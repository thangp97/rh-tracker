# rh-tracker — Robinhood Chain wallet deploy/launch tracker

Theo dõi ví `0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49` trên Robinhood Chain (chainId 4663):
báo Telegram ngay khi ví **deploy adapter** và khi **launch token** trên Pons v2.

## Cấu trúc

```
rh-tracker/
├── track-ws.js         # Bot 1: theo dõi ví deploy/launch trên Pons (RPC failover + dự phòng Blockscout)
├── track-index.js      # Bot 2: canh khi theindex TÍCH HỢP pools.trade + lưu token index launch
├── lib/
│   ├── env.js          # nạp .env
│   ├── guard.js        # bắt lỗi toàn cục (không chết âm thầm)
│   ├── bot.js          # Telegram: gửi cảnh báo (retry, không mất tin) + lắng nghe lệnh
│   ├── rpc.js          # nhiều RPC failover + auto-reconnect WebSocket
│   ├── blockscout.js   # nguồn log DỰ PHÒNG độc lập (REST) khi mọi RPC chết
│   ├── theindex.js     # (Bot 2) đọc trạng thái tích hợp từ theindex app.js + /api/assets
│   ├── poolstrade.js   # (Bot 2) client tRPC của pools.trade (category/launchpad/launches)
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
```

Chạy 24/7 trên VPS bằng pm2:
```bash
npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
pm2 logs rh-tracker
```

## Lệnh Telegram (gõ trong chat với bot)

Bot 1 (rh-tracker): `/status` `/health` `/ping` `/tokens` `/adapters` `/help`

## Bot 2 — theindex ↔ pools.trade (`track-index.js`)

Canh khi **theindex** (nền tảng index/stocks) tích hợp vào **pools.trade** (launchpad token trên Robinhood Chain), báo Telegram, và **lưu mọi token index** launch trên pools.trade.

Hybrid 3 watcher — cảnh báo khi BẤT KỲ tín hiệu nào "dương" (so với **baseline cứng đã biết**):
- **W1** — `theindex/app.js` (conditional-GET/ETag): `poolstrade` xuất hiện trong danh sách launchpad **tích hợp gốc** (hiện: `pons`, `letscash`; Pons đã tích hợp index).
- **W2** — pools.trade tRPC: **category mới** (ngoài `volume/recency/linked-x/trending`) hoặc **launchpadId mới** (ngoài `uniswap-bonding-curve`, `uniswap-cca`).
- **W3** — **on-chain**: bắt sự kiện `TokenLaunched` từ launcher pools.trade có **cặp ghép ∈ stock/index** (194 mã cổ phiếu + INDEX/PONS/CASHCAT) — bằng chứng chắc nhất; dùng RPC failover + dự phòng Blockscout của Bot 1, quét từ block 0 để bắt cả launch đã có.
- Khi phát hiện tích hợp → mỗi chu kỳ **quét & lưu token index mới** (dedupe theo CA).

```bash
node track-index.js     # hoặc: npm run index
```

⚠️ **Cần Telegram bot token RIÊNG** cho Bot 2 (`INDEX_TELEGRAM_BOT_TOKEN` trong `.env`) — Telegram getUpdates độc quyền, không dùng chung token với Bot 1.

Lệnh Bot 2: `/status` `/health` `/ping` `/watchers` `/assets` `/token` `/help`
(`/token` liệt kê các token index đã launch trên pools.trade)

## Test

```bash
node test/test-rpcs.js       # RPC nào còn sống + nhanh (ALCHEMY_URL=<url> để test thêm endpoint)
node test/test-telegram.js   # kênh cảnh báo OK chưa
npm test                     # offline: test-commands + persist + outbox + index-detect
npm run test:fallback        # bug#1 (không treo khi RPC chết) + fallback Blockscout (cần mạng)
npm run test:index           # Bot 2: W1/W2 đọc đúng hiện trạng theindex/pools.trade (cần mạng)
node test/backtest.js        # kiểm chứng nguồn Blockscout REST trên dữ liệu quá khứ
node test/backtest-fixes.js  # kiểm chứng các fix của track-ws (cần RPC_URL)
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
- Chỉ dùng RPC uy tín (official + tenderly đã kiểm tra OK cho getLogs address-less).
  - `publicnode` CHẶN getLogs address-less → không quét được adapter, đừng dùng.
  - Alchemy free giới hạn getLogs 10 block/lần → chỉ hợp quét live, không hợp nạp lịch sử (cần PAYG).
- **Dự phòng khi mọi RPC chết**: `track-ws.js` tự rơi xuống Blockscout REST (nguồn độc lập, không cần key)
  để không bị "mù"; báo 🟡 khi chuyển dự phòng, 🟢 khi RPC phục hồi.
- Adapter đã biết được lưu ở `ws_adapters.json` → khởi động lại **không** re-scan toàn lịch sử.
- Tracker chỉ **đọc** on-chain — không đụng private key/giao dịch.
