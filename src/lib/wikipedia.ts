import { parseWikipediaUrl } from '../../supabase/functions/_shared/article-plan.mjs'
export { parseWikipediaUrl }

export type ParsedWikipediaUrl = ReturnType<typeof parseWikipediaUrl>
export type JobStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed'
export type ArticleActivity = { phase: 'source' | 'preparing' | 'writing' | 'reviewing' | 'revising'; drafted: number }
export type ArticleProgress = { status: JobStatus; jobId?: string; progress: number; completed?: number; total?: number; activity?: ArticleActivity }
export type ArticleSection = { id: string; title: string; html: string; complete: boolean }
export type WikipediaArticle = {
  title: string
  html: string
  canonicalUrl: string
  sourceApiUrl: string
  rewriteMode: 'llm' | 'llm-partial' | 'heuristic'
  opinion?: string
  sections?: ArticleSection[]
  status?: JobStatus
  jobId?: string
  progress?: number
  completed?: number
  total?: number
  failedCount?: number
  error?: string
  retryable?: boolean
  metrics?: Record<string, unknown>
}
type JobView = {
  jobId?: string
  status: JobStatus
  progress?: number | { completed: number; total: number }
  completed?: number
  total?: number
  updatedAt?: string
  unchanged?: boolean
  article?: WikipediaArticle
  error?: string
  retryable?: boolean
  activity?: ArticleActivity
}
type RequestOptions = {
  signal?: AbortSignal
  onUpdate?: (article: WikipediaArticle) => void
  onStatus?: (status: ArticleProgress) => void
  retry?: boolean
  fetch?: typeof fetch
  pollIntervalMs?: number
  watchTimeoutMs?: number
  requestTimeoutMs?: number
}
const MAX_WATCH_MS = 6 * 60_000
const MAX_REQUEST_MS = 15_000
const MAX_RESPONSE_BYTES = 8_000_000
const env = import.meta.env ?? {}
const ARTICLE_API_URL = env.VITE_ARTICLE_API_URL ||
  env.VITE_REWRITE_API_URL?.replace(/\/rewrite\/?$/, '/article') ||
  `${env.VITE_SUPABASE_URL || 'https://yzktkvixqboxmzdtzffb.supabase.co'}/functions/v1/article`

class ArticleApiError extends Error {
  status: number
  retryable: boolean
  retryAfter: number
  constructor(message: string, status: number, retryAfter = 0) {
    super(message)
    this.status = status
    this.retryable = status === 408 || status === 429 || status >= 500
    this.retryAfter = retryAfter
  }
}
class ArticleWatchTimeout extends Error {
  constructor() {
    super('This article is still being prepared. Open it again to continue watching the saved job.')
    this.name = 'ArticleWatchTimeout'
  }
}
function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError')
}
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    checkAborted(signal)
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Request cancelled.', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
async function waitWithinDeadline(ms: number, deadline: number, signal?: AbortSignal) {
  checkAborted(signal)
  if (Date.now() + ms >= deadline) throw new ArticleWatchTimeout()
  await wait(ms, signal)
  if (Date.now() >= deadline) throw new ArticleWatchTimeout()
}
function retryAfterSeconds(value: string | number | null | undefined) {
  if (value == null) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds))
  const date = Date.parse(String(value))
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 0
}
async function readResponse(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new ArticleApiError('The article response is too large.', 413)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new ArticleApiError('The article service returned an empty response.', 502)
  const chunks: Uint8Array[] = []
  let length = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    checkAborted(signal)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new ArticleApiError('The article response is too large.', 413)
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid response')
    return payload
  } catch { throw new ArticleApiError('The article service returned an unreadable response.', 502) }
}
async function request(body: Record<string, unknown>, options: RequestOptions = {}, deadline = Infinity) {
  checkAborted(options.signal)
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new ArticleWatchTimeout()
  const requestMs = Number.isFinite(options.requestTimeoutMs)
    ? Math.max(1, Math.min(options.requestTimeoutMs!, MAX_REQUEST_MS))
    : MAX_REQUEST_MS
  const controller = new AbortController()
  let cancel!: () => void
  let timeout!: ReturnType<typeof setTimeout>
  const limit = new Promise<never>((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(new DOMException('Request cancelled.', 'AbortError')) }
    options.signal?.addEventListener('abort', cancel, { once: true })
    timeout = setTimeout(() => {
      controller.abort()
      reject(remaining <= requestMs ? new ArticleWatchTimeout() : new ArticleApiError('The article service took too long to respond. Please try again.', 408))
    }, Math.min(requestMs, remaining))
  })
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.VITE_SUPABASE_ANON_KEY && ARTICLE_API_URL.includes('/functions/v1/')) {
      headers.apikey = env.VITE_SUPABASE_ANON_KEY
      headers.Authorization = `Bearer ${env.VITE_SUPABASE_ANON_KEY}`
    }
    return await Promise.race([limit, (async () => {
      const response = await (options.fetch || fetch)(ARTICLE_API_URL, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      })
      const payload = await readResponse(response, controller.signal)
      if (!response.ok) {
        throw new ArticleApiError(typeof payload.error === 'string' ? payload.error : 'The article service is temporarily unavailable.', response.status, retryAfterSeconds(response.headers.get('Retry-After') || payload.retryAfter))
      }
      return payload
    })()])
  } catch (error) {
    checkAborted(options.signal)
    if (error instanceof ArticleApiError || error instanceof ArticleWatchTimeout) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new ArticleApiError('The article service took too long to respond. Please try again.', 408)
    throw new ArticleApiError('Could not reach the article service. Please try again.', 503)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}
