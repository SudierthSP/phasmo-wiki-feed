/**
 * 恐鬼症 wiki 快照抓取器 —— 零依赖，跑在 GitHub Actions 上
 * ---------------------------------------------------------------
 * 产出的是一个「可检索的文本数据库」，供 550v 在服务器上本地读取：
 *
 *   pages/<lang>/<标题>.txt     全站正文（完整信息）
 *   index.json                  检索索引（标题 + 摘要 + 路径 + revid）
 *   redirects.json              重定向别名表（小写名/简称 → 真页面）
 *   state/<lang>.json           标题 → 当前 revid/时间戳/是否重定向
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
 *
 * ⚠️ 2026-09-19 修掉的两个 bug（都是上线后发现的）：
 *
 *   ① 页头与正文粘在一起。原来是
 *        [...header, ''].filter(Boolean).join('\n') + content
 *      —— `filter(Boolean)` 把当分隔符用的空串也滤掉了，于是
 *      `# 源: <url>` 和正文第一行连成一行。后果不只是难看：
 *      下游用 `filter(l => !l.startsWith('# '))` 去头，会把**每一页正文的第一行**
 *      当成页头丢掉（摘要和喂给模型的材料都少了开头）。
 *      现在改成显式的 `header + '\n\n' + content`，正文从第一个空行之后开始。
 *
 *   ② 重定向页被当成正文收进库。全站 57 个 en + 11 个 zh 页面其实是
 *      `#REDIRECT [[真页面]]` 的空壳（25~300 字节）。两个害处：
 *        · 制造大小写孪生（`Ghost Event` 与 `Ghost event` 同名不同大小写），
 *          **在 Windows 上克隆这个仓库时两者会互相覆盖**，git 报假改动，
 *          一旦提交就等于删掉真实页面；
 *        · 检索时空壳标题精确命中，会顶掉真正有内容的页面。
 *      现在：重定向页**不落 pages/、不进索引**，改为记进 redirects.json，
 *      由 phasmo-lib.mjs 在检索时把别名展开到真页面。
 *
 *      ⚠️ 判定重定向**只能用 `apfilterredir`**：Fandom 的
 *      `prop=pageprops&ppprop=redirect` **不返回任何东西**（详情见 fetchState 的注释）。
 *      第一次修的时候就栽在这上面——脚本不报错，只是安静地得到「重定向 0 页」。
 *      正则只用来从正文里取目标标题。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const OUT = process.cwd();

// 数据格式版本。改动页头结构或落盘策略时 +1 —— 会让下一次运行强制全量重抓
// （见 syncSite 里的 fmtBump），这样旧格式文件会被就地升级，不用手工迁移。
const FMT = 2;

// 英文站 + 中文站（同一套 API，换路径前缀）。中文站是给中文群的答案来源。
const SITES = [
  { lang: 'en', api: process.env.WIKI_API_EN || 'https://phasmophobia.fandom.com/api.php' },
  { lang: 'zh', api: process.env.WIKI_API_ZH || 'https://phasmophobia.fandom.com/zh/api.php' },
];

const UA = 'phasmo-wiki-feed/1.0 (https://github.com/SudierthSP/phasmo-wiki-feed; contact: SudierthSP@users.noreply.github.com)';

// 请求间隔：站点不拦（实测 20 次串行全 200），但每请求都到源站，主动克制。
// 测试里用 FETCH_DELAY_MS=0 把它关掉。
const DELAY_MS = Number(process.env.FETCH_DELAY_MS ?? 1000);
// 一次批量取多少页的正文。50 页约 250 KB，稳（也是 MediaWiki 单次 titles 的上限）。
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

/**
 * 精确按文件名删除。
 *
 * ⚠️ 不能写成 `fs.existsSync(p) && fs.unlinkSync(p)`：Windows 的文件系统不区分大小写，
 * 删 `Ghost event.txt` 会**真的删掉** `Ghost Event.txt`（那是正文页）。
 * 2026-09-19 踩过：在本地跑一遍就把正文页删了，而且下一轮又「发现文件存在」再删一次，
 * `.dirty` 永远是 1，提交里全是噪声。
 * 改成先读目录拿到**真实文件名**再精确比对。
 */
function unlinkExact(dir, name) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return false; }
  if (!names.includes(name)) return false;
  try { fs.unlinkSync(path.join(dir, name)); return true; } catch { return false; }
}

