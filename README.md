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

## 数据来源与授权

内容来自 [Phasmophobia Wiki](https://phasmophobia.fandom.com/)（Fandom 托管，MediaWiki），
采用 **CC-BY-SA** 授权。本仓库只是它的定时快照，同样按 CC-BY-SA 提供；
转载或再发布时请保留署名与相同方式共享。

本仓库与 Fandom、Kinetic Games 均无关联。

<!-- trigger rescan -->
