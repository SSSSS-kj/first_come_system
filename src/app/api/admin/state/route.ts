import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, json } from "@/lib/api";
import type { PublicState, Registration, Team } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await guardAdmin();
  if (denied) return denied;

  const supabase = getAdminSupabase();

  const [stateRes, regsRes] = await Promise.all([
    supabase.rpc("get_public_state"),
    supabase
      .from("registrations")
      .select(
        "id, team_id, name, student_no4, seq, created_at, is_cancelled, cancelled_at",
      )
      .order("created_at", { ascending: true }),
  ]);

  if (stateRes.error) {
    return json({ ok: false, status: "rpc_error", message: stateRes.error.message }, 500);
  }
  if (regsRes.error) {
    return json({ ok: false, status: "db_error", message: regsRes.error.message }, 500);
  }

  const state = stateRes.data as PublicState;

  return json({
    ok: true,
    server_now: state.server_now,
    opens_at: state.opens_at,
    is_closed: state.is_closed,
    teams: (state.teams ?? []) as Team[],
    registrations: (regsRes.data ?? []) as Registration[],
  });
}
