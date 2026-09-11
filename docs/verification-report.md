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

## V2. 기존 동시성 테스트 — FAIL (T8, 테스트 스크립트 결함으로 판단)

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


## V3. 실제 행사 시뮬레이션 — 미실행 (`scripts/event-sim.mjs` 아직 미작성)

## V4. 브라우저 E2E — 미실행

## V5. 최종 보고서 — 미작성
