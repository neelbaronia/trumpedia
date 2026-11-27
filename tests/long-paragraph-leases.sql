-- Run only in an isolated database with the durable-jobs migration applied and
-- Supabase's service_role BYPASSRLS attribute reproduced by the local fixture.
-- The migration and all fixtures below roll back together.
begin;
create function pg_temp.assert(ok boolean,message text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception '%',message; end if; end $$;

insert into public.article_jobs(id,url,version,lang,title,status,deadline_at,request_key,lease_token,lease_expires_at,state)
values('00000000-0000-4000-8000-000000000001','https://en.wikipedia.org/wiki/ExistingLease','lease-test','en','Existing','running',clock_timestamp()+interval '12 minutes','test','00000000-0000-4000-8000-000000000002',clock_timestamp()+interval '100 seconds','{"outputs":{"b0":"already approved"},"pendingDrafts":{"b1":"private candidate"}}');
insert into public.article_worker_slots values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',clock_timestamp()+interval '100 seconds');
insert into public.article_provider_slots values('00000000-0000-4000-8000-000000000003',clock_timestamp()+interval '60 seconds');
create temporary table before_lease_rows as select
  (select jsonb_agg(to_jsonb(j) order by id) from public.article_jobs j) jobs,
  (select jsonb_agg(to_jsonb(w) order by owner) from public.article_worker_slots w) workers,
  (select jsonb_agg(to_jsonb(p) order by owner) from public.article_provider_slots p) providers,
  (select jsonb_agg(to_jsonb(b) order by bucket) from public.article_rate_budgets b) budgets,
  (select jsonb_agg(to_jsonb(l)) from public.article_generation_limits l) limits;

\ir ../supabase/migrations/20261126000004_long_paragraph_leases.sql
\ir ../supabase/migrations/20261126000004_long_paragraph_leases.sql

select pg_temp.assert((select jobs is not distinct from (select jsonb_agg(to_jsonb(j) order by id) from public.article_jobs j)
  and workers is not distinct from (select jsonb_agg(to_jsonb(w) order by owner) from public.article_worker_slots w)
  and providers is not distinct from (select jsonb_agg(to_jsonb(p) order by owner) from public.article_provider_slots p)
  and budgets is not distinct from (select jsonb_agg(to_jsonb(b) order by bucket) from public.article_rate_budgets b)
  and limits is not distinct from (select jsonb_agg(to_jsonb(l)) from public.article_generation_limits l)
  from before_lease_rows),'Migration and reapply preserve every existing job, lease, rate budget and limit row');
select pg_temp.assert(not exists(select 1 from pg_proc where oid in ('public.claim_provider_slot(uuid,integer)'::regprocedure,'public.claim_article_job(uuid)'::regprocedure,'public.checkpoint_article_job(uuid,uuid,jsonb,jsonb)'::regprocedure)
  and (not prosecdef or proconfig is distinct from array['search_path=pg_catalog, public'] or has_function_privilege('anon',oid,'execute') or has_function_privilege('authenticated',oid,'execute') or not has_function_privilege('service_role',oid,'execute'))),'All replaced functions retain security-definer/search-path and service-only ACLs');
select pg_temp.assert((select pg_get_expr(proargdefaults,0)='90' from pg_proc where oid='public.claim_provider_slot(uuid,integer)'::regprocedure),'Provider lease default is90');

truncate public.article_provider_slots,public.article_worker_slots,public.article_jobs;
set local role service_role;
select pg_temp.assert(public.claim_provider_slot('00000000-0000-4000-8000-000000000010'),'Default provider claim succeeds');
select pg_temp.assert((select expires_at between clock_timestamp()+interval '89 seconds' and clock_timestamp()+interval '90 seconds' from public.article_provider_slots where owner='00000000-0000-4000-8000-000000000010'),'Default provider lease is90seconds');
select pg_temp.assert(public.claim_provider_slot('00000000-0000-4000-8000-000000000011',200),'Long provider claim succeeds');
select pg_temp.assert((select expires_at between clock_timestamp()+interval '89 seconds' and clock_timestamp()+interval '90 seconds' from public.article_provider_slots where owner='00000000-0000-4000-8000-000000000011'),'Provider lease is capped at90seconds');
select pg_temp.assert(public.claim_provider_slot('00000000-0000-4000-8000-000000000012',0),'Minimum provider claim succeeds');
select pg_temp.assert((select expires_at between clock_timestamp() and clock_timestamp()+interval '1 second' from public.article_provider_slots where owner='00000000-0000-4000-8000-000000000012'),'Provider lease retains one-second minimum');
reset role;
truncate public.article_provider_slots;
set local role service_role;
do $$ declare i int; begin
  for i in 1..8 loop perform pg_temp.assert(public.claim_provider_slot(gen_random_uuid(),90),'Eight provider slots available'); end loop;
  perform pg_temp.assert(not public.claim_provider_slot(gen_random_uuid(),90),'Ninth provider slot denied');
end $$;
reset role;

insert into public.article_jobs(id,url,version,lang,title,status,created_at,deadline_at,request_key,state)
select gen_random_uuid(),'https://en.wikipedia.org/wiki/LeaseTest'||i,'lease-test','en','Lease test','queued',clock_timestamp()-interval '10 seconds'+i*interval '1 second',clock_timestamp()+interval '12 minutes','test',
  '{"outputs":{"b0":"already approved"},"plan":{"blocks":[{"id":"b0"},{"id":"b1"}]},"pendingDrafts":{"b1":"private candidate"}}'::jsonb from generate_series(1,3) i;
set local role service_role;
do $$
declare first_claim jsonb; second_claim jsonb; renewed jsonb; jid uuid; before_state jsonb;
  owner1 uuid:='00000000-0000-4000-8000-000000000101';
  owner2 uuid:='00000000-0000-4000-8000-000000000102';
  owner3 uuid:='00000000-0000-4000-8000-000000000103';
begin
  first_claim:=public.claim_article_job(owner1); second_claim:=public.claim_article_job(owner2);
  perform pg_temp.assert(first_claim is not null and second_claim is not null,'Two worker claims available');
  perform pg_temp.assert(public.claim_article_job(owner3) is null,'Third worker denied');
  jid:=(first_claim->>'id')::uuid;
  perform pg_temp.assert((select lease_expires_at between clock_timestamp()+interval '139 seconds' and clock_timestamp()+interval '140 seconds' from public.article_jobs where id=jid),'New job lease is140seconds');
  perform pg_temp.assert((select s.expires_at=j.lease_expires_at from public.article_worker_slots s join public.article_jobs j on j.id=s.job_id where s.owner=owner1),'Worker slot and job lease expire together');
  before_state:=(select state from public.article_jobs where id=jid);
  update public.article_jobs set lease_expires_at=clock_timestamp()+interval '20 seconds' where id=jid;
  update public.article_worker_slots set expires_at=clock_timestamp()+interval '20 seconds' where owner=owner1;
  perform public.checkpoint_article_job(jid,owner1,'{}','{"b1":"new approved output"}');
  perform pg_temp.assert((select lease_expires_at between clock_timestamp()+interval '139 seconds' and clock_timestamp()+interval '140 seconds' from public.article_jobs where id=jid),'Checkpoint renews job lease to140seconds');
  perform pg_temp.assert((select s.expires_at=j.lease_expires_at from public.article_worker_slots s join public.article_jobs j on j.id=s.job_id where s.owner=owner1),'Checkpoint renews matching worker slot');
  perform pg_temp.assert((select state->'outputs'='{"b0":"already approved","b1":"new approved output"}'::jsonb and state->'pendingDrafts'=before_state->'pendingDrafts' and completed=2 and total=2 from public.article_jobs where id=jid),'Checkpoint retains approved output and private candidate while merging new output');
  update public.article_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=jid;
  update public.article_worker_slots set expires_at=clock_timestamp()-interval '1 second' where owner=owner1;
  renewed:=public.claim_article_job(owner3);
  perform pg_temp.assert(renewed->>'id'=jid::text,'Expired worker resumes same saved job');
  begin
    perform public.checkpoint_article_job(jid,owner1,'{}','{"b0":"stale overwrite"}');
    raise exception 'Stale writer unexpectedly accepted';
  exception when sqlstate 'P0002' then null;
  end;
  perform pg_temp.assert((select state->'outputs'->>'b0'='already approved' from public.article_jobs where id=jid),'Expired owner cannot overwrite approved output');
end $$;
reset role;
rollback;
