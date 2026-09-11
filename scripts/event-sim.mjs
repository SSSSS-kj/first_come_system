#!/usr/bin/env node
/**
 * 실제 행사 시뮬레이션 — 100명이 페이지를 열어 둔 채 오픈을 기다리다
 * 동시에 신청하는 상황을, 앱이 실제로 쓰는 경로(anon 키 + RPC + Realtime +
 * 폴링)로 재현한다. `scripts/load-test.mjs`는 RPC를 직접 두들기는 순수
 * 동시성 테스트인 반면, 이 스크립트는 `useContest.ts`/`RegisterView.tsx`/
 * `BoardView.tsx`의 동작(구독, 폴링, 시계 보정, team_full 재시도, 네트워크
 * 끊김 복구)까지 그대로 흉내 낸다.
 *
 *   node scripts/event-sim.mjs [--users 100] [--boards 2] [--capacity 10]
 *                               [--runs 3] [--open-in 20] [--force]
 *                               [--site-url https://...]
 *
 * ⚠ __sim__A~D 팀 4개(기본 정원 10)를 만들고 settings.opens_at/is_closed 를
 *   일시적으로 바꾼다. 개발용 프로젝트에서 실행할 것.
 * ⚠ `__` 로 시작하지 않는 실제 팀에 취소되지 않은 신청이 있으면 --force
 *   없이는 실행을 거부한다.
 * ⚠ 신청자·현황판 가상 사용자마다 별도의 Realtime 연결을 연다. 100명+
 *   규모로 실행하기 전에 Supabase 프로젝트의 동시 연결 한도(Free 플랜)를
 *   대시보드에서 확인할 것.
 * ⚠ audit_log 는 append-only 라 시뮬레이션이 남긴 행은 정리하지 않는다
 *   (정상 동작).
 */

import { readFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";

// ── .env.local / .env 로드 ────────────────────────────────────────────
for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ── 인자 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const strArg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const numArg = (name, fallback) => Number(strArg(name, fallback));

const USERS = numArg("users", 100);
const BOARDS = numArg("boards", 2);
const CAPACITY = numArg("capacity", 10);
const RUNS = numArg("runs", 3);
const OPEN_IN = numArg("open-in", 20); // 초
const FORCE = hasFlag("force");
const SITE_URL = strArg("site-url", null);

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !ANON || !SERVICE) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.",
  );
  process.exit(1);
}

const makeAnon = () =>
  createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });

const admin = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── 유틸 ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function weightedIndex(weights) {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}

function shuffledIndices(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

// ── 결과 집계 (정확성 = PASS/FAIL, 성능/Realtime = 기록 + WARN) ──────
const results = [];
let failed = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failed += 1;
  const mark = pass ? "\x1b[32m PASS \x1b[0m" : "\x1b[31m FAIL \x1b[0m";
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
}
function note(name, detail = "", warn = false) {
  const mark = warn ? "\x1b[33m WARN \x1b[0m" : "\x1b[36m INFO \x1b[0m";
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
}

// ── 안전 점검 / 준비 / 정리 ────────────────────────────────────────────
const TEAM_PREFIX = "__sim__";
const TEAM_SUFFIXES = ["A", "B", "C", "D"];
const TEAM_WEIGHTS = [0.4, 0.25, 0.2, 0.15];

async function guardRealTeams() {
  const { data: teams, error } = await admin.from("teams").select("id, name");
  if (error) throw new Error(`팀 목록 조회 실패: ${error.message}`);
  const realIds = (teams ?? [])
    .filter((t) => !t.name.startsWith("__"))
    .map((t) => t.id);
  if (realIds.length === 0) return;

  const { count, error: cErr } = await admin
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .in("team_id", realIds)
    .eq("is_cancelled", false);
  if (cErr) throw new Error(`신청 확인 실패: ${cErr.message}`);

  if ((count ?? 0) > 0 && !FORCE) {
    console.error(
      `⚠ 실제 팀에 취소되지 않은 신청이 ${count}건 있습니다. --force 없이는 실행을 거부합니다.`,
    );
    process.exit(1);
  }
  if ((count ?? 0) > 0 && FORCE) {
    note(
      "--force 로 실행",
      `실제 팀에 신청 ${count}건이 있는 상태에서 opens_at/is_closed 를 일시적으로 바꿉니다.`,
      true,
    );
  }
}

