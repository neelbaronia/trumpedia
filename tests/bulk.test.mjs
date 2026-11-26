import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createArticleClient, main, normalizeTargets, parseArgs, runBulk } from '../scripts/bulk-trumpify.mjs'

const alpha = 'https://en.wikipedia.org/wiki/Alpha'
const beta = 'https://en.wikipedia.org/wiki/Beta'
const jobId = 'aaaabbbb-1111-2222-3333-444455556666'
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const done = (canonicalUrl = alpha) => ({ status: 'complete', jobId, updatedAt: 'done', article: { canonicalUrl, opinion: 'Saved stance.', metrics: { calls: 2 } } })

test('import and help have no environment, log, cache or network side effects', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'trumpedia-bulk-import-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const url = new URL('../scripts/bulk-trumpify.mjs', import.meta.url)
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url.href)})`], { cwd, encoding: 'utf8', timeout: 5000 })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')
  const help = spawnSync(process.execPath, [url.pathname, '--help'], { cwd, encoding: 'utf8', timeout: 5000, env: {} })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /same resumable article service/)
  assert.deepEqual(await readdir(cwd), [])
})

test('canonical normalization deduplicates mobile, HTTP, title spacing and fragments; CLI bounds are enforced', () => {
  assert.deepEqual(normalizeTargets(['New York City', 'https://en.m.wikipedia.org/wiki/New_York_City#History', 'http://en.wikipedia.org/wiki/New_York_City']), ['https://en.wikipedia.org/wiki/New_York_City'])
  assert.deepEqual(normalizeTargets(['Café', 'https://en.wikipedia.org/wiki/Caf%C3%A9']), ['https://en.wikipedia.org/wiki/Caf%C3%A9'])
  assert.throws(() => normalizeTargets(['https://en.wikipedia.org.evil.test/wiki/A']))
  assert.equal(parseArgs(['20']).limit, 20)
  assert.equal(parseArgs(['--limit', '3', '--workers', '2', '--retry']).retry, true)
  for (const args of [['--workers', '3'], ['--limit', '0'], ['--watch-minutes', '61'], ['--url'], ['--resume', '--url', alpha]]) assert.throws(() => parseArgs(args))
})

test('real HTTP polling follows the shared start/status contract, conditional cursors and server canonical URL', async t => {
  const requests = []; const checkpoints = []
  const views = [
    { status: 'queued', jobId, updatedAt: '1' },
    { status: 'running', jobId, updatedAt: '2', progress: 50, article: { canonicalUrl: beta } },
    { status: 'running', jobId, updatedAt: '2', unchanged: true },
    done(beta),
  ]
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/api/article'); assert.equal(req.method, 'POST')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(views.shift()))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const client = createArticleClient({ endpoint: `http://127.0.0.1:${server.address().port}/api/article`, pollMs: 0, onCheckpoint: async (...args) => checkpoints.push(args) })
  const result = await client.watch(alpha)
  assert.deepEqual(requests, [{ action: 'start', url: alpha }, { action: 'status', jobId, updatedAt: '1' }, { action: 'status', jobId, updatedAt: '2' }, { action: 'status', jobId, updatedAt: '2' }])
  assert.equal(result.canonicalUrl, beta)
  assert.equal(result.status, 'complete')
  assert.equal(result.cached, false)
  assert.equal(checkpoints[2][1].canonicalUrl, beta)
  assert.equal(checkpoints.at(-1)[1].status, 'complete')
})

test('cached complete-with-stance jobs are reused; partial jobs require opt-in and retry at most once', async () => {
  let calls = []
  let client = createArticleClient({ endpoint: 'https://example.test/article', fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return json(done()) } })
  assert.equal((await client.watch(alpha)).cached, true)
  assert.deepEqual(calls, [{ action: 'start', url: alpha }])
  calls = []
  client = createArticleClient({ endpoint: 'https://example.test/article', fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return json({ status: 'partial', jobId, retryable: true }) } })
  assert.equal((await client.watch(alpha)).retried, false)
  assert.equal(calls.length, 1)
  calls = []
  assert.equal((await client.watch(alpha, { retry: true })).status, 'partial')
  assert.deepEqual(calls, [{ action: 'start', url: alpha }, { action: 'retry', jobId }])
})

test('resume watches the checkpoint job without new admission; an expired job safely falls back to canonical start', async () => {
  const calls = []
  const client = createArticleClient({ endpoint: 'https://example.test/article', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body)
    return body.action === 'status' ? json({ error: 'Job expired.' }, 404) : json(done())
  } })
  assert.equal((await client.watch(alpha, { resume: { jobId } })).status, 'complete')
  assert.deepEqual(calls, [{ action: 'status', jobId }, { action: 'start', url: alpha }])
  const onlyStatus = []
  const cached = createArticleClient({ endpoint: 'https://example.test/article', fetchImpl: async (_url, init) => { onlyStatus.push(JSON.parse(init.body)); return json(done()) } })
  await cached.watch(alpha, { resume: { jobId } })
  assert.deepEqual(onlyStatus, [{ action: 'status', jobId }])
})

