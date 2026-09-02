import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, json, readJson, rpcResponse } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const body = await readJson<{ to_team_id?: string }>(req);
  if (!body?.to_team_id) return json({ ok: false, status: "invalid_body" }, 400);

  const { data, error } = await getAdminSupabase().rpc(
    "admin_transfer_registration",
    { p_registration_id: id, p_to_team_id: body.to_team_id },
  );
  return rpcResponse(data, error);
}
