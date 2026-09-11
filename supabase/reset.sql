-- ============================================================================
--  ⚠ 개발/테스트 전용. 모든 데이터와 객체를 삭제한다. 운영 프로젝트에서 실행 금지.
-- ============================================================================
drop trigger if exists audit_log_no_mutation on public.audit_log;

drop function if exists public.register_for_team(uuid,text,text);
drop function if exists public.lookup_registration(text,text);
drop function if exists public.get_public_state();
drop function if exists public.admin_cancel_registration(uuid);
drop function if exists public.admin_transfer_registration(uuid,uuid);
drop function if exists public.admin_set_capacity(uuid,int);
drop function if exists public.admin_create_team(text,text,int,int);
drop function if exists public.admin_update_team(uuid,text,text,int);
drop function if exists public.admin_delete_team(uuid);
drop function if exists public.admin_update_settings(timestamptz,boolean,boolean,boolean);
drop function if exists public._audit(text,text,boolean,text,uuid,uuid,uuid,text,jsonb);
drop function if exists public.audit_log_immutable();

drop table if exists public.audit_log     cascade;
drop table if exists public.registrations cascade;
drop table if exists public.teams         cascade;
drop table if exists public.settings      cascade;
