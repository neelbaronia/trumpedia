import test from 'node:test'
import assert from 'node:assert/strict'
import { assessRewrite, REWRITE_QUALITY_LIMITS } from '../supabase/functions/_shared/rewrite-quality.mjs'
const keep = (id, label) => `<keep id="${id}">${label}</keep>`
const accepted = (source, output) => { const result = assessRewrite(source, output); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.reason, null); return result }
const rejected = (source, output, reason) => { const result = assessRewrite(source, output); assert.equal(result.ok, false, JSON.stringify(result)); if (reason) assert.equal(result.reason, reason); return result }

const actualMinimalEdits = [
  [
    `${keep(0, 'Petrissage')} (French, from ${keep(1, 'pétrir')} 'to knead') is a massage technique that applies deep pressure to the underlying muscles. Kneading, wringing, skin rolling, and pick-up-and-squeeze are the petrissage movements. They are all performed with the padded palmar surface of the hand, the surface of the finger and also the thumbs.`,
    `${keep(0, 'Petrissage')} (French, from ${keep(1, 'pétrir')} 'to knead') is a massage technique that applies tremendous, deep pressure to the underlying muscles. Kneading, wringing, skin rolling, and pick-up-and-squeeze are the petrissage movements. They are all performed with the padded palmar surface of the hand, the surface of the finger and also the thumbs.`,
  ],
  [
    'During kneading, the hands should be moulded to the area and the movements should be slow and rhythmical, with the tissue between the hands as the focus of the work.',
    'During kneading, the hands have to be moulded to the area and the movements must be slow and rhythmical, with the tissue between the hands as the focus of the work, tremendous focus.',
  ],
  [
    'Knuckling is another form of kneading but using the knuckles to knead and lift in circular and upwards motions.',
    'Knuckling, believe me, is another fantastic form of kneading but using the knuckles to knead and lift in circular and upwards motions—tremendous motions, the best.',
  ],
]

test('rejects all three observed Petrissage minimal edits rather than merely checking changed text', () => {
  for (const [source, output] of actualMinimalEdits) {
    const result = rejected(source, output, 'excessive_copying')
    assert.ok(result.metrics.wordRetention > 0.8)
    assert.ok(result.metrics.longestCopyRun >= 8)
  }
})

test('rejects exact copies, case/punctuation-only changes, source wrapping and scattered insertions', () => {
  const source = 'The local museum opened its doors to visitors and displayed paintings from several nearby towns.'
  rejected(source, source, 'unchanged_prose')
  rejected(source, source.toUpperCase().replaceAll(' ', '... '), 'unchanged_prose')
  rejected(source, 'Folks, ' + source + ' Believe me!', 'source_wrapped')
  const scattered = source.split(' ').map((word, index) => word + (index % 3 === 0 ? ' tremendous' : '')).join(' ')
  assert.equal(rejected(source, scattered, 'excessive_copying').metrics.wordRetention, 1)
})

test('rejects all-prose dropping even when structure, facts or protected atoms remain', () => {
  rejected('The local collection opened in 1920 after extensive construction.', '1920', 'prose_dropped')
  rejected(`${keep(0, 'New York City')} welcomed its first visitors after lengthy restoration work.`, keep(0, 'New York City'), 'prose_dropped')
  rejected('An account of regional history is shown to every visitor.', '', 'prose_dropped')
})

test('whole keep atoms are immutable within structural zones, with ids excluded from scoring and numeric facts', () => {
  const a = keep(1920, 'Paris &amp; Lyon'); const b = keep(1991, 'New York City'); const open = keep(2, ''); const close = keep(3, '')
  const source = `${a} welcomed the delegates before ${open}${b} hosted a second gathering.${close}`
  const output = `${a} received those visitors; afterward ${open}a further meeting took place in ${b}.${close}`
  const good = accepted(source, output)
  assert.equal(good.metrics.sourceAtoms, 4); assert.equal(good.metrics.outputAtoms, 4)
  assert.deepEqual(good.metrics.sourceNumbers, [])
  assert.ok(good.metrics.sourceWords < 12, 'Protected multiword place names must not inflate the prose count')
  for (const bad of [output.replace(a, ''), output.replace(a, a + a), output.replace(a, '__SWAP__').replace(b, a).replace('__SWAP__', b), output.replace('Paris &amp; Lyon', 'Paris and Lyon'), output.replace('id="1920"', 'id="0"'), output.replace('<keep id="1920">', '<keep id="1920" title="changed">')]) rejected(source, bad, 'protected_atoms_changed')
})

