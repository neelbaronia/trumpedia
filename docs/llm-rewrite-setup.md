# xAI Rewrite Setup

## 1) Set environment variables
In your shell:

```bash
export XAI_API_KEY="<your_xai_key>"
export XAI_MODEL="grok-4-1-fast"
```

Optional API base override:

```bash
export XAI_API_BASE_URL="https://api.x.ai/v1"
```

Optional frontend override (defaults to `http://127.0.0.1:8787/api/rewrite`):

```bash
export VITE_REWRITE_API_URL="http://127.0.0.1:8787/api/rewrite"
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
- If rewrite API is unavailable, the app falls back to local heuristic rewriting.
- The HTML structure, links, and images are preserved by only rewriting text nodes.
