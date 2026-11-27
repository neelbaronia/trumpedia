// @ts-self-types="./rewrite-quality.d.mts"
import { validateMarkers } from './article-plan.mjs'
// Conservative lexical checks, not a semantic fact-checker or a POV judge.
// Keep atoms are immutable structure; their labels are excluded from novelty scoring,
// but included in literal-number checks. Facts/negation/causation still need verification.
export const REWRITE_QUALITY_LIMITS = Object.freeze({ characters: 12000, words: 2000, longWords: 12, shortWords: 8, maxLongRetention: 0.9, minLongCopyRun: 12, maxLongCopyFraction: 0.5 })
const ATOM = /<keep id="([0-9]+)">([^<]*)<\/keep>/g
const LEGACY = /__TRUMPEDIA_\d+__/g
const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })
const NUMBER = /(?<![\p{L}\p{N}_])[+\-−]?(?:\d{1,3}(?:[, \u00a0\u202f]\d{3})+|\d+)(?:\.\d+)?(?:st|nd|rd|th|s)?(?:\s*(?:percentage\s+points|per\s+cent|percent|[%‰]))?(?![\p{L}\p{N}_])/giu

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? whole
    const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
  })
}
function atoms(text) { return Array.from(text.matchAll(ATOM), match => ({ raw: match[0], id: match[1], label: match[2] })) }
function sameSequence(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]) }
function novelAnalysis(text) {
  const chunks = []; let end = 0
  for (const atom of text.matchAll(ATOM)) { chunks.push(text.slice(end, atom.index)); end = atom.index + atom[0].length }
  chunks.push(text.slice(end))
  const words = []; const breakBefore = []
  const normalized = chunks.map(chunk => decodeEntities(chunk.replace(LEGACY, ' ')).normalize('NFC').replace(/\s+/g, ' ').trim())
  for (const chunk of normalized) {
    const part = tokenize(chunk)
    for (let i = 0; i < part.length; i++) { words.push(part[i]); breakBefore.push(i === 0) }
  }
  // Flattening preserves the LCS metric. Run boundaries retain where whole atoms were removed.
  return { text: normalized.join(' ').replace(/\s+/g, ' ').trim(), words, breakBefore }
}
function factualText(text) { return decodeEntities(text.replace(ATOM, (_whole, _id, label) => label).replace(LEGACY, ' ')).normalize('NFC') }
function tokenize(text) { return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [] }
function canonicalNumber(raw) {
  let unit = ''
  if (/percentage\s+points$/i.test(raw)) { unit = 'pp'; raw = raw.replace(/percentage\s+points$/i, '') }
  else if (/(?:percent|per\s+cent|%)$/i.test(raw)) { unit = '%'; raw = raw.replace(/(?:percent|per\s+cent|%)$/i, '') }
  else if (/‰$/.test(raw)) { unit = '‰'; raw = raw.slice(0, -1) }
  raw = raw.trim().replace(/(?:st|nd|rd|th|s)$/i, '').replace(/[,\s\u00a0\u202f]/g, '').replace('−', '-')
  const negative = raw[0] === '-'; raw = raw.replace(/^[+-]/, '')
  const [integer, fractional = ''] = raw.split('.')
  const whole = integer.replace(/^0+(?=\d)/, '')
  const fraction = fractional.replace(/0+$/, '')
  const value = whole + (fraction ? '.' + fraction : '')
  return (negative && /[1-9]/.test(value) ? '-' : '') + value + unit
}
function numbers(text) { return [...new Set(Array.from(factualText(text).matchAll(NUMBER), match => canonicalNumber(match[0])))].sort() }

// Two rows keep memory linear. An explicit word cap bounds the matrix to four million cells.
function wordComparison(source, output, sourceBreaks, outputBreaks) {
  let previousLcs = new Uint16Array(output.length + 1)
  let previousRun = new Uint16Array(output.length + 1)
  let longestCopyRun = 0; let bestSourceEnd = 0
  for (let i = 0; i < source.length; i++) {
    const currentLcs = new Uint16Array(output.length + 1)
    const currentRun = new Uint16Array(output.length + 1)
    for (let j = 1; j <= output.length; j++) {
      if (source[i] === output[j - 1]) {
        currentLcs[j] = previousLcs[j - 1] + 1
        const contiguous = i > 0 && j > 1 && !sourceBreaks[i] && !outputBreaks[j - 1]
        currentRun[j] = (contiguous ? previousRun[j - 1] : 0) + 1
        if (currentRun[j] > longestCopyRun) { longestCopyRun = currentRun[j]; bestSourceEnd = i + 1 }
      } else currentLcs[j] = Math.max(previousLcs[j], currentLcs[j - 1])
    }
    previousLcs = currentLcs; previousRun = currentRun
  }
  let longestCopiedPhrase = source.slice(bestSourceEnd - longestCopyRun, bestSourceEnd).join(' ').slice(0, 180)
  if (/[\uD800-\uDBFF]$/.test(longestCopiedPhrase)) longestCopiedPhrase = longestCopiedPhrase.slice(0, -1)
  return { orderedSourceWordsRetained: previousLcs[output.length], longestCopyRun, longestCopiedPhrase }
}

