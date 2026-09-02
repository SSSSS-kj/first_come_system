"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";
import type { PublicState, Team } from "@/lib/types";

export type ContestState = {
  teams: Team[];
  opensAt: string | null;
  isClosed: boolean;
  /** 서버 시각 − 브라우저 시각 (ms). 카운트다운은 이 보정값으로 계산한다. */
  clockOffsetMs: number;
  loading: boolean;
  error: string | null;
  realtime: "connecting" | "live" | "polling";
};

const POLL_MS = 4000;

function isTeamRow(row: unknown): row is Team {
  return !!row && typeof (row as Team).id === "string";
}

/**
 * 팀 잔여석과 오픈 설정을 구독한다.
 *
 *  - teams 는 Realtime(postgres_changes)으로 즉시 갱신된다.
 *  - settings 는 admin_password_hash 의 컬럼 단위 권한 때문에 Realtime 전달이
 *    보장되지 않으므로 get_public_state() 폴링을 안전망으로 함께 돌린다.
 *  - 탭 복귀 / 재연결 시 전체 상태를 다시 읽어 누락된 이벤트를 복구한다.
 */
export function useContest() {
  const [state, setState] = useState<ContestState>({
    teams: [],
    opensAt: null,
    isClosed: false,
    clockOffsetMs: 0,
    loading: true,
    error: null,
    realtime: "connecting",
  });

  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const sentAt = Date.now();

    try {
      const { data, error } = await getSupabase().rpc("get_public_state");
      if (error) throw error;

      const s = data as PublicState;
      const rtt = Date.now() - sentAt;
      // 왕복 시간의 절반을 보정해 서버 시각과의 차이를 추정한다.
      const offset = new Date(s.server_now).getTime() - (sentAt + rtt / 2);

      setState((prev) => ({
        ...prev,
        teams: s.teams ?? [],
        opensAt: s.opens_at,
        isClosed: s.is_closed,
        clockOffsetMs: offset,
        loading: false,
        error: null,
      }));
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : "상태를 불러오지 못했습니다.",
      }));
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const supabase = getSupabase();

    const onTeamChange = (payload: RealtimePostgresChangesPayload<Team>) => {
      if (payload.eventType === "DELETE") {
        void refresh();
        return;
      }
      const row: unknown = payload.new;
      if (!isTeamRow(row)) {
        void refresh();
        return;
      }
      setState((prev) => {
        const exists = prev.teams.some((t) => t.id === row.id);
        const teams = exists
          ? prev.teams.map((t) => (t.id === row.id ? { ...t, ...row } : t))
          : [...prev.teams, row];
        teams.sort(
          (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
        );
        return { ...prev, teams };
      });
    };

    const channel = supabase
      .channel("contest-public")
      .on<Team>(
        "postgres_changes",
        { event: "*", schema: "public", table: "teams" },
        onTeamChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "settings" },
        () => void refresh(),
      )
      .subscribe((status) => {
        setState((prev) => ({
          ...prev,
          realtime: String(status) === "SUBSCRIBED" ? "live" : "polling",
        }));
      });

    const poll = setInterval(() => void refresh(), POLL_MS);
    const onWake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);

    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  return { ...state, refresh };
}
