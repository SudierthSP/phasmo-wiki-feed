/**
 * 恐鬼症 wiki 快照抓取器 —— 零依赖，跑在 GitHub Actions 上
 * ---------------------------------------------------------------
 * 产出的是一个「可检索的文本数据库」，供 550v 在服务器上本地读取：
 *
 *   pages/<lang>/<标题>.txt     全站正文（完整信息）
 *   index.json                  检索索引（标题 + 摘要 + 路径 + 大小）
 *   state/<lang>.json           标题 → 当前 revid/时间戳
 *   changes.jsonl               变更日志：时间 / 标题 / revid / 作者 / 备注
 *   history/<lang>/<标题>/<revid>.txt   历史版本（对照用）
 *
 * 为什么在 GitHub 上抓：大陆阿里云 ECS **连不上 Fandom**（实测连接被拒/超时），
 * 而 PC 直连也超时、只有走代理才行。runner 在墙外 → 抓取放这里，
 * 服务器只从 GitHub 拉（实测可达，一次 tar.gz 就够）。
 *
 * 设计依据（全部实测，见 550v-0918temp\恐鬼症知识库-更新方案研究.md）：
 *   · 全站 revid 清单 34 KB / 全量正文 1.85 MB
 *   · API 没有 ETag，Last-Modified 是响应时刻 → 条件请求走不通，只能靠 revid 比对
 *   · Atom/RSS 被 Cloudflare 403；`feeds` 还限流 6 次/60 秒 → 不走它
 *   · 站点限流表（meta=userinfo&uiprop=ratelimits）里**没有任何只读查询条目**
 *   · RevisionDelete 会永久隐藏正文 → 必须第一次见到就落盘，所以有 history/
 *   · 正文命名空间约 6.1 次编辑/天（全命名空间的 20.8 次/天里大半是图片）
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const OUT = process.cwd();

// 英文站 + 中文站（同一套 API，换路径前缀）。中文站是给中文群的答案来源。
const SITES = [
  { lang: 'en', api: process.env.WIKI_API_EN || 'https://phasmophobia.fandom.com/api.php' },
  { lang: 'zh', api: process.env.WIKI_API_ZH || 'https://phasmophobia.fandom.com/zh/api.php' },
];

const UA = 'phasmo-wiki-feed/1.0 (https://github.com/SudierthSP/phasmo-wiki-feed; contact: SudierthSP@users.noreply.github.com)';

// 请求间隔：站点不拦（实测 20 次串行全 200），但每请求都到源站，主动克制。
const DELAY_MS = 1000;
// 一次批量取多少页的正文。50 页约 250 KB，稳。
const BATCH = 50;
// 索引里每页存多少字符的摘要（给检索用）
const EXCERPT = 220;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function backoffMs(attempt, retryAfter) {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 60_000);
  }
  return Math.min(5000 * 2 ** attempt, 60_000);
}

async function api(apiBase, params, attempt = 0) {
  const url = new URL(apiBase);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('maxlag', '5');   // 官方推荐的背压信号；Fandom 实测支持

  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' } });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }

  const code = data?.error?.code;
  if (code === 'maxlag' || code === 'ratelimited' || res.status === 429 || res.status === 503) {
    if (attempt >= 5) throw new Error(`反复被背压（${code ?? res.status}），放弃`);
    const wait = backoffMs(attempt, res.headers.get('retry-after'));
    console.warn(`  背压 ${code ?? res.status}，等 ${wait} ms 重试`);
    await sleep(wait);
    return api(apiBase, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (data?.error) throw new Error(`API 错误 ${data.error.code}: ${data.error.info ?? ''}`);
  return data;
}

function safeName(title) {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** 全站 ns0 页面的「标题 → revid/时间戳」。一次请求拿完（实测 34 KB / 378 页）。 */
async function fetchState(apiBase) {
  const pages = {};
  let cont = null;
  do {
    const params = {
      action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '500',
      prop: 'revisions', rvprop: 'ids|timestamp',
    };
    if (cont) Object.assign(params, cont);
    const data = await api(apiBase, params);
    for (const p of data.query?.pages ?? []) {
      const rev = p.revisions?.[0];
      if (rev) pages[p.title] = { revid: rev.revid, ts: rev.timestamp };
    }
    cont = data.continue ?? null;
    if (cont) await sleep(DELAY_MS);
  } while (cont);
  return pages;
}

