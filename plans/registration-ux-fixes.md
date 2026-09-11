# 선착순 신청 UX·운영 버그 수정 계획

한 세션에 태스크 하나만 진행. 완료 시 체크박스를 갱신하고 태스크별로 커밋 분리.
전부 끝나면 이 파일을 plans/done/ 으로 이동.

## 태스크

- [x] T1. 오픈 순간 즉시 잠금 해제 + 오픈 전 팀 미리 선택
  - 문제: `src/components/RegisterView.tsx` 90~92행의 `serverNow`/`beforeOpen`/`canSubmit`은
    `RegisterView`가 렌더될 때만 계산된다. `Countdown`의 `setRemaining`은 `Countdown`만
    리렌더하므로, 오픈 시각이 지나도 `onOpen` → `refresh()`의 `get_public_state` 응답이
    와야 버튼이 풀린다. 네트워크가 느린 사람일수록 늦게 출발한다.
  - 수정:
    - `RegisterView`에 `opened` 상태를 두고, `opensAt`·`clockOffsetMs`가 바뀔 때마다
      서버 보정 시각 기준으로 오픈 시각이 되면 `true`로 바뀌게 한다(짧은 interval로
      재확인). `opensAt`이 null이거나 미래로 바뀌면 `false`.
      `canSubmit = opened && !isClosed`. 오픈 순간 `refresh()` 호출은 유지하되
      잠금 해제가 그 응답에 의존하지 않게 한다.
    - 오픈 전에도 `TeamCard`를 눌러 팀을 미리 고를 수 있게 한다(마감 상태이거나
      정원이 찬 팀은 계속 비활성). 신청 버튼만 오픈 전 비활성 유지.
    - 선택해 둔 팀이 실시간 갱신으로 정원이 차면 선택을 해제한다.
  - 완료 보고: 수동 확인 시나리오 포함 — 오픈 1분 뒤로 설정 → 팀·이름 미리 입력 →
    카운트다운 0 순간 응답을 기다리지 않고 버튼 활성화.

- [x] T2. 이미 신청한 사람이 재신청하면 team_full 대신 기존 배정 안내
  - 문제: `supabase/schema.sql`의 `register_for_team`은 좌석 UPDATE(215행)를 INSERT보다
    먼저 한다. 이미 A팀에 배정된 사람이 A팀이 꽉 찬 뒤 A팀에 재시도하면 duplicate_name이
    아니라 team_full이 나가 "방금 마감, 다른 팀 선택"이 뜬다. 또 unique_violation
    핸들러의 기존 신청 조회(254행)는 `name_key = lower(v_name)`으로 비교해 생성
    컬럼식(39행)과 달라 existing이 null로 빠지는 경우가 있다.
  - 수정:
    - 오픈/마감 검증 뒤, 좌석 확보 전에 (name_key, student_no4)로 취소 안 된 기존
      신청을 조회해 있으면 기존 duplicate_name 응답 형태(existing 포함)와 audit
      기록으로 즉시 반환한다. UNIQUE 인덱스와 기존 예외 핸들러는 동시 제출 대비로
      그대로 둔다.
    - 이름 키 비교식을 생성 컬럼과 똑같이 맞춘다(사전 조회·예외 핸들러·
      lookup_registration 세 곳).
    - `RegisterView`의 duplicate_name + existing 처리 흐름이 그대로 동작하는지
      확인만 한다.
    - load-test에 새 검증 T8 추가: 정원 1 팀에 A 신청 성공 → 같은 A가 같은 팀에
      재신청 → status=duplicate_name, existing.team_id 일치, taken=1 유지.
  - schema.sql 변경 태스크 → 완료 보고에 "Supabase SQL Editor에서 schema.sql 재실행 필요" 명시.

