// backtest-c.js — Kiểm chứng Cách C (ethers.js + RPC) trên block quá khứ, tất định.
// Cài: npm i ethers
// Chạy: node backtest-c.js  (đặt RPC_URL đúng của Robinhood Chain, chainId 4663)
//
// getLogs (dùng lại đúng stack RPC + ethers + parseLog của Cách C). Riêng phần
// provider.on real-time cần live-test — xem track-ws.js.

require("../lib/env"); // nạp .env (RPC_URL) nếu có
const { ethers } = require("ethers");

// Ưu tiên biến môi trường RPC_URL; nếu trống, thử endpoint eth-rpc của Blockscout (bị rate-limit).
const RPC_URL = process.env.RPC_URL || "https://robinhoodchain.blockscout.com/api/eth-rpc";
const WALLET = "0x3d58E42d3a920dE4C1F71EE041c7eBb82ee23f49";

const provider = new ethers.JsonRpcProvider(RPC_URL);

const iface = new ethers.Interface([
  "event AdapterDeployed(address indexed adapter, address indexed creator, address indexed router, bytes32 userSalt, bytes32 derivedSalt, uint256 chainId, address implementation, bool created)",
]);
const T_ADAPTER = ethers.id(
  "AdapterDeployed(address,address,address,bytes32,bytes32,uint256,address,bool)"
);
const creatorTopic = ethers.zeroPadValue(WALLET, 32);

const CASES = [
  { name: "POWERBALL", from: 34246000, to: 34246500, adapter: "0xe1fe0d5b2c2d39ab4cd716ca9966b05f8ca8241a" },
  { name: "BANDS",     from: 37236900, to: 37237400, adapter: "0x1ee88067828efb8175a3003ce01382974cf0f921" },
];

(async () => {
  console.log("=== BACKTEST CÁCH C (ethers + RPC) ===");
  console.log("RPC:", RPC_URL, "\n");
  let pass = 0, total = 0;

  // Test 0: ethers.id có khớp topic0 on-chain không
  total++;
  const EXPECTED = "0xf5e62f18207578ca90c9d19a15c6405c9b3b401917ba0ad7a443bc76dcdadb2d";
  if (T_ADAPTER === EXPECTED) { pass++; console.log(`✅ PASS  topic0 khớp (${T_ADAPTER})`); }
  else { console.log(`❌ FAIL  topic0 ${T_ADAPTER} != ${EXPECTED}`); }

  // Xác nhận kết nối RPC + đúng chain
  try {
    const net = await provider.getNetwork();
    console.log(`   RPC ok, chainId=${net.chainId}`);
  } catch (e) {
    console.log(`❌ Không kết nối được RPC: ${e.message}`);
    console.log(`   -> đặt RPC_URL=... (WebSocket/HTTP của chain 4663) rồi chạy lại.`);
    process.exit(1);
  }

  // Test dương: getLogs qua đúng stack của Cách C
  for (const c of CASES) {
    total++;
    try {
      const logs = await provider.getLogs({
        fromBlock: c.from, toBlock: c.to,
        topics: [T_ADAPTER, null, creatorTopic], // topic2 = creator
      });
      const found = logs.map((l) => iface.parseLog(l).args.adapter.toLowerCase());
      if (found.includes(c.adapter)) { pass++; console.log(`✅ PASS  ${c.name} -> ${JSON.stringify(found)}`); }
      else { console.log(`❌ FAIL  ${c.name} -> ${JSON.stringify(found)}`); }
    } catch (e) { console.log(`❌ ${c.name} getLogs lỗi: ${e.message}`); }
  }

  console.log(`\nKẾT QUẢ: ${pass}/${total} bài đạt.`);
  console.log("Lưu ý: phần provider.on (real-time push) chưa test ở đây — dùng track-ws.js để live-test.");
  process.exit(pass === total ? 0 : 1);
})();
