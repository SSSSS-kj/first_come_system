#!/usr/bin/env node
/**
 * 동시성 부하 테스트 — 정원 초과가 절대 발생하지 않는지 검증한다.
 *
 *   node scripts/load-test.mjs [--n 100] [--capacity 10] [--rounds 1]
 *
 * 검증 항목
 *   T1  정원 10인 팀에 100건 동시 발사 → 성공 응답이 정확히 10건
 *   T2  registrations 행이 정확히 10개, teams.taken 이 정확히 10
 *   T3  나머지 90건이 모두 team_full 사유로 실패
 *   T4  발급된 순번이 1..10 중복 없음
 *   T5  같은 사람이 여러 팀에 동시 제출 → 정확히 1건만 성공
 *   T6  관리자가 취소한 자리가 다시 선착순 대상이 됨
 *   T7  오픈 시각 이전 요청은 서버가 거부
 *   T8  이미 신청한 사람이 같은 팀에 재신청 → team_full 대신 기존 배정 안내
 *
 * ⚠ 이 스크립트는 테스트용 팀과 신청 데이터를 생성/삭제하고
 *   settings.opens_at 을 일시적으로 바꾼다. 개발용 프로젝트에서 실행할 것.
 */

import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ── .env.local / .env 로드 (의존성 없이) ──────────────────────────────
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
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ── 인자 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};

const N = arg("n", 100);
const CAPACITY = arg("capacity", 10);
const ROUNDS = arg("rounds", 1);

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !ANON || !SERVICE) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.",
  );
  process.exit(1);
}

// 참가자가 실제로 쓰는 경로 그대로 검증한다 (anon 키 + RPC).
const anon = createClient(URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// 준비/정리 및 사실 확인은 service_role 로 한다.
const admin = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── 결과 집계 ────────────────────────────────────────────────────────
const results = [];
let failed = 0;

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failed += 1;
  const mark = pass ? "\x1b[32m PASS \x1b[0m" : "\x1b[31m FAIL \x1b[0m";
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
}

const TEAM_PREFIX = "__loadtest__";

// ── 준비 / 정리 ──────────────────────────────────────────────────────
async function cleanup() {
  const { data: teams } = await admin
    .from("teams")
    .select("id, name")
    .like("name", `${TEAM_PREFIX}%`);

  for (const t of teams ?? []) {
    await admin.from("registrations").delete().eq("team_id", t.id);
    await admin.from("teams").delete().eq("id", t.id);
  }
}

async function createTeam(suffix, capacity) {
  const name = `${TEAM_PREFIX}${suffix}`;
  const { data, error } = await admin
    .from("teams")
    .insert({ name, description: "load test", capacity, sort_order: 9000 })
    .select("id, name, capacity, taken")
    .single();
  if (error) throw new Error(`팀 생성 실패: ${error.message}`);
  return data;
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

/**
 * N 개의 요청을 배리어로 묶어 동시에 발사한다.
 * 각 요청은 release 프로미스가 resolve 될 때까지 대기하다가 함께 출발한다.
 */
async function fireConcurrently(makeRequest, count) {
  let release;
  const gate = new Promise((r) => (release = r));

  const tasks = Array.from({ length: count }, (_, i) =>
    (async () => {
      await gate;
      const t0 = performance.now();
      try {
        const value = await makeRequest(i);
        return { i, value, ms: performance.now() - t0 };
      } catch (e) {
        return { i, error: String(e), ms: performance.now() - t0 };
      }
    })(),
  );

  // 모든 태스크가 gate 앞에 도달할 시간을 준 뒤 동시에 놓는다.
  await new Promise((r) => setTimeout(r, 50));
  const startedAt = performance.now();
  release();

  const settled = await Promise.all(tasks);
  return { settled, elapsedMs: performance.now() - startedAt };
}

const register = (teamId, name, sno) =>
  anon
    .rpc("register_for_team", {
      p_team_id: teamId,
      p_name: name,
      p_student_no4: sno,
    })
    .then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return data;
    });

