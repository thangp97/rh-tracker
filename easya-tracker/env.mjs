// env.mjs — nạp .env NẰM CẠNH module này TRƯỚC khi bất kỳ module nào đọc process.env.
// Import dòng đầu ở mọi module cần secret (telegram, index...) để dotenv chạy đúng thứ tự khởi tạo
// ESM (dependency được init trước module cha) và tìm đúng .env kể cả khi cwd khác thư mục dự án.
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(dir, ".env") });
