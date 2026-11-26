import { useEffect, useState } from 'react'

const FLAVOR_TEXTS = [
  'Negotiating a better deal with Wikipedia…',
  'Consulting with the best people for this rewrite…',
  'Making this article great again…',
  'Adding some very important gold accents to the prose…',
]

export function RewriteProgress({ progress, queued, completed, total, passages = false, compact = false, onStop }: {
  progress: number; queued?: boolean; completed?: number; total?: number; passages?: boolean; compact?: boolean; onStop: () => void
}) {
  const [flavorIndex, setFlavorIndex] = useState(0)
  useEffect(() => {
    const interval = window.setInterval(() => setFlavorIndex(previous => (previous + 1) % FLAVOR_TEXTS.length), 5000)
    return () => window.clearInterval(interval)
  }, [])
  return <div className={compact ? 'rewrite-progress-inline' : 'status-page'}>
    {!compact && <h2>{queued ? 'Preparing your article' : 'Rewriting your article'}</h2>}
    <p className="rewrite-phase" role="status">{compact ? 'More of this page is on the way.' : queued ? 'Your page is in the queue.' : 'The first finished section will appear here.'}</p>
    {!compact && <p aria-hidden="true">{FLAVOR_TEXTS[flavorIndex]}</p>}
    <div className="progress-container">
      <div className="progress-bar-bg"><div className="progress-bar-fill" role="progressbar" aria-label="Article rewrite progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} style={{ width: `${progress}%` }} /></div>
      <p className="progress-text">{progress}%{total ? ` · ${completed || 0} of ${total} ${passages ? 'passages saved' : 'sections ready'}` : ''}</p>
    </div>
    <button className="rewrite-secondary-button" type="button" onClick={onStop}>Stop loading</button>
  </div>
}
