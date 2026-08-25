// wscheck.mjs — CHỨNG MINH websocket Helius nhận push ở commitment "confirmed" (bài học then chốt).
// Mở logsSubscribe trên 1 program (mặc định DBC) trong N giây, đếm event + đánh dấu tx có marker launch.
// Chạy:  node wscheck.mjs [program|all] [giây]     (mặc định: DBC program, 30s)
import "./env.mjs";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseProviders, maskUrl } from "./providers.mjs";
import { DBC_PROGRAM, LAUNCH_MARKERS } from "./dbc.mjs";

const providers = parseProviders();
if (!providers.length) { console.error("Thiếu endpoint (đặt HELIUS_API_KEY hoặc SOLANA_RPC_URLS trong .env)"); process.exit(1); }

const arg = process.argv[2] || DBC_PROGRAM;
const secs = Number(process.argv[3] || 30);
const p = providers[0]; // kiểm endpoint đầu tiên
console.log(`Endpoint: ${maskUrl(p.http)}`);
const conn = new Connection(p.http, { commitment: "confirmed", wsEndpoint: p.ws });

let n = 0, launches = 0;
const sample = [];
const filter = arg === "all" ? "all" : new PublicKey(arg);
console.log(`Mở logsSubscribe (confirmed) trên ${arg} trong ${secs}s…`);

const subId = await conn.onLogs(filter, (l) => {
  if (l.err) return;
  n++;
  if (LAUNCH_MARKERS.some((m) => (l.logs || []).some((x) => x.includes(m)))) {
    launches++;
    if (sample.length < 5) sample.push(l.signature);
  }
}, "confirmed");

setTimeout(async () => {
  await conn.removeOnLogsListener(subId).catch(() => {});
  console.log(`\nKết quả: nhận ${n} event trong ${secs}s (${(n / secs).toFixed(1)}/s).`);
  console.log(`Trong đó có marker launch: ${launches}.`);
  if (sample.length) {
    console.log("Signature launch mẫu — replay để kiểm parse:");
    for (const s of sample) console.log("  node replay.mjs " + s);
  }
  console.log(n > 0
    ? "✅ Websocket confirmed HOẠT ĐỘNG (nhận được push)."
    : "⚠️ Không nhận event — kiểm tra key/mạng, hoặc program quá ít traffic (thử: node wscheck.mjs all 20).");
  process.exit(0);
}, secs * 1000);
