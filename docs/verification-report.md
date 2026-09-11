# 검증 보고서

계획: `plans/verification-load-test.md`

## V1. 사전 점검 + 정적 검증 — PASS

- git status: 클린.
- `plans/done/registration-ux-fixes.md`: T1~T6 전부 `[x]`.
- `npm ci` / `npm run typecheck` / `npm run build`: 전부 통과.
- 정합성 대조 (schema.sql ↔ revoke/grant ↔ reset.sql ↔ 클라이언트/API route/load-test):
  - `register_for_team(uuid,text,text)` — `p_team_id, p_name, p_student_no4` 로
    schema.sql 정의, revoke/grant, reset.sql drop, `RegisterView.tsx`,
    `scripts/load-test.mjs` 전부 일치. T5 미적용 상태와 부합 (`student_no4` 잔존).
  - `lookup_registration(text,text)` — `p_name, p_student_no4` 동일하게 일치.
  - `admin_update_settings(timestamptz,boolean,boolean,boolean)` 4-인자
    부분 업데이트 시그니처 — schema.sql, revoke/grant, reset.sql,
    `src/app/api/admin/settings/route.ts` 전부 일치.
- 개발 Supabase 런타임 확인 (`https://mqxjhmkqfuvwxbufvjor.supabase.co`):
  - 최초 확인 시 `schema.sql` 미반영 상태였음(테이블·함수 전부 `PGRST202`/`PGRST205`).
    사용자가 Supabase SQL Editor 에서 `schema.sql` 을 실행한 뒤 재확인 → 통과.
  - anon `get_public_state()` → 정상 응답 (`teams: []`, `opens_at: null`,
    `is_closed: false`). `seed.sql` 은 아직 실행되지 않아 teams 테이블이 빈
    상태 — V2(load-test) 는 자체적으로 `__loadtest__` 팀을 생성/정리하므로
    영향 없음. V3(event-sim) 준비 단계에서는 참고 필요.
  - anon `register_for_team()` 존재하지 않는 team_id 로 호출 → `PGRST202` 없이
    정상 실행되어 `{ ok: false, status: "not_open" }` 반환(오픈 시각이 설정되지
    않아 team 조회 전에 open 체크에서 걸림). 시그니처 자체는 정상 — 함수를
    찾지 못하는 오류(PGRST202)가 아님을 확인.
  - service_role `admin_update_settings()` 4-인자 no-op 호출(`p_set_opens_at:
    false, p_set_is_closed: false`) → 정상 응답, 호출 전후 `get_public_state()`
    의 `opens_at`/`is_closed` 값 변화 없음(둘 다 `null`/`false` 유지).

### 참고 (버그 아님)
- 개발 Supabase 에 `seed.sql` 이 아직 반영되지 않아 `teams`/`settings` 초기
  데이터가 없다. V2 는 자체 생성 팀으로 동작하므로 무관하지만, V3(event-sim)
  실행 전에는 `__sim__A~D` 팀 생성 로직이 기존 teams 유무에 의존하지 않는지
  스크립트 작성 시 확인 필요.

## V2. 기존 동시성 테스트 — PASS (재실행)

`scripts/load-test.mjs`의 `testNotOpen()` → `testDuplicateRetry()` 사이에
`setSettings(new Date(Date.now() - 60_000).toISOString(), false)` 를 추가해
`is_closed`를 open 상태로 되돌린 뒤 재실행 → **27/27 통과**.

- round1 p95 705ms / round2 p95 480ms / round3 p95 486ms.
- T8a~T8d 전부 PASS (`status=ok` → `duplicate_name`, `existing` 일치, `taken=1` 유지).

### 최초 실행 결과 (수정 전, 참고용) — FAIL (T8, 테스트 스크립트 결함으로 판단)

`npm run load-test -- --n 100 --capacity 10 --rounds 3` 실행 결과: **23/27 통과**.

- T1~T7 (round 1~3 포함): 전부 PASS.
  - burst 100건 → 성공 정확히 10건, p95: round1 1157ms / round2 541ms / round3 491ms.
  - T5(멀티탭 동일인 동시제출), T6(취소 후 재오픈, seq 재사용 안 됨), T7(오픈전/즉시마감 거부) 전부 PASS.
- **T8a~T8d FAIL** — 전부 `status=closed`:
  ```
  ✗ T8a 정원 1 팀에 첫 신청 성공 — status=closed
  ✗ T8b 같은 사람이 같은 팀에 재신청 → duplicate_name — status=closed
  ✗ T8c existing.team_id 가 기존 배정과 일치 — existing=undefined
  ✗ T8d 재신청으로 taken 이 늘지 않고 1로 유지 — taken=0
  ```

### 원인 추정 — 앱 버그가 아니라 `scripts/load-test.mjs`의 테스트 간 상태 오염

`main()`에서 `testNotOpen()`(T7) 다음에 곧바로 `testDuplicateRetry()`(T8)를 호출한다
(`scripts/load-test.mjs:441` 부근). `testNotOpen()`의 T7b 서브테스트가
`setSettings(..., true)`로 `settings.is_closed`를 `true`로 바꿔두고, T7 함수 안에서는
이를 되돌리지 않는다. `settings.is_closed`가 `original` 값으로 복원되는 지점은
`main()`의 `finally` 블록(모든 테스트가 끝난 뒤) 뿐이다. 따라서 T8이 실행되는
시점에는 여전히 `is_closed=true`이고, `register_for_team()`은 `is_closed`를
duplicate-check보다 먼저 검사하므로(`supabase/schema.sql` 199~206행) 모든 호출이
`status=closed`로 즉시 거부된다.

