import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { fetchAndRewriteArticle, fetchRecentArticles, parseWikipediaUrl } from './lib/wikipedia'
import type { WikipediaArticle } from './lib/wikipedia'
import { ArticleBody } from './components/ArticleBody'
import { GoldenShine, PatrioticEffects } from './components/ArticleEffects'
import { RewriteProgress } from './components/RewriteProgress'
import { articleDestination, articleHref, contentsFromHtml, sectionAnchor } from './components/articleNavigation'

type LoadState = 'landing' | 'loading' | 'article' | 'error'
type RecentArticle = { url: string; title: string }
type LoadOptions = { signal?: AbortSignal; onUpdate?: (article: WikipediaArticle) => void; retry?: boolean }
export type AppServices = {
  loadArticle: (input: string, onProgress?: (progress: number) => void, options?: LoadOptions) => Promise<WikipediaArticle>
  loadRecent: (signal?: AbortSignal) => Promise<RecentArticle[]>
}
const DEFAULT_SERVICES: AppServices = { loadArticle: fetchAndRewriteArticle, loadRecent: fetchRecentArticles }
const percent = (value: number) => Number.isFinite(value) ? Math.min(100, Math.max(0, Math.floor(value))) : 0
const plainClick = (event: MouseEvent<HTMLElement>) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

function hasVisibleContent(value: WikipediaArticle | null): boolean {
  if (!value) return false
  if (!value.sections?.length) return Boolean(value.html)
  return value.sections.some(section => section.complete && Boolean(section.html)) ||
    ((value.status === 'partial' || value.status === 'failed') && value.sections.some(section => Boolean(section.html)))
}

function preserveFinishedSections(previous: WikipediaArticle | null, next: WikipediaArticle): WikipediaArticle {
  if (!previous || previous.canonicalUrl !== next.canonicalUrl || !hasVisibleContent(previous)) return next
  if (!hasVisibleContent(next)) return { ...previous, status: next.status, progress: next.progress, jobId: next.jobId, failedCount: next.failedCount }
  if (!previous.sections?.length || !next.sections?.length) return next
  const ready = new Map(previous.sections.filter(section => section.complete).map(section => [section.id, section]))
  return { ...next, sections: next.sections.map(section => !section.complete && ready.has(section.id) ? ready.get(section.id)! : section) }
}

function scrollToHeading(id: string, smooth = false): boolean {
  const element = document.getElementById(id) || document.getElementsByName(id)[0]
  if (!element) return false
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: Math.max(0, element.getBoundingClientRect().top + window.scrollY - 70), behavior: smooth && !reducedMotion ? 'smooth' : 'auto' })
  return true
}

