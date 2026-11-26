export const PIPELINE_VERSION = 'paragraphs-v3'
export const MAX_BLOCK_CHARS = 5000
export const MARKER_PATTERN = /__TRUMPEDIA_\d+__/g

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'MATH', 'KBD', 'SAMP', 'SVG', 'TABLE', 'FIGURE', 'BLOCKQUOTE'])
const SKIP_CLASSES = ['reference', 'reflist', 'mw-editsection', 'navbox', 'toc', 'metadata', 'infobox', 'sidebar', 'hatnote', 'shortdescription', 'ambox', 'sistersitebox']
const SKIP_SECTIONS = /^(references|notes|citations|bibliography|further reading|external links|see also|sources|footnotes)$/i
const REMOVE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'LINK', 'META', 'BASE', 'TEMPLATE', 'SVG', 'FOREIGNOBJECT', 'USE', 'ANIMATE', 'SET'])
const ALLOWED_ATTRIBUTES = new Set(['id', 'class', 'title', 'lang', 'dir', 'href', 'src', 'alt', 'width', 'height', 'colspan', 'rowspan', 'scope', 'role', 'aria-label', 'aria-hidden', 'name', 'start', 'value', 'type', 'datetime', 'loading', 'decoding'])
const VOID_TAGS = new Set(['BR', 'HR', 'IMG', 'WBR', 'SOURCE'])

export function parseWikipediaUrl(input) {
  let url
  try { url = new URL(String(input).trim()) } catch { throw new Error('Enter a valid Wikipedia article URL.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTPS Wikipedia article URL.')
  const match = url.hostname.toLowerCase().match(/^([a-z][a-z0-9-]{0,19})(?:\.m)?\.wikipedia\.org$/)
  if (!match || match[1] === 'www') throw new Error('Use a language Wikipedia URL, such as en.wikipedia.org.')
  let title
  try {
    title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/_/g, ' ').normalize('NFC').trim()
  } catch { throw new Error('This article URL contains invalid encoding.') }
  if (!url.pathname.startsWith('/wiki/') || !title || title.length > 255 || /[\u0000-\u001f#?|]/.test(title)) throw new Error('Paste a direct Wikipedia article URL.')
  if (/^(special|file|image|category|talk|template|user|wikipedia|help|portal|mediawiki|draft|module|book)(?: talk)?:/i.test(title)) throw new Error('Choose an encyclopedia article rather than a Wikipedia administration page.')
  const lang = match[1]
  const path = encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/gi, '/')
  return { lang, title, canonicalUrl: 'https://' + lang + '.wikipedia.org/wiki/' + path }
}

function safeUrl(value, lang, image = false) {
  if (!value) return null
  const text = value.trim()
  if (text.startsWith('#') && !image) return text
  try {
    const url = new URL(text, 'https://' + lang + '.wikipedia.org')
    if (url.username || url.password) return null
    if (!['https:', 'http:'].includes(url.protocol)) return null
    return url.href
  } catch { return null }
}

export function sanitizeHtml(html, lang, parseDocument) {
  const doc = parseDocument('<div id="trumpedia-source-root">' + html + '</div>')
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    if (REMOVE_TAGS.has(element.tagName.toUpperCase())) {
      element.remove()
      continue
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      if (!ALLOWED_ATTRIBUTES.has(name) || name.startsWith('on')) element.removeAttribute(attr.name)
    }
    for (const attr of ['href', 'src']) {
      if (!element.hasAttribute(attr)) continue
      const value = safeUrl(element.getAttribute(attr), lang, attr === 'src')
      if (value) element.setAttribute(attr, value)
      else element.removeAttribute(attr)
    }
    if (element.tagName.toUpperCase() === 'IMG') {
      element.setAttribute('loading', 'lazy')
      element.setAttribute('decoding', 'async')
    }
    if (element.tagName.toUpperCase() === 'A') element.setAttribute('rel', 'noopener noreferrer')
  }
  doc.querySelectorAll('.mw-editsection, .toc, .mw-toc').forEach(node => node.remove())
  return doc.querySelector('#trumpedia-source-root')?.innerHTML || ''
}

function isExcluded(element) {
  for (let parent = element; parent; parent = parent.parentElement) {
    if (SKIP_TAGS.has(parent.tagName.toUpperCase())) return true
    const classes = parent.getAttribute('class') || ''
    if (SKIP_CLASSES.some(hint => classes.includes(hint))) return true
    if (parent.hasAttribute('data-mw-trumpedia-skip')) return true
  }
  return false
}

function elementEnvelope(element) {
  const copy = element.cloneNode(false)
  const serialized = copy.outerHTML
  return { openHtml: serialized.slice(0, serialized.indexOf('>') + 1), closeHtml: '</' + element.tagName.toLowerCase() + '>' }
}

function tokenizeInline(element) {
  const slots = []
  const marker = html => {
    const value = '__TRUMPEDIA_' + slots.length + '__'
    slots.push({ marker: value, html })
    return value
  }
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue || ''
    if (node.nodeType !== 1) return ''
    const tag = node.tagName.toUpperCase()
    if (isExcluded(node) || VOID_TAGS.has(tag)) return marker(node.outerHTML)
    const envelope = elementEnvelope(node)
    return marker(envelope.openHtml) + Array.from(node.childNodes).map(walk).join('') + marker(envelope.closeHtml)
  }
  return { text: Array.from(element.childNodes).map(walk).join(''), slots }
}

