import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, json, readJson, rpcResponse } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  description?: string;
  capacity?: number;
  sort_order?: number;
};

export async function POST(req: Request) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const body = await readJson<Body>(req);
  if (!body?.name?.trim()) return json({ ok: false, status: "invalid_name" }, 400);

  const capacity = Number(body.capacity);
  if (!Number.isInteger(capacity) || capacity < 0) {
    return json({ ok: false, status: "invalid_capacity" }, 400);
  }

  const { data, error } = await getAdminSupabase().rpc("admin_create_team", {
    p_name: body.name.trim(),
    p_description: body.description ?? "",
    p_capacity: capacity,
    p_sort_order: Number.isInteger(body.sort_order) ? body.sort_order : 0,
  });

  return rpcResponse(data, error);
}
