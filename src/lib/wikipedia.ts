export type ParsedWikipediaUrl = {
  lang: string
  title: string
  canonicalUrl: string
}

export type WikipediaArticle = {
  title: string
  html: string
  canonicalUrl: string
  sourceApiUrl: string
  rewriteMode: 'llm' | 'llm-partial' | 'heuristic'
}

type ParseApiResponse = {
  parse?: {
    title: string
    displaytitle: string
    text: {
      '*': string
    }
  }
  error?: {
    code: string
    info: string
  }
}

type RewriteApiResponse = {
  segments?: string[]
}

type RewriteTarget = {
  node: Text
  text: string
}

const SKIP_TEXT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'MATH',
  'KBD',
  'SAMP',
  'SVG',
])

const SKIP_CLASS_HINTS = [
  'reference',
  'reflist',
  'mw-editsection',
  'navbox',
  'toc',
  'metadata',
  'infobox-above',
]

const REWRITE_BATCH_SIZE = 15
const MAX_CONCURRENT_REQUESTS = 20
const REWRITE_API_URL = import.meta.env.VITE_REWRITE_API_URL || 'http://127.0.0.1:8787/api/rewrite'

export function parseWikipediaUrl(input: string): ParsedWikipediaUrl {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Paste a Wikipedia article URL.')
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Enter a valid URL.')
  }

  const hostParts = url.hostname.toLowerCase().split('.')
  if (hostParts.length < 3 || hostParts[hostParts.length - 2] !== 'wikipedia' || hostParts[hostParts.length - 1] !== 'org') {
    throw new Error('URL must be from wikipedia.org.')
  }

  const lang = hostParts[0]
  if (!lang || lang === 'www') {
    throw new Error('Use a language Wikipedia URL (example: en.wikipedia.org).')
  }

  const pathname = decodeURIComponent(url.pathname)
  const wikiPrefix = '/wiki/'
  if (!pathname.startsWith(wikiPrefix) || pathname.length <= wikiPrefix.length) {
    throw new Error('Paste a direct article URL like https://en.wikipedia.org/wiki/Article_Title.')
  }

  const title = pathname.slice(wikiPrefix.length)
  if (!title || title.includes(':')) {
    throw new Error('Only standard article pages are supported in this MVP.')
  }

  return {
    lang,
    title,
    canonicalUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%2F/g, '/')}`,
  }
}

export async function fetchAndRewriteArticle(
  inputUrl: string,
  onProgress?: (percent: number) => void,
): Promise<WikipediaArticle> {
  const parsed = parseWikipediaUrl(inputUrl)
  const apiUrl = new URL(`https://${parsed.lang}.wikipedia.org/w/api.php`)
  apiUrl.searchParams.set('action', 'parse')
  apiUrl.searchParams.set('format', 'json')
  apiUrl.searchParams.set('origin', '*')
  apiUrl.searchParams.set('prop', 'text|displaytitle')
  apiUrl.searchParams.set('page', parsed.title)

  const response = await fetch(apiUrl.toString())
  if (!response.ok) {
    throw new Error(`Wikipedia request failed (${response.status}).`)
  }

  const payload = (await response.json()) as ParseApiResponse
  if (payload.error) {
    throw new Error(payload.error.info || 'Wikipedia returned an error.')
  }

  const parse = payload.parse
  if (!parse?.text?.['*']) {
    throw new Error('No article content found for this URL.')
  }

  const normalizedHtml = normalizeWikipediaHtml(parse.text['*'], parsed.lang)
  const rewritten = await rewriteArticleHtml(normalizedHtml, onProgress)

  return {
    title: stripHtml(parse.displaytitle || parse.title),
    html: rewritten.html,
    canonicalUrl: parsed.canonicalUrl,
    sourceApiUrl: apiUrl.toString(),
    rewriteMode: rewritten.rewriteMode,
  }
}

function normalizeWikipediaHtml(rawHtml: string, lang: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div id="mw-content-text">${rawHtml}</div>`, 'text/html')

  const allElements = Array.from(doc.querySelectorAll<HTMLElement>('*'))
  for (const el of allElements) {
    const href = el.getAttribute('href')
    if (href) {
      if (href.startsWith('//')) {
        el.setAttribute('href', `https:${href}`)
      } else if (href.startsWith('/')) {
        el.setAttribute('href', `https://${lang}.wikipedia.org${href}`)
      }
    }

    const src = el.getAttribute('src')
    if (src) {
      if (src.startsWith('//')) {
        el.setAttribute('src', `https:${src}`)
      } else if (src.startsWith('/')) {
        el.setAttribute('src', `https://${lang}.wikipedia.org${src}`)
      }
    }
  }

  doc.querySelectorAll('.mw-editsection').forEach((node) => node.remove())

  const root = doc.querySelector('#mw-content-text')
  return root?.innerHTML || rawHtml
}

