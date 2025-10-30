import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(__dirname, "firebase-admin-key.json"); // <-- match the real name

const key = readFileSync(jsonPath, "utf8");
const base64 = Buffer.from(key).toString("base64");
console.log(base64);
