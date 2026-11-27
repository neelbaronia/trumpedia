# Production deployment

Trumpedia uses GitHub Pages for the static website and the existing Supabase project for server-owned article generation. Deploy storage and Edge Functions before the website.

## Release checks

```sh
npm ci
npm test
npm run lint
npm run build
```

The test suite uses offline model fixtures; it verifies control flow and invariants rather than proving model quality. A release also needs a small real article generation, independent factual/link/style review, a second cached visit, and browser checks for progressive content, links, back/forward and mobile layout. Do not run a bulk job as a smoke test.

## Storage and functions

Apply the additive migrations in `supabase/migrations`, including `20261126000004_long_paragraph_leases.sql`, before deploying the extended paragraph deadline. This migration raises provider-slot leases to 90 seconds and worker leases to 140 seconds; its native SQL checks passed. Confirm it is applied before enabling the longer calls. Existing articles and historical job rows are retained. New job tables and worker/provider budget procedures are service-role only. Public clients read job snapshots through the article function; they cannot write cache entries or worker state.

Deploy `article`, `rewrite`, and `opinion` to the linked Supabase project. The existing `XAI_API_KEY`, optional `XAI_MODEL` (default `grok-4.3`), optional `XAI_REVIEW_MODEL` (default `grok-4.7`), optional `XAI_REASONING_EFFORT` (default `none` for the default writer), and optional `XAI_API_BASE_URL` remain server-side settings. The Supabase runtime supplies the service-role credential; never put it in a frontend or bulk-client environment variable.

The article function allows public requests at its gateway and enforces its own bounded admission and worker authentication. Its internal continuation action rejects unsigned public requests. Legacy generation endpoints enforce the shared provider budget and fail closed when budget storage is unavailable.

Apply the second watchdog migration and provision its scoped worker token in Vault and the Edge environment as described in [worker watchdog setup](worker-watchdog.md). A minute cron check recovers due jobs after a platform interruption; idle checks make no model or HTTP calls. The token can only wake already admitted work.

## Website

GitHub Actions publishes tested pushes to `main`. Existing secrets:

- `VITE_SUPABASE_URL`: public project URL.
- `VITE_SUPABASE_ANON_KEY`: public project key; this is not a server credential.
- `VITE_REWRITE_API_URL`: existing compatibility endpoint, used to derive `/article` when no explicit article URL is set.
- `VITE_ARTICLE_API_URL`: optional explicit article endpoint.

`public/CNAME` keeps the custom domain. Confirm the published site uses the new version, not just a successful local build.

## Quality and cache identity

The release uses planner `paragraphs-v5` and prompt `trumpedia-blocks-v6`. A cache key combines planner, prompt, writer and reviewer: `paragraphs-v5:trumpedia-blocks-v6:grok-4.3:grok-4.7` with default settings. Bump the appropriate version when changing planner or prompt quality rules; changing the reviewer also creates a separate cache version.

The planner owns immutable whole `<keep>` atoms. Their labels and restored hrefs must match source exactly. Labelled atoms may reorder only within zones separated by ordered empty formatting boundaries; citation placement is also reviewed against the source claim. Ordinary prose stays editable. Each paragraph's factual notes precede newly composed prose, guided by one cached, reviewed `admire`/`question` policy. Stable paragraph-position voice hints vary rhythm and aside placement while retaining that policy; they are soft stylistic directions, not permission to add facts or force an opinion.

Simple first paragraph drafts use the default writer with reasoning disabled. Initial opinion generation and opinion repairs use the stronger reviewer model. A first paragraph draft with at least six atoms or more than 800 source characters, and any paragraph repair draft, also uses that model. Opinion and body publication require separate semantic QA; these stronger-model operations default to `grok-4.7` with low reasoning. Deterministic copy, numeric and structural checks run before semantic acceptance. The semantic reviewer must privately align source assertions with candidate wording, identify unsupported candidate assertions, and preserve qualifiers, negation, dates and citation support before passing a result. Private alignment checks are not published as article content. These safeguards reduce errors but do not make generated parody a factual authority.

Only approved generated text enters published output. `pendingOpinion`, `pendingDrafts`, previous rejected drafts and cumulative repair feedback are private worker state. Both body `revisionContext` and stance `opinionRevisionContext` retain bounded, distinct correction rules and the latest rejected candidate across automatic and manual retries; approved replacements clear their correction context. An unavailable or interrupted review retains its unreviewed candidate for another bounded review attempt; a negative QA verdict sends it through the repair path. Approved passages and the reviewed article policy survive retries.

Unversioned legacy HTML and stances never seed verified current output. Fresh quality versions fetch original Wikipedia source. Historical rows remain readable with stored provenance; old pending jobs are fenced from new paid work, old-ID retries direct callers to the article URL, and the recent list contains current-version completed jobs. Do not relabel old output with current quality metadata.

## Limits and recovery

The service permits two article workers, four concurrent paragraph operations per worker, eight shared provider slots, and a 5,000-call daily backstop shared with legacy endpoints. Generation, review and failed paid attempts all consume the applicable call budget. Independent QA and repairs add model calls, cost and latency; model routing can also change per-call cost.

