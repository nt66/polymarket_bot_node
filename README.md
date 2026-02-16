# Polymarket BTC 15min 套利 Bot

Node.js + TypeScript 实现的 Polymarket 套利机器人，目标板块为 **Crypto BTC 15min**，支持三种策略与启动/停止命令。

## 功能

1. **连接 Polymarket API**：自动买入/卖出（通过 CLOB + 私钥/API 凭证）
2. **目标板块**：Crypto BTC 15min（可通过 Gamma tag 或 slug 配置）
3. **三种套利策略**：
   - **跨平台信息差套利 (Latency Arbitrage)**：监控 OKX WebSocket BTC 价格，跳动超过阈值时在 Polymarket 吃旧价挂单
   - **负风险组合套利 (Negative Risk Arb)**：当 YES 卖一 + NO 卖一 < 1（扣除手续费）时同时买入两边
   - **末日轮概率博弈 (Expected Value Arb)**：结算前 1–2 分钟根据理论胜率与市场票价差下注
4. **启动/停止**：`npm run start` 启动，`npm run stop` 请求停止（或创建 `.polymarket-bot-stop` 文件）

## 项目结构（模块化）

```
src/
  config/         # 配置（环境变量）
  api/           # Gamma、CLOB、OKX WebSocket
  strategies/    # 三种策略逻辑
  execution/     # 下单执行
  runner.ts      # 主循环
  index.ts       # CLI 入口
```

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

- `PRIVATE_KEY`：Polymarket 账户私钥（从 reveal.polymarket.com 或钱包导出）
- `POLYMARKET_FUNDER_ADDRESS`：Polymarket 资金地址（设置页面的 Profile 地址）
- `SIGNATURE_TYPE`：0=EOA, 1=Magic/Email, 2=Gnosis Safe（常用 2）
- 可选：`POLY_API_KEY` / `POLY_SECRET` / `POLY_PASSPHRASE`（不填则用私钥自动 createOrDerive）
- `STRATEGY_LATENCY_ARB` / `STRATEGY_NEG_RISK_ARB` / `STRATEGY_EV_ARB`：策略开关（true/false）
- `LATENCY_PRICE_JUMP_THRESHOLD`：OKX 价格跳动阈值（美元）
- `NEG_RISK_MAX_SUM`：负风险套利 YES+NO 买一价之和上限（如 0.98）
- `EV_ARB_LAST_SECONDS`：末日轮在最后多少秒内启动（如 120）
- **`BTC_15MIN_SLUG`**（推荐）或 **`BTC_15MIN_TAG_ID`**：必填其一，否则不会拉取到市场、也不会下单。打开 [polymarket.com/crypto/15M](https://polymarket.com/crypto/15M)，点进某个「BTC Up/Down」事件，浏览器地址栏里 `/event/` 后面的那一段即为 slug（如 `btc-updown-15m-1739347200`），填到 `BTC_15MIN_SLUG`

## 命令

```bash
npm install
npm run build
npm run start    # 启动 bot
npm run stop     # 请求停止（下次轮询时退出）
npm run dev      # 开发模式（tsx 直接跑 src）
```

## 远程部署：停止服务与查看输出

部署到远程机器后，若用 SSH 直接跑 `npm run start`，断开连接后进程会退出，且不方便随时看日志。推荐用 **PM2** 管理进程，既能后台常驻，又能随时停止、查看终端输出。

### 1. 安装 PM2（远程机上一次即可）

```bash
npm install -g pm2
```

### 2. 启动服务（在项目根目录执行）

```bash
cd /path/to/polymarket_bot_node
npm run build
mkdir -p logs
pm2 start ecosystem.config.cjs
```

### 3. 停止服务

任选其一即可：

- **推荐**：`pm2 stop polymarket-bot` — 停止进程（可随时 `pm2 start polymarket-bot` 再启）
- 或在同一项目目录下执行 `npm run stop` — 写入停止标记，bot 下次轮询时自己退出（优雅退出）
- 或 `pm2 delete polymarket-bot` — 从 PM2 列表移除（需再启动时用 `pm2 start ecosystem.config.cjs`）

### 4. 查看终端输出

- **实时看日志（类似 terminal 输出）**：`pm2 logs polymarket-bot`
- 只看最近 200 行：`pm2 logs polymarket-bot --lines 200`
- 查看状态：`pm2 status`
- 日志也写在 `./logs/out.log` 和 `./logs/err.log`，可直接 `tail -f logs/out.log`

### 5. 其他常用命令

```bash
pm2 restart polymarket-bot   # 重启
pm2 flush polymarket-bot     # 清空当前日志缓冲
```

若不想用 PM2，也可用 **screen** / **tmux**：在 session 里运行 `npm run start`，需要看输出时 SSH 上去执行 `screen -r` 或 `tmux attach` 即可；停止时在同一 session 里 Ctrl+C，或另开终端到项目目录执行 `npm run stop`。

## 依赖

- Node.js >= 18
- `@polymarket/clob-client`：Polymarket 下单与认证
- `@ethersproject/wallet`：与 CLOB 兼容的签名
- `ws`：OKX WebSocket
- `dotenv`：加载 .env

## 风险与合规

- 套利存在执行延迟、滑点与余额风险，请先用小资金或测试环境验证。
- 遵守 Polymarket 与当地法规，禁止在受限地区使用。
