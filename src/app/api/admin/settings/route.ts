import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, json, readJson, rpcResponse } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { opens_at?: string | null; is_closed?: boolean };

export async function PATCH(req: Request) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const body = await readJson<Body>(req);
  if (!body) return json({ ok: false, status: "invalid_body" }, 400);

  const setOpensAt = "opens_at" in body;
  const setIsClosed = "is_closed" in body;
  if (!setOpensAt && !setIsClosed) {
    return json({ ok: false, status: "invalid_body" }, 400);
  }

  const opensAt = body.opens_at ?? null;
  if (setOpensAt && opensAt !== null && Number.isNaN(new Date(opensAt).getTime())) {
    return json({ ok: false, status: "invalid_opens_at" }, 400);
  }

  const { data, error } = await getAdminSupabase().rpc("admin_update_settings", {
    p_opens_at: opensAt,
    p_is_closed: Boolean(body.is_closed),
    p_set_opens_at: setOpensAt,
    p_set_is_closed: setIsClosed,
  });

  return rpcResponse(data, error);
}
