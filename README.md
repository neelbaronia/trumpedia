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

- Prose is rewritten as contextual paragraphs, with stable block IDs and protected inline formatting. Navigation, references, tables, code and other non-prose content are preserved without spending model calls on them.
- The first batch produces the parody stance and starts the introduction. Finished sections appear while the remaining passages run.
- A canonical article and pipeline/model version share one job. The server checkpoints completed blocks; retries only request unfinished work. Closing a browser stops watching without cancelling work for other readers.
- Workers, request sizes, provider calls, retries, queues and generation deadlines are bounded. An interrupted worker can resume after its lease expires.
- Cache quality is explicit. Partial output is labelled and can be retried. A fully rewritten legacy article can be reused; if only its stance is missing, only that stance is generated.
- Source and cached HTML are sanitized; model text is escaped and cannot inject HTML. IDs and inline marker sequences must match before a batch is accepted.

Job responses include measured provider calls, provider time and token usage. These describe actual calls; they do not estimate speed from historical logs.

## Verification

```sh
npm test
npm run lint
npm run build
```

Tests cover provider timeouts and errors, strict structured outputs, jobs and checkpoints, cached pages, progressive rendering, cancellation, navigation and HTML safety. GitHub Pages runs tests, lint and the production build before publishing.

## Deployment

The website is published from `main` through `.github/workflows/deploy.yml`; `public/CNAME` preserves the custom domain. Configure the public Supabase URL/key and optional article endpoint in GitHub Actions secrets. No server credential belongs in the frontend build.

Supabase Edge Functions implement `article` plus backward-compatible `rewrite` and `opinion` endpoints. Apply the additive SQL migrations before deploying the functions. The article service uses the project's server-only service-role credential. See [deployment notes](docs/DEPLOYMENT.md) for release steps and operational limits.

## Bulk processing

`npm run bulk:trumpify -- --help` describes the bulk client. It uses the same bounded, resumable article service as the website; it does not write article cache rows directly. Optional notifications require `NTFY_TOPIC` and are disabled by default.
