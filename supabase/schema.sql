-- ============================================================================
--  선착순 팀 배정 시스템 — Supabase / Postgres 스키마
--  Supabase Dashboard > SQL Editor 에 통째로 붙여넣어 실행하세요. (재실행 안전)
--
--  설계 원칙
--   1) 좌석 확보 + 신청 기록 삽입은 단 하나의 RPC 트랜잭션 안에서만 일어난다.
--   2) 정원 초과는 조건부 UPDATE(row lock) + CHECK 제약으로 이중 차단한다.
--   3) 중복 신청은 애플리케이션이 아니라 UNIQUE 인덱스가 막는다.
--   4) 시각은 오직 서버의 now() 만 신뢰한다.
-- ============================================================================

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
--  1. 테이블
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.teams (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null unique,
  description  text        not null default '',
  capacity     int         not null check (capacity >= 0),
  taken        int         not null default 0 check (taken >= 0),
  -- 순번 발급용 단조 증가 카운터. 취소가 발생해도 감소하지 않으므로
  -- 같은 순번이 두 사람에게 발급되는 일이 없다. (대신 번호에 빈칸이 생긴다)
  seq_counter  int         not null default 0,
  sort_order   int         not null default 0,
  created_at   timestamptz not null default now(),
  -- ★ 절대 요구사항: 애플리케이션/RPC 에 버그가 있어도 DB 가 초과를 거부한다.
  constraint teams_taken_le_capacity check (taken <= capacity)
);

create table if not exists public.registrations (
  id           uuid        primary key default gen_random_uuid(),
  team_id      uuid        not null references public.teams(id) on delete restrict,
  name         text        not null check (btrim(name) <> ''),
  student_no4  text        not null check (student_no4 ~ '^[0-9]{10}$'),
  -- 대소문자·공백 차이로 중복 검사를 우회하지 못하도록 정규화한 키
  name_key     text        generated always as
                 (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  seq          int         not null,                 -- 팀 내 순번
  created_at   timestamptz not null default now(),   -- 서버 시각만 기록
  is_cancelled boolean     not null default false,
  cancelled_at timestamptz
);

-- 학번 자리수 변경(4자리 → 10자리): 이미 테이블이 존재하는 배포본에는
-- "create table if not exists" 가 적용되지 않으므로 제약을 다시 건다. (재실행 안전)
alter table public.registrations drop constraint if exists registrations_student_no4_check;
alter table public.registrations add constraint registrations_student_no4_check
  check (student_no4 ~ '^[0-9]{10}$');

-- ★ 중복 신청 차단: 취소되지 않은 (이름, 학번) 조합은 전체에서 유일.
create unique index if not exists registrations_identity_active_uniq
  on public.registrations (name_key, student_no4) where (not is_cancelled);

-- 팀 내 순번은 취소 행을 포함해 유일 (순번 재사용 없음을 DB 가 보증)
create unique index if not exists registrations_team_seq_uniq
  on public.registrations (team_id, seq);

create index if not exists registrations_team_idx
  on public.registrations (team_id, seq);
create index if not exists registrations_created_idx
  on public.registrations (created_at);

create table if not exists public.settings (
  id                  smallint    primary key default 1 check (id = 1),
  opens_at            timestamptz,                 -- null 이면 "아직 미오픈"
  is_closed           boolean     not null default false,
  -- 스키마 요구사항상 보관. anon 에게는 컬럼 단위 권한으로 노출되지 않는다.
  -- 실제 앱 인증은 서버 라우트가 환경변수 ADMIN_PASSWORD_HASH 로 수행한다.
  admin_password_hash text,
  updated_at          timestamptz not null default now()
);

create table if not exists public.audit_log (
  id              bigserial   primary key,
  at              timestamptz not null default now(),
  action          text        not null,  -- register | cancel | transfer | team_create
                                         -- | team_delete | capacity_update | settings_update
  actor           text        not null,  -- 'anon' | 'admin'
  success         boolean     not null,
  reason          text        not null,  -- ok | not_open | closed | team_full | duplicate_name ...
  team_id         uuid,
  to_team_id      uuid,
  registration_id uuid,
  name            text,
  detail          jsonb       not null default '{}'::jsonb
);

create index if not exists audit_log_at_idx on public.audit_log (at desc);

-- append-only 보장: UPDATE / DELETE 를 트리거로 완전 차단
create or replace function public.audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only (% denied)', tg_op;
end;
$$;

drop trigger if exists audit_log_no_mutation on public.audit_log;
create trigger audit_log_no_mutation
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

-- ────────────────────────────────────────────────────────────────────────────
--  2. 내부 헬퍼
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public._audit(
  p_action text, p_actor text, p_success boolean, p_reason text,
  p_team_id uuid default null, p_to_team_id uuid default null,
  p_registration_id uuid default null, p_name text default null,
  p_detail jsonb default '{}'::jsonb
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.audit_log
    (action, actor, success, reason, team_id, to_team_id, registration_id, name, detail)
  values
    (p_action, p_actor, p_success, p_reason, p_team_id, p_to_team_id,
     p_registration_id, p_name, coalesce(p_detail, '{}'::jsonb));
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  3. 공개 RPC
-- ────────────────────────────────────────────────────────────────────────────

-- 서버 시각 + 오픈 설정 + 팀 현황을 한 번에. 카운트다운의 기준 시각은 이 값이다.
create or replace function public.get_public_state()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'server_now', now(),
    'opens_at',   (select opens_at  from public.settings where id = 1),
    'is_closed',  coalesce((select is_closed from public.settings where id = 1), false),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'description', t.description,
               'capacity', t.capacity, 'taken', t.taken, 'sort_order', t.sort_order
             ) order by t.sort_order, t.name)
      from public.teams t
    ), '[]'::jsonb)
  );
