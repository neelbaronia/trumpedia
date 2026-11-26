import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createProvider, ProviderError, PROVIDER_LIMITS, PROVIDER_PROMPT_VERSION, normalizeRewritePayload, parseRetryAfter, rewritePayload, safeProviderError } from '../supabase/functions/_shared/provider.mjs'
import { createLegacyHandler, createSupabaseProviderBudget } from '../supabase/functions/_shared/legacy-http.mjs'
import { createRewriteServer } from '../server/rewrite-server.mjs'

const blocks = [{ id: 'lead-0', text: '  A __TRUMPEDIA_0__fact__TRUMPEDIA_1__.\n' }, { id: 'lead-1', text: 'Second fact.' }]
const output = [{ id: 'lead-0', text: '  A tremendous __TRUMPEDIA_0__fact__TRUMPEDIA_1__, believe me.\n' }, { id: 'lead-1', text: 'Here is the second fact—tremendous.' }]
const completion = (result, extra = {}) => new Response(JSON.stringify({ model: 'actual-model', usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], ...extra }), { headers: { 'Content-Type': 'application/json' } })
function fixture(result = { blocks: output }, config = {}) {
  const calls = []
  const provider = createProvider({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) })
    let output = typeof result === 'function' ? result(calls.at(-1)) : result
    if (calls.at(-1).body.response_format.json_schema.schema.properties.blocks?.items.properties.spans && Array.isArray(output.blocks)) {
      output = { ...output, blocks: output.blocks.map(block => {
        if (typeof block.text !== 'string') return block
        const { text, ...rest } = block
        return { ...rest, spans: text.split(/__TRUMPEDIA_\d+__/g) }
      }) }
    }
    return completion(output)
  }, ...config })
  return { provider, calls }
}
function post(payload, headers = {}) { return new Request('https://example.test/rewrite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) }) }
const rejectsCode = (promise, code, status) => assert.rejects(promise, error => error instanceof ProviderError && error.code === code && (!status || error.status === status))

test('paused generation never acquires paid capacity or reaches the provider', async () => {
  let calls = 0
  let budgets = 0
  const provider = createProvider({ apiKey: '', fetchImpl: async () => { calls++; throw new Error('Must not call the provider') } })
  const handler = createLegacyHandler({ provider, operation: 'rewrite', budget: { acquire: async () => { budgets++; throw new Error('Must not allocate budget') } } })
  const result = await handler(post({ blocks }))
  assert.equal(result.status, 503)
  assert.equal((await result.json()).code, 'provider_not_configured')
  assert.equal(calls, 0)
  assert.equal(budgets, 0)
})

test('strict structured request, actual usage/model, shuffled IDs and deterministic whitespace', async () => {
  const metrics = []
  const { provider, calls } = fixture({ blocks: [{ ...output[1] }, { id: output[0].id, text: output[0].text.trim() }] }, { onMetric: value => metrics.push(value) })
  const result = await provider.rewrite({ blocks })
  assert.deepEqual(result.blocks, output)
  assert.equal(result.model, 'actual-model')
  assert.deepEqual(result.usage, { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.response_format.type, 'json_schema')
  assert.equal(calls[0].body.response_format.json_schema.strict, true)
  assert.deepEqual(calls[0].body.response_format.json_schema.schema.properties.blocks.items.properties.id.enum, ['lead-0', 'lead-1'])
  assert.equal(calls[0].body.max_tokens, undefined)
  assert.ok(calls[0].body.max_completion_tokens > 0)
  assert.equal(calls[0].body.model, 'grok-4.3')
  assert.equal(calls[0].body.reasoning_effort, 'none')
  assert.equal(PROVIDER_PROMPT_VERSION, 'trumpedia-blocks-v4')
  assert.equal(calls[0].body.prompt_cache_key, 'trumpedia-blocks-v4:rewrite')
  assert.equal(metrics[0].status, 200)
  assert.equal(metrics[0].model, 'actual-model')
})

test('explicit model and reasoning overrides are preserved', async () => {
  const custom = fixture({ blocks: output }, { model: 'custom-model' })
  await custom.provider.rewrite({ blocks })
  assert.equal(custom.calls[0].body.model, 'custom-model')
  assert.equal(custom.calls[0].body.reasoning_effort, undefined)
  const overridden = fixture({ blocks: output }, { reasoningEffort: 'low' })
  await overridden.provider.rewrite({ blocks })
  assert.equal(overridden.calls[0].body.model, 'grok-4.3')
  assert.equal(overridden.calls[0].body.reasoning_effort, 'low')
})

test('stance and lead are produced in one call; separate opinion remains available', async () => {
  const { provider, calls } = fixture({ blocks: output, opinion: 'Tremendous. Believe me.' })
  const result = await provider.rewrite({ blocks, includeOpinion: true, summary: 'A topic summary.' })
  assert.equal(calls.length, 1)
  assert.equal(result.opinion, 'Tremendous. Believe me.')
  assert.deepEqual(calls[0].body.response_format.json_schema.schema.required, ['blocks', 'opinion'])
  assert.equal(JSON.parse(calls[0].body.messages[1].content).summary, 'A topic summary.')
  const opinion = fixture({ opinion: ' Very tremendous. ' })
  assert.equal((await opinion.provider.opinion({ summary: 'A topic summary.' })).opinion, 'Very tremendous.')
})

test('a new opinion cannot disguise a batch of copied source prose; paid attempt metrics survive', async () => {
  const metrics = []
  const copied = blocks.map(block => ({ ...block, text: block.text.replace(/\s+/g, ' ').trim() }))
  const { provider, calls } = fixture({ blocks: copied, opinion: 'A tremendous topic. Believe me.' }, { onMetric: metric => metrics.push(metric) })
  await assert.rejects(provider.rewrite({ blocks, includeOpinion: true, summary: 'A topic summary.' }), error => {
    assert.equal(error.code, 'invalid_output')
    assert.equal(error.status, 502)
    assert.equal(error.retryable, true)
    assert.equal(error.model, 'actual-model')
    assert.equal(typeof error.duration, 'number')
    assert.deepEqual(error.usage, { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 })
    return true
  })
  assert.equal(calls.length, 1)
  assert.equal(metrics[0].status, 502)
  assert.equal(metrics[0].usage.total_tokens, 35)
})

test('one prefixed paragraph cannot disguise eight copied paragraphs', async () => {
  const source = Array.from({ length: 9 }, (_, index) => ({ id: `p-${index}`, text: `The museum display in room ${index + 1} explains the history of the town and its residents.` }))
  const copied = source.map((block, index) => ({ ...block, text: index === 0 ? 'Folks, ' + block.text : block.text }))
  const { provider, calls } = fixture({ blocks: copied, opinion: 'Tremendous museums. Believe me.' })
  await rejectsCode(provider.rewrite({ blocks: source, includeOpinion: true, summary: 'A museum history.' }), 'invalid_output', 502)
  assert.equal(calls.length, 1)
})

test('a copied block is rejected even when its neighboring block is genuinely rephrased', async () => {
  const result = [{ ...output[0] }, { ...blocks[1] }]
  await rejectsCode(fixture({ blocks: result }).provider.rewrite({ blocks }), 'invalid_output', 502)
})

test('prefix/suffix-only wrappers cannot pass as a paragraph rewrite', async t => {
  const source = [{ id: 'p-0', text: 'The __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened in 1920 and displays the history of the town.' }]
  const wrappers = [
    'Folks, ' + source[0].text,
    source[0].text + ' Believe me, a tremendous museum.',
    'Folks, ' + source[0].text.toLowerCase().replace('.', '!') + ' Tremendous!',
    source[0].text.replace(/\s+/g, '\n'),
  ]
  for (const text of wrappers) await t.test(text.slice(0, 55), async () => {
    // Marker spelling is protected independently from prose punctuation/case.
    const fixedMarkers = text.replace(/__trumpedia_(\d+)__/g, '__TRUMPEDIA_$1__')
    await rejectsCode(fixture({ blocks: [{ id: 'p-0', text: fixedMarkers }] }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
  })
})

test('Folks plus a lowercased source and suffix is rejected', async () => {
  const source = [{ id: 'zarf-0', text: 'A zarf is a holder, usually of ornamental metal, for a coffee cup without a handle.' }]
  const wrapped = [{ id: 'zarf-0', text: 'Folks, a zarf is a holder, usually of ornamental metal, for a coffee cup without a handle, believe me.' }]
  await rejectsCode(fixture({ blocks: wrapped }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
})

test('copy checks normalize Unicode without normalizing accepted output strings', async () => {
  const source = [{ id: 'cafe-0', text: 'The café displays local history and admits visitors every Sunday.' }]
  const wrapped = [{ id: 'cafe-0', text: 'Folks, ' + source[0].text.toLowerCase().normalize('NFD') + ' Believe me.' }]
  await rejectsCode(fixture({ blocks: wrapped }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
  const changed = [{ id: 'cafe-0', text: 'Every Sunday, visitors can enter the cafe\u0301 and discover the history of this place—tremendous.' }]
  const result = await fixture({ blocks: changed }).provider.rewrite({ blocks: source })
  assert.equal(result.blocks[0].text, changed[0].text)
  assert.notEqual(result.blocks[0].text, changed[0].text.normalize('NFC'))
})

test('two genuinely rephrased paragraphs preserve their facts and protected links', async () => {
  const source = [
    { id: 'museum-0', text: 'The __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened in 1920 and displays local history.' },
    { id: 'museum-1', text: 'Visitors can enter the museum free of charge on __TRUMPEDIA_2__Sundays__TRUMPEDIA_3__.' },
  ]
  const changed = [
    { id: 'museum-0', text: 'In 1920, the __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened its doors to tell the story of local history—tremendous history, believe me.' },
    { id: 'museum-1', text: 'On __TRUMPEDIA_2__Sundays__TRUMPEDIA_3__, visitors pay nothing to enter that museum—a tremendous deal.' },
  ]
  assert.deepEqual((await fixture({ blocks: changed }).provider.rewrite({ blocks: source })).blocks, changed)
})

test('marker-preserving paraphrases retain facts, IDs, and formatting', async () => {
  const source = [{ id: 'museum-0', text: 'The __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened in 1920.' }]
  const changed = [{ id: 'museum-0', text: 'In 1920, the __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened its doors—a tremendous opening, believe me.' }]
  const { provider } = fixture({ blocks: changed })
  assert.deepEqual((await provider.rewrite({ blocks: source })).blocks, changed)
})

test('moving only protected markers does not count as changing source prose', async () => {
  const source = [{ id: 'p-0', text: '__TRUMPEDIA_0__A fact__TRUMPEDIA_1__ remains true.' }]
  const moved = [{ id: 'p-0', text: 'A fact __TRUMPEDIA_0__remains true.__TRUMPEDIA_1__' }]
  await rejectsCode(fixture({ blocks: moved }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
})

test('an unchanged marker-only split tail does not invalidate rewritten prose', async () => {
  const source = [{ id: 'p-0', text: '__TRUMPEDIA_0__The museum opened in 1920.' }, { id: 'p-1', text: '__TRUMPEDIA_1__' }]
  const changed = [{ id: 'p-0', text: '__TRUMPEDIA_0__In 1920, the museum opened—a tremendous event.' }, source[1]]
  assert.deepEqual((await fixture({ blocks: changed }).provider.rewrite({ blocks: source })).blocks, changed)
})

test('singleton spans retain standalone and adjacent markers without asking the model to emit them', async () => {
  const text = 'The __TRUMPEDIA_0__museum__TRUMPEDIA_1__ (founded: 1920; __TRUMPEDIA_2__local__TRUMPEDIA_3__: __TRUMPEDIA_4__history__TRUMPEDIA_5__; __TRUMPEDIA_6__collection__TRUMPEDIA_7__: __TRUMPEDIA_8____TRUMPEDIA_9__artifacts__TRUMPEDIA_10____TRUMPEDIA_11__) displays __TRUMPEDIA_12__objects__TRUMPEDIA_13__ collected locally__TRUMPEDIA_14__ (__TRUMPEDIA_15__tools__TRUMPEDIA_16__ or __TRUMPEDIA_17__maps__TRUMPEDIA_18__).__TRUMPEDIA_19__\n'
  const source = [{ id: 'lead-0', text }]
  const changed = [{ id: 'lead-0', text: text.replace('The ', 'Look at this ').replace('displays ', 'shows off ').replace('collected locally', 'from the local collection—a tremendous collection') }]
  const { provider, calls } = fixture({ blocks: changed, opinion: 'A tremendous museum.' })
  const result = await provider.rewrite({ blocks: source, includeOpinion: true, summary: 'Local museum history.' })
  assert.deepEqual(result.blocks, changed)
  assert.equal(result.opinion, 'A tremendous museum.')
  const body = calls[0].body
  const item = body.response_format.json_schema.schema.properties.blocks.items
  assert.deepEqual(item.required, ['id', 'spans'])
  assert.deepEqual(item.properties.spans, { type: 'array', minItems: 21, maxItems: 21, items: { type: 'string' } })
  assert.equal(item.properties.text, undefined)
  const input = JSON.parse(body.messages[1].content).blocks[0]
  assert.equal(input.text, text)
  assert.deepEqual(input.spans, text.split(/__TRUMPEDIA_\d+__/g))
  assert.equal(input.spans[9], '')
  assert.equal(input.spans[11], '')
  assert.deepEqual(result.blocks[0].text.match(/__TRUMPEDIA_\d+__/g), text.match(/__TRUMPEDIA_\d+__/g))
})

test('spans reject missing gaps, malformed entries, marker injection, wrong IDs, and overlong output', async t => {
  const source = [{ id: 'lead-0', text: 'The __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened in 1920 and displays local history.' }]
  const good = ['In 1920, the ', 'museum', ' opened its doors to tell the local story—tremendous history.']
  const cases = [
    { id: 'lead-0', spans: good.slice(0, 2) },
    { id: 'lead-0', spans: [...good, 'extra'] },
    { id: 'lead-0', spans: [good[0], null, good[2]] },
    { id: 'lead-0', spans: [good[0], '__TRUMPEDIA_99__', good[2]] },
    { id: 'lead-0', spans: [good[0], '__trumpedia_99__', good[2]] },
    { id: 'lead-0', spans: [good[0], '__TRUMPEDIA_', good[2]] },
    { id: 'wrong-id', spans: good },
    { id: 'lead-0', spans: good, extra: true },
    { id: 'lead-0', spans: ['x'.repeat(1025), '', ''] },
    { id: 'lead-0', spans: ['', '', ''] },
    { id: 'lead-0', spans: [good[0], '   ', good[2]] },
    { id: 'lead-0', spans: [good[0], '!', good[2]] },
  ]
  for (const block of cases) await t.test(JSON.stringify(block).slice(0, 60), async () => {
    await rejectsCode(fixture({ blocks: [block] }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
  })
  const copied = source[0].text.split(/__TRUMPEDIA_\d+__/g)
  await rejectsCode(fixture({ blocks: [{ id: 'lead-0', spans: copied }] }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
})

test('empty formatting gaps stay empty and source prose cannot disappear', async () => {
  const source = [{ id: 'p-0', text: '__TRUMPEDIA_0____TRUMPEDIA_1__The museum opened in 1920 and displays local history.__TRUMPEDIA_2__' }]
  const good = ['', '', 'In 1920, the museum opened to tell the local story—tremendous history.', '']
  assert.equal((await fixture({ blocks: [{ id: 'p-0', spans: good }] }).provider.rewrite({ blocks: source })).blocks[0].text, '__TRUMPEDIA_0____TRUMPEDIA_1__' + good[2] + '__TRUMPEDIA_2__')
  for (const index of [0, 1, 3]) {
    const changed = [...good]; changed[index] = ' '
    await rejectsCode(fixture({ blocks: [{ id: 'p-0', spans: changed }] }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
  }
  await rejectsCode(fixture({ blocks: [{ id: 'p-0', spans: ['', '', '', ''] }] }).provider.rewrite({ blocks: source }), 'invalid_output', 502)
  const plain = [{ id: 'plain', text: 'The museum opened in 1920 and displays local history.' }]
  await rejectsCode(fixture({ blocks: [{ id: 'plain', text: '!!!' }] }).provider.rewrite({ blocks: plain }), 'invalid_output', 502)
})

test('text wire mode remains for marker-free, multi-block, and more than 255 markers', async () => {
  const plain = fixture({ blocks: [{ id: 'plain', text: 'A tremendous fact, believe me.' }] })
  await plain.provider.rewrite({ blocks: [{ id: 'plain', text: 'A fact.' }] })
  assert.equal(plain.calls[0].body.response_format.json_schema.schema.properties.blocks.items.properties.spans, undefined)
  const multiple = fixture()
  await multiple.provider.rewrite({ blocks })
  assert.equal(multiple.calls[0].body.response_format.json_schema.schema.properties.blocks.items.properties.spans, undefined)
  const boundary = 'The museum opened in 1920 and displays local history. ' + Array.from({ length: 255 }, (_, i) => `__TRUMPEDIA_${i}__`).join('')
  const allowed = fixture({ blocks: [{ id: 'boundary', text: boundary.replace('The museum opened in 1920 and displays local history.', 'In 1920, the museum opened its doors to tell the local story—tremendous history.') }] })
  await allowed.provider.rewrite({ blocks: [{ id: 'boundary', text: boundary }] })
  const spans = allowed.calls[0].body.response_format.json_schema.schema.properties.blocks.items.properties.spans
  assert.equal(spans.minItems, 256); assert.equal(spans.maxItems, 256)
  const many = 'The museum opened in 1920 and displays local history. ' + Array.from({ length: 256 }, (_, i) => `__TRUMPEDIA_${i}__`).join('')
  const fallback = fixture({ blocks: [{ id: 'many', text: many.replace('The museum opened in 1920 and displays local history.', 'In 1920, the museum opened its doors to tell the local story—tremendous history.') }] })
  await fallback.provider.rewrite({ blocks: [{ id: 'many', text: many }] })
  const item = fallback.calls[0].body.response_format.json_schema.schema.properties.blocks.items
  assert.deepEqual(item.required, ['id', 'text'])
  assert.equal(item.properties.text.pattern, undefined)
})

test('missing/extra/duplicate IDs and incomplete blocks are rejected without padding', async t => {
  for (const result of [[], [output[0]], [...output, { id: 'extra', text: 'Invented' }], [output[0], output[0]], [output[0], { ...output[1], id: 'unknown' }], [output[0], { id: output[1].id, text: 7 }], [output[0], { ...output[1], extra: true }]]) {
    await t.test(JSON.stringify(result).slice(0, 80), async () => {
      const { provider, calls } = fixture({ blocks: result })
      await rejectsCode(provider.rewrite({ blocks }), 'invalid_output', 502)
      assert.equal(calls.length, 1)
    })
  }
})

test('protected marker counts, order and identity must match per block', async t => {
  for (const text of ['No markers.', '__TRUMPEDIA_1__fact__TRUMPEDIA_0__', '__TRUMPEDIA_0__fact__TRUMPEDIA_1____TRUMPEDIA_1__', '__TRUMPEDIA_0__fact__TRUMPEDIA_2__']) {
    await t.test(text, async () => {
      const { provider } = fixture({ blocks: [{ id: output[0].id, text }, output[1]] })
      await rejectsCode(provider.rewrite({ blocks }), 'invalid_output')
    })
  }
  const split = [{ id: 'p-0', text: '__TRUMPEDIA_1__A fact' }, { id: 'p-1', text: 'continued.__TRUMPEDIA_2__' }]
  const changed = [{ id: 'p-0', text: '__TRUMPEDIA_1__A tremendous fact' }, { id: 'p-1', text: 'continues, believe me.__TRUMPEDIA_2__' }]
  assert.deepEqual((await fixture({ blocks: changed }).provider.rewrite({ blocks: split })).blocks, changed)
})

test('input whitelist and bounds prevent invalid requests from reaching the provider', async () => {
  const { provider, calls } = fixture()
  for (const input of [undefined, [], [{ id: 'bad id', text: 'a' }], [{ id: 'a', text: '' }], [{ id: 'a', text: 1 }], [{ id: 'a', text: 'x'.repeat(12001) }], [{ id: 'a', text: 'x'.repeat(12000) }, { id: 'b', text: 'x'.repeat(12000) }, { id: 'c', text: 'x' }], [...Array(61)].map((_, i) => ({ id: `a${i}`, text: 'x' }))]) {
    await assert.rejects(provider.rewrite({ blocks: input }), ProviderError)
  }
  for (const payload of [{ segments: [1] }, { segments: ['a'], surprise: true }, { segments: ['a'], blocks: [] }, { segments: ['a'], includeOpinion: 'true' }, { segments: ['a'], includeOpinion: true, summary: 'x'.repeat(6001) }]) assert.throws(() => normalizeRewritePayload(payload), ProviderError)
  await assert.rejects(provider.opinion({ summary: '' }), ProviderError)
  assert.equal(calls.length, 0)
})

test('malformed, truncated, refused and overlong results fail with retryable sanitized errors', async t => {
  const badBodies = [null, {}, { choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ blocks: output }) } }] }, { choices: [{ message: { content: '{bad' } }] }, { choices: [{ message: { refusal: 'no', content: '{}' } }] }]
  for (const body of badBodies) await t.test(JSON.stringify(body).slice(0, 80), async () => {
    const provider = createProvider({ apiKey: 'test-key', fetchImpl: async () => new Response(JSON.stringify(body)) })
    await rejectsCode(provider.rewrite({ blocks }), 'invalid_output')
  })
  const { provider } = fixture({ blocks: [output[0], { ...output[1], text: 'x'.repeat(1025) }] })
  await rejectsCode(provider.rewrite({ blocks }), 'invalid_output')
  const missingOpinion = fixture({ blocks: output })
  await rejectsCode(missingOpinion.provider.rewrite({ blocks, includeOpinion: true, summary: 'Summary' }), 'invalid_output')
  const unknown = fixture({ blocks: output, extra: 'surprise' })
  await rejectsCode(unknown.provider.rewrite({ blocks }), 'invalid_output')
})

test('upstream status and Retry-After survive while credentials and raw bodies never escape', async () => {
  for (const status of [400, 401, 403, 408, 429, 503]) {
    let bodyRead = false
    const stream = new ReadableStream({ pull() { bodyRead = true }, cancel() {} })
    const provider = createProvider({ apiKey: 'secret-test-key', fetchImpl: async () => new Response(stream, { status, headers: { 'Retry-After': '7' } }) })
    try { await provider.rewrite({ blocks }); assert.fail('Expected provider error') } catch (error) {
      assert.equal(error.status, status)
      assert.equal(error.retryable, status === 408 || status === 429 || status >= 500)
      assert.equal(error.retryAfter, 7)
      const safe = safeProviderError(error)
      assert.equal(safe.headers['Retry-After'], '7')
      assert.ok(!JSON.stringify(safe).includes('secret-test-key'))
    }
    // No response.text/json is used on error responses. A stream may pre-pull once.
    assert.equal(typeof bodyRead, 'boolean')
  }
  assert.equal(parseRetryAfter('2.1'), 3)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 10)
  assert.equal(parseRetryAfter('not-a-date'), null)
  assert.equal(safeProviderError(new Error('secret-test-key')).body.error.includes('secret'), false)
})

test('one attempt has a hard deadline, including a stalled response body', async () => {
  let calls = 0
  let signal
  const provider = createProvider({ apiKey: 'test-key', timeoutMs: 15, fetchImpl: (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}) } })
  await rejectsCode(provider.rewrite({ blocks }), 'provider_timeout', 504)
  assert.equal(calls, 1)
  assert.equal(signal.aborted, true)
  let cancelled = false
  const stalled = createProvider({ apiKey: 'test-key', timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true } })) })
  await rejectsCode(stalled.rewrite({ blocks }), 'provider_timeout', 504)
  assert.equal(cancelled, true)
})

test('caller cancellation is preserved before fetch and while in flight', async () => {
  const controller = new AbortController()
  const { provider, calls } = fixture()
  controller.abort()
  await rejectsCode(provider.rewrite({ blocks, signal: controller.signal }), 'cancelled', 499)
  assert.equal(calls.length, 0)
  const running = new AbortController()
  const pending = createProvider({ apiKey: 'test-key', fetchImpl: () => new Promise(() => {}) }).rewrite({ blocks, signal: running.signal })
  running.abort()
  await rejectsCode(pending, 'cancelled', 499)
})

test('bounded response bodies are cancelled, including misleading content length', async () => {
  for (const declared of [true, false]) {
    let cancelled = false
    const provider = createProvider({ apiKey: 'test-key', fetchImpl: async () => new Response(new ReadableStream({ start(c) { if (!declared) c.enqueue(new Uint8Array(PROVIDER_LIMITS.responseBytes + 1)) }, cancel() { cancelled = true } }), { headers: declared ? { 'Content-Length': String(PROVIDER_LIMITS.responseBytes + 1) } : {} }) })
    await rejectsCode(provider.rewrite({ blocks }), 'invalid_output')
    assert.equal(cancelled, true)
  }
})

test('provider concurrency is bounded and a finished call releases capacity', async () => {
  let resolveFetch
  const provider = createProvider({ apiKey: 'test-key', maxConcurrent: 1, fetchImpl: () => new Promise(resolve => { resolveFetch = resolve }) })
  const pending = provider.rewrite({ blocks })
  await Promise.resolve()
  await rejectsCode(provider.rewrite({ blocks }), 'provider_busy', 429)
  resolveFetch(completion({ blocks: output }))
  await pending
  const next = provider.rewrite({ blocks })
  await Promise.resolve()
  resolveFetch(completion({ blocks: output }))
  await next
})

test('usage metadata ignores arbitrary strings and invalid counts; invalid output is measured as failure', async () => {
  const metrics = []
  const provider = createProvider({ apiKey: 'test-key', onMetric: value => metrics.push(value), fetchImpl: async () => completion({ blocks: [] }, { model: 'actual-model', usage: { total_tokens: 50, prompt_tokens: -1, secret: 'credential', completion_tokens: '30', prompt_tokens_details: { cached_tokens: 25, extra: 'secret' } } }) })
  await rejectsCode(provider.rewrite({ blocks }), 'invalid_output')
  assert.equal(metrics[0].status, 502)
  assert.deepEqual(metrics[0].usage, { total_tokens: 50, prompt_tokens_details: { cached_tokens: 25 } })
})

test('legacy adapter preserves segment ordering and whitespace without coercion', async () => {
  const { provider } = fixture(({ body }) => ({ blocks: JSON.parse(body.messages[1].content).blocks.map(block => ({ ...block, text: 'Tremendous: ' + block.text.trim() })) }))
  const result = await rewritePayload(provider, { segments: [' One. ', 'Two.'] })
  assert.deepEqual(result.segments, [' Tremendous: One. ', 'Tremendous: Two.'])
  await rejectsCode(rewritePayload(provider, { segments: [null] }), 'invalid_input', 400)
})

test('legacy HTTP validates before acquiring budget and fails closed on unavailable budget', async () => {
  let generations = 0
  let budgets = 0
  const provider = { rewrite: async () => { generations++; return { blocks: output } } }
  const handler = createLegacyHandler({ provider, operation: 'rewrite', budget: { acquire: async () => { budgets++; throw new ProviderError('Capacity unavailable.', { status: 503, code: 'budget_unavailable', retryable: true, retryAfter: 3 }) } } })
  assert.equal((await handler(post({ segments: [7] }))).status, 400)
  assert.equal(budgets, 0)
  const response = await handler(post({ blocks }))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Retry-After'), '3')
  assert.equal(generations, 0)
  assert.equal((await createLegacyHandler({ provider, operation: 'rewrite' })(post({ blocks }))).status, 503)
})

test('legacy HTTP has bounded JSON, CORS, proper status and always releases its lease', async () => {
  let released = 0
  const provider = fixture().provider
  const handler = createLegacyHandler({ provider, operation: 'rewrite', budget: { acquire: async () => async () => { released++ } } })
  assert.equal((await handler(new Request('https://example.test', { method: 'OPTIONS' }))).status, 204)
  assert.equal((await handler(new Request('https://example.test'))).status, 405)
  assert.equal((await handler(new Request('https://example.test', { method: 'POST', body: '{}' }))).status, 415)
  assert.equal((await handler(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400)
  assert.equal((await handler(post({ padding: 'x'.repeat(PROVIDER_LIMITS.requestBytes) }))).status, 413)
  const success = await handler(post({ blocks }))
  assert.equal(success.status, 200)
  assert.equal(success.headers.get('Access-Control-Allow-Origin'), '*')
  assert.equal(released, 1)
  const failure = createLegacyHandler({ provider: { rewrite: async () => { throw new ProviderError('Busy.', { status: 429, retryable: true, retryAfter: 2 }) } }, operation: 'rewrite', budget: { acquire: async () => async () => { released++ } } })
  assert.equal((await failure(post({ blocks }))).status, 429)
  assert.equal(released, 2)
})

test('shared DB budget uses exact service RPCs, hashes client identity and releases idempotently', async () => {
  const calls = []
  const budget = createSupabaseProviderBudget({ url: 'https://project.supabase.co', serviceRoleKey: 'test-role-secret', fetchImpl: async (url, options) => { calls.push({ name: url.split('/').at(-1), args: JSON.parse(options.body), headers: options.headers }); return new Response(url.endsWith('release_provider_slot') ? null : 'true') } })
  const release = await budget.acquire(post({}, { 'x-forwarded-for': '192.0.2.7, 10.0.0.1' }))
  assert.deepEqual(calls.slice(0, 2).map(call => call.name), ['take_rate_budget', 'take_rate_budget'])
  assert.deepEqual(calls[0].args, { bucket: 'legacy:global', max_calls: 120, window_secs: 60 })
  assert.match(calls[1].args.bucket, /^legacy:client:[a-f0-9]{64}$/)
  assert.equal(calls[2].name, 'claim_provider_slot')
  assert.equal(calls[2].args.lease_secs, 35)
  assert.deepEqual(calls[3].args, { bucket: 'provider:daily', max_calls: 5000, window_secs: 86400 })
  assert.equal(JSON.stringify(calls.map(call => call.args)).includes('192.0.2.7'), false)
  await release(); await release()
  assert.deepEqual(calls[4].args, { owner: calls[2].args.owner })
  assert.equal(calls.filter(call => call.name === 'release_provider_slot').length, 1)
})

test('budget denial and broken DB prevent leases; uncertain claim attempts cleanup', async () => {
  for (const mode of ['denied', 'broken', 'claim-broken']) {
    const names = []
    const budget = createSupabaseProviderBudget({ url: 'https://project.supabase.co', serviceRoleKey: 'test-key', fetchImpl: async url => { const name = url.split('/').at(-1); names.push(name); if (mode === 'broken' || (mode === 'claim-broken' && name === 'claim_provider_slot')) return new Response('raw secret error', { status: 503 }); return new Response(mode === 'denied' ? 'false' : 'true') } })
    await assert.rejects(budget.acquire(post({})), error => error instanceof ProviderError && error.status === (mode === 'denied' ? 429 : 503))
    assert.equal(names.includes('claim_provider_slot'), mode === 'claim-broken')
    assert.equal(names.includes('release_provider_slot'), mode === 'claim-broken')
  }
  await rejectsCode(createSupabaseProviderBudget().acquire(post({})), 'budget_unavailable', 503)
})

test('daily shared provider backstop denies generation and releases the acquired slot', async () => {
  const calls = []
  const budget = createSupabaseProviderBudget({ url: 'https://project.supabase.co', serviceRoleKey: 'test-key', fetchImpl: async (url, options) => {
    const name = url.split('/').at(-1); const args = JSON.parse(options.body); calls.push({ name, args })
    return new Response(args.bucket === 'provider:daily' ? 'false' : name === 'release_provider_slot' ? null : 'true')
  } })
  await assert.rejects(budget.acquire(post({})), error => error.status === 429 && error.code === 'daily_budget_exceeded' && error.retryAfter === 86400)
  assert.equal(calls.at(-1).name, 'release_provider_slot')
  assert.equal(calls.at(-1).args.owner, calls.find(call => call.name === 'claim_provider_slot').args.owner)
})

test('local HTTP serves backward-compatible rewrite and article service without env side effects', async t => {
  const { provider } = fixture(({ body }) => ({ blocks: JSON.parse(body.messages[1].content).blocks.map(block => ({ ...block, text: 'Tremendous: ' + block.text })) }))
  let wakes = 0
  let requestKey
  const server = createRewriteServer({ provider, articleService: { handle: async (payload, context) => { requestKey = context.requestKey; return { state: 'queued', action: payload.action } }, wake: async () => { wakes++ } } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}`
  const result = await fetch(base + '/api/rewrite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments: ['First.', 'Second.'] }) })
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).segments, ['Tremendous: First.', 'Tremendous: Second.'])
  const article = await fetch(base + '/api/article', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', url: 'https://en.wikipedia.org/wiki/Fact' }) })
  assert.deepEqual(await article.json(), { state: 'queued', action: 'start' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(wakes, 1)
  assert.match(requestKey, /^[a-f0-9]{64}$/)
})

test('local HTTP client disconnect aborts its upstream request', async t => {
  let upstreamSignal
  let started
  const upstreamStarted = new Promise(resolve => { started = resolve })
  const provider = createProvider({ apiKey: 'test-key', fetchImpl: async (_url, options) => { upstreamSignal = options.signal; started(); return new Promise(() => {}) } })
  const server = createRewriteServer({ provider })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/api/rewrite', method: 'POST', headers: { 'Content-Type': 'application/json' } })
  req.on('error', () => {})
  req.end(JSON.stringify({ blocks }))
  await upstreamStarted
  req.destroy()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(upstreamSignal.aborted, true)
})

test('local HTTP rejects large declared and streamed request bodies with a visible 413', async t => {
  let generated = 0
  const server = createRewriteServer({ provider: { rewrite: async () => { generated++; return { blocks: [] } } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const body = JSON.stringify({ segments: ['x'.repeat(PROVIDER_LIMITS.requestBytes + 1024)] })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rewrite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'input_too_large')
  const streamedStatus = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/api/rewrite', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)) })
    req.once('error', reject)
    req.write(body.slice(0, 80000)); req.end(body.slice(80000))
  })
  assert.equal(streamedStatus, 413)
  assert.equal(generated, 0)
})

test('article HTTP preserves safe service errors and does not wake failed requests', async t => {
  let wakes = 0
  const error = Object.assign(new Error('Rate limited.'), { status: 429, retryAfter: 9, retryable: true })
  const server = createRewriteServer({ provider: fixture().provider, articleService: { handle: async () => { throw error }, wake() { wakes++ } }, mapArticleError: value => ({ error: value.message, retryable: value.retryable }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"start"}' })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('Retry-After'), '9')
  assert.deepEqual(await response.json(), { error: 'Rate limited.', retryable: true })
  assert.equal(wakes, 0)
})
