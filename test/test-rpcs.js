// test-rpcs.js — kiểm tra các RPC Robinhood Chain miễn phí: kết nối, đúng chainId,
// độ trễ, và getLogs (thứ tracker cần). Chạy: node test-rpcs.js
const { ethers } = require("ethers");
const { makeProvider } = require("../lib/rpc"); // dùng chung factory đã vá lỗi wss

const T = ethers.id("AdapterDeployed(address,address,address,bytes32,bytes32,uint256,address,bool)");
const creator = ethers.zeroPadValue("0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49", 32);

const CANDIDATES = [
  ["official",      "https://rpc.mainnet.chain.robinhood.com"],
  ["publicnode",    "https://robinhood-rpc.publicnode.com"],
  ["tenderly",      "https://robinhood-chain.gateway.tenderly.co"],
  ["arrowrpc-http", "https://rpc.arrowrpc.com"],
  ["arrowrpc-wss",  "wss://ws.arrowrpc.com"],
];

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

async function testOne(name, url) {
  const p = makeProvider(url);
  const out = { name, url, ok: false };
  try {
    const t0 = Date.now();
    const net = await withTimeout(p.getNetwork(), 8000);
    out.chainId = Number(net.chainId);
    const blk = await withTimeout(p.getBlockNumber(), 8000);
    out.block = blk;
    out.pingMs = Date.now() - t0;
    const t1 = Date.now();
    const logs = await withTimeout(
      p.getLogs({ fromBlock: blk - 2000, toBlock: blk, topics: [T, null, creator] }), 10000);
    out.getLogsMs = Date.now() - t1;
    out.logs = logs.length;
    out.ok = out.chainId === 4663;
  } catch (e) {
    out.err = e.shortMessage || e.message;
  } finally {
    try { await p.destroy(); } catch (_) {}
  }
  return out;
}

(async () => {
  const results = [];
  for (const [n, u] of CANDIDATES) {
    console.log(`Đang test ${n} (${u}) ...`);
    results.push(await testOne(n, u));
  }
  console.log("\n=== KẾT QUẢ ===");
  for (const r of results) {
    if (r.ok) {
      console.log(`✅ ${r.name.padEnd(14)} chainId=${r.chainId} block=${r.block} ping=${r.pingMs}ms getLogs=${r.getLogsMs}ms (${r.logs} log)`);
    } else {
      console.log(`❌ ${r.name.padEnd(14)} ${r.err || "chainId sai=" + r.chainId}`);
    }
  }
  const good = results.filter((r) => r.ok).sort((a, b) => a.pingMs - b.pingMs);
  if (good.length) {
    console.log("\nGợi ý RPC_URLS (nhanh -> chậm):");
    console.log("RPC_URLS=" + good.map((r) => r.url).join(","));
  }
  setTimeout(() => process.exit(0), 800).unref(); // thoát sạch kể cả khi wss còn handle
})();
