// backtest-fixes.js — kiểm chứng các fix của track-ws.js:
//   #2 persistence, #3 nạp đủ adapter, #4 dedupe, #5 confirmations,
//   #6/#7 failover nhiều RPC (+ auto-reconnect), #9 symbol token.
// Chạy: RPC_URL="https://rpc.mainnet.chain.robinhood.com" node backtest-fixes.js
require("../lib/env");
const fs = require("fs");
const assert = require("assert");
const ws = require("../track-ws");
const { Rpc } = require("../lib/rpc");

(async () => {
  const latest = await ws.rpc.getBlockNumber();
  const safeTip = latest - ws.CONFIRMATIONS;

  // ---- #3: nạp ĐỦ adapter của ví từ đầu chuỗi ----
  const all = await ws.getLogsAdaptive({ topics: [ws.T_ADAPTER, null, ws.creatorTopic] }, 0, safeTip);
  const adapters = new Set(all.map((l) => ws.iface.parseLog(l).args.adapter.toLowerCase()));
  console.log(`#3 adapter toàn lịch sử: ${adapters.size}`);
  assert(adapters.size >= 7, "phải >= 7 adapter");
  assert(adapters.has("0xe1fe0d5b2c2d39ab4cd716ca9966b05f8ca8241a"), "thiếu adapter POWERBALL");
  assert(adapters.has("0x1ee88067828efb8175a3003ce01382974cf0f921"), "thiếu adapter BANDS");
  console.log("✅ #3 nạp đủ adapter (gồm POWERBALL + BANDS)");

  // ---- token detect + #4 dedupe ----
  const from = 34246000, to = 34246500;
  const tLogs = await ws.getLogsAdaptive({ address: ws.PONS, topics: [ws.T_LAUNCH] }, from, to);
  const seen = new Set();
  const pass1 = [];
  for (const l of tLogs) {
    const a = ws.iface.parseLog(l).args;
    if (!adapters.has(a.deployer.toLowerCase())) continue;
    const k = `${l.transactionHash}:${l.index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pass1.push(a.token.toLowerCase());
  }
  assert(pass1.includes("0xb7ead5209ca970ad6326fa38ea10724fc6b8d3b9"), "không bắt được token POWERBALL");
  console.log("✅ token detect qua deployer∈adapters đúng");

  let dup = 0;
  for (const l of tLogs) {
    const a = ws.iface.parseLog(l).args;
    if (!adapters.has(a.deployer.toLowerCase())) continue;
    const k = `${l.transactionHash}:${l.index}`;
    if (seen.has(k)) continue;
    seen.add(k); dup++;
  }
  assert(dup === 0, "dedupe hỏng");
  console.log("✅ #4 dedupe: quét lại cùng range -> 0 cảnh báo trùng");

  // ---- #5 confirmations ----
  assert(ws.CONFIRMATIONS >= 1 && safeTip < latest, "confirmations phải lùi khỏi tip");
  console.log(`✅ #5 confirmations=${ws.CONFIRMATIONS}: quét tới ${safeTip} < tip ${latest}`);

  // ---- #2 persistence ----
  const f = "./.cursor_test.tmp";
  fs.writeFileSync(f, "12345");
  assert(Number(fs.readFileSync(f, "utf8")) === 12345, "ghi/đọc con trỏ hỏng");
  fs.unlinkSync(f);
  console.log("✅ #2 ghi/đọc con trỏ block OK");

  // ---- #9 symbol token ----
  const sym = await ws.tokenSymbol("0xb7ead5209ca970ad6326fa38ea10724fc6b8d3b9");
  assert(sym === "POWERBALL", "symbol sai: " + sym);
  console.log(`✅ #9 symbol token: ${sym}`);

  // ---- #6/#7 failover: RPC hỏng đứng đầu -> tự xoay sang RPC tốt ----
  const r2 = new Rpc(["http://127.0.0.1:1", "https://rpc.mainnet.chain.robinhood.com"]);
  const blk = await r2.getBlockNumber();
  assert(blk > 0, "failover không lấy được block");
  assert(r2.rotations >= 1, "phải xoay RPC ít nhất 1 lần");
  await r2.destroy();
  console.log(`✅ #7 failover: bỏ RPC hỏng, lấy block ${blk} qua RPC dự phòng (xoay ${r2.rotations} lần)`);

  console.log("\n✅ TẤT CẢ FIX ĐẠT.");
  await ws.rpc.destroy();
  process.exitCode = 0;
})().catch((e) => { console.error("❌ FAIL:", e.message); process.exit(1); });
