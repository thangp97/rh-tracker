// livecheck2-c.js — chứng minh cơ chế real-time bằng poll getLogs theo con trỏ block.
// Quét các block MỚI sinh ra sau khi script chạy => bắt được log => kênh live OK.
const { ethers } = require("ethers");
const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);
const T_TRANSFER = ethers.id("Transfer(address,address,uint256)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const net = await provider.getNetwork();
  let last = await provider.getBlockNumber();
  console.log(`RPC ok chainId=${net.chainId}. Bắt đầu từ block ${last}. Poll 4 lần (mỗi 4s) block MỚI ...`);
  let total = 0;
  for (let i = 0; i < 4; i++) {
    await sleep(4000);
    const cur = await provider.getBlockNumber();
    if (cur <= last) { console.log(`  (chưa có block mới)`); continue; }
    const logs = await provider.getLogs({ fromBlock: last + 1, toBlock: cur, topics: [T_TRANSFER] });
    total += logs.length;
    console.log(`  block ${last + 1}..${cur}: +${logs.length} Transfer (mới, real-time)`);
    last = cur;
  }
  console.log(`${total > 0 ? "✅ PASS" : "❌ FAIL"}  bắt được ${total} log từ block mới sinh`);
  process.exit(total > 0 ? 0 : 1);
})().catch((e) => { console.error("Lỗi:", e.message); process.exit(1); });
