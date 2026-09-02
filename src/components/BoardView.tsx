"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";
import { useContest } from "@/lib/useContest";
import { formatDateTime } from "@/lib/format";
import type { Registration } from "@/lib/types";

/** 현황판은 개인정보 보호를 위해 학번을 제외한 공개 컬럼만 읽는다. */
type PublicRegistration = Omit<Registration, "student_no4">;

export default function BoardView() {
  const { teams, loading: teamsLoading, realtime } = useContest();
  const [rows, setRows] = useState<PublicRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const { data, error: e } = await getSupabase()
        .from("registrations")
        .select("id, team_id, name, seq, created_at, is_cancelled, cancelled_at")
        .eq("is_cancelled", false)
        .order("team_id")
        .order("seq");
      if (e) throw e;
      setRows((data ?? []) as PublicRegistration[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "명단을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const supabase = getSupabase();

    const onChange = (_p: RealtimePostgresChangesPayload<PublicRegistration>) => {
      // 취소·이관은 팀 이동과 순번 변경을 동반하므로 전체를 다시 읽는 편이 안전하다.
      void load();
    };

    const channel = supabase
      .channel("board-registrations")
      .on<PublicRegistration>(
        "postgres_changes",
        { event: "*", schema: "public", table: "registrations" },
        onChange,
      )
      .subscribe();

    // Realtime 이 끊겨도 현황판이 멈추지 않도록 폴링을 안전망으로 둔다.
    const poll = setInterval(() => void load(), 5000);
    const onWake = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);

    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const byTeam = useMemo(() => {
    const map = new Map<string, PublicRegistration[]>();
    for (const r of rows) {
      const list = map.get(r.team_id) ?? [];
      list.push(r);
      map.set(r.team_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.seq - b.seq);
    return map;
  }, [rows]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-bold">팀별 현황판</h1>
          <p className="text-xs text-slate-500">
            실시간으로 갱신됩니다. 총 {rows.length}명 배정
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <span
            className={[
              "inline-block h-1.5 w-1.5 rounded-full",
              realtime === "live" ? "bg-emerald-500" : "bg-amber-500",
            ].join(" ")}
          />
          {realtime === "live" ? "실시간 연결됨" : "동기화 중"}
        </span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {teamsLoading || loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-white"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {teams.map((team) => {
            const list = byTeam.get(team.id) ?? [];
            const full = team.taken >= team.capacity;

            return (
              <section
                key={team.id}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
              >
                <header className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      {team.name}
                      {full && (
                        <span className="ml-2 rounded-full bg-slate-700 px-2 py-0.5 text-[11px] font-semibold text-white">
                          마감
                        </span>
                      )}
                    </h2>
                    <p className="text-xs text-slate-500">{team.description}</p>
                  </div>
                  <p className="font-mono text-sm tabular-nums text-slate-600">
                    {team.taken} / {team.capacity}
                  </p>
                </header>

                {list.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-slate-400">
                    아직 신청자가 없습니다.
                  </p>
                ) : (
                  <ol className="divide-y divide-slate-100">
                    {list.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center gap-3 px-4 py-2 text-sm"
                      >
                        <span className="w-7 shrink-0 text-right font-mono font-semibold tabular-nums text-slate-400">
                          {r.seq}
                        </span>
                        <span className="flex-1 truncate font-medium text-slate-800">
                          {r.name}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-slate-400">
                          {formatDateTime(r.created_at).split(" ").slice(-1)[0]}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
