import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import App from '../src/App'
import type { AppServices } from '../src/App'
import type { WikipediaArticle } from '../src/lib/wikipedia'
import { ArticleBody } from '../src/components/ArticleBody'

function installDom(url = 'https://trumpedia.test/') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url, pretendToBeVisual: true })
  for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLAnchorElement', 'HTMLInputElement', 'DOMParser', 'MutationObserver']) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name as keyof typeof dom.window] })
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
  dom.window.scrollTo = () => {}
  dom.window.matchMedia = query => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })
  return dom
}

const seed = installDom()
const { createRoot } = await import('react-dom/client')
seed.window.close()
let dom: JSDOM | undefined
let root: Root | undefined
const alpha = 'https://en.wikipedia.org/wiki/Alpha'
const beta = 'https://en.wikipedia.org/wiki/Beta'
const article = (title: string, overrides: Partial<WikipediaArticle> = {}): WikipediaArticle => ({
  title,
  html: `<p id="${title.toLowerCase()}-text">${title} is ready.</p>`,
  canonicalUrl: `https://en.wikipedia.org/wiki/${title}`,
  sourceApiUrl: 'https://en.wikipedia.org/w/api.php',
  rewriteMode: 'llm',
  status: 'complete',
  progress: 100,
  failedCount: 0,
  ...overrides,
})
const tick = (delay = 0) => new Promise<void>(resolve => setTimeout(resolve, delay))
async function settle(delay = 0) { await act(async () => { await tick(delay) }) }
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type LoadOptions = NonNullable<Parameters<AppServices['loadArticle']>[2]>
function controlledServices(recent = [{ url: beta, title: 'Beta' }]) {
  const calls: { url: string; options: LoadOptions; progress?: (value: number) => void; result: ReturnType<typeof pending<WikipediaArticle>> }[] = []
  let recentLoads = 0
  const services: AppServices = {
    loadArticle: (url, progress, options) => {
      const result = pending<WikipediaArticle>()
      calls.push({ url, options: options || {}, progress, result })
      return result.promise
    },
    loadRecent: async () => { recentLoads++; return recent },
  }
  return { services, calls, recentLoads: () => recentLoads }
}
async function mount(services: AppServices, url = alpha, strict = false) {
  dom = installDom(`https://trumpedia.test/${url ? `?url=${encodeURIComponent(url)}` : ''}`)
  root = createRoot(document.getElementById('root')!)
  await act(async () => root!.render(strict ? <StrictMode><App services={services} /></StrictMode> : <App services={services} />))
  await settle()
}
async function click(element: Element, options: MouseEventInit = {}) {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options })) })
  await settle()
}
async function waitFor(condition: () => boolean) {
  for (let tries = 0; tries < 30 && !condition(); tries++) await settle(5)
  assert.ok(condition(), 'Expected UI state to become visible')
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  dom?.window.close()
  dom = undefined
})

test('zero-approved jobs display repair activity and draft counts without a fake percentage', async () => {
  const fake = controlledServices(); await mount(fake.services)
  await act(async () => fake.calls[0].options.onStatus?.({ status: 'running', jobId: 'saved-job', progress: 0, completed: 0, total: 9, activity: { phase: 'revising', drafted: 2 } }))
  assert.match(document.body.textContent || '', /Reworking passages that need another check/)
  assert.match(document.body.textContent || '', /2 passages drafted and awaiting review/)
  assert.match(document.body.textContent || '', /0 of 9 passages approved/)
  assert.equal(document.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow'), false)
  assert.doesNotMatch(document.querySelector('.progress-text')?.textContent || '', /0%/)
  await click(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Stop loading')!)
  await click(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Continue watching')!)
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[1].options.retry, false, 'Watching again does not buy a new retry run')
})

test('late metadata from a previous article cannot overwrite the next article activity', async () => {
  const fake = controlledServices(); await mount(fake.services)
  await act(async () => { window.history.pushState(null, '', `/?url=${encodeURIComponent(beta)}`); window.dispatchEvent(new window.PopStateEvent('popstate')) })
  await settle()
  await act(async () => {
    fake.calls[1].options.onStatus?.({ status: 'running', progress: 0, total: 3, completed: 0, activity: { phase: 'preparing', drafted: 0 } })
    fake.calls[0].options.onStatus?.({ status: 'running', progress: 0, total: 99, completed: 0, activity: { phase: 'revising', drafted: 50 } })
  })
  assert.match(document.body.textContent || '', /0 of 3 passages approved/)
  assert.doesNotMatch(document.body.textContent || '', /50 passages|99 passages/)
})

test('StrictMode starts one URL generation and aborts it on unmount', async () => {
  const fake = controlledServices()
  await mount(fake.services, alpha, true)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].options.signal?.aborted, false)
  await act(async () => root!.unmount())
  root = undefined
  assert.equal(fake.calls[0].options.signal?.aborted, true)
  await act(async () => {
    fake.calls[0].options.onUpdate?.(article('Alpha'))
    fake.calls[0].result.resolve(article('Alpha'))
  })
  assert.equal(document.getElementById('root')?.childElementCount, 0)
})

