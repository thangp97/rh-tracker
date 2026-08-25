# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Đây là gì

Hai bot theo dõi Node.js chạy nền độc lập cho **Robinhood Chain** (chainId 4663), cảnh báo qua Telegram. Chỉ **đọc** on-chain (không đụng private key, không gửi giao dịch). Thiết kế để chạy 24/7 dưới pm2.

- **Bot 1 — `track-ws.js`**: theo dõi ví `0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49`. Cảnh báo khi ví deploy adapter (`AdapterDeployed`) và khi ví launch token qua factory Pons v2 `0x7eD598…EC7e` (`TokenLaunched`).
- **Bot 2 — `track-index.js`**: canh khi **theindex.finance ↔ pools.trade** tích hợp và lưu mọi token "index" launch trên pools.trade.
- **Bot 3 — `easya-tracker/` (Solana)**: sub-project ĐỘC LẬP theo dõi token launch trên EasyA/Kickstart (Meteora DBC). **Stack khác hẳn** hai bot trên — xem mục riêng bên dưới.

Comment trong code và mọi chuỗi hiển thị cho người dùng (Telegram/console) đều bằng **tiếng Việt** — giữ chuỗi mới nhất quán như vậy.

## Lệnh

```bash
npm install                  # phụ thuộc duy nhất là ethers (+ ws, gián tiếp, cho RPC WebSocket)
cp .env.example .env         # rồi điền các token TELEGRAM_*

npm run ws                   # chạy Bot 1 (node track-ws.js)
npm run index                # chạy Bot 2 (node track-index.js)

# Test (xem mục "Test" để biết bài nào cần mạng)
npm test                     # bộ OFFLINE: commands + persist + outbox + index-detect
npm run test:fallback        # bug#1 không treo + dự phòng Blockscout   (CẦN mạng)
npm run test:index           # Bot 2 W1/W2 đọc live                     (CẦN mạng)
npm run test:rpcs            # RPC nào còn sống/nhanh   (ALCHEMY_URL=<url> để test thêm 1 cái)
npm run test:telegram        # kiểm tra kênh cảnh báo có hoạt động

npm run backtest             # kiểm chứng nguồn Blockscout REST trên dữ liệu quá khứ
npm run backtest:ws          # kiểm chứng các fix của track-ws            (CẦN RPC_URL)

# Chạy một file test riêng lẻ:
node test/test-commands.js
```

