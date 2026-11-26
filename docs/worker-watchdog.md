# Article worker watchdog

Normal generation continues through bounded Edge self-requests. A separate Supabase cron job checks every minute and recovers due queued jobs or expired worker leases. Idle checks send no HTTP request and never call a model. Existing worker leases, queue admission, and the shared 5,000-call daily provider budget still apply.

The additive `20261126000001_article_watchdog.sql` migration enables `pg_cron` and `pg_net`. It uses the existing Vault and `extensions.hmac` from pgcrypto. The cron command contains only a function call, with no credential. The function and its underlying job state remain inaccessible to public clients.

Before activating this release, provision the same random 32-byte value, encoded as 64 hexadecimal characters, in both places:

- Edge secret `ARTICLE_WORKER_TOKEN`.
- Vault secret named `trumpedia_article_worker_token`.

Also provision Vault secrets `trumpedia_project_url` (the project's HTTPS `.supabase.co` URL) and `trumpedia_anon_key` (its public legacy anon JWT). The public article function uses `verify_jwt = false` and enforces admission itself. The anon key is public gateway metadata; only a valid signed `work` action or internal service credential can wake the queue. A worker signature cannot admit jobs, call storage, or authorize another article action.

Create or update Vault entries with `vault.create_secret` / `vault.update_secret` through the trusted provisioning connection. Generate the token without printing it. Use a private, temporary environment file for `supabase secrets set --env-file`, and delete the file afterward. Do not place the value in a migration, command history, application logs, or the browser build.

Requests contain a timestamp and HMAC-SHA256 signature of `<timestamp>.work`, valid for five minutes. The token stays in Vault and the Edge environment; even pg_net's transient request queue contains only a signature and the public anon key. Replayed valid wakes are bounded and idempotent through the database leases.

After deployment, verify only non-sensitive metadata:

```sql
select jobname,schedule,active from cron.job where jobname='trumpedia-article-watchdog';
select status,count(*) from public.article_jobs group by status;
select status,return_message from cron.job_run_details
where jobid=(select jobid from cron.job where jobname='trumpedia-article-watchdog')
order by start_time desc limit 5;
```

To pause only the watchdog without changing saved jobs:

```sql
select cron.alter_job((select jobid from cron.job where jobname='trumpedia-article-watchdog'),active:=false);
```

Rotate the token in both Vault and the Edge secret together after copying/restoring the database or if it is exposed. A copy with an old token cannot wake the production receiver after rotation.

The native SQL contract test can substitute local `net.http_post` and `cron.schedule` stubs while using real pgcrypto. It should assert idle/busy checks make zero requests; due/expired work produces one signed request; public roles cannot execute the watchdog; no token or service-role key appears in the queued headers; and the signature matches the receiver helper.
