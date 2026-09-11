"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatDateTime,
  isoToLocalInput,
  localInputToIso,
} from "@/lib/format";
import type { AuditRow, Registration, Team } from "@/lib/types";

type AdminState = {
  server_now: string;
  opens_at: string | null;
  is_closed: boolean;
  teams: Team[];
  registrations: Registration[];
};

type Toast = { tone: "ok" | "error"; text: string } | null;

const STATUS_TEXT: Record<string, string> = {
  capacity_below_taken: "현재 인원보다 작은 정원으로는 줄일 수 없습니다.",
  has_active_registrations: "신청자가 있는 팀은 삭제할 수 없습니다.",
  has_registration_history: "신청 이력이 남아 있어 삭제할 수 없습니다.",
  team_full: "대상 팀이 가득 찼습니다.",
  duplicate_team_name: "같은 이름의 팀이 이미 있습니다.",
  already_cancelled: "이미 취소된 신청입니다.",
  registration_not_found: "신청을 찾을 수 없습니다.",
  team_not_found: "팀을 찾을 수 없습니다.",
  same_team: "이미 그 팀에 속해 있습니다.",
  unauthorized: "세션이 만료되었습니다. 다시 로그인해주세요.",
};

async function call(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status?: string; [k: string]: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  try {
    return (await res.json()) as { ok: boolean; status?: string };
  } catch {
    return { ok: false, status: `http_${res.status}` };
  }
}

