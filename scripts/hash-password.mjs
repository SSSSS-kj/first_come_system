#!/usr/bin/env node
/**
 * 관리자 비밀번호의 bcrypt 해시를 만든다.
 *   npm run hash-password -- '내비밀번호'
 * 출력된 줄을 .env.local / Vercel 환경변수에 넣는다.
 */
import bcrypt from "bcryptjs";

const password = process.argv[2];

if (!password) {
  console.error("사용법: npm run hash-password -- '비밀번호'");
  process.exit(1);
}

if (password.length < 8) {
  console.error("비밀번호는 8자 이상을 권장합니다.");
}

const hash = await bcrypt.hash(password, 10);
console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