function articleFrom(view: JobView, previous?: WikipediaArticle): WikipediaArticle | undefined {
  if (!view.article && !previous) return undefined
  const counts = typeof view.progress === 'object' ? view.progress : undefined
  const progress = counts ? (counts.total ? counts.completed / counts.total * 100 : 0) : view.progress
  const article = {
    ...previous, ...view.article, status: view.status, jobId: view.jobId || previous?.jobId,
    progress: progress ?? previous?.progress,
    completed: view.completed ?? counts?.completed ?? view.article?.completed ?? previous?.completed,
    total: view.total ?? counts?.total ?? view.article?.total ?? previous?.total,
    error: view.error ?? view.article?.error,
    retryable: view.retryable ?? view.article?.retryable ?? previous?.retryable,
  } as WikipediaArticle
  if (article.sections) article.html = article.sections.filter(section => section.complete || ['complete', 'partial', 'failed'].includes(view.status)).map(section => section.html).join('')
  return article
}
export async function fetchAndRewriteArticle(
  input: string | ParsedWikipediaUrl,
  onProgress?: (progress: number) => void,
  options: RequestOptions = {},
): Promise<WikipediaArticle> {
  const url = typeof input === 'string' ? parseWikipediaUrl(input) : input
  const watchMs = Number.isFinite(options.watchTimeoutMs) ? Math.min(options.watchTimeoutMs!, MAX_WATCH_MS) : MAX_WATCH_MS
  const deadline = Date.now() + watchMs
  let view: JobView = await request({ action: options.retry ? 'retry' : 'start', url: url.canonicalUrl }, options, deadline)
  let article: WikipediaArticle | undefined
  let lastStatus: ArticleProgress | undefined
  let transientFailures = 0
  while (true) {
    checkAborted(options.signal)
    const counts = typeof view.progress === 'object' ? view.progress : undefined
    const completed = view.completed ?? counts?.completed ?? lastStatus?.completed
    const total = view.total ?? counts?.total ?? lastStatus?.total
    const progress = typeof view.progress === 'number' ? view.progress : view.status === 'complete' ? 100 : total ? (completed ?? 0) / total * 100 : lastStatus?.progress ?? 0
    lastStatus = { status: view.status, jobId: view.jobId ?? lastStatus?.jobId, progress, completed, total, activity: view.activity ?? lastStatus?.activity }
    options.onStatus?.(lastStatus)
    onProgress?.(progress)
    const next = articleFrom(view, article)
    if (next && !view.unchanged) { article = next; options.onUpdate?.(next) }
    if (view.status === 'complete' || view.status === 'partial') {
      if (!article) throw new Error('The article job finished without an article. Please retry.')
      return article
    }
    if (view.status === 'failed') throw new Error(view.error || 'Generation paused. Retry to continue from the saved sections.')
    if (!view.jobId) throw new Error('The article service did not return a job identifier.')
    await waitWithinDeadline(options.pollIntervalMs ?? (view.status === 'queued' ? 2500 : 1200), deadline, options.signal)
    try {
      const updated: JobView = await request({ action: 'status', jobId: view.jobId, updatedAt: view.updatedAt }, options, deadline)
      view = updated.unchanged ? { ...view, ...updated, article: undefined } : updated
      transientFailures = 0
    } catch (error) {
      if (!(error instanceof ArticleApiError) || !error.retryable || transientFailures >= 2) throw error
      transientFailures += 1
      await waitWithinDeadline(Math.max(error.retryAfter * 1000, 1000 * 2 ** transientFailures), deadline, options.signal)
    }
  }
}
export async function fetchRecentArticles(signal?: AbortSignal): Promise<{ url: string; title: string }[]> {
  const options = { signal }
  const result = await request({ action: 'recent' }, options)
  return Array.isArray(result.articles) ? result.articles : []
}
