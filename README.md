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
| `pages/<lang>/<标题>.txt` | 全站 ns0 页面正文（含页头注释） | 约 1.9 MB |
| `index.json` | 检索索引：标题 + 摘要 + 路径 + revid | 约 270 KB |
| `redirects.json` | **别名表**：小写名/简称 → 真页面 | 几 KB |
| `state/<lang>.json` | 标题 → 当前 revid + 时间戳 + 是否重定向 | 约 40 KB |
| `changes.jsonl` | 追加式变更日志：时间/标题/revid/作者/备注 | 每轮几行 |
| `history/<lang>/<标题>/<revid>.txt` | 变动过的页的历史版本 | 按需 |

读取方是 `phasmo-lib.mjs`（在 `server-ops\workloads\550v\files\`，部署到服务器 `~/550v/`）。
**改这里的落盘格式时，那个文件要跟着改。**

## 频率

`fetch.yml` 里 `cron: '23 */3 * * *'` —— **每 3 小时**。

依据是实测：这个 wiki 约 **6.1 次编辑/天**，活跃用户只有 **8 人**（近期基本都是一个人 `Darkhopper`）。
每小时查一次没有意义，而且 GitHub 的 cron 本来也不保证准时。

想改频率就改那一行。想立刻跑一次：`gh workflow run fetch.yml`，
或仓库页 → Actions → fetch wiki snapshot → Run workflow。

## 怎么测（不用联网）

```bash
node test-fetch.mjs
```

它起一个假的 MediaWiki HTTP 服务器，把已知会出问题的几种页面喂进去，
跑真正的 `fetch.mjs`，再检查落盘结果。覆盖页头分隔、重定向（含**链式**和
**下划线标题**）、大小写孪生、`.dirty` 判定这几条路径。38 项断言，秒级完成。

> **别用 `spawnSync` 跑它。** 假服务器就在测试进程里，`spawnSync` 会阻塞事件循环，
> 子进程的 HTTP 请求永远等不到响应——直接死锁。

---

## ⚠️ 两个数据格式上的坑（2026-09-19 修）

### 1. 页头不能和正文粘连

原来写文件是这么拼的：

```js
[...header, ''].filter(Boolean).join('\n') + content
```

`filter(Boolean)` 把那个当分隔符用的空串**也滤掉了**，于是
`# 源: <url>` 和正文第一行连成一行。后果不只是难看：下游（`phasmo-lib.mjs`）
按 `filter(l => !l.startsWith('# '))` 去页头，**每一页正文的第一行都被当成页头删掉了**。

现在改成显式的 `header + '\n\n' + content`，正文从**第一个空行**之后开始。
`state/<lang>.json` 里有 `fmt` 字段，这个值一变就会强制全量重写所有页面
（见 `fetch.mjs` 的 `FMT` 常量），所以旧数据不用手工迁移。

### 2. 重定向不能当成正文收进库

全站有 **50 个 en + 11 个 zh** 页面其实是 `#REDIRECT [[真页面]]` 的空壳（25~300 字节）。
两个害处：

- **制造大小写孪生**（`Ghost Event` 与 `Ghost event` 同名不同大小写，13 组）→ 见下一节
- **检索污染**：空壳标题精确命中拿 40 分，真正有内容的页面只能靠 `includes` 拿 12 分

实测的典型翻车（修之前）：

```
问：Van 在哪
  [41.0] en Van  (19 字符)          ← 喂给模型的材料就是 "#REDIRECT [[Truck]]"
问：Sanity Pills
  [25.0] en Sanity Pills (31 字符)   ← 空壳顶掉了真页面 Sanity Medication
```

现在：重定向**不落 `pages/`、不进索引**，改为记进 `redirects.json`，
由 `phasmo-lib.mjs` 在检索时把别名展开到真页面。

判定不靠正则猜——用 API 的 `prop=pageprops&ppprop=redirect`；
正则只用来从正文里取目标标题。解析时会处理：

