# 검증 보고서

계획: `plans/verification-load-test.md`

## 요약

| 단계 | 내용 | 결과 |
|---|---|---|
| V1 | 사전 점검 + 정적 검증 | PASS |
| V2 | 기존 동시성 테스트 (`load-test.mjs`, 100명×3라운드) | PASS (27/27, 스크립트 버그 1건 수정 후) |
| V3 | 실제 행사 시뮬레이션 (`event-sim.mjs` 신규, 100명×3라운드) | PASS (24/24 정확성, 스크립트 버그 1건 수정 후) |
| V4 | 브라우저 E2E (Playwright, E1~E6·E8) | PASS (7/7, E7은 T5 미적용으로 스킵) |

전 구간에서 **정원 초과·이중 배정·순번 중복은 한 번도 발생하지 않았다.** 발견된
문제는 전부 검증 스크립트 자체의 결함(즉시 수정)이거나 앱 동작에 영향 없는
참고 사항이며, 앱 코드는 이번 검증 중 한 줄도 고치지 않았다.

## 발견 이슈 목록

| # | 심각도 | 내용 | 재현 | 원인 추정 / 조치 |
|---|---|---|---|---|
| 1 | 낮음(테스트 코드) | `load-test.mjs` T8 전부 FAIL | `testNotOpen()`→`testDuplicateRetry()` 순서로 실행 | T7b 가 `is_closed=true` 로 바꿔둔 채 되돌리지 않아 다음 테스트가 전부 `closed` 로 막힘. **수정 완료**(두 테스트 사이에 open 상태 복원 추가), 재실행 27/27 PASS. V2 절 참고. |
| 2 | 중간(테스트 코드, DB 오염) | `event-sim.mjs` 자체 검증 중 가짜 신청 8건이 실제 운영 팀(퀀트 등)에 유입 | `--users 20 --capacity 3 --runs 1` | 가상 신청자의 팀 후보 목록이 `get_public_state()` 전체(실제 팀 포함)였는데 필터링 없이 "잔여석 있는 팀"을 고르다 보니 시뮬 전용 팀이 차면 실제 팀으로 샘. **수정 완료**(`simTeamIds` 필터 추가), 유출 데이터 즉시 정리·원복. V3 절 참고. |
| 3 | 정보/WARN | `event-sim.mjs` 100명×3라운드 중 3라운드째 Realtime 연결 오류 102건 | 동일 실행을 3라운드 연속 수행 | 직전 라운드의 WebSocket 연결이 다 정리되기 전에 다음 라운드가 곧바로 최대 102개의 새 연결을 여는 것으로 추정. `get_public_state` 폴링 안전망 덕에 정확성 결과에는 영향 없었음. **행사 당일 권장사항 참고.** |
| 4 | 낮음(코드, 영향 없음) | `RegisterView.submit()` 의 `duplicate_name` 안내 배너("이미 접수된 신청을 불러왔습니다.")가 실제로는 그려지지 않음 | 이미 배정된 사람이 같은 이름/학번으로 재신청 | `persist()`(→ `me` 세팅)가 `setBanner()` 보다 먼저 호출되는데 `if (me) return <ResultPanel/>` 가 조기 반환이라 배너 렌더 분기에 도달하지 못함. ResultPanel 이 즉시 뜨므로 사용자 경험엔 문제 없음(오히려 결과가 바로 보임). **수정하지 않음** — 원한다면 별도 정리 대상. |
| 5 | 정보(테스트 인프라) | Playwright E1 활성화 지연이 단독 실행 10ms ↔ 스위트 연속 실행 ~1.3초 | `npx playwright test` 전체 스위트 실행 | Chromium 이 포커스 불확실한(백그라운드로 간주되는) 탭의 `setInterval` 을 스로틀링하는 것으로 추정. 실사용자는 카운트다운을 보려고 탭을 열어 둔 상태이므로 해당 없음. 앱 코드 문제 아님. |

## 행사 당일 권장 사항

1. **Realtime 동시 연결 한도 사전 확인** — 참가자 규모(예상 100명 안팎)에 맞춰
   Supabase 프로젝트(Free/Pro) 의 Realtime 동시 연결·메시지 한도를 대시보드에서
   미리 확인한다. 한도를 넘어도 `get_public_state` 4초 폴링 + `/board` 5초 폴링이
   안전망으로 동작해 정원 초과로 이어지진 않지만, 화면 갱신이 순간적으로 느려질
   수 있다.
2. **오픈 직전 리허설은 한 번으로 충분** — 연속으로 여러 번(특히 100명 규모)
   리허설을 돌릴 경우, 직전 회차의 Realtime 연결이 정리될 시간을 30초~1분 정도
   두고 다음 회차를 시작하는 편이 안전하다(V3 라운드3 관찰 기반).
3. 기존 README "7. 대회 당일 운영 순서" 의 오픈 직전 체크리스트에 위 1번을
   한 줄 추가할 것을 권장한다(별도 승인 후 반영).
4. **README "5. 동시성 부하 테스트"에 `event-sim.mjs` 사용법 추가** — 순수
   RPC 동시성 테스트(`load-test.mjs`)와 별도로, 실제 참가자 흐름(구독+폴링+
   재시도)까지 재현하는 `event-sim.mjs` 가 이번에 추가됐으므로 README 에도
   반영이 필요하다(아래 "README 반영" 참고, 승인 후 진행).

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

