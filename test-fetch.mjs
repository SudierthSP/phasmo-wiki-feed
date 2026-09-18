/**
 * fetch.mjs 的离线回归测试 —— 零依赖，`node test-fetch.mjs` 即可跑。
 * ---------------------------------------------------------------
 * 起一个假的 MediaWiki HTTP 服务器，把已知会出问题的几种页面喂进去，
 * 跑真正的 fetch.mjs，再检查落盘结果。不联网、不碰真实仓库。
 *
 * 覆盖的是 2026-09-19 修掉的两个 bug 以及它们的几个变体：
 *   ① 页头与正文粘连      → 正文必须与源站原文逐字节相同
 *   ② 重定向当成正文收进库 → 空壳不落盘、不进索引，但要进 redirects.json
 *      变体：链式重定向（Salt shaker → Salt Shaker → Salt）
 *            下划线标题（Tarot → Tarot_Cards，真标题 Tarot Cards）
 *            大小写孪生（Ghost Event / Ghost event）
 *   ③ 正文里以 "# " 开头的行不能被当成页头删掉（wikitext 的有序列表就长这样）
 *   ④ 「没变动就不提交」与「格式升级要重写但不记变更」两条路径
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCH = path.join(HERE, 'fetch.mjs');

// ---------------------------------------------------------------- 假数据

const ghostEventBody = [
  "A '''ghost event''' is a manifestation of the [[ghost]] in the mortal world.",
  '',
  '==Mechanics==',
  'When the ghost attempts to perform a ghost event, it checks the presence of players.',
].join('\n');

const fuseBoxBody = [
  '{{Item Template',
  '|img=Fusebox 0.7 small.png',
  '|imgcaption=A fuse box in the garage of [[42 Edgefield Road]].',
  '}}',
  "The '''fuse box''' is found on [[map]]s.",
].join('\n');

// 正文里故意放以 "# " 开头的行（wikitext 有序列表），验证去页头不会误删
const listBody = [
  'Steps to reproduce:',
  '# first step',
  '# second step',
  '',
  'Done.',
].join('\n');
const expectedListBody = listBody;

/** 正文页：title → { revid, content } */
const EN_CONTENT = {
  'Main Page': { revid: 100, content: 'Welcome to Phasmopedia.' },
  'Ghost Event': { revid: 24629, content: ghostEventBody },
  'Fuse Box': { revid: 24259, content: fuseBoxBody },
  'Salt': { revid: 300, content: 'Salt is a consumable item.' },
  'Tarot Cards': { revid: 400, content: 'There are 10 tarot cards.' },
  'Zzz List': { revid: 500, content: listBody },
};

/** 重定向页：title → 目标标题（下划线写法也照原样写，测规范化） */
const EN_REDIRECT = {
  'Ghost event': 'Ghost Event',
  'Fuse box': 'Fuse Box',
  'Salt Shaker': 'Salt',
  'Salt shaker': 'Salt Shaker',        // 链：→ Salt Shaker → Salt
  'Tarot': 'Tarot_Cards',              // 下划线，真标题是 Tarot Cards
  'Dead Link': 'Nonexistent Page',     // 死链，应进 unresolved
};

const ZH_CONTENT = {
  '恐鬼症': { revid: 1, content: '恐鬼症（Phasmophobia）是一款恐怖游戏。' },
};
const ZH_REDIRECT = {
  '恐鬼症 Wiki': '恐鬼症',
};

// ---------------------------------------------------------------- 假服务器

function buildPages(content, redirect) {
  const out = {};
  for (const [t, v] of Object.entries(content)) {
    out[t] = { ...v, user: 'Tester', comment: `edit ${t}`, ts: '2026-09-01T00:00:00Z', redirect: false };
  }
  for (const [t, target] of Object.entries(redirect)) {
    out[t] = {
      revid: 1, user: 'Tester', comment: `redirect ${t}`, ts: '2021-01-01T00:00:00Z',
      content: `#REDIRECT [[${target}]]`, redirect: true,
    };
  }
  return out;
}

const EN = buildPages(EN_CONTENT, EN_REDIRECT);
const ZH = buildPages(ZH_CONTENT, ZH_REDIRECT);

function allpages(data) {
  return Object.entries(data).map(([title, p]) => ({
    title, revid: p.revid, ts: p.ts, redirect: p.redirect,
  }));
}

function makeServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const data = u.pathname.startsWith('/zh/') ? ZH : EN;
    const params = u.searchParams;
    let pages = [];

    // fetch.mjs 用 list=allpages&apfilterredir=redirects 拿重定向标题集合
    // （不是 prop=pageprops&ppprop=redirect —— Fandom 上那个不返回任何东西，实测过）
    if (params.get('list') === 'allpages' && params.get('apfilterredir') === 'redirects') {
      const allpages = Object.entries(data).filter(([, p]) => p.redirect).map(([title]) => ({ title, ns: 0 }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ batchcomplete: true, query: { allpages } }));
      return;
    }

    if (params.get('generator') === 'allpages') {
      pages = allpages(data).map(p => ({
        title: p.title,
        revisions: [{ revid: p.revid, timestamp: p.ts }],
      }));
    } else if (params.has('titles')) {
      const wanted = params.get('titles').split('|');
      pages = wanted.filter(t => data[t]).map(t => {
        const p = data[t];
        return {
          title: t,
          revisions: [{
            revid: p.revid, timestamp: p.ts, user: p.user, comment: p.comment,
            slots: { main: { content: p.content } },
          }],
        };
      });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ batchcomplete: true, query: { pages } }));
  });
}

