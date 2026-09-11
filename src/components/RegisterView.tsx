"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useContest } from "@/lib/useContest";
import { RESULT_MESSAGE, type RegisterResult, type Team } from "@/lib/types";
import Countdown from "@/components/Countdown";
import TeamCard from "@/components/TeamCard";
import ConfirmModal from "@/components/ConfirmModal";
import ResultPanel from "@/components/ResultPanel";

const STORAGE_KEY = "fcs_my_registration";

type MyRegistration = {
  registration_id: string;
  team_id: string;
  team_name: string;
  seq: number;
  name: string;
  student_no4: string;
  created_at: string;
};

type Banner = { tone: "error" | "warn" | "info"; text: string } | null;

function loadStored(): MyRegistration | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MyRegistration) : null;
  } catch {
    return null;
  }
}

export default function RegisterView() {
  const { teams, opensAt, isClosed, clockOffsetMs, loading, error, realtime, refresh } =
    useContest();

  const [name, setName] = useState("");
  const [studentNo, setStudentNo] = useState("");
  const [selected, setSelected] = useState<Team | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [me, setMe] = useState<MyRegistration | null>(null);

  // ── 새로고침 후에도 본인 배정 결과를 유지한다.
  //    로컬 저장값은 참고용이고, 진짜 상태는 서버에 다시 물어 확인한다.
  useEffect(() => {
    const stored = loadStored();
    if (!stored) return;
    setMe(stored);

    void (async () => {
      let res: RegisterResult | null = null;
      try {
        const { data } = await getSupabase().rpc("lookup_registration", {
          p_name: stored.name,
          p_student_no4: stored.student_no4,
        });
        res = data as RegisterResult | null;
      } catch {
        return; // 오프라인 등 — 저장된 결과를 그대로 보여준다
      }

      if (res?.ok) {
        const fresh: MyRegistration = {
          registration_id: res.registration_id,
          team_id: res.team_id,
          team_name: res.team_name,
          seq: res.seq,
          name: res.name,
          student_no4: stored.student_no4,
          created_at: res.created_at,
        };
        setMe(fresh);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      } else if (res && res.status === "not_found") {
        // 운영진이 신청을 취소한 경우 — 다시 신청할 수 있게 되돌린다.
        window.localStorage.removeItem(STORAGE_KEY);
        setMe(null);
        setBanner({
          tone: "warn",
          text: "이전 신청이 취소되었습니다. 다시 신청할 수 있습니다.",
        });
      }
    })();
  }, []);

  const [opened, setOpened] = useState(false);

  // ── 오픈 시각 도달을 Countdown 의 리렌더와 무관하게 직접 추적한다.
  //    (Countdown 의 setRemaining 은 Countdown 자신만 리렌더하므로,
  //     get_public_state 응답을 기다리지 않고 오픈 순간 즉시 풀려야 한다.)
  useEffect(() => {
    if (!opensAt) {
      setOpened(false);
      return;
    }
    const target = new Date(opensAt).getTime();
    const check = () => setOpened(Date.now() + clockOffsetMs >= target);
    check();
    const id = setInterval(check, 200);
    return () => clearInterval(id);
  }, [opensAt, clockOffsetMs]);

  const canSubmit = opened && !isClosed;

  // ── 선택해 둔 팀이 실시간 갱신으로 정원이 차면 선택을 해제한다.
  useEffect(() => {
    if (!selected) return;
    const t = teams.find((x) => x.id === selected.id);
    if (t && t.taken >= t.capacity) {
      setSelected(null);
      setBanner({ tone: "warn", text: "선택하신 팀이 방금 마감되어 선택이 해제되었습니다." });
    }
  }, [teams, selected]);

  const totals = useMemo(() => {
    const capacity = teams.reduce((a, t) => a + t.capacity, 0);
    const taken = teams.reduce((a, t) => a + t.taken, 0);
    return { capacity, taken, remaining: capacity - taken };
  }, [teams]);

  const nameValid = name.trim().length >= 1 && name.trim().length <= 40;
  const snoValid = /^[0-9]{4}$/.test(studentNo.trim());
  const formReady = nameValid && snoValid && !!selected;

  const persist = useCallback((reg: MyRegistration) => {
    setMe(reg);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reg));
    } catch {
      /* 사파리 프라이빗 모드 등 — 화면 표시에는 영향 없음 */
    }
  }, []);

  /** 네트워크가 끊긴 뒤 재시도할 때, 실제로 등록되었는지 서버에 확인한다. */
  const recoverAfterNetworkError = useCallback(async (): Promise<boolean> => {
    let res: RegisterResult | null = null;
    try {
      const { data } = await getSupabase().rpc("lookup_registration", {
        p_name: name.trim(),
        p_student_no4: studentNo.trim(),
      });
      res = data as RegisterResult | null;
    } catch {
      return false;
    }
    if (!res?.ok) return false;

    persist({
      registration_id: res.registration_id,
      team_id: res.team_id,
      team_name: res.team_name,
      seq: res.seq,
      name: res.name,
      student_no4: studentNo.trim(),
      created_at: res.created_at,
    });
    return true;
  }, [name, studentNo, persist]);

  const submit = useCallback(async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setBanner(null);

    try {
      const { data, error: rpcError } = await getSupabase().rpc("register_for_team", {
        p_team_id: selected.id,
        p_name: name.trim(),
        p_student_no4: studentNo.trim(),
      });

      if (rpcError) throw rpcError;
      const res = data as RegisterResult;

      if (res.ok) {
        persist({
          registration_id: res.registration_id,
          team_id: res.team_id,
          team_name: res.team_name,
          seq: res.seq,
          name: res.name,
          student_no4: studentNo.trim(),
          created_at: res.created_at,
        });
        setConfirming(false);
        void refresh();
        return;
      }

      setConfirming(false);

      if (res.status === "team_full") {
        setSelected(null);
        void refresh(); // 잔여 팀 즉시 갱신
        setBanner({ tone: "warn", text: RESULT_MESSAGE.team_full });
        return;
      }

      if (res.status === "duplicate_name" && res.existing) {
        // 제출 중 네트워크가 끊겨 재시도한 경우가 대부분이다.
        persist({
          registration_id: res.existing.registration_id,
          team_id: res.existing.team_id,
          team_name: res.existing.team_name,
          seq: res.existing.seq,
          name: name.trim(),
          student_no4: studentNo.trim(),
          created_at: res.existing.created_at,
        });
        setBanner({ tone: "info", text: "이미 접수된 신청을 불러왔습니다." });
        return;
      }

      if (res.status === "not_open" || res.status === "closed") void refresh();

      setBanner({
        tone: "error",
        text: RESULT_MESSAGE[res.status] ?? "신청에 실패했습니다.",
      });
    } catch (e) {
      // 응답을 받지 못했다 = 등록 여부를 알 수 없다. 서버에 직접 확인한다.
      const recovered = await recoverAfterNetworkError();
      setConfirming(false);
      if (!recovered) {
        setBanner({
          tone: "error",
          text: `통신에 실패했습니다. 다시 시도해주세요. (${
            e instanceof Error ? e.message : "network"
          })`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [selected, submitting, name, studentNo, persist, refresh, recoverAfterNetworkError]);

  // ── 이미 배정된 사용자 화면 ──────────────────────────────────
  if (me) {
    return (
      <div className="space-y-4">
        <ResultPanel
          teamName={me.team_name}
          seq={me.seq}
          name={me.name}
          createdAt={me.created_at}
          onReset={() => {
            window.localStorage.removeItem(STORAGE_KEY);
            setMe(null);
            setName("");
            setStudentNo("");
            setSelected(null);
            setBanner(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {isClosed && (
        <div className="rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-sm font-medium text-slate-700">
          신청이 마감되었습니다.
        </div>
      )}

      {!isClosed && !opened && (
        <Countdown
          opensAt={opensAt}
          clockOffsetMs={clockOffsetMs}
          onOpen={refresh}
        />
      )}

      {banner && (
        <div
          role="status"
          className={[
            "animate-fade-in rounded-xl border px-4 py-3 text-sm font-medium",
            banner.tone === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : banner.tone === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-blue-200 bg-blue-50 text-blue-900",
          ].join(" ")}
        >
          {banner.text}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <section>
        <div className="mb-2 flex items-end justify-between">
          <h1 className="text-lg font-bold">1. 팀 선택</h1>
          <p className="text-xs text-slate-500">
            전체 잔여{" "}
            <span className="font-mono font-semibold tabular-nums text-slate-700">
              {totals.remaining}
            </span>
            {" / "}
            {totals.capacity}
            <span className="ml-2 inline-flex items-center gap-1">
              <span
                className={[
                  "inline-block h-1.5 w-1.5 rounded-full",
                  realtime === "live" ? "bg-emerald-500" : "bg-amber-500",
                ].join(" ")}
              />
              {realtime === "live" ? "실시간" : "동기화 중"}
            </span>
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white"
              />
            ))}
          </div>
        ) : teams.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
            등록된 팀이 없습니다. 운영진에게 문의하세요.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {teams.map((t) => (
              <TeamCard
                key={t.id}
                team={t}
                selected={selected?.id === t.id}
                disabled={isClosed}
                onSelect={(team) => {
                  setSelected(team);
                  setBanner(null);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-bold">2. 본인 정보</h2>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="sm:col-span-2">
            <span className="text-xs font-medium text-slate-600">이름</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="off"
              placeholder="홍길동"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>

          <label>
            <span className="text-xs font-medium text-slate-600">학번 뒤 4자리</span>
            <input
              value={studentNo}
              onChange={(e) =>
                setStudentNo(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))
              }
              inputMode="numeric"
              autoComplete="off"
              placeholder="1234"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 font-mono text-sm tabular-nums outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          동명이인 구분을 위해 학번 뒤 4자리를 함께 받습니다. 한 사람은 한 팀에만
          신청할 수 있습니다.
        </p>

        <button
          type="button"
          disabled={!canSubmit || !formReady || submitting}
          onClick={() => setConfirming(true)}
          className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isClosed
            ? "마감되었습니다"
            : !opened
              ? "오픈 전입니다"
              : !selected
                ? "팀을 선택해주세요"
                : !formReady
                  ? "이름과 학번 뒤 4자리를 입력해주세요"
                  : `${selected.name} 팀으로 신청하기`}
        </button>
      </section>

      <ConfirmModal
        open={confirming}
        title="신청 내용을 확인해주세요"
        confirmLabel="신청 확정"
        pending={submitting}
        onCancel={() => !submitting && setConfirming(false)}
        onConfirm={submit}
      >
        <dl className="grid grid-cols-3 gap-y-2">
          <dt className="text-slate-500">팀</dt>
          <dd className="col-span-2 font-semibold text-slate-900">
            {selected?.name}
          </dd>
          <dt className="text-slate-500">이름</dt>
          <dd className="col-span-2 font-semibold text-slate-900">{name.trim()}</dd>
          <dt className="text-slate-500">학번</dt>
          <dd className="col-span-2 font-mono font-semibold tabular-nums text-slate-900">
            ···{studentNo}
          </dd>
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          확정 후에는 본인이 변경할 수 없습니다. 좌석은 서버가 확정하는 순간
          배정됩니다.
        </p>
      </ConfirmModal>
    </div>
  );
}
