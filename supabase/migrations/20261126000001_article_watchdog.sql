-- A small independent watchdog recovers durable jobs after an interrupted Edge continuation.
-- Vault values are provisioned separately; no credential is embedded in the cron command.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create function public.wake_pending_article_jobs()
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare project_url text; anon_key text; worker_token text; stamp text; signature text;
begin
  if not pg_try_advisory_xact_lock(884202,5) then return false; end if;
  if not exists (
    select 1 from public.article_jobs
    where (status='queued' and next_run_at<=clock_timestamp())
       or (status='running' and lease_expires_at<=clock_timestamp())
  ) then return false; end if;
  if (select count(*) from public.article_worker_slots where expires_at>clock_timestamp())>=2 then return false; end if;

  select decrypted_secret into project_url from vault.decrypted_secrets where name='trumpedia_project_url';
  select decrypted_secret into anon_key from vault.decrypted_secrets where name='trumpedia_anon_key';
  select decrypted_secret into worker_token from vault.decrypted_secrets where name='trumpedia_article_worker_token';
  if project_url is null or project_url !~ '^https://[a-z0-9]+[.]supabase[.]co/?$'
     or anon_key is null or length(anon_key)<20
     or worker_token is null or worker_token !~ '^[A-Fa-f0-9]{64}$' then
    raise exception 'Article watchdog configuration is missing or invalid';
  end if;
  if not public.take_rate_budget('article:watchdog',1,55) then return false; end if;

  stamp:=floor(extract(epoch from clock_timestamp()))::bigint::text;
  signature:=encode(extensions.hmac(stamp||'.work',worker_token,'sha256'),'hex');
  perform net.http_post(
    url:=rtrim(project_url,'/')||'/functions/v1/article',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'apikey',anon_key,'Authorization','Bearer '||anon_key,
      'x-trumpedia-worker-timestamp',stamp,'x-trumpedia-worker-signature',signature
    ),
    body:=jsonb_build_object('action','work'),
    timeout_milliseconds:=5000
  );
  return true;
end $$;
revoke all on function public.wake_pending_article_jobs() from public,anon,authenticated;
grant execute on function public.wake_pending_article_jobs() to service_role;

select cron.schedule('trumpedia-article-watchdog','* * * * *','select public.wake_pending_article_jobs();');