Chạy 24/7 bằng pm2 (cả hai bot khai báo trong `ecosystem.config.js`):
```bash
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

## Kiến trúc

Không dùng framework. `main()` trong mỗi bot là vòng lặp `while (true)` vô hạn bọc trong try/catch, đếm số lỗi liên tiếp và cảnh báo `🔴` khi vượt `ERROR_ALERT_THRESHOLD`, `🟢` khi phục hồi. Hai bot có cấu trúc y hệt nhau (object `status`, bộ xử lý lệnh `/status /health /ping /help`, heartbeat, hàng đợi alert không chặn, persistence JSON).

**`lib/` dùng chung:**
- `env.js` — nạp `.env` qua `process.loadEnvFile` gốc của Node (không cần dotenv). `require("./lib/env")` phải là dòng **đầu tiên** của mọi script entry.
- `guard.js` — bắt lỗi toàn cục `unhandledRejection` (chỉ log) / `uncaughtException` (cảnh báo + `exit(1)` để pm2 khởi động lại sạch). Ngăn bot chết âm thầm trên VPS.
- `bot.js` — Telegram. `send()` = chặn (startup/reply); `queueAlert()` = hàng đợi nền không chặn, không bao giờ mất tin khi lỗi tạm thời. `listen()` long-poll `getUpdates` để nhận lệnh chat, chỉ chấp nhận `TELEGRAM_CHAT_ID`.
- `rpc.js` — class `Rpc`: nhiều endpoint RPC có failover; lỗi thì xoay sang endpoint kế, và tạo lại provider WebSocket đã chết. `parseUrls` đọc `RPC_URLS` (cách nhau dấu phẩy, ưu tiên) hoặc `RPC_URL`.
- `blockscout.js` — nguồn log REST **độc lập** (không cần node, không cần key). Chuẩn hoá log REST về đúng shape ethers-log để `iface.parseLog()` và khoá dedupe `tx:index` dùng lại được nguyên. Chia nhỏ range và chia đôi khi chạm cap ~1000 log (Blockscout cắt im lặng).
- `store.js` — đọc/ghi JSON best-effort (lỗi → fallback/bỏ qua).
- `tokenmeta.js` — làm giàu thẻ token (cả 2 bot EVM): `name/symbol/decimals/totalSupply` + market cap/giá/volume/holders qua **Blockscout token API**, và **top-10 holder + %** (tính bằng BigInt) qua `/api/v2/tokens/{ca}/holders`. Best-effort (Blockscout lỗi → gửi thẻ trơn). Socials (X/website) **không có** on-chain lẫn Blockscout (`contractURI`/`tokenURI` revert) — muốn thì phải lấy từ pools.trade/Pons. `renderEnrichment` bỏ qua trường null. **Cả hai bot gửi thẻ "trơn" NHANH trước (lấy `message_id`) rồi làm giàu bằng `editMessage` ở NỀN** — Blockscout chậm/404 (token mới) **không chặn** vòng poll/quét. Logic thuần test offline ở `test/test-tokenmeta.js`.
- Chỉ Bot 2: `theindex.js` (trích danh sách launchpad từ bundle `app.js` của theindex, cache theo ETag; đọc `/api/assets`), `poolstrade.js` (client tRPC của pools.trade), `poolstrade-onchain.js` (bộ quét on-chain W3).
- `notify.js` — shim tương thích ngược → `bot.send`.

### Độ bền nguồn dữ liệu (thiết kế cốt lõi)
Mọi lần đọc log/tip đều **thử tất cả RPC (failover) trước, rồi rơi xuống Blockscout REST** để bot không bao giờ bị "mù" khi mọi RPC chết. Bot 1 báo `🟡` khi chuyển sang Blockscout và `🟢` khi RPC phục hồi, quyết định **theo từng chu kỳ poll** qua delta của `bsUseCount` (tránh flap giữa query adapter address-less và query launch có address).

### Chia nhỏ getLogs — bất biến quan trọng (bug #1)
`splitLogs`/`getLogsAdaptive` thử nguyên range trước, và **chỉ chia đôi khi RPC báo lỗi range/kích thước-kết-quả thật sự** (`isRangeError`, khớp theo nội dung message). Lỗi rate-limit và lỗi mạng/kết nối được **ném ngay**, không chia — đây là chủ ý. Bug gốc: mọi lỗi đều kích hoạt chia đôi, nên khi mọi RPC chết lúc khởi động đang nạp `0..tip`, đệ quy bùng nổ và tiến trình treo âm thầm. `LOG_SPLIT_BUDGET` (mặc định 4000) chặn đệ quy cho RPC giới hạn range quá chặt (vd cửa sổ 10 block của Alchemy free) để nó ném → rơi xuống Blockscout thay vì chia hàng triệu lần. Logic này **lặp lại** trong `lib/poolstrade-onchain.js` cho W3 — sửa thì sửa cả hai.

### Hai sự kiện `TokenLaunched` khác nhau
`track-ws.js` giải mã `TokenLaunched(address token, address curve, address deployer, ...)` của **factory Pons v2**. `lib/poolstrade-onchain.js` giải mã `TokenLaunched(bytes32 poolId, address token, address recipient, PoolKey key)` của **launcher pools.trade**. Cùng tên sự kiện, khác ABI/topic — đừng lẫn lộn.

### Push 0-conf 2 nấc (chỉ `track-ws.js`)
Bên cạnh vòng poll, `track-ws` có thể mở `eth_subscribe(logs)` qua websocket (`lib/push.js`) để **báo sớm**: gửi thẻ `⚡ CHỜ XÁC NHẬN` (0-conf) ngay, rồi vòng poll **edit** thành `✅ đã xác nhận` khi tới độ sâu `CONFIRMATIONS`, hoặc `⚠️ reorg` nếu sự kiện không lên chain (`collectReorged`). **Bất biến cốt lõi: push CHỈ để nhanh, poll VẪN là nguồn chân lý** — mọi parse/dedupe/persistence/reorg-sweep nằm ở đường poll; `resolveConfirm(k)` quyết định `edit` (đã có tin 0-conf) hay `fresh`, dùng chung `Set alerted` (khoá `tx:index`) nên push-scan và poll-scan **không báo trùng**. `pending` (Map) và `pendingAdapters` (Set) chỉ **in-memory** (không persist) — chủ ý, để tránh false-reorg sau restart (poll sẽ báo lại `✅` mới, chấp nhận 1 thẻ `⚡` mồ côi). Bật push khi `RPC_URLS` có URL `wss://` hoặc đặt `WS_URL`; không có thì tự tắt, poll chạy như cũ. `lib/bot.js` được thêm `editMessage()` và `send()` trả `message_id` để phục vụ luồng này. Logic 2 nấc test offline ở `test/test-push-logic.js`.

