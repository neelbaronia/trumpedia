import { memo, useMemo } from 'react'
import type { MouseEventHandler } from 'react'
import createDOMPurify from 'dompurify'
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
  })
}

const ArticleMarkup = memo(function ArticleMarkup({ html, canonicalUrl, pathname, scope }: {
  html: string; canonicalUrl: string; pathname: string; scope: string
}) {
  const markup = useMemo(() => ({ __html: prepareArticleHtml(safeArticleHtml(html), canonicalUrl, pathname, scope) }), [html, canonicalUrl, pathname, scope])
  return <div className="article-section-body" dangerouslySetInnerHTML={markup} />
})

const Section = memo(function Section({ id, title, html, complete, terminal, canonicalUrl, pathname }: ArticleSection & {
  terminal: boolean; canonicalUrl: string; pathname: string
}) {
  const showText = complete || (terminal && Boolean(html))
  return <section id={sectionAnchor(id)} className={`article-section${complete ? ' is-complete' : ' is-pending'}`} aria-busy={!complete && !terminal}>
    {!complete && <p className="section-rewrite-status">{showText ? 'Not fully rewritten' : `${title || 'Introduction'} · ${terminal ? 'not rewritten yet' : 'waiting for its rewrite'}`}</p>}
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
