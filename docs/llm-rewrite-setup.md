# xAI Rewrite Setup

## 1) Create local env file
In project root:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local` and set at minimum:

```bash
XAI_API_KEY="<your_xai_key>"
XAI_MODEL="grok-4-1-fast"
```

Optional values:

```bash
XAI_API_BASE_URL="https://api.x.ai/v1"
REWRITE_PORT="8787"
VITE_REWRITE_API_URL="http://127.0.0.1:8787/api/rewrite"
```

## 2) Start rewrite API server

```bash
npm run dev:rewrite
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## 3) Start frontend dev server

```bash
npm run dev
```

## Notes
- The rewrite server auto-loads `.env.local` and `.env` from the project root.
- Existing shell environment variables still take precedence.
- If rewrite API is unavailable, the app falls back to local heuristic rewriting.
- HTML structure, links, and images are preserved because only text nodes are rewritten.
