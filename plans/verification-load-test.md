# 선착순 시스템 전체 동작 검증 + 부하 테스트 계획

코드 수정이 목적이 아니다. 기준 부하는 동시 접속 100명 이내.
`plans/done/registration-ux-fixes.md` 의 T1~T4(+T6, 학번 10자리)가 반영된
상태를 검증한다. T5(학번 입력 제거)는 철회되어 미적용 — `student_no4` 가
`supabase/schema.sql` 에 남아 있으므로 모든 시나리오의 RPC 호출은
`p_student_no4` 인자를 포함해야 한다.

한 세션에 태스크 하나만 진행. 결과는 `docs/verification-report.md` 해당
섹션에 기록하고, 완료 시 체크박스를 갱신해 태스크별로 커밋 분리.
전부 끝나면 이 파일을 `plans/done/` 으로 이동.

발견한 버그는 고치지 않는다 — `docs/verification-report.md` 에 재현 방법·
원인 추정만 기록한다(수정은 별도 계획).

## 태스크

- [x] V1. 사전 점검 + 정적 검증
  - git status 클린 여부, `plans/done/registration-ux-fixes.md` 의 적용 태스크
    전부 체크됐는지 확인.
  - `npm ci` → `npm run typecheck` → `npm run build`.
  - 정합성: schema.sql 함수 시그니처 ↔ revoke/grant 줄 ↔ reset.sql drop 줄 ↔
    클라이언트·API route·load-test 의 rpc 호출 인자가 서로 일치하는지.
    T5 미적용이므로 `student_no4` 잔존을 전제로 확인.
  - 개발용 Supabase 에 최신 schema.sql 이 반영됐는지, 신청 데이터를 만들지 않고
    확인: anon 으로 `get_public_state` 호출 / `register_for_team` 을 존재하지
    않는 team_id 로 호출해 `team_not_found` 가 오는지(시그니처가 다르면
    PGRST202 류 오류) / service_role 로 `admin_update_settings` 새 4-인자
    시그니처 호출 시 현재 값을 그대로 다시 써서 설정이 바뀌지 않게 할 것.

- [ ] V2. 기존 동시성 테스트
  - `npm run load-test -- --n 100 --capacity 10 --rounds 3` 실행. T1~T8 전
    항목 결과와 p95 를 기록.
  - 하나라도 FAIL 이면 여기서 멈추고 출력 원문을 보고한다.

- [ ] V3. 실제 행사 시뮬레이션 (`scripts/event-sim.mjs` 신규)
  - 목적: 100명이 페이지를 열어 둔 채 오픈을 기다리다 동시에 신청하는 상황을
    앱과 같은 경로(anon 키 + RPC + Realtime + 폴링)로 재현한다.
  - 준비·안전: `__` 로 시작하지 않는 실제 팀에 취소 안 된 신청이 있으면
    `--force` 없이는 실행 거부. `__sim__A~D` 4개 팀(기본 정원 10, 총 40석)
    생성, settings 저장 후 종료 시 원복, 테스트 팀·신청 정리(audit_log 는
    append-only 라 남는 것이 정상).
  - 옵션: `--users 100 --boards 2 --capacity 10 --runs 3 --open-in 20`
  - 가상 사용자: 신청자 N명(useContest.ts 와 동일하게 구독+폴링+시계 보정),
    현황판 B명(구독+5초 폴링). 오픈 감지 후 150~1200ms 반응 지연, 가중치
    40/25/20/15% 로 선호 팀 신청. team_full 이면 최신 상태에서 잔여석 있는
    팀으로 200~600ms 뒤 재시도(최대 4회). 5명은 네트워크 끊김(50ms abort →
    lookup_registration → 재시도) 흉내.
  - 판정: 정확성(FAIL 기준 — 배정 행 수=min(N,정원), taken≤capacity, seq
    중복 없음, 이중 배정 없음, ok 응답과 DB 1:1, abort 5명도 최종 일치,
    의도치 않은 rpc 오류/5xx 0건), 성능(기록, p95>1000ms WARN, max>10s FAIL,
    오픈~전석마감 시간, 마감 인지 지연 WARN>5s), Realtime(기록, WARN —
    구독 상태 변화, teams 이벤트 수, 연결 오류. Supabase Free 플랜 한도는
    실행 전 확인).
  - 먼저 `--users 10 --runs 1` 로 스크립트 자체 검증 후 본 실행(100명×3회).
  - (선택) 배포 URL 제공 시 `--site-url` 로 `/`, `/board` 100건 동시 GET
    상태코드·p95 기록.

- [ ] V4. 브라우저 E2E (Playwright)
  - `@playwright/test` devDependency·브라우저 설치는 승인 후 진행. 거절 시
    수동 체크리스트로 `docs/verification-report.md` 에 작성.
  - 데이터 준비·정리는 테스트 코드에서 service_role 로, `__e2e__` 팀만 사용.
    settings 원복.
  - E1(T1) 오픈 20초 전 팀·이름 선택 가능/버튼 비활성 → get_public_state
    차단 → 카운트다운 0 후 1초 내 버튼 활성화.
  - E2(T1) 선택한 팀이 타인 신청으로 마감되면 선택 해제.
  - E3(T2) 이미 배정된 사람이 마감된 같은 팀에 재신청 → 기존 배정 결과 표시.
  - E4(T3) register_for_team 15초 지연 → 약 10초 후 제출 중 해제.
  - E5(T4) 관리자 탭 2개: A 즉시 마감 → B 에서 오픈 시각만 저장 →
    is_closed 유지. 오픈 시각 빈칸이면 저장 버튼 비활성.
  - E6 /board: 신청/취소/이관 5초 내 반영.
  - E7 (T5 적용 시에만 — 현재 미적용이라 스킵)
  - E8 390px 모바일 뷰포트 신청 흐름, 가로 스크롤 없음.

- [ ] V5. 최종 보고서
  - `docs/verification-report.md` 맨 위에 요약표, 발견 이슈 목록(심각도·재현·
    원인 추정), 행사 당일 권장 사항(Realtime 한도 대응, README 운영 순서
    변경점) 정리.
  - 승인 후 README "5. 동시성 부하 테스트" 에 event-sim 사용법 3~5줄 추가.
