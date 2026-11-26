-- Run only against an isolated database with the durable-jobs migration. All fixtures roll back.
begin;
insert into public.article_jobs(id,url,version,lang,title,status,deadline_at,request_key,retryable,state)
values
 ('10000000-0000-4000-8000-000000000001','https://en.wikipedia.org/wiki/RepairAuth','repair-test','en','Auth','failed',now()+interval '1 hour','test',false,'{"opinion":"Saved stance","opinionFailure":{"code":"provider_auth","terminal":true,"retryable":false},"outputs":{"b1":"saved passage"}}'),
 ('10000000-0000-4000-8000-000000000002','https://en.wikipedia.org/wiki/RepairConfig','repair-test','en','Config','partial',now()+interval '1 hour','test',false,'{"opinion":"Saved stance","failures":{"b2":{"code":"provider_not_configured","terminal":true,"retryable":false}},"outputs":{"b1":"saved passage"}}'),
 ('10000000-0000-4000-8000-000000000003','https://en.wikipedia.org/wiki/UnchangedSource','repair-test','en','Source','failed',now()+interval '1 hour','test',false,'{"sourceFailure":{"code":"article_not_found"},"outputs":{}}'),
 ('10000000-0000-4000-8000-000000000004','https://en.wikipedia.org/wiki/UnchangedComplete','repair-test','en','Complete','complete',now()+interval '1 hour','test',false,'{"opinionFailure":{"code":"provider_auth"},"outputs":{"b1":"saved passage"}}');
create temporary table before_repair as select * from public.article_jobs where version='repair-test';
\ir ../supabase/migrations/20261126000002_manual_provider_recovery.sql
create function pg_temp.check_repair() returns void language plpgsql as $$ begin
  if (select count(*) from public.article_jobs where version='repair-test' and retryable)<>2 then raise exception 'Only terminal auth/config rows should become manually retryable'; end if;
  if exists(select 1 from public.article_jobs after join before_repair before using(id) where to_jsonb(after)-'retryable'-'updated_at' is distinct from to_jsonb(before)-'retryable'-'updated_at') then raise exception 'Recovery must not alter status, queue, deadline, source, outputs or other state'; end if;
end $$;
select pg_temp.check_repair();
create temporary table after_first_repair as select * from public.article_jobs where version='repair-test';
\ir ../supabase/migrations/20261126000002_manual_provider_recovery.sql
select pg_temp.check_repair();
do $$ begin if exists(select 1 from public.article_jobs after join after_first_repair before using(id) where to_jsonb(after) is distinct from to_jsonb(before)) then raise exception 'Repair must be idempotent'; end if; end $$;
rollback;
