import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { prepareArticle, renderArticle, makeBatches, parseWikipediaUrl, sanitizeHtml, validateMarkers, MAX_BLOCK_CHARS } from '../supabase/functions/_shared/article-plan.mjs'
const parse = html => new JSDOM(html).window.document
const sentence = 'This is a sufficiently long paragraph about the subject that deserves a contextual rewrite.'

test('canonical URLs support mobile, Unicode and article colons without allowing foreign hosts', () => {
  assert.equal(parseWikipediaUrl('https://en.m.wikipedia.org/wiki/Star_Trek:_Voyager#Cast').canonicalUrl, 'https://en.wikipedia.org/wiki/Star_Trek%3A_Voyager')
  assert.equal(parseWikipediaUrl('http://fr.wikipedia.org/wiki/Caf%C3%A9?oldid=1').title, 'Café')
  for (const url of ['https://en.wikipedia.org.evil.org/wiki/Test', 'https://en.wikipedia.org/wiki/Special:Random', 'https://x@en.wikipedia.org/wiki/Test', 'https://en.wikipedia.org/w/index.php', 'javascript:alert(1)']) assert.throws(() => parseWikipediaUrl(url))
})
test('rewrites whole prose with protected inline links; excludes all ancestor navigation and reference text', () => {
  const plan = prepareArticle(`<div class="mw-parser-output"><p>${sentence} <a href="/wiki/Test"><b>Important source</b></a>.</p><div class="navbox"><div><p>${sentence}</p></div></div><table><tr><td><p>${sentence}</p></td></tr></table><h2>References</h2><ul><li>${sentence}</li></ul></div>`, 'en', parse)
  assert.equal(plan.blocks.length, 1)
  assert.match(plan.blocks[0].text, /__TRUMPEDIA_0__/)
  const out = renderArticle(plan, { [plan.blocks[0].id]: plan.blocks[0].text.replace('sufficiently', 'tremendously') })
  assert.match(out.html, /tremendously/)
  assert.match(out.html, /href="https:\/\/en.wikipedia.org\/wiki\/Test"/)
  assert.match(out.html, /<b>Important source<\/b>/)
  assert.equal(out.rewriteMode, 'llm')
})
test('finished sections appear progressively; failed output retains original with explicit partial quality', () => {
  const plan = prepareArticle(`<p>${sentence}</p><h2>History</h2><p>${sentence} History.</p>`, 'en', parse)
  const outputs = { [plan.blocks[0].id]: 'Tremendous! ' + plan.blocks[0].text }
  const running = renderArticle(plan, outputs)
  assert.equal(running.sections[0].complete, true)
  assert.equal(running.sections[1].complete, false)
  assert.doesNotMatch(running.html, /History/)
  const partial = renderArticle(plan, outputs, { finished: true, failedIds: [plan.blocks[1].id] })
  assert.equal(partial.rewriteMode, 'llm-partial')
  assert.equal(partial.failedCount, 1)
  assert.equal(partial.sections[1].complete, false)
  assert.match(partial.html, /History/)
})
test('marker omissions, duplicates and reordering cannot shift or corrupt inline formatting', () => {
  const input = '__TRUMPEDIA_0__link__TRUMPEDIA_1__ and __TRUMPEDIA_2__bold__TRUMPEDIA_3__'
  assert.equal(validateMarkers(input, input.replace('link', 'tremendous link')), true)
  for (const bad of [input.replace('__TRUMPEDIA_1__', ''), input + '__TRUMPEDIA_0__', input.replace('__TRUMPEDIA_0__', '__TRUMPEDIA_1__')]) assert.equal(validateMarkers(input, bad), false)
  const plan = prepareArticle(`<p>${sentence} <a href="/wiki/Test">some source</a></p>`, 'en', parse)
  const result = renderArticle(plan, { [plan.blocks[0].id]: '<img src=x onerror=alert(1)> ' + plan.blocks[0].text }, { finished: true })
  assert.match(result.html, /&lt;img/)
  assert.doesNotMatch(result.html, /<img/)
})
test('source and old cached HTML are sanitized before inclusion', () => {
  const clean = sanitizeHtml(`<script>alert(1)</script><svg><a href="javascript:alert(1)">x</a></svg><p onclick="x()" style="position:fixed">${sentence}<a href="javascript:x()">bad</a><img src="//upload.wikimedia.org/a.png" onerror="x()"></p>`, 'en', parse)
  assert.doesNotMatch(clean, /script|svg|onclick|onerror|javascript|style=/)
  assert.match(clean, /src="https:\/\/upload.wikimedia.org\/a.png"/)
  assert.match(clean, /loading="lazy"/)
})
test('large paragraphs split with stable IDs, bounded batches, and lossless inline markup', () => {
  const original = `<p>${sentence.repeat(170)}<a href="/wiki/Test">${sentence.repeat(70)}</a>${sentence.repeat(50)}</p>`
  const plan = prepareArticle(original, 'en', parse)
  assert.ok(plan.blocks.length > 3)
  assert.equal(new Set(plan.blocks.map(b => b.id)).size, plan.blocks.length)
  assert.ok(plan.blocks.every(b => b.text.length <= MAX_BLOCK_CHARS))
  for (const batch of makeBatches(plan.blocks)) {
    assert.ok(batch.length <= 12)
    assert.ok(batch.reduce((sum,b) => sum + b.text.length, 0) <= 6000)
  }
  const result = renderArticle(plan, Object.fromEntries(plan.blocks.map(b => [b.id,b.text])))
  assert.equal(parse(result.html).body.textContent, parse(original).body.textContent)
  assert.equal(parse(result.html).querySelectorAll('a').length, 1)
})

test('non-Latin prose is eligible and a page with no rewriteable prose is never labelled model-written', () => {
  const plan = prepareArticle('<p>これは百科事典の記事の十分に長い日本語の段落です。文脈を保持しながら記事の本文全体を処理する必要があります。</p>', 'ja', parse)
  assert.equal(plan.blocks.length, 1)
  const empty = prepareArticle('<p>Short.</p>', 'en', parse)
  assert.equal(renderArticle(empty, {}, { finished: true }).rewriteMode, 'heuristic')
})
