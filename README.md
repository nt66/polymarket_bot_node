# Polymarket 98 概率买入 Bot（BTC 5min）

Node.js + TypeScript 实现的 Polymarket 机器人，专注 **BTC 5 分钟 Up/Down** 市场：在 0.98/0.99 挂单买入，盈利即卖。

## 功能

1. **目标**：BTC Up or Down 5min 市场，挂单价从 `.env` 配置（如 0.98、0.99）
2. **逻辑**：盘口进入目标价格带时挂限价单，成交后监控买一，涨 0.01 即止盈卖出；最后 15 秒不挂新单，最后 10 秒若 BTC 当前价与 Price to Beat 差 < 5 美元则不挂单
3. **启动/停止**：可直接 `npm run start`，或使用 **PM2** 后台运行（推荐）

## 项目结构

```
src/
  config/         # 配置（环境变量）
  api/            # Gamma、CLOB、BTC 价格（OKX/Binance）
  execution/      # 下单执行
  risk/           # 持仓与风控
  util/           # 按日日志（ET 时间）
  runner.ts       # 主循环（98 挂单 + 止盈）
  index.ts        # CLI 入口
```

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

- `PRIVATE_KEY`：Polymarket 账户私钥
- `POLYMARKET_FUNDER_ADDRESS`：Polymarket 资金地址（Profile 地址）
- `SIGNATURE_TYPE`：0=EOA, 1=Magic/Email, 2=Gnosis Safe（常用 2）
- `BUY98_ORDER_PRICES`：允许挂单的价格，逗号分隔，如 `0.98,0.99`
- `BUY98_ORDER_SIZE_SHARES`：每次买入张数，如 `50`
- `BUY98_MAX_POSITION_PER_MARKET`：单市场最大持仓金额（美元），如 `150`

## 命令（本地直接跑）

```bash
npm install
npm run build
npm run start    # 启动 bot
npm run stop     # 请求停止（下次轮询时退出）
npm run dev      # 开发模式（tsx 直接跑 src）
```

## PM2 启动 / 关闭 / 重启（推荐）

用 PM2 可后台常驻、断 SSH 不退出，并方便启停与看日志。

### 安装 PM2（一次即可）

```bash
npm install -g pm2
```

### 启动

在项目根目录执行（先构建再启动）：

```bash
npm run build
mkdir -p logs
npm run pm2:start
```

或直接：`pm2 start ecosystem.config.cjs`

### 关闭（停止）

```bash
npm run pm2:stop
```

或：`pm2 stop polymarket-bot`。停止后进程仍在 PM2 列表中，可再次 `npm run pm2:start`。

### 重启

```bash
npm run pm2:restart
```

改完代码或配置后，先 `npm run build` 再执行上述重启。

### 查看状态与日志

| 命令 | 说明 |
|------|------|
| `npm run pm2:status` | 查看进程状态（运行中/已停） |
| `npm run pm2:logs` | 实时看终端输出 |
| `pm2 logs polymarket-bot --lines 200` | 最近 200 行 |
| `tail -f logs/out.log` | 看标准输出文件 |
| `tail -f logs/err.log` | 看错误输出文件 |

### 日志轮转（避免 out.log 无限变大）

PM2 默认一直往同一文件追加，长期运行会占满磁盘。建议安装 **pm2-logrotate** 按大小或按天轮转：

```bash
pm2 install pm2-logrotate
```

可选配置（例如单文件最大 10M、保留 3 个备份）：

```bash
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 3
pm2 set pm2-logrotate:compress true
```

之后 `logs/out.log` 超过 10M 会自动轮转为 `out.log.1` 等并压缩，只保留最近 3 份。

### 其他

- **从 PM2 移除**：`pm2 delete polymarket-bot`（之后要启动需重新 `pm2 start ecosystem.config.cjs`）
- **优雅停止**：在项目目录执行 `npm run stop`，bot 会在下次轮询时自行退出（PM2 进程仍存在，状态会变为 stopped）

## 依赖

- Node.js >= 18
- `@polymarket/clob-client`：Polymarket 下单与认证
- `@ethersproject/wallet`：与 CLOB 兼容的签名
- `ws`：WebSocket
- `dotenv`：加载 .env

## 风险与合规

- 套利存在执行延迟、滑点与余额风险，请先用小资金或测试环境验证。
- 遵守 Polymarket 与当地法规，禁止在受限地区使用。