async function saveSettings() {
  const { data } = await admin
    .from("settings")
    .select("opens_at, is_closed")
    .eq("id", 1)
    .maybeSingle();
  return data ?? { opens_at: null, is_closed: false };
}

async function setSettings(opensAt, isClosed) {
  const { error } = await admin
    .from("settings")
    .upsert({ id: 1, opens_at: opensAt, is_closed: isClosed, updated_at: new Date().toISOString() });
  if (error) throw new Error(`settings 갱신 실패: ${error.message}`);
}

async function cleanupSimTeams() {
  const { data: teams } = await admin
    .from("teams")
    .select("id, name")
    .like("name", `${TEAM_PREFIX}%`);
  for (const t of teams ?? []) {
    await admin.from("registrations").delete().eq("team_id", t.id);
    await admin.from("teams").delete().eq("id", t.id);
  }
}

async function createSimTeams(capacity) {
  const rows = TEAM_SUFFIXES.map((s, i) => ({
    name: `${TEAM_PREFIX}${s}`,
    description: "event-sim",
    capacity,
    sort_order: 9000 + i,
  }));
  const { data, error } = await admin
    .from("teams")
    .insert(rows)
    .select("id, name, capacity, taken");
  if (error) throw new Error(`sim 팀 생성 실패: ${error.message}`);
  return [...data].sort((a, b) => a.name.localeCompare(b.name));
}

// ── 신청자 컨텍스트: useContest.ts 와 동일하게 구독 + 폴링 + 시계 보정 ──
async function refreshState(ctx) {
  const sentAt = Date.now();
  try {
    const { data, error } = await ctx.client.rpc("get_public_state");
    if (error) throw error;
    const rtt = Date.now() - sentAt;
    ctx.clockOffsetMs = new Date(data.server_now).getTime() - (sentAt + rtt / 2);
    ctx.teams = data.teams ?? [];
    ctx.opensAt = data.opens_at;
    ctx.isClosed = data.is_closed;
  } catch (e) {
    ctx.lastError = String(e?.message ?? e);
  }
}

function applyTeamPayload(ctx, payload) {
  if (payload.eventType === "DELETE") {
    void refreshState(ctx);
    return;
  }
  const row = payload.new;
  if (!row?.id) {
    void refreshState(ctx);
    return;
  }
  const i = ctx.teams.findIndex((t) => t.id === row.id);
  if (i >= 0) ctx.teams[i] = { ...ctx.teams[i], ...row };
  else ctx.teams.push(row);
}

