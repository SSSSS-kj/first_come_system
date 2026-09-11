-- ============================================================================
--  2026 신입부원 OT 팀 구성 반영 — 이미 옛 팀(거시분석/차트분석/퀀트/안전자산,
--  정원 10)이 들어 있는 DB 를 새 구성(매크로 분석/차트 분석/퀀트 투자/
--  채권 · 원자재, 정원 15)으로 갱신한다.
--
--  Supabase Dashboard > SQL Editor 에 통째로 붙여넣어 실행하세요.
--  신청 기록(registrations)은 team_id 로 연결되어 있어 팀 이름을 바꿔도
--  그대로 유지된다. 재실행해도 안전하다(이미 새 이름으로 바뀐 팀은 설명/
--  정원/정렬만 다시 맞추고 넘어간다).
--
--  안전장치:
--   - 새 이름 팀이 이미 있으면 그 팀 행만 갱신하고, 옛 이름 팀은 건드리지
--     않은 채 NOTICE 로 알린다(seed.sql 을 두 번 실행해 8개 팀이 된 경우 등).
--   - 정원을 현재 taken 보다 작게 만들 수 없다(teams_taken_le_capacity 제약).
--     taken 이 새 정원(15)보다 큰 팀이 있으면 전체를 롤백하고 이유를 알린다.
--   - 마지막에 teams 를 sort_order 순으로 보여준다.
-- ============================================================================

begin;

do $$
declare
  mapping jsonb := '[
    {"old": "거시분석", "new": "매크로 분석",   "description": "금리가 오르면 어디로 돈이 움직일까?",  "capacity": 15, "sort_order": 1},
    {"old": "차트분석", "new": "차트 분석",     "description": "지금이 살 때인가, 팔 때인가?",          "capacity": 15, "sort_order": 2},
    {"old": "퀀트",     "new": "퀀트 투자",     "description": "이 전략, 과거 10년엔 얼마나 벌었을까?", "capacity": 15, "sort_order": 3},
    {"old": "안전자산", "new": "채권 · 원자재", "description": "주식 말고, 세상은 뭘로 움직일까?",      "capacity": 15, "sort_order": 4}
  ]'::jsonb;
  m jsonb;
  v_old_id uuid;
  v_new_id uuid;
  v_taken int;
begin
  for m in select * from jsonb_array_elements(mapping)
  loop
    select id into v_new_id from public.teams where name = m->>'new';
    select id into v_old_id from public.teams where name = m->>'old';

    if v_new_id is not null then
      -- 이미 새 이름 팀이 있다 — 옛 팀은 그대로 두고 새 팀 행만 갱신한다.
      select taken into v_taken from public.teams where id = v_new_id;
      if v_taken > (m->>'capacity')::int then
        raise exception '팀 "%" 의 현재 신청 인원(%)이 새 정원(%)보다 많아 중단합니다.',
          m->>'new', v_taken, m->>'capacity';
      end if;

      update public.teams
         set description = m->>'description',
             capacity    = (m->>'capacity')::int,
             sort_order  = (m->>'sort_order')::int
       where id = v_new_id;

      if v_old_id is not null then
        raise notice '"%" 팀이 이미 있어 설명/정원/정렬만 갱신했습니다. 옛 팀 "%" (id=%) 은 그대로 남아 있으니 필요하면 수동으로 정리하세요.',
          m->>'new', m->>'old', v_old_id;
      else
        raise notice '"%" 팀을 갱신했습니다(옛 이름 팀은 없음).', m->>'new';
      end if;

    elsif v_old_id is not null then
      -- 정상 경로: 옛 팀을 새 이름/설명/정원/정렬로 바꾼다.
      select taken into v_taken from public.teams where id = v_old_id;
      if v_taken > (m->>'capacity')::int then
        raise exception '팀 "%" 의 현재 신청 인원(%)이 새 정원(%)보다 많아 중단합니다.',
          m->>'old', v_taken, m->>'capacity';
      end if;

      update public.teams
         set name        = m->>'new',
             description = m->>'description',
             capacity    = (m->>'capacity')::int,
             sort_order  = (m->>'sort_order')::int
       where id = v_old_id;

      raise notice '"%" 팀을 "%" 로 바꿨습니다.', m->>'old', m->>'new';

    else
      raise notice '"%"/"%" 이름의 팀을 찾지 못해 건너뜁니다.', m->>'old', m->>'new';
    end if;
  end loop;
end;
$$;

select id, name, description, capacity, taken, sort_order
  from public.teams
 order by sort_order;

commit;
