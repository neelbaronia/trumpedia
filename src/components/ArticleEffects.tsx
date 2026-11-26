import { memo, useEffect, useState } from 'react'

export const GoldenShine = memo(function GoldenShine() {
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let frame = 0
    let x = 0
    let y = 0
    const update = () => {
      frame = 0
      document.documentElement.style.setProperty('--mouse-x', `${x}px`)
      document.documentElement.style.setProperty('--mouse-y', `${y}px`)
    }
    const move = (event: globalThis.MouseEvent) => {
      if (media?.matches) return
      x = event.clientX
      y = event.clientY
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    window.addEventListener('mousemove', move, { passive: true })
    return () => {
      window.removeEventListener('mousemove', move)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])
  return <div className="cursor-shine" aria-hidden="true" />
})

export const PatrioticEffects = memo(function PatrioticEffects() {
  const [flags, setFlags] = useState<{ id: number; left: number; duration: number }[]>([])
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const change = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches)
      if (event.matches) setFlags([])
    }
    media?.addEventListener('change', change)
    return () => media?.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    if (reducedMotion) return
    let id = 0
    const interval = window.setInterval(() => {
      const flag = { id: ++id, left: Math.random() * 100, duration: 3 + Math.random() * 4 }
      setFlags(previous => [...previous.slice(-19), flag])
    }, 800)
    return () => window.clearInterval(interval)
  }, [reducedMotion])
  if (reducedMotion) return null
  return <div className="patriotic-overlay" aria-hidden="true">
    {flags.map(flag => <div key={flag.id} className="raining-flag" style={{ left: `${flag.left}%`, animationDuration: `${flag.duration}s` }}>🇺🇸</div>)}
    <div className="flying-eagle">🦅</div>
  </div>
})
