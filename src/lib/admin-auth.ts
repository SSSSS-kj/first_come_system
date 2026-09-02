import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";

export const ADMIN_COOKIE = "fcs_admin";

const HOWTO = "`openssl rand -base64 48` 로 생성한 값으로 교체하세요.";

/** .env.example 을 그대로 복사했을 때 흔히 남는 문자열들. 대소문자는 무시한다. */
const PLACEHOLDERS = ["change-me", "your-secret", "example", "placeholder"];

function sessionSecret(): string {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      `ADMIN_SESSION_SECRET 가 없거나 너무 짧습니다 (32자 이상). ${HOWTO}`,
    );
  }

  const lowered = s.toLowerCase();
  const hit = PLACEHOLDERS.find((p) => lowered.includes(p));
  if (hit) {
    throw new Error(
      `ADMIN_SESSION_SECRET 에 플레이스홀더 문자열("${hit}")이 들어 있습니다. ${HOWTO}`,
    );
  }

  return s;
}

function sessionMs(): number {
  const hours = Number(process.env.ADMIN_SESSION_HOURS ?? "8");
  return (Number.isFinite(hours) && hours > 0 ? hours : 8) * 3600_000;
}

/** `admin.<expiryMs>.<hmac>` 형태의 서명 토큰을 만든다. */
export function issueToken(): { token: string; maxAgeSec: number } {
  const ttl = sessionMs();
  const payload = `admin.${Date.now() + ttl}`;
  const sig = crypto
    .createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
  return { token: `${payload}.${sig}`, maxAgeSec: Math.floor(ttl / 1000) };
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;

  const idx = token.lastIndexOf(".");
  if (idx <= 0) return false;

  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  let expected: string;
  try {
    expected = crypto
      .createHmac("sha256", sessionSecret())
      .update(payload)
      .digest("base64url");
  } catch {
    return false;
  }

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const [prefix, expStr] = payload.split(".");
  if (prefix !== "admin") return false;

  const exp = Number(expStr);
  return Number.isFinite(exp) && Date.now() < exp;
}

/** 요청에 유효한 관리자 세션 쿠키가 있는지 확인한다. */
export async function isAdmin(): Promise<boolean> {
  const store = await cookies();
  return verifyToken(store.get(ADMIN_COOKIE)?.value);
}

/**
 * 비밀번호 검증. ADMIN_PASSWORD_HASH(bcrypt)를 우선 사용하고,
 * 없으면 로컬 개발 편의를 위해 평문 ADMIN_PASSWORD 를 상수 시간 비교한다.
 */
export async function checkPassword(input: string): Promise<boolean> {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (hash) {
    try {
      return await bcrypt.compare(input, hash);
    } catch {
      return false;
    }
  }

  const plain = process.env.ADMIN_PASSWORD;
  if (!plain) return false;

  const a = Buffer.from(input);
  const b = Buffer.from(plain);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── 로그인 시도 제한 (인스턴스 로컬, 무차별 대입 완화용) ────────────────
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;

export function rateLimitLogin(key: string): boolean {
  const now = Date.now();
  const cur = attempts.get(key);

  if (!cur || now > cur.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  cur.count += 1;
  return cur.count <= MAX_ATTEMPTS;
}

export function clearRateLimit(key: string): void {
  attempts.delete(key);
}
