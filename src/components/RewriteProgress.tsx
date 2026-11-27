import { useEffect, useState } from 'react'
import type { ArticleActivity } from '../lib/wikipedia'

const FLAVOR_TEXTS = [
  'Negotiating a better deal with Wikipedia…',
  'Consulting with the best people for this rewrite…',
  'Making this article great again…',
  'Adding some very important gold accents to the prose…',
]

export function RewriteProgress({ progress, queued, activity, completed, total, passages = false, compact = false, onStop }: {
  progress: number; queued?: boolean; activity?: ArticleActivity; completed?: number; total?: number; passages?: boolean; compact?: boolean; onStop: () => void
}) {
  const [flavorIndex, setFlavorIndex] = useState(0)
  useEffect(() => {
    const interval = window.setInterval(() => setFlavorIndex(previous => (previous + 1) % FLAVOR_TEXTS.length), 5000)
    return () => window.clearInterval(interval)
  }, [])
  const phase = activity?.phase === 'source' ? 'Loading the original Wikipedia article.'
    : activity?.phase === 'preparing' ? 'Preparing and checking the rewrite’s point of view.'
    : activity?.phase === 'revising' ? 'Reworking passages that need another check.'
    : activity?.phase === 'reviewing' ? 'Checking drafted passages before publishing them.'
    : activity?.phase === 'writing' ? 'Writing and checking your article.'
    : queued ? 'Your page is in the queue.' : 'Preparing your article. Finished sections will appear here.'
  const starting = progress === 0
  return <div className={compact ? 'rewrite-progress-inline' : 'status-page'}>
    {!compact && <h2>{queued ? 'Preparing your article' : 'Rewriting your article'}</h2>}
    <p className="rewrite-phase" role="status">{phase}</p>
    {Boolean(activity?.drafted) && <p>{activity!.drafted} {activity!.drafted === 1 ? 'passage drafted and awaiting review.' : 'passages drafted and awaiting review.'}</p>}
    {!compact && <p aria-hidden="true">{FLAVOR_TEXTS[flavorIndex]}</p>}
    <div className="progress-container">
      <div className="progress-bar-bg"><div className={`progress-bar-fill${starting ? ' progress-bar-indeterminate' : ''}`} role="progressbar" aria-label="Article rewrite progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={starting ? undefined : progress} aria-valuetext={starting ? phase : undefined} style={{ width: starting ? '30%' : `${progress}%` }} /></div>
      <p className="progress-text">{starting ? total ? `${completed || 0} of ${total} ${passages ? 'passages approved' : 'sections ready'}` : 'Preparing…' : `${progress}%${total ? ` · ${completed || 0} of ${total} ${passages ? 'passages saved' : 'sections ready'}` : ''}`}</p>
    </div>
    <button className="rewrite-secondary-button" type="button" onClick={onStop}>Stop loading</button>
  </div>
}