export default function AdminView() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [state, setState] = useState<AdminState | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditFailuresOnly, setAuditFailuresOnly] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [opensAtInput, setOpensAtInput] = useState("");
  const [newTeam, setNewTeam] = useState({
    name: "",
    description: "",
    capacity: 15,
  });

  const notify = useCallback((tone: "ok" | "error", text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const fail = useCallback(
    (r: { status?: string; message?: unknown }) =>
      STATUS_TEXT[r.status ?? ""] ??
      (typeof r.message === "string" ? r.message : `실패 (${r.status ?? "unknown"})`),
    [],
  );

  const loadState = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch("/api/admin/state", { cache: "no-store" });
    } catch {
      return; // 네트워크 순단 — 다음 폴링에서 회복된다
    }

    if (res.status === 401) {
      setAuthed(false);
      return;
    }
    setAuthed(true); // 인증은 유효하다. 아래는 데이터 갱신 실패 여부만 본다.

    const data = (await res.json().catch(() => null)) as
      | (AdminState & { ok: boolean })
      | null;
    if (!data?.ok) return; // 일시적 오류 — 기존 화면을 유지한다

    setState(data);
    setOpensAtInput((prev) => (prev ? prev : isoToLocalInput(data.opens_at)));
  }, []);

  const loadAudit = useCallback(async () => {
    const res = await fetch(
      `/api/admin/audit?limit=200${auditFailuresOnly ? "&failures=1" : ""}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { ok: boolean; rows: AuditRow[] };
    if (data.ok) setAudit(data.rows);
  }, [auditFailuresOnly]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (authed) void loadAudit();
  }, [authed, loadAudit]);

  // 대회 진행 중에는 주기적으로 현황을 갱신한다.
  useEffect(() => {
    if (!authed) return;
    const id = setInterval(() => void loadState(), 4000);
    return () => clearInterval(id);
  }, [authed, loadState]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError(null);
    const r = await call("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setLoggingIn(false);

    if (r.ok) {
      setPassword("");
      await loadState();
    } else {
      setLoginError(
        r.status === "rate_limited"
          ? "시도가 너무 많습니다. 잠시 후 다시 시도하세요."
          : "비밀번호가 올바르지 않습니다.",
      );
    }
  };

  const act = useCallback(
    async (key: string, fn: () => Promise<{ ok: boolean; status?: string }>, okText: string) => {
      setBusy(key);
      try {
        const r = await fn();
        if (r.ok) {
          notify("ok", okText);
          await Promise.all([loadState(), loadAudit()]);
        } else {
          notify("error", fail(r));
          if (r.status === "unauthorized") setAuthed(false);
          await loadState();
        }
      } finally {
        setBusy(null);
      }
    },
    [notify, fail, loadState, loadAudit],
  );

  const teamsById = useMemo(
    () => new Map((state?.teams ?? []).map((t) => [t.id, t] as const)),
    [state],
  );

  const activeRegs = useMemo(
    () => (state?.registrations ?? []).filter((r) => !r.is_cancelled),
    [state],
  );

  // ── 로그인 화면 ────────────────────────────────────────────
  if (authed === null) {
    return <p className="py-16 text-center text-sm text-slate-400">확인 중…</p>;
  }

  if (!authed) {
    return (
      <form
        onSubmit={login}
        className="mx-auto mt-12 max-w-sm space-y-3 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <h1 className="text-lg font-bold">관리자 로그인</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder="관리자 비밀번호"
          className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
        {loginError && <p className="text-sm text-red-600">{loginError}</p>}
        <button
          type="submit"
          disabled={loggingIn || !password}
          className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:bg-slate-300"
        >
          {loggingIn ? "확인 중…" : "로그인"}
        </button>
      </form>
    );
  }

  // ── 관리자 화면 ────────────────────────────────────────────
  return (
    <div className="space-y-6 pb-10">
      {toast && (
        <div
          className={[
            "sticky top-2 z-40 animate-fade-in rounded-xl border px-4 py-3 text-sm font-medium shadow-sm",
            toast.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-800",
          ].join(" ")}
        >
          {toast.text}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">관리자</h1>
          <p className="text-xs text-slate-500">
            서버 시각 {formatDateTime(state?.server_now)}
          </p>
        </div>
        <button
          type="button"
          onClick={async () => {
            await call("/api/admin/logout", { method: "POST" });
            setAuthed(false);
            setState(null);
          }}
          className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600"
        >
          로그아웃
        </button>
      </div>

      {/* 오픈 설정 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-base font-bold">신청 오픈 설정</h2>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="text-xs font-medium text-slate-600">
              오픈 시각 (브라우저 로컬 시각으로 입력 → 서버에 UTC 로 저장)
            </span>
            <input
              type="datetime-local"
              value={opensAtInput}
              onChange={(e) => setOpensAtInput(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <button
            type="button"
            disabled={busy === "settings" || !opensAtInput}
            onClick={() =>
              act(
                "settings",
                () =>
                  call("/api/admin/settings", {
                    method: "PATCH",
                    body: JSON.stringify({
                      opens_at: localInputToIso(opensAtInput),
                    }),
                  }),
                "오픈 시각을 저장했습니다.",
              )
            }
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
          >
            저장
          </button>

          <button
            type="button"
            disabled={busy === "settings"}
            onClick={() =>
              act(
                "settings",
                () =>
                  call("/api/admin/settings", {
                    method: "PATCH",
                    body: JSON.stringify({
                      is_closed: !state?.is_closed,
                    }),
                  }),
                state?.is_closed ? "마감을 해제했습니다." : "즉시 마감했습니다.",
              )
            }
            className={[
              "rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300",
              state?.is_closed ? "bg-emerald-600" : "bg-red-600",
            ].join(" ")}
          >
            {state?.is_closed ? "마감 해제" : "즉시 마감"}
          </button>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          현재 상태:{" "}
          <span className="font-semibold">
            {state?.is_closed
              ? "마감됨"
              : state?.opens_at
                ? `오픈 ${formatDateTime(state.opens_at)}`
                : "오픈 시각 미지정 (신청 불가)"}
          </span>
        </p>
      </section>

      {/* 팀 관리 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-base font-bold">팀 관리</h2>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="py-2">팀</th>
                <th className="py-2 text-right">인원</th>
                <th className="py-2 text-right">정원</th>
                <th className="py-2 text-right">작업</th>
              </tr>
            </thead>
            <tbody>
              {(state?.teams ?? []).map((t) => (
                <TeamRow
                  key={t.id}
                  team={t}
                  busy={busy === `team-${t.id}`}
                  onCapacity={(capacity) =>
                    act(
                      `team-${t.id}`,
                      () =>
                        call(`/api/admin/teams/${t.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ capacity }),
                        }),
                      `${t.name} 정원을 ${capacity}명으로 변경했습니다.`,
                    )
                  }
                  onDelete={() => {
                    if (!window.confirm(`'${t.name}' 팀을 삭제할까요?`)) return;
                    void act(
                      `team-${t.id}`,
                      () => call(`/api/admin/teams/${t.id}`, { method: "DELETE" }),
                      `${t.name} 팀을 삭제했습니다.`,
                    );
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row">
          <input
            value={newTeam.name}
            onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })}
            placeholder="새 팀 이름"
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm sm:w-40"
          />
          <input
            value={newTeam.description}
            onChange={(e) =>
              setNewTeam({ ...newTeam, description: e.target.value })
            }
            placeholder="한 줄 설명"
            className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            min={0}
            value={newTeam.capacity}
            onChange={(e) =>
              setNewTeam({ ...newTeam, capacity: Number(e.target.value) })
            }
            className="w-24 rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={!newTeam.name.trim() || busy === "new-team"}
            onClick={() =>
              act(
                "new-team",
                async () => {
                  const r = await call("/api/admin/teams", {
                    method: "POST",
                    body: JSON.stringify({
                      ...newTeam,
                      sort_order: (state?.teams.length ?? 0) + 1,
                    }),
                  });
                  if (r.ok) setNewTeam({ name: "", description: "", capacity: 15 });
                  return r;
                },
                "팀을 추가했습니다.",
              )
            }
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
          >
            팀 추가
          </button>
        </div>
      </section>

      {/* 신청자 관리 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">
            신청자 <span className="text-slate-400">({activeRegs.length}명)</span>
          </h2>
          <div className="flex gap-2">
            <a
              href="/api/admin/export"
              className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              CSV 다운로드
            </a>
            <a
              href="/api/admin/export?cancelled=1"
              className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
            >
              취소 포함
            </a>
          </div>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="py-2">팀 / 순번</th>
                <th className="py-2">이름</th>
                <th className="py-2">학번</th>
                <th className="py-2">신청 시각</th>
                <th className="py-2 text-right">작업</th>
              </tr>
            </thead>
            <tbody>
              {(state?.registrations ?? []).map((r) => (
                <RegistrationRow
                  key={r.id}
                  reg={r}
                  teamName={teamsById.get(r.team_id)?.name ?? "?"}
                  teams={state?.teams ?? []}
                  busy={busy === `reg-${r.id}`}
                  onCancel={() => {
                    if (!window.confirm(`'${r.name}' 님의 신청을 취소할까요?`)) return;
                    void act(
                      `reg-${r.id}`,
                      () =>
                        call(`/api/admin/registrations/${r.id}/cancel`, {
                          method: "POST",
                        }),
                      `${r.name} 님의 신청을 취소했습니다. 자리가 다시 열립니다.`,
                    );
                  }}
                  onTransfer={(toTeamId) =>
                    act(
                      `reg-${r.id}`,
                      () =>
                        call(`/api/admin/registrations/${r.id}/transfer`, {
                          method: "POST",
                          body: JSON.stringify({ to_team_id: toTeamId }),
                        }),
                      `${r.name} 님을 이관했습니다.`,
                    )
                  }
                />
              ))}
              {(state?.registrations ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    아직 신청자가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 감사 로그 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">감사 로그</h2>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={auditFailuresOnly}
              onChange={(e) => setAuditFailuresOnly(e.target.checked)}
            />
            실패만 보기
          </label>
        </div>

        <div className="mt-3 max-h-96 overflow-auto rounded-xl border border-slate-100">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2">시각</th>
                <th className="px-3 py-2">동작</th>
                <th className="px-3 py-2">주체</th>
                <th className="px-3 py-2">결과</th>
                <th className="px-3 py-2">대상</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {audit.map((a) => (
                <tr key={a.id} className={a.success ? "" : "bg-red-50/50"}>
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-500">
                    {formatDateTime(a.at)}
                  </td>
                  <td className="px-3 py-1.5 font-medium">{a.action}</td>
                  <td className="px-3 py-1.5 text-slate-500">{a.actor}</td>
                  <td
                    className={[
                      "px-3 py-1.5 font-medium",
                      a.success ? "text-emerald-700" : "text-red-700",
                    ].join(" ")}
                  >
                    {a.reason}
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">
                    {a.name ?? "-"}
                    {a.team_id && (
                      <span className="ml-1 text-slate-400">
                        ({teamsById.get(a.team_id)?.name ?? "삭제된 팀"}
                        {a.to_team_id
                          ? ` → ${teamsById.get(a.to_team_id)?.name ?? "?"}`
                          : ""}
                        )
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {audit.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    기록이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TeamRow({
  team,
  busy,
  onCapacity,
  onDelete,
}: {
  team: Team;
  busy: boolean;
  onCapacity: (capacity: number) => void;
  onDelete: () => void;
}) {
  const [capacity, setCapacity] = useState(team.capacity);
  useEffect(() => setCapacity(team.capacity), [team.capacity]);

  return (
    <tr className="border-b border-slate-50">
      <td className="py-2">
        <p className="font-medium text-slate-900">{team.name}</p>
        <p className="text-xs text-slate-400">{team.description}</p>
      </td>
      <td className="py-2 text-right font-mono tabular-nums">{team.taken}</td>
      <td className="py-2 text-right">
        <input
          type="number"
          min={0}
          value={capacity}
          onChange={(e) => setCapacity(Number(e.target.value))}
          className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-right font-mono text-sm tabular-nums"
        />
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          disabled={busy || capacity === team.capacity}
          onClick={() => onCapacity(capacity)}
          className="mr-1 rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:bg-slate-200 disabled:text-slate-400"
        >
          저장
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 disabled:opacity-40"
        >
          삭제
        </button>
      </td>
    </tr>
  );
}

function RegistrationRow({
  reg,
  teamName,
  teams,
  busy,
  onCancel,
  onTransfer,
}: {
  reg: Registration;
  teamName: string;
  teams: Team[];
  busy: boolean;
  onCancel: () => void;
  onTransfer: (toTeamId: string) => void;
}) {
  const [target, setTarget] = useState("");

  return (
    <tr
      className={[
        "border-b border-slate-50",
        reg.is_cancelled ? "text-slate-400 line-through" : "",
      ].join(" ")}
    >
      <td className="py-2">
        <span className="font-medium">{teamName}</span>{" "}
        <span className="font-mono tabular-nums text-slate-400">#{reg.seq}</span>
      </td>
      <td className="py-2 font-medium">{reg.name}</td>
      <td className="py-2 font-mono tabular-nums text-slate-500">
        {reg.student_no4}
      </td>
      <td className="py-2 text-xs text-slate-500">
        {formatDateTime(reg.created_at)}
      </td>
      <td className="py-2 text-right">
        {reg.is_cancelled ? (
          <span className="text-xs">취소됨</span>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded-lg border border-slate-300 px-1.5 py-1 text-xs"
            >
              <option value="">이관…</option>
              {teams
                .filter((t) => t.id !== reg.team_id)
                .map((t) => (
                  <option key={t.id} value={t.id} disabled={t.taken >= t.capacity}>
                    {t.name} ({t.capacity - t.taken}자리)
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={busy || !target}
              onClick={() => {
                onTransfer(target);
                setTarget("");
              }}
              className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:bg-slate-200 disabled:text-slate-400"
            >
              이관
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="rounded-lg border border-red-200 px-2 py-1 text-xs font-medium text-red-600 disabled:opacity-40"
            >
              취소
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
