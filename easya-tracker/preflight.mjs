// preflight.mjs — kiểm tra CẤU HÌNH trước khi chạy bot: Helius RPC + kênh Telegram.
// Chạy: node preflight.mjs  (cần .env đã điền). In ✅/❌ từng mục, gửi 1 tin thử vào Telegram.
import "./env.mjs";
import { Connection } from "@solana/web3.js";
import { parseProviders, maskUrl } from "./providers.mjs";

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
let ok = true;

// 1) RPC — kiểm TỪNG endpoint (getSlot + version). Cần ít nhất 1 cái OK.
const providers = parseProviders();
if (!providers.length) { console.log("❌ RPC: thiếu endpoint (đặt HELIUS_API_KEY hoặc SOLANA_RPC_URLS)"); ok = false; }
else {
  let anyOk = false;
  for (const p of providers) {
    try {
      const conn = new Connection(p.http, { commitment: "confirmed" });
      const slot = await conn.getSlot("confirmed");
      const v = await conn.getVersion();
      console.log(`✅ RPC ${maskUrl(p.http)}: OK (slot ${slot}, solana-core ${v["solana-core"]})`);
      anyOk = true;
    } catch (e) { console.log(`❌ RPC ${maskUrl(p.http)}: LỖI — ${e.message}`); }
  }
  if (!anyOk) ok = false;
}

// 2) Telegram token hợp lệ? (getMe)
if (!BOT) { console.log("❌ TELEGRAM_BOT_TOKEN: thiếu"); ok = false; }
else {
  try {
    const j = await (await fetch(`https://api.telegram.org/bot${BOT}/getMe`)).json();
    if (j.ok) console.log(`✅ Telegram token: OK (@${j.result.username})`);
    else { console.log("❌ Telegram token: LỖI —", j.description); ok = false; }
  } catch (e) { console.log("❌ Telegram token: LỖI —", e.message); ok = false; }
}

// 3) Chat id + gửi thử
if (!CHAT) {
  console.log("⚠️ TELEGRAM_CHAT_ID: chưa đặt. Nhắn cho bot 1 câu rồi lấy id ở:");
  console.log(`   https://api.telegram.org/bot${BOT || "<token>"}/getUpdates`);
  ok = false;
} else if (BOT) {
  try {
    const j = await (await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: "✅ preflight easya-tracker: kênh Telegram OK." }),
    })).json();
    if (j.ok) console.log(`✅ Telegram gửi thử: OK (đã gửi tới chat ${CHAT})`);
    else { console.log("❌ Telegram gửi thử: LỖI —", j.description, "(chat id sai? chưa nhắn bot?)"); ok = false; }
  } catch (e) { console.log("❌ Telegram gửi thử: LỖI —", e.message); ok = false; }
}

console.log(ok ? "\n✅ SẴN SÀNG — chạy: npm start" : "\n❌ CHƯA SẴN SÀNG — sửa các mục ❌/⚠️ ở trên.");
process.exit(ok ? 0 : 1);