Stronger-model paragraph first drafts and paragraph repairs have a 75-second upstream deadline. Opinion generation, semantic review, ordinary paragraph generation and legacy rewrite calls retain 45-second deadlines. Shared provider-slot leases last 90 seconds. An article worker runs for at most 100 seconds with a 140-second worker lease, and starts a new operation only with at least 90 seconds left in its slice. Private pending candidates let generation and review finish in separate invocations instead of repeating successful generation.

The Edge entry skips an inline dispatch when request admission has already taken more than 15 seconds, and skips inline continuation when dispatch took at least 75 seconds. Status requests and the watchdog recover due work. This leaves room for storage and cleanup within the platform invocation limit; worker leases and saved stages also protect recovery after a platform interruption.

The browser watches for at most six minutes and each admitted job run has a twelve-minute deadline. Large articles, queued jobs and slow responses can exceed the watch window or reach a partial result at the job deadline. Continuing to watch reuses the existing job; an explicit retry resumes unfinished passages while retaining approved output. Both actions remain subject to shared financial limits. Do not extrapolate short-article timings to long pages or infer latency improvements from request counts.

Admission is bounded by queue size, global daily/minute limits and a per-client minute limit. Current-version cached reads do not spend model calls. Manual retries are bounded too. Tune limits in the shared job module and SQL together, and verify both with tests. Provider errors retain retryability and Retry-After.

Job metrics include actual models, call stages, provider time, token usage and returned `costUsdTicks`. Convert the returned cost total to USD by dividing ticks by 10,000,000,000. Missing cost metadata is not estimated. Count stance generation/review, paragraph generation/review, repairs and failed attempts when reporting a run's cost.

Set `ARTICLE_GENERATION_ENABLED=false` in the server/Edge environment to pause model calls while keeping finished current-version cached pages available. Re-enable it only after provider access and the selected models/budget are settled.

If a worker disappears, its lease expires and the job can be claimed again. A stale worker cannot overwrite a newer checkpoint. Browser navigation cancels the watcher; it does not cancel the shared job. Private pending candidates resume review, and approved outputs are retained.

If generation fails after release, inspect sanitized function logs and job metrics first. Check Wikipedia availability, model credentials, provider rate limits and SQL RPC grants. Do not print API keys, private pending drafts or raw provider error bodies. Keep the additive schema and historical rows on rollback; do not promote older unverified output into the current cache.

## Release verification

The current v6 checks passed 288 offline tests, lint, the production build and Deno checks for all three Edge functions. Thirteen real-model canary cases passed. Isolated PostgreSQL checks passed for the additive leases, existing-row retention, permissions, concurrency and expired-worker fencing. Independent production factual, citation, link and style audits passed for all 20 paragraphs across Petrissage, Oxford Electric Bell and Zarf. All 185 source href/label pairs were retained. Opinion introductions still share a somewhat formulaic sentence pattern; body paragraphs are substantively rephrased and their viewpoints are coherent. These checks reduce errors rather than guarantee factual correctness.

The following measurements used v6 quality rules. Petrissage and Oxford Electric Bell completed before the final 75-second paragraph transport upgrade; Zarf spans the old and new transport bounds. They include review, repairs, queueing, deployment/debug pauses and the stated resumes. They are observations rather than clean benchmarks of the final transport bounds or a before/after speed comparison.

| Article | Approved passages | Independent audit | Preserved source links | Actual model calls | Returned cost | Timing and recovery |
| --- | --- | --- | --- | --- | --- | --- |
| Petrissage | 5/5 | Facts/links passed; style acceptable | 37 | 24 | USD 0.2157559 | Observed elapsed 140.310 s. |
| Oxford Electric Bell | 6/6 | Facts/links passed; style acceptable | 77 | 24 | USD 0.21978415 | Observed elapsed 468.439 s, including 140.734 s queue time and one explicit resume. Initial run reached 4/6 in 335.027 s. |
| Zarf | 9/9 | Facts/citations/links/style passed | 71 | 62 | USD 0.572502 | Cumulative elapsed 1,079.994 s, including two explicit resumes and the transport deployment/debug pauses. Cold run reached 5/9 in 391.546 s; first resume reached 6/9. After the transport upgrade, the second resume added 12 calls, zero failed calls and three approved paragraphs, without regenerating the saved six. This is not a cold-generation benchmark. |

The audited Wikipedia revisions were Petrissage `1248802184`, Oxford Electric Bell `1376486765`, and Zarf `1357931675`. Current job provenance retains the source revision alongside planner, prompt, writer and reviewer versions.

A final repeated API visit returned the same completed jobs with unchanged call counts: Zarf 636 ms (62 calls), Petrissage 1,121 ms (24), and Oxford Electric Bell 407 ms (24). Earlier Petrissage reads also measured 506 ms. Full browser reloads reused approved output; citation navigation worked, and a 433-pixel narrow view had no document overflow. The browser's normal size was restored. Cached visits made zero model calls.

The final transport change was verified by the three previously timing-out Zarf paragraphs completing and passing review; it was not followed by paid regeneration of the other two approved pages. Request-timer tests cover all operation classes and explicit overrides. Returned costs include only provider-supplied billing metadata; timed-out requests without returned usage may also have incurred charges. No additional credit purchase or automatic top-up was enabled for these checks.
