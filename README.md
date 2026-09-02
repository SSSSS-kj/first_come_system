# 모의투자 대회 선착순 팀 배정 시스템

주식 동아리 모의투자 대회에서 참가자를 분야별 팀에 선착순으로 배정하는 웹 애플리케이션.
**유일한 실패 조건은 정원 초과**이며, 이를 막기 위한 설계가 전체 구조를 결정한다.

- 예상 동시 접속: 약 40명
- 기본 팀: 퀀트 / 거시분석 / 차트분석 / 안전자산 (각 정원 10명, 설정으로 변경 가능)
- 스택: Next.js 15 (App Router) + TypeScript + Supabase(Postgres · Realtime) + Tailwind CSS, Vercel 배포

---

## 1. 정원 초과 방지 설계

정원 초과를 막는 방어선은 네 겹이다. 어느 하나가 무너져도 다음 겹이 막는다.

| # | 방어선 | 위치 |
|---|---|---|
| 1 | 좌석 확보와 신청 기록 삽입이 **하나의 RPC 트랜잭션** | `register_for_team()` |
| 2 | `UPDATE teams SET taken = taken + 1 WHERE id = $1 AND taken < capacity RETURNING …` 의 **영향 행 수**로 마감 판정 (row lock + 원자적 재검사) | `supabase/schema.sql` |
| 3 | `CHECK (taken <= capacity)` **DB 제약** | `teams` 테이블 |
| 4 | RLS + GRANT 로 **anon 의 직접 INSERT 차단** — 등록 경로는 RPC 하나뿐 | RLS 정책 |

핵심 문장은 이것 하나다.

```sql
update public.teams t
   set taken = t.taken + 1,
       seq_counter = t.seq_counter + 1
 where t.id = p_team_id
   and t.taken < t.capacity      -- ★ 잠금과 정원 재검사가 같은 문장 안에서
returning t.name, t.seq_counter into v_team_name, v_seq;

if not found then  -- 여기에 도달한 세션은 좌석을 얻지 못했다
```

"잔여석 조회 → 판단 → 삽입" 은 코드 어디에도 없다. 조회 없이 조건부 UPDATE 한 문장으로
잠금·검사·증가가 동시에 일어나므로, 마지막 한 자리에 100명이 몰려도 `found` 가 참인
세션은 정확히 하나다.

### 중복 신청

`registrations` 의 부분 UNIQUE 인덱스가 막는다. 애플리케이션 검사는 UX용일 뿐이다.

```sql
create unique index registrations_identity_active_uniq
  on public.registrations (name_key, student_no4) where (not is_cancelled);
```

`name_key` 는 `lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))` 로 생성되는 컬럼이라
`홍길동` / `홍 길동` / ` 홍길동 ` 이 모두 같은 키로 취급된다.
동명이인 때문에 실제 참가자가 막히는 사고를 피하기 위해 **학번 뒤 4자리**를 함께 받는다.

여러 탭에서 서로 다른 팀에 동시 제출하면 두 좌석이 잠깐 확보되지만, 늦은 쪽은
UNIQUE 위반으로 좌석을 **같은 트랜잭션에서 즉시 반납**하고 실패한다.

### 시각

`created_at` 과 오픈 여부 판정은 모두 Postgres 의 `now()` 만 사용한다. 클라이언트가 보낸
타임스탬프는 어디에도 받지 않는다. 카운트다운은 `get_public_state()` 가 돌려주는
`server_now` 로 브라우저 시계 오차를 보정해 표시할 뿐이며, 실제 차단은 서버가 한다.
버튼 비활성화는 UI 편의이고, 오픈 전 요청은 RPC 가 `not_open` 으로 거부한다.

---

## 2. 데이터 모델

```
teams          id, name(unique), description, capacity, taken, seq_counter, sort_order, created_at
               CHECK (taken <= capacity)
registrations  id, team_id, name, student_no4, name_key(generated), seq, created_at,
               is_cancelled, cancelled_at
               UNIQUE (name_key, student_no4) WHERE NOT is_cancelled
               UNIQUE (team_id, seq)
settings       id(=1), opens_at, is_closed, admin_password_hash, updated_at
audit_log      id, at, action, actor, success, reason, team_id, to_team_id,
               registration_id, name, detail   — UPDATE/DELETE 를 트리거로 차단 (append-only)
```

