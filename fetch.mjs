/**
 * 恐鬼症 wiki 快照抓取器 —— 零依赖，跑在 GitHub Actions 上
 * ---------------------------------------------------------------
 * 为什么不用服务器自己抓：实测大陆阿里云 ECS **连不上 Fandom**
 * （连接被拒/超时），而 PC 直连也超时、只有走代理才行。
 * GitHub Actions 的 runner 在墙外 → 抓取在这里做，服务器只从 GitHub 拉小文件
 * （实测服务器到 github.com / raw.githubusercontent.com 可达）。
 *
 * 设计依据（全部实测，见 550v-0918temp\恐鬼症知识库-更新方案研究.md）：
 *   · 全站 revid 清单 34–36 KB，全量正文 1.85 MB —— 检测变更只要 1/50 的量
 *   · API **没有** ETag，Last-Modified 是响应时刻、If-Modified-Since 仍返回 200
 *     → 条件请求（304）走不通，只能靠 revid 比对
 *   · Atom/RSS 被 Cloudflare 403；且 `feeds` 限流 6 次/60 秒 → 不走它
 *   · `Cache-Control: no-store` + `CF-Cache-Status: BYPASS` → 每请求都到源站，要克制
 *   · 站点真实限流表（meta=userinfo&uiprop=ratelimits）里**没有任何只读查询条目**
 *     → 只读轮询不在 $wgRateLimits 覆盖内；但仍主动限速 1 req/s
 *   · **RevisionDelete 会把正文永久隐藏**（隐藏后匿名只剩 revid+user）
 *     → 必须"第一次见到 revid 就落盘"，不能指望以后回取。本脚本对重点页正是这么做的
 *
 * 编辑密度实测：正文命名空间 6.1 次/天；全命名空间 20.8 次/天（其中大半是图片 ns=6）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const API = process.env.WIKI_API || 'https://phasmophobia.fandom.com/api.php';
const UA  = 'phasmo-wiki-feed/1.0 (https://github.com/SudierthSP/phasmo-wiki-feed; contact: SudierthSP@users.noreply.github.com)';
const OUT = process.cwd();

// 请求间隔（毫秒）。站点不拦（实测 20 次串行 20.8s 全 200），但每请求都到源站，
// 所以主动克制。官方 API 礼仪的要求是「串行、批量合并、别把站点打挂」，没有硬性速度上限。
const DELAY_MS = 1200;

// 重点页：每次变动都把**新版本的正文**存下来（其余页只记录 revid 变动）。
// 这是应对 RevisionDelete / 暗改的唯一可靠办法——被隐藏后正文就永久拿不回了。
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

/** 指数退避，尊重 Retry-After。 */
function backoffMs(attempt, retryAfter) {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 60_000);
  }
  return Math.min(5000 * 2 ** attempt, 60_000);
}