### Mô hình phát hiện của Bot 2 (`track-index.js`)
Ba watcher, cảnh báo nếu **bất kỳ** cái nào dương so với **baseline cứng** (các hằng `KNOWN_NATIVE/KNOWN_CATEGORIES/KNOWN_LAUNCHPADS` — cố ý không dùng snapshot động, để phát hiện được cả tích hợp đã xảy ra trước lần chạy đầu và không bị "đóng băng" trên baseline sai):
- **W1** — `theindex/app.js`: `poolstrade` có xuất hiện trong danh sách launchpad gốc không (cùng với `pons`, `letscash`)? Parser neo theo khoá i18n ổn định `wizard.you.lp<Name>` để bền qua minify/rebuild; nếu trích được rỗng thì báo `🟡` (cấu trúc bundle đã đổi → cập nhật `lib/theindex.js`).
- **W2** — tRPC pools.trade: category mới (ngoài `volume/recency/linked-x/trending`) hoặc `launchpadId` mới (ngoài `uniswap-bonding-curve`, `uniswap-cca`). Category hợp lệ được phát hiện bằng cách gửi `sortBy` sai rồi đọc enum zod trả về trong lỗi.
- **W3** — on-chain: `TokenLaunched` từ launcher pools.trade có currency ghép cặp ∈ tập stock/index asset — bằng chứng chắc nhất. Dùng lại RPC-failover + dự phòng Blockscout của Bot 1; lần đầu quét lùi một cửa sổ lookback (mặc định 2M block).
Khi phát hiện tích hợp, mỗi chu kỳ quét & lưu token index mới, dedupe theo địa chỉ contract. **Sau khi `integrationDetected`**: W1/W2 (canh tích hợp) **giãn còn `INDEX_W12_SLOW_MS`** (mặc định 10 phút, biến `w12LastAt`) để nhẹ tải; **W3 + scanIndexTokens vẫn chạy mỗi `INDEX_POLL_MS`** (bắt token nhanh). Chu kỳ đầu luôn chạy W1/W2 (kể cả khi tích hợp nạp từ state) để `status.w2` được nạp.

### State & persistence (đều gitignore)
Bot khôi phục state lúc khởi động để khỏi quét lại toàn lịch sử: `ws_cursor.txt` (block cuối), `ws_tokens.json`, `ws_adapters.json` (Bot 1), `index_state.json` (Bot 2). Giữ lùi `CONFIRMATIONS` block (mặc định 5) so với tip để tránh reorg.

