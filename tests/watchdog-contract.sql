-- Run only in an isolated scratch database, passing migration_file with the two
-- unavailable local pg_cron/pg_net CREATE EXTENSION statements removed.
-- The production function and schedule statements are otherwise unchanged.
\set ON_ERROR_STOP on
begin;
create schema extensions;
create extension pgcrypto with schema extensions;
create schema vault;
create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
create schema cron;
create table cron.test_jobs(jobname text,schedule text,command text);
create function cron.schedule(text,text,text) returns bigint language plpgsql as $$
begin insert into cron.test_jobs values($1,$2,$3); return 1; end $$;
create schema net;
create table net.test_requests(url text,body jsonb,headers jsonb,timeout_ms int);
create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds int default 2000)
returns bigint language plpgsql as $$
begin insert into net.test_requests values(url,body,headers,timeout_milliseconds); return 1; end $$;
create table public.article_jobs(status text,next_run_at timestamptz,lease_expires_at timestamptz);
create table public.article_worker_slots(expires_at timestamptz);
create table public.watchdog_test_budget(allowed boolean);
insert into public.watchdog_test_budget values(true);
create function public.take_rate_budget(bucket text,max_calls int,window_secs int) returns boolean language plpgsql as $$
begin
  if bucket<>'article:watchdog' or max_calls<>1 or window_secs<>55 then raise exception 'Invalid watchdog rate contract'; end if;
  return (select allowed from public.watchdog_test_budget);
end $$;
\i :migration_file

do $$
declare r net.test_requests; stamp text; signature text; token text:=repeat('a7',32);
begin
  if public.wake_pending_article_jobs() then raise exception 'Idle watchdog sent request'; end if;
  if exists(select 1 from net.test_requests) then raise exception 'Idle watchdog queued HTTP'; end if;
  if (select command from cron.test_jobs)<>'select public.wake_pending_article_jobs();' or (select schedule from cron.test_jobs)<>'* * * * *' then raise exception 'Invalid cron schedule'; end if;
  if has_function_privilege('anon','public.wake_pending_article_jobs()','execute') or has_function_privilege('authenticated','public.wake_pending_article_jobs()','execute') then raise exception 'Public watchdog privilege leaked'; end if;
  if not has_function_privilege('service_role','public.wake_pending_article_jobs()','execute') then raise exception 'Missing internal watchdog privilege'; end if;
  insert into public.article_jobs values('queued',clock_timestamp()-interval '1 second',null);
  begin
    perform public.wake_pending_article_jobs();
    raise exception 'Missing configuration accepted';
  exception when raise_exception then
    if sqlerrm<>'Article watchdog configuration is missing or invalid' then raise; end if;
  end;
  insert into vault.decrypted_secrets values('trumpedia_project_url','https://abcdefghijklmnopqrst.supabase.co'),('trumpedia_anon_key','public-test-anon-JWT-value'),('trumpedia_article_worker_token',token);
  insert into public.article_worker_slots values(clock_timestamp()+interval '1 minute'),(clock_timestamp()+interval '1 minute');
  if public.wake_pending_article_jobs() then raise exception 'Busy watchdog sent request'; end if;
  if exists(select 1 from net.test_requests) then raise exception 'Busy watchdog queued HTTP'; end if;
  update public.article_worker_slots set expires_at=clock_timestamp()-interval '1 second';
  if not public.wake_pending_article_jobs() then raise exception 'Due watchdog did not send request'; end if;
  select * into strict r from net.test_requests;
  stamp:=r.headers->>'x-trumpedia-worker-timestamp'; signature:=r.headers->>'x-trumpedia-worker-signature';
  if signature<>encode(extensions.hmac(stamp||'.work',token,'sha256'),'hex') then raise exception 'Invalid worker HMAC'; end if;
  if r.url<>'https://abcdefghijklmnopqrst.supabase.co/functions/v1/article' or r.body<>jsonb_build_object('action','work') or r.timeout_ms<>5000 then raise exception 'Invalid HTTP contract'; end if;
  if position(token in r.headers::text)>0 or position(token in (select command from cron.test_jobs))>0 then raise exception 'Worker token leaked'; end if;
  if r.headers->>'Authorization'<>'Bearer public-test-anon-JWT-value' then raise exception 'Unexpected gateway credential'; end if;
  truncate net.test_requests;
  update public.article_jobs set next_run_at=clock_timestamp()+interval '1 minute';
  if public.wake_pending_article_jobs() then raise exception 'Future retry woken prematurely'; end if;
  update public.article_jobs set status='running',lease_expires_at=clock_timestamp()-interval '1 second';
  if not public.wake_pending_article_jobs() then raise exception 'Expired worker was not recovered'; end if;
  truncate net.test_requests;
  update public.watchdog_test_budget set allowed=false;
  if public.wake_pending_article_jobs() then raise exception 'Wake budget ignored'; end if;
  if exists(select 1 from net.test_requests) then raise exception 'Denied watchdog queued HTTP'; end if;
end $$;
rollback;
\echo Watchdog SQL contract passed