async function setupApplicant(tag) {
  const client = makeAnon();
  const ctx = {
    client,
    teams: [],
    opensAt: null,
    isClosed: false,
    clockOffsetMs: 0,
    realtimeEvents: 0,
    realtimeErrors: 0,
    statusChanges: [],
  };
  await refreshState(ctx);

  ctx.channel = client
    .channel(`sim-applicant-${tag}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "teams" },
      (payload) => {
        ctx.realtimeEvents++;
        applyTeamPayload(ctx, payload);
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "settings" },
      () => {
        ctx.realtimeEvents++;
        void refreshState(ctx);
      },
    )
    .subscribe((status) => {
      ctx.statusChanges.push(String(status));
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") ctx.realtimeErrors++;
    });

  ctx.pollTimer = setInterval(() => void refreshState(ctx), 4000); // useContest.ts POLL_MS
  return ctx;
}

async function teardownApplicant(ctx) {
  clearInterval(ctx.pollTimer);
  try {
    await ctx.client.removeChannel(ctx.channel);
  } catch {
    /* 종료 정리이므로 무시 */
  }
}

async function waitForOpen(ctx, deadlineAt) {
  while (Date.now() < deadlineAt) {
    if (ctx.opensAt) {
      const target = new Date(ctx.opensAt).getTime();
      if (Date.now() + ctx.clockOffsetMs >= target) return true;
    }
    await sleep(200); // RegisterView.tsx 의 오픈 감지 interval 과 동일
  }
  return false;
}

function pickTargetTeam(ctx, preferredIdx, teamOrder, simTeamIds) {
  // ctx.teams 는 get_public_state() 전체(실제 팀 포함) 를 앱과 동일하게 담고
  // 있으므로, 신청 대상은 반드시 이번 시뮬레이션의 __sim__ 팀으로만 한정한다.
  const withRoom = ctx.teams.filter((t) => simTeamIds.has(t.id) && t.taken < t.capacity);
  if (withRoom.length === 0) return null;
  const preferredId = teamOrder[preferredIdx]?.id;
  const preferred = withRoom.find((t) => t.id === preferredId);
  if (preferred) return preferred;
  return withRoom[Math.floor(Math.random() * withRoom.length)];
}

async function registerOnce(ctx, teamId, name, sno, signal) {
  const t0 = performance.now();
  try {
    const { data, error } = await ctx.client
      .rpc("register_for_team", { p_team_id: teamId, p_name: name, p_student_no4: sno })
      .abortSignal(signal);
    const elapsed = performance.now() - t0;
    if (error) return { elapsed, error };
    return { elapsed, data };
  } catch (e) {
    return { elapsed: performance.now() - t0, error: e };
  }
}

/** 신청자 한 명의 전체 흐름: 오픈 대기 → 반응 지연 → 신청 → team_full 재시도 (+네트워크 끊김 복구). */
async function runApplicant({ idx, round, teamOrder, isDisconnect, openDeadlineAt }) {
  const ctx = await setupApplicant(`${round}-${idx}`);
  const simTeamIds = new Set(teamOrder.map((t) => t.id));
  const name = `sim_${round}_${String(idx).padStart(4, "0")}`;
  const sno = String(1_000_000_000 + round * 100_000 + idx).slice(-10);
  const preferredIdx = weightedIndex(TEAM_WEIGHTS);

  const responseTimes = [];
  let unexpectedErrors = 0;
  let lastRes = null;
  let attempts = 0;

  const opened = await waitForOpen(ctx, openDeadlineAt);
  if (!opened) {
    await teardownApplicant(ctx);
    return { idx, name, sno, isDisconnect, attempts: 0, responseTimes, lastRes: null, unexpectedErrors: 1, note: "오픈 감지 실패(타임아웃)" };
  }

  await sleep(rand(150, 1200)); // 오픈 인지 후 반응 지연

  const EXPECTED = new Set([
    "not_open", "closed", "team_full", "duplicate_name",
    "team_not_found", "invalid_name", "invalid_student_no",
  ]);

  if (isDisconnect) {
    const team = pickTargetTeam(ctx, preferredIdx, teamOrder, simTeamIds);
    if (team) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50); // 50ms 만에 연결 끊김 흉내
      const r = await registerOnce(ctx, team.id, name, sno, controller.signal);
      responseTimes.push(r.elapsed);
      attempts++;
      await sleep(300); // 서버가 처리를 마칠 시간을 준다
      try {
        const { data } = await ctx.client
          .rpc("lookup_registration", { p_name: name, p_student_no4: sno })
          .abortSignal(timeoutSignal(5000));
        if (data?.ok) lastRes = data;
      } catch {
        /* 조회도 실패 — 아래 일반 재시도 루프로 넘어간다 */
      }
    }
  }

  while (!lastRes?.ok && attempts < 4) {
    const team = pickTargetTeam(ctx, preferredIdx, teamOrder, simTeamIds);
    if (!team) break; // 전 팀 마감 — 정상적인 탈락
    const r = await registerOnce(ctx, team.id, name, sno, timeoutSignal(10_000));
    responseTimes.push(r.elapsed);
    attempts++;

    if (r.error) {
      unexpectedErrors++;
      lastRes = { ok: false, status: "rpc_error", _error: String(r.error?.message ?? r.error) };
      break;
    }
    const res = r.data;
    if (res.ok) {
      lastRes = res;
      break;
    }
    if (res.status === "duplicate_name" && res.existing) {
      lastRes = { ok: true, status: "duplicate_name(existing)", ...res.existing };
      break;
    }
    if (!EXPECTED.has(res.status)) unexpectedErrors++;
    lastRes = res;
    if (res.status === "team_full") {
      await sleep(rand(200, 600));
      continue;
    }
    break; // not_open/closed/invalid_* 등 — 재시도해도 의미 없음
  }

  const stats = {
    idx, name, sno, isDisconnect, attempts, responseTimes, lastRes, unexpectedErrors,
    realtimeEvents: ctx.realtimeEvents,
    realtimeErrors: ctx.realtimeErrors,
    statusChanges: ctx.statusChanges,
  };
  await teardownApplicant(ctx);
  return stats;
}

// ── 현황판 가상 사용자: BoardView.tsx 와 동일하게 구독 + 5초 폴링 ──────
async function refreshBoard(bctx, teamIds) {
  const { data, error } = await bctx.client
    .from("teams")
    .select("id, taken, capacity")
    .in("id", teamIds);
  if (error) {
    bctx.lastError = String(error.message ?? error);
    return;
  }
  bctx.teams = data ?? [];
  const totalTaken = bctx.teams.reduce((a, t) => a + t.taken, 0);
  const totalCap = bctx.teams.reduce((a, t) => a + t.capacity, 0);
  if (totalTaken >= totalCap && totalCap > 0 && !bctx.detectedFullAt) {
    bctx.detectedFullAt = Date.now();
  }
}

async function setupBoard(tag, teamIds) {
  const client = makeAnon();
  const bctx = {
    client, teams: [], events: 0, errors: 0, statusChanges: [], detectedFullAt: null,
  };
  await refreshBoard(bctx, teamIds);
  bctx.channel = client
    .channel(`sim-board-${tag}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "registrations" },
      () => {
        bctx.events++;
        void refreshBoard(bctx, teamIds);
      },
    )
    .subscribe((status) => {
      bctx.statusChanges.push(String(status));
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") bctx.errors++;
    });
  bctx.pollTimer = setInterval(() => void refreshBoard(bctx, teamIds), 5000); // BoardView.tsx 폴링 주기
  return bctx;
}

