import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { fetchAndRewriteArticle } from './lib/wikipedia'

type LoadState = 'landing' | 'loading' | 'article' | 'error'

type ArticleState = {
  title: string
  html: string
  canonicalUrl: string
  sourceApiUrl: string
  rewriteMode: 'llm' | 'llm-partial' | 'heuristic'
}

function App() {
  const [urlInput, setUrlInput] = useState('')
  const [status, setStatus] = useState<LoadState>('landing')
  const [error, setError] = useState('')
  const [article, setArticle] = useState<ArticleState | null>(null)
  const [progress, setProgress] = useState(0)
  const [isShaking, setIsShaking] = useState(false)

  const loading = status === 'loading'

  // Load article from URL parameter on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const initialUrl = params.get('url')
    if (initialUrl) {
      setUrlInput(initialUrl)
      handleRewrite(initialUrl)
    }
  }, [])

  async function handleRewrite(input: string) {
    if (!input) return
    setStatus('loading')
    setError('')
    setProgress(0)

    try {
      const result = await fetchAndRewriteArticle(input, (p) => setProgress(p))
      setArticle(result)
      setStatus('article')
    } catch (err) {
      setStatus('error')
      setArticle(null)
      setError(err instanceof Error ? err.message : 'Unexpected error while loading article.')
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    
    // Validation: Must be a Wikipedia link
    if (!urlInput.includes('wikipedia.org/wiki/')) {
      setIsShaking(true)
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
        event.preventDefault()
        
        // Construct the new Trumpedia URL with the parameter
        const currentUrl = new URL(window.location.href)
        const newTabUrl = `${currentUrl.origin}${currentUrl.pathname}?url=${encodeURIComponent(href)}`
        
        window.open(newTabUrl, '_blank')
      }
    }
  }

  const pageTitle = useMemo(() => {
    if (article) return `${article.title} - Trumpedia`
    return 'Trumpedia'
  }, [article])

  return (
    <div className="app-shell">
      <header className="top-bar">
        <a className="brand" href="#" onClick={() => setStatus('landing')}>
          <span className="brand-mark">T</span>
          <span className="brand-text">Trumpedia</span>
        </a>
        <form className={`top-search ${isShaking ? 'shake' : ''}`} onSubmit={onSubmit}>
          <input
            aria-label="Wikipedia URL"
            type="url"
            placeholder="please post an existing wikipedia link"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Loading...' : 'Rewrite'}
          </button>
        </form>
      </header>

      {status === 'landing' && (
        <main className="landing">
          <h1>{pageTitle}</h1>
          <p className="tagline">The free encyclopedia, rewritten with tremendous confidence.</p>
          <form className={`hero-search ${isShaking ? 'shake' : ''}`} onSubmit={onSubmit}>
            <input
              aria-label="Paste Wikipedia URL"
              type="url"
              placeholder="please post an existing wikipedia link"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              required
            />
            <button type="submit" disabled={loading}>
              {loading ? 'Rewriting...' : 'Rewrite this page'}
            </button>
          </form>
          <p className="helper">Links and images are preserved from the original article.</p>
        </main>
      )}

      {status === 'loading' && (
        <main className="status-page">
          <h2>Loading article</h2>
          <p>Fetching and transforming Wikipedia content.</p>
          <div className="progress-container">
            <div className="progress-bar-bg">
              <div 
                className="progress-bar-fill" 
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="progress-text">{progress}% processed</p>
          </div>
        </main>
      )}

      {status === 'error' && (
        <main className="status-page error">
          <h2>Could not load article</h2>
          <p>{error}</p>
        </main>
      )}

      {status === 'article' && article && (
        <main className="article-page">
          <div className="article-header">
            <h1>{article.title}</h1>
            <div className="article-links">
              <a href={article.canonicalUrl} target="_blank" rel="noreferrer">
                View original Wikipedia page
              </a>
            </div>
          </div>

          <article 
            className="mw-content" 
            dangerouslySetInnerHTML={{ __html: article.html }} 
            onClick={onContentClick}
          />
        </main>
      )}
    </div>
  )
}

export default App
