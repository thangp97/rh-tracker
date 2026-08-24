// env.js — tự nạp file .env vào process.env nếu có (Node >= 20.12, không cần thư viện).
// require("./env") ở DÒNG ĐẦU mỗi script để biến trong .env sẵn sàng trước khi dùng.
const path = require("path");
try {
  process.loadEnvFile(path.resolve(__dirname, "..", ".env"));
} catch (_) {
  // không có .env -> bỏ qua, dùng biến môi trường hệ thống (nếu có)
}
