# rh-tracker — Robinhood Chain wallet deploy/launch tracker

Theo dõi ví `0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49` trên Robinhood Chain (chainId 4663):
báo Telegram ngay khi ví **deploy adapter** và khi **launch token** trên Pons v2.

## Cấu trúc

```
rh-tracker/
├── track-ws.js         # Cách C: ethers + RPC (khuyên dùng), cursor-poll + failover
├── track-rest.js       # Cách B: poll REST Blockscout (không cần RPC node)
├── lib/
│   ├── env.js          # nạp .env
│   ├── guard.js        # bắt lỗi toàn cục (không chết âm thầm)
│   ├── bot.js          # Telegram: gửi cảnh báo (retry, không mất tin) + lắng nghe lệnh
│   ├── rpc.js          # nhiều RPC failover + auto-reconnect WebSocket
│   ├── store.js        # đọc/ghi JSON
│   └── notify.js       # wrapper tương thích (-> bot.send)
├── test/               # backtest + unit test (xem phần Test)
├── ecosystem.config.js # cấu hình pm2 chạy 24/7
├── .env.example        # mẫu cấu hình
└── .gitignore
```

## Cài đặt

```bash
npm install
cp .env.example .env
chmod 600 .env
nano .env               # điền TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

## Chạy

```bash
node track-ws.js        # hoặc: npm run ws
node track-rest.js      # hoặc: npm run rest
```

Chạy 24/7 trên VPS bằng pm2:
```bash
npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
pm2 logs rh-tracker
```

## Lệnh Telegram (gõ trong chat với bot)

`/status` `/health` `/ping` `/tokens` `/adapters` `/help`

## Test

```bash
node test/test-rpcs.js       # RPC nào còn sống + nhanh
node test/test-telegram.js   # kênh cảnh báo OK chưa
npm test                     # test-commands + test-persist + test-outbox
node test/backtest.js        # kiểm chứng Cách B trên dữ liệu quá khứ
node test/backtest-fixes.js  # kiểm chứng các fix của Cách C (cần RPC_URL)
```

## Cấu hình (.env)

| Biến | Ý nghĩa |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token bot từ @BotFather |
| `TELEGRAM_CHAT_ID` | id chat nhận cảnh báo (dùng chat riêng, không dùng group) |
| `RPC_URLS` | nhiều RPC cách nhau dấu phẩy (ưu tiên hơn `RPC_URL`) — dùng cho track-ws |
| `RPC_URL` | một RPC (mặc định official) |
| `CONFIRMATIONS` | số block chờ trước tip để tránh reorg (mặc định 5) |
| `HEARTBEAT_HOURS` | chu kỳ heartbeat (mặc định 6) |
| `ERROR_ALERT_THRESHOLD` | số lỗi liên tiếp trước khi báo 🔴 (mặc định 3) |

## Lưu ý vận hành

- Mỗi bot token chỉ chạy **một** tracker (Telegram getUpdates độc quyền).
- Chỉ dùng RPC uy tín (official + tenderly đã kiểm tra OK cho getLogs).
- Tracker chỉ **đọc** on-chain — không đụng private key/giao dịch.
