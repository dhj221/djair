# 众和航空 · 客票数据库部署说明

浏览器把出票数据写进 GitHub 仓库，仓库当数据库用：
`tickets/index.json` 当表，每张客票一个 JSON 文件当行，GitHub Actions 负责维护索引。

上线前请先做一件事：

> **去 GitHub 设置里撤销 `checkout.html` 里原来那把明文 PAT。**
> 它曾经直接写在公开网页里，任何访问过的人都可能已经拿到。
> 撤销后重新生成一把 **Fine-grained token**，权限只勾 `Contents: Read and write`，只授权这一个仓库。
> 新 token 只放在 Cloudflare Worker 的环境变量里，**永远不要**写进 `.js` / `.html`。

---

## 0. 最快上线（6 步）

1. **撤销旧 token**：GitHub → Settings → Developer settings → Personal access tokens，把 `checkout.html` 里出现过的那把删掉。
2. **新建 token**：Fine-grained token，只勾选本仓库的 `Contents: Read and write`。
3. **部署 Worker**：把 [`worker/worker.js`](worker/worker.js) 部署到 Cloudflare Workers，执行
   `wrangler secret put GITHUB_TOKEN` 填入第 2 步的 token。
4. **填配置**：编辑 [`db-config.js`](db-config.js)，把 `proxyUrl` 改成 Worker 地址。
5. **提交文件**：把 `ticket-db.js`、`db-config.js`、`my-orders.html`、`scripts/`、`.github/workflows/`、`worker/` 一起 push 到 `main`。
6. **测试出票**：在网站正常下一单，仓库里应出现
   `tickets/orders/<年>/<月>/<订单号>.json`；等 Actions 跑完后打开 `my-orders.html`
   用「订单号 + 姓名首字母和证件末四位」查询。

如果第 6 步失败，先看 Worker 日志和浏览器 Console，通常是 token 权限或 `proxyUrl` 没填对。

---

## 1. 目录结构

```text
ticket-db.js                 浏览器端存储层（读写/路径/脱敏/口令哈希）
db-config.js                 仓库坐标 + 写库代理地址（公开文件，不含密钥）
db-config.example.js         配置模板
my-orders.html               订单查询页
scripts/build_ticket_index.py 索引构建脚本（Actions 调用）
.github/workflows/ticket-index.yml
worker/worker.js             写库代理（Cloudflare Worker）

tickets/                     ← 运行后自动出现
├── index.json                       站点索引（列表用）
├── orders/2026/11/PE20261114....json 订单档（无明文证件号）
├── public/2026/PE20261114....json    访客脱敏档
└── PE20261114....txt                 人读客票（仅录票模式生成）
```

订单文件路径由订单号直接推出，查票不需要扫目录：

```text
tickets/orders/<年>/<月>/<订单号>.json
订单号 PE20261114231000123 → tickets/orders/2026/11/PE20261114231000123.json
```

---

## 2. 三种写入方式（按推荐程度）

| 方式 | 谁能写库 | 需要什么 | 适合 |
|---|---|---|---|
| **A. 写库代理**（推荐） | 任何访客 | 部署 `worker/worker.js`，填 `proxyUrl` | 公开上线 |
| **B. 站长录票模式** | 只有你本人的浏览器 | 本机存一把 token | 自己演示、后台补录 |
| **C. 手动存 JSON** | 你自己 | 无 | 备灾 |

没有配置写权限时，`checkout.html` 的「确认并支付」会**直接提示无法保存并停在结算页**，
不会再出现“页面显示已出票，其实什么都没存下来”的假成功。

### A. 写库代理（公开站点用这个）

```bash
npm i -g wrangler
# 在项目根目录新建一个 Worker 项目，把 worker/worker.js 贴进 src/index.js
wrangler secret put GITHUB_TOKEN    # 填新生成的 fine-grained PAT
wrangler secret put DJAIR_SECRET    # 可选：随便一串随机字符
wrangler deploy
```

然后在 [`db-config.js`](db-config.js) 填地址：

```js
window.DJAIR_DB_CONFIG = { proxyUrl: 'https://djair-db-ticket.xxxx.workers.dev/' };
```

建议在 Worker 里再打开两项防护（见 `worker/worker.js` 顶部注释）：

- `ALLOW_ORIGIN` 设成你的站点域名，防止别人直接调你的接口
- `API_KEY` + 前端请求头 `X-Api-Key`，配合你的前端一起使用

> 这毕竟是一个“任何人都能触发写库”的公开站点，建议再加一层人机校验（Turnstile），
> 否则有人可以刷单把你的仓库刷爆。

### B. 站长录票模式

在你要出票的那台电脑上打开任意页面，按 F12 在控制台执行一次：

```js
localStorage.setItem('djair_db_station', '1');
localStorage.setItem('djair_db_token', 'github_pat_xxxxx');   // 只存在这台浏览器
```

之后在本机结算时会用这把 token 直接写库；关闭：

```js
localStorage.removeItem('djair_db_station');
localStorage.removeItem('djair_db_token');
```

---

## 3. 数据怎么存（公开仓库的安全底线）

订单档里**不保存**任何能直接识别身份的字段：

| 原字段 | 入库形式 |
|---|---|
| 证件号码 | `idNoMask`：`E1*****78`、`320**********34` |
| 出生日期 / 国籍 / 签发国 | 不入库 |
| 姓名 | 保留（查票、值机需要） |
| 取票口令 | 只存 SHA-256 哈希 `customerCodeHash` |

完整证件号只留在出票那台浏览器的 `localStorage`（`peace_ticket_latest_txt`），
`payment.html` 的「下载客票 txt」按钮用的是它。

取票口令规则：**姓名首字母 + 证件末四位**，例如 张三 / 320101199001011234 → `Z1234`。
它只做“随手防窥”，不是强认证；真正的保护是：公开档 `tickets/public/` 不含敏感信息。

---

## 4. 索引与查询

推送到 `main` 后，[`ticket-index.yml`](.github/workflows/ticket-index.yml) 会自动运行
[`build_ticket_index.py`](scripts/build_ticket_index.py)，生成：

- `tickets/index.json` —— 列表用，几十条以内读一次就够
- `tickets/public/<年>/<订单号>.json` —— 访客脱敏档

[`my-orders.html`](my-orders.html)：

- **录票模式 / 配了代理**：自动列出全部订单
- **只读模式**：只允许「订单号 + 口令」查询，不开放列表
- 查到的客票点进去跳转 `payment.html?order=订单号`，从数据库回读

如果没有 `index.json`，会自动退回到 GitHub API 现场扫描 `tickets/orders/<年>/<月>`。

> `raw.githubusercontent.com` 有缓存，刚写进去的文件可能几秒内读不到。
> `ticket-db.js` 已经加了时间戳和最多 4 次重试，出票后会做一次「写后自检」。

---

## 5. 已知限制

- 每一次出票 = 一次 commit，仓库提交历史会很多；订单上千后建议改用真正的数据库（Supabase / D1）。
- GitHub Contents API 对同一文件的高频写入会冲突，所以**索引交给 Actions 生成**，前端绝不手写 `index.json`。
- 仓库是 public 时，TXT 档是**脱敏摘要**（证件号只留掩码，不含生日/国籍），
  完整客票文本只留在出票那台浏览器里，不会上传。
- 未登录的 GitHub API 限速为 60 次/小时，现场扫描会在订单多时变慢。
