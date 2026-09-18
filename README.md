# phasmo-wiki-feed

《恐鬼症 Phasmophobia》wiki 的定时快照。给 550v QQ 机器人当知识库用。

## 为什么需要它（而不是让机器人自己抓）

实测（2026-09-19）：

| 从哪 | 能不能到 Fandom |
|---|---|
| 大陆阿里云 ECS（机器人所在地） | ❌ 连接被拒 / 超时 |
| sp 的 PC 直连 | ❌ 超时（21 秒） |
| sp 的 PC 走 Clash 代理 | ✅ 可以 |
| **GitHub Actions runner** | ✅ 可以（墙外） |
| 阿里云 → GitHub | ✅ 可达（`github.com` 200） |

所以：**抓取放在这里（Actions runner 在墙外），服务器只从 GitHub 拉小文件。**
这样既不依赖 sp 的 PC 常开，也不需要在大陆机器上搞代理。

## 它产出什么

| 文件 | 内容 | 体积量级 |
|---|---|---|
| `state.json` | 全站 ns0 页面的「标题 → 当前 revid + 时间戳」 | 约 36 KB |
| `changes.jsonl` | 追加式的变更日志：每行一次变动（时间 / 标题 / revid / 类型） | 每轮几行 |
| `watch/<标题>/<revid>.txt` | **重点页**每次变动时的完整 wikitext（累积成"以前的版本"） | 每版几 KB～几十 KB |

**为什么不存全站正文**：全站正文 1.85 MB，而检测变更只要 36 KB——差 50 倍。
重点页（`fetch.mjs` 里的 `WATCH` 列表）才值得存全量；其余页只记 revid 变动，
需要旧版本时可以去 wiki 自己取（MediaWiki 保留全部历史）。

## 频率

`fetch.yml` 里 `cron: '23 */3 * * *'` —— **每 3 小时**。

依据是实测：这个 wiki 约 **6.1 次编辑/天**，活跃用户只有 **8 人**（近期基本都是一个人 `Darkhooper`）。
每小时查一次没有意义，而且 GitHub 的 cron 本来也不保证准时。

想改频率就改那一行。想立刻跑一次：仓库页 → Actions → fetch wiki snapshot → Run workflow。

## 关于限流（实测，不必担心）

- 连打 12 个请求（间隔 250 ms）→ **12/12 全 200**，没有 429/403/Cloudflare 质询
- 但响应头是 `Cache-Control: no-store` + `CF-Cache-Status: BYPASS` →
  **每个请求都打到源站，CDN 不缓存**，所以脚本里仍主动限制为约 1 请求/秒
- **没有 ETag / Last-Modified** → 条件请求（304）走不通，只能用 revid 比对
- **Atom/RSS feed 全部 403**（Cloudflare）→ 没有推送机制，只能轮询

## ⚠️ 踩到的坑（2026-09-19 首次搭建时）

### 1. workflow 文件里**不能有中文** —— GitHub 会静默忽略

**症状**：文件明明推上去了，`gh api repos/.../actions/workflows` 却返回 `{"total_count":0}`，
`gh workflow run` 报 `404: workflow fetch.yml not found on the default branch`。
**没有报错、没有提示、Actions 页面也不说一句话**——文件就像不存在。

**排查**：加一个纯 ASCII 的极简 `smoke.yml` 做二分 → 它立刻注册成功（`total_count: 1`）。
把 `fetch.yml` 的中文注释和中文 `name:` 全换成英文 → 立刻注册成功（`total_count: 2`）。

**结论**：**这个仓库的 workflow 文件保持纯 ASCII。**中文说明一律写进这个 README。
（具体是中文编码还是那行中文尾注释触发的，没再细分——不值得为它再花一次 CI。）

### 2. 推 `.github/workflows/` 需要 `workflow` 权限

`gh auth refresh -h github.com -s workflow`。
只有 `repo` + `gist` + `read:org` 时，`git push` 会被服务端拒绝：
`refusing to allow an OAuth App to create or update workflow ... without workflow scope`。
这不是 gh 的限制，是 GitHub 服务端的硬要求。

### 3. 本地测不了（但不需要）

Node 的 `fetch` **不认 `HTTPS_PROXY` 环境变量**（curl 认、undici 不认），
所以在这台走 Clash 的 PC 上跑 `node fetch.mjs` 会 `ETIMEDOUT`。
**不用折腾**——它本来就是给 Actions runner（墙外直连）跑的。
要验证就跑一次 workflow：`gh workflow run fetch.yml`。

### 4. 首次运行的 `changes.jsonl` 会很大

第一轮没有 baseline，**全站 378 页都会被记成 `kind: "new"`**（约 50 KB）。
第二轮起就只剩真正变动的那几行。

### 5. 公开仓库 = 服务器端零密钥

私有仓库就得在服务器上放一个只读 PAT，还得轮换。用公开仓库后
**服务器只需一个普通的 HTTPS GET**，不需要任何凭据。
内容本身是 CC-BY-SA 的公开 wiki 数据，不含私人信息。

## 数据来源与授权

内容来自 [Phasmophobia Wiki](https://phasmophobia.fandom.com/)（Fandom 托管，MediaWiki），
采用 **CC-BY-SA** 授权。本仓库只是它的定时快照，同样按 CC-BY-SA 提供；
转载或再发布时请保留署名与相同方式共享。

本仓库与 Fandom、Kinetic Games 均无关联。