test('proper-noun-heavy paragraphs pass when mutable prose is genuinely rebuilt', () => {
  const names = [keep(0, 'Alice Smith'), keep(1, 'Bob Jones'), keep(2, 'Carol Lee'), keep(3, 'Dan Patel'), keep(4, 'Eva van Dijk')].join(', ')
  const source = `The artists were ${names}, who participated in the exhibition.`
  const output = `Taking part in the exhibition: ${names}—that was the lineup of artists.`
  accepted(source, output)
  // A list consisting entirely of immutable labels has no mutable prose to rephrase.
  accepted(`${keep(0, 'New York City')}, ${keep(1, 'San Francisco')}.`, `${keep(0, 'New York City')}, ${keep(1, 'San Francisco')}.`)
})

test('empty wrapper atoms remain ordered while prose between them can be rephrased', () => {
  const open = keep(0, ''); const close = keep(1, '')
  accepted(`${open}The museum opened in 1920 after a long period of construction.${close}`, `${open}After lengthy building work, 1920 brought the opening of that museum.${close}`)
  rejected(`${open}A museum opened.${close}`, `${close}An institution welcomed visitors.${open}`, 'protected_atoms_changed')
})

test('legacy markers are stripped without swallowing their labels, and remain exactly ordered', () => {
  const source = 'The __TRUMPEDIA_0__museum__TRUMPEDIA_1__ opened in 1920 and displays regional history.'
  const output = 'In 1920, the __TRUMPEDIA_0__museum__TRUMPEDIA_1__ began welcoming visitors to explore the region’s past.'
  const result = accepted(source, output)
  assert.equal(result.metrics.sourceWords, 9)
  assert.deepEqual(result.metrics.sourceNumbers, ['1920'])
  rejected(source, output.replace('__TRUMPEDIA_1__', '__TRUMPEDIA_2__'), 'legacy_markers_changed')
  rejected(source, output + '__TRUMPEDIA_0__', 'legacy_markers_changed')
})

test('eight-to-eleven-word source insertions fail, but short genuine paraphrases pass', () => {
  const source = 'The museum welcomed visitors from nearby towns every Sunday.'
  rejected(source, 'The tremendous museum welcomed visitors from nearby towns every wonderful Sunday.', 'excessive_copying')
  accepted('The museum opened in 1920.', 'Its first visitors arrived in 1920.')
  rejected('The museum opened in 1920.', 'THE MUSEUM OPENED IN 1920!', 'unchanged_prose')
})

test('preserves literal dates/numbers, rejects omitted or invented numeric facts, and ignores keep ids', () => {
  const source = `The ${keep(0, 'museum')} opened in 1920, then expanded in 1991 after gaining 1,000 visitors.`
  const valid = `First came the 1920 opening of the ${keep(0, 'museum')}; an expansion followed in 1991, after 1000 people had visited.`
  accepted(source, valid)
  const changed = rejected(source, valid.replace('1991', '1992'), 'numeric_facts_changed')
  assert.deepEqual(changed.metrics.missingNumbers, ['1991']); assert.deepEqual(changed.metrics.addedNumbers, ['1992'])
  rejected(source, valid.replace(' in 1991', ''), 'numeric_facts_changed')
  rejected(source, valid + ' A further 50 rooms were planned.', 'numeric_facts_changed')
  const labelDate = keep(3000, 'The 1920 exhibition')
  const result = accepted(`${labelDate} welcomed visitors after substantial building work.`, `${labelDate} opened its doors once the construction had finished.`)
  assert.deepEqual(result.metrics.sourceNumbers, ['1920'])
})

test('normalizes common numeric presentation without turning this into a semantic fact-checker', () => {
  accepted('In 1991, the price was $2.50 for each of 1,000 people visiting the museum.', 'Each of the 1000 visitors paid $2.5 to enter that museum during 1991.')
  accepted('The institution reported growth of 10 percent during 1991 after opening to visitors.', 'During 1991, opening the doors was followed by reported growth of 10%.')
  const range = accepted('Records cover 1920-1991 and describe the institution’s expansion into new exhibition rooms.', 'Between 1920 and 1991, those documents trace how the institution added space for exhibitions.')
  assert.deepEqual(range.metrics.sourceNumbers, ['1920', '1991'])
})