async function teardownBoard(bctx) {
  clearInterval(bctx.pollTimer);
  try {
    await bctx.client.removeChannel(bctx.channel);
  } catch {
    /* 종료 정리이므로 무시 */
  }
}

// ── 한 라운드 실행 + 판정 ──────────────────────────────────────────────
async function runOnce(round) {
  console.log(`\n${"═".repeat(60)}\n라운드 ${round}/${RUNS}\n${"═".repeat(60)}`);

  await cleanupSimTeams();
  const teamOrder = await createSimTeams(CAPACITY);
  const teamIds = teamOrder.map((t) => t.id);
  const totalCapacity = teamOrder.reduce((a, t) => a + t.capacity, 0);

  const opensAtDate = new Date(Date.now() + OPEN_IN * 1000);
  await setSettings(opensAtDate.toISOString(), false);
  const openDeadlineAt = opensAtDate.getTime() + 30_000; // 오픈 후 30초까지 대기

  console.log(
    `  팀 ${teamOrder.length}개 · 정원 합계 ${totalCapacity} · 신청자 ${USERS}명 · 현황판 ${BOARDS}명 · 오픈까지 ${OPEN_IN}s`,
  );

  const boardCtxs = await Promise.all(
    Array.from({ length: BOARDS }, (_, b) => setupBoard(`${round}-${b}`, teamIds)),
  );

  const disconnectIdx = new Set(shuffledIndices(USERS).slice(0, Math.min(5, USERS)));

  const t0 = performance.now();
  const applicantResults = await Promise.all(
    Array.from({ length: USERS }, (_, idx) =>
      runApplicant({
        idx,
        round,
        teamOrder,
        isDisconnect: disconnectIdx.has(idx),
        openDeadlineAt,
      }),
    ),
  );
  const roundElapsedMs = performance.now() - t0;

  // 현황판이 마지막 이벤트를 반영할 시간을 준다 (폴링 주기 5s 보다 넉넉히).
  await sleep(6000);
  const boardStats = await Promise.all(boardCtxs.map(async (b) => {
    await teardownBoard(b);
    return b;
  }));

  // ── 판정: DB 를 진실로 삼는다 ──
  const { data: regs, error: regsErr } = await admin
    .from("registrations")
    .select("id, team_id, seq, name, student_no4, created_at, is_cancelled")
    .in("team_id", teamIds)
    .eq("is_cancelled", false)
    .order("created_at", { ascending: false });
  if (regsErr) throw new Error(`판정용 registrations 조회 실패: ${regsErr.message}`);

  const { data: teamsNow } = await admin
    .from("teams")
    .select("id, name, taken, capacity")
    .in("id", teamIds);

  const expectedAssigned = Math.min(USERS, totalCapacity);
  check(
    `[R${round}] 배정 행 수 = min(신청자, 정원)`,
    regs.length === expectedAssigned,
    `배정 ${regs.length}건 / 기대 ${expectedAssigned}건`,
  );

  const overCapacity = (teamsNow ?? []).filter((t) => t.taken > t.capacity);
  check(`[R${round}] taken ≤ capacity (모든 팀)`, overCapacity.length === 0, overCapacity.map((t) => t.name).join(", "));

  let dupSeq = 0;
  const byTeamSeq = new Map();
  for (const r of regs) {
    const key = r.team_id;
    const set = byTeamSeq.get(key) ?? new Set();
    if (set.has(r.seq)) dupSeq++;
    set.add(r.seq);
    byTeamSeq.set(key, set);
  }
  check(`[R${round}] 팀별 seq 중복 없음`, dupSeq === 0, `중복 ${dupSeq}건`);

  const byIdentity = new Map();
  for (const r of regs) {
    const key = `${r.name}::${r.student_no4}`;
    byIdentity.set(key, (byIdentity.get(key) ?? 0) + 1);
  }
  const doubleBooked = [...byIdentity.values()].filter((n) => n > 1).length;
  check(`[R${round}] 이중 배정 없음 (동일인 1건)`, doubleBooked === 0, `중복 신원 ${doubleBooked}건`);

  const okResults = applicantResults.filter((r) => r.lastRes?.ok);
  const okIds = okResults.map((r) => r.lastRes.registration_id);
  const okIdSet = new Set(okIds);
  const dbIdSet = new Set(regs.map((r) => r.id));
  const idsMatch =
    okIds.length === okIdSet.size &&
    okIdSet.size === dbIdSet.size &&
    [...okIdSet].every((id) => dbIdSet.has(id));
  check(
    `[R${round}] ok 응답과 DB 1:1`,
    idsMatch,
    `ok응답 ${okIds.length}건(고유 ${okIdSet.size}) / DB ${dbIdSet.size}건`,
  );

  const disconnectUsers = applicantResults.filter((r) => r.isDisconnect);
  let disconnectMismatch = 0;
  for (const r of disconnectUsers) {
    const dbRow = regs.find((x) => x.name === r.name && x.student_no4 === r.sno);
    if (!!r.lastRes?.ok !== !!dbRow) disconnectMismatch++;
  }
  check(
    `[R${round}] 네트워크 끊김 시뮬레이션 5명 최종 상태가 DB와 일치`,
    disconnectMismatch === 0,
    `대상 ${disconnectUsers.length}명, 불일치 ${disconnectMismatch}건`,
  );

  const totalUnexpected = applicantResults.reduce((a, r) => a + (r.unexpectedErrors ?? 0), 0);
  check(`[R${round}] 의도치 않은 rpc 오류 0건`, totalUnexpected === 0, `${totalUnexpected}건`);

  // ── 성능 (기록 + max>10s 만 FAIL) ──
  const allTimes = applicantResults.flatMap((r) => r.responseTimes);
  const p95 = percentile(allTimes, 0.95);
  const max = allTimes.length ? Math.max(...allTimes) : 0;
  note(`[R${round}] 응답시간`, `p95=${p95.toFixed(0)}ms · max=${max.toFixed(0)}ms · 전체 ${roundElapsedMs.toFixed(0)}ms`, p95 > 1000);
  check(`[R${round}] 응답시간 max ≤ 10s`, max <= 10_000, `max=${max.toFixed(0)}ms`);

  const lastRegAt = regs.length
    ? Math.max(...regs.map((r) => new Date(r.created_at).getTime()))
    : null;
  const openToFullMs =
    regs.length >= totalCapacity && lastRegAt ? lastRegAt - opensAtDate.getTime() : null;
  note(
    `[R${round}] 오픈~전석마감 시간`,
    openToFullMs !== null ? `${openToFullMs}ms` : "전석 마감되지 않음(신청자 < 정원)",
  );

  const detectDelays = boardStats
    .map((b) => (b.detectedFullAt && lastRegAt ? b.detectedFullAt - lastRegAt : null))
    .filter((v) => v !== null);
  if (detectDelays.length) {
    const maxDelay = Math.max(...detectDelays);
    note(
      `[R${round}] 현황판 마감 인지 지연`,
      `${detectDelays.map((d) => `${d}ms`).join(", ")}`,
      maxDelay > 5000,
    );
  } else {
    note(`[R${round}] 현황판 마감 인지 지연`, "전석 마감 미도달 또는 미감지");
  }

  // ── Realtime (기록 + WARN) ──
  const rtErrors =
    applicantResults.reduce((a, r) => a + (r.realtimeErrors ?? 0), 0) +
    boardStats.reduce((a, b) => a + b.errors, 0);
  const rtEvents =
    applicantResults.reduce((a, r) => a + (r.realtimeEvents ?? 0), 0) +
    boardStats.reduce((a, b) => a + b.events, 0);
  note(
    `[R${round}] Realtime`,
    `teams/registrations 이벤트 ${rtEvents}건 · 연결 오류 ${rtErrors}건`,
    rtErrors > 0,
  );

  await cleanupSimTeams();
}