test('finished sections appear before completion and survive a watcher error and continued watching', async () => {
  const fake = controlledServices()
  await mount(fake.services)
  const partial = article('Alpha', {
    status: 'running', rewriteMode: 'llm-partial', progress: 50,
    html: '<p id="lead-text">A finished introduction.</p>',
    sections: [
      { id: 'lead', title: 'Introduction', html: '<p id="lead-text">A finished introduction.</p>', complete: true },
      { id: 'history', title: 'History', html: '', complete: false },
    ],
  })
  await act(async () => fake.calls[0].options.onUpdate?.(partial))
  const lead = document.getElementById('lead-text')
  assert.ok(lead)
  assert.match(document.body.textContent || '', /History · waiting for its rewrite/)
  assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '50')
  assert.match(document.body.textContent || '', /AI-generated parody/)
  await act(async () => fake.calls[0].result.reject(new Error('The rewrite service is temporarily busy.')))
  assert.equal(document.getElementById('lead-text'), lead)
  assert.match(document.body.textContent || '', /temporarily busy/)
  const retry = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Continue watching')!
  const historyLength = window.history.length
  await click(retry)
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[1].options.retry, false)
  assert.equal(window.history.length, historyLength)
  assert.equal(document.getElementById('lead-text'), lead)
  const complete = article('Alpha', {
    sections: [partial.sections![0], { id: 'history', title: 'History', html: '<h2 id="History">History</h2><p id="history-text">Now complete.</p>', complete: true }],
    html: `${partial.html}<h2 id="History">History</h2><p id="history-text">Now complete.</p>`,
  })
  await act(async () => fake.calls[1].result.resolve(complete))
  assert.equal(document.getElementById('lead-text'), lead)
  assert.equal(document.getElementById('history-text')?.textContent, 'Now complete.')
  assert.equal(Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Retry unfinished sections'), false)
})

test('paragraphs appear before any section finishes and preserve neighboring text and selection', async () => {
  const fake = controlledServices(); await mount(fake.services)
  const first = '<p data-trumpedia-unit="u00000" id="first-ready">A reviewed paragraph with a <a href="https://en.wikipedia.org/wiki/Beta">working link</a>.</p>'
  const waiting = '<p data-trumpedia-unit="u00001"><span class="paragraph-placeholder" aria-hidden="true"><span></span></span></p>'
  const snapshot = (html: string, complete = false) => article('Alpha', {
    status: complete ? 'complete' : 'running', rewriteMode: complete ? 'llm' : 'llm-partial',
    progress: complete ? 100 : 50, completed: complete ? 2 : 1, total: 2, html,
    sections: [{ id: 'lead', title: 'Introduction', html, complete }],
  })
  await act(async () => fake.calls[0].options.onUpdate?.(snapshot(first + waiting)))
  assert.ok(document.querySelector('h1'))
  assert.match(document.querySelector('.section-rewrite-status')?.textContent || '', /More paragraphs/)
  const paragraph = document.getElementById('first-ready')!
  assert.ok(paragraph)
  assert.match(paragraph.querySelector('a')?.getAttribute('href') || '', /url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FBeta/)
  const text = paragraph.firstChild!
  const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 10)
  window.getSelection()!.addRange(range)
  const selected = window.getSelection()!.toString()
  const observer = new MutationObserver(() => {})
  observer.observe(paragraph, { childList: true, subtree: true, characterData: true, attributes: true })
  const done = snapshot(first + '<p data-trumpedia-unit="u00001" id="second-ready">A second approved paragraph.</p>', true)
  await act(async () => fake.calls[0].result.resolve(done))
  assert.equal(document.getElementById('first-ready'), paragraph)
  assert.equal(paragraph.firstChild, text)
  assert.equal(window.getSelection()!.toString(), selected)
  assert.equal(observer.takeRecords().length, 0)
  assert.equal(document.getElementById('second-ready')?.textContent, 'A second approved paragraph.')
  assert.equal(document.querySelector('.paragraph-placeholder'), null)
  observer.disconnect()
})

