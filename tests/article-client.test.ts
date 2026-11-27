import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchAndRewriteArticle } from '../src/lib/wikipedia'
const url = 'https://en.wikipedia.org/wiki/Test'
const article = { title: 'Test', html: '<p>Legacy body</p>', canonicalUrl: url, sourceApiUrl: '', rewriteMode: 'llm' as const }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

test('job activity and counts reach the UI before the first approved article exists', async () => {
  const statuses: unknown[] = []; const progress: number[] = []; const updates: unknown[] = []
  const views = [
    { status: 'queued', jobId: 'job', progress: 0, completed: 0, total: 0, activity: { phase: 'source', drafted: 0 } },
    { status: 'running', jobId: 'job', progress: 0, completed: 0, total: 9, activity: { phase: 'revising', drafted: 2 } },
    { status: 'running', jobId: 'job', unchanged: true, progress: 0, completed: 0, total: 9 },
    { status: 'complete', jobId: 'job', progress: 100, completed: 9, total: 9, article },
  ]
  await fetchAndRewriteArticle(url, value => progress.push(value), { fetch: async () => response(views.shift()), pollIntervalMs: 0, onStatus: value => statuses.push(value), onUpdate: value => updates.push(value) })
  assert.deepEqual(progress, [0, 0, 0, 100])
  assert.equal(updates.length, 1, 'No unapproved article content is synthesized for progress')
  assert.deepEqual(statuses[2], { status: 'running', jobId: 'job', progress: 0, completed: 0, total: 9, activity: { phase: 'revising', drafted: 2 } })
})

test('a cached article returns immediately without polling or starting model work in the browser', async () => {
  const requests: Record<string,unknown>[] = []
  const result = await fetchAndRewriteArticle(url, undefined, { fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return response({ status: 'complete', article })
  } })
  assert.equal(result.html, article.html)
  assert.deepEqual(requests, [{ action: 'start', url }])
})
test('progressive and unchanged responses preserve the last full snapshot', async () => {
  const updates: string[] = []
  const views = [
    { status: 'running', jobId: 'job', updatedAt: '1', progress: { completed: 1, total: 2 }, article: { ...article, sections: [{ id: 'lead', title: 'Intro', html: '<p>Lead</p>', complete: true }, { id: 'history', title: 'History', html: '', complete: false }] } },
    { status: 'running', jobId: 'job', updatedAt: '1', unchanged: true },
    { status: 'complete', jobId: 'job', updatedAt: '2', article: { ...article, sections: [{ id: 'lead', title: 'Intro', html: '<p>Lead</p>', complete: true }, { id: 'history', title: 'History', html: '<p>History</p>', complete: true }] } },
  ]
  const result = await fetchAndRewriteArticle(url, undefined, { fetch: async () => response(views.shift()), pollIntervalMs: 0, onUpdate: value => updates.push(value.html) })
  assert.deepEqual(updates, ['<p>Lead</p>', '<p>Lead</p><p>History</p>'])
  assert.equal(result.sections?.length, 2)
})
test('the client includes approved paragraph HTML from an unfinished section', async () => {
  const updates: string[] = []
  const views = [
    { status: 'running', jobId: 'job', progress: 50, article: { ...article, sections: [{ id: 'lead', title: 'Intro', html: '<p>Approved paragraph.</p>', complete: false }] } },
    { status: 'complete', jobId: 'job', progress: 100, article: { ...article, sections: [{ id: 'lead', title: 'Intro', html: '<p>Approved paragraph.</p><p>The next paragraph.</p>', complete: true }] } },
  ]
  await fetchAndRewriteArticle(url, undefined, { fetch: async () => response(views.shift()), pollIntervalMs: 0, onUpdate: value => updates.push(value.html) })
  assert.deepEqual(updates, ['<p>Approved paragraph.</p>', '<p>Approved paragraph.</p><p>The next paragraph.</p>'])
})
test('cancellation stops watching without trying to cancel the shared server job', async () => {
  const controller = new AbortController()
  let requests = 0
  await assert.rejects(fetchAndRewriteArticle(url, undefined, { signal: controller.signal, fetch: async () => {
    requests += 1
    return response({ status: 'running', jobId: 'job', article })
  }, onUpdate: () => controller.abort() }), { name: 'AbortError' })
  assert.equal(requests, 1)
})
test('watch deadline returns a resumable message rather than recursively restarting generation', async () => {
  let requests = 0
  await assert.rejects(fetchAndRewriteArticle(url, undefined, { watchTimeoutMs: -1, fetch: async () => {
    requests += 1
    return response({ status: 'running', jobId: 'job', article })
  } }), /continue watching the saved job/)
  assert.equal(requests, 0)
})
test('retry is explicit and terminal failures preserve an already emitted section', async () => {
  let request: unknown
  let update: unknown
  await assert.rejects(fetchAndRewriteArticle(url, undefined, { retry: true, fetch: async (_url, init) => {
    request = JSON.parse(String(init?.body))
    return response({ status: 'failed', jobId: 'job', error: 'Saved sections remain available.', article })
  }, onUpdate: value => { update = value } }), /Saved sections/)
  assert.deepEqual(request, { action: 'retry', url })
  assert.equal((update as typeof article).html, article.html)
})

