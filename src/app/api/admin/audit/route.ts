import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, json } from "@/lib/api";
import type { AuditRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 1000);
  const onlyFailures = url.searchParams.get("failures") === "1";

  let query = getAdminSupabase()
    .from("audit_log")
    .select("*")
    .order("id", { ascending: false })
    .limit(limit);

  if (onlyFailures) query = query.eq("success", false);

  const { data, error } = await query;
  if (error) return json({ ok: false, status: "db_error", message: error.message }, 500);

  return json({ ok: true, rows: (data ?? []) as AuditRow[] });
}
