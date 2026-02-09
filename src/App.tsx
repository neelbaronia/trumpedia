import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { fetchAndRewriteArticle } from './lib/wikipedia'
import { supabase } from './lib/supabase'

type LoadState = 'landing' | 'loading' | 'article' | 'error'

type ArticleState = {
  title: string
  html: string
  canonicalUrl: string
  sourceApiUrl: string
  rewriteMode: 'llm' | 'llm-partial' | 'heuristic'
}

type TOCItem = {
  id: string
  text: string
  level: number
}

function App() {
  const [urlInput, setUrlInput] = useState('')
  const [status, setStatus] = useState<LoadState>('landing')
  const [error, setError] = useState('')
  const [article, setArticle] = useState<ArticleState | null>(null)
  const [progress, setProgress] = useState(0)
  const [isShaking, setIsShaking] = useState(false)
  const [validationError, setValidationError] = useState('')
  const [recentArticles, setRecentArticles] = useState<any[]>([])
  const [flavorTextIndex, setFlavorTextIndex] = useState(0)

  const flavorTexts = [
    "Negotiating a better deal with Wikipedia...",
    "Building a tremendous firewall around this article...",
    "Rewriting history with total confidence, believe me...",
    "Reviewing the crowd sizes at the last rally...",
    "Making this article great again...",
    "Sending world-class tweets while the segments process...",
    "Consulting with the best people for this rewrite...",
    "Adding some very important gold accents to the prose...",
    "Checking the polls—we're up bigly, very bigly!",
    "Firing the woke editors who wrote this original garbage..."
  ]

  const loading = status === 'loading'

  // Cycling flavor text during loading
  useEffect(() => {
    if (status !== 'loading') return

    const interval = setInterval(() => {
      setFlavorTextIndex((prev) => (prev + 1) % flavorTexts.length)
    }, 5000)

    return () => clearInterval(interval)
  }, [status, flavorTexts.length])

  // Load article from URL parameter on mount
  useEffect(() => {
    console.log('--- Trumpedia 🇺🇸 Debug ---')
    console.log('API URL:', import.meta.env.VITE_REWRITE_API_URL || 'http://127.0.0.1:8787/api/rewrite')
    console.log('Supabase URL:', import.meta.env.VITE_SUPABASE_URL)
    console.log('Key Status:', import.meta.env.VITE_SUPABASE_ANON_KEY?.startsWith('sb_publishable') ? '✅ Correct Publishable Key' : '❌ Wrong Key (Use Publishable key from Supabase)')
    
    const params = new URLSearchParams(window.location.search)
    const initialUrl = params.get('url')
    if (initialUrl) {
      setUrlInput(initialUrl)
      handleRewrite(initialUrl)
    }

    // Fetch recent articles
    fetchRecentArticles()
  }, [])

  useEffect(() => {
    if (status === 'article' || status === 'loading') {
      window.scrollTo(0, 0)
    }
  }, [status])

  async function fetchRecentArticles() {
    if (!supabase) return
    const { data } = await supabase
      .from('articles')
      .select('url, title')
      .order('created_at', { ascending: false })
      .limit(20)
    
    if (data) {
      setRecentArticles(data)
    }
  }

  async function handleRewrite(input: string) {
    if (!input) return
    setStatus('loading')
    setFlavorTextIndex(Math.floor(Math.random() * flavorTexts.length))
    setError('')
    setProgress(0)
    window.scrollTo(0, 0) // Reset scroll position to top

    try {
      const result = await fetchAndRewriteArticle(input, (p) => setProgress(p))
      setArticle(result)
      setStatus('article')
      // Refresh recent articles after a successful rewrite
      fetchRecentArticles()
    } catch (err) {
      setStatus('error')
      setArticle(null)
      setError(err instanceof Error ? err.message : 'Unexpected error while loading article.')
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setValidationError('')
    
    // Validation: Must be a Wikipedia link
    if (!urlInput.includes('wikipedia.org/wiki/')) {
      setIsShaking(true)
      setValidationError('Please provide a valid Wikipedia article link.')
      setTimeout(() => setIsShaking(false), 500)
      return
    }

    handleRewrite(urlInput)
  }

  // Intercept clicks on Wikipedia links
  function onContentClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    
    if (anchor && anchor.href) {
      const href = anchor.href
      // Check if it's a Wikipedia link
      if (href.includes('wikipedia.org/wiki/')) {
        // Skip non-article links like Files, Categories, etc.
        const isArticle = !href.includes('/wiki/File:') && 
                         !href.includes('/wiki/Category:') && 
                         !href.includes('/wiki/Special:') && 
                         !href.includes('/wiki/Talk:') &&
                         !href.includes('/wiki/Template:');

        if (!isArticle) return;

        event.preventDefault()
        
        // Construct the new URL using current location
        const targetUrl = new URL(window.location.origin + window.location.pathname);
        targetUrl.searchParams.set('url', href);
        
        window.open(targetUrl.toString(), '_blank');
      }
    }
  }

  const pageTitle = useMemo(() => {
    if (article) return `${article.title} - Trumpedia`
    return 'TRUMPEDIA'
  }, [article])

  useEffect(() => {
    document.title = pageTitle
  }, [pageTitle])

  const toc = useMemo<TOCItem[]>(() => {
    if (!article || status !== 'article') return []
    
    const parser = new DOMParser()
    const doc = parser.parseFromString(article.html, 'text/html')
    const headers = Array.from(doc.querySelectorAll('h2, h3, h4'))
    
    return headers.map((header, index) => {
      // Wikipedia usually puts the ID on a span inside the header, or the header itself
      const id = header.id || 
                 header.querySelector('.mw-headline')?.id || 
                 `section-${index}`;
                 
      // If the header doesn't have an ID, we should probably add one to the actual rendered HTML too
      // but for now let's just extract what's there.
      
      return {
        id,
        text: header.textContent?.replace('[edit]', '').trim() || '',
        level: parseInt(header.tagName.substring(1))
      }
    }).filter(item => item.text.length > 0)
  }, [article, status])

  return (
    <div className="app-shell">
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
            <button type="submit" disabled={loading}>
              {loading ? 'Rewriting...' : 'Rewrite this page'}
            </button>
          </form>
          <p className="helper">Links and images are preserved from the original article.</p>

          {recentArticles.length > 0 && (
            <div className="recent-section">
              <h3>Recently Trumpified</h3>
              <div className="marquee-container">
                <div className="marquee-track row-1">
                  {[...recentArticles.slice(0, 10), ...recentArticles.slice(0, 10)].map((art, idx) => (
                    <a 
                      key={`${art.url}-row1-${idx}`} 
                      href={`?url=${encodeURIComponent(art.url)}`}
                      className="recent-item brick"
                      onClick={(e) => {
                        e.preventDefault()
                        setUrlInput(art.url)
                        handleRewrite(art.url)
                      }}
                    >
                      {art.title}
                    </a>
                  ))}
                </div>
                <div className="marquee-track row-2">
                  {[...recentArticles.slice(10, 20), ...recentArticles.slice(10, 20)].map((art, idx) => (
                    <a 
                      key={`${art.url}-row2-${idx}`} 
                      href={`?url=${encodeURIComponent(art.url)}`}
                      className="recent-item brick"
                      onClick={(e) => {
                        e.preventDefault()
                        setUrlInput(art.url)
                        handleRewrite(art.url)
                      }}
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
              <a className="brand" href="#" onClick={() => setStatus('landing')}>
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
              <button type="submit" disabled={loading}>
                {loading ? 'Loading...' : 'Rewrite'}
              </button>
            </form>
            <div className="top-bar-right">
              <a href="#">Donate</a>
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
              <div className="sidebar-section">
                <h3>Contents</h3>
                {toc.length > 0 ? (
                  <ul className="toc-list">
                    <li className="toc-item toc-level-1">
                      <a href="#" onClick={(e) => {
                        e.preventDefault()
                        window.scrollTo({ top: 0, behavior: 'smooth' })
                      }}>
                        (Top)
                      </a>
                    </li>
                    {toc.map((item, idx) => (
                      <li key={`${item.id}-${idx}`} className={`toc-item toc-level-${item.level}`}>
                        <a 
                          href={`#${item.id}`}
                          onClick={(e) => {
                            e.preventDefault()
                            const el = document.getElementById(item.id) || 
                                     document.getElementsByName(item.id)[0] ||
                                     document.querySelector(`[id="${item.id}"]`);
                            if (el) {
                              const offset = 70; // Account for sticky headers if any
                              const bodyRect = document.body.getBoundingClientRect().top;
                              const elementRect = el.getBoundingClientRect().top;
                              const elementPosition = elementRect - bodyRect;
                              const offsetPosition = elementPosition - offset;

                              window.scrollTo({
                                top: offsetPosition,
                                behavior: 'smooth'
                              });
                            }
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
                  <li><a href="#" onClick={(e) => { e.preventDefault(); setStatus('landing') }}>Main page</a></li>
                  <li><a href="#">Contents</a></li>
                  <li><a href="#">Current events</a></li>
                  <li><a href="#">Random article</a></li>
                </ul>
              </div>
            </aside>

            <main className="wiki-content-container">
              {status === 'loading' && (
                <div className="status-page">
                  <h2>Loading article</h2>
                  <p>{flavorTexts[flavorTextIndex]}</p>
                  <div className="progress-container">
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill" 
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <p className="progress-text">{progress}% processed</p>
                  </div>
                </div>
              )}

              {status === 'error' && (
                <div className="status-page error">
                  <h2>Could not load article</h2>
                  <p>{error}</p>
                </div>
              )}

              {status === 'article' && article && (
                <div className="article-page">
                  <div className="article-header">
                    <h1>{article.title}</h1>
                  </div>

                  <article 
                    className="mw-content vector-body" 
                    dangerouslySetInnerHTML={{ __html: article.html }} 
                    onClick={onContentClick}
                  />
                </div>
              )}
            </main>
          </div>
        </>
      )}
      
      <footer className="site-footer">
        Made with ❤️, 🤖, and 😎 by <a href="https://www.nbaronia.com/" target="_blank" rel="noopener noreferrer">nbaronia</a>
      </footer>
    </div>
  )
}

export default App
