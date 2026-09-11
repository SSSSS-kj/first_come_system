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

## V2. 기존 동시성 테스트 — 미실행

## V3. 실제 행사 시뮬레이션 — 미실행 (`scripts/event-sim.mjs` 아직 미작성)

## V4. 브라우저 E2E — 미실행

## V5. 최종 보고서 — 미작성
