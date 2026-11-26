# Production deployment

Trumpedia uses GitHub Pages for the static website and the existing Supabase project for server-owned article generation. Deploy storage and Edge Functions before the website.

## Release checks

```sh
npm ci
npm test
npm run lint
npm run build
```

The test suite uses offline model fixtures. A release also needs a small real article generation, a second cached visit, and browser checks for progressive content, links, back/forward and mobile layout. Do not run a bulk job as a smoke test.

## Storage and functions

Apply the additive migration in `supabase/migrations`. Existing articles are retained. New job tables and worker/provider budget procedures are service-role only. Public clients read job snapshots through the article function; they cannot write cache entries or worker state.

Deploy `article`, `rewrite`, and `opinion` to the linked Supabase project. The existing `XAI_API_KEY`, optional `XAI_MODEL` (default `grok-4.3`), optional `XAI_REASONING_EFFORT` (default `none` for that model), and optional `XAI_API_BASE_URL` remain server-side secrets. The Supabase runtime supplies the service-role credential; never put it in a frontend or bulk-client environment variable.

The article function allows public requests at its gateway and enforces its own bounded admission and worker authentication. Its internal continuation action rejects unsigned public requests. Legacy generation endpoints enforce the shared provider budget and fail closed when budget storage is unavailable.

Apply the second watchdog migration and provision its scoped worker token in Vault and the Edge environment as described in [worker watchdog setup](worker-watchdog.md). A minute cron check recovers due jobs after a platform interruption; idle checks make no model or HTTP calls. The token can only wake already admitted work.

## Website

GitHub Actions publishes tested pushes to `main`. Existing secrets:

- `VITE_SUPABASE_URL`: public project URL.
- `VITE_SUPABASE_ANON_KEY`: public project key; this is not a server credential.
- `VITE_REWRITE_API_URL`: existing compatibility endpoint, used to derive `/article` when no explicit article URL is set.
- `VITE_ARTICLE_API_URL`: optional explicit article endpoint.

`public/CNAME` keeps the custom domain. Confirm the published site uses the new version, not just a successful local build.

## Limits and recovery

The current service permits two article workers and four body batches per worker, with a shared maximum of eight provider calls and a 5,000-call daily backstop shared with legacy endpoints. Calls have a 25-second attempt deadline. Jobs checkpoint each completed batch, stop after their overall deadline, and expose partial/failed state rather than claiming success. Provider errors retain retryability and Retry-After.

Admission is bounded by queue size, global daily/minute limits and a per-client minute limit. Cached reads do not spend model calls. Manual retries are bounded too. Tune limits in the shared job module and SQL together, and verify both with tests.

Set `ARTICLE_GENERATION_ENABLED=false` in the server/Edge environment to pause model calls while keeping finished cached pages available. Re-enable it only after provider access and the selected model/budget are settled. The release was verified with cached desktop/mobile pages and unattended recovery; fresh generation was blocked by the provider account's credits/spending-limit restriction, so no live generation speed claim is made.

If a worker disappears, its lease expires and the job can be claimed again. A stale worker cannot overwrite a newer checkpoint. Browser navigation cancels the watcher; it does not cancel the shared job. Retry retains successful outputs.

If generation fails after release, inspect sanitized function logs and job metrics first. Check Wikipedia availability, model credentials, provider rate limits and SQL RPC grants. Do not print API keys or raw provider error bodies. Keep the additive schema on rollback; old article rows remain available.
