import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createProvider } from '../supabase/functions/_shared/provider.mjs'
import { createArticleService, createMemoryStore } from '../supabase/functions/_shared/article-jobs.mjs'
const url = 'https://en.wikipedia.org/wiki/Integration_test'
const prose = 'This is a long encyclopedia paragraph with meaningful context and an inline source link to preserve. '
const source = `<div class="mw-parser-output"><p>${prose}<a href="/wiki/Example">Example</a>.</p><h2>History</h2><p>${prose.repeat(70)}</p><h2>References</h2><ol><li>${prose}</li></ol></div>`

test('the real strict provider and article engine generate, checkpoint and reuse one shared job', async () => {
  let modelCalls = 0; let spanCalls = 0
  const provider = createProvider({ apiKey: 'offline-test-key', fetchImpl: async (_url, init) => {
    modelCalls += 1
    const body = JSON.parse(init.body)
    const input = JSON.parse(body.messages[1].content)
    const output = input.blocks
      ? { blocks: input.blocks.map(b => ({ id: b.id, text: b.text.replace('encyclopedia', 'tremendous encyclopedia') })) }
      : { opinion: 'A tremendous test. The best test!' }
    if (input.blocks) {
      assert.equal(input.blocks.length, 1); assert.equal(input.opinion, undefined); assert.equal(body.response_format.json_schema.schema.properties.opinion, undefined)
      const spanSchema = body.response_format.json_schema.schema.properties.blocks.items.properties.spans
      if (spanSchema) {
        spanCalls++
        const block = input.blocks[0]; const markers = block.text.match(/__TRUMPEDIA_\d+__/g) || []
        assert.equal(block.spans.length, markers.length + 1)
        assert.equal(spanSchema.minItems, block.spans.length); assert.equal(spanSchema.maxItems, block.spans.length)
        assert.equal(block.spans.map((span,index) => (index ? markers[index - 1] : '') + span).join(''), block.text)
        output.blocks = output.blocks.map(({ id, text }) => ({ id, spans: text.split(/__TRUMPEDIA_\d+__/g) }))
        assert.equal(output.blocks[0].spans.length, block.spans.length)
        assert.equal(Object.hasOwn(output.blocks[0], 'text'), false)
      }
    }
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
  assert.ok(modelCalls > 1); assert.ok(spanCalls > 0, 'Protected markup must exercise the real spans wire protocol')
  assert.equal(modelCalls, ready.total + 1)
  assert.deepEqual(ready.article.metrics.stages, { opinion: 1, body: ready.total })
  assert.equal(ready.article.metrics.calls, modelCalls)
  assert.equal(ready.article.metrics.inputTokens, modelCalls * 100)
  const finalHtml = ready.article.sections.map(s=>s.html).join('')
  assert.match(finalHtml, /tremendous encyclopedia/)
  assert.doesNotMatch(finalHtml, /__TRUMPEDIA_\d+__/)
  const finalDom = new JSDOM(finalHtml).window.document
  assert.equal(finalDom.querySelectorAll('a[href="https://en.wikipedia.org/wiki/Example"]').length, 1)
  assert.equal(finalDom.querySelector('a[href="https://en.wikipedia.org/wiki/Example"]').textContent, 'Example')
  const cached = await service.start({ url })
  assert.equal(cached.jobId,a.jobId)
  await service.dispatch()
  assert.equal(ready.article.metrics.calls,modelCalls)
  service.close()
})
