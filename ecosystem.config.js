// ecosystem.config.js — chạy tracker 24/7 trên VPS bằng pm2 (tự khởi động lại khi chết).
// Dùng:  pm2 start ecosystem.config.js  &&  pm2 save  &&  pm2 startup
// track-ws.js là tracker duy nhất: RPC (nhiều endpoint failover) + tự dự phòng Blockscout REST.
module.exports = {
  apps: [
    {
      name: "rh-tracker",
      script: "track-ws.js",
      cwd: __dirname,            // để env.js tìm đúng .env
      autorestart: true,
      max_restarts: 100,
      restart_delay: 5000,       // chờ 5s rồi restart, tránh vòng lặp chết nhanh
      max_memory_restart: "300M",
      time: true,                // gắn timestamp vào log
    },
    {
      // Bot 2 — canh theindex ↔ pools.trade. Cần INDEX_TELEGRAM_* riêng trong .env.
      name: "rh-index-tracker",
      script: "track-index.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 100,
      restart_delay: 5000,
      max_memory_restart: "300M",
      time: true,
    },
    {
      // Bot 3 — EasyA/Kickstart (Solana, Meteora DBC). Sub-project ESM riêng trong easya-tracker/.
      // Cần .env RIÊNG trong easya-tracker/ (HELIUS_API_KEY + TELEGRAM_*). Chạy `npm install` trong đó trước.
      name: "easya-tracker",
      script: "index.mjs",
      cwd: __dirname + "/easya-tracker",
      autorestart: true,
      max_restarts: 100,
      restart_delay: 5000,
      max_memory_restart: "300M",
      time: true,
    },
  ],
};