// ---------------------------------------------------------------- 断言

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  —— ' + extra : ''}`); }
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = p => fs.existsSync(p);

/**
 * 跑一次 fetch.mjs。**必须异步**：假 wiki 服务器就跑在本进程里，
 * 用 spawnSync 会阻塞事件循环 → 子进程的 HTTP 请求永远等不到响应（实测死锁过一次）。
 */
function runFetch(cwd, port, label) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [FETCH], {
      cwd,
      env: {
        ...process.env,
        FETCH_DELAY_MS: '0',
        WIKI_API_EN: `http://127.0.0.1:${port}/api.php`,
        WIKI_API_ZH: `http://127.0.0.1:${port}/zh/api.php`,
      },
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      if (code !== 0) {
        console.log(`  [${label}] fetch 退出码 ${code}`);
        console.log(out);
        console.log(err);
      }
      resolve({ status: code, stdout: out, stderr: err });
    });
  });
}

// ---------------------------------------------------------------- 主流程

const server = makeServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'phasmo-test-'));
console.log(`临时输出目录: ${OUT}\n`);

try {
  // ============ 第一次运行（首次全量） ============
  console.log('第一次运行（首次全量）');
  const r1 = await runFetch(OUT, port, 'run1');
  check('fetch 正常退出', r1.status === 0);

  const en = n => path.join(OUT, 'pages', 'en', n);

  console.log('\n① 页头与正文必须分开');
  const ghostRaw = fs.readFileSync(en('Ghost Event.txt'), 'utf8');
  const ghostBody = ghostRaw.split('\n\n').slice(1).join('\n\n');
  check('正文与源站原文逐字节相同', ghostBody === ghostEventBody,
    `实际开头 ${JSON.stringify(ghostBody.slice(0, 60))}`);
  check('页头里有 # 源: 行', /^# 源: /m.test(ghostRaw));
  check('前 5 行都是页头（没有和正文粘连）',
    ghostRaw.split('\n').slice(0, 6).every(l => l === '' || l.startsWith('# ')));
  check('页头与正文之间恰好一个空行', ghostRaw.includes('\n\n') && !ghostRaw.startsWith('\n'));

  console.log('\n② 重定向不能当成正文收进库');
  // ⚠️ 断言必须用 readdir 拿**真实文件名**：
  //    Windows 上 fs.existsSync('Ghost event.txt') 会因为大小写不敏感返回 true
  //    （命中的其实是 'Ghost Event.txt'），用 existsSync 断言会一直失败。
  const enNames = () => fs.readdirSync(path.join(OUT, 'pages', 'en'));
  check('Ghost event.txt 没落盘', !enNames().includes('Ghost event.txt'));
  check('Fuse box.txt 没落盘', !enNames().includes('Fuse box.txt'));
  check('Salt shaker.txt 没落盘', !enNames().includes('Salt shaker.txt'));
  check('对照：正文页 Ghost Event.txt 在（没被误删）', enNames().includes('Ghost Event.txt'),
    enNames().join(', '));

  const redirects = readJson(path.join(OUT, 'redirects.json'));
  check('redirects.json 存在且有 en 段', !!redirects.langs?.en);
  check('Ghost event → Ghost Event', redirects.langs.en['Ghost event'] === 'Ghost Event');
  check('链式 Salt shaker → Salt（跳了两跳）', redirects.langs.en['Salt shaker'] === 'Salt',
    `实际 ${redirects.langs.en['Salt shaker']}`);
  check('下划线 Tarot → Tarot Cards',
    redirects.langs.en['Tarot'] === 'Tarot Cards', `实际 ${redirects.langs.en['Tarot']}`);
  check('死链进了 unresolved', redirects.unresolved?.en?.['Dead Link'] === 'Nonexistent Page');
  check('chains 记下了那条链', Array.isArray(redirects.chains?.en?.['Salt shaker']));
  check('链条首尾分别是别名和真目标',
    redirects.chains?.en?.['Salt shaker']?.[0] === 'Salt shaker'
    && redirects.chains?.en?.['Salt shaker']?.at(-1) === 'Salt',
    JSON.stringify(redirects.chains?.en?.['Salt shaker']));
  check('链条尾部不重复（hops 最后一项常常已经就是目标）',
    new Set(redirects.chains?.en?.['Salt shaker'] ?? []).size
      === (redirects.chains?.en?.['Salt shaker'] ?? []).length,
    JSON.stringify(redirects.chains?.en?.['Salt shaker']));
  check('zh 别名也在', redirects.langs.zh?.['恐鬼症 Wiki'] === '恐鬼症');

  const index = readJson(path.join(OUT, 'index.json'));
  const titles = index.langs.en.map(e => e.t);
  check('索引里没有重定向标题', !titles.includes('Ghost event') && !titles.includes('Salt shaker'));
  check('索引里有正文标题', titles.includes('Ghost Event') && titles.includes('Salt'));
  check('索引计数 = 正文页数（6 个 en）', index.counts.en === 6, `实际 ${index.counts.en}`);
  check('zh 索引计数 = 1', index.counts.zh === 1, `实际 ${index.counts.zh}`);

  console.log('\n③ 正文里以 "# " 开头的行不能被当成页头删掉');
  const listRaw = fs.readFileSync(en('Zzz List.txt'), 'utf8');
  const zzzBody = listRaw.split('\n\n').slice(1).join('\n\n');
  check('wikitext 有序列表还在', zzzBody === expectedListBody, JSON.stringify(zzzBody));

  console.log('\n④ 大小写孪生不能同时落盘');
  const names = fs.readdirSync(path.join(OUT, 'pages', 'en'));
  const lowered = names.map(n => n.toLowerCase());
  const dupes = lowered.filter((n, i) => lowered.indexOf(n) !== i);
  check('pages/en 下没有只差大小写的重名文件', dupes.length === 0, dupes.join(', '));

  console.log('\n⑤ 摘要必须包含正文开头（原来这里丢了第一行）');
  const geEntry = index.langs.en.find(e => e.t === 'Ghost Event');
  check('摘要以正文首词开头', geEntry.x.startsWith("A '''ghost event'''"),
    `实际开头 ${JSON.stringify(geEntry.x.slice(0, 40))}`);

  console.log('\n⑥ 状态文件记了格式版本和重定向标记');
  const state = readJson(path.join(OUT, 'state', 'en.json'));
  check('state.fmt === 2', state.fmt === 2);
  check('state 记了 redirect 标记', state.pages['Ghost event']?.redirect === true
    && state.pages['Ghost Event']?.redirect === false);
  check('state 记了 redirectCount', state.redirectCount === 6, `实际 ${state.redirectCount}`);

  console.log('\n⑦ 首次运行应当标记为有变动');
  check('.dirty === 1', fs.readFileSync(path.join(OUT, '.dirty'), 'utf8').trim() === '1');
  const logLines1 = fs.readFileSync(path.join(OUT, 'changes.jsonl'), 'utf8').trim().split('\n').length;
  check('变更日志记了 7 条新的正文页（en 6 + zh 1）', logLines1 === 7, `实际 ${logLines1}`);

  // ============ 第二次运行（什么都没变） ============
  console.log('\n第二次运行（源站无变化）');
  const r2 = await runFetch(OUT, port, 'run2');
  check('fetch 正常退出', r2.status === 0);
  check('.dirty === 0（不该产生空提交）',
    fs.readFileSync(path.join(OUT, '.dirty'), 'utf8').trim() === '0');
  const logLines2 = fs.readFileSync(path.join(OUT, 'changes.jsonl'), 'utf8').trim().split('\n').length;
  check('变更日志没有新增', logLines2 === logLines1, `${logLines1} → ${logLines2}`);
  check('重定向文件依旧没有复活', !enNames().includes('Ghost event.txt'));
  check('正文页也没被那一轮误删', enNames().includes('Ghost Event.txt'));

  // ============ 第三次运行（模拟格式升级） ============
  console.log('\n第三次运行（把 state 的 fmt 改回 1，模拟格式升级）');
  const statePath = path.join(OUT, 'state', 'en.json');
  const s = readJson(statePath);
  s.fmt = 1;
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
  // 再手动改坏一个正文文件，验证全量重写会把它修回来
  fs.writeFileSync(en('Zzz List.txt'), '# Zzz List\n# 旧的坏页头\n坏内容\n');

  const r3 = await runFetch(OUT, port, 'run3');
  check('fetch 正常退出', r3.status === 0);
  check('.dirty === 1（重写了文件就得提交）',
    fs.readFileSync(path.join(OUT, '.dirty'), 'utf8').trim() === '1');
  check('被改坏的文件已修回', fs.readFileSync(en('Zzz List.txt'), 'utf8').includes('Steps to reproduce'));
  const logLines3 = fs.readFileSync(path.join(OUT, 'changes.jsonl'), 'utf8').trim().split('\n').length;
  check('格式升级不产生假的「变动」条目', logLines3 === logLines2, `${logLines2} → ${logLines3}`);

  // ============ 第四次运行（升级已完成，应静默） ============
  console.log('\n第四次运行（升级已完成）');
  await runFetch(OUT, port, 'run4');
  check('.dirty === 0', fs.readFileSync(path.join(OUT, '.dirty'), 'utf8').trim() === '0');
} finally {
  server.close();
  fs.rmSync(OUT, { recursive: true, force: true });
}

// 小工具：期望的列表正文在上面（fake 数据那一段里），这里不再重复声明

console.log(`\n${'='.repeat(50)}\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
