-- Durable, versioned article cache and a bounded generation queue. Existing articles survive.
-- The browser reads status through the article function; it cannot write jobs or cached HTML.
create table public.article_jobs (
  id uuid primary key,
  url text not null check (length(url) <= 2048),
  version text not null check (length(version) <= 200),
  lang text not null,
  title text not null,
  status text not null check (status in ('queued','running','complete','partial','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  next_run_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  paid boolean not null default true,
  request_key text not null,
  manual_retries int not null default 0,
  retry_window_at timestamptz not null default now(),
  progress int not null default 0,
  completed int not null default 0,
  total int not null default 0,
  failed_count int not null default 0,
  retryable boolean not null default true,
  error text,
  state jsonb not null default '{}'::jsonb,
  unique (url,version)
);
create index article_jobs_queue on public.article_jobs(next_run_at,created_at) where status='queued';
create index article_jobs_expired on public.article_jobs(lease_expires_at) where status='running';
create index article_jobs_recent on public.article_jobs(version,updated_at desc) where status='complete';
create index article_jobs_admissions on public.article_jobs(created_at) where paid;
create index article_jobs_client_admissions on public.article_jobs(request_key,created_at) where paid;

create table public.article_aliases(alias_url text primary key, url text not null);
create table public.article_worker_slots(owner uuid primary key, job_id uuid not null references public.article_jobs(id), expires_at timestamptz not null);
create table public.article_provider_slots(owner uuid primary key, expires_at timestamptz not null);
create table public.article_rate_budgets(bucket text primary key, calls int not null, expires_at timestamptz not null);
create index article_rate_budgets_expiry on public.article_rate_budgets(expires_at);
create table public.article_generation_limits (
  singleton boolean primary key default true check(singleton),
  max_queued int not null default 20 check(max_queued between 1 and 100),
  max_new_per_minute int not null default 6 check(max_new_per_minute between 1 and 60),
  max_new_per_day int not null default 100 check(max_new_per_day between 1 and 1000),
  max_per_client_minute int not null default 3 check(max_per_client_minute between 1 and 20)
);
insert into public.article_generation_limits(singleton) values(true);

alter table public.article_jobs enable row level security;
alter table public.article_aliases enable row level security;
alter table public.article_worker_slots enable row level security;
alter table public.article_provider_slots enable row level security;
alter table public.article_rate_budgets enable row level security;
alter table public.article_generation_limits enable row level security;
revoke all on public.article_jobs,public.article_aliases,public.article_worker_slots,public.article_provider_slots,public.article_rate_budgets,public.article_generation_limits from public,anon,authenticated;
grant all on public.article_jobs,public.article_aliases,public.article_worker_slots,public.article_provider_slots,public.article_rate_budgets,public.article_generation_limits to service_role;
-- The old browser writer is retired. Public, sanitized reads remain compatible.
drop policy if exists "Allow public insert access" on public.articles;
revoke insert,update,delete,truncate,references,trigger on public.articles from public,anon,authenticated;
grant select on public.articles to anon,authenticated;
grant all on public.articles to service_role;

create function public.take_rate_budget(bucket text,max_calls int,window_secs int)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare n int;
begin
  if bucket is null or length(bucket)>180 or max_calls<1 or max_calls>10000 or window_secs<1 or window_secs>86400 then return false; end if;
  perform pg_advisory_xact_lock(884202,1);
  delete from public.article_rate_budgets where expires_at <= clock_timestamp();
  if not exists(select 1 from public.article_rate_budgets b where b.bucket=take_rate_budget.bucket)
     and (select count(*) from public.article_rate_budgets)>=10000 then return false; end if;
  insert into public.article_rate_budgets as b(bucket,calls,expires_at)
    values(take_rate_budget.bucket,1,clock_timestamp()+make_interval(secs=>window_secs))
    on conflict on constraint article_rate_budgets_pkey do update set calls=b.calls+1 where b.calls<max_calls returning calls into n;
  return n is not null;
end $$;

create function public.claim_provider_slot(owner uuid,lease_secs int default 35)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if owner is null then return false; end if;
  perform pg_advisory_xact_lock(884202,2);
  delete from public.article_provider_slots where expires_at<=clock_timestamp();
  if exists(select 1 from public.article_provider_slots s where s.owner=claim_provider_slot.owner) then return true; end if;
  if (select count(*) from public.article_provider_slots)>=8 then return false; end if;
  insert into public.article_provider_slots values(owner,clock_timestamp()+make_interval(secs=>greatest(1,least(35,lease_secs))));
  return true;
end $$;
create function public.release_provider_slot(owner uuid)
returns void language sql security definer set search_path=pg_catalog,public as $$
  delete from public.article_provider_slots s where s.owner=release_provider_slot.owner;
$$;

create function public.admit_article_job(initial_job jsonb,alias_url text,request_key text,paid boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.article_jobs; limits public.article_generation_limits; at timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(884202,3);
  select * into j from public.article_jobs where url=initial_job->>'url' and version=initial_job->>'version';
  if found then
    insert into public.article_aliases values(alias_url,j.url) on conflict on constraint article_aliases_pkey do update set url=excluded.url;
    return to_jsonb(j);
  end if;
  select * into strict limits from public.article_generation_limits where singleton;
  if paid and (
    (select count(*) from public.article_jobs where status in ('queued','running'))>=limits.max_queued or
    (select count(*) from public.article_jobs aj where aj.paid and aj.created_at>at-interval '1 minute')>=limits.max_new_per_minute or
    (select count(*) from public.article_jobs aj where aj.paid and aj.created_at>at-interval '1 day')>=limits.max_new_per_day or
    (select count(*) from public.article_jobs aj where aj.paid and aj.request_key=admit_article_job.request_key and aj.created_at>at-interval '1 minute')>=limits.max_per_client_minute
  ) then raise exception using errcode='P0003',message='Article admission budget exceeded'; end if;
  insert into public.article_jobs(id,url,version,lang,title,status,created_at,updated_at,next_run_at,deadline_at,paid,request_key,state)
    values((initial_job->>'id')::uuid,initial_job->>'url',initial_job->>'version',initial_job->>'lang',initial_job->>'title',initial_job->>'status',at,at,at,at+interval '12 minutes',paid,left(request_key,100),initial_job)
    returning * into j;
  -- Reused legacy HTML has no worker, but still needs accurate status metadata.
  update public.article_jobs set completed=(select count(*) from jsonb_object_keys(coalesce(state->'outputs','{}'))),
    total=jsonb_array_length(coalesce(state->'plan'->'blocks','[]')),
    progress=case when status='complete' then 100 else 0 end where id=j.id returning * into j;
  insert into public.article_aliases values(alias_url,j.url) on conflict on constraint article_aliases_pkey do update set url=excluded.url;
  return to_jsonb(j);
end $$;

create function public.claim_article_job(owner uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.article_jobs; at timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(884202,4);
  delete from public.article_worker_slots where expires_at<=at;
  if (select count(*) from public.article_worker_slots)>=2 then return null; end if;
  select * into j from public.article_jobs
    where (status='queued' and next_run_at<=at) or (status='running' and lease_expires_at<=at)
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.article_jobs set status='running',lease_token=owner,lease_expires_at=at+interval '100 seconds',updated_at=at where id=j.id returning * into j;
  insert into public.article_worker_slots values(owner,j.id,at+interval '100 seconds');
  return to_jsonb(j);
end $$;

create function public.checkpoint_article_job(job_id uuid,owner uuid,patch jsonb,output_patch jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.article_jobs; state2 jsonb; done int; n int; failures int; at timestamptz:=clock_timestamp();
begin
  select * into j from public.article_jobs where id=job_id for update;
  if not found or j.lease_token is distinct from owner or j.lease_expires_at<=at then raise exception using errcode='P0002',message='Stale article worker'; end if;
  state2:=j.state||coalesce(patch,'{}');
  state2:=jsonb_set(state2,'{outputs}',coalesce(j.state->'outputs','{}')||coalesce(output_patch,'{}'));
  select count(*) into done from jsonb_object_keys(state2->'outputs');
  n:=jsonb_array_length(coalesce(state2->'plan'->'blocks','[]'));
  select count(*) into failures from jsonb_each(coalesce(state2->'failures','{}')) f where f.value->>'terminal'='true';
  update public.article_jobs set state=state2,title=coalesce(patch->>'title',title),
    updated_at=greatest(at,updated_at+interval '1 microsecond'),lease_expires_at=at+interval '100 seconds',
    completed=done,total=n,failed_count=failures,progress=case when n=0 then 0 else least(99,done*100/n) end,
    error=case when patch?'error' then patch->>'error' else error end,
    retryable=coalesce((patch->>'retryable')::boolean,retryable)
    where id=job_id returning * into j;
  update public.article_worker_slots s set expires_at=at+interval '100 seconds' where s.owner=checkpoint_article_job.owner;
  return jsonb_build_object('updated_at',j.updated_at);
end $$;

create function public.finish_article_job(job_id uuid,owner uuid,patch jsonb,article jsonb default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.article_jobs; at timestamptz:=clock_timestamp(); metrics jsonb;
begin
  select * into j from public.article_jobs where id=job_id for update;
  if not found or j.lease_token is distinct from owner or j.lease_expires_at<=at then raise exception using errcode='P0002',message='Stale article worker'; end if;
  if patch->>'status' not in ('complete','partial','failed') then raise exception 'Invalid terminal status'; end if;
  metrics:=coalesce(j.state->'metrics','{}')||jsonb_build_object('elapsedMs',greatest(0,extract(epoch from at-j.created_at)*1000),'completedAt',at);
  update public.article_jobs set state=(state||patch)||jsonb_build_object('metrics',metrics),status=patch->>'status',
    error=patch->>'error',retryable=coalesce((patch->>'retryable')::boolean,true),
    progress=case when patch->>'status'='complete' then 100 else progress end,
    updated_at=greatest(at,updated_at+interval '1 microsecond'),lease_token=null,lease_expires_at=null where id=job_id;
  delete from public.article_worker_slots s where s.owner=finish_article_job.owner;
  -- Rendered output is derived from versioned plan + validated block checkpoints. Avoid storing HTML twice.
end $$;

create function public.release_article_job(job_id uuid,owner uuid,next_run timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.article_jobs set status='queued',next_run_at=next_run,lease_token=null,lease_expires_at=null,
    updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
    where id=job_id and lease_token=owner and status='running';
  delete from public.article_worker_slots s where s.owner=release_article_job.owner;
end $$;

create function public.retry_article_job(job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.article_jobs; retries int; at timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(884202,3);
  select * into j from public.article_jobs where id=job_id for update;
  if not found then return null; end if;
  if j.status not in ('partial','failed') or not j.retryable then return to_jsonb(j); end if;
  if (select count(*) from public.article_jobs where status in ('queued','running')) >= (select max_queued from public.article_generation_limits where singleton) then raise exception using errcode='P0003',message='Article queue exceeded'; end if;
  retries:=case when j.retry_window_at<=at-interval '1 day' then 0 else j.manual_retries end;
  if retries>=3 then raise exception using errcode='P0004',message='Article retry budget exceeded'; end if;
  if not public.take_rate_budget('article:retries:global',6,60) then raise exception using errcode='P0003',message='Article retry budget exceeded'; end if;
  update public.article_jobs set status='queued',retryable=true,error=null,manual_retries=retries+1,
    retry_window_at=case when retries=0 then at else retry_window_at end,
    next_run_at=at,deadline_at=at+interval '12 minutes',updated_at=greatest(at,updated_at+interval '1 microsecond'),
    state=state||jsonb_build_object('failures','{}'::jsonb,'opinionFailure',null,'sourceFailure',null,'error',null)
    where id=job_id returning * into j;
  return to_jsonb(j);
end $$;

create function public.next_article_wake()
returns timestamptz language sql security definer set search_path=pg_catalog,public as $$
  select min(case when status='running' then lease_expires_at else next_run_at end) from public.article_jobs where status in ('queued','running');
$$;

-- Postgres grants EXECUTE to PUBLIC by default: explicitly close every privileged RPC.
revoke all on function public.take_rate_budget(text,int,int),public.claim_provider_slot(uuid,int),public.release_provider_slot(uuid),public.admit_article_job(jsonb,text,text,boolean),public.claim_article_job(uuid),public.checkpoint_article_job(uuid,uuid,jsonb,jsonb),public.finish_article_job(uuid,uuid,jsonb,jsonb),public.release_article_job(uuid,uuid,timestamptz),public.retry_article_job(uuid),public.next_article_wake() from public,anon,authenticated;
grant execute on function public.take_rate_budget(text,int,int),public.claim_provider_slot(uuid,int),public.release_provider_slot(uuid),public.admit_article_job(jsonb,text,text,boolean),public.claim_article_job(uuid),public.checkpoint_article_job(uuid,uuid,jsonb,jsonb),public.finish_article_job(uuid,uuid,jsonb,jsonb),public.release_article_job(uuid,uuid,timestamptz),public.retry_article_job(uuid),public.next_article_wake() to service_role;
