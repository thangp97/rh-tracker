# easya-tracker — theo dõi token launch trên EasyA/Kickstart (Solana)

Bot Node.js (ESM) lắng nghe on-chain **thời gian thực** và gửi thẻ Telegram ngay khi có token mới tạo trên
launchpad **EasyA / Kickstart** (chạy trên **Meteora Dynamic Bonding Curve / DBC**). Thẻ gồm: tên, symbol,
mint, ví dev + số dư SOL, dev mua bao nhiêu SOL (+ % supply), socials, link Kickstart. Bonus: phát hiện khi
token bị **khoá qua Streamflow** và reply vào thẻ gốc.

> Đây là sub-project ĐỘC LẬP với 2 bot EVM ở thư mục gốc (`track-ws.js` / `track-index.js`). Stack khác hẳn:
> Solana + ESM + `@solana/web3.js` + Helius, nên có `package.json` và `node_modules` riêng.

## Cài đặt & chạy

```bash
cd easya-tracker
npm install
cp .env.example .env      # điền HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
npm test                  # selftest OFFLINE (không cần mạng/secret)
npm start                 # chạy bot (node index.mjs)
```

## Làm sao biết bot THỰC SỰ hoạt động

Kiểm chứng theo từng lớp (không cần ngồi chờ launch EasyA hiếm hoi):

```bash
npm test                     # 1) LOGIC offline (parse/math/lệnh) — không cần key/mạng
node preflight.mjs           # 2) CẤU HÌNH: Helius RPC OK + gửi 1 tin thử vào Telegram
node wscheck.mjs             # 3) WEBSOCKET: nghe 30s trên DBC, đếm event confirmed + in sig launch mẫu
node replay.mjs <signature>  # 4) PIPELINE: replay 1 tx launch THẬT -> in thẻ (đủ dữ liệu đúng chưa?)
node replay.mjs <sig> --send --socials   #   ...và gửi thẻ thật vào Telegram
npm start                    # 5) CHẠY THẬT: thấy "🟢 khởi động"; nhắn bot /ping /status /health
```

- **Bước 3** trả lời trực tiếp nỗi lo "confirmed vs processed": nếu `nhận N event > 0` nghĩa là push hoạt động. `wscheck` còn in sẵn signature các tx có marker launch để bạn `replay`.
- **Bước 4** là bằng chứng mạnh nhất mà không cần chờ: lấy 1 signature launch EasyA (từ bước 3, từ Solscan địa chỉ config `DD3y…HPCqQ`, hoặc từ 1 cảnh báo cũ) và replay — nếu thẻ hiện đúng tên/symbol/mint/dev/% supply thì toàn bộ trích xuất đúng.
- **Bước 5**: bot đang sống khi `/status` có "Event ws gần nhất" cập nhật và `/health` = 🟢.

## Cách phát hiện launch

1. Mở websocket Helius, `logsSubscribe` với **mentions filter = EasyA config**.
2. **Commitment PHẢI `confirmed`** — KHÔNG dùng `processed` (Helius giao im lặng ở processed → mất launch).
3. Chỉ giữ log chứa marker `InitializeVirtualPoolWithSplToken` / `InitializeVirtualPoolWithToken2022` (bỏ swap/spam).
4. Dedupe theo signature.

Websocket chỉ cho logs + signature → `getParsedTransaction` (retry ~8×/300ms). Thứ tự account trong instruction
DBC InitializeVirtualPool: `[0]=config [1]=pool_authority [2]=creator(dev) [3]=base_mint [4]=quote_mint [5]=pool`.
Name/symbol/uri lấy từ inner `CreateMetadataAccountV3` (Borsh). Dev mua / % supply tính từ `postTokenBalances`.

## Telegram: "gửi nhanh, làm giàu bằng edit"

Gửi thẻ NGAY với dữ liệu on-chain (giữ `message_id`), rồi fetch socials (đua nhiều IPFS gateway, NGOÀI đường
tới hạn) và `editMessageText` để thêm mô tả + link social. Độ trễ cảnh báo ~1.5–2.5s bất kể IPFS chậm.

## Streamflow lock (bonus)

Websocket thứ 2 trên program Streamflow. Lock = log có `Instruction: Create` VÀ (`SPL token stream` HOẶC
`escrow`). Mint bị khoá = balance khác WSOL lớn nhất trong `postTokenBalances`. Nếu mint nằm trong Map launch
gần đây (TTL 24h, persist `recent.json`) → reply `🔒 LOCK` vào thẻ gốc.

## Lệnh chat & heartbeat

Bot lắng nghe lệnh Telegram (long-poll `getUpdates`, chỉ nhận từ `TELEGRAM_CHAT_ID`):

`/status` `/health` `/ping` `/tokens` `/help`

`/tokens` liệt kê token đã bắt trong 24h gần đây. Heartbeat `💓` gửi định kỳ mỗi `HEARTBEAT_HOURS` (mặc định 6h).

> ⚠️ `getUpdates` độc quyền theo token → bot này phải dùng **Telegram token RIÊNG** (khác 2 bot EVM ở gốc), nếu không sẽ lỗi 409.

## Vận hành & độ bền

- Chạy dưới supervisor tự-restart (đã thêm app `easya-tracker` vào `../ecosystem.config.js` cho pm2).
- **Failover nhiều endpoint** (chống điểm chết đơn Helius): đặt `SOLANA_RPC_URLS` (nhiều URL, cách nhau dấu phẩy)
  thay cho — hoặc cùng với — `HELIUS_API_KEY`.
  - **RPC**: `getParsedTransaction`/`getBalance`/`getSlot` thử lần lượt các endpoint (`providers.mjs` → `Pool.call`).
  - **Websocket**: `onSlotChange` là "nhịp tim" (bắn ~2/s khi ws sống → phát hiện ws chết ngay cả khi EasyA im).
    Im lặng > 45s → **xoay endpoint + re-subscribe**; vẫn im sau nhiều nhịp → thoát cho supervisor restart.
- **Telegram không mất tin**: cảnh báo nền (startup/heartbeat/trạng thái) đi qua hàng đợi `queueAlert` — lỗi tạm
  thời (429/5xx/mạng) thì giữ tin và thử lại (backoff), không rớt. Thẻ launch dùng `send()` có retry (giữ `message_id`).
- **1 instance duy nhất**: lockfile `easya.lock` (ghi pid; từ chối chạy nếu lock còn tươi < 45s) để 2 bản không
  gửi trùng. Dedupe sự kiện theo signature.

## Muốn nhanh hơn (dưới 1s)

Sàn độ trễ ≈ commitment `confirmed` (~1–2s). Muốn sub-second: đổi sang Helius **`transactionSubscribe`**
(enhanced websocket — đẩy full tx, khỏi `getParsedTransaction`); cần Helius Developer tier (~$49/tháng).

## Hằng số công khai (program IDs — ai cũng thấy trên Solscan, KHÔNG bí mật)

Xem `dbc.mjs`. Bí mật CHỈ nằm trong `.env` (Helius key + Telegram token), đã gitignore.
