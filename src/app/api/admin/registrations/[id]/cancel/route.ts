import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, rpcResponse } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const { data, error } = await getAdminSupabase().rpc(
    "admin_cancel_registration",
    { p_registration_id: id },
  );
  return rpcResponse(data, error);
}