$$;

-- ───────────────────────────────────────────────
--  ★ 핵심: 신청 (좌석 확보 + 기록 삽입이 하나의 트랜잭션)
-- ───────────────────────────────────────────────
create or replace function public.register_for_team(
  p_team_id     uuid,
  p_name        text,
  p_student_no4 text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now       timestamptz := now();          -- 서버 시각만 사용
  v_opens_at  timestamptz;
  v_is_closed boolean;
  v_name      text;
  v_name_key  text;
  v_sno       text := btrim(coalesce(p_student_no4, ''));
  v_team_name text;
  v_seq       int;
  v_reg_id    uuid;
  v_exists    boolean;
  v_cap       int;
  v_taken     int;
  v_dup_id       uuid;
  v_dup_seq      int;
  v_dup_team     uuid;
  v_dup_team_nm  text;
  v_dup_created  timestamptz;
begin
  -- 0) 입력 정규화 및 검증 -------------------------------------------------
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  -- registrations.name_key 생성 컬럼식과 동일한 정규화(39행)를 그대로 재사용한다.
  v_name_key := lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g'));

  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    perform public._audit('register', 'anon', false, 'invalid_name',
                          p_team_id, null, null, v_name,
                          jsonb_build_object('student_no4', v_sno));
    return jsonb_build_object('ok', false, 'status', 'invalid_name', 'server_now', v_now);
  end if;

  if v_sno !~ '^[0-9]{10}$' then
    perform public._audit('register', 'anon', false, 'invalid_student_no',
                          p_team_id, null, null, v_name, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'invalid_student_no', 'server_now', v_now);
  end if;

  -- 1) 오픈 시각 / 마감 검증 (서버에서만 판단. UI 비활성화는 검증 수단이 아니다) --
  select s.opens_at, s.is_closed into v_opens_at, v_is_closed
    from public.settings s where s.id = 1;

  if coalesce(v_is_closed, false) then
    perform public._audit('register', 'anon', false, 'closed',
                          p_team_id, null, null, v_name, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'closed', 'server_now', v_now);
  end if;

  if v_opens_at is null or v_now < v_opens_at then
    perform public._audit('register', 'anon', false, 'not_open',
                          p_team_id, null, null, v_name,
                          jsonb_build_object('opens_at', v_opens_at));
    return jsonb_build_object('ok', false, 'status', 'not_open',
                              'opens_at', v_opens_at, 'server_now', v_now);
  end if;

  -- 1.5) 이미 신청되어 있는지 좌석을 건드리기 전에 먼저 확인 ----------------
  --      정원이 찬 뒤 재시도해도 team_full 이 아니라 본인 배정을 그대로 보여준다.
  select r.id, r.seq, r.team_id, t.name, r.created_at
    into v_dup_id, v_dup_seq, v_dup_team, v_dup_team_nm, v_dup_created
    from public.registrations r
    join public.teams t on t.id = r.team_id
   where r.name_key = v_name_key
     and r.student_no4 = v_sno
     and not r.is_cancelled
   limit 1;

  if v_dup_id is not null then
    perform public._audit('register', 'anon', false, 'duplicate_name',
                          p_team_id, null, v_dup_id, v_name,
                          jsonb_build_object('student_no4', v_sno));
    return jsonb_build_object(
      'ok', false, 'status', 'duplicate_name', 'server_now', v_now,
      'existing', jsonb_build_object(
        'registration_id', v_dup_id, 'team_id', v_dup_team,
        'team_name', v_dup_team_nm, 'seq', v_dup_seq, 'created_at', v_dup_created
      )
    );
  end if;

  -- 2) ★ 원자적 좌석 확보 + 순번 발급 --------------------------------------
  --    조건부 UPDATE 가 해당 team row 에 배타 잠금을 걸고 정원을 재검사한다.
  --    "조회 → 판단 → 삽입" 이 아니라 단일 문장으로 판정되므로
  --    마지막 한 자리에 100건이 몰려도 found 가 참인 세션은 정확히 하나다.
  update public.teams t
     set taken       = t.taken + 1,
         seq_counter = t.seq_counter + 1
   where t.id = p_team_id
     and t.taken < t.capacity
  returning t.name, t.seq_counter into v_team_name, v_seq;

  if not found then
    select exists(select 1 from public.teams where id = p_team_id) into v_exists;

    if not v_exists then
      perform public._audit('register', 'anon', false, 'team_not_found',
                            p_team_id, null, null, v_name, '{}'::jsonb);
      return jsonb_build_object('ok', false, 'status', 'team_not_found', 'server_now', v_now);
    end if;

    select capacity, taken into v_cap, v_taken from public.teams where id = p_team_id;
    perform public._audit('register', 'anon', false, 'team_full',
                          p_team_id, null, null, v_name,
                          jsonb_build_object('capacity', v_cap, 'taken', v_taken));
    return jsonb_build_object('ok', false, 'status', 'team_full',
                              'team_id', p_team_id, 'capacity', v_cap, 'taken', v_taken,
                              'server_now', v_now);
  end if;

  -- 3) 신청 기록 삽입. 중복은 UNIQUE 인덱스가 막는다 ------------------------
  begin
    insert into public.registrations (team_id, name, student_no4, seq, created_at)
    values (p_team_id, v_name, v_sno, v_seq, v_now)
    returning id into v_reg_id;
  exception when unique_violation then
    -- 같은 트랜잭션 안에서 방금 확보한 좌석을 즉시 반납한다.
    -- (여러 탭에서 서로 다른 팀에 동시 제출한 경우 늦은 쪽이 여기로 들어온다)
    update public.teams set taken = taken - 1 where id = p_team_id;

    select r.id, r.seq, r.team_id, t.name, r.created_at
      into v_dup_id, v_dup_seq, v_dup_team, v_dup_team_nm, v_dup_created
      from public.registrations r
      join public.teams t on t.id = r.team_id
     where r.name_key = v_name_key
       and r.student_no4 = v_sno
       and not r.is_cancelled
     limit 1;

    perform public._audit('register', 'anon', false, 'duplicate_name',
                          p_team_id, null, v_dup_id, v_name,
                          jsonb_build_object('student_no4', v_sno));

    return jsonb_build_object(
      'ok', false, 'status', 'duplicate_name', 'server_now', v_now,
      'existing', case when v_dup_id is null then null else jsonb_build_object(
        'registration_id', v_dup_id, 'team_id', v_dup_team,
        'team_name', v_dup_team_nm, 'seq', v_dup_seq, 'created_at', v_dup_created
      ) end
    );
  end;

  -- 4) 성공 ----------------------------------------------------------------
  perform public._audit('register', 'anon', true, 'ok',
                        p_team_id, null, v_reg_id, v_name,
                        jsonb_build_object('seq', v_seq, 'student_no4', v_sno));

  return jsonb_build_object(
    'ok', true, 'status', 'ok',
    'registration_id', v_reg_id,
    'team_id', p_team_id, 'team_name', v_team_name,
    'seq', v_seq, 'name', v_name,
    'created_at', v_now, 'server_now', v_now
  );
