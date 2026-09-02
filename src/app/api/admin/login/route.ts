import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  checkPassword,
  clearRateLimit,
  issueToken,
  rateLimitLogin,
} from "@/lib/admin-auth";
import { json, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!rateLimitLogin(ip)) {
    return json({ ok: false, status: "rate_limited" }, 429);
  }

  const body = await readJson<{ password?: string }>(req);
  const password = body?.password ?? "";

  if (!password || !(await checkPassword(password))) {
    return json({ ok: false, status: "invalid_password" }, 401);
  }

  clearRateLimit(ip);
  const { token, maxAgeSec } = issueToken();

  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  });
  return res;
}
