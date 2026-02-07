import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { fetchAndRewriteArticle } from './lib/wikipedia'

type LoadState = 'landing' | 'loading' | 'article' | 'error'

type ArticleState = {
  title: string
  html: string
  canonicalUrl: string
  sourceApiUrl: string
  rewriteMode: 'llm' | 'heuristic'
}

function App() {
  const [urlInput, setUrlInput] = useState('')
  const [status, setStatus] = useState<LoadState>('landing')
  const [error, setError] = useState('')
  const [article, setArticle] = useState<ArticleState | null>(null)

  const loading = status === 'loading'

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus('loading')
    setError('')

    try {
      const result = await fetchAndRewriteArticle(urlInput)
      setArticle(result)
      setStatus('article')
    } catch (err) {
      setStatus('error')
      setArticle(null)
      setError(err instanceof Error ? err.message : 'Unexpected error while loading article.')
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
        <form className="top-search" onSubmit={onSubmit}>
          <input
            aria-label="Wikipedia URL"
            type="url"
            placeholder="Paste a Wikipedia article URL"
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
          <form className="hero-search" onSubmit={onSubmit}>
            <input
              aria-label="Paste Wikipedia URL"
              type="url"
              placeholder="https://en.wikipedia.org/wiki/Article_Title"
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
              <a href={article.sourceApiUrl} target="_blank" rel="noreferrer">
                View source API call
              </a>
            </div>
          </div>

          <p className="disclaimer">
            Satirical rewrite: article structure, links, and media are from Wikipedia. Rewrite mode:{' '}
            <strong>{article.rewriteMode === 'llm' ? 'LLM (enhanced)' : 'heuristic fallback'}</strong>.
          </p>

          <article className="mw-content" dangerouslySetInnerHTML={{ __html: article.html }} />
        </main>
      )}
    </div>
  )
}

export default App
