# CẦN KIỂM TRA — 2 mục easya-tracker (chờ 1 tx launch EasyA thật)

Đợt săn bug (2026-08) phát hiện 2 điểm ở `dbc.mjs` **chưa sửa** vì phải xác minh bằng **1 signature launch EasyA/Kickstart thật** (không sửa mù). Khi có signature, replay để kiểm:

```bash
cd easya-tracker
node replay.mjs <signature>            # xem dữ liệu parse + thẻ
node replay.mjs <signature> --socials  # kèm socials (IPFS)
```
(Chưa có signature? Chạy `node wscheck.mjs` trên máy có mạng để lấy sig launch mẫu.)

## 1. `computeBuy` — "Dev mua X SOL" có thể SAI
File: `dbc.mjs` (`computeBuy`). Hiện lấy `Math.max` trên **mọi** WSOL trong `postTokenBalances`, giả định WSOL lớn nhất = vault pool. Nếu **dev còn dư WSOL trong ví** → `max` chọn nhầm số dư đó → thẻ báo "Dev mua" sai to.
**Fix đúng:** lọc WSOL có owner = vault/pool authority (`POOL_AUTHORITY` = `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`) thay vì max toàn cục. Cần 1 tx launch **có dev-buy** để xác minh account nào là vault.

## 2. `parseLaunch` — có thể chọn NHẦM instruction DBC
File: `dbc.mjs` (`parseLaunch`). Hiện chọn instruction init chỉ bằng `programId===DBC && accounts.length>5`. Một DBC **swap** (dev mua cùng tx) cũng thường >5 account → `find` có thể lấy nhầm → `creator/mint/pool` (accounts[2/3/5]) thành rác.
**Fix đúng (nếu tái hiện):** phân biệt bằng **discriminator** (8 byte đầu của `ix.data`) thay vì đếm account. Cần tx launch **có dev-buy** để đối chiếu.

---
Mọi bug khác của đợt review đó đã sửa + commit trên nhánh `feat/easya-solana-launch-tracker`.
