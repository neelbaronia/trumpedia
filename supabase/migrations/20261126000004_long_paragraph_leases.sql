-- Allow one bounded 75-second strong-paragraph request plus budget RPC headroom.
-- Only future claims/checkpoints use the longer leases; existing rows are unchanged.
create or replace function public.claim_provider_slot(owner uuid,lease_secs int default 90)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if owner is null then return false; end if;
  perform pg_advisory_xact_lock(884202,2);
  delete from public.article_provider_slots where expires_at<=clock_timestamp();
  if exists(select 1 from public.article_provider_slots s where s.owner=claim_provider_slot.owner) then return true; end if;
  if (select count(*) from public.article_provider_slots)>=8 then return false; end if;
  insert into public.article_provider_slots values(owner,clock_timestamp()+make_interval(secs=>greatest(1,least(90,lease_secs))));
  return true;
end $$;

create or replace function public.claim_article_job(owner uuid)
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
  update public.article_jobs set status='running',lease_token=owner,lease_expires_at=at+interval '140 seconds',updated_at=at where id=j.id returning * into j;
  insert into public.article_worker_slots values(owner,j.id,at+interval '140 seconds');
  return to_jsonb(j);
end $$;

create or replace function public.checkpoint_article_job(job_id uuid,owner uuid,patch jsonb,output_patch jsonb)
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
    updated_at=greatest(at,updated_at+interval '1 microsecond'),lease_expires_at=at+interval '140 seconds',
    completed=done,total=n,failed_count=failures,progress=case when n=0 then 0 else least(99,done*100/n) end,
    error=case when patch?'error' then patch->>'error' else error end,
    retryable=coalesce((patch->>'retryable')::boolean,retryable)
    where id=job_id returning * into j;
  update public.article_worker_slots s set expires_at=at+interval '140 seconds' where s.owner=checkpoint_article_job.owner;
  return jsonb_build_object('updated_at',j.updated_at);
end $$;

revoke all on function public.claim_provider_slot(uuid,int),public.claim_article_job(uuid),public.checkpoint_article_job(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.claim_provider_slot(uuid,int),public.claim_article_job(uuid),public.checkpoint_article_job(uuid,uuid,jsonb,jsonb) to service_role;