async function api(params, attempt = 0) {
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  // 官方推荐的背压信号；实测 Fandom 支持（maxlag=-1 会返回 maxlag 错误）
  url.searchParams.set('maxlag', '5');

  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' } });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }

  const code = data?.error?.code;
  const backpressure = code === 'maxlag' || code === 'ratelimited' || res.status === 429 || res.status === 503;
  if (backpressure) {
    if (attempt >= 5) throw new Error(`反复被背压（${code ?? res.status}），放弃`);
    const wait = backoffMs(attempt, res.headers.get('retry-after'));
    console.warn(`  背压 ${code ?? res.status}，等 ${wait} ms 后重试（第 ${attempt + 1} 次）`);
    await sleep(wait);
    return api(params, attempt + 1);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (data?.error) throw new Error(`API 错误 ${data.error.code}: ${data.error.info ?? ''}`);
  return data;
}

/**
 * 全站 ns0 页面的「标题 → 当前 revid」映射。实测 34 KB / 1.7 s，覆盖全部 378 页。
 * 这是变更检测的主力：一次请求就是全站快照。
 */
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
    // 目前 378 页一次就拿完；超过 500 页会静默截断，所以照 continue 走完
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

/** 单页正文（wikitext）+ 指纹。 */
async function fetchText(title) {
  const data = await api({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content|ids|timestamp|user|comment',
    rvslots: 'main',
    titles: title,
  });
  const rev = data.query?.pages?.[0]?.revisions?.[0];
  if (!rev) return null;
  const content = rev.slots?.main?.content ?? '';
  return {
    revid: rev.revid,
    ts: rev.timestamp,
    user: rev.user,
    comment: rev.comment ?? '',
    content,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

/** 删除/隐藏日志（375 B）。用来发现"有修订被隐藏了"——那时正文可能已永久丢失。 */
async function fetchDeleteLog() {
  try {
    const data = await api({ action: 'query', list: 'logevents', letype: 'delete|suppress', lelimit: '20' });
    return data.query?.logevents ?? [];
  } catch (e) {
    console.warn(`  删除日志取不到（不影响主流程）: ${e.message}`);
    return [];
  }
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
    if (!old || old.revid !== info.revid) {
      changed.push({ title, ...info, oldRevid: old?.revid ?? null });
    }
  }
  const removed = Object.keys(prevPages).filter(t => !(t in now));
  console.log(`  变动 ${changed.length} 页，消失 ${removed.length} 页`);

  const stamp = new Date().toISOString();
  const logLines = [];

  for (const c of changed) {
    const isNew = c.oldRevid === null;
    logLines.push(JSON.stringify({
      ts: stamp, title: c.title, revid: c.revid, prevRevid: c.oldRevid,
      kind: isNew ? 'new' : 'edit', pageTs: c.ts,
    }));
  }
  for (const t of removed) logLines.push(JSON.stringify({ ts: stamp, title: t, kind: 'removed' }));

  // 重点页：把新版本正文存下来（累积成"以前的版本"，应对 RevisionDelete）
  const watched = changed.filter(c => WATCH.includes(c.title));
  console.log(`  其中重点页 ${watched.length} 个，开始取正文（每请求间隔 ${DELAY_MS} ms）`);
  for (const c of watched) {
    try {
      const t = await fetchText(c.title);
      if (!t) { console.warn(`  跳过（取不到）: ${c.title}`); continue; }
      const dir = path.join(OUT, 'watch', safeName(c.title));
      fs.mkdirSync(dir, { recursive: true });
      const header = [
        `# ${c.title}`,
        `# revid ${t.revid}  ${t.ts}  by ${t.user}`,
        `# 上个版本 ${c.oldRevid ?? '(首次见到)'}`,
        `# sha256 ${t.sha256}  bytes ${t.bytes}`,
        t.comment ? `# 备注: ${t.comment}` : null,
        '',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(path.join(dir, `${t.revid}.txt`), header + t.content, 'utf8');
      console.log(`  存下 ${c.title} @ ${t.revid}（${(t.bytes / 1024).toFixed(1)} KB）`);
    } catch (e) {
      console.warn(`  失败 ${c.title}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  // 删除/隐藏日志：只报，不改状态
  const delLog = await fetchDeleteLog();
  if (delLog.length) {
    console.log(`  删除/隐藏日志有 ${delLog.length} 条，记入 changes.jsonl`);
    for (const e of delLog) {
      logLines.push(JSON.stringify({ ts: stamp, kind: 'log', logtype: e.type, logaction: e.action, title: e.title, user: e.user, logTs: e.timestamp }));
    }
  }

  fs.writeFileSync(statePath, JSON.stringify({
    updated: stamp,
    api: API,
    pageCount: Object.keys(now).length,
    pages: now,
  }, null, 2) + '\n', 'utf8');

  if (logLines.length) fs.appendFileSync(logPath, logLines.join('\n') + '\n', 'utf8');

  const dirty = logLines.length > 0;
  fs.writeFileSync(path.join(OUT, '.dirty'), dirty ? '1' : '0', 'utf8');
  console.log(dirty ? '有变动' : '无变动');
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