// ── (선택) 배포 사이트 동시 GET ────────────────────────────────────────
async function runSiteCheck(siteUrl) {
  console.log(`\n▶ 배포 사이트 동시 GET 확인: ${siteUrl}`);
  for (const path of ["/", "/board"]) {
    const url = new URL(path, siteUrl).toString();
    const times = [];
    const statuses = {};
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        const t0 = performance.now();
        try {
          const res = await fetch(url, { signal: timeoutSignal(10_000) });
          times.push(performance.now() - t0);
          statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        } catch {
          statuses.error = (statuses.error ?? 0) + 1;
        }
      }),
    );
    note(
      `  ${path}`,
      `p95=${percentile(times, 0.95).toFixed(0)}ms · max=${(times.length ? Math.max(...times) : 0).toFixed(0)}ms · 상태코드=${JSON.stringify(statuses)}`,
    );
  }
}

// ── 실행 ─────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `Supabase: ${URL}\n신청자 ${USERS}명 · 현황판 ${BOARDS}명 · 팀당 정원 ${CAPACITY} · ${RUNS}회 반복 · 오픈까지 ${OPEN_IN}s\n`,
  );
  note(
    "Realtime 연결 수 안내",
    `이번 실행은 라운드당 최대 ${USERS + BOARDS}개의 동시 Realtime 연결을 만듭니다. Supabase 대시보드에서 프로젝트의 동시 연결 한도(Free 플랜)를 미리 확인하세요.`,
    true,
  );

  await guardRealTeams();
  const original = await saveSettings();

  try {
    for (let r = 1; r <= RUNS; r++) {
      await runOnce(r);
    }
  } catch (e) {
    check("실행 오류", false, String(e?.stack ?? e));
  } finally {
    await setSettings(original.opens_at, original.is_closed);
    await cleanupSimTeams();
  }

  if (SITE_URL) await runSiteCheck(SITE_URL);

  console.log(`\n${"─".repeat(60)}`);
  const passed = results.length - failed;
  console.log(`${passed}/${results.length} 통과 (정확성 항목 기준)`);

  if (failed > 0) {
    console.log("\n실패한 검증:");
    for (const r of results) {
      if (!r.pass) console.log(`  ✗ ${r.name} — ${r.detail}`);
    }
    console.log("\x1b[31m일부 검증에 실패했습니다.\x1b[0m");
    process.exitCode = 1;
  } else {
    console.log("\x1b[32m모든 정확성 검증을 통과했습니다.\x1b[0m");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
