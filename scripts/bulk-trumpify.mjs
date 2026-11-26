import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWikipediaUrl } from '../supabase/functions/_shared/article-plan.mjs'

const STATUSES = new Set(['queued', 'running', 'complete', 'partial', 'failed'])
const TERMINAL = new Set(['complete', 'partial', 'failed'])
const DEFAULT_CHECKPOINT = '.verification/bulk-checkpoint.json'
const HELP = `Trumpedia bulk client — uses the same resumable article service as the website.

Usage: npm run bulk:trumpify -- [limit] [options]
  --limit N             Top English articles to request (default 150, maximum 1000)
  --url URL             Request an article; repeat for multiple URLs
  --file PATH           Read article URLs or titles, one per line
  --workers N           Concurrent article watchers: 1 (default) or 2
  --endpoint URL        Article API; otherwise VITE_ARTICLE_API_URL / Supabase URL
  --retry               Retry unfinished terminal jobs once, subject to server budgets
  --resume              Watch unfinished jobs from the checkpoint, without new targets
  --checkpoint PATH     Checkpoint file (default ${DEFAULT_CHECKPOINT})
  --poll-ms N           Poll interval (default 1500)
  --timeout-ms N        Deadline for each HTTP request (default 15000)
  --watch-minutes N     Watch deadline per article (default 15, maximum 60)
  --dry-run             List targets without requesting generation
  --help                Show this help without credentials or network access

The server owns cache quality, canonical deduplication, saved blocks, stance generation,
and spending limits. Re-running a URL reuses its current saved job. Ctrl-C stops watching;
it does not cancel jobs shared with other readers. --resume checks saved job IDs.
Optional NTFY_TOPIC enables start/completion notifications. No model API key is used here.
`

export function parseArgs(args = []) {
  const options = { limit: 150, urls: [], workers: 1, checkpoint: DEFAULT_CHECKPOINT, pollMs: 1500, timeoutMs: 15000, watchMs: 15 * 60_000, retry: false, resume: false, dryRun: false, help: false }
  const number = (value, label, min, max) => {
    if (!/^\d+$/.test(value || '') || Number(value) < min || Number(value) > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`)
    return Number(value)
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const next = () => { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`); return value }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--retry') options.retry = true
    else if (arg === '--resume') options.resume = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--url') options.urls.push(next())
    else if (arg === '--file') options.file = next()
    else if (arg === '--endpoint') options.endpoint = next()
    else if (arg === '--checkpoint') options.checkpoint = next()
    else if (arg === '--limit') options.limit = number(next(), '--limit', 1, 1000)
    else if (arg === '--workers') options.workers = number(next(), '--workers', 1, 2)
    else if (arg === '--poll-ms') options.pollMs = number(next(), '--poll-ms', 100, 60_000)
    else if (arg === '--timeout-ms') options.timeoutMs = number(next(), '--timeout-ms', 100, 60_000)
    else if (arg === '--watch-minutes') options.watchMs = number(next(), '--watch-minutes', 1, 60) * 60_000
    else if (/^\d+$/.test(arg) && index === 0) options.limit = number(arg, 'limit', 1, 1000)
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`)
  }
  if (options.resume && (options.urls.length || options.file)) throw new Error('--resume cannot be combined with --url or --file.')
  return options
}

export function normalizeTargets(values) {
  return [...new Set(values.map(value => {
    const input = String(value).trim()
    const url = /^https?:\/\//i.test(input) ? input : `https://en.wikipedia.org/wiki/${encodeURIComponent(input.replace(/ /g, '_')).replace(/%2F/gi, '/')}`
    return parseWikipediaUrl(url).canonicalUrl
  }))]
}

