import { getAdminSupabase } from "@/lib/supabase/admin";
import { guardAdmin, json } from "@/lib/api";
import { csvEscape } from "@/lib/format";
import type { Registration, Team } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await guardAdmin();
  if (denied) return denied;

  const includeCancelled =
    new URL(req.url).searchParams.get("cancelled") === "1";

  const supabase = getAdminSupabase();

  const [teamsRes, regsRes] = await Promise.all([
    supabase.from("teams").select("*").order("sort_order").order("name"),
    supabase
      .from("registrations")
      .select("*")
      .order("team_id")
      .order("seq"),
  ]);

  if (teamsRes.error || regsRes.error) {
    return json(
      {
        ok: false,
        status: "db_error",
        message: teamsRes.error?.message ?? regsRes.error?.message,
      },
      500,
    );
  }

  const teams = new Map(
    ((teamsRes.data ?? []) as Team[]).map((t) => [t.id, t] as const),
  );

  const rows = ((regsRes.data ?? []) as Registration[])
    .filter((r) => includeCancelled || !r.is_cancelled)
    .sort((a, b) => {
      const ta = teams.get(a.team_id);
      const tb = teams.get(b.team_id);
      return (
        (ta?.sort_order ?? 0) - (tb?.sort_order ?? 0) ||
        (ta?.name ?? "").localeCompare(tb?.name ?? "") ||
        a.seq - b.seq
      );
    });

  const header = [
    "team_name",
    "seq",
    "name",
    "student_no4",
    "created_at",
    "is_cancelled",
    "cancelled_at",
    "registration_id",
  ];

  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [
        teams.get(r.team_id)?.name ?? r.team_id,
        r.seq,
        r.name,
        r.student_no4,
        r.created_at,
        r.is_cancelled ? "Y" : "N",
        r.cancelled_at ?? "",
        r.id,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];

  // Excel 이 UTF-8 로 인식하도록 BOM 을 앞에 붙인다.
  const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="registrations-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
