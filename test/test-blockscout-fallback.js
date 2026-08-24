// test-blockscout-fallback.js — kiểm chứng độ bền nguồn dữ liệu của track-ws:
//   (C) isRangeError phân loại đúng lỗi range vs mạng/permission
//   (A) BUG#1: khi mọi RPC chết, getLogsAdaptive NÉM NHANH (không đệ quy bùng nổ/treo)
//   (B) FALLBACK: khi RPC chết, getLogs tự lấy log qua Blockscout REST (nguồn độc lập)
// Chạy: node test/test-blockscout-fallback.js   (cần mạng cho phần B — Blockscout)

// ÉP mọi RPC chết TRƯỚC khi nạp track-ws (Rpc khởi tạo từ env lúc import).
process.env.RPC_URLS = "http://127.0.0.1:1";

const assert = require("assert");
const ws = require("../track-ws");

const POWERBALL_ADAPTER = "0xe1fe0d5b2c2d39ab4cd716ca9966b05f8ca8241a";

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, r) => setTimeout(() => r(new Error(msg)), ms)),
  ]);
}

(async () => {
  // ---- (C) isRangeError ----
  assert(ws.isRangeError({ error: { message: "exceed maximum block range: 50000" } }) === true, "range-error phải nhận diện được");
  assert(ws.isRangeError({ error: { message: "you can make eth_getLogs requests with up to a 10 block range" } }) === true, "Alchemy 10-block phải là range-error");
  assert(ws.isRangeError({ error: { message: "query returned more than 10000 results" } }) === true, "too-many-results phải là range-error");
  assert(ws.isRangeError(new Error("could not coalesce error")) === false, "lỗi mạng KHÔNG được coi là range-error");
  assert(ws.isRangeError(new Error("connect ECONNREFUSED 127.0.0.1:1")) === false, "refused KHÔNG được coi là range-error");
  assert(ws.isRangeError({ error: { message: "Please specify an address in your request" } }) === false, "lỗi permission KHÔNG được coi là range-error");
  // rate-limit/throttle KHÔNG được coi là range-error (nếu không sẽ chia đôi -> dội bom RPC đang bị siết)
  assert(ws.isRangeError({ error: { message: "Your app has exceeded its compute units per second capacity" } }) === false, "compute-unit throttle KHÔNG phải range-error");
  assert(ws.isRangeError({ error: { message: "rate limit exceeded" } }) === false, "rate limit KHÔNG phải range-error");
  assert(ws.isRangeError({ error: { message: "429 Too Many Requests" } }) === false, "429 KHÔNG phải range-error");
  console.log("✅ (C) isRangeError phân loại đúng (range -> chia; mạng/permission/rate-limit -> ném)");

  // ---- (A) bug#1: RPC chết -> ném NHANH, không đệ quy bùng nổ trên range khổng lồ ----
  const t0 = Date.now();
  let threw = false;
  try {
    await withTimeout(
      ws.getLogsAdaptive({ topics: [ws.T_ADAPTER, null, ws.creatorTopic] }, 0, 5_000_000),
      20000,
      "HANG: getLogsAdaptive không ném nhanh -> nghi đệ quy bùng nổ (bug#1 chưa fix)"
    );
  } catch (e) {
    assert(!/HANG/.test(e.message), e.message);
    threw = true;
  }
  assert(threw, "RPC chết thì getLogsAdaptive phải ném lỗi");
  console.log(`✅ (A) bug#1: mọi RPC chết -> getLogsAdaptive ném sau ${Date.now() - t0}ms (range 5,000,000 block, KHÔNG treo)`);

  // ---- (B) fallback: RPC chết -> getLogs tự lấy adapter qua Blockscout REST ----
  const logs = await withTimeout(
    ws.getLogs({ topics: [ws.T_ADAPTER, null, ws.creatorTopic] }, 34246000, 34246500),
    30000,
    "Blockscout fallback quá lâu"
  );
  const adapters = new Set(logs.map((l) => ws.iface.parseLog(l).args.adapter.toLowerCase()));
  assert(adapters.has(POWERBALL_ADAPTER), "fallback Blockscout phải trả adapter POWERBALL, nhận: " + [...adapters].join(","));
  console.log(`✅ (B) fallback: mọi RPC chết -> getLogs lấy được adapter qua Blockscout REST (${adapters.size} adapter)`);

  // ---- (D) getTip: RPC chết -> lấy block mới nhất qua Blockscout (tracker chạy được KHÔNG cần RPC) ----
  const tip = await withTimeout(ws.getTip(), 30000, "getTip fallback quá lâu");
  assert(Number.isFinite(tip) && tip > 40_000_000, "getTip phải trả block hợp lệ qua Blockscout, nhận: " + tip);
  console.log(`✅ (D) getTip: mọi RPC chết -> lấy tip=${tip} qua Blockscout (thay hoàn toàn Cách B/REST)`);

  console.log("\n✅ ĐỘ BỀN NGUỒN DỮ LIỆU ĐẠT (bug#1 + Blockscout fallback + getTip fallback).");
  try { await ws.rpc.destroy(); } catch (_) {}
  process.exitCode = 0;
})().catch((e) => { console.error("❌ FAIL:", e.message); process.exit(1); });
