import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import type { MouseEventHandler } from 'react'
import createDOMPurify from 'dompurify'
import morphdom from 'morphdom'
import type { DOMPurify } from 'dompurify'
import type { WikipediaArticle } from '../lib/wikipedia'
import { prepareArticleHtml, sectionAnchor } from './articleNavigation'

type ArticleSection = NonNullable<WikipediaArticle['sections']>[number]
const sanitizers = new WeakMap<Window, DOMPurify>()

function safeArticleHtml(html: string): string {
  let sanitizer = sanitizers.get(window)
  if (!sanitizer) {
    sanitizer = createDOMPurify(window)
    sanitizers.set(window, sanitizer)
  }
  return sanitizer.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'base', 'meta', 'link'],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['data-trumpedia-unit'],
  })
}

const ArticleMarkup = memo(function ArticleMarkup({ html, canonicalUrl, pathname, scope }: {
  html: string; canonicalUrl: string; pathname: string; scope: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const markup = useMemo(() => prepareArticleHtml(safeArticleHtml(html), canonicalUrl, pathname, scope), [html, canonicalUrl, pathname, scope])
  useLayoutEffect(() => {
    const current = container.current
    if (!current) return
    const next = current.cloneNode(false) as HTMLDivElement
    next.innerHTML = markup
    // React owns the container; only sanitized article markup is patched inside.
    // Keep unchanged paragraphs and their text nodes so selections survive updates.
    morphdom(current, next, {
      childrenOnly: true,
      getNodeKey: node => {
        if (!(node instanceof Element)) return undefined
        const unit = node.getAttribute('data-trumpedia-unit')
        return unit ? `paragraph:${unit}` : node.id ? `id:${node.id}` : undefined
      },
      onBeforeElUpdated: (from, to) => !from.isEqualNode(to),
    })
  }, [markup])
  return <div ref={container} className="article-section-body" />
})

const Section = memo(function Section({ id, title, html, complete, terminal, canonicalUrl, pathname }: ArticleSection & {
  terminal: boolean; canonicalUrl: string; pathname: string
}) {
  const showText = Boolean(html)
  return <section id={sectionAnchor(id)} className={`article-section${complete ? ' is-complete' : ' is-pending'}`} aria-busy={!complete && !terminal}>
    {!complete && <p className="section-rewrite-status">{showText ? terminal ? 'Not fully rewritten' : 'More paragraphs are on the way.' : `${title || 'Introduction'} · ${terminal ? 'not rewritten yet' : 'waiting for its rewrite'}`}</p>}
    {showText
      ? <ArticleMarkup html={html} canonicalUrl={canonicalUrl} pathname={pathname} scope={id} />
      : <div className="section-placeholder" aria-hidden="true"><span /><span /><span /></div>}
  </section>
})

export const ArticleBody = memo(function ArticleBody({ article, pathname, onNavigate, isLoading = false }: {
  article: WikipediaArticle; pathname: string; onNavigate: MouseEventHandler<HTMLElement>; isLoading?: boolean
}) {
  const terminal = !isLoading || article.status === 'complete' || article.status === 'partial' || article.status === 'failed'
  return <article className="mw-content vector-body" onClick={onNavigate}>
    {article.sections?.length
      ? article.sections.map(section => <Section key={section.id} {...section} terminal={terminal} canonicalUrl={article.canonicalUrl} pathname={pathname} />)
      : <ArticleMarkup html={article.html} canonicalUrl={article.canonicalUrl} pathname={pathname} scope="article" />}
  </article>
})