test('leaving a request aborts it and its late callbacks cannot replace a newer article', async () => {
  const fake = controlledServices()
  await mount(fake.services)
  await click(document.querySelector('a.brand')!)
  assert.equal(fake.calls[0].options.signal?.aborted, true)
  const recent = Array.from(document.querySelectorAll<HTMLAnchorElement>('a.recent-item')).find(link => link.textContent === 'Beta')!
  await click(recent)
  assert.equal(fake.calls.length, 2)
  assert.equal(new URLSearchParams(window.location.search).get('url'), beta)
  await act(async () => fake.calls[1].options.onUpdate?.(article('Beta', { status: 'running', progress: 40 })))
  await act(async () => {
    fake.calls[0].progress?.(99)
    fake.calls[0].options.onUpdate?.(article('Gamma'))
    fake.calls[0].result.resolve(article('Gamma'))
  })
  assert.equal(document.querySelector('.article-header h1')?.textContent, 'Beta')
  assert.equal(new URLSearchParams(window.location.search).get('url'), beta)
  assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '40')
  await act(async () => fake.calls[1].result.resolve(article('Beta')))
  assert.equal(document.querySelector('.article-header h1')?.textContent, 'Beta')
})

test('article links have shareable app URLs, preserve modified clicks, and follow browser history', async () => {
  const seen: string[] = []
  const alphaPage = article('Alpha', { html: `<p id="alpha-text">Alpha. <a id="next-page" href="${beta}">Beta</a></p><h2 id="History">History</h2>` })
  const services: AppServices = {
    loadArticle: async url => { seen.push(url); return url === alpha ? alphaPage : article('Beta') },
    loadRecent: async () => [],
  }
  await mount(services)
  const link = document.getElementById('next-page') as HTMLAnchorElement
  assert.equal(new URL(link.href).origin, window.location.origin)
  assert.equal(new URL(link.href).searchParams.get('url'), beta)
  let appPreventedModifiedClick = true
  document.addEventListener('click', event => {
    appPreventedModifiedClick = event.defaultPrevented
    event.preventDefault() // Keep JSDOM from attempting native new-tab navigation.
  }, { once: true })
  await click(link, { metaKey: true })
  assert.equal(appPreventedModifiedClick, false)
  assert.deepEqual(seen, [alpha])
  await click(document.querySelector('a[href="#History"]')!)
  assert.equal(window.location.hash, '#History')
  assert.deepEqual(seen, [alpha])
  window.history.back()
  await waitFor(() => window.location.hash === '')
  assert.deepEqual(seen, [alpha])
  await click(document.getElementById('next-page')!)
  assert.equal(new URLSearchParams(window.location.search).get('url'), beta)
  assert.equal(document.querySelector('.article-header h1')?.textContent, 'Beta')
  window.history.back()
  await waitFor(() => document.querySelector('.article-header h1')?.textContent === 'Alpha')
  assert.equal(new URLSearchParams(window.location.search).get('url'), alpha)
  window.history.forward()
  await waitFor(() => document.querySelector('.article-header h1')?.textContent === 'Beta')
  assert.equal(new URLSearchParams(window.location.search).get('url'), beta)
})

test('a server redirect replaces the alias history entry and preserves the latest fragment', async () => {
  const fake = controlledServices()
  await mount(fake.services, `${alpha}#Initial`)
  const historyLength = window.history.length
  window.history.replaceState({ preserved: true }, '', '#Latest')
  await act(async () => fake.calls[0].options.onUpdate?.(article('Beta', { status: 'running', progress: 50 })))
  assert.equal(new URLSearchParams(window.location.search).get('url'), beta)
  assert.equal(window.location.hash, '#Latest')
  assert.equal(window.history.length, historyLength)
  assert.deepEqual(window.history.state, { preserved: true })
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Wikipedia URL"]')?.value, beta)
  assert.equal(document.querySelector('.article-header h1')?.textContent, 'Beta')
  await act(async () => fake.calls[0].result.resolve(article('Beta')))
  assert.equal(window.location.hash, '#Latest')
  assert.equal(window.history.length, historyLength)
})