test('capacity Retry-After is respected and requests do not bypass the shared service', async () => {
  const waits = []; const calls = []; let now = 0
  const client = createArticleClient({ endpoint: 'https://example.test/article', clock: () => now, sleep: async ms => { waits.push(ms); now += ms }, fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://example.test/article'); calls.push(JSON.parse(init.body))
    return calls.length === 1 ? json({ error: 'Capacity is full.' }, 429, { 'Retry-After': '3' }) : json(done())
  } })
  assert.equal((await client.watch(alpha)).status, 'complete')
  assert.deepEqual(waits, [3000])
  assert.deepEqual(calls, [{ action: 'start', url: alpha }, { action: 'start', url: alpha }])
})

test('stalled response bodies reach a hard HTTP deadline and cancel their streams', async () => {
  let calls = 0; let cancelled = 0
  const client = createArticleClient({ endpoint: 'https://example.test/article', timeoutMs: 10, sleep: async () => {}, fetchImpl: async () => {
    calls++
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { cancelled++ } }))
  } })
  const began = Date.now()
  await assert.rejects(client.watch(alpha), /HTTP request reached its deadline/)
  assert.equal(calls, 3); assert.equal(cancelled, 3)
  assert.ok(Date.now() - began < 1000)
})

test('watch deadlines retain checkpoint IDs and cancellation does not cancel shared jobs', async () => {
  const checkpoints = []; const calls = []
  const client = createArticleClient({ endpoint: 'https://example.test/article', watchMs: 1, pollMs: 2, clock: () => 0, onCheckpoint: async (_url, record) => checkpoints.push(record), fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return json({ status: 'running', jobId }) } })
  await assert.rejects(client.watch(alpha), /watch deadline/)
  assert.equal(checkpoints[0].jobId, jobId)
  assert.deepEqual(calls, [{ action: 'start', url: alpha }])
  const controller = new AbortController()
  const cancelled = createArticleClient({ endpoint: 'https://example.test/article', signal: controller.signal, onCheckpoint: async () => controller.abort(), fetchImpl: async () => json({ status: 'running', jobId }) })
  await assert.rejects(cancelled.watch(alpha), { name: 'AbortError' })
})

test('steady watchers are bounded and duplicate canonical inputs are only watched once', async () => {
  let active = 0; let peak = 0; const seen = []
  const client = { watch: async url => { seen.push(url); peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { status: 'complete', url } } }
  const results = await runBulk({ targets: [alpha, beta, 'https://en.m.wikipedia.org/wiki/Alpha#A', 'Gamma'], client, workers: 2 })
  assert.equal(peak, 2); assert.equal(results.length, 3)
  assert.deepEqual(seen, [alpha, beta, 'https://en.wikipedia.org/wiki/Gamma'])
})

test('the CLI writes atomic checkpoints and resumes them; notification requests remain optional', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'trumpedia-bulk-checkpoint-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const originalCwd = process.cwd()
  const calls = []; const notifications = []
  const endpoint = 'https://offline.test/article'
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://ntfy.sh/')) { notifications.push({ url: String(url), title: init.headers.Title }); return new Response(null, { status: 204 }) }
    assert.equal(String(url), endpoint)
    const body = JSON.parse(init.body); calls.push(body)
    return body.action === 'start' ? json({ status: 'partial', jobId, updatedAt: '1', retryable: true }) : json(done())
  }
  try {
    process.chdir(cwd)
    const first = await main(['--endpoint', endpoint, '--url', alpha], { env: {}, fetchImpl })
    assert.equal(first.results[0].status, 'partial')
    assert.equal(notifications.length, 0)
    const checkpoint = JSON.parse(await readFile(join(cwd, '.verification/bulk-checkpoint.json'), 'utf8'))
    assert.equal(checkpoint.articles[alpha].jobId, jobId)
    assert.equal(checkpoint.articles[alpha].status, 'partial')
    const resumed = await main(['--endpoint', endpoint, '--resume'], { env: { NTFY_TOPIC: 'offline-test-topic' }, fetchImpl })
    assert.equal(resumed.results[0].status, 'complete')
    assert.deepEqual(calls, [{ action: 'start', url: alpha }, { action: 'status', jobId }])
    assert.deepEqual(notifications.map(value => value.title), ['Trumpedia starting', 'Trumpedia finished'])
    assert.deepEqual(await readdir(join(cwd, '.verification')), ['bulk-checkpoint.json'])
    const saved = JSON.parse(await readFile(join(cwd, '.verification/bulk-checkpoint.json'), 'utf8'))
    assert.equal(saved.articles[alpha].status, 'complete')
    assert.equal(JSON.stringify(saved).includes('offline-test-topic'), false)
  } finally { process.chdir(originalCwd) }
})