// ── T1~T4 : 마지막 한 자리 경쟁 ──────────────────────────────────────
async function testBurst(round) {
  const label = ROUNDS > 1 ? ` (round ${round})` : "";
  const team = await createTeam(`burst-${round}-${Date.now()}`, CAPACITY);
  console.log(
    `\n▶ 정원 ${CAPACITY}인 팀에 ${N}건 동시 신청${label}  team=${team.name}`,
  );

  const { settled, elapsedMs } = await fireConcurrently(
    (i) => register(team.id, `부하테스트${round}_${i}`, String(1000 + (i % 9000)).padStart(10, "0")),
    N,
  );

  const oks = settled.filter((r) => r.value?.ok === true);
  const fulls = settled.filter((r) => r.value?.status === "team_full");
  const others = settled.filter(
    (r) => r.value?.ok !== true && r.value?.status !== "team_full",
  );

  const p95 = [...settled.map((r) => r.ms)].sort((a, b) => a - b)[
    Math.floor(settled.length * 0.95)
  ];
  console.log(
    `  ${N}건 완료 ${elapsedMs.toFixed(0)}ms · p95 ${p95?.toFixed(0)}ms`,
  );

  check(
    `T1${label} 성공 응답이 정확히 ${CAPACITY}건`,
    oks.length === CAPACITY,
    `성공 ${oks.length}건`,
  );

  const { count: rowCount } = await admin
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("team_id", team.id)
    .eq("is_cancelled", false);

  check(
    `T2a${label} registrations 행이 정확히 ${CAPACITY}개`,
    rowCount === CAPACITY,
    `행 ${rowCount}개`,
  );

  const { data: after } = await admin
    .from("teams")
    .select("taken, capacity")
    .eq("id", team.id)
    .single();

  check(
    `T2b${label} teams.taken 이 정확히 ${CAPACITY}`,
    after?.taken === CAPACITY,
    `taken=${after?.taken} capacity=${after?.capacity}`,
  );

  check(
    `T3${label} 나머지 ${N - CAPACITY}건이 모두 team_full 로 실패`,
    fulls.length === N - CAPACITY && others.length === 0,
    `team_full ${fulls.length}건, 기타 ${others.length}건` +
      (others.length
        ? ` → ${JSON.stringify(others.slice(0, 3).map((o) => o.value?.status ?? o.error))}`
        : ""),
  );

  const { data: regs } = await admin
    .from("registrations")
    .select("seq")
    .eq("team_id", team.id)
    .eq("is_cancelled", false)
    .order("seq");

  const seqs = (regs ?? []).map((r) => r.seq);
  const expected = Array.from({ length: CAPACITY }, (_, i) => i + 1);
  check(
    `T4${label} 순번이 1..${CAPACITY} 로 중복 없이 발급됨`,
    JSON.stringify(seqs) === JSON.stringify(expected),
    `seq=[${seqs.join(",")}]`,
  );

  return team;
}

// ── T5 : 한 사람이 여러 팀에 동시 제출 ───────────────────────────────
async function testMultiTab() {
  console.log("\n▶ 같은 사람이 4개 팀에 동시 제출 (여러 탭 시나리오)");

  const teams = await Promise.all(
    [0, 1, 2, 3].map((i) => createTeam(`multitab-${i}-${Date.now()}`, 5)),
  );

  const name = `동시탭테스트_${Date.now()}`;
  const sno = "4242".padStart(10, "0");

  const { settled } = await fireConcurrently(
    (i) => register(teams[i % teams.length].id, name, sno),
    teams.length * 3, // 팀당 3개 탭
  );

  const oks = settled.filter((r) => r.value?.ok === true);
  const dups = settled.filter((r) => r.value?.status === "duplicate_name");

  check(
    "T5a 동일인 동시 제출 중 정확히 1건만 성공",
    oks.length === 1,
    `성공 ${oks.length}건, duplicate_name ${dups.length}건`,
  );

  // 좌석 반납이 제대로 되었는지: 모든 팀 taken 합이 1이어야 한다.
  const { data: rows } = await admin
    .from("teams")
    .select("taken")
    .in(
      "id",
      teams.map((t) => t.id),
    );
  const totalTaken = (rows ?? []).reduce((a, r) => a + r.taken, 0);

  check(
    "T5b 실패한 요청이 확보했던 좌석을 모두 반납 (taken 합 = 1)",
    totalTaken === 1,
    `taken 합 ${totalTaken}`,
  );

  return teams;
}

// ── T6 : 취소한 자리는 다시 선착순 대상 ──────────────────────────────
async function testCancelReopens(team) {
  console.log("\n▶ 관리자가 취소한 자리는 다시 선착순 대상이 되는지");

  const { data: victim } = await admin
    .from("registrations")
    .select("id, name, seq")
    .eq("team_id", team.id)
    .eq("is_cancelled", false)
    .order("seq")
    .limit(1)
    .single();

  const { data: cancelRes } = await admin.rpc("admin_cancel_registration", {
    p_registration_id: victim.id,
  });

  const { data: afterCancel } = await admin
    .from("teams")
    .select("taken")
    .eq("id", team.id)
    .single();

  check(
    "T6a 취소 후 taken 이 1 감소",
    cancelRes?.ok === true && afterCancel.taken === CAPACITY - 1,
    `taken=${afterCancel?.taken}`,
  );

  // 비워진 한 자리를 두고 20명이 다시 경쟁한다.
  const { settled } = await fireConcurrently(
    (i) => register(team.id, `재신청_${Date.now()}_${i}`, "7777".padStart(10, "0")),
    20,
  );
  const oks = settled.filter((r) => r.value?.ok === true);

  const { data: afterRefill } = await admin
    .from("teams")
    .select("taken")
    .eq("id", team.id)
    .single();

  check(
    "T6b 비워진 1자리를 20명이 경쟁 → 정확히 1명만 성공",
    oks.length === 1 && afterRefill.taken === CAPACITY,
    `성공 ${oks.length}건, taken=${afterRefill?.taken}`,
  );

  check(
    "T6c 재신청자의 순번은 재사용되지 않음",
    oks[0]?.value?.seq !== undefined && oks[0].value.seq > CAPACITY,
    `발급된 seq=${oks[0]?.value?.seq} (취소된 seq=${victim?.seq})`,
  );
}

