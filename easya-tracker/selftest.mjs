// selftest.mjs — kiểm tra OFFLINE (không mạng, không secret): base58 + parse metadata + math buy + format thẻ.
// Chạy: npm test  (hoặc: node selftest.mjs)
import assert from "node:assert";
import { PublicKey } from "@solana/web3.js";
import { base58Decode, parseMetadataBytes, computeBuy, parseLaunch, WSOL, DBC_PROGRAM, METADATA_PROG } from "./dbc.mjs";
import { formatCard, formatEnriched } from "./telegram.mjs";

// (1) base58Decode phải khớp web3.js PublicKey.toBytes() (gồm cả trường hợp byte-0 dẫn đầu).
for (const b58 of [WSOL, "DD3y1mi4yeQSLNbNGZTxUwdwbEm4Gh2injjx1N9HPCqQ", "11111111111111111111111111111111"]) {
  assert.deepStrictEqual([...base58Decode(b58)], [...new PublicKey(b58).toBytes()], "base58Decode sai cho " + b58);
}
console.log("✅ (1) base58Decode khớp PublicKey.toBytes()");

// (2) parseMetadataBytes: dựng buffer CreateMetadataAccountV3 (byte 33 + borsh name/symbol/uri).
function buildMeta(name, symbol, uri) {
  const enc = new TextEncoder();
  const parts = [Uint8Array.of(33)];
  for (const s of [name, symbol, uri]) {
    const b = enc.encode(s);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, b.length, true);
    parts.push(len, b);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const m = parseMetadataBytes(buildMeta("Doge EASY", "DEASY", "ipfs://Qm123"));
assert.strictEqual(m.name, "Doge EASY");
assert.strictEqual(m.symbol, "DEASY");
assert.strictEqual(m.uri, "ipfs://Qm123");
assert.strictEqual(parseMetadataBytes(Uint8Array.of(1, 2, 3)), null, "byte đầu != 33 -> null");
console.log("✅ (2) parseMetadataBytes đọc đúng name/symbol/uri");

// (3) computeBuy: SOL dev mua + % supply + trường hợp không mua.
const mint = "MintAAA", creator = "DevBBB";
const r = computeBuy([
  { mint: WSOL, owner: "pool", uiTokenAmount: { uiAmount: 3.5 } },
  { mint, owner: creator, uiTokenAmount: { uiAmount: 200_000_000 } },
  { mint, owner: "pool", uiTokenAmount: { uiAmount: 800_000_000 } },
], mint, creator);
assert.strictEqual(r.buySol, 3.5);
assert.strictEqual(r.totalSupply, 1_000_000_000);
assert.ok(Math.abs(r.pctSupply - 20) < 1e-9, "pct phải = 20%");
assert.strictEqual(computeBuy([{ mint, owner: "pool", uiTokenAmount: { uiAmount: 1e9 } }], mint, creator).buySol, 0);
console.log("✅ (3) computeBuy: buySol + %supply + không-mua");

// (4) parseLaunch trên fixture parsed-tx tối giản (đúng các shape mà code đọc).
const cfg = "DD3y1mi4yeQSLNbNGZTxUwdwbEm4Gh2injjx1N9HPCqQ";
const fixture = {
  meta: {
    postTokenBalances: [
      { mint: WSOL, owner: "poolauth", uiTokenAmount: { uiAmount: 1.25 } },
      { mint: "MINTxxx", owner: "DEVxxx", uiTokenAmount: { uiAmount: 100_000_000 } },
      { mint: "MINTxxx", owner: "poolauth", uiTokenAmount: { uiAmount: 900_000_000 } },
    ],
    innerInstructions: [
      { index: 0, instructions: [ { programId: METADATA_PROG, data: base58EncodeForTest(buildMeta("Tester", "TST", "ipfs://cid")) } ] },
    ],
  },
  transaction: { message: { instructions: [
    { programId: DBC_PROGRAM, accounts: [cfg, "poolauth", "DEVxxx", "MINTxxx", WSOL, "POOLxxx", "extra"] },
  ] } },
};
const d = parseLaunch(fixture);
assert.strictEqual(d.creator, "DEVxxx");
assert.strictEqual(d.mint, "MINTxxx");
assert.strictEqual(d.pool, "POOLxxx");
assert.strictEqual(d.symbol, "TST");
assert.strictEqual(d.name, "Tester");
assert.strictEqual(d.uri, "ipfs://cid");
assert.strictEqual(d.buySol, 1.25);
assert.strictEqual(d.totalSupply, 1_000_000_000);
assert.ok(Math.abs(d.pctSupply - 10) < 1e-9, "pct phải = 10%");
console.log("✅ (4) parseLaunch tách đúng account order + metadata + buy từ fixture");

// (5) formatCard/formatEnriched: đủ trường, chặn URL không phải http(s).
const card = formatCard(d, 12.34);
assert.ok(card.includes("TST") && card.includes("MINTxxx") && card.includes("SOL"), "thẻ thiếu trường");
const enriched = formatEnriched(d, 12.34, { description: "hello", twitter: "javascript:alert(1)", website: "https://ok.com" });
assert.ok(!enriched.includes("javascript:"), "phải loại URL không phải http(s)");
assert.ok(enriched.includes("https://ok.com") && enriched.includes("hello"), "phải giữ website hợp lệ + mô tả");
console.log("✅ (5) formatCard/enriched render đúng + lọc URL độc");

// (6) lệnh chat (offline). Import index.mjs KHÔNG chạy bot nhờ guard isMain (chỉ chạy khi là entry point).
const idx = await import("./index.mjs");
idx.status.startedAt = Date.now() - 3 * 3600 * 1000; // 3h uptime
idx.status.launches = 2; idx.status.locks = 1;
idx.status.lastLaunch = { symbol: "TST", mint: "MINTxxx" }; idx.status.lastLaunchAt = Date.now() - 5000;
idx.recent.set("MINTxxx", { symbol: "TST", message_id: 1, totalSupply: 1e9, ts: Date.now() });

assert.ok(/pong/i.test(await idx.onCommand("/ping")), "/ping sai");
const st = await idx.onCommand("/status");
assert.ok(st.includes("EasyA tracker") && st.includes("Launch đã bắt: 2"), "/status thiếu trường");
const tks = await idx.onCommand("/tokens");
assert.ok(tks.includes("MINTxxx") && tks.includes("TST"), "/tokens thiếu token");
assert.ok((await idx.onCommand("/help")).includes("/status"), "/help thiếu danh sách");
assert.strictEqual(await idx.onCommand("/khong-co"), null, "lệnh lạ phải trả null (im lặng)");
console.log("✅ (6) lệnh chat: /ping /status /tokens /help + lệnh lạ trả null");

console.log("\n✅ TẤT CẢ SELFTEST ĐẠT.");

// base58 encoder CHỈ dùng trong test (dựng data instruction giả). Không nằm trong code chạy thật.
function base58EncodeForTest(bytes) {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = "";
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) s += "1";
  for (let q = digits.length - 1; q >= 0; q--) s += B58[digits[q]];
  return s;
}