실제 앱의 "이미 신청한 사람이 재신청하면 team_full 대신 기존 배정 안내"
기능(`registration-ux-fixes.md` T2)은 `is_closed=false`인 정상 운영 상태를
전제로 하므로 이번 결과로 회귀가 있다고 볼 근거는 없다. 다만 T8은 유효한 조건에서
**한 번도 검증되지 못했다** — 재현하려면 `testNotOpen()`과 `testDuplicateRetry()`
사이에 `await setSettings(new Date(Date.now() - 60_000).toISOString(), false);`
를 넣거나, T8을 T7보다 먼저 실행하면 된다.

수정은 이번 검증 범위 밖(별도 계획)이라 적용하지 않음. → 계획 지시("하나라도 FAIL이면
여기서 멈추고 출력 원문을 보고한다")에 따라 V2 체크박스는 미완료로 남기고 보고함.


## V3. 실제 행사 시뮬레이션 — PASS (`scripts/event-sim.mjs` 신규 작성)

`useContest.ts`(구독+폴링+시계보정)·`RegisterView.tsx`(반응 지연, team_full
재시도, 네트워크 끊김 복구)·`BoardView.tsx`(구독+5초 폴링)와 동일한 경로로
가상 사용자를 구현했다. `npm run event-sim -- [옵션]`으로 실행.

### 자체 검증 중 발견한 스크립트 버그 (실행 전에 수정, 앱 버그 아님)

최초 구현에서 `--users 20 --capacity 3 --runs 1` 로 경쟁 상황을 자체 검증하니
`ok 응답과 DB 1:1` 등 2개 항목이 FAIL 했다(ok 응답 20건 vs sim 팀 DB 12건).
원인: 가상 신청자의 로컬 상태(`ctx.teams`)를 앱과 동일하게
`get_public_state()` 전체 응답(실제 운영 팀 포함)으로 채웠는데,
`pickTargetTeam()`이 이 전체 목록에서 "잔여석 있는 팀"을 고르다 보니 시뮬
전용 팀(`__sim__A~D`)이 다 차면 **실제 운영 팀(퀀트/거시분석/차트분석/
안전자산)에 가짜 신청 8건이 새어 들어갔다.** 즉시 해당 8건을 삭제하고
영향받은 실제 팀들의 `taken`을 원복했다(seed 직후라 원래 0이었으므로 전부
0으로 복구, 실사용자 데이터 없었음 확인).
수정: `pickTargetTeam()`에 `simTeamIds` 필터를 추가해 후보를 항상
이번 시뮬레이션의 4개 팀으로만 한정하도록 고쳤다(`scripts/event-sim.mjs`
303~310행 부근). 이후 동일 시나리오 재실행 시 ok 응답 12건 = DB 12건으로
일치, 실제 팀 유출 없음을 재확인.

### 본 실행 — `--users 100 --boards 2 --capacity 10 --runs 3 --open-in 20`

**24/24 통과** (정확성 항목 기준, 3라운드 × 8항목).

- 라운드별 배정: 40건(=min(100,40)) 정확히 일치, taken≤capacity, seq 중복
  없음, 이중 배정 없음, ok 응답과 DB 1:1, 네트워크 끊김 5명 최종 상태 DB와
  일치, 의도치 않은 rpc 오류 0건 — 전부 3라운드 모두 PASS.
- 성능(기록): p95 175~423ms, max 426~505ms(전부 10s 이내), 오픈~전석마감
  976~1655ms, 현황판 마감 인지 지연 1158~1641ms(WARN 기준 5s 이내).
- Realtime(기록): 라운드1 이벤트 2490건/오류 0건, 라운드2 이벤트 2985건/
  오류 0건, **라운드3 이벤트 2586건/연결 오류 102건(WARN)** — 102는 이번
  실행의 최대 동시 연결 수(신청자 100 + 현황판 2)와 정확히 일치한다.
  round 1→2→3 로 이어지며 직전 라운드의 WebSocket 연결이 완전히 정리되기
  전에 다음 라운드가 곧바로 새 연결을 여는 것으로 보이며, 3라운드째에
  Supabase 쪽에서 일시적으로 채널 오류/타임아웃을 낸 것으로 추정된다.
  **다만 정확성 결과는 라운드3도 전부 PASS** — `get_public_state()` 폴링
  안전망(4초/5초 주기)이 의도대로 작동해 Realtime 이 흔들려도 최종 신청
  결과에는 영향이 없었다. 행사 당일 참고사항으로 V5에 기록 예정
  (연속 라운드 사이에 연결 정리 시간을 좀 더 두거나, Free 플랜 동시 연결
  한도를 사전에 확인할 것).
- 실행 후 `__sim__` 팀·신청 데이터 정리 확인, 실제 팀(퀀트 등) taken 모두
  0으로 원복 확인. `audit_log` 는 append-only 라 시뮬레이션이 남긴 행을
  그대로 둠(정상).
- (선택) `--site-url` 배포 URL 확인은 스킵 — 아직 배포 URL 없음.

## V4. 브라우저 E2E — 미실행

## V5. 최종 보고서 — 미작성
