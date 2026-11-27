import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createProvider } from '../supabase/functions/_shared/provider.mjs'
import { createArticleService, createMemoryStore } from '../supabase/functions/_shared/article-jobs.mjs'
const url = 'https://en.wikipedia.org/wiki/Integration_test'
const prose = 'This is a long encyclopedia paragraph with meaningful context and an inline source link to preserve. '
const source = `<div class="mw-parser-output"><p>${prose}<a href="/wiki/Example">Example</a>.</p><h2>History</h2><p>${prose.repeat(70)}</p><h2>References</h2><ol><li>${prose}</li></ol></div>`

test('the real strict provider and article engine generate, checkpoint and reuse one shared job', async () => {
  let modelCalls = 0; let paragraphCalls = 0; let reviewCalls = 0
  const viewpoint = { admire: 'practical skill', question: 'unnecessary fuss' }
  const provider = createProvider({ apiKey: 'offline-test-key', fetchImpl: async (_url, init) => {
    modelCalls += 1
    const body = JSON.parse(init.body)
    const input = JSON.parse(body.messages.at(-1).content)
    let output
    if (input.kind) {
      reviewCalls++
      const checks = input.kind === 'opinion'
        ? [{ source_fact: 'Subjective preference; no factual premise', candidate_support: input.candidate_opinion, preserved: true }]
        : input.source_paragraphs.flatMap(block => {
          const candidate = input.candidate_paragraphs.find(value => value.id === block.id)
          const support = candidate.text.includes('with meaningful context and a source link kept intact.')
            ? 'with meaningful context and a source link kept intact.'
            : candidate.text.slice(0, 240)
          return [
            { source_fact: 'The encyclopedia paragraph provides meaningful context.', candidate_support: support, preserved: true },
            { source_fact: 'The paragraph includes an inline source link to preserve.', candidate_support: support, preserved: true },
          ]
        })
      output = { checks, facts_preserved: true, point_of_view_consistent: true, substantive_rewrite: true, issues: [] }
    } else if (input.source_paragraphs) {
      paragraphCalls++
      assert.equal(input.source_paragraphs.length, 1)
      assert.deepEqual(input.article_viewpoint, viewpoint)
      output = { paragraphs: input.source_paragraphs.map(({ id, source }) => ({ id, notes: ['Retain the factual account, qualifiers and original source link.'], rewritten: source.replaceAll(prose, 'Here is how I see this subject: the encyclopedia lays out a tremendous, detailed account, with meaningful context and a source link kept intact. ') })) }
    } else output = { opinion: 'A tremendous test. The best test!', viewpoint }
    return new Response(JSON.stringify({ model: 'actual-test-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 80, cost_in_usd_ticks: 250 } }))
  } })
  const store = createMemoryStore()
  const service = createArticleService({ store, provider, parseDocument: html => new JSDOM(html).window.document, resolveIdentity: false, fetchImpl: async () => new Response(JSON.stringify({ parse: { title: 'Integration test', text: source } })) })
  const [a,b] = await Promise.all([service.start({ url }),service.start({ url })])
  assert.equal(a.jobId,b.jobId)
  await service.dispatch()
  const ready = await service.status({ jobId: a.jobId })
  assert.equal(ready.status, 'complete')
  assert.equal(ready.failedCount, 0)
  assert.ok(modelCalls > 1); assert.equal(paragraphCalls, ready.total); assert.equal(reviewCalls, ready.total + 1)
  assert.equal(modelCalls, (ready.total + 1) * 2)
  assert.deepEqual(ready.article.metrics.stages, { opinion: 1, 'opinion-review': 1, body: ready.total, review: ready.total })
  assert.equal(ready.article.metrics.calls, modelCalls)
  assert.equal(ready.article.metrics.inputTokens, modelCalls * 100)
  assert.equal(ready.article.metrics.costUsdTicks, modelCalls * 250)
  const finalHtml = ready.article.sections.map(s=>s.html).join('')
  assert.match(finalHtml, /tremendous, detailed account/)
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
