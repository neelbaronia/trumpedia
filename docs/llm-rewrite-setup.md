# Local generation setup

Copy `.env.local.example` to `.env.local`, set `XAI_API_KEY`, and run `npm ci`. The default model is `grok-4-1-fast`; `XAI_MODEL` and `XAI_API_BASE_URL` can override it on the server.

Run `npm run dev:rewrite` and `npm run dev` in separate terminals. The frontend uses `http://127.0.0.1:8787/api/article`; `/api/rewrite` and `/api/opinion` remain compatibility endpoints. `GET /health` reports configuration status without exposing credentials.

The server loads `.env.local` then `.env`, preserving values already set in the shell. No model API key goes into a `VITE_` variable or browser bundle.

Local jobs use memory storage. They survive browser navigation but disappear when the development server restarts. Production jobs use Supabase checkpoints and a separate recovery watchdog.

The browser displays finished sections progressively. Generation errors preserve completed work and offer a bounded retry; unchanged source text is never silently presented as a successful model rewrite. HTML, links and formatting are protected through sanitized templates and validated inline markers.

See [deployment notes](DEPLOYMENT.md) and the [worker watchdog](worker-watchdog.md) for production setup.