function App({ services = DEFAULT_SERVICES }: { services?: AppServices }) {
  const [urlInput, setUrlInput] = useState('')
  const [status, setStatus] = useState<LoadState>('landing')
  const [error, setError] = useState('')
  const [article, setArticle] = useState<WikipediaArticle | null>(null)
  const [progress, setProgress] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isShaking, setIsShaking] = useState(false)
  const [validationError, setValidationError] = useState('')
  const [recentArticles, setRecentArticles] = useState<RecentArticle[]>([])
  const [routeHash, setRouteHash] = useState(window.location.hash)
  const currentArticle = useRef<WikipediaArticle | null>(null)
  const request = useRef<{ id: number; controller: AbortController } | null>(null)
  const sequence = useRef(0)
  const recentRequest = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrolledHash = useRef('')
  const pathname = window.location.pathname
  const visibleArticle = status === 'article' && article !== null
  const isTrumpPage = visibleArticle && (article.canonicalUrl.endsWith('/wiki/Donald_Trump') || article.title === 'Donald Trump')
  const pageTitle = article && status !== 'landing' ? `${article.title} - Trumpedia` : 'TRUMPEDIA'

  const refreshRecent = useCallback(async () => {
    recentRequest.current?.abort()
    const controller = new AbortController()
    recentRequest.current = controller
    try {
      const articles = await services.loadRecent(controller.signal)
      if (mounted.current && !controller.signal.aborted && recentRequest.current === controller) setRecentArticles(articles)
    } catch {
      // A recent-list failure must not prevent reading or generating an article.
    }
  }, [services])

  const goHome = useCallback((history: 'push' | 'none' = 'push') => {
    request.current?.controller.abort()
    request.current = null
    currentArticle.current = null
    if (history === 'push') window.history.pushState(null, '', window.location.pathname)
    setStatus('landing')
    setArticle(null)
    setError('')
    setValidationError('')
    setIsGenerating(false)
    setRouteHash('')
    window.scrollTo(0, 0)
  }, [])

  const handleRewrite = useCallback(async (input: string, options: { history?: 'push' | 'replace' | 'none'; retry?: boolean; hash?: string } = {}) => {
    setUrlInput(input)
    let canonicalUrl: string
    let hash: string
    try {
      canonicalUrl = parseWikipediaUrl(input).canonicalUrl
      hash = options.hash ?? new URL(input).hash
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : 'Please provide a valid Wikipedia article link.')
      setIsShaking(true)
      if (shakeTimer.current) clearTimeout(shakeTimer.current)
      shakeTimer.current = setTimeout(() => setIsShaking(false), 500)
      return
    }
    const historyMode = options.history ?? 'push'
    const href = articleHref(canonicalUrl, window.location.pathname, hash)
    if (historyMode !== 'none' && `${window.location.pathname}${window.location.search}${window.location.hash}` !== href) {
      if (historyMode === 'replace') window.history.replaceState(null, '', href)
      else window.history.pushState(null, '', href)
    }
    setUrlInput(canonicalUrl)
    setValidationError('')
    setRouteHash(hash)
    scrolledHash.current = ''
    if (!options.retry && currentArticle.current?.canonicalUrl === canonicalUrl && hasVisibleContent(currentArticle.current)) {
      setStatus('article')
      if (hash) {
        try { scrollToHeading(decodeURIComponent(hash.slice(1))) } catch { /* Ignore malformed fragments. */ }
      }
      return
    }
    request.current?.controller.abort()
    const controller = new AbortController()
    const id = ++sequence.current
    request.current = { id, controller }
    const isCurrent = () => mounted.current && request.current?.id === id && !controller.signal.aborted
    const previous = currentArticle.current?.canonicalUrl === canonicalUrl ? currentArticle.current : null
    currentArticle.current = previous
    setArticle(previous)
    setStatus(hasVisibleContent(previous) ? 'article' : 'loading')
    setError('')
    const readyBeforeRetry = previous?.sections?.length
      ? (previous.sections.filter(section => section.complete).length / previous.sections.length) * 100
      : 0
    setProgress(options.retry ? percent(readyBeforeRetry) : percent(previous?.progress || 0))
    setIsGenerating(true)
    if (!hash) window.scrollTo(0, 0)
    const update = (next: WikipediaArticle) => {
      if (!isCurrent()) return
      const snapshot = preserveFinishedSections(currentArticle.current, next)
      if (snapshot.canonicalUrl !== canonicalUrl) {
        try {
          const redirectedUrl = parseWikipediaUrl(snapshot.canonicalUrl).canonicalUrl
          if (new URLSearchParams(window.location.search).get('url') !== redirectedUrl) {
            const currentHash = window.location.hash
            window.history.replaceState(window.history.state, '', articleHref(redirectedUrl, window.location.pathname, currentHash))
            setRouteHash(currentHash)
            setUrlInput(value => value === canonicalUrl ? redirectedUrl : value)
          }
        } catch { /* A malformed response URL cannot change the current route. */ }
      }
      currentArticle.current = snapshot
      setArticle(snapshot)
      if (typeof snapshot.progress === 'number') setProgress(percent(snapshot.progress))
      setStatus(hasVisibleContent(snapshot) ? 'article' : 'loading')
    }
    try {
      const result = await services.loadArticle(canonicalUrl, value => { if (isCurrent()) setProgress(percent(value)) }, { signal: controller.signal, onUpdate: update, retry: options.retry })
      if (!isCurrent()) return
      update(result)
      setStatus(hasVisibleContent(currentArticle.current) ? 'article' : 'error')
      if (!hasVisibleContent(currentArticle.current)) setError('The page is not ready yet. You can retry its unfinished sections.')
      void refreshRecent()
    } catch (cause) {
      if (!isCurrent()) return
      setError(cause instanceof Error ? cause.message : 'Could not finish loading this article.')
      setStatus(hasVisibleContent(currentArticle.current) ? 'article' : 'error')
    } finally {
      if (mounted.current && request.current?.id === id) {
        request.current = null
        setIsGenerating(false)
      }
    }
  }, [refreshRecent, services])

  useEffect(() => {
    mounted.current = true
    let active = true
    const fromLocation = (initial = false) => {
      const input = new URLSearchParams(window.location.search).get('url')
      if (input) void handleRewrite(input, { history: initial ? 'replace' : 'none', hash: window.location.hash || undefined })
      else goHome('none')
    }
    // Deferring one microtask lets StrictMode discard its probe mount before a
    // generation request is started, without delaying a real navigation.
    queueMicrotask(() => {
      if (!active) return
      fromLocation(true)
      void refreshRecent()
    })
    const popstate = () => fromLocation()
    window.addEventListener('popstate', popstate)
    return () => {
      active = false
      mounted.current = false
      request.current?.controller.abort()
      request.current = null
      recentRequest.current?.abort()
      if (shakeTimer.current) clearTimeout(shakeTimer.current)
      window.removeEventListener('popstate', popstate)
    }
  }, [goHome, handleRewrite, refreshRecent])

  useEffect(() => {
    document.title = pageTitle
  }, [pageTitle])

  useEffect(() => {
    if (!visibleArticle || !routeHash || !article) return
    const key = `${article.canonicalUrl}${routeHash}`
    if (scrolledHash.current === key) return
    try {
      if (scrollToHeading(decodeURIComponent(routeHash.slice(1)))) scrolledHash.current = key
    } catch { /* A malformed link fragment cannot interrupt the article. */ }
  }, [article, routeHash, visibleArticle])

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void handleRewrite(urlInput)
  }

  const onContentClick = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!plainClick(event) || event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    const anchor = target?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return
    const destination = articleDestination(anchor.href, window.location.origin, window.location.pathname)
    if (!destination) return
    // Plain in-page anchors keep the browser's usual hash behavior.
    if ((anchor.getAttribute('href') || '').startsWith('#')) return
    event.preventDefault()
    void handleRewrite(destination.canonicalUrl, { hash: destination.hash })
  }, [handleRewrite])

  function onHomeClick(event: MouseEvent<HTMLElement>) {
    if (!plainClick(event)) return
    event.preventDefault()
    goHome()
  }

  function stopLoading() {
    request.current?.controller.abort()
    request.current = null
    setIsGenerating(false)
    setError('Loading stopped. Finished sections are kept; resume when you are ready.')
    setStatus(hasVisibleContent(currentArticle.current) ? 'article' : 'error')
  }

  const toc = useMemo(() => article?.sections?.length
    ? article.sections.filter(section => section.title).map(section => ({ id: sectionAnchor(section.id), text: section.title, level: 2 }))
    : contentsFromHtml(article?.html || ''), [article?.html, article?.sections])
  const unfinished = Boolean(article && (article.status === 'partial' || article.status === 'failed' || article.rewriteMode !== 'llm' || (article.failedCount || 0) > 0))
  const unchanged = article?.status === 'complete' && article.rewriteMode === 'heuristic'
  const retryUrl = article?.canonicalUrl || urlInput
  const readySections = article?.sections?.filter(section => section.complete).length
  const retry = () => { void handleRewrite(retryUrl, { retry: true, history: 'none', hash: routeHash }) }

  return (
    <div className={`app-shell ${isTrumpPage ? 'trump-page' : ''}`}>
      <GoldenShine />
      {isTrumpPage && <PatrioticEffects />}
      {status === 'landing' && (
        <main className="landing">
          <h1>
            <span className="accent">T</span>
            RUMPEDI
            <span className="accent">A</span>
          </h1>
          <p className="maga-subtitle">Make Articles Great Again</p>
          <div className="portrait-container">
            <img 
              className="official-portrait"
              src="https://upload.wikimedia.org/wikipedia/commons/6/6f/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29_%28cropped%29.jpg" 
              alt="Official Portrait of Donald J. Trump"
            />
          </div>
          <p className="tagline">The free encyclopedia, rewritten with tremendous confidence.</p>
          <form className={`hero-search ${isShaking ? 'shake' : ''}`} onSubmit={onSubmit}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
              <input
                aria-label="Paste Wikipedia URL"
                type="url"
                placeholder="please post an existing wikipedia link"
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value)
                  if (validationError) setValidationError('')
                }}
                required
              />
              {validationError && (
                <span style={{ color: '#b32424', fontSize: '0.9rem', marginTop: '0.4rem', fontWeight: 'bold' }}>
                  {validationError}
                </span>
              )}
            </div>
            <button type="submit" disabled={isGenerating}>
              {isGenerating ? 'Rewriting...' : 'Rewrite this page'}
            </button>
          </form>
          <p className="helper">AI-generated parody. Links and images come from Wikipedia.</p>

          {recentArticles.length > 0 && (
            <div className="recent-section">
              <h3>Recently Trumpified</h3>
              <div className="marquee-container">
                <div className="marquee-track row-1">
                  {[...recentArticles.slice(0, 10), ...recentArticles.slice(0, 10)].map((art, idx) => (
                    <a 
                      key={`${art.url}-row1-${idx}`} 
                      href={articleHref(art.url, pathname)}
                      className="recent-item brick"
                      onClick={onContentClick}
                    >
                      {art.title}
                    </a>
                  ))}
                </div>
                <div className="marquee-track row-2">
                  {[...recentArticles.slice(10, 20), ...recentArticles.slice(10, 20)].map((art, idx) => (
                    <a 
                      key={`${art.url}-row2-${idx}`} 
                      href={articleHref(art.url, pathname)}
                      className="recent-item brick"
                      onClick={onContentClick}
                    >
                      {art.title}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {status !== 'landing' && (
        <>
          <header className="top-bar">
            <div className="top-bar-left">
              <a className="brand" href={pathname} onClick={onHomeClick}>
                <span className="brand-text">
                  <span className="accent">T</span>RUMPEDI<span className="accent">A</span>
                </span>
              </a>
            </div>
            <form className={`top-search ${isShaking ? 'shake' : ''}`} onSubmit={onSubmit}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <input
                  aria-label="Wikipedia URL"
                  type="url"
                  placeholder="please post an existing wikipedia link"
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value)
                    if (validationError) setValidationError('')
                  }}
                  required
                />
                {validationError && (
                  <span style={{ color: '#b32424', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                    {validationError}
                  </span>
                )}
              </div>
              <button type="submit" disabled={isGenerating}>
                {isGenerating ? 'Loading...' : 'Rewrite'}
              </button>
            </form>
            <div className="top-bar-right">
              <a 
                href="https://buy.stripe.com/cNidR9g41b3pdt1ckE00000"
                target="_blank"
                rel="noopener noreferrer"
                title="TREMENDOUS DONATION FROM A PATRIOT"
              >
                Donate
              </a>
            </div>
          </header>

          <div className="wiki-tabs-container">
            <div className="wiki-tabs">
              <div className="wiki-tab active">Article</div>
            </div>
            <div className="wiki-tabs">
              <div className="wiki-tab active">Read</div>
              {article && (
                <a 
                  href={article.canonicalUrl} 
                  target="_blank" 
                  rel="noreferrer" 
                  className="wiki-tab original-link"
                  style={{ textDecoration: 'none' }}
                >
                  View original Wikipedia ↗
                </a>
              )}
            </div>
          </div>

          <div className="wiki-wrapper">
            <aside className="wiki-sidebar">
              <div className="sidebar-section" id="contents">
                <h3>Contents</h3>
                {toc.length > 0 ? (
                  <ul className="toc-list">
                    <li className="toc-item toc-level-1">
                      <a href="#" onClick={(e) => {
                        if (!plainClick(e)) return
                        e.preventDefault()
                        window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`)
                        setRouteHash('')
                        window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
                      }}>
                        (Top)
                      </a>
                    </li>
                    {toc.map((item, idx) => (
                      <li key={`${item.id}-${idx}`} className={`toc-item toc-level-${item.level}`}>
                        <a 
                          href={`#${encodeURIComponent(item.id)}`}
                          onClick={(e) => {
                            if (!plainClick(e)) return
                            e.preventDefault()
                            window.history.pushState(null, '', `#${encodeURIComponent(item.id)}`)
                            setRouteHash(`#${encodeURIComponent(item.id)}`)
                            scrollToHeading(item.id, true)
                          }}
                        >
                          {item.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ color: '#54595d', fontStyle: 'italic' }}>No sections found.</p>
                )}
              </div>
              <div className="sidebar-section" style={{ marginTop: '2rem' }}>
                <h3>Navigation</h3>
                <ul>
                  <li><a href={pathname} onClick={onHomeClick}>Main page</a></li>
                  <li><a href="#contents">Contents</a></li>
                </ul>
              </div>
            </aside>

            <main className="wiki-content-container">
              {status === 'loading' && (
                <RewriteProgress progress={progress} queued={article?.status === 'queued'} completed={readySections} total={article?.sections?.length} onStop={stopLoading} />
              )}

              {status === 'error' && (
                <div className="status-page error">
                  <h2>Could not load article</h2>
                  <p>{error}</p>
                  <button type="button" className="rewrite-secondary-button" onClick={retry}>Try again</button>
                </div>
              )}

              {status === 'article' && article && (
                <div className="article-page">
                  <div className="article-header">
                    <h1>{article.title}</h1>
                    {isTrumpPage && (
                      <div className="trump-score-box">
                        <div className="trump-score-number">0</div>
                        <div className="trump-score-text">
                          YOU ARE THIS MANY PAGES<br />AWAY FROM TRUMP
                        </div>
                      </div>
                    )}
                  </div>

                  <p className="parody-notice">{unchanged ? 'Original Wikipedia content. No prose was rewritten for this page.' : 'AI-generated parody, not written by Donald Trump. Check the original for facts.'}</p>

                  {isGenerating && <RewriteProgress compact progress={progress} queued={article.status === 'queued'} completed={readySections} total={article.sections?.length} onStop={stopLoading} />}

                  {!isGenerating && (error || unfinished) && <div className="rewrite-notice" role="status">
                    <p>{error || (unchanged ? 'No eligible prose was found to rewrite. This page shows the original Wikipedia content.' : article.failedCount ? `${article.failedCount} ${article.failedCount === 1 ? 'passage needs' : 'passages need'} another pass.` : 'Some text could not be fully rewritten. Finished sections are kept.')}</p>
                    {(!unchanged || Boolean(error)) && <button type="button" className="rewrite-secondary-button" onClick={retry}>Retry unfinished sections</button>}
                  </div>}

                  {article.opinion && !unchanged && (
                    <div className="trump-opinion-box">
                      <img 
                        src="https://upload.wikimedia.org/wikipedia/commons/6/6f/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29_%28cropped%29.jpg" 
                        alt="Trump" 
                        className="opinion-avatar"
                      />
                      <p className="opinion-text">"{article.opinion}"</p>
                    </div>
                  )}

                  <ArticleBody article={article} pathname={pathname} onNavigate={onContentClick} isLoading={isGenerating} />
                </div>
              )}
            </main>
          </div>
        </>
      )}
      
      <footer className="site-footer">
        <div>
          Made with ❤️, 🤖, and 😎 by <a href="https://www.nbaronia.com/" target="_blank" rel="noopener noreferrer">nbaronia</a>
        </div>
        <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
          <a 
            href="https://buy.stripe.com/cNidR9g41b3pdt1ckE00000"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#bf953f', fontWeight: 'bold', textDecoration: 'none' }}
          >
            MAKE A TREMENDOUS DONATION 🇺🇸
          </a>
        </div>
      </footer>
    </div>
  )
}

export default App
