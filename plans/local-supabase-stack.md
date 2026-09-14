# D안 — Docker 로컬 Supabase 스택으로 행사 운영

> 상태: **진행 중**. 행사 D-2 (2026-09-16).
> 결정 근거: 계정 0개, `schema.sql` 758줄 그대로 사용, V1~V5 검증 스크립트 그대로 재사용,
> `src/` 코드 변경 없음. 노트북이 단일 장애점인 점은 "일회용 행사"로 사용자가 감수 결정함.

## 0. 핵심 — src/ 는 건드리지 않는다

`supabase start` 는 Postgres + PostgREST + Realtime 을 로컬 Docker 로 띄운다.
앱 입장에서는 Supabase 클라우드와 **프로토콜이 동일**하다. 따라서 바뀌는 것은
`NEXT_PUBLIC_SUPABASE_URL` 이 가리키는 주소뿐이고, 애플리케이션 코드는 한 줄도 고치지 않는다.

C안(SQLite 이식, 28개 파일)이 필요 없어지는 이유가 이것이다.
→ `plans/local-sqlite-migration.md` 는 보류 유지.

## 1. 변경 파일 (5개, `src/` 없음)

| 파일 | 성격 | 내용 |
|---|---|---|
| `supabase/migrations/20260914000000_init.sql` | 신규 | `schema.sql` 그대로 복사. `supabase start` 가 자동 적용 |
| `supabase/config.toml` | 신규 | `supabase init` 이 생성. ⚠ 기존 `seed.sql` 을 덮어쓰지 않는지 확인 |
| `.env.local` | 신규(비커밋) | 로컬 스택 URL·키, 관리자 해시, 세션 시크릿 |
| `.env.example` | 수정 | 로컬 스택용 항목 주석 추가 |
| `README.md` | 수정 | 7장에 로컬 스택 운영 순서 추가 |

`supabase/seed.sql` 은 이미 CLI 규약과 정확히 일치한다(팀 4개·정원 15). 그대로 쓴다.

## 2. 태스크

- [x] **D1a** `schema.sql` → `supabase/migrations/20260914000000_init.sql` 복사 *(Claude)*
- [ ] **D1b** `supabase init` → `config.toml` 생성. `seed.sql` 무결성 확인 *(jun, 로컬 터미널)*
- [ ] **D2** `supabase start` → 기동. `supabase status` 로 API URL·anon·service_role 키 확보 *(jun)*
- [ ] **D3** 스키마·시드 적용 확인 (`/admin` 에서 팀 4개·정원 15, `settings` 1행)
- [ ] **D4** 노트북 LAN IP 확인 → `.env.local` 작성 (**URL 을 localhost 아닌 LAN IP 로**) → `npm run build`
- [ ] **D5** 보안 결정: 기본 JWT 키 교체 여부 (4장). 교체 시 `.env.local` 재작성 + 재빌드
- [ ] **D6** `npm start -- -H 0.0.0.0` → **행사 장소에서 실제 폰으로 접속 테스트** (최우선 관문)
- [ ] **D7** 검증 재실행: `npm run load-test` → `npm run event-sim` → `npm run e2e`
- [ ] **D8** 당일 런북 작성 (기동 순서·중단 시 복구·DB 백업)

D1~D4 순차. D6 은 D4 이후 가능한 한 빨리(내일 중). D7 은 D5 이후.

**Docker 와 `supabase` CLI 는 Claude 가 쓰는 셸(격리 VM)에 없다.** D1b·D2·D6 은 jun 이
자기 터미널에서 직접 실행한다. Claude 는 파일 준비와 명령 제공을 맡는다.

## 3. 빌드타임 주입 주의 (가장 흔한 사고)

`NEXT_PUBLIC_` 접두사 값은 **빌드 시점에 브라우저 번들에 박힌다.**
`localhost:54321` 로 빌드하면 참가자 폰에서 자기 자신을 가리켜 전부 실패한다.
반드시 노트북의 LAN IP 로 설정한 뒤 `npm run build` 를 **다시** 돌린다.
IP 가 바뀌면(WiFi 재접속 등) 재빌드가 필요하므로 당일 IP 고정을 권장한다.

## 4. 보안 — 결정 필요 (D5)

로컬 Supabase 스택의 기본 `anon` / `service_role` 키는 **전 세계 공통 공개 값**이다.
같은 WiFi 의 부원이 `service_role` 키로 신청 데이터를 조회·삭제·조작할 수 있다.

- (가) **감수한다** — 동아리 내부, 60명, 1시간. 현실적으로 시도할 사람이 없다고 판단.
- (나) **JWT secret 교체 후 키 재발급** — 확실하지만 CLI 버전별 절차 차이로 시간이 든다.

`audit_log` 는 트리거로 UPDATE/DELETE 가 차단되므로 **조작 흔적은 어느 쪽이든 남는다.**

## 5. 검증 기준 (D7) — V1~V5 와 동일

- 정원 15 팀에 100 동시 요청 → 성공 정확히 15, 초과 0
- 같은 이름+학번 동시 2탭 → 성공 1, 좌석 누수 0
- `opens_at` 이전 요청 → 전부 `not_open`
- Playwright E2E 7종 통과 (E8 모바일 390px 포함)

## 6. 폐기 경로

D6(폰 접속 테스트)이 실패하면 — AP 격리 등 — 즉시 A안(Vercel + Supabase 클라우드)으로 전환한다.
A안은 30분~1시간이면 되고 `src/` 변경이 없으므로, D안 작업이 A안을 막지 않는다.
**D6 을 내일 중에 끝내는 것이 이 계획의 유일한 기한이다.**
