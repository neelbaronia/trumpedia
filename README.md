# Trumpedia

A parody Wikipedia reader: paste an article URL and get a satirical rewrite, with the original links and article structure preserved. Generated text is entertainment, not a factual source.

Live: [trumpedia.org](https://trumpedia.org)

## Local development

Requires Node 20.19+ (Node 22 recommended).

1. Run `npm ci`.
2. Copy `.env.local.example` to `.env.local` and set `XAI_API_KEY`.
3. Run `npm run dev:rewrite` for the article service, then `npm run dev` for the website.
4. Open the URL printed by Vite.

The local service uses in-memory shared jobs; restarting it discards development jobs. Production uses durable Supabase storage. API secrets stay in the server environment; only public frontend settings use the `VITE_` prefix.

## Generation

- Prose is rewritten paragraph by paragraph. Source-owned `<keep>` atoms preserve whole links, labels, citations and inline formatting. Whole labelled atoms can move within their formatting zone; empty formatting boundaries remain ordered. The server restores the original HTML and escapes generated prose.
- A reviewed, structured `admire`/`question` policy guides the article's voice. The model extracts factual notes before writing fresh prose. Stable paragraph-position hints vary rhythm and aside placement without forcing a stock opinion into every ending. The displayed stance and each rewritten paragraph must pass separate source-fidelity and viewpoint review, including private assertion alignment, before publication.
- Simple first paragraph drafts use `grok-4.3` with reasoning disabled. Initial and repaired stances, paragraphs with at least six protected atoms or more than 800 source characters, repair drafts, and independent semantic reviews use `grok-4.7` with low reasoning. Deterministic checks reject copied prose, changed numeric expressions and damaged protected atoms.
- Approved rewritten sections appear progressively. Unreviewed drafts stay private and survive worker interruptions, so a later worker can review them without buying the same draft again. Body and stance repairs retain bounded, cumulative correction feedback and the latest rejected draft, including across manual retries. Partial results remain labelled and explicit retries retain approved passages.
- Canonical URL, planner version, prompt version, writer and reviewer identify one shared job. Unversioned legacy rewrites are not imported as verified output. Historical rows remain intact; a new quality version generates from original Wikipedia source.
- Navigation, references, tables, code and other non-prose content remain source content. Workers, calls, queues, retries and deadlines are bounded. Closing a browser stops its watcher while the shared server job continues.

The current version key is `paragraphs-v5:trumpedia-blocks-v6:grok-4.3:grok-4.7`. Current-version cache hits require no new model calls. Generation plus independent review adds cost and latency: for a page with N eligible paragraph blocks, a successful run without retries normally uses two stance calls and two calls per block. Model reviews can still miss errors; use the original Wikipedia page for factual reference. No fixed generation-time or speedup guarantee is implied.

Stronger paragraph drafts and repairs have a bounded 75-second provider deadline; opinion, review and ordinary/legacy rewrite calls retain 45-second deadlines. Durable stages keep slow generation separate from review. Worker limits and recovery details are in the [deployment notes](docs/DEPLOYMENT.md#limits-and-recovery).

Job metrics report actual call counts, provider time, token usage and cost metadata returned by the provider, including paid failed attempts when that metadata is available. Costs are not estimated from text length or request counts.

## Verification

```sh
npm test
npm run lint
npm run build
```

Tests cover factual/copy guards, protected atoms, semantic-review gates, private pending stages, versioned caches, timeouts, retry feedback, progressive rendering, cancellation, navigation and HTML safety. GitHub Pages runs tests, lint and the production build before publishing. See the [release verification record](docs/DEPLOYMENT.md#release-verification) for the distinction between offline tests, local model evaluations and production checks.

## Deployment

The website is published from `main` through `.github/workflows/deploy.yml`; `public/CNAME` preserves the custom domain. Configure the public Supabase URL/key and optional article endpoint in GitHub Actions secrets. No server credential belongs in the frontend build.

Supabase Edge Functions implement `article` plus backward-compatible `rewrite` and `opinion` endpoints. Apply the additive SQL migrations before deploying the functions. The article service uses the project's server-only service-role credential. See [deployment notes](docs/DEPLOYMENT.md) for release steps and operational limits.

## Bulk processing

`npm run bulk:trumpify -- --help` describes the bulk client. It uses the same bounded, resumable article service as the website; it does not write article cache rows directly. Optional notifications require `NTFY_TOPIC` and are disabled by default.