/** MediaWiki 标题规范化：下划线等同于空格，连续空白并成一个。 */
function normalizeTitle(t) {
  return String(t).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 页头与正文的分隔：**第一个空行**。
 * 提取正文的规则必须和写文件的规则成对，所以这里写死一处、两处（本文件与
 * phasmo-lib.mjs）保持一致。旧格式（页头与正文粘连）由 phasmo-lib 单独兼容。
 */
function stripHeader(raw) {
  const i = raw.indexOf('\n\n');
  return i >= 0 ? raw.slice(i + 2) : raw;
}

/** 从重定向页正文里取目标标题。只用它取名字，页是不是重定向由 apfilterredir 决定。 */
function parseRedirectTarget(content) {
  const m = String(content).match(/#\s*(?:REDIRECT|重定向)\s*:?\s*\[\[([^\]|#]+)/i);
  return m ? normalizeTitle(m[1]) : null;
}

/**
 * 全站 ns0 页面的「标题 → revid/时间戳/是否重定向」。
 *
 * ⚠️ 判定重定向**只能靠 `apfilterredir`**。
 *    2026-09-19 实测：Fandom 的 `prop=pageprops&ppprop=redirect` **不返回任何东西**——
 *    `Ghost event`、`Van` 这类重定向页在 pageprops 里只有 `fandomdescription`
 *    或者干脆没有 pageprops。照抄通用 MediaWiki 教程会得到「重定向 0 页」，
 *    而且**脚本不报错**（第一次上线就是这么静默失败的）。
 *    对照数据：`apfilterredir=redirects` 得 57 条，`nonredirects` 得 321 条，57+321=378。
 *
 * 所以分两步：先按 `list=allpages` 拿重定向标题集合，再按 generator 拿 revid。
 */
async function fetchState(apiBase) {
  // ---- 1. 重定向标题集合（权威来源）----
  const redirects = new Set();
  let cont = null;
  do {
    const params = {
      action: 'query', list: 'allpages', apnamespace: '0', aplimit: '500',
      apfilterredir: 'redirects',
    };
    if (cont) Object.assign(params, cont);
    const data = await api(apiBase, params);
    for (const p of data.query?.allpages ?? []) redirects.add(p.title);
    cont = data.continue ?? null;
    if (cont) await sleep(DELAY_MS);
  } while (cont);

  // ---- 2. 全站 revid / 时间戳 ----
  const pages = {};
  cont = null;
  do {
    const params = {
      action: 'query', generator: 'allpages', gapnamespace: '0', gaplimit: '500',
      prop: 'revisions', rvprop: 'ids|timestamp',
    };
    if (cont) Object.assign(params, cont);
    const data = await api(apiBase, params);
    for (const p of data.query?.pages ?? []) {
      const rev = p.revisions?.[0];
      if (!rev) continue;
      pages[p.title] = { revid: rev.revid, ts: rev.timestamp, redirect: redirects.has(p.title) };
    }
    cont = data.continue ?? null;
    if (cont) await sleep(DELAY_MS);
  } while (cont);

  return { pages, redirectCount: redirects.size };
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

/**
 * 把「别名 → 原始目标」解析成「别名 → 真实存在的正文页」。
 * 需要处理三种情况，全是实测遇到的：
 *   · 链式重定向：Salt shaker → Salt Shaker → Salt
 *   · 下划线写法：Tarot → Tarot_Cards（真标题是 Tarot Cards）
 *   · 死链：目标页自己没了
 * 返回 { resolved, unresolved, chains }。
 */
function resolveRedirects(rawMap, realTitles) {
  const lowerToReal = new Map();
  for (const t of realTitles) lowerToReal.set(t.toLowerCase(), t);

  // 别名（小写）→ 原始目标。**只当兜底**：链式跳转优先用精确标题查 rawMap，
  // 因为真实数据里 `Salt Shaker` 和 `Salt shaker` 同时是重定向，
  // 按小写归并会让它们互相覆盖（实测踩过）。
  const lowerTarget = new Map();
  for (const [k, v] of Object.entries(rawMap)) {
    if (!lowerTarget.has(k.toLowerCase())) lowerTarget.set(k.toLowerCase(), v);
  }

  const resolved = {};
  const unresolved = {};
  const chains = {};

  for (const [alias, rawTarget] of Object.entries(rawMap)) {
    let cur = normalizeTitle(rawTarget);
    const hops = [cur];
    // ⚠️ 防环用**精确标题**，不能用小写：
    //    `Ghost event → [[Ghost Event]]` 是合法的大小写重定向（首字母之外大小写敏感），
    //    按小写去重会把它误判成自环，整条别名就丢了（实测踩过）。
    const seen = new Set([alias]);
    let hit = null;

    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(cur)) break;                 // 自环
      seen.add(cur);

      const real = lowerToReal.get(cur.toLowerCase());
      if (real) { hit = real; break; }          // 落到正文页了

      const next = rawMap[cur] ?? lowerTarget.get(cur.toLowerCase());
      if (!next) break;                         // 死链
      cur = normalizeTitle(next);
      hops.push(cur);
    }

    if (hit) {
      resolved[alias] = hit;
      if (hops.length > 1) chains[alias] = [alias, ...hops, hit];
    } else {
      unresolved[alias] = cur;
    }
  }
  return { resolved, unresolved, chains };
}

/** 取一个站的全部正文并落盘。 */
async function syncSite(site, globalLog, redirectsOut) {
  console.log(`\n=== [${site.lang}] ${site.api} ===`);
  const pagesDir = path.join(OUT, 'pages', site.lang);
  const histDir  = path.join(OUT, 'history', site.lang);
  const statePath = path.join(OUT, 'state', `${site.lang}.json`);

  const prev = readJson(statePath, { pages: {} });
  const prevPages = prev.pages ?? {};

  const now = await fetchState(site.api);
  const nowPages = now.pages;
  const titles = Object.keys(nowPages);
  console.log(`  当前 ${titles.length} 页，上次 ${Object.keys(prevPages).length} 页`);

  const redirectTitles = titles.filter(t => nowPages[t].redirect);
  const contentTitles = titles.filter(t => !nowPages[t].redirect);
  console.log(`  其中重定向 ${redirectTitles.length} 页（不落盘，只做别名）`);

  const changed = contentTitles.filter(t => prevPages[t]?.revid !== nowPages[t].revid);
  const removed = Object.keys(prevPages).filter(t => !(t in nowPages));
  const bootstrap = Object.keys(prevPages).length === 0;
  // 格式升级：状态文件里的版本对不上 → 全量重写一遍（但不算「变动」，不写变更日志）
  const fmtBump = !bootstrap && prev.fmt !== FMT;
  const fullFetch = bootstrap || fmtBump;
  console.log(`  正文变动 ${changed.length} 页${bootstrap ? '（首次全量）' : ''}${fmtBump ? `（格式升级 → 全量重写）` : ''}，消失 ${removed.length} 页`);

  const stamp = new Date().toISOString();
  let wroteAnything = false;
  const writeFile = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8'); wroteAnything = true; };

  // ---- 1. 重定向：抓正文只为拿目标标题，然后清掉 pages/ 里可能残留的旧文件 ----
  const rawRedirectMap = {};
  for (let i = 0; i < redirectTitles.length; i += BATCH) {
    const batch = redirectTitles.slice(i, i + BATCH);
    let got = [];
    try { got = await fetchBatch(site.api, batch); }
    catch (e) { console.warn(`  重定向批次 ${i / BATCH} 失败: ${e.message}`); }
    for (const p of got) {
      const target = parseRedirectTarget(p.content);
      if (target) rawRedirectMap[p.title] = target;
    }
    if (i + BATCH < redirectTitles.length) await sleep(DELAY_MS);
  }
  for (const t of redirectTitles) {
    // 用 unlinkExact：不能因为 Windows 大小写不敏感而删掉同名的正文页
    if (unlinkExact(pagesDir, safeName(t) + '.txt')) wroteAnything = true;
  }
  console.log(`  重定向别名 ${Object.keys(rawRedirectMap).length} 条`);

  // ---- 2. 正文页落盘 ----
  const toFetch = fullFetch ? contentTitles : changed;
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
      ].filter(Boolean).join('\n');

      // ⚠️ 这里的 '\n\n' 是正文的起始标记，别改（见文件头 bug ① 的说明）
      const text = header + '\n\n' + p.content;
      writeFile(path.join(pagesDir, fname), text);

      // 历史版本：只对**确实变动过**的页留档
      // （首次全量、格式升级都不留，否则一次就是 700 个文件）
      const reallyChanged = prevPages[p.title]?.revid !== p.revid;
      if (!fullFetch || (fmtBump && reallyChanged)) {
        writeFile(path.join(histDir, safeName(p.title), `${p.revid}.txt`), text);
      }

      // 格式升级且内容没变 → 只重写文件，不记变更（否则播报会变成「共 700 处变动」）
      if (bootstrap || !fmtBump || reallyChanged) {
        globalLog.push(JSON.stringify({
          ts: stamp, lang: site.lang, title: p.title, revid: p.revid,
          prevRevid: prevPages[p.title]?.revid ?? null,
          kind: prevPages[p.title] ? 'edit' : 'new',
          user: p.user ?? '', comment: p.comment ?? '',
          bytes: p.bytes, pageTs: p.ts,
        }));
      }
    }
    console.log(`  [${i + got.length}/${toFetch.length}] 已落盘`);
    await sleep(DELAY_MS);
  }

  // ---- 3. 别名解析 ----
  const realTitles = contentTitles;
  const { resolved, unresolved, chains } = resolveRedirects(rawRedirectMap, realTitles);
  redirectsOut.langs[site.lang] = resolved;
  redirectsOut.unresolved[site.lang] = unresolved;
  redirectsOut.chains[site.lang] = chains;
  redirectsOut.counts[site.lang] = Object.keys(resolved).length;
  if (Object.keys(unresolved).length) {
    console.log(`  ⚠ ${Object.keys(unresolved).length} 个别名没解析到正文页，已记进 redirects.json 的 unresolved`);
  }

  // ---- 4. 被删的页：从 pages/ 移除 ----
  for (const t of removed) {
    const existed = unlinkExact(pagesDir, safeName(t) + '.txt');
    if (existed) wroteAnything = true;
    // 重定向页没了不算内容变动，不播报
    if (!prevPages[t]?.redirect) {
      globalLog.push(JSON.stringify({ ts: stamp, lang: site.lang, title: t, kind: 'removed' }));
    }
  }

  // ---- 5. 索引：只收正文页 ----
  const index = [];
  for (const t of realTitles) {
    const fname = safeName(t) + '.txt';
    const full = path.join(pagesDir, fname);
    let excerpt = '';
    let bytes = 0;
    try {
      const raw = fs.readFileSync(full, 'utf8');
      bytes = Buffer.byteLength(raw, 'utf8');
      excerpt = stripHeader(raw).replace(/\s+/g, ' ').trim().slice(0, EXCERPT);
    } catch { /* 本轮没拿到（批次失败） */ }
    index.push({ t, f: `pages/${site.lang}/${fname}`, b: bytes, r: nowPages[t].revid, x: excerpt });
  }

  writeJson(statePath, {
    fmt: FMT, updated: stamp, api: site.api,
    pageCount: titles.length, redirectCount: redirectTitles.length, pages: nowPages,
  });

  console.log(`  [${site.lang}] 索引 ${index.length} 条（正文页），别名 ${Object.keys(resolved).length} 条`);
  return { index, wroteAnything };
}