class BulkError extends Error {
  constructor(message, { status = 0, retryable = false, retryAfter = 0, code } = {}) {
    super(message); this.name = 'BulkError'; Object.assign(this, { status, retryable, retryAfter, code })
  }
}
const aborted = () => new DOMException('Stopped watching. Saved server work is retained.', 'AbortError')
function pause(ms, signal) {
  return new Promise((resolvePause, reject) => {
    if (signal?.aborted) { reject(aborted()); return }
    const cancel = () => { clearTimeout(timer); reject(aborted()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolvePause() }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
async function readJson(response, maxBytes = 8 * 1024 * 1024, signal) {
  if (Number(response.headers.get('Content-Length')) > maxBytes) { await response.body?.cancel(); throw new BulkError('The response exceeds the size limit.') }
  const reader = response.body?.getReader()
  if (!reader) throw new BulkError('The service returned an empty response.')
  const chunks = []; let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) throw aborted()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new BulkError('The response exceeds the size limit.') }
      chunks.push(value)
    }
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new BulkError('The service returned unreadable JSON.') }
}
async function boundedFetchJson(url, init, { fetchImpl, timeoutMs, signal, maxBytes }) {
  if (signal?.aborted) throw aborted()
  const controller = new AbortController()
  let timer; let cancel
  const limit = new Promise((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(aborted()) }
    signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => { controller.abort(); reject(new BulkError('The HTTP request reached its deadline.', { retryable: true, code: 'request_timeout' })) }, timeoutMs)
  })
  try {
    return await Promise.race([limit, (async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal })
      const value = await readJson(response, maxBytes, controller.signal)
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('Retry-After') || value?.retryAfter) || 0
        throw new BulkError(typeof value?.error === 'string' ? value.error : `The service returned HTTP ${response.status}.`, { status: response.status, retryAfter, retryable: response.status === 408 || response.status === 429 || response.status >= 500 })
      }
      return value
    })()])
  } catch (error) {
    if (signal?.aborted) throw aborted()
    if (error instanceof BulkError) throw error
    throw new BulkError('Could not reach the article service.', { retryable: true })
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

export function createArticleClient({ endpoint, apiKey, fetchImpl = fetch, timeoutMs = 15000, watchMs = 15 * 60_000, pollMs = 1500, signal, clock = Date.now, sleep = pause, onCheckpoint = async () => {} }) {
  const url = new URL(endpoint)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) article endpoint without credentials in its URL.')
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey && url.pathname.includes('/functions/v1/')) { headers.apikey = apiKey; headers.Authorization = `Bearer ${apiKey}` }
  async function request(body, deadline) {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - clock()
      if (remaining <= 0) throw new BulkError('The watch deadline was reached. Re-run with --resume to keep watching saved work.', { code: 'watch_timeout' })
      try {
        return await boundedFetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) }, { fetchImpl, timeoutMs: Math.min(timeoutMs, remaining), signal })
      } catch (error) {
        if (!error.retryable || attempt >= 2) throw error
        const waitMs = Math.max(error.retryAfter * 1000, 1000 * 2 ** attempt)
        if (waitMs >= deadline - clock()) throw new BulkError('The watch deadline was reached while waiting for service capacity. Re-run with --resume.', { code: 'watch_timeout' })
        await sleep(waitMs, signal)
      }
    }
  }
  return {
    async watch(input, { retry = false, resume } = {}) {
      const originalUrl = normalizeTargets([input])[0]
      const deadline = clock() + watchMs
      let view
      if (resume?.jobId) {
        try { view = await request({ action: 'status', jobId: resume.jobId }, deadline) } catch (error) {
          if (error.status !== 404) throw error
        }
      }
      view ||= await request({ action: 'start', url: originalUrl }, deadline)
      const cached = !resume && view?.status === 'complete'
      let retried = false
      let canonicalUrl = originalUrl
      while (true) {
        if (signal?.aborted) throw aborted()
        if (!view || !STATUSES.has(view.status)) throw new BulkError('The service returned an invalid job state.')
        if (view.article?.canonicalUrl) canonicalUrl = parseWikipediaUrl(view.article.canonicalUrl).canonicalUrl
        await onCheckpoint(originalUrl, { canonicalUrl, jobId: view.jobId, status: view.status, updatedAt: view.updatedAt, progress: view.progress, completed: view.completed, total: view.total })
        if (TERMINAL.has(view.status)) {
          if (view.status !== 'complete' && retry && !retried && view.retryable !== false) {
            retried = true
            view = await request({ action: 'retry', ...(view.jobId ? { jobId: view.jobId } : { url: canonicalUrl }) }, deadline)
            continue
          }
          return { url: originalUrl, canonicalUrl, status: view.status, jobId: view.jobId, cached, retried, metrics: view.article?.metrics }
        }
        if (typeof view.jobId !== 'string' || !view.jobId) throw new BulkError('The service did not return a job identifier.')
        if (clock() + pollMs >= deadline) throw new BulkError('The watch deadline was reached. Re-run with --resume to keep watching saved work.', { code: 'watch_timeout' })
        await sleep(pollMs, signal)
        const update = await request({ action: 'status', jobId: view.jobId, updatedAt: view.updatedAt }, deadline)
        view = update?.unchanged ? { ...view, ...update } : update
      }
    },
  }
}

export async function runBulk({ targets, client, workers = 1, retry = false, resumeRecords = {}, onResult = async () => {} }) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 2) throw new Error('Use one or two article watchers.')
  const urls = normalizeTargets(targets); const results = new Array(urls.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(workers, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next++; const url = urls[index]
      try { results[index] = await client.watch(url, { retry, resume: resumeRecords[url] }) }
      catch (error) { results[index] = { url, status: error.name === 'AbortError' ? 'stopped' : error.code === 'watch_timeout' ? 'watch-timeout' : 'error', error: error.message } }
      await onResult(results[index], index)
      if (results[index].status === 'stopped') break
    }
  }))
  return results.filter(Boolean)
}

