// test-commands.js — kiểm tra bộ xử lý lệnh chat (/status, /ping, ...) không cần Telegram.
// Nạp tracker như module (main không chạy nhờ guard require.main), bơm status giả, gọi onCommand.
const assert = require("assert");

(async () => {
  for (const modName of ["../track-ws"]) {
    const m = require(modName);
    // bơm trạng thái giả
    m.status.startedAt = Date.now() - 3 * 3600 * 1000; // 3h uptime
    m.status.lastBlock = 44700000;
    m.status.cursor = 44700001;
    m.status.lastScanAt = Date.now() - 5000;
    m.status.lastHeartbeatAt = Date.now() - 60000;
    m.status.adapters.add("0xe1fe0d5b2c2d39ab4cd716ca9966b05f8ca8241a");
    m.status.tokens.push({ token: "0xb7ead5209ca970ad6326fa38ea10724fc6b8d3b9", symbol: "POWERBALL", tx: "0xbc14c6d0" });

    console.log(`\n========== ${modName} ==========`);
    const st = await m.onCommand("/status");
    console.log("--- /status ---\n" + st);
    assert(st.includes("Tracker"), "status thiếu tiêu đề");
    assert(st.includes("44700000"), "status thiếu block");
    assert(st.includes("Adapter của ví: 1"), "status sai số adapter");

    const ping = await m.onCommand("/ping");
    console.log("--- /ping ---\n" + ping);
    assert(ping.toLowerCase().includes("pong"), "ping sai");

    const health = await m.onCommand("/health");
    console.log("--- /health (probe thật) ---\n" + health);
    assert(/HEALTHY|DEGRADED|UNHEALTHY/.test(health), "health thiếu verdict");

    const tk = await m.onCommand("/tokens");
    console.log("--- /tokens ---\n" + tk);
    assert(tk.includes("0xb7ead5209"), "tokens thiếu token");

    const ad = await m.onCommand("/adapters");
    console.log("--- /adapters ---\n" + ad);
    assert(ad.includes("0xe1fe0d5b"), "adapters thiếu adapter");

    const help = await m.onCommand("/help");
    console.log("--- /help ---\n" + help);
    assert(help.includes("/status"), "help thiếu danh sách");

    const unknown = await m.onCommand("/khong-co");
    console.log("--- /khong-co (lệnh lạ) ---\n" + JSON.stringify(unknown));
    assert(unknown === null, "lệnh lạ phải trả null (im lặng)");
  }
  console.log("\n✅ TẤT CẢ LỆNH ĐẠT.");
  try { await require("../track-ws").rpc?.destroy?.(); } catch (_) {} // đóng socket ethers cho sạch
  process.exitCode = 0; // để process tự thoát, tránh libuv assert lúc process.exit() trên Windows
})().catch((e) => { console.error("❌ FAIL:", e.message); process.exit(1); });
