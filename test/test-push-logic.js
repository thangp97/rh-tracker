// test-push-logic.js — kiểm LOGIC 2 nấc (0-conf -> confirmed / reorg) của track-ws, OFFLINE (không mạng/ws).
// Nạp track-ws như module (main không chạy nhờ require.main), thao tác trực tiếp pending/alerted + helper.
const assert = require("assert");
const m = require("../track-ws");

m.alerted.clear(); m.pending.clear();

// (1) resolveConfirm: chưa có pending -> 'fresh'; gọi lại cùng key -> null (chống trùng)
let r = m.resolveConfirm("0xaa:1");
assert(r && r.action === "fresh", "lần đầu phải là fresh");
assert(m.resolveConfirm("0xaa:1") === null, "trùng key phải trả null");
console.log("✅ (1) resolveConfirm: fresh + chống báo trùng (dedupe tx:index)");

// (2) đã có tin 0-conf -> 'edit' đúng messageId, và xoá khỏi pending khi confirmed
m.pending.set("0xbb:2", { kind: "launch", blockNumber: 100, messageId: 555, token: "0xTOK", tx: "0xbb" });
r = m.resolveConfirm("0xbb:2");
assert(r && r.action === "edit" && r.messageId === 555, "phải edit đúng message 0-conf");
assert(!m.pending.has("0xbb:2"), "xác nhận xong phải xoá khỏi pending");
console.log("✅ (2) resolveConfirm: pending 0-conf -> edit thành 'đã xác nhận'");

// (3) collectReorged: pending có block <= to (đã tới độ sâu xác nhận mà chưa confirmed) -> reorg
m.pending.clear();
m.pending.set("old", { blockNumber: 50, messageId: 1, kind: "launch", tx: "0x1" });   // đã qua -> reorg
m.pending.set("new", { blockNumber: 300, messageId: 2, kind: "launch", tx: "0x2" });  // còn chờ
const reorged = m.collectReorged(100);
assert(reorged.length === 1 && reorged[0][0] === "old", "chỉ 'old' (block<=to) bị coi là reorg");
console.log("✅ (3) collectReorged: pending quá độ sâu mà chưa confirmed -> reorg; cái còn chờ vẫn giữ");

m.pending.clear(); m.alerted.clear();
console.log("\n✅ LOGIC PUSH 2-NẤC ĐẠT (resolveConfirm + collectReorged).");
try { m.rpc?.destroy?.(); } catch (_) {} // đóng socket ethers cho sạch (Windows)
process.exitCode = 0;