async function loadEnv(env) {
  for (const file of ['.env.local', '.env']) {
    let source
    try { source = await readFile(resolve(file), 'utf8') } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const line of source.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}
async function topArticles(limit, fetchOptions) {
  const date = new Date(Date.now() - 2 * 86400_000)
  const path = date.toISOString().slice(0, 10).replace(/-/g, '/')
  const data = await boundedFetchJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${path}`, { headers: { 'User-Agent': 'TrumpediaBulkProcessor/2.0 (https://trumpedia.org)' } }, { ...fetchOptions, maxBytes: 2 * 1024 * 1024 })
  if (!Array.isArray(data?.items?.[0]?.articles)) throw new Error('Wikimedia did not return top articles.')
  const targets = []
  for (const item of data.items[0].articles) {
    if (item.article === 'Main_Page') continue
    try { targets.push(...normalizeTargets([item.article])) } catch { /* Ignore non-article namespaces. */ }
    if (targets.length >= limit) break
  }
  return normalizeTargets(targets).slice(0, limit)
}
async function readCheckpoint(path, endpoint) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    if (data.version !== 1 || data.endpoint !== endpoint || !data.articles || typeof data.articles !== 'object' || Array.isArray(data.articles)) return { version: 1, endpoint, articles: {} }
    return data
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, endpoint, articles: {} }; throw new Error(`Could not read checkpoint: ${error.message}`) }
}

export async function main(args = process.argv.slice(2), { env = { ...process.env }, fetchImpl = fetch } = {}) {
  const options = parseArgs(args)
  if (options.help) { console.log(HELP); return { results: [] } }
  await loadEnv(env)
  const endpoint = options.endpoint || env.VITE_ARTICLE_API_URL || env.ARTICLE_API_URL || env.VITE_REWRITE_API_URL?.replace(/\/rewrite\/?$/, '/article') || (env.VITE_SUPABASE_URL ? `${env.VITE_SUPABASE_URL.replace(/\/$/, '')}/functions/v1/article` : 'http://127.0.0.1:8787/api/article')
  const checkpointPath = resolve(options.checkpoint)
  const checkpoint = await readCheckpoint(checkpointPath, endpoint)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let pendingWrite = Promise.resolve(); let writes = 0
  const log = async message => { const line = `[${new Date().toISOString()}] ${message}`; console.log(line); await appendFile('bulk-process.log', line + '\n') }
  const onCheckpoint = async (url, record) => {
    checkpoint.articles[url] = record; checkpoint.updatedAt = new Date().toISOString()
    const serialized = JSON.stringify(checkpoint, null, 2)
    const temporary = `${checkpointPath}.${process.pid}.${++writes}.tmp`
    pendingWrite = pendingWrite.then(async () => { await mkdir(dirname(checkpointPath), { recursive: true }); await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, checkpointPath) })
    await pendingWrite
  }
  const notify = async (title, message) => {
    if (!env.NTFY_TOPIC || options.dryRun) return
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(env.NTFY_TOPIC)) { await log('[ntfy] Invalid topic; notification skipped.'); return }
    try {
      await fetchImpl(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: 'POST', headers: { Title: title, 'Content-Type': 'text/plain' }, body: message, signal: AbortSignal.timeout(options.timeoutMs) })
    } catch { await log('[ntfy] Notification could not be sent.') }
  }
  const began = Date.now()
  try {
    let targets
    const resumeRecords = options.resume ? checkpoint.articles : {}
    if (options.resume) {
      targets = Object.entries(resumeRecords).filter(([, record]) => record && record.status !== 'complete' && typeof record.jobId === 'string').map(([url]) => url)
      if (!targets.length) throw new Error('No unfinished saved jobs match this endpoint. Supply URLs or a top-article limit to start a run.')
    } else if (options.urls.length || options.file) {
      const fileTargets = options.file ? (await readFile(resolve(options.file), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')) : []
      targets = normalizeTargets([...options.urls, ...fileTargets]).slice(0, options.limit)
    } else targets = await topArticles(options.limit, { fetchImpl, timeoutMs: options.timeoutMs, signal: controller.signal })
    if (options.dryRun) { for (const url of targets) console.log(url); return { results: [], targets } }
    await log(`Starting ${targets.length} article watchers (${options.workers} concurrent); saved work and provider budgets are managed by the server.`)
    await notify('Trumpedia starting', `Watching ${targets.length} articles using the shared article service.`)
    const client = createArticleClient({ endpoint, apiKey: env.VITE_SUPABASE_ANON_KEY, fetchImpl, timeoutMs: options.timeoutMs, watchMs: options.watchMs, pollMs: options.pollMs, signal: controller.signal, onCheckpoint })
    const results = await runBulk({ targets, client, workers: options.workers, retry: options.retry, resumeRecords, onResult: result => log(`${result.status}${result.cached ? ' (cached with completed stance)' : ''}: ${result.canonicalUrl || result.url}${result.error ? ` — ${result.error}` : ''}`) })
    const counts = results.reduce((all, result) => { all[result.status] = (all[result.status] || 0) + 1; return all }, {})
    const summary = `${JSON.stringify(counts)}; ${((Date.now() - began) / 60_000).toFixed(1)} minutes. Checkpoint: ${options.checkpoint}`
    await log(`Finished: ${summary}`); await notify('Trumpedia finished', summary)
    return { results, counts }
  } catch (error) {
    await log(`Stopped: ${error.message}`); await notify('Trumpedia stopped', error.name === 'AbortError' ? 'Watching stopped. Server checkpoints are retained.' : 'The run could not finish. Check the local bulk log and checkpoint.')
    throw error
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    await pendingWrite
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(({ results }) => { if (results.some(result => result.status !== 'complete')) process.exitCode = 1 }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