async function main() {
  const index = { generated: new Date().toISOString(), counts: {}, langs: {} };
  const redirectsOut = { generated: index.generated, counts: {}, langs: {}, unresolved: {}, chains: {} };
  const globalLog = [];
  let wroteAnything = false;

  for (const site of SITES) {
    const { index: idx, wroteAnything: w } = await syncSite(site, globalLog, redirectsOut);
    index.langs[site.lang] = idx;
    index.counts[site.lang] = idx.length;
    wroteAnything = wroteAnything || w;
  }

  writeJson(path.join(OUT, 'index.json'), index);

  // redirects.json 每次都重写，但只有**内容**变了才算变动。
  // 不能直接比文本：generated 时间戳每轮都不同，会导致每 3 小时一个空提交。
  const redirPath = path.join(OUT, 'redirects.json');
  const canonical = o => JSON.stringify({ counts: o.counts, langs: o.langs, unresolved: o.unresolved, chains: o.chains });
  let redirectsChanged = true;
  try { redirectsChanged = canonical(readJson(redirPath, {})) !== canonical(redirectsOut); } catch { /* 首次 */ }
  fs.writeFileSync(redirPath, JSON.stringify(redirectsOut, null, 2) + '\n', 'utf8');

  if (globalLog.length) {
    fs.appendFileSync(path.join(OUT, 'changes.jsonl'), globalLog.join('\n') + '\n', 'utf8');
  }

  // 判定「要不要提交」：变更日志、文件重写、别名表内容变化，三者任一即可
  const dirty = globalLog.length > 0 || wroteAnything || redirectsChanged;
  fs.writeFileSync(path.join(OUT, '.dirty'), dirty ? '1' : '0', 'utf8');
  console.log(`\n总计：en ${index.counts.en ?? 0} 页 + zh ${index.counts.zh ?? 0} 页；`
    + `别名 ${Object.values(redirectsOut.counts).reduce((a, b) => a + b, 0)} 条；变更日志 ${globalLog.length} 条`);
  console.log(dirty ? '有变动' : '无变动');
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