- [ ] T3. 제출 응답 타임아웃
  - 문제: `RegisterView`의 register_for_team / lookup_registration 호출에 타임아웃이
    없어 모바일에서 연결이 멈추면 "제출 중…"이 끝나지 않는다.
  - 수정:
    - supabase-js 쿼리의 `.abortSignal()`로 신청 10초, 조회 5초 타임아웃을 건다
      (`AbortSignal.timeout` 미지원 시 `AbortController` + `setTimeout` 폴백).
    - 타임아웃/네트워크 오류 시 기존 `recoverAfterNetworkError()`로 넘어간다.
      조회로도 확인 못 하면 "응답이 늦어 신청 여부를 확인하지 못했어요. 다시
      눌러주세요" 안내. 서버에서 뒤늦게 성공한 경우엔 재시도가 T2의 duplicate_name
      경로로 기존 배정을 보여주므로 추가 처리 불필요.
    - 어떤 경로로 끝나든 submitting이 해제되어야 한다.

- [ ] T4. 관리자 설정 부분 업데이트
  - 문제: `src/components/AdminView.tsx` 275~279행(오픈 시각 저장)과 297~300행(즉시
    마감 토글)이 opens_at·is_closed를 최대 4초 전 폴링 상태로 둘 다 보내고,
    `src/app/api/admin/settings/route.ts`는 빠진 값을 null/false로 채우며,
    `admin_update_settings` RPC는 두 컬럼을 모두 덮어쓴다. 운영진 둘이 동시에 쓰면
    마감이 풀리거나 오픈 시각이 지워진다. 오픈 시각 입력이 비어 있으면 저장 시
    조용히 null이 된다.
  - 수정:
    - RPC를 `admin_update_settings(p_opens_at timestamptz, p_is_closed boolean,
      p_set_opens_at boolean, p_set_is_closed boolean)`로 바꿔 플래그가 true인
      컬럼만 갱신한다. schema.sql에 옛 시그니처 `drop function if exists` 추가,
      revoke/grant 줄과 `supabase/reset.sql`의 drop 줄도 새 시그니처로 맞춘다.
    - route: body에 키가 있는 필드만 갱신(`'opens_at' in body` /
      `'is_closed' in body`). 둘 다 없으면 400.
    - AdminView: 저장 버튼은 opens_at만, 마감 토글은 is_closed만 보낸다. 오픈 시각
      입력이 비어 있으면 저장 버튼 비활성화.
    - load-test는 settings를 직접 upsert하므로 영향 없는지 확인만 한다.
  - schema.sql 변경 태스크 → 완료 보고에 "Supabase SQL Editor에서 schema.sql 재실행 필요" 명시.

- [ ] T5. 학번 입력 제거, 이름만으로 신청
  - 배경: 동명이인이 없어 학번 뒤 4자리가 필요 없다. 입력칸을 줄여 신청을 빠르게 한다.
  - 시작 전: DB에 보존할 데이터가 있는지 사용자에게 먼저 묻는다(없으면 reset.sql →
    schema.sql → seed.sql 재실행 안내).
  - 수정:
    - `registrations`에서 `student_no4` 제거. 이름 키는 공백을 모두 없애고 NFC 정규화:
      `lower(regexp_replace(normalize(btrim(name), NFC), '\s', '', 'g'))` — PG16 생성
      컬럼에서 동작 확인됨. "홍길동" / "홍 길동" / "홍길동　"이 같은 키가 된다.
    - UNIQUE 인덱스를 `(name_key) where not is_cancelled`로 바꾼다.
    - `register_for_team(uuid, text)`, `lookup_registration(text)`로 시그니처 변경
      (옛 시그니처 drop, grant/revoke, reset.sql 갱신). 이름 키 계산식은 immutable
      SQL 함수 하나로 모아 생성 컬럼과 RPC가 같이 쓴다.
    - 영향 파일: RegisterView(학번 입력·검증·localStorage·확인 모달),
      `src/lib/types.ts`, `api/admin/state`, `api/admin/export`(CSV 헤더),
      AdminView(학번 열), README, load-test.
    - load-test는 호출 인자만 바뀌지만 기존 검증을 건드리므로 변경 내용을 먼저
      보여주고 승인받는다. 새 검증 T9: "홍길동"과 "홍 길동"을 서로 다른 팀에 동시
      제출 → 정확히 1건 성공.
  - schema.sql 변경 태스크 → 완료 보고에 "Supabase SQL Editor에서 schema.sql 재실행 필요" 명시.