// ── T7 : 오픈 시각 이전 요청 거부 ────────────────────────────────────
async function testNotOpen() {
  console.log("\n▶ 오픈 시각 이전 요청을 서버가 거부하는지");

  const team = await createTeam(`notopen-${Date.now()}`, 10);
  await setSettings(new Date(Date.now() + 3600_000).toISOString(), false);

  const res = await register(team.id, `오픈전_${Date.now()}`, "0001".padStart(10, "0"));
  check(
    "T7a 오픈 전 요청은 not_open 으로 거부",
    res?.ok === false && res.status === "not_open",
    `status=${res?.status}`,
  );

  await setSettings(new Date(Date.now() - 60_000).toISOString(), true);
  const res2 = await register(team.id, `마감후_${Date.now()}`, "0002".padStart(10, "0"));
  check(
    "T7b 즉시 마감 상태에서는 closed 로 거부",
    res2?.ok === false && res2.status === "closed",
    `status=${res2?.status}`,
  );

  const { count } = await admin
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("team_id", team.id);
  check("T7c 거부된 요청은 행을 만들지 않음", count === 0, `행 ${count}개`);
}

// ── T8 : 이미 신청한 사람의 재신청은 기존 배정을 그대로 돌려줌 ───────
async function testDuplicateRetry() {
  console.log("\n▶ 정원이 찬 뒤 같은 사람이 같은 팀에 재신청하는지 (team_full 아님)");

  const team = await createTeam(`duptry-${Date.now()}`, 1);
  const name = `재시도테스트_${Date.now()}`;
  const sno = "5555".padStart(10, "0");

  const first = await register(team.id, name, sno);
  check(
    "T8a 정원 1 팀에 첫 신청 성공",
    first?.ok === true,
    `status=${first?.status}`,
  );

  const retry = await register(team.id, name, sno);
  check(
    "T8b 같은 사람이 같은 팀에 재신청 → duplicate_name",
    retry?.ok === false && retry.status === "duplicate_name",
    `status=${retry?.status}`,
  );
  check(
    "T8c existing.team_id 가 기존 배정과 일치",
    retry?.existing?.team_id === team.id,
    `existing=${JSON.stringify(retry?.existing)}`,
  );

  const { data: after } = await admin
    .from("teams")
    .select("taken")
    .eq("id", team.id)
    .single();
  check(
    "T8d 재신청으로 taken 이 늘지 않고 1로 유지",
    after?.taken === 1,
    `taken=${after?.taken}`,
  );
}

// ── 실행 ─────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `Supabase: ${URL}\n동시 요청: ${N}건 · 정원: ${CAPACITY} · 라운드: ${ROUNDS}\n`,
  );

  const original = await saveSettings();
  let lastTeam = null;

  try {
    await cleanup();
    // 오픈 상태로 만들어 두고 시작한다.
    await setSettings(new Date(Date.now() - 60_000).toISOString(), false);

    for (let r = 1; r <= ROUNDS; r++) {
      lastTeam = await testBurst(r);
    }
    await testMultiTab();
    await testCancelReopens(lastTeam);
    await testNotOpen();
    // testNotOpen 의 T7b 가 is_closed=true 로 바꿔둔 채 끝나므로 되돌린다.
    await setSettings(new Date(Date.now() - 60_000).toISOString(), false);
    await testDuplicateRetry();
  } catch (e) {
    check("실행 오류", false, String(e));
  } finally {
    await setSettings(original.opens_at, original.is_closed);
    await cleanup();
  }

  console.log("\n" + "─".repeat(60));
  const passed = results.length - failed;
  console.log(`${passed}/${results.length} 통과`);

  if (failed > 0) {
    console.log("\n실패한 검증:");
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  ✗ ${r.name} — ${r.detail}`);
    }
    console.log(
      "\n\x1b[31m정원 초과 방지 검증에 실패했습니다. 구현을 완료로 간주하지 마세요.\x1b[0m",
    );
    process.exit(1);
  }

  console.log("\n\x1b[32m모든 동시성 검증을 통과했습니다.\x1b[0m");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