async function rewriteArticleHtml(
  html: string,
  onProgress?: (percent: number) => void,
): Promise<{ html: string; rewriteMode: 'llm' | 'llm-partial' | 'heuristic' }> {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<article id="content">${html}</article>`, 'text/html')
  const root = doc.querySelector('#content')
  if (!root) {
    return {
      html,
      rewriteMode: 'heuristic',
    }
  }

  const targets = collectRewriteTargets(root)
  if (targets.length === 0) {
    return {
      html: root.innerHTML,
      rewriteMode: 'heuristic',
    }
  }

  const rewriteMode = await applyLlmRewrite(targets, onProgress)
  return {
    html: root.innerHTML,
    rewriteMode,
  }
}

export function collectRewriteTargets(root: Element): RewriteTarget[] {
  const targets: RewriteTarget[] = []
  const doc = root.ownerDocument || document
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null = walker.nextNode()

  while (node) {
    const textNode = node as Text
    const parent = textNode.parentElement
    const value = textNode.nodeValue || ''

    if (parent && shouldRewriteNode(parent, value)) {
      targets.push({
        node: textNode,
        text: value,
      })
    }

    node = walker.nextNode()
  }

  return targets
}

async function applyLlmRewrite(
  targets: RewriteTarget[],
  onProgress?: (percent: number) => void,
): Promise<'llm' | 'llm-partial' | 'heuristic'> {
  let successCount = 0
  let failureCount = 0
  let completedBatches = 0

  const batches: RewriteTarget[][] = []
  for (let i = 0; i < targets.length; i += REWRITE_BATCH_SIZE) {
    batches.push(targets.slice(i, i + REWRITE_BATCH_SIZE))
  }

  const queue = [...batches]
  const totalBatches = batches.length

  const processNext = async (): Promise<void> => {
    if (queue.length === 0) return
    const batch = queue.shift()!
    try {
      const rewrittenBatch = await rewriteSegmentsWithApi(batch.map((target) => target.text))
      if (!rewrittenBatch || rewrittenBatch.length !== batch.length) {
        throw new Error('invalid rewrite batch')
      }

      for (let j = 0; j < batch.length; j += 1) {
        batch[j].node.nodeValue = rewrittenBatch[j]
      }
      successCount += 1
    } catch {
      for (const target of batch) {
        target.node.nodeValue = heuristicRewrite(target.text)
      }
      failureCount += 1
    } finally {
      completedBatches += 1
      if (onProgress) {
        onProgress(Math.floor((completedBatches / totalBatches) * 100))
      }
    }
    return processNext()
  }

  const workers = Array(Math.min(MAX_CONCURRENT_REQUESTS, batches.length))
    .fill(null)
    .map(() => processNext())

  await Promise.all(workers)

  if (successCount > 0 && failureCount === 0) {
    return 'llm'
  }
  if (successCount > 0) {
    return 'llm-partial'
  }
  return 'heuristic'
}

async function rewriteSegmentsWithApi(segments: string[]): Promise<string[] | null> {
  const rewritten = await rewriteSegmentsWithApiInternal(segments)
  return rewritten
}

async function rewriteSegmentsWithApiInternal(segments: string[]): Promise<string[] | null> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 60000)
  const startTime = Date.now()

  try {
    const response = await fetch(REWRITE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ segments }),
      signal: controller.signal,
    })

    const rawBody = await response.text()
    const duration = Date.now() - startTime
    
    if (!response.ok) {
      console.warn(`Rewrite API request failed (${duration}ms)`, {
        status: response.status,
        body: rawBody.slice(0, 300),
      })
      return null
    }

    console.log(`Rewrite API batch of ${segments.length} finished in ${duration}ms`)

    let payload: RewriteApiResponse
    try {
      payload = JSON.parse(rawBody) as RewriteApiResponse
    } catch {
      console.warn('Rewrite API returned non-JSON body', rawBody.slice(0, 300))
      return null
    }

    if (!Array.isArray(payload.segments)) {
      console.warn('Rewrite API missing segments array', rawBody.slice(0, 300))
      return null
    }

    return payload.segments.map((value) => String(value))
  } catch (error) {
    // If a batch fails, recursively split it to recover partial LLM rewrites.
    if (segments.length > 1) {
      const mid = Math.floor(segments.length / 2)
      const left = await rewriteSegmentsWithApiInternal(segments.slice(0, mid))
      const right = await rewriteSegmentsWithApiInternal(segments.slice(mid))
      if (left && right) {
        return [...left, ...right]
      }
    }
    console.warn('Rewrite API exception', error)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function shouldRewriteNode(parent: Element, text: string): boolean {
  if (!text.trim()) {
    return false
  }

  if (!/[A-Za-z]{3,}/.test(text)) {
    return false
  }

  if (SKIP_TEXT_TAGS.has(parent.tagName)) {
    return false
  }

  const className = parent.className || ''
  if (typeof className === 'string' && SKIP_CLASS_HINTS.some((hint) => className.includes(hint))) {
    return false
  }

  return true
}

function heuristicRewrite(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return input
  }

  let output = input

  const replacements: Array<[RegExp, string]> = [
    [/\bvery\b/gi, 'tremendous'],
    [/\bimportant\b/gi, 'very important, believe me'],
    [/\bsuccessful\b/gi, 'incredibly successful'],
    [/\bmany\b/gi, 'so many'],
    [/\bwidely\b/gi, 'very widely'],
    [/\baccording to\b/gi, 'according to many people'],
    [/\bnotable\b/gi, 'highly notable'],
    [/\bstrong\b/gi, 'strong, really strong'],
  ]

  for (const [pattern, replacement] of replacements) {
    output = output.replace(pattern, replacement)
  }

  if (trimmed.length > 90 && /^[A-Z]/.test(trimmed) && !trimmed.startsWith('Folks,')) {
    output = output.replace(trimmed, `Folks, ${trimmed}`)
  }

  return output
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '').trim()
}
