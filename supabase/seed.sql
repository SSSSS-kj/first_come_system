-- ============================================================================
--  초기 데이터 — 팀 목록과 정원은 여기서 바꾸거나 /admin 에서 수정하면 된다.
-- ============================================================================

insert into public.settings (id, opens_at, is_closed)
values (1, null, false)
on conflict (id) do nothing;

insert into public.teams (name, description, capacity, sort_order) values
  ('매크로 분석',   '금리가 오르면 어디로 돈이 움직일까?',      15, 1),
  ('차트 분석',     '지금이 살 때인가, 팔 때인가?',            15, 2),
  ('퀀트 투자',     '이 전략, 과거 10년엔 얼마나 벌었을까?',    15, 3),
  ('채권 · 원자재', '주식 말고, 세상은 뭘로 움직일까?',        15, 4)
on conflict (name) do nothing;
