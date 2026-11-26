import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createProvider } from '../supabase/functions/_shared/provider.mjs'
import { createArticleService, createMemoryStore } from '../supabase/functions/_shared/article-jobs.mjs'
const url = 'https://en.wikipedia.org/wiki/Integration_test'
const prose = 'This is a long encyclopedia paragraph with meaningful context and an inline source link to preserve. '
const source = `<div class="mw-parser-output"><p>${prose}<a href="/wiki/Example">Example</a>.</p><h2>History</h2><p>${prose.repeat(70)}</p><h2>References</h2><ol><li>${prose}</li></ol></div>`

test('the real strict provider and article engine generate, checkpoint and reuse one shared job', async () => {
  let modelCalls = 0
  const provider = createProvider({ apiKey: 'offline-test-key', fetchImpl: async (_url, init) => {
    modelCalls += 1
    const body = JSON.parse(init.body)
    const input = JSON.parse(body.messages[1].content)
    const output = { blocks: input.blocks.map(b => ({ id: b.id, text: b.text.replace('encyclopedia', 'tremendous encyclopedia') })) }
    if (body.response_format.json_schema.schema.properties.opinion) output.opinion = 'A tremendous test. The best test!'
    return new Response(JSON.stringify({ model: 'actual-test-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }))
  } })
  const store = createMemoryStore()
  const service = createArticleService({ store, provider, parseDocument: html => new JSDOM(html).window.document, resolveIdentity: false, fetchImpl: async () => new Response(JSON.stringify({ parse: { title: 'Integration test', text: source } })) })
  const [a,b] = await Promise.all([service.start({ url }),service.start({ url })])
  assert.equal(a.jobId,b.jobId)
  await service.dispatch()
  const ready = await service.status({ jobId: a.jobId })
  assert.equal(ready.status, 'complete')
  assert.equal(ready.failedCount, 0)
  assert.ok(modelCalls > 1)
  assert.equal(ready.article.metrics.calls, modelCalls)
  assert.equal(ready.article.metrics.inputTokens, modelCalls * 100)
  assert.match(ready.article.sections.map(s=>s.html).join(''), /tremendous encyclopedia/)
  const cached = await service.start({ url })
  assert.equal(cached.jobId,a.jobId)
  await service.dispatch()
  assert.equal(ready.article.metrics.calls,modelCalls)
  service.close()
})
