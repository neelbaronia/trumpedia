-- Earlier releases correctly stopped automatic attempts after provider account/config rejection,
-- but also hid manual recovery. Keep the terminal status, source and every saved output intact.
update public.article_jobs j
set retryable=true,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
where j.status in ('failed','partial') and not j.retryable and (
  j.state->'opinionFailure'->>'code' in ('provider_auth','provider_not_configured')
  or exists (
    select 1 from jsonb_each(coalesce(j.state->'failures','{}'::jsonb)) f
    where f.value->>'code' in ('provider_auth','provider_not_configured')
  )
);
