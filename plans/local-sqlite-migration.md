# 로컬 SQLite 전환 비용 산정 계획

> 상태: **미승인 — 비용 산정용 문서**. 이 문서만으로는 코드를 고치지 않는다.
> 목적: "Supabase 없이 내 노트북에서 일회성으로 돌릴 수 있나"에 대한 근거 있는 답.

## 0. 전제 정정

한도(quota)는 전환 사유가 되지 못한다. Supabase 무료 티어는 DB 500MB / Realtime 동시 200 /
MAU 5만이고, 60명 일회성 행사는 그 어떤 항목도 1%를 넘기지 않는다.
따라서 판단 기준은 **"계정·배포 번거로움"과 "당일 노트북 단일 장애점"의 교환**이다.

## 1. 전환 후 아키텍처

| 항목 | 현재 | 전환 후 |
|---|---|---|
| DB | Supabase Postgres | 로컬 SQLite 파일 1개 (`data/contest.db`) |
| 비즈니스 로직 | PL/pgSQL 함수 11개 (`schema.sql` 758줄) | Next.js 서버 코드 (`src/lib/db/*.ts`) |
| 브라우저 → DB | anon 키로 RPC 직접 호출 (3곳) | 직접 접근 없음. API 라우트 경유 |
| 권한 모델 | RLS + GRANT/REVOKE 4겹 | 불필요 (브라우저가 DB에 닿지 않음) |
| 실시간 갱신 | Realtime `postgres_changes` + 4초 폴링 | 4초 폴링만 (이미 구현되어 있음) |
| 실행 | Vercel | 노트북에서 `npm run build && npm start` |

### 정원 초과 방어는 유지되는가 — 유지된다

현재 4겹 중 3겹이 그대로 살아남고, 오히려 단순해진다.

1. **조건부 UPDATE** — `update teams set taken = taken + 1 where id = ? and taken < capacity`
   는 SQLite에서 동일하게 동작하고, `changes()` 로 영향 행 수를 본다.
2. **CHECK 제약** — `CHECK (taken <= capacity)` SQLite 지원.
3. **부분 UNIQUE 인덱스** — `WHERE NOT is_cancelled` 부분 인덱스 SQLite 지원.
4. RLS 겹은 사라지지만, 그 겹이 막던 위협(브라우저의 직접 INSERT) 자체가 사라진다.

추가로 `next start` 는 **단일 Node 프로세스**라 `BEGIN IMMEDIATE` 트랜잭션이 직렬화된다.
PostgREST 커넥션 풀 대기(README 8장의 알려진 제약)가 사라진다.

### 설계가 실제로 바뀌는 지점 (주의 필요)

- **`name_key` 생성 컬럼**: Postgres는 `lower(regexp_replace(...))` 를 DB가 계산했다.
  SQLite에는 `regexp_replace` 가 없다. → 애플리케이션에서 정규화해 **저장**하는 컬럼으로 바뀐다.
  UNIQUE 인덱스는 그대로 남으므로 중복 방어의 최종 보루는 여전히 DB다.
  다만 "정규화 규칙이 DB에 박혀 있다"는 보장은 잃는다. 정규화 함수 단위 테스트 필수.
- **시각**: `timestamptz` → UTC ISO8601 TEXT. `now()` → 서버 `Date.now()`.
  "클라이언트 시각을 절대 받지 않는다"는 원칙은 그대로 유지된다(서버 단일 소스).
- **UUID**: `gen_random_uuid()` → `crypto.randomUUID()`.
- **audit_log append-only**: SQLite 트리거 + `RAISE(ABORT)` 로 동일 구현 가능.

### SQLite 드라이버 — 결정 필요

- (A) **`node:sqlite` 내장** — 의존성 0, 네이티브 빌드 없음. 현재 노트북 Node v22.23에서
      동작 확인함(`ExperimentalWarning` 출력됨). 일회성 행사엔 충분. **권장**
- (B) **`better-sqlite3`** — 성숙하고 API가 넓지만 네이티브 모듈 빌드가 필요.

## 2. 변경 파일 목록 (실측)

**신규 (8)**
- `src/lib/db/open.ts` — DB 핸들, WAL, `globalThis` 캐싱(dev HMR 다중 인스턴스 방지)
- `src/lib/db/schema.sql` — Postgres 스키마의 SQLite 번역본
- `src/lib/db/register.ts` — `register_for_team` 이식 (**가장 중요, 165줄**)
- `src/lib/db/queries.ts` — `get_public_state` / `lookup_registration`
- `src/lib/db/admin.ts` — `admin_*` 7개 이식 (cancel / transfer / set_capacity / create / update / delete / settings)
- `src/lib/db/audit.ts` — `_audit` 이식
- `src/app/api/register/route.ts` — 신규 공개 엔드포인트
- `src/app/api/lookup/route.ts`, `src/app/api/state/route.ts` — 신규 공개 엔드포인트