**순번 정책**: `teams.seq_counter` 는 취소가 발생해도 감소하지 않는다. 따라서 같은 순번이
두 사람에게 발급되는 일이 없고, 대신 취소된 자리에는 번호 빈칸이 생긴다
(예: 1, 2, 4, 5 … 다음 신청자는 11번). 좌석 수(`taken`)와 번호(`seq`)를 분리한 결과다.

### RPC

| 함수 | 실행 권한 | 용도 |
|---|---|---|
| `register_for_team(p_team_id uuid, p_name text, p_student_no4 text)` | `anon` | 신청 (좌석 확보 + 기록 삽입) |
| `get_public_state()` | `anon` | 서버 시각 + 오픈 설정 + 팀 현황 |
| `lookup_registration(p_name text, p_student_no4 text)` | `anon` | 재시도·새로고침 시 본인 배정 조회 |
| `admin_cancel_registration(uuid)` | `service_role` | 취소 + `taken` 감소 (동일 트랜잭션) |
| `admin_transfer_registration(uuid, uuid)` | `service_role` | 이관 + 양쪽 카운트 조정 (동일 트랜잭션) |
| `admin_set_capacity(uuid, int)` | `service_role` | 정원 수정 (현재 인원 미만이면 거부) |
| `admin_create_team / admin_update_team / admin_delete_team` | `service_role` | 팀 관리 |
| `admin_update_settings(timestamptz, boolean)` | `service_role` | 오픈 시각 · 즉시 마감 |

모든 RPC 는 예외를 던지지 않고 `jsonb` 상태 코드를 돌려준다. 그래야 실패 케이스도
같은 트랜잭션에서 `audit_log` 에 남는다.

### RLS

| 테이블 | anon SELECT | anon 쓰기 |
|---|---|---|
| `teams` | 전체 | ❌ 정책 없음 |
| `registrations` | `id, team_id, name, seq, created_at, is_cancelled, cancelled_at` — **`student_no4` 는 컬럼 단위로 제외** | ❌ |
| `settings` | `id, opens_at, is_closed, updated_at` — **`admin_password_hash` 는 컬럼 단위로 제외** | ❌ |
| `audit_log` | ❌ 정책 없음 | ❌ |

`admin_*` 함수는 `public`·`anon`·`authenticated` 에서 EXECUTE 를 회수하고 `service_role`
에만 부여한다. 브라우저에는 service_role 키가 전달되지 않는다.

---

## 3. 화면

| 경로 | 설명 |
|---|---|
| `/` | 팀 카드 목록(잔여 n/10, Realtime 갱신, 마감 배지) → 이름·학번 입력 → 확인 모달 → 제출. 오픈 전에는 서버 시각 기준 카운트다운. 신청 후 본인 배정 결과 화면으로 전환 |
| `/board` | 팀별 명단과 순번 공개. 인증 없이 열람. Realtime 갱신 |
| `/admin` | 비밀번호 로그인. 팀 추가·삭제·정원 수정, 오픈 시각 설정, 즉시 마감 토글, 개별 취소, 다른 팀 이관, CSV 다운로드, `audit_log` 조회 |

제출 버튼은 응답을 받을 때까지 잠기고(`submitting`), 팀 마감 시에는 잔여 팀 목록이 즉시
갱신된다. Realtime 이 끊겨도 화면이 멈추지 않도록 `get_public_state()` 폴링(4초)을
안전망으로 함께 돌린다.

---

## 4. 로컬 실행

### 4-1. Supabase 프로젝트 설정