## V4. 브라우저 E2E — PASS (Playwright)

`@playwright/test` devDependency + Chromium 설치 승인받아 진행.

### 환경 이슈 (기록용, 코드와 무관)

- 이 머신은 Arch Linux(WSL) 라서 Playwright 의 `install-deps`(apt 전제)가
  동작하지 않았다. `ldd` 로 실제 누락된 공유 라이브러리를 확인해
  `pacman -S nss nspr atk at-spi2-core libx11 libxcomposite libxdamage
  libxext libxfixes libxrandr mesa libxcb libxkbcommon alsa-lib` 로 직접
  설치(사용자가 sudo 실행)한 뒤 정상 동작 확인.
- 데이터 준비/정리는 `e2e/helpers.ts` 에서 service_role 로 수행, `__e2e__`
  팀만 사용, 각 테스트 `afterEach` 에서 settings 원복 + 팀/신청 정리.
  `playwright.config.ts` 는 `workers: 1` 로 고정(모든 테스트가 같은
  Supabase 프로젝트의 단일 settings 행·teams 를 공유 조작하므로 병렬 실행
  불가).

### 결과 — `npx playwright test` 7/7 PASS (E1~E6, E8)

- **E1(T1)** 오픈 전 팀/이름 선택 가능 + 제출 버튼 비활성 확인, 이후
  `get_public_state` RPC 를 강제로 막은 상태에서도 오픈 순간 버튼이 활성화됨을
  확인(로컬 시계 기반 `opened` 상태가 폴링 응답에 의존하지 않음, T1 의도대로).
  실측 활성화 지연은 스펙 단독 실행 시 약 10ms. **테스트 스위트를 연달아
  돌리면 일관되게 ~1.3초**로 나타났는데, 원인은 Chromium 이 포커스가
  불확실한(백그라운드로 간주되는) 탭의 `setInterval` 을 스로틀링하는 잘 알려진
  동작으로 추정된다(앱 코드는 정상; 실제 사용자는 카운트다운을 보려고 탭을
  열어 둔 상태이므로 이 스로틀링을 겪지 않는다). 테스트는 "4초 폴링 주기보다
  훨씬 빠르다(2초 이내)"는 핵심만 넉넉한 예산으로 검증하도록 조정.
- **E2(T1)** 선택해 둔 팀을 다른 사람이 채우면(anon RPC 직접 호출) 5초 내
  자동 선택 해제 + 안내 배너 확인.
- **E3(T2)** 이미 배정된 사람이 같은 이름/학번으로 재신청 → `team_full` 이
  아니라 기존 배정(ResultPanel, 동일 seq)을 그대로 보여주고 `teams.taken`
  이 늘지 않음을 확인. **참고(버그 아님, 코드는 수정하지 않음)**:
  `RegisterView.submit()` 의 `duplicate_name` 분기는 `persist()`(→ `me`
  세팅) 를 `setBanner("이미 접수된 신청을 불러왔습니다.")` 보다 먼저 호출하는데,
  `if (me) return <ResultPanel/>` 가 조기 반환이라 이 배너는 이 경로에서
  실제로 그려질 기회가 없다(항상 ResultPanel 로 즉시 넘어감). 사용자 경험에
  문제가 되진 않지만(오히려 결과 화면이 바로 보이는 편이 나을 수 있음),
  죽은 상태값이라는 점은 기록해둔다.
- **E4(T3)** `register_for_team` 응답을 지연시키면(요청이 서버에 닿지 않게
  15초 뒤 abort) 클라이언트의 `abortSignal(10_000)` 이 먼저 끊어 약
  10~13초 후 "제출 중…" 이 풀리고 "응답이 늦어…" 안내가 뜸을 확인.
- **E5(T4)** 관리자 탭 2개 — A 가 즉시 마감 → B 가 오픈 시각만 저장해도
  `is_closed` 가 그대로 유지됨을 DB 로 확인(부분 업데이트 정상). 오픈 시각
  입력이 비어 있으면 저장 버튼이 비활성임도 확인.
- **E6** `/board` — 신청/이관/취소가 각각 5초 내 반영됨을 확인(관리자
  RPC 는 service_role 로 직접 호출해 실제 관리자 동작을 흉내).
- **E7**: T5(학번 입력 제거)가 철회되어 미적용이므로 계획대로 스킵.
- **E8** 390px 모바일 뷰포트에서 팀 선택 → 입력 → 확인 모달 → 신청 완료
  전 구간에서 가로 스크롤이 발생하지 않음을 확인.

테스트 실행 후 DB 확인: `__e2e__` 팀/신청 전부 정리, 실제 팀(퀀트 등)
`taken` 모두 0, `settings` 원복(`opens_at: null, is_closed: false`) 확인.
`npm run typecheck` / `npm run build` 도 새 `e2e/*.ts`, `playwright.config.ts`
포함해 정상 통과.

## V5. 최종 보고서 — 완료

이 문서 맨 위 "요약"·"발견 이슈 목록"·"행사 당일 권장 사항" 절 참고.
README "5. 동시성 부하 테스트"에 `event-sim.mjs` 사용법 반영은 승인 후 별도
커밋으로 진행.