test('an article without eligible prose clearly shows unchanged source content', async () => {
  const services: AppServices = {
    loadArticle: async () => article('Alpha', {
      rewriteMode: 'heuristic', total: 0, completed: 0,
      opinion: 'This article has no prose available for a parody rewrite.',
      html: '<table class="wikitable"><tbody><tr><td>Original source table</td></tr></tbody></table>',
    }),
    loadRecent: async () => [],
  }
  await mount(services)
  assert.match(document.querySelector('.parody-notice')?.textContent || '', /Original Wikipedia content/)
  assert.match(document.querySelector('.rewrite-notice')?.textContent || '', /No eligible prose was found/)
  assert.match(document.querySelector('.wikitable')?.textContent || '', /Original source table/)
  assert.equal(document.querySelector('.trump-opinion-box'), null)
  assert.equal(Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Retry unfinished sections'), false)
})

test('section updates preserve completed DOM nodes and the reader selection', async () => {
  dom = installDom()
  root = createRoot(document.getElementById('root')!)
  const initial = article('Alpha', {
    sections: [
      { id: 'lead', title: 'Introduction', html: '<p id="stable-lead">A stable introduction.</p>', complete: true },
      { id: 'history', title: 'History', html: '<h2>History</h2><p>First version.</p>', complete: true },
    ],
  })
  const onNavigate = () => {}
  const render = async (tick: number, historyHtml = initial.sections![1].html) => {
    const snapshot = { ...initial, progress: tick, sections: initial.sections!.map((section, index) => ({ ...section, html: index ? historyHtml : section.html })) }
    await act(async () => root!.render(<div data-tick={tick}><ArticleBody article={snapshot} pathname="/" onNavigate={onNavigate} /></div>))
  }
  await render(0)
  const lead = document.getElementById('stable-lead')!
  const range = document.createRange()
  range.setStart(lead.firstChild!, 2)
  range.setEnd(lead.firstChild!, 8)
  window.getSelection()!.addRange(range)
  const selected = window.getSelection()!.toString()
  const observer = new MutationObserver(() => {})
  observer.observe(lead.parentElement!, { childList: true, subtree: true })
  for (let tick = 1; tick <= 5; tick++) await render(tick)
  assert.equal(document.getElementById('stable-lead'), lead)
  assert.equal(window.getSelection()!.toString(), selected)
  assert.equal(observer.takeRecords().length, 0)
  await render(6, '<h2>History</h2><p>Updated independently.</p>')
  assert.equal(document.getElementById('stable-lead'), lead)
  assert.equal(window.getSelection()!.toString(), selected)
  assert.match(document.body.textContent || '', /Updated independently/)
  observer.disconnect()
})

test('patriotic animation ticks do not replace an already readable article', async () => {
  const url = 'https://en.wikipedia.org/wiki/Donald_Trump'
  const services: AppServices = {
    loadArticle: async () => article('Donald Trump', { canonicalUrl: url, html: '<p id="trump-text">Readable text stays put.</p>' }),
    loadRecent: async () => [],
  }
  await mount(services, url)
  const paragraph = document.getElementById('trump-text')!
  const observer = new MutationObserver(() => {})
  observer.observe(paragraph.parentElement!, { childList: true, subtree: true })
  await settle(850)
  assert.ok(document.querySelector('.raining-flag'))
  assert.equal(document.getElementById('trump-text'), paragraph)
  assert.equal(observer.takeRecords().length, 0)
  observer.disconnect()
})

test('stopping a rewrite keeps finished text and lets the reader continue watching the same job', async () => {
  const fake = controlledServices()
  await mount(fake.services)
  await act(async () => fake.calls[0].options.onUpdate?.(article('Alpha', {
    status: 'running', progress: 50,
    sections: [
      { id: 'lead', title: 'Introduction', html: '<p id="saved-lead">Keep reading this.</p>', complete: true },
      { id: 'history', title: 'History', html: '', complete: false },
    ],
  })))
  const lead = document.getElementById('saved-lead')
  await click(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Stop loading')!)
  assert.equal(fake.calls[0].options.signal?.aborted, true)
  assert.equal(document.getElementById('saved-lead'), lead)
  assert.match(document.body.textContent || '', /Loading stopped/)
  assert.match(document.body.textContent || '', /History · not rewritten yet/)
  assert.equal(document.querySelector('.article-section.is-pending')?.getAttribute('aria-busy'), 'false')
  await click(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Continue watching')!)
  assert.equal(fake.calls[1].options.retry, false)
  assert.equal(document.getElementById('saved-lead'), lead)
})

test('a long running article shows saved passages and continues watching after the local deadline', async () => {
  const fake = controlledServices()
  await mount(fake.services)
  await act(async () => fake.calls[0].options.onUpdate?.(article('Alpha', { status: 'running', progress: 70, completed: 100, total: 144 })))
  const lead = document.getElementById('alpha-text')
  assert.match(document.querySelector('.progress-text')?.textContent || '', /100 of 144 passages saved/)
  await act(async () => fake.calls[0].result.reject(new Error('This article is still being prepared. Open it again to continue watching the saved job.')))
  assert.match(document.querySelector('.rewrite-notice')?.textContent || '', /100 of 144 passages saved/)
  await click(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Continue watching')!)
  assert.equal(fake.calls[1].options.retry, false)
  assert.equal(document.getElementById('alpha-text'), lead)
})

test('server time limits are labelled as a pause and only unfinished work is explicitly resumed', async () => {
  const fake = controlledServices()
  await mount(fake.services)
  await act(async () => fake.calls[0].result.resolve(article('Alpha', {
    status: 'partial', rewriteMode: 'llm-partial', completed: 112, total: 144, retryable: true,
    error: 'The generation deadline was reached. Completed sections are saved; retry to finish.',
  })))
  const lead = document.getElementById('alpha-text')
  assert.match(document.querySelector('.rewrite-notice')?.textContent || '', /Generation paused at its time limit/)
  assert.match(document.querySelector('.saved-passages')?.textContent || '', /112 of 144 passages saved/)
  await click(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Resume unfinished')!)
  assert.equal(fake.calls[1].options.retry, true)
  assert.equal(document.getElementById('alpha-text'), lead)
})

test('validation failures keep the usual retry action and permanent failures do not offer futile retries', async () => {
  const fake = controlledServices()
  await mount(fake.services)
  await act(async () => fake.calls[0].result.resolve(article('Alpha', {
    status: 'partial', rewriteMode: 'llm-partial', failedCount: 1, completed: 1, total: 2, retryable: true,
    error: 'Some sections could not be generated. Completed sections are saved.',
  })))
  await click(Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Retry unfinished sections')!)
  assert.equal(fake.calls[1].options.retry, true)
  await act(async () => fake.calls[1].result.resolve(article('Alpha', {
    status: 'partial', rewriteMode: 'llm-partial', failedCount: 1, completed: 1, total: 2, retryable: false,
    error: 'The remaining source cannot be rewritten.',
  })))
  assert.match(document.querySelector('.rewrite-notice')?.textContent || '', /remaining source cannot be rewritten/)
  assert.equal(Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Retry unfinished sections'), false)
})

test('the article rendering boundary removes executable HTML and preserves useful article markup', async () => {
  dom = installDom()
  root = createRoot(document.getElementById('root')!)
  const content = article('Alpha', { html: `<h2 id="Safe-heading">A useful heading</h2>
    <p><a id="safe-link" href="https://example.com/">Reference</a><a id="unsafe-link" href="javascript:alert(1)">Unsafe</a></p>
    <img id="source-image" src="https://upload.wikimedia.org/example.png" onerror="alert(1)">
    <table class="wikitable"><tbody><tr><td>Preserved table</td></tr></tbody></table>
    <script>alert(1)</script><iframe srcdoc="<script>alert(1)</script>"></iframe><form><input autofocus></form>
    <svg onload="alert(1)"><script>alert(1)</script></svg>` })
  await act(async () => root!.render(<ArticleBody article={content} pathname="/" onNavigate={() => {}} />))
  assert.equal(document.querySelector('.article-section-body script, iframe, form, input, svg'), null)
  assert.equal(document.getElementById('source-image')?.hasAttribute('onerror'), false)
  assert.equal(document.getElementById('unsafe-link')?.hasAttribute('href'), false)
  assert.equal(document.getElementById('safe-link')?.getAttribute('href'), 'https://example.com/')
  assert.equal(document.querySelector('.wikitable td')?.textContent, 'Preserved table')
  assert.equal(document.getElementById('Safe-heading')?.textContent, 'A useful heading')
})