export function assessRewrite(source, output) {
  const metrics = { sourceWords: 0, outputWords: 0, orderedSourceWordsRetained: 0, wordRetention: 0, newWordFraction: 0, longestCopyRun: 0, longestCopiedPhrase: '', longestCopyFraction: 0, sourceAtoms: 0, outputAtoms: 0, sourceNumbers: [], outputNumbers: [], missingNumbers: [], addedNumbers: [] }
  const result = reason => ({ ok: reason === null, reason, metrics })
  if (typeof source !== 'string' || typeof output !== 'string' || !source.trim()) return result('invalid_text')
  if (source.length > REWRITE_QUALITY_LIMITS.characters || output.length > REWRITE_QUALITY_LIMITS.characters) return result('analysis_limit')
  const before = atoms(source); const after = atoms(output)
  metrics.sourceAtoms = before.length; metrics.outputAtoms = after.length
  if (!validateMarkers(source, output)) return result(before.length || after.length || /<\/?keep\b/i.test(source + output) ? 'protected_atoms_changed' : 'legacy_markers_changed')
  const sourceNovel = novelAnalysis(source); const outputNovel = novelAnalysis(output)
  const sourceText = sourceNovel.text; const outputText = outputNovel.text
  const sourceWords = sourceNovel.words; const outputWords = outputNovel.words
  metrics.sourceWords = sourceWords.length; metrics.outputWords = outputWords.length
  metrics.sourceNumbers = numbers(source); metrics.outputNumbers = numbers(output)
  metrics.missingNumbers = metrics.sourceNumbers.filter(value => !metrics.outputNumbers.includes(value))
  metrics.addedNumbers = metrics.outputNumbers.filter(value => !metrics.sourceNumbers.includes(value))
  if (sourceWords.length > REWRITE_QUALITY_LIMITS.words || outputWords.length > REWRITE_QUALITY_LIMITS.words) return result('analysis_limit')
  const comparison = wordComparison(sourceWords, outputWords, sourceNovel.breakBefore, outputNovel.breakBefore)
  Object.assign(metrics, comparison)
  metrics.wordRetention = sourceWords.length ? comparison.orderedSourceWordsRetained / sourceWords.length : 0
  metrics.longestCopyFraction = sourceWords.length ? comparison.longestCopyRun / sourceWords.length : 0
  metrics.newWordFraction = outputWords.length ? (outputWords.length - comparison.orderedSourceWordsRetained) / outputWords.length : 0
  if (/\p{L}/u.test(sourceText) && !/\p{L}/u.test(outputText)) return result('prose_dropped')
  if (metrics.missingNumbers.length || metrics.addedNumbers.length) return result('numeric_facts_changed')
  // Labels/numbers-only material can legitimately have no prose available to rephrase.
  if (!/\p{L}/u.test(sourceText)) return result(null)
  if (sameSequence(sourceWords, outputWords)) return result('unchanged_prose')
  const sourceSequence = sourceWords.join(' ')
  const outputSequence = outputWords.join(' ')
  if (sourceWords.length >= REWRITE_QUALITY_LIMITS.shortWords && (` ${outputSequence} `).includes(` ${sourceSequence} `)) return result('source_wrapped')
  if (comparison.longestCopyRun >= REWRITE_QUALITY_LIMITS.minLongCopyRun && metrics.longestCopyFraction >= REWRITE_QUALITY_LIMITS.maxLongCopyFraction) return result('excessive_copying')
  if (sourceWords.length >= REWRITE_QUALITY_LIMITS.longWords && metrics.wordRetention > REWRITE_QUALITY_LIMITS.maxLongRetention) return result('excessive_copying')
  if (sourceWords.length >= REWRITE_QUALITY_LIMITS.shortWords && sourceWords.length < REWRITE_QUALITY_LIMITS.longWords && metrics.wordRetention === 1) return result('excessive_copying')
  return result(null)
}