test('natural negation paraphrases are accepted; lexical success alone never proves factual fidelity', () => {
  const source = `The ${keep(0, 'museum')} did not open to visitors in 1920 because construction was still unfinished.`
  const equivalent = `Visitors could not enter the ${keep(0, 'museum')} during 1920; work on the building had yet to finish.`
  accepted(source, equivalent)
  // A semantic verifier must catch this contradiction. The lexical/numeric guard deliberately makes no such claim.
  const contradictory = `Visitors enjoyed access to the ${keep(0, 'museum')} during 1920 following the completion of construction.`
  accepted(source, contradictory)
})

test('input/matrix caps fail closed without allocating an unbounded edit matrix', () => {
  rejected(null, 'Anything', 'invalid_text')
  rejected('', 'Anything', 'invalid_text')
  rejected('a'.repeat(REWRITE_QUALITY_LIMITS.characters + 1), 'Rewrite', 'analysis_limit')
  rejected('word '.repeat(REWRITE_QUALITY_LIMITS.words + 1), 'A rebuilt sentence.', 'analysis_limit')
  const bounded = assessRewrite('old '.repeat(1500), 'new '.repeat(1500))
  assert.equal(bounded.ok, true); assert.equal(bounded.metrics.wordRetention, 0); assert.equal(bounded.metrics.newWordFraction, 1)
})

test('captured definitional paraphrase is lexically eligible despite mandatory separate citation review', () => {
  const source = 'A <keep id="0">zarf</keep> (plural: zarfs, zarves; <keep id="1">Turkish</keep>: <keep id="2">zarflar</keep>; <keep id="3">Arabic</keep>: <keep id="4">zuruuf</keep>) is a <keep id="5">cup holder</keep>, usually of ornamented metal, for a coffee cup without a handle<keep id="6">[1]</keep> (<keep id="7">demitasse</keep> or <keep id="8">fincan</keep>).<keep id="9">[2]</keep>\n'
  const candidate = 'A <keep id="0">zarf</keep> — plural zarfs, zarves; <keep id="1">Turkish</keep> has <keep id="2">zarflar</keep>, and <keep id="3">Arabic</keep> has <keep id="4">zuruuf</keep> — is a <keep id="5">cup holder</keep>, usually of ornamented metal, and that metalwork is beautiful craftsmanship doing a practical job: it holds a coffee cup with no handle at all<keep id="6">[1]</keep> (a <keep id="7">demitasse</keep> or a <keep id="8">fincan</keep>). In my view, the protection is tremendous, but the elaborate fuss around such a tiny cup can get a little much.<keep id="9">[2]</keep>'
  const result = accepted(source, candidate)
  assert.equal(result.metrics.sourceWords, 18); assert.equal(result.metrics.orderedSourceWordsRetained, 15)
  assert.equal(result.metrics.wordRetention, 15 / 18); assert.equal(result.metrics.longestCopyRun, 4)
  assert.equal(result.metrics.outputWords, 57)
  // This lexical acceptance MUST NOT imply semantic/citation approval: [2] now follows an added opinion.
  assert.ok(candidate.indexOf('<keep id="9">[2]</keep>') > candidate.indexOf('In my view'))
  assert.ok(source.indexOf('<keep id="9">[2]</keep>') > source.indexOf('<keep id="8">fincan</keep>'))
})

test('exactly 0.9 retention remains eligible for semantic review; values above it are rejected', () => {
  const source = 'The museum welcomed visitors every Sunday and displayed paintings collected from several nearby towns during its annual summer cultural exhibition.'
  const boundary = 'The museum welcomed visitors—each Sunday was an opportunity—and displayed paintings collected from several nearby communities during its annual summer cultural exhibition.'
  const result = accepted(source, boundary)
  assert.equal(result.metrics.sourceWords, 20); assert.equal(result.metrics.orderedSourceWordsRetained, 18)
  assert.equal(result.metrics.wordRetention, 0.9); assert.ok(result.metrics.longestCopyRun < 12)
  const above = rejected(source, source.replace('from several', 'across several'), 'excessive_copying')
  assert.equal(above.metrics.wordRetention, 0.95); assert.ok(above.metrics.longestCopyRun < 12)
})