function splitText(text) {
  const pieces = []
  let rest = text
  while (rest.length > MAX_BLOCK_CHARS) {
    let end = rest.lastIndexOf(' ', MAX_BLOCK_CHARS)
    if (end < MAX_BLOCK_CHARS / 2) end = MAX_BLOCK_CHARS
    if (/^[\uDC00-\uDFFF]$/.test(rest[end] || '')) end -= 1
    const startMarker = rest.lastIndexOf('__TRUMPEDIA_', end)
    if (startMarker >= 0) {
      const markerEnd = rest.indexOf('__', startMarker + 12) + 2
      if (markerEnd > end) end = startMarker || markerEnd
    }
    pieces.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) pieces.push(rest)
  return pieces
}

export function prepareArticle(rawHtml, lang, parseDocument) {
  const sanitized = sanitizeHtml(rawHtml, lang, parseDocument)
  const doc = parseDocument('<article id="trumpedia-plan-root">' + sanitized + '</article>')
  const outer = doc.querySelector('#trumpedia-plan-root')
  const content = outer.querySelector('.mw-parser-output') || outer
  const sectionNodes = []
  let section = { id: 'lead', title: 'Introduction', nodes: [] }
  sectionNodes.push(section)
  for (const node of Array.from(content.childNodes)) {
    const heading = node.nodeType === 1 && (node.tagName.toUpperCase() === 'H2' ? node : node.querySelector(':scope > h2'))
    if (heading) {
      const title = (heading.textContent || '').replace(/\[edit\]/g, '').trim()
      section = { id: 'section-' + sectionNodes.length, title, nodes: [] }
      sectionNodes.push(section)
    }
    section.nodes.push(node)
  }
  const units = []
  const blocks = []
  const sections = []
  let sourceTextChars = 0
  let summary = ''
  for (const item of sectionNodes) {
    const wrapper = doc.createElement('div')
    for (const node of item.nodes) wrapper.appendChild(node.cloneNode(true))
    const blockIds = []
    if (!SKIP_SECTIONS.test(item.title)) {
      const candidates = Array.from(wrapper.querySelectorAll('p, li, dd, dt'))
      for (const element of candidates) {
        if (isExcluded(element) || element.querySelector('p, li, dd, dt')) continue
        const plain = element.textContent || ''
        if (plain.trim().length < 40 || !/\p{L}{3}/u.test(plain)) continue
        const tokens = tokenizeInline(element)
        // Prevent source text from masquerading as our protected HTML markers.
        if ((tokens.text.match(MARKER_PATTERN)?.length || 0) !== tokens.slots.length) continue
        const id = 'u' + String(units.length).padStart(5, '0')
        const unitBlocks = splitText(tokens.text).map((text, index) => {
          const block = { id: id + '-' + index, text, sectionId: item.id }
          blocks.push(block)
          blockIds.push(block.id)
          return block.id
        })
        units.push({ id, ...elementEnvelope(element), blockIds: unitBlocks, slots: tokens.slots })
        sourceTextChars += plain.length
        if (summary.length < 2000) summary += plain.trim() + '\n'
        element.replaceWith(doc.createComment('TRUMPEDIA_UNIT_' + id))
      }
    }
    sections.push({ id: item.id, title: item.title, template: wrapper.innerHTML, blockIds })
  }
  return { version: PIPELINE_VERSION, sections, units, blocks, sourceTextChars, summary: summary.slice(0, 2000) }
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function validateMarkers(source, output) {
  if (typeof output !== 'string') return false
  const expected = source.match(MARKER_PATTERN) || []
  const actual = output.match(MARKER_PATTERN) || []
  return expected.length === actual.length && expected.every((marker, index) => marker === actual[index])
}

export function makeBatches(blocks, maxChars = 6000, maxBlocks = 12) {
  const batches = []
  let batch = []
  let size = 0
  for (const block of blocks) {
    if (batch.length && (size + block.text.length > maxChars || batch.length >= maxBlocks)) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(block)
    size += block.text.length
  }
  if (batch.length) batches.push(batch)
  return batches
}

export function renderArticle(plan, outputs = {}, options = {}) {
  const failed = new Set(options.failedIds || [])
  const originals = new Map(plan.blocks.map(block => [block.id, block.text]))
  const valid = new Set(plan.blocks.filter(block => validateMarkers(block.text, outputs[block.id])).map(block => block.id))
  const renderedUnits = new Map()
  for (const unit of plan.units) {
    let text = unit.blockIds.map(id => valid.has(id) ? outputs[id] : originals.get(id) || '').join('')
    text = escapeHtml(text)
    for (const slot of unit.slots) text = text.replace(slot.marker, () => slot.html)
    renderedUnits.set(unit.id, unit.openHtml + text + unit.closeHtml)
  }
  const sections = plan.sections.map(section => {
    const ready = section.blockIds.every(id => valid.has(id))
    const visible = ready || Boolean(options.finished)
    let html = visible ? section.template : ''
    if (visible) html = html.replace(/<!--TRUMPEDIA_UNIT_(u\d+)-->/g, (_whole, id) => renderedUnits.get(id) || '')
    return { id: section.id, title: section.title, html, complete: ready }
  })
  const total = plan.blocks.length
  const completed = valid.size
  return {
    html: sections.map(section => section.html).join(''),
    sections,
    rewriteMode: total > 0 && completed === total ? 'llm' : completed ? 'llm-partial' : 'heuristic',
    completed,
    total,
    failedCount: plan.blocks.filter(block => failed.has(block.id) && !valid.has(block.id)).length,
  }
}
