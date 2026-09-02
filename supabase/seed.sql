-- ============================================================================
--  초기 데이터 — 팀 목록과 정원은 여기서 바꾸거나 /admin 에서 수정하면 된다.
-- ============================================================================

insert into public.settings (id, opens_at, is_closed)
values (1, null, false)
on conflict (id) do nothing;

insert into public.teams (name, description, capacity, sort_order) values
  ('퀀트',     '수식과 백테스트로 알파를 찾는 팀',        10, 1),
  ('거시분석', '금리·환율·경기지표로 큰 그림을 읽는 팀',  10, 2),
  ('차트분석', '가격과 거래량의 흐름을 읽는 팀',          10, 3),
  ('안전자산', '채권·금·현금성 자산 중심으로 지키는 팀',  10, 4)
on conflict (name) do nothing;