### Bot 3 — `easya-tracker/` (Solana, sub-project ESM tách biệt)
Ngăn xếp **hoàn toàn khác** hai bot EVM: **Solana + ESM (`.mjs`) + `@solana/web3.js` + Helius**, không dùng `ethers`, không dùng `lib/` gốc. Có `package.json` (`"type":"module"`, deps `@solana/web3.js` + `dotenv`) và `node_modules` RIÊNG → chạy `npm install` bên trong `easya-tracker/`. Xem `easya-tracker/README.md` để biết chi tiết.
- **Phát hiện launch**: Helius `logsSubscribe` với mentions filter = EasyA config; **commitment BẮT BUỘC `"confirmed"`** (dùng `"processed"` → Helius giao im lặng, mất launch). Lọc log theo marker `InitializeVirtualPoolWith(SplToken|Token2022)`, dedupe theo signature. Websocket chỉ có logs+sig → `getParsedTransaction` (retry) để lấy account. Thứ tự account DBC init: `[2]=dev [3]=mint [5]=pool`; name/symbol/uri từ inner `CreateMetadataAccountV3` (Borsh, `dbc.mjs`).
- **Telegram**: mẫu "gửi nhanh, làm giàu bằng edit" — gửi thẻ on-chain ngay (giữ `message_id`), rồi fetch socials qua IPFS (đua gateway, ngoài đường tới hạn) và `editMessageText`. Cảnh báo nền (startup/heartbeat/trạng thái) đi qua hàng đợi `queueAlert` **không mất tin** khi Telegram lỗi tạm (429/5xx/mạng → backoff, giữ tin); `send()` cho thẻ có retry và trả `message_id`.
- **Streamflow lock**: websocket thứ 2; nếu 1 lock khớp mint trong Map launch gần đây (TTL 24h, `recent.json`) → reply vào thẻ gốc.
- **Failover nhiều endpoint** (`providers.mjs`): `parseProviders` đọc `SOLANA_RPC_URLS` (nhiều URL, ưu tiên) hoặc `HELIUS_API_KEY`; `Pool.call` thử RPC lần lượt (getParsedTransaction/getBalance/getSlot). Websocket dùng `onSlotChange` làm nhịp tim (bắn ~2/s khi sống → phát hiện ws chết cả khi EasyA im); im lặng > 45s → xoay endpoint + `resubscribe()`; vẫn im sau nhiều nhịp → thoát cho supervisor. `wscheck`/`replay`/`preflight` cũng dùng `parseProviders`.
- **Lệnh chat + heartbeat**: `listen()` trong `telegram.mjs` long-poll `getUpdates` (chỉ nhận từ `TELEGRAM_CHAT_ID`) phục vụ `/status /health /ping /tokens /help`; heartbeat `💓` mỗi `HEARTBEAT_HOURS` (mặc định 6h). `index.mjs` export `{ onCommand, status, recent }` và chỉ chạy `main()` khi là entry point (`isMain`) → import được để test lệnh offline.
- **Vận hành**: **cần `.env` RIÊNG** trong `easya-tracker/` (Helius key + Telegram token — token Telegram **BẮT BUỘC khác** hai bot kia vì `getUpdates` độc quyền theo token, chung sẽ 409), lockfile single-instance (`easya.lock`). Đã thêm app `easya-tracker` vào `ecosystem.config.js`. Test offline (không mạng/secret): `cd easya-tracker && npm test`.
- Các hằng ID chương trình trong `dbc.mjs` là **công khai** (nhìn thấy trên Solscan), không phải secret.

## Test

Bộ test offline hoạt động bằng cách `require` một script entry như module — `main()` không chạy nhờ guard `if (require.main === module)`, nên test bơm `status` giả và gọi trực tiếp các hàm `onCommand`/watcher đã export. Đó là lý do `track-ws.js`/`track-index.js` export nội bộ của chúng. Các test cần mạng (`test:fallback`, `test:index`, `test:rpcs`, `backtest*`) gọi RPC/API live và có thể fail do rate limit — đó là do môi trường, không phải regression code.

Lưu ý Windows: test offline đặt `process.exitCode = 0` (hoặc đóng socket ethers trước khi thoát) thay vì `process.exit()` để tránh libuv assert trên Windows.

## Ràng buộc vận hành (không được vi phạm)

- **Mỗi bot cần token Telegram RIÊNG.** `getUpdates` của Telegram là độc quyền — hai tracker chung một token → HTTP 409. Bot 2 đọc `INDEX_TELEGRAM_BOT_TOKEN`/`INDEX_TELEGRAM_CHAT_ID` rồi ánh xạ sang các biến mà `bot.js` đọc. Chat ID có thể dùng chung.
- **Chọn RPC quan trọng** (xem bảng đã test trong `.env.example`): `publicnode` chặn `getLogs` address-less (không quét được adapter — đừng dùng); Alchemy free giới hạn `getLogs` 10 block/call (chỉ hợp quét live, không hợp lịch sử). `official` + `tenderly` là endpoint tốt đã biết cho full-history.
