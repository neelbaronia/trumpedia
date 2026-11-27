-- Allow one bounded 45-second model request plus budget RPC/cleanup headroom.
-- Existing leases, the eight-slot cap, and rate budgets remain unchanged.
create or replace function public.claim_provider_slot(owner uuid,lease_secs int default 60)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if owner is null then return false; end if;
  perform pg_advisory_xact_lock(884202,2);
  delete from public.article_provider_slots where expires_at<=clock_timestamp();
  if exists(select 1 from public.article_provider_slots s where s.owner=claim_provider_slot.owner) then return true; end if;
  if (select count(*) from public.article_provider_slots)>=8 then return false; end if;
  insert into public.article_provider_slots values(owner,clock_timestamp()+make_interval(secs=>greatest(1,least(60,lease_secs))));
  return true;
end $$;

revoke all on function public.claim_provider_slot(uuid,int) from public,anon,authenticated;
grant execute on function public.claim_provider_slot(uuid,int) to service_role;