1. [supabase.com](https://supabase.com) 에서 새 프로젝트를 만든다. (대회 당일 트래픽이면 Free 플랜으로 충분하다)
2. Dashboard → **SQL Editor** 에서 `supabase/schema.sql` 전체를 붙여넣고 실행한다. 재실행해도 안전하다.
3. 이어서 `supabase/seed.sql` 을 실행해 기본 4개 팀과 `settings` 행을 만든다.
4. Dashboard → **Database → Replication** 에서 `supabase_realtime` 퍼블리케이션에
   `teams`, `registrations`, `settings` 가 포함됐는지 확인한다. (스키마 SQL 이 자동으로 추가하지만 확인해 두면 좋다)
5. Dashboard → **Project Settings → API** 에서 아래 세 값을 복사한다.
   - Project URL
   - `anon` public key
   - `service_role` secret key ← **절대 클라이언트에 노출 금지**

### 4-2. 앱 실행

Node.js 20 이상이 필요하다.

```bash
cp .env.example .env.local
# .env.local 에 Supabase 값 3개를 채운다

npm install

# 관리자 비밀번호 해시 생성 → 출력된 줄을 .env.local 에 붙여넣는다
npm run hash-password -- '원하는비밀번호'

# 세션 서명 시크릿 생성 → ADMIN_SESSION_SECRET 에 붙여넣는다
openssl rand -base64 48

npm run dev     # http://localhost:3000
```

접속 확인:

- `http://localhost:3000` — 신청 (처음에는 "오픈 시각 미지정" 상태라 신청 불가)
- `http://localhost:3000/admin` — 로그인 후 오픈 시각을 지정하면 신청이 열린다
- `http://localhost:3000/board` — 현황판

---

## 5. 동시성 부하 테스트

**이 테스트가 통과하지 않으면 구현은 완료가 아니다.**

```bash
npm run load-test                          # 기본: 정원 10 팀에 100건 동시 발사
npm run load-test -- --n 200 --capacity 10 # 요청 수/정원 변경
npm run load-test -- --rounds 3            # 버스트 테스트 반복
```

> ⚠ 스크립트가 `__loadtest__*` 팀과 신청 데이터를 만들고 지우며, `settings.opens_at` 을
> 일시적으로 바꿨다가 원복한다. **개발용 Supabase 프로젝트에서 실행할 것.**

검증 항목:

| ID | 내용 |
|---|---|
| T1 | 정원 10인 팀에 100건 동시 발사 → 성공 응답이 **정확히 10건** |
| T2a/b | `registrations` 행이 정확히 10개, `teams.taken` 이 정확히 10 |
| T3 | 나머지 90건이 **모두** `team_full` 사유로 실패 (다른 사유가 하나라도 있으면 실패) |
| T4 | 발급된 순번이 1..10, 중복 없음 |
| T5a/b | 같은 사람이 4개 팀 × 3탭 으로 동시 제출 → 정확히 1건만 성공, 실패한 요청이 확보했던 좌석은 모두 반납 (taken 합 = 1) |
| T6a/b/c | 관리자가 취소한 자리에 20명이 재경쟁 → 정확히 1명 성공, 순번은 재사용되지 않음 |
| T7a/b/c | 오픈 전 요청은 `not_open`, 즉시 마감 상태에서는 `closed` 로 거부되고 행이 생기지 않음 |

요청은 배리어로 묶어 동시에 출발시키고, 참가자와 **동일한 경로**(anon 키 → `register_for_team`
RPC)로 발사한다. 검증은 `service_role` 로 DB 를 직접 읽어 확인한다.

`제출 중 네트워크 끊김 후 재시도` 는 두 겹으로 처리된다. 서버 쪽에서는 UNIQUE 인덱스가
중복 행을 만들지 않고, 클라이언트 쪽에서는 응답을 받지 못했을 때 `lookup_registration()`
으로 실제 등록 여부를 확인해 결과 화면으로 넘어간다.

---

## 6. Vercel 배포

```bash
npm i -g vercel
vercel link
vercel --prod
```

Vercel 프로젝트 **Settings → Environment Variables** 에 다음을 등록한다.

| 변수 | 노출 | 값 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 공개 | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 공개 | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **비공개** | service_role secret key |
| `ADMIN_PASSWORD_HASH` | **비공개** | `npm run hash-password` 출력값 |
| `ADMIN_SESSION_SECRET` | **비공개** | `openssl rand -base64 48` 출력값 |
| `ADMIN_SESSION_HOURS` | 비공개(선택) | 관리자 세션 시간, 기본 8 |

`NEXT_PUBLIC_` 접두사가 붙은 값만 브라우저 번들에 포함된다. `SUPABASE_SERVICE_ROLE_KEY`
에는 절대 접두사를 붙이지 않는다.

`vercel.json` 없이 기본 설정으로 동작한다. 관리자 라우트는 모두
`runtime = "nodejs"`, `dynamic = "force-dynamic"` 이라 캐시되지 않는다.

---

## 7. 대회 당일 운영 순서

**D-1**

1. `/admin` 로그인 → 팀 목록과 정원을 최종 확정한다. (정원은 나중에 늘릴 수는 있어도, 현재 인원보다 작게 줄일 수는 없다)
2. 오픈 시각을 지정하고 저장한다. `/` 에서 카운트다운이 뜨는지 확인한다.
3. 개발용 프로젝트에서 `npm run load-test` 를 한 번 더 돌려 전 항목 통과를 확인한다.
4. 참가자에게 배포 URL 과 "이름 + 학번 뒤 4자리로 신청" 안내를 공지한다.

**오픈 직전 (T-10분)**

5. `/admin` 을 열어 둔다. 서버 시각이 화면 상단에 표시된다.
6. `/board` 를 프로젝터에 띄운다. 인증 없이 열람 가능하다.
7. `is_closed` 가 꺼져 있고 `opens_at` 이 정확한지 마지막으로 확인한다.

**오픈**

8. 별도 조작이 필요 없다. `opens_at` 이 지나는 순간 서버가 요청을 받기 시작한다.
9. 관리자 화면의 팀별 인원이 4초마다 갱신된다. 이상 징후는 감사 로그의 **"실패만 보기"** 로 확인한다.

**진행 중 대응**

| 상황 | 조치 |
|---|---|
| 특정 팀만 남고 인원이 안 찬다 | 팀 관리에서 해당 팀 정원을 늘린다 (즉시 반영) |
| 잘못 신청한 참가자 | 신청자 목록에서 **이관** (양쪽 카운트가 한 트랜잭션에서 조정된다) |
| 참가 취소자 | **취소** — 자리가 즉시 다시 선착순 대상이 된다 |
| 중복 이름 문의 | 감사 로그에서 `duplicate_name` 을 검색해 누가 언제 먼저 신청했는지 확인 |
| 조기 마감 필요 | **즉시 마감** 토글 (서버가 모든 신규 요청을 `closed` 로 거부) |

**마감 후**

10. **즉시 마감**을 켠다.
11. **CSV 다운로드** 로 최종 명단을 받는다. (`취소 포함` 버튼은 취소 이력까지 포함한 버전)
12. `/board` 화면을 캡처해 공지 채널에 올린다.
13. 이의 제기 대응이 필요하면 감사 로그로 시각·순번·사유를 그대로 제시할 수 있다.

---

## 8. 알려진 제약

- `lookup_registration()` 은 이름 + 학번 뒤 4자리를 아는 사람에게 배정 결과를 알려준다.
  동아리 내부 행사 수준에서는 문제없지만, 외부 공개 행사라면 이 함수의 `anon` 권한을 회수하고
  결과 조회를 로컬 저장값에만 의존하도록 바꾸는 편이 낫다.
- 관리자 로그인 시도 제한(5분 10회)은 서버리스 인스턴스 로컬 메모리 기반이라 여러 인스턴스에
  분산되면 완화된다. 더 강한 제한이 필요하면 Upstash 등 외부 저장소로 옮긴다.
- Realtime 이 끊긴 경우 잔여석 갱신은 4초 폴링으로 대체된다. 실제 마감 판정은 항상 서버가 하므로
  화면이 잠시 낡아도 정원 초과로 이어지지 않는다.
- PostgREST 커넥션 풀 때문에 100건 동시 요청 중 일부는 큐에서 대기한다. 이는 정확성이 아니라
  지연에만 영향을 준다.