/** 批量取一批页的正文（含作者与备注，供变更日志用）。 */
async function fetchBatch(apiBase, titles) {
  const data = await api(apiBase, {
    action: 'query',
    prop: 'revisions',
    rvprop: 'content|ids|timestamp|user|comment',
    rvslots: 'main',
    titles: titles.join('|'),
  });
  const out = [];
  for (const p of data.query?.pages ?? []) {
    const rev = p.revisions?.[0];
    if (!rev) continue;
    const content = rev.slots?.main?.content ?? '';
    out.push({
      title: p.title,
      revid: rev.revid,
      ts: rev.timestamp,
      user: rev.user ?? '',
      comment: rev.comment ?? '',
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
  }
  return out;
}

/** 取一个站的全部正文并落盘。changedTitles 为空 = 首次全量（bootstrap）。 */
async function syncSite(site, globalLog) {
  console.log(`\n=== [${site.lang}] ${site.api} ===`);
  const pagesDir = path.join(OUT, 'pages', site.lang);
  const histDir  = path.join(OUT, 'history', site.lang);
  const statePath = path.join(OUT, 'state', `${site.lang}.json`);

  const prev = readJson(statePath, { pages: {} });
  const prevPages = prev.pages ?? {};

  const now = await fetchState(site.api);
  const titles = Object.keys(now);
  console.log(`  当前 ${titles.length} 页，上次 ${Object.keys(prevPages).length} 页`);

  const changed = titles.filter(t => prevPages[t]?.revid !== now[t].revid);
  const removed = Object.keys(prevPages).filter(t => !(t in now));
  const bootstrap = Object.keys(prevPages).length === 0;
  console.log(`  变动 ${changed.length} 页${bootstrap ? '（首次全量）' : ''}，消失 ${removed.length} 页`);

  // 首次全量时要拉全部页；之后只拉变动的页
  const toFetch = bootstrap ? titles : changed;
  const stamp = new Date().toISOString();
  const index = [];

  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    let got = [];
    try {
      got = await fetchBatch(site.api, batch);
    } catch (e) {
      console.warn(`  批次 ${i / BATCH} 失败: ${e.message}`);
    }
    for (const p of got) {
      const fname = safeName(p.title) + '.txt';
      const header = [
        `# ${p.title}`,
        `# revid ${p.revid}  ${p.ts}  by ${p.user || '(未知)'}`,
        p.comment ? `# 备注: ${p.comment}` : null,
        `# sha256 ${p.sha256}  bytes ${p.bytes}`,
        `# 源: ${site.api}`,
        '',
      ].filter(Boolean).join('\n');

      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(path.join(pagesDir, fname), header + p.content, 'utf8');

      // 历史版本：只对**变动过**的页留档（首次全量不留，否则一次就是 700 个文件）
      if (!bootstrap) {
        const hd = path.join(histDir, safeName(p.title));
        fs.mkdirSync(hd, { recursive: true });
        fs.writeFileSync(path.join(hd, `${p.revid}.txt`), header + p.content, 'utf8');
      }

      globalLog.push(JSON.stringify({
        ts: stamp, lang: site.lang, title: p.title, revid: p.revid,
        prevRevid: prevPages[p.title]?.revid ?? null,
        kind: prevPages[p.title] ? 'edit' : 'new',
        user: p.user ?? '', comment: p.comment ?? '',
        bytes: p.bytes, pageTs: p.ts,
      }));
    }
    console.log(`  [${i + got.length}/${toFetch.length}] 已落盘`);
    await sleep(DELAY_MS);
  }

  // 被删的页：从 pages/ 移除，并记日志
  for (const t of removed) {
    const f = path.join(pagesDir, safeName(t) + '.txt');
    try { fs.unlinkSync(f); } catch { /* 本来就不在 */ }
    globalLog.push(JSON.stringify({ ts: stamp, lang: site.lang, title: t, kind: 'removed' }));
  }

  // 生成索引：标题 + 摘要 + 路径 + 大小（给 bot 检索用，避免每次读全站）
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const t of titles) {
    const fname = safeName(t) + '.txt';
    const full = path.join(pagesDir, fname);
    let excerpt = '';
    let bytes = 0;
    try {
      const raw = fs.readFileSync(full, 'utf8');
      bytes = Buffer.byteLength(raw, 'utf8');
      // 跳过我们加的头部注释行，正文摘要才有用
      const body = raw.split('\n').filter(l => !l.startsWith('# ')).join('\n');
      excerpt = body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT);
    } catch { /* 本轮没拿到（批次失败） */ }
    index.push({ t, f: `pages/${site.lang}/${fname}`, b: bytes, r: now[t].revid, x: excerpt });
  }

  writeJson(statePath, {
    updated: stamp, api: site.api,
    pageCount: titles.length, pages: now,
  });

  console.log(`  [${site.lang}] 索引 ${index.length} 条`);
  return index;
}

async function main() {
  const index = { generated: new Date().toISOString(), counts: {}, langs: {} };
  const globalLog = [];

  for (const site of SITES) {
    const idx = await syncSite(site, globalLog);
    index.langs[site.lang] = idx;
    index.counts[site.lang] = idx.length;
  }

  writeJson(path.join(OUT, 'index.json'), index);
  if (globalLog.length) {
    fs.appendFileSync(path.join(OUT, 'changes.jsonl'), globalLog.join('\n') + '\n', 'utf8');
  }

  const dirty = globalLog.length > 0;
  fs.writeFileSync(path.join(OUT, '.dirty'), dirty ? '1' : '0', 'utf8');
  console.log(`\n总计：en ${index.counts.en ?? 0} 页 + zh ${index.counts.zh ?? 0} 页；变更日志 ${globalLog.length} 条`);
  console.log(dirty ? '有变动' : '无变动');
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
