import { hashPassword } from "../api/auth/password.js";

const password = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
if (!password) {
  console.error("Usage: pnpm hash-password -- <password>");
  process.exit(1);
}

process.stdout.write(`${hashPassword(password)}\n`);
