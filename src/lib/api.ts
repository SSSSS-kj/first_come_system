import "server-only";

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** 관리자 세션이 없으면 401 응답을 돌려준다. 있으면 null. */
export async function guardAdmin(): Promise<NextResponse | null> {
  if (await isAdmin()) return null;
  return json({ ok: false, status: "unauthorized" }, 401);
}

/** RPC 결과를 그대로 클라이언트에 전달한다. ok=false 는 200 이 아닌 409 로 내려준다. */
export function rpcResponse(
  data: unknown,
  error: { message: string } | null,
): NextResponse {
  if (error) return json({ ok: false, status: "rpc_error", message: error.message }, 500);

  const result = data as { ok?: boolean } | null;
  if (!result) return json({ ok: false, status: "empty_result" }, 500);

  return json(result, result.ok ? 200 : 409);
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