- **链式跳转**：`Salt shaker → Salt Shaker → Salt`
- **下划线标题**：`Tarot → Tarot_Cards`（真标题是 `Tarot Cards`）
- **死链**：目标页自己没了 → 进 `redirects.json` 的 `unresolved`

---

## ⚠️ 不要在 Windows 上克隆这个仓库（除非重定向已清干净）

修之前，`pages/en/` 里有 **13 组只差大小写的文件名**。Windows 文件系统不区分大小写，
克隆时两者会**互相覆盖**：

- 已提交的树里 en 有 **378** 个页面，Windows 上只落地 **365** 个
- `git status` 会报那 13 个文件"被修改"
- **一旦 `git add -A && git commit`，就等于把 13 个真实页面替换成重定向空壳**

（自身查证：`git -c core.ignorecase=false status` 下这 13 个大写文件显示为 `D` 删除。）

重定向清掉之后这个冲突会自然消失（13 组里每组至少有一个是重定向）。
在那之前：**在 Windows 上只读不写**，要提交就在 WSL/Linux 里做。

顺带一条同源的坑：写代码时**别用 `fs.existsSync(p) && fs.unlinkSync(p)` 删文件**——
Windows 上 `existsSync('Ghost event.txt')` 会因为大小写不敏感命中 `Ghost Event.txt`，
把正文页删掉。`fetch.mjs` 里的 `unlinkExact()` 就是为此存在的：先 `readdir` 拿真实文件名再精确比对。

---

## 其余踩过的坑

### workflow 文件里**不能有中文** —— GitHub 会静默忽略

**症状**：文件明明推上去了，`gh api repos/.../actions/workflows` 却返回 `{"total_count":0}`，
`gh workflow run` 报 `404: workflow fetch.yml not found on the default branch`。
**没有报错、没有提示、Actions 页面也不说一句话**——文件就像不存在。

**排查**：加一个纯 ASCII 的极简 `smoke.yml` 做二分 → 它立刻注册成功（`total_count: 1`）。
把 `fetch.yml` 的中文注释和中文 `name:` 全换成英文 → 立刻注册成功（`total_count: 2`）。

**结论**：**这个仓库的 workflow 文件保持纯 ASCII。** 中文说明一律写进这个 README。

### 推 `.github/workflows/` 需要 `workflow` 权限

`gh auth refresh -h github.com -s workflow`。
只有 `repo` + `gist` + `read:org` 时，`git push` 会被服务端拒绝：
`refusing to allow an OAuth App to create or update workflow ... without workflow scope`。
这不是 gh 的限制，是 GitHub 服务端的硬要求。

### 本地连不上真站（但测试不需要）

Node 的 `fetch` **不认 `HTTPS_PROXY` 环境变量**（curl 认、undici 不认），
所以在这台走 Clash 的 PC 上跑真的抓取会 `ETIMEDOUT`。
要验证真实抓取就跑一次 workflow：`gh workflow run fetch.yml`。

（`test-fetch.mjs` 走的是本地假服务器，不受影响。）

### 首次运行的 `changes.jsonl` 会很大

第一轮没有 baseline，全站 700+ 页都会被记成 `kind: "new"`。
第二轮起就只剩真正变动的那几行。

### 公开仓库 = 服务器端零密钥

私有仓库就得在服务器上放一个只读 PAT，还得轮换。用公开仓库后
**服务器只需一个普通的 HTTPS GET**，不需要任何凭据。
内容本身是 CC-BY-SA 的公开 wiki 数据，不含私人信息。

---

## 数据来源与授权

内容来自 [Phasmophobia Wiki](https://phasmophobia.fandom.com/)（Fandom 托管，MediaWiki），
采用 **CC-BY-SA** 授权。本仓库只是它的定时快照，同样按 CC-BY-SA 提供；
转载或再发布时请保留署名与相同方式共享。

本仓库与 Fandom、Kinetic Games 均无关联。
