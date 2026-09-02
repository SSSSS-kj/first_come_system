import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, json, readJson, rpcResponse } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type Body = {
  capacity?: number;
  name?: string;
  description?: string;
  sort_order?: number;
};

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const body = await readJson<Body>(req);
  if (!body) return json({ ok: false, status: "invalid_body" }, 400);

  const supabase = getAdminSupabase();

  // 정원 변경 — 현재 인원보다 작으면 RPC 가 capacity_below_taken 으로 거부한다.
  if (body.capacity !== undefined) {
    const capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity < 0) {
      return json({ ok: false, status: "invalid_capacity" }, 400);
    }
    const { data, error } = await supabase.rpc("admin_set_capacity", {
      p_team_id: id,
      p_capacity: capacity,
    });
    return rpcResponse(data, error);
  }

  // 이름 / 설명 / 정렬 변경
  if (!body.name?.trim()) return json({ ok: false, status: "invalid_name" }, 400);

  const { data, error } = await supabase.rpc("admin_update_team", {
    p_team_id: id,
    p_name: body.name.trim(),
    p_description: body.description ?? "",
    p_sort_order: Number.isInteger(body.sort_order) ? body.sort_order : null,
  });
  return rpcResponse(data, error);
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const { data, error } = await getAdminSupabase().rpc("admin_delete_team", {
    p_team_id: id,
  });
  return rpcResponse(data, error);
}