end;
$$;

-- 재시도/새로고침 시 본인 배정 결과를 다시 찾기 위한 조회 (읽기 전용)
create or replace function public.lookup_registration(
  p_name text, p_student_no4 text
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
       'ok', true, 'status', 'ok',
       'registration_id', r.id, 'team_id', r.team_id, 'team_name', t.name,
       'seq', r.seq, 'name', r.name, 'created_at', r.created_at, 'server_now', now())
     from public.registrations r
     join public.teams t on t.id = r.team_id
     where r.name_key = lower(regexp_replace(btrim(coalesce(p_name,'')), '\s+', ' ', 'g'))
       and r.student_no4 = btrim(coalesce(p_student_no4,''))
       and not r.is_cancelled
     limit 1),
    jsonb_build_object('ok', false, 'status', 'not_found', 'server_now', now())
  );
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  4. 관리자 RPC (service_role 에게만 EXECUTE 부여)
-- ────────────────────────────────────────────────────────────────────────────

-- 취소: is_cancelled 플래그와 taken 감소를 같은 트랜잭션에서 처리.
-- 비운 자리는 즉시 다시 선착순 대상이 된다.
create or replace function public.admin_cancel_registration(p_registration_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_reg public.registrations;
begin
  select * into v_reg from public.registrations
   where id = p_registration_id for update;

  if not found then
    perform public._audit('cancel', 'admin', false, 'registration_not_found',
                          null, null, p_registration_id, null, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'registration_not_found');
  end if;

  if v_reg.is_cancelled then
    perform public._audit('cancel', 'admin', false, 'already_cancelled',
                          v_reg.team_id, null, v_reg.id, v_reg.name, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'already_cancelled');
  end if;

  perform 1 from public.teams where id = v_reg.team_id for update;

  update public.registrations
     set is_cancelled = true, cancelled_at = now()
   where id = p_registration_id;

  update public.teams
     set taken = greatest(taken - 1, 0)
   where id = v_reg.team_id;

  perform public._audit('cancel', 'admin', true, 'ok',
                        v_reg.team_id, null, v_reg.id, v_reg.name,
                        jsonb_build_object('seq', v_reg.seq));

  return jsonb_build_object('ok', true, 'status', 'ok',
                            'registration_id', v_reg.id, 'team_id', v_reg.team_id);
end;
$$;

-- 이관: 양쪽 팀 카운트를 하나의 트랜잭션에서 조정. 대상 팀이 만석이면 아무것도 바뀌지 않는다.
create or replace function public.admin_transfer_registration(
  p_registration_id uuid,
  p_to_team_id      uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg     public.registrations;
  v_lock    record;
  v_to_name text;
  v_new_seq int;
  v_cap     int;
  v_taken   int;
begin
  select * into v_reg from public.registrations
   where id = p_registration_id for update;

  if not found then
    perform public._audit('transfer', 'admin', false, 'registration_not_found',
                          null, p_to_team_id, p_registration_id, null, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'registration_not_found');
  end if;

  if v_reg.is_cancelled then
    perform public._audit('transfer', 'admin', false, 'already_cancelled',
                          v_reg.team_id, p_to_team_id, v_reg.id, v_reg.name, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'already_cancelled');
  end if;

  if v_reg.team_id = p_to_team_id then
    return jsonb_build_object('ok', false, 'status', 'same_team');
  end if;

  if not exists (select 1 from public.teams where id = p_to_team_id) then
    perform public._audit('transfer', 'admin', false, 'team_not_found',
                          v_reg.team_id, p_to_team_id, v_reg.id, v_reg.name, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'team_not_found');
  end if;

  -- 데드락 방지: 두 팀 row 를 항상 id 오름차순으로 잠근다.
  for v_lock in
    select id from public.teams
     where id in (v_reg.team_id, p_to_team_id) order by id
  loop
    perform 1 from public.teams where id = v_lock.id for update;
  end loop;

  -- 대상 팀 좌석을 먼저 확보 (실패하면 원 팀은 그대로 둔다)
  update public.teams t
     set taken = t.taken + 1, seq_counter = t.seq_counter + 1
   where t.id = p_to_team_id and t.taken < t.capacity
  returning t.name, t.seq_counter into v_to_name, v_new_seq;

  if not found then
    select capacity, taken into v_cap, v_taken from public.teams where id = p_to_team_id;
    perform public._audit('transfer', 'admin', false, 'team_full',
                          v_reg.team_id, p_to_team_id, v_reg.id, v_reg.name,
                          jsonb_build_object('capacity', v_cap, 'taken', v_taken));
    return jsonb_build_object('ok', false, 'status', 'team_full',
                              'capacity', v_cap, 'taken', v_taken);
  end if;

  update public.teams set taken = greatest(taken - 1, 0) where id = v_reg.team_id;

  update public.registrations
     set team_id = p_to_team_id, seq = v_new_seq
   where id = p_registration_id;

  perform public._audit('transfer', 'admin', true, 'ok',
                        v_reg.team_id, p_to_team_id, v_reg.id, v_reg.name,
                        jsonb_build_object('from_seq', v_reg.seq, 'to_seq', v_new_seq,
                                           'to_team_name', v_to_name));

  return jsonb_build_object('ok', true, 'status', 'ok',
                            'registration_id', v_reg.id,
                            'from_team_id', v_reg.team_id, 'to_team_id', p_to_team_id,
                            'to_team_name', v_to_name, 'seq', v_new_seq);
end;
$$;

-- 정원 수정: 현재 인원보다 작게 줄이려 하면 거부하고 경고를 돌려준다.
create or replace function public.admin_set_capacity(p_team_id uuid, p_capacity int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_taken int; v_name text;
begin
  if p_capacity is null or p_capacity < 0 then
    return jsonb_build_object('ok', false, 'status', 'invalid_capacity');
  end if;

  select taken, name into v_taken, v_name
    from public.teams where id = p_team_id for update;

  if not found then
    perform public._audit('capacity_update', 'admin', false, 'team_not_found',
                          p_team_id, null, null, null, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'team_not_found');
  end if;

  if p_capacity < v_taken then
    perform public._audit('capacity_update', 'admin', false, 'capacity_below_taken',
                          p_team_id, null, null, v_name,
                          jsonb_build_object('requested', p_capacity, 'taken', v_taken));
    return jsonb_build_object('ok', false, 'status', 'capacity_below_taken',
                              'taken', v_taken, 'requested', p_capacity);
  end if;

  update public.teams set capacity = p_capacity where id = p_team_id;

  perform public._audit('capacity_update', 'admin', true, 'ok',
                        p_team_id, null, null, v_name,
                        jsonb_build_object('capacity', p_capacity, 'taken', v_taken));

  return jsonb_build_object('ok', true, 'status', 'ok', 'capacity', p_capacity);
end;
$$;

create or replace function public.admin_create_team(
  p_name text, p_description text, p_capacity int, p_sort_order int
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    return jsonb_build_object('ok', false, 'status', 'invalid_name');
  end if;
  if p_capacity is null or p_capacity < 0 then
    return jsonb_build_object('ok', false, 'status', 'invalid_capacity');
  end if;

  begin
    insert into public.teams (name, description, capacity, sort_order)
    values (v_name, coalesce(p_description, ''), p_capacity, coalesce(p_sort_order, 0))
    returning id into v_id;
  exception when unique_violation then
    perform public._audit('team_create', 'admin', false, 'duplicate_team_name',
                          null, null, null, v_name, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'status', 'duplicate_team_name');
  end;

  perform public._audit('team_create', 'admin', true, 'ok',
                        v_id, null, null, v_name,
                        jsonb_build_object('capacity', p_capacity));
  return jsonb_build_object('ok', true, 'status', 'ok', 'team_id', v_id);
end;
$$;

create or replace function public.admin_update_team(
  p_team_id uuid, p_name text, p_description text, p_sort_order int
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    return jsonb_build_object('ok', false, 'status', 'invalid_name');
  end if;
  if not exists (select 1 from public.teams where id = p_team_id) then
    return jsonb_build_object('ok', false, 'status', 'team_not_found');
  end if;

  begin
    update public.teams
       set name = v_name,
           description = coalesce(p_description, ''),
           sort_order = coalesce(p_sort_order, sort_order)
     where id = p_team_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'status', 'duplicate_team_name');
  end;

  perform public._audit('team_update', 'admin', true, 'ok',
                        p_team_id, null, null, v_name, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', 'ok');
end;
$$;

-- 삭제: 신청 이력(취소분 포함)이 남아 있으면 거부한다. 기록을 보존하기 위함.
create or replace function public.admin_delete_team(p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_active int; v_total int; v_name text;
begin
  select name into v_name from public.teams where id = p_team_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'team_not_found');
  end if;

  select count(*) filter (where not is_cancelled), count(*)
    into v_active, v_total
    from public.registrations where team_id = p_team_id;

  if v_total > 0 then
    perform public._audit('team_delete', 'admin', false,
                          case when v_active > 0 then 'has_active_registrations'
                               else 'has_registration_history' end,
                          p_team_id, null, null, v_name,
                          jsonb_build_object('active', v_active, 'total', v_total));
    return jsonb_build_object('ok', false,
      'status', case when v_active > 0 then 'has_active_registrations'
                     else 'has_registration_history' end,
      'active', v_active, 'total', v_total);
  end if;

  delete from public.teams where id = p_team_id;

  perform public._audit('team_delete', 'admin', true, 'ok',
                        p_team_id, null, null, v_name, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', 'ok');
end;
$$;

-- 옛 2-인자 시그니처 제거 (부분 업데이트를 지원하는 4-인자 버전으로 교체)
drop function if exists public.admin_update_settings(timestamptz, boolean);

-- 운영진 둘이 동시에 저장해도 서로의 값을 덮어쓰지 않도록, 플래그가 true 인
-- 컬럼만 갱신한다. (p_set_opens_at=false 면 opens_at 은 건드리지 않음)
create or replace function public.admin_update_settings(
  p_opens_at      timestamptz,
  p_is_closed     boolean,
  p_set_opens_at  boolean,
  p_set_is_closed boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opens_at  timestamptz;
  v_is_closed boolean;
begin
  insert into public.settings (id, opens_at, is_closed, updated_at)
  values (1,
          case when p_set_opens_at then p_opens_at else null end,
          case when p_set_is_closed then coalesce(p_is_closed, false) else false end,
          now())
  on conflict (id) do update
    set opens_at   = case when p_set_opens_at then excluded.opens_at
                          else public.settings.opens_at end,
        is_closed  = case when p_set_is_closed then excluded.is_closed
                          else public.settings.is_closed end,
        updated_at = now()
  returning opens_at, is_closed into v_opens_at, v_is_closed;

  perform public._audit('settings_update', 'admin', true, 'ok',
                        null, null, null, null,
                        jsonb_build_object('opens_at', v_opens_at, 'is_closed', v_is_closed,
                                            'set_opens_at', p_set_opens_at,
                                            'set_is_closed', p_set_is_closed));

  return jsonb_build_object('ok', true, 'status', 'ok',
                            'opens_at', v_opens_at, 'is_closed', v_is_closed,
                            'server_now', now());
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
--  5. RLS 정책 및 권한
--     익명 사용자는 registrations 에 직접 INSERT 할 수 없고,
--     오직 register_for_team RPC 를 통해서만 등록할 수 있다.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.teams         enable row level security;
alter table public.registrations enable row level security;
alter table public.settings      enable row level security;
alter table public.audit_log     enable row level security;

drop policy if exists teams_public_read         on public.teams;
drop policy if exists registrations_public_read on public.registrations;
drop policy if exists settings_public_read      on public.settings;

-- 읽기만 허용. INSERT/UPDATE/DELETE 정책은 "존재하지 않음" = 전부 거부.
create policy teams_public_read
  on public.teams for select to anon, authenticated using (true);

create policy registrations_public_read
  on public.registrations for select to anon, authenticated using (true);

create policy settings_public_read
  on public.settings for select to anon, authenticated using (true);

-- audit_log 에는 정책을 만들지 않는다 → anon/authenticated 전면 차단.

-- 테이블 권한 (RLS 와 별개로 GRANT 레벨에서도 쓰기를 봉쇄)
revoke all on public.teams         from anon, authenticated;
revoke all on public.registrations from anon, authenticated;
revoke all on public.settings      from anon, authenticated;
revoke all on public.audit_log     from anon, authenticated;

grant select on public.teams to anon, authenticated;

-- ★ 현황판은 이름과 순번만 공개한다. student_no4 는 컬럼 단위로 제외.
grant select (id, team_id, name, seq, created_at, is_cancelled, cancelled_at)
  on public.registrations to anon, authenticated;

-- ★ admin_password_hash 도 컬럼 단위로 제외한다.
grant select (id, opens_at, is_closed, updated_at)
  on public.settings to anon, authenticated;

-- service_role 은 관리자 라우트에서 직접 조회·정리 작업에 쓰인다. (RLS 우회 롤)
grant all on public.teams, public.registrations, public.settings, public.audit_log
  to service_role;
grant usage, select on all sequences in schema public to service_role;

-- 함수 권한
revoke all on function public._audit(text,text,boolean,text,uuid,uuid,uuid,text,jsonb)
  from public, anon, authenticated;

revoke all on function public.register_for_team(uuid,text,text) from public;
grant execute on function public.register_for_team(uuid,text,text) to anon, authenticated;

revoke all on function public.get_public_state() from public;
grant execute on function public.get_public_state() to anon, authenticated;

revoke all on function public.lookup_registration(text,text) from public;
grant execute on function public.lookup_registration(text,text) to anon, authenticated;

revoke all on function public.admin_cancel_registration(uuid)              from public, anon, authenticated;
revoke all on function public.admin_transfer_registration(uuid,uuid)       from public, anon, authenticated;
revoke all on function public.admin_set_capacity(uuid,int)                 from public, anon, authenticated;
revoke all on function public.admin_create_team(text,text,int,int)         from public, anon, authenticated;
revoke all on function public.admin_update_team(uuid,text,text,int)        from public, anon, authenticated;
revoke all on function public.admin_delete_team(uuid)                      from public, anon, authenticated;
revoke all on function public.admin_update_settings(timestamptz,boolean,boolean,boolean) from public, anon, authenticated;

grant execute on function public.admin_cancel_registration(uuid)            to service_role;
grant execute on function public.admin_transfer_registration(uuid,uuid)     to service_role;
grant execute on function public.admin_set_capacity(uuid,int)               to service_role;
grant execute on function public.admin_create_team(text,text,int,int)       to service_role;
grant execute on function public.admin_update_team(uuid,text,text,int)      to service_role;
grant execute on function public.admin_delete_team(uuid)                    to service_role;
grant execute on function public.admin_update_settings(timestamptz,boolean,boolean,boolean) to service_role;

-- ────────────────────────────────────────────────────────────────────────────
--  6. Realtime publication
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  -- Supabase 프로젝트에는 이미 존재하지만, 로컬/셀프호스트 대비 없으면 만든다.
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;

  foreach t in array array['teams', 'registrations', 'settings'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null;  -- 이미 포함되어 있음
    end;
  end loop;
end $$;
