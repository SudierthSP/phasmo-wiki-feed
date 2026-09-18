/**
 * 恐鬼症 wiki 快照抓取器 —— 零依赖，跑在 GitHub Actions 上
 * ---------------------------------------------------------------
 * 为什么不用服务器自己抓：实测大陆阿里云 ECS **连不上 Fandom**
 * （连接被拒/超时），而 PC 直连也超时、只有走代理才行。
 * GitHub Actions 的 runner 在墙外 → 抓取在这里做，服务器只从 GitHub 拉小文件
 * （实测服务器到 github.com / raw.githubusercontent.com 可达）。
 *
 * 设计要点（都来自实测，见 550v-0918temp\恐鬼症知识库-更新方案研究.md）：
 *   · 检测变更只要 36.5 KB（全站 revid 清单），全量正文是 1.85 MB —— 差 50 倍
 *   · API **没有** ETag / Last-Modified → 条件请求走不通，只能靠 revid 比对
 *   · Atom feed 被 Cloudflare 403 → 没有推送，只能轮询
 *   · Cache-Control: no-store + CF-Cache-Status: BYPASS → 每请求都到源站，要克制
 *   · 该 wiki 实测约 6.1 次编辑/天，活跃用户 8 人（基本是一个人）
 */

import fs from 'node:fs';
import path from 'node:path';

const API = process.env.WIKI_API || 'https://phasmophobia.fandom.com/api.php';
const UA  = 'phasmo-wiki-feed/1.0 (+https://github.com/SudierthSP/phasmo-wiki-feed)';
const OUT = process.cwd();

// 每隔多久发一个请求（毫秒）。实测该站不拦，但响应头显示 CDN 不缓存、每请求都到源站，
// 所以主动克制：约 1 req/s。
const DELAY_MS = 1000;

// 重点页：每次变动都把**新版本的正文**存下来（其余页只记录 revid 变动）。
// 目的是"留存以前的版本来对照"——全站正文太占地方，重点页才值得存全量。
const WATCH = [
  'Ghost', 'Hunt', 'Evidence', 'Sanity', 'Difficulty',
  'Items', 'Equipment', 'Map', 'Maps', 'Cursed Possessions',
  'Ouija Board', 'Tarot Cards', 'Monkey Paw', 'Music Box',
  'Summoning Circle', 'Voodoo Doll', 'Planchette', 'Ghost Writing Book',
  'EMF Reader', 'Spirit Box', 'Thermometer', 'Video Camera', 'D.O.T.S Projector',
  'Flashlight', 'UV Light', 'Crucifix', 'Salt', 'Smudge Sticks',
  'Cursed Mirror', 'Third-party tools', 'Planned updates and features',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(params) {
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}${url.search}`);
  return res.json();
}

/** 全站 ns0 页面的「标题 → 当前 revid」映射。实测 36.5 KB / 1.7 s。 */
async function fetchState() {
  const pages = {};
  let cont = null;
  do {
    const params = {
      action: 'query',
      generator: 'allpages',
      gapnamespace: '0',
      gaplimit: '500',
      prop: 'revisions',
      rvprop: 'ids|timestamp',
    };
    // 目前 378 页一次就拿完；但超过 500 页会静默截断，所以照 continue 走完
    if (cont) Object.assign(params, cont);
    const data = await api(params);
    for (const p of data.query?.pages ?? []) {
      const rev = p.revisions?.[0];
      if (rev) pages[p.title] = { revid: rev.revid, ts: rev.timestamp };
    }
    cont = data.continue ?? null;
    if (cont) await sleep(DELAY_MS);
  } while (cont);
  return pages;
}

/** 单页正文（wikitext）。 */
async function fetchText(title) {
  const data = await api({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content|ids|timestamp|user|comment',
    rvslots: 'main',
    titles: title,
  });
  const p = data.query?.pages?.[0];
  const rev = p?.revisions?.[0];
  if (!rev) return null;
  return {
    revid: rev.revid,
    ts: rev.timestamp,
    user: rev.user,
    comment: rev.comment ?? '',
    content: rev.slots?.main?.content ?? '',
  };
}

function safeName(title) {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function main() {
  const statePath = path.join(OUT, 'state.json');
  const logPath   = path.join(OUT, 'changes.jsonl');

  const prev = readJson(statePath, { pages: {} });
  const prevPages = prev.pages ?? {};

  console.log('拉取全站 revid 清单…');
  const now = await fetchState();
  console.log(`  当前 ${Object.keys(now).length} 页；上次记录 ${Object.keys(prevPages).length} 页`);

  const changed = [];
  for (const [title, info] of Object.entries(now)) {
    const old = prevPages[title];
    if (!old || old.revid !== info.revid) changed.push({ title, ...info, oldRevid: old?.revid ?? null });
  }
  const removed = Object.keys(prevPages).filter(t => !(t in now));

  console.log(`  变动 ${changed.length} 页，消失 ${removed.length} 页`);

  const stamp = new Date().toISOString();
  const logLines = [];

  for (const c of changed) {
    const isNew = c.oldRevid === null;
    logLines.push(JSON.stringify({ ts: stamp, title: c.title, revid: c.revid, prevRevid: c.oldRevid, kind: isNew ? 'new' : 'edit', pageTs: c.ts }));
  }
  for (const t of removed) {
    logLines.push(JSON.stringify({ ts: stamp, title: t, kind: 'removed' }));
  }

  // 重点页：把新版本正文存下来（累积成"以前的版本"）
  const watched = changed.filter(c => WATCH.includes(c.title));
  console.log(`  其中重点页 ${watched.length} 个，开始取正文（每请求间隔 ${DELAY_MS}ms）`);
  for (const c of watched) {
    try {
      const t = await fetchText(c.title);
      if (!t) { console.warn(`  跳过（取不到）: ${c.title}`); continue; }
      const dir = path.join(OUT, 'watch', safeName(c.title));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${t.revid}.txt`);
      const header = [
        `# ${c.title}`,
        `# revid ${t.revid}  ${t.ts}  by ${t.user}`,
        `# 上个版本 ${c.oldRevid ?? '(首次见到)'}`,
        t.comment ? `# 备注: ${t.comment}` : null,
        `# 源: ${API}?curid=`,
        '',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(file, header + t.content, 'utf8');
      console.log(`  存下 ${c.title} @ ${t.revid}  (${(t.content.length/1024).toFixed(1)} KB)`);
    } catch (e) {
      console.warn(`  失败 ${c.title}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  // 写状态与日志
  fs.writeFileSync(statePath, JSON.stringify({
    updated: stamp,
    api: API,
    pageCount: Object.keys(now).length,
    pages: now,
  }, null, 2) + '\n', 'utf8');

  if (logLines.length) fs.appendFileSync(logPath, logLines.join('\n') + '\n', 'utf8');

  // 给 Actions 用：有没有变化
  const dirty = logLines.length > 0;
  fs.writeFileSync(path.join(OUT, '.dirty'), dirty ? '1' : '0', 'utf8');
  console.log(dirty ? '有变动' : '无变动');
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