**수정 (13)**
- 삭제: `src/lib/supabase/client.ts`, `src/lib/supabase/admin.ts`
- 관리자 API 라우트 8개 (`src/app/api/admin/**`) — `.rpc(...)` → 로컬 함수 호출
- `src/components/RegisterView.tsx` — RPC 2곳 → `fetch`
- `src/components/BoardView.tsx` — Realtime 채널 제거
- `src/lib/useContest.ts` — Realtime 채널 제거, 폴링만 유지, `realtime` 상태 표시 정리

**부수 (7)**
- `package.json` (의존성 제거 / 스크립트 추가), `.env.example` (Supabase 3개 항목 제거)
- `scripts/load-test.mjs`, `scripts/event-sim.mjs`, `e2e/helpers.ts` — 접속 방식 교체
- `README.md` (1·2·6·7·8장 재작성), `supabase/` 디렉터리 처리 방침 결정

**합계: 신규 8 + 수정 13 + 부수 7 = 28개 파일**

## 3. 태스크 (원자 단위, 한 세션에 하나씩)

- [ ] **L1** SQLite 스키마 번역 + 드라이버 결정 확정. 빈 DB 생성·제약 동작 확인 (인위적 정원 초과·중복 INSERT가 실제로 거부되는지)
- [ ] **L2** `_audit` + `register_for_team` 이식. 입력 검증·중복·마감·오픈 전 분기 전부 이식
- [ ] **L3** `get_public_state` / `lookup_registration` 이식 + 공개 API 라우트 3개
- [ ] **L4** `admin_*` 7개 이식 + 관리자 라우트 8개 교체
- [ ] **L5** 클라이언트 3개 파일에서 Supabase 제거 (RPC → fetch, Realtime → 폴링)
- [ ] **L6** `scripts/` 2개 + `e2e/helpers.ts` 를 로컬 서버 대상으로 교체
- [ ] **L7** 재검증: 부하 테스트 → 100명×3회 시뮬레이션 → Playwright E2E 7종
- [ ] **L8** 접속 경로 확정 및 실환경 리허설 (아래 5장)
- [ ] **L9** README 재작성 + `.env.example` 정리 + Supabase 잔재 처리

L1~L5 는 순차 의존. L6 은 L3·L4 이후. L7 은 전부 이후.

## 4. 검증 루프 (각 태스크 종료 시 필수)

1. `npm run typecheck`
2. 해당 범위 테스트 실행
3. 실패 시 결과 원문 보고 후 수정

L7 은 기존 V1~V5 와 **동일한 판정 기준**을 그대로 적용한다. 특히:
- 정원 15 팀에 100 동시 요청 → 성공 정확히 15, 초과 0
- 같은 이름+학번 동시 2탭 → 성공 1, 좌석 누수 0
- `opens_at` 이전 요청 → 전부 `not_open`

## 5. 미결정 — 참가자 접속 경로

로컬 전환의 **진짜 리스크는 코드가 아니라 여기**다. L8 전까지 결정 필요.

| 방식 | 장점 | 위험 |
|---|---|---|
| 같은 WiFi 로컬 IP (`192.168.x.x:3000`) | 인터넷 불필요, 가장 단순 | 학교/카페 WiFi의 AP 격리로 폰→노트북이 막히는 경우가 흔함. **행사 전 실제 장소에서 폰으로 테스트 필수** |
| cloudflared 임시 터널 | AP 격리 우회, 계정 불필요 | 인터넷 의존, 실행할 때마다 URL 변경, 터널 프로세스도 장애점 |

어느 쪽이든 공통 리스크: **노트북 절전 / WiFi 끊김 / 터미널 종료 = 행사 중단.**
Vercel에는 없는 위험이다. 최소 대비책으로 절전 비활성화 + 전원 연결 + 유선 선호.

## 6. 결론 — 비용 요약

- 코드 작업: 28개 파일, PL/pgSQL 758줄을 TypeScript로 이식. L1~L9의 9개 세션 규모.
- 재검증: 이미 끝난 V1~V5 를 처음부터 다시. 이게 코드 작업만큼 든다.
- 얻는 것: 계정·배포 절차 없음, 데이터가 내 파일 하나, 커넥션 풀 대기 소멸.
- 잃는 것: 검증 완료 상태, 무중단 호스팅. 노트북이 단일 장애점이 됨.

**판단 재료**: 행사까지 남은 기간이 넉넉하고 Supabase 계정 만들기가 싫다면 할 만하다.
행사가 임박했다면, 이미 V5까지 검증된 현재 구성을 그대로 쓰는 편이 훨씬 안전하다.