test('a long contiguous copy is rejected even when overall ordered retention is below 0.9', () => {
  const tokens = 'amber birch cedar dogwood elm fir ginkgo hazel iris jasmine kelp larch maple nettle olive pine quince rose sage thyme umber violet willow xenia yarrow zinnia alder beech cypress dahlia'.split(' ')
  const source = tokens.join(' ')
  const candidate = tokens.slice(0, 15).join(' ') + ' completely fresh descriptive language follows with different words about an unrelated collection and its surroundings'
  const result = rejected(source, candidate, 'excessive_copying')
  assert.equal(result.metrics.sourceWords, 30); assert.equal(result.metrics.longestCopyRun, 15)
  assert.equal(result.metrics.longestCopyFraction, 0.5); assert.equal(result.metrics.wordRetention, 0.5)
})


test('exposes the actual longest normalized copied passage with a strict 180-character bound', () => {
  const source = 'The vessel is usually of ornamented metal for a coffee cup without a handle and has a long history.'
  const output = 'In my view, it is usually of ornamented metal for a coffee cup without a handle, with other details presented differently.'
  const result = assessRewrite(source, output)
  assert.equal(result.metrics.longestCopyRun, 12)
  assert.equal(result.metrics.longestCopiedPhrase, 'is usually of ornamented metal for a coffee cup without a handle')
  const longSource = Array.from({length:14},(_,i)=>String.fromCharCode(97+i).repeat(30)).join(' ')
  const longOutput = longSource.split(' ').slice(0,12).join(' ') + ' rebuilt prose'
  const bounded = assessRewrite(longSource,longOutput)
  assert.equal(bounded.metrics.longestCopyRun,12);assert.equal(bounded.metrics.longestCopiedPhrase.length,180)
  assert.equal(bounded.metrics.longestCopiedPhrase,longSource.slice(0,180))
  assert.equal(assessRewrite('old vocabulary here','entirely fresh wording').metrics.longestCopiedPhrase,'')
})


test('closed atom reorder within one zone allows restructured facts without certifying their relationships', () => {
  const a=keep(0,'New York City');const b=keep(1,'Paris')
  const source=`${a} and ${b} hosted exhibitions in 1920 after extensive planning.`
  const rewritten=`Following lengthy preparations, 1920 brought exhibitions to ${b} as well as ${a}.`
  accepted(source,rewritten)
  // The shared structure guard permits closed-token movement; semantic relationships still require review.
  const open=keep(2,'');const close=keep(3,'')
  const zonedSource=`${a} and ${open}${b} hosted exhibitions${close} in 1920 after extensive planning.`
  const crossed=`Following lengthy preparations, 1920 brought exhibitions to ${b} as well as ${open}${a}${close}.`
  rejected(zonedSource,crossed,'protected_atoms_changed')
})


test('contiguous copied runs stop at atomic gaps in either source or output while LCS stays flattened', () => {
  const first='amber birch cedar dogwood elm fir';const second='ginkgo hazel iris jasmine kelp larch';const atom=keep(0,'Entity')
  const split=`${first} ${atom} ${second}`;const joined=`${first} ${second} ${atom}`
  for(const [source,output] of [[split,split],[split,joined],[joined,split]]) {
    const result=rejected(source,output,'unchanged_prose')
    assert.equal(result.metrics.sourceWords,12);assert.equal(result.metrics.orderedSourceWordsRetained,12);assert.equal(result.metrics.wordRetention,1)
    assert.equal(result.metrics.longestCopyRun,6);assert.equal(result.metrics.longestCopiedPhrase,first)
  }
  // Legacy marker handling intentionally remains unchanged, including its prior flattened run behavior.
  const legacy=`${first} __TRUMPEDIA_0__ ${second}`
  assert.equal(assessRewrite(legacy,legacy).metrics.longestCopyRun,12)
})

test('one genuinely contiguous plain chunk still triggers the twelve-word half-source guard beside atoms', () => {
  const run='amber birch cedar dogwood elm fir ginkgo hazel iris jasmine kelp larch'
  const rest='maple nettle olive pine quince rose sage thyme umber violet willow xenia'
  const a=keep(0,'Entity');const b=keep(1,'Other entity')
  const source=`${a} ${run} ${b} ${rest}`
  const output=`${a} ${run} ${b} completely fresh descriptions explain different features of a separate collection and location`
  const result=rejected(source,output,'excessive_copying')
  assert.equal(result.metrics.sourceWords,24);assert.equal(result.metrics.longestCopyRun,12);assert.equal(result.metrics.longestCopyFraction,0.5)
  assert.equal(result.metrics.longestCopiedPhrase,run);assert.equal(result.metrics.wordRetention,0.5)
})
