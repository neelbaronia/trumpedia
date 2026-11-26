import { parseWikipediaUrl } from '../lib/wikipedia'

export type ArticleDestination = { canonicalUrl: string; hash: string }
export type ContentHeading = { id: string; text: string; level: number }

export function articleHref(canonicalUrl: string, pathname = '/', hash = ''): string {
  const query = new URLSearchParams({ url: canonicalUrl })
  return `${pathname}?${query.toString()}${hash}`
}

export function articleDestination(href: string, origin: string, pathname: string): ArticleDestination | null {
  try {
    const url = new URL(href, `${origin}${pathname}`)
    const input = url.origin === origin && url.pathname === pathname
      ? url.searchParams.get('url')
      : url.href
    if (!input) return null
    const parsed = parseWikipediaUrl(input)
    return { canonicalUrl: parsed.canonicalUrl, hash: url.hash || new URL(input).hash }
  } catch {
    return null
  }
}

export function sectionAnchor(id: string): string {
  return `trumpedia-section-${id}`
}

function headingId(heading: Element, index: number, scope: string): string {
  return heading.id || heading.querySelector('.mw-headline')?.id || `trumpedia-${scope}-heading-${index}`
}

export function contentsFromHtml(html: string, scope = 'article'): ContentHeading[] {
  if (!html || typeof DOMParser === 'undefined') return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll('h2, h3, h4')).map((heading, index) => ({
    id: headingId(heading, index, scope),
    text: heading.textContent?.replace('[edit]', '').trim() || '',
    level: Number(heading.tagName.slice(1)),
  })).filter(heading => heading.text)
}

// Run after HTML sanitization. This presentation pass assigns stable heading
// anchors and makes article links work with native new-tab/copy-link behavior.
export function prepareArticleHtml(html: string, canonicalUrl: string, pathname: string, scope: string): string {
  if (!html || typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('h2, h3, h4').forEach((heading, index) => {
    if (!heading.id && !heading.querySelector('.mw-headline')?.id) heading.id = headingId(heading, index, scope)
  })
  doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
    const href = anchor.getAttribute('href') || ''
    if (!href || href.startsWith('#') || anchor.hasAttribute('download')) return
    try {
      const source = new URL(href, canonicalUrl)
      const parsed = parseWikipediaUrl(source.href)
      anchor.setAttribute('href', articleHref(parsed.canonicalUrl, pathname, source.hash))
      anchor.removeAttribute('target')
    } catch {
      // References, file pages, and external links retain the API's safe URL.
    }
  })
  return doc.body.innerHTML
}