test('full snapshots retain top-level saved counts, partial reason and retryability', async () => {
  const reason = 'The generation deadline was reached. Completed sections are saved; retry to finish.'
  const updates: unknown[] = []
  const result = await fetchAndRewriteArticle(url, undefined, { onUpdate: snapshot => updates.push(snapshot), fetch: async () => response({
    status: 'partial', jobId: 'job', progress: 77, completed: 112, total: 144, error: reason, retryable: true,
    article: { ...article, rewriteMode: 'llm-partial' },
  }) })
  assert.equal(result.completed, 112)
  assert.equal(result.total, 144)
  assert.equal(result.error, reason)
  assert.equal(result.retryable, true)
  assert.deepEqual(updates, [result])
})

test('hard request deadlines bound stalled fetches and response bodies even when fetch ignores abort', async t => {
  for (const bodyStalls of [false, true]) await t.test(bodyStalls ? 'stalled body' : 'stalled fetch', async () => {
    let upstreamSignal: AbortSignal | null | undefined
    let cancelled = false
    const began = Date.now()
    await assert.rejects(fetchAndRewriteArticle(url, undefined, { requestTimeoutMs: 10, fetch: async (_url, init) => {
      upstreamSignal = init?.signal
      if (!bodyStalls) return new Promise<Response>(() => {})
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true } }))
    } }), /too long to respond/)
    assert.equal(upstreamSignal?.aborted, true)
    if (bodyStalls) assert.equal(cancelled, true)
    assert.ok(Date.now() - began < 1000)
  })
})

test('declared and streamed oversized bodies are cancelled before JSON parsing', async t => {
  for (const declared of [false, true]) await t.test(declared ? 'declared size' : 'streamed size', async () => {
    let cancelled = false
    let chunks = 0
    await assert.rejects(fetchAndRewriteArticle(url, undefined, { fetch: async () => new Response(new ReadableStream({
      pull(controller) { chunks++; if (!declared) controller.enqueue(new Uint8Array(8_000_001)) },
      cancel() { cancelled = true },
    }), { headers: declared ? { 'Content-Length': '8000001' } : {} }) }), /response is too large/)
    assert.equal(cancelled, true)
    assert.ok(chunks <= 2)
  })
})

test('Retry-After beyond the watch deadline returns immediately with saved content and no early retry', async () => {
  let requests = 0
  let lastUpdate = ''
  const began = Date.now()
  await assert.rejects(fetchAndRewriteArticle(url, undefined, { pollIntervalMs: 0, watchTimeoutMs: 500, onUpdate: value => { lastUpdate = value.html }, fetch: async () => {
    requests++
    return requests === 1 ? response({ status: 'running', jobId: 'job', article }) : new Response(JSON.stringify({ error: 'Capacity is full.' }), { status: 429, headers: { 'Retry-After': '30' } })
  } }), /continue watching the saved job/)
  assert.equal(requests, 2)
  assert.equal(lastUpdate, article.html)
  assert.ok(Date.now() - began < 500)
})

test('a thirty-second Retry-After is never shortened to ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  let requests = 0
  const watched = fetchAndRewriteArticle(url, undefined, { pollIntervalMs: 0, fetch: async () => {
    requests++
    if (requests === 1) return response({ status: 'running', jobId: 'job', article })
    if (requests === 2) return new Response(JSON.stringify({ error: 'Capacity is full.' }), { status: 429, headers: { 'Retry-After': '30' } })
    return response({ status: 'complete', jobId: 'job', article })
  } })
  const turn = () => new Promise<void>(resolve => setImmediate(resolve))
  await turn()
  t.mock.timers.tick(0)
  await turn()
  assert.equal(requests, 2)
  t.mock.timers.tick(10_000)
  await turn()
  assert.equal(requests, 2)
  t.mock.timers.tick(20_000)
  await turn()
  t.mock.timers.tick(0)
  await turn()
  assert.equal((await watched).html, article.html)
  assert.equal(requests, 3)
})

test('the watcher cannot be extended beyond six minutes through options', async () => {
  let requests = 0
  await assert.rejects(fetchAndRewriteArticle(url, undefined, { watchTimeoutMs: 3_600_000, pollIntervalMs: 0, fetch: async () => {
    requests++
    return requests === 1 ? response({ status: 'running', jobId: 'job', article }) : new Response(JSON.stringify({ error: 'Capacity is full.' }), { status: 429, headers: { 'Retry-After': '400' } })
  } }), /continue watching the saved job/)
  assert.equal(requests, 2)
})
