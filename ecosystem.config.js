// ecosystem.config.js — chạy tracker 24/7 trên VPS bằng pm2 (tự khởi động lại khi chết).
// Dùng:  pm2 start ecosystem.config.js  &&  pm2 save  &&  pm2 startup
// Đổi script sang "track-rest.js" nếu muốn dùng Cách B.
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
  ],
};
