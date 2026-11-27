import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { prepareArticle, renderArticle, makeBatches, parseWikipediaUrl, sanitizeHtml, validateMarkers, MAX_BLOCK_CHARS, MAX_ATOM_CHARS, KEEP_PATTERN, PIPELINE_VERSION } from '../supabase/functions/_shared/article-plan.mjs'
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
  assert.equal(PIPELINE_VERSION, 'paragraphs-v5')
  assert.match(plan.blocks[0].text, /<keep id="0">Important source<\/keep>/)
  assert.equal(plan.units[0].slots.length, 1)
  assert.match(plan.units[0].slots[0].html, /<a[^>]*><b>Important source<\/b><\/a>/)
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
test('approved paragraphs appear in their source positions inside an unfinished section', () => {
  const plan = prepareArticle(`<h2>History</h2><p>First: ${sentence} <a href="/wiki/Test">Original link</a>.</p><p>Second: ${sentence}</p><ul><li>Third: ${sentence}</li></ul>`, 'en', parse)
  const outputs = { [plan.blocks[1].id]: 'A tremendous second paragraph, ready before its neighbors.' }
  const running = renderArticle(plan, outputs)
  const section = running.sections[1]
  assert.equal(section.complete, false)
  const doc = parse(section.html)
  assert.equal(doc.querySelectorAll('[data-trumpedia-unit]').length, 3)
  assert.equal(doc.querySelectorAll('.paragraph-placeholder').length, 2)
  assert.equal(doc.querySelectorAll('ul > li > .paragraph-placeholder').length, 1)
  assert.match(doc.querySelectorAll('p')[1].textContent, /tremendous second paragraph/)
  assert.doesNotMatch(doc.body.textContent, /First:|Third:|Original link|sufficiently long/)
  const next = renderArticle(plan, { ...outputs, [plan.blocks[0].id]: plan.blocks[0].text.replace('sufficiently', 'tremendously') })
  assert.equal(next.sections[1].complete, false)
  assert.match(next.sections[1].html, /href="https:\/\/en.wikipedia.org\/wiki\/Test"/)
  assert.equal(parse(next.sections[1].html).querySelectorAll('.paragraph-placeholder').length, 1)
})
test('a split paragraph stays hidden until all of its model blocks are approved', () => {
  const plan = prepareArticle(`<p>${sentence.repeat(75)}</p><p>A separate paragraph: ${sentence}</p>`, 'en', parse)
  const large = plan.units[0]; const small = plan.units[1]
  assert.ok(large.blockIds.length > 1)
  const outputs = { [large.blockIds[0]]: 'Only a fragment has passed review.', [small.blockIds[0]]: 'A completely reviewed neighboring paragraph.' }
  const running = renderArticle(plan, outputs)
  assert.match(running.html, /completely reviewed neighboring paragraph/)
  assert.doesNotMatch(running.html, /Only a fragment|sufficiently long/)
  assert.equal(parse(running.html).querySelectorAll('.paragraph-placeholder').length, 1)
  const complete = renderArticle(plan, { ...outputs, ...Object.fromEntries(large.blockIds.map(id => [id, plan.blocks.find(block => block.id === id).text])) })
  assert.equal(complete.sections[0].complete, true)
  assert.equal(parse(complete.html).querySelectorAll('.paragraph-placeholder').length, 0)
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
test('whole nested inline HTML is immutable while surrounding prose can be rephrased', () => {
  const plan = prepareArticle(`<p>${sentence} <a href="/wiki/Research"><strong>R&amp;D &lt;guide&gt;</strong></a> and <em lang="fr">déjà vu</em><sup class="reference"><a href="#cite-1">[1]</a></sup>.</p>`, 'en', parse)
  const block = plan.blocks[0]
  const slots = plan.units[0].slots
  assert.deepEqual(slots.map(slot => slot.marker), ['<keep id="0">R&amp;D &lt;guide&gt;</keep>', '<keep id="1">déjà vu</keep>', '<keep id="2">[1]</keep>'])
  assert.equal(slots[0].html.includes('<strong>R&amp;D &lt;guide&gt;</strong>'), true)
  const output = block.text.replace('sufficiently long', 'tremendously detailed')
  const result = renderArticle(plan, { [block.id]: output })
  const doc = parse(result.html)
  assert.equal(doc.querySelector('a strong').textContent, 'R&D <guide>')
  assert.equal(doc.querySelector('em').getAttribute('lang'), 'fr')
  assert.equal(doc.querySelector('sup.reference a').getAttribute('href'), '#cite-1')
  assert.doesNotMatch(result.html, /<keep\b|&lt;keep\b/)
  assert.match(result.html, /tremendously detailed/)
})
test('atom labels canonicalize invisible whitespace without changing source HTML or text gaps', () => {
  const raw = `<p>\n  ${sentence}\t <span lang="fr">\u00a0 romanized:\u00a0\n\t R&amp;D \u00a0</span>\n\tThe original gaps remain here.  </p>`
  const original = parse(raw)
  const plan = prepareArticle(raw, 'en', parse)
  const block = plan.blocks[0]
  const slot = plan.units[0].slots[0]
  assert.equal(slot.marker, '<keep id="0">romanized: R&amp;D</keep>')
  assert.equal(slot.html, original.querySelector('span').outerHTML)
  assert.equal(block.text, `\n  ${sentence}\t ${slot.marker}\n\tThe original gaps remain here.  `)
  const rendered = parse(renderArticle(plan, { [block.id]: block.text }).html)
  assert.equal(rendered.querySelector('span').outerHTML, original.querySelector('span').outerHTML)
  assert.equal(rendered.body.textContent, original.body.textContent)
  const savedToken = '<keep id="12">romanized:\u00a0</keep>'
  assert.equal(validateMarkers('Original ' + savedToken, 'Rewritten ' + savedToken), true)
  assert.equal(validateMarkers('Original ' + savedToken, 'Rewritten <keep id="12">romanized:</keep>'), false)
})
test('atomic drops, duplicates, altered labels, extra IDs and malformed tags are rejected', () => {
  const source = 'The <keep id="0">museum</keep> displays <keep id="1">local history</keep>.'
  const first = '<keep id="0">museum</keep>'
  const second = '<keep id="1">local history</keep>'
  assert.equal(validateMarkers(source, source.replace('displays', 'shows off')), true)
  assert.equal(validateMarkers(source, source.replace(first, '__TEMP__').replace(second, first).replace('__TEMP__', second)), true)
  for (const bad of [
    source.replace(first, ''), source + first, source.replace('>museum<', '>fake museum<'),
    source + '<keep id="2">invented</keep>', source + '<keep id=x>bad</keep>',
    source + '__TRUMPEDIA_0__', source + '<keep id="3">unclosed',
  ]) assert.equal(validateMarkers(source, bad), false, bad)
  assert.equal(validateMarkers('Plain source prose.', source), false)
  assert.equal(validateMarkers('<keep id="0">first</keep><keep id="0">second</keep>', '<keep id="0">first</keep><keep id="0">second</keep>'), false)
})
test('closed atoms reorder inside their boundary zones without changing nested source HTML', () => {
  const plan = prepareArticle(`<p>${sentence} <a href="/wiki/Alpha"><b>Alpha</b></a> and <a href="/wiki/Beta">Beta</a>. <em lang="fr">${sentence} <a href="/wiki/Gamma"><strong>Gamma</strong></a> and <a href="/wiki/Delta">Delta</a>.</em> Finally <a href="/wiki/Epsilon">Epsilon</a>.</p>`, 'en', parse)
  const block = plan.blocks[0]
  const atoms = block.text.match(KEEP_PATTERN)
  assert.deepEqual(atoms.map(atom => atom.replace(/^.*?">|<\/keep>$/g, '')), ['Alpha', 'Beta', '', 'Gamma', 'Delta', '', 'Epsilon'])
  const swapped = new Map([[atoms[0], atoms[1]], [atoms[1], atoms[0]], [atoms[3], atoms[4]], [atoms[4], atoms[3]]])
  const output = block.text.replace(KEEP_PATTERN, atom => swapped.get(atom) || atom) + '<img src=x onerror=alert(1)>'
  assert.equal(validateMarkers(block.text, output), true)
  const rendered = renderArticle(plan, { [block.id]: output })
  const doc = parse(rendered.html)
  assert.deepEqual(Array.from(doc.querySelectorAll('p > a'), node => node.textContent), ['Beta', 'Alpha', 'Epsilon'])
  assert.deepEqual(Array.from(doc.querySelectorAll('em a'), node => node.textContent), ['Delta', 'Gamma'])
  assert.equal(doc.querySelector('em').getAttribute('lang'), 'fr')
  assert.equal(doc.querySelector('a[href$="/Alpha"] b').textContent, 'Alpha')
  assert.equal(doc.querySelector('em a[href$="/Gamma"] strong').textContent, 'Gamma')
  assert.equal(doc.querySelectorAll('img').length, 0)
  assert.match(rendered.html, /&lt;img/)
  assert.equal(rendered.rewriteMode, 'llm')
})
test('closed atoms cannot cross empty boundaries or change their nesting sequence', () => {
  const atoms = ['<keep id="0">outside</keep>', '<keep id="1"></keep>', '<keep id="2">inside</keep>', '<keep id="3">also inside</keep>', '<keep id="4"></keep>', '<keep id="5">after</keep>']
  const source = atoms.join(' ')
  assert.equal(validateMarkers(source, [atoms[0], atoms[1], atoms[3], atoms[2], atoms[4], atoms[5]].join(' ')), true)
  for (const order of [[2, 1, 0, 3, 4, 5], [0, 2, 1, 3, 4, 5], [0, 1, 2, 5, 4, 3], [0, 4, 2, 3, 1, 5]]) {
    assert.equal(validateMarkers(source, order.map(index => atoms[index]).join(' ')), false, order.join(','))
  }
  for (const bad of [source.replace(atoms[1], ''), source + atoms[4], source.replace(atoms[1], '<keep id="1">invented</keep>')]) assert.equal(validateMarkers(source, bad), false)
  const mixed = source + ' __TRUMPEDIA_0__legacy__TRUMPEDIA_1__'
  assert.equal(validateMarkers(mixed, mixed.replace('__TRUMPEDIA_0__', '__TEMP__').replace('__TRUMPEDIA_1__', '__TRUMPEDIA_0__').replace('__TEMP__', '__TRUMPEDIA_1__')), false)
})
test('saved legacy boundary-marker plans still restore their original link structure', () => {
  const id = 'u00000-0'
  const original = 'The __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened in 1920.'
  const plan = {
    version: 'paragraphs-v3', summary: '', sourceTextChars: original.length,
    blocks: [{ id, text: original, sectionId: 'lead' }],
    units: [{ id: 'u00000', openHtml: '<p>', closeHtml: '</p>', blockIds: [id], slots: [{ marker: '__TRUMPEDIA_0__', html: '<a href="https://en.wikipedia.org/wiki/Museum">' }, { marker: '__TRUMPEDIA_1__', html: '</a>' }] }],
    sections: [{ id: 'lead', title: 'Introduction', template: '<!--TRUMPEDIA_UNIT_u00000-->', blockIds: [id] }],
  }
  const rendered = renderArticle(plan, { [id]: 'In 1920, the __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened its doors—a tremendous event.' })
  assert.equal(rendered.rewriteMode, 'llm')
  assert.equal(parse(rendered.html).querySelector('a').textContent, 'museum')
  assert.equal(parse(rendered.html).querySelector('a').getAttribute('href'), 'https://en.wikipedia.org/wiki/Museum')
})
test('restoration escapes model HTML and never rescans restored source attributes as tokens', () => {
  const title = '<keep id="1">second link</keep>'
  const plan = prepareArticle(`<p>${sentence} <a title="&lt;keep id=&quot;1&quot;&gt;second link&lt;/keep&gt;" href="/wiki/One">first link</a> and <a href="/wiki/Two">second link</a>.</p>`, 'en', parse)
  const block = plan.blocks[0]
  const output = '<img src=x onerror=alert(1)> ' + block.text
  const result = renderArticle(plan, { [block.id]: output })
  const doc = parse(result.html)
  assert.equal(doc.querySelectorAll('a').length, 2)
  assert.equal(doc.querySelector('a').getAttribute('title'), title)
  assert.equal(doc.querySelectorAll('img').length, 0)
  assert.match(result.html, /&lt;img/)
})
test('source literal protocol collisions remain unchanged source instead of creating slots', () => {
  for (const raw of [
    `<p>${sentence} &lt;keep id="0"&gt;literal&lt;/keep&gt;</p>`,
    `<p>${sentence} <keep id="0">source element</keep></p>`,
    `<p>${sentence} __TRUMPEDIA_0__</p>`,
  ]) {
    const plan = prepareArticle(raw, 'en', parse)
    assert.equal(plan.blocks.length, 0)
    assert.equal(plan.units.length, 0)
    const rendered = renderArticle(plan, {}, { finished: true })
    assert.equal(rendered.rewriteMode, 'heuristic')
    assert.match(parse(rendered.html).body.textContent, /sufficiently long paragraph/)
  }
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
  assert.ok(plan.units[0].slots.every(slot => slot.marker.length <= MAX_ATOM_CHARS))
  assert.ok(plan.units[0].slots.some(slot => slot.marker.endsWith('></keep>') && slot.html.startsWith('<a ')))
  for (const block of plan.blocks) {
    const atomless = block.text.replace(KEEP_PATTERN, '')
    assert.doesNotMatch(atomless, /<\/?keep\b/)
  }
  for (const batch of makeBatches(plan.blocks)) {
    assert.ok(batch.length <= 12)
    assert.ok(batch.reduce((sum,b) => sum + b.text.length, 0) <= 6000)
  }
  const result = renderArticle(plan, Object.fromEntries(plan.blocks.map(b => [b.id,b.text])))
  assert.equal(parse(result.html).body.textContent, parse(original).body.textContent)
  assert.equal(parse(result.html).querySelectorAll('a').length, 1)
})
test('long nested wrappers split without splitting any keep token and restore coherent HTML', () => {
  const raw = `<p>${sentence.repeat(55)}<em lang="fr"><a href="/wiki/Test"><strong>${sentence.repeat(90)}</strong></a></em>${sentence.repeat(20)}</p>`
  const plan = prepareArticle(raw, 'en', parse)
  assert.ok(plan.blocks.length > 2)
  assert.ok(plan.blocks.every(block => block.text.length <= MAX_BLOCK_CHARS && !/<\/?keep\b/.test(block.text.replace(KEEP_PATTERN, ''))))
  const result = renderArticle(plan, Object.fromEntries(plan.blocks.map(block => [block.id, block.text])))
  const doc = parse(result.html)
  assert.equal(doc.body.textContent, parse(raw).body.textContent)
  assert.equal(doc.querySelectorAll('em[lang="fr"] a strong').length, 1)
  assert.equal(doc.querySelector('a').getAttribute('href'), 'https://en.wikipedia.org/wiki/Test')
})
test('oversized opaque code stays source rather than becoming editable model prose', () => {
  const plan = prepareArticle(`<p>${sentence}<code>${'immutable_code '.repeat(100)}</code></p>`, 'en', parse)
  assert.equal(plan.blocks.length, 0)
  assert.match(renderArticle(plan, {}, { finished: true }).html, /immutable_code/)
})
test('ordinary paragraph prose inside emphasis and links stays editable instead of becoming a frozen label', () => {
  for (const wrapper of [text => `<i lang="en">${text}</i>`, text => `<a href="/wiki/Test">${text}</a>`]) {
    const raw = `<p>${wrapper(sentence)}</p>`
    const plan = prepareArticle(raw, 'en', parse)
    assert.equal(plan.blocks.length, 1)
    assert.equal(plan.units[0].slots.length, 2)
    assert.ok(plan.units[0].slots.every(slot => /<keep id="\d+"><\/keep>/.test(slot.marker)))
    assert.match(plan.blocks[0].text, /sufficiently long paragraph/)
    const output = plan.blocks[0].text.replace('sufficiently long', 'tremendously detailed')
    const result = renderArticle(plan, { [plan.blocks[0].id]: output })
    const doc = parse(result.html)
    assert.match(doc.querySelector('i, a').textContent, /tremendously detailed/)
    if (doc.querySelector('a')) assert.equal(doc.querySelector('a').getAttribute('href'), 'https://en.wikipedia.org/wiki/Test')
  }
})
test('short named labels and long proper-name links stay immutable while name-only lists and quotes remain source', () => {
  const properName = 'United Nations Department for International Economic and Social Affairs'
  const plan = prepareArticle(`<p>${sentence} <a href="/wiki/United_Nations">${properName}</a> and <i>zarf</i>.</p>`, 'en', parse)
  assert.equal(plan.blocks.length, 1)
  assert.equal(plan.units[0].slots.length, 2)
  assert.match(plan.units[0].slots[0].marker, /United Nations Department/)
  assert.equal(plan.units[0].slots[1].marker, '<keep id="1">zarf</keep>')
  for (const raw of [
    `<ul><li><a href="/wiki/United_Nations">${properName}</a></li></ul>`,
    `<p><q>${sentence}</q></p>`,
    `<p><code>${sentence}</code></p>`,
  ]) {
    const excluded = prepareArticle(raw, 'en', parse)
    assert.equal(excluded.blocks.length, 0)
    assert.equal(renderArticle(excluded, {}, { finished: true }).rewriteMode, 'heuristic')
  }
})

test('non-Latin prose is eligible and a page with no rewriteable prose is never labelled model-written', () => {
  const plan = prepareArticle('<p>これは百科事典の記事の十分に長い日本語の段落です。文脈を保持しながら記事の本文全体を処理する必要があります。</p>', 'ja', parse)
  assert.equal(plan.blocks.length, 1)
  const empty = prepareArticle('<p>Short.</p>', 'en', parse)
  assert.equal(renderArticle(empty, {}, { finished: true }).rewriteMode, 'heuristic')
})
