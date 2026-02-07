# Trumpedia Implementation Plan

## Goal
Build a site that:
- Looks like Wikipedia's landing search page.
- Accepts a pasted Wikipedia article URL.
- Recreates that article page with the same links and images.
- Rewrites article prose in a "Donald Trump wrote it" voice.

## Phase 0: Foundation and Scope
### Deliverables
- Product constraints documented (parody/disclaimer, rate limits, supported URLs).
- MVP acceptance criteria.

### Tools
- Project docs in Markdown (`docs/`).
- GitHub Issues/Project board for phase tracking.

## Phase 1: Frontend Shell (Wikipedia-like Landing)
### Deliverables
- Centered landing page with Wikipedia-inspired search layout.
- Input accepts full Wikipedia URLs.
- Validation and user feedback for invalid links.

### Tools
- React + TypeScript + Vite.
- Tailwind CSS for styling.

## Phase 2: Wikipedia Ingestion Pipeline
### Deliverables
- Parse a Wikipedia URL into page title/language.
- Fetch source article HTML via MediaWiki API.
- Normalize internal links and media URLs so they remain functional.

### Tools
- MediaWiki API (`action=parse` with `origin=*`).
- Browser `DOMParser` + tree transforms.

## Phase 3: Text Rewriting Engine (Content Transform)
### Deliverables
- Rewrite text nodes while preserving DOM structure, links, and images.
- Skip references/code/math/template-like blocks.
- Pluggable rewrite provider interface:
  - Local heuristic mode for development.
  - LLM-backed mode for production-quality voice.

### Tools
- DOM traversal (`TreeWalker`).
- Provider abstraction (`rewriteText` interface).
- Optional LLM backend (OpenAI/Anthropic via server endpoint).

## Phase 4: Article Rendering Experience
### Deliverables
- Wikipedia-like article presentation with source attribution.
- Loading/error states.
- "View original" link and rewrite disclaimer.

### Tools
- React state machine for `landing/loading/article/error`.
- Scoped article styles for MediaWiki HTML classes.

## Phase 5: Backend Hardening for LLM Rewrites
### Deliverables
- Secure server endpoint for rewrite requests (no API keys in browser).
- Chunking + caching + retry logic for long pages.
- Abuse/rate limiting.

### Tools
- Node backend (Express/Fastify or serverless function).
- Redis/Upstash for cache + rate limiting.
- Observability (structured logs + error monitoring).

## Phase 6: Quality, Testing, and Launch
### Deliverables
- Unit tests for URL parsing, HTML transforms, and rewrite filtering.
- Integration test for end-to-end URL -> rewritten render.
- Deployment pipeline.

### Tools
- Vitest + Testing Library.
- Playwright for E2E.
- Vercel/Netlify/Cloudflare Pages + CI.

## Immediate Build Order (starting now)
1. Implement landing page and URL validation.
2. Implement Wikipedia fetch and HTML normalization.
3. Implement DOM-preserving text rewrite pipeline (local heuristic mode).
4. Render rewritten article with links/images intact and production-ready states.
5. Add integration points for a future server-side LLM rewrite API.
