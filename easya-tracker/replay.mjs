// replay.mjs — REPLAY 1 tx launch CÓ THẬT qua pipeline (parse -> thẻ). Chứng minh trích xuất đúng
// trên dữ liệu on-chain thật mà KHÔNG cần chờ launch mới.
// Chạy:  node replay.mjs <signature> [--send] [--socials]
//   --send    : gửi thẻ thật vào Telegram (không chỉ xem trước console)
//   --socials : fetch IPFS để thêm mô tả + link social
import "./env.mjs";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseLaunch } from "./dbc.mjs";
import { fetchSocials } from "./socials.mjs";
import { formatCard, formatEnriched, send, edit } from "./telegram.mjs";

const key = process.env.HELIUS_API_KEY || "";
const sig = process.argv[2];
const doSend = process.argv.includes("--send");
const doSocials = process.argv.includes("--socials");

if (!key) { console.error("Thiếu HELIUS_API_KEY trong .env"); process.exit(1); }
if (!sig || sig.startsWith("--")) { console.error("Dùng: node replay.mjs <signature> [--send] [--socials]"); process.exit(1); }

const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, { commitment: "confirmed" });
const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
if (!tx) { console.error("Không lấy được tx (sig sai / quá cũ / RPC lỗi)."); process.exit(1); }

const d = parseLaunch(tx);
if (!d) { console.error("❌ Không phải launch DBC (hoặc không parse được instruction)."); process.exit(1); }

let devBal = null;
try { devBal = (await conn.getBalance(new PublicKey(d.creator))) / 1e9; } catch (_) {}

console.log("\n--- Dữ liệu parse ---");
console.log(JSON.stringify({ ...d, devBalanceSol: devBal }, null, 2));

let s = {};
if (doSocials && d.uri) s = await fetchSocials(d.uri);
console.log("\n--- Thẻ Telegram (xem trước) ---\n" + (doSocials ? formatEnriched(d, devBal, s) : formatCard(d, devBal)));

if (doSend) {
  const id = await send(formatCard(d, devBal));
  if (id && doSocials && (s.description || s.twitter || s.website)) await edit(id, formatEnriched(d, devBal, s));
  console.log(id ? `\n✅ Đã gửi Telegram (msg ${id}).` : "\n❌ Gửi Telegram thất bại (kiểm tra token/chat id).");
}
process.exit(0);
