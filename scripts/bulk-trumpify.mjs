import { createClient } from '@supabase/supabase-js'
import { JSDOM } from 'jsdom'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LOG_FILE = 'bulk-process.log'

function log(msg) {
  const timedMsg = `[${new Date().toISOString()}] ${msg}`
  console.log(timedMsg)
  appendFileSync(LOG_FILE, timedMsg + '\n')
}

// 1. Setup Environment
function loadEnv() {
  const files = ['.env.local', '.env']
  for (const file of files) {
    const fullPath = resolve(process.cwd(), file)
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf8')
      content.split(/\r?\n/).forEach(line => {
        const [key, ...parts] = line.trim().split('=')
        if (key && parts.length > 0 && !process.env[key]) {
          process.env[key] = parts.join('=').replace(/^["']|["']$/g, '')
        }
      })
    }
  }
}
loadEnv()

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY // or service role if needed
const xaiApiKey = process.env.XAI_API_KEY
const xaiModel = process.env.XAI_MODEL || 'grok-4-1-fast'

if (!supabaseUrl || !supabaseKey || !xaiApiKey) {
  console.error('❌ Missing credentials in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// 2. Metrics Tracking
const metrics = {
  startTime: Date.now(),
  articlesProcessed: 0,
  articlesSkipped: 0,
  totalTokensInput: 0,
  totalTokensOutput: 0,
  estimatedCost: 0,
}

const COST_PER_1M_INPUT = 0.15
const COST_PER_1M_OUTPUT = 0.60

function updateCost(inputTokens, outputTokens) {
  metrics.totalTokensInput += inputTokens
  metrics.totalTokensOutput += outputTokens
  metrics.estimatedCost += (inputTokens / 1_000_000) * COST_PER_1M_INPUT
  metrics.estimatedCost += (outputTokens / 1_000_000) * COST_PER_1M_OUTPUT
}

// 3. Wikipedia API Helpers
async function getTopArticles(limit = 100) {
  // Get yesterday's date
  const date = new Date()
  date.setDate(date.getDate() - 2)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')

  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${d}`
  console.log(`Fetching top articles from: ${url}`)
  
  const res = await fetch(url, { headers: { 'User-Agent': 'TrumpediaBulkProcessor/1.0 (contact@trumpedia.org)' } })
  const data = await res.json()
  
  if (!data.items?.[0]?.articles) {
    throw new Error('Failed to fetch top articles')
  }

  return data.items[0].articles
    .filter(a => !['Main_Page', 'Special:Search', 'File:', 'Category:', 'Talk:', 'Template:', 'User:'].some(p => a.article.startsWith(p)))
    .slice(0, limit)
    .map(a => a.article)
}

async function fetchArticleHtml(title) {
  const url = new URL(`https://en.wikipedia.org/w/api.php`)
  url.searchParams.set('action', 'parse')
  url.searchParams.set('format', 'json')
  url.searchParams.set('prop', 'text|displaytitle')
  url.searchParams.set('page', title)
  url.searchParams.set('origin', '*')

  const res = await fetch(url.toString())
  const data = await res.json()
  return {
    html: data.parse?.text?.['*'],
    displayTitle: data.parse?.displaytitle || title
  }
}

// 4. Content Processing Logic (Adapted for Node)
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'MATH', 'SVG'])
const SKIP_CLASSES = ['reference', 'reflist', 'mw-editsection', 'navbox', 'toc', 'metadata']

function collectTargets(element) {
  const targets = []
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */)
  let node = walker.nextNode()
  while (node) {
    const parent = node.parentElement
    const text = node.nodeValue?.trim()
    if (text && text.length > 3 && parent && !SKIP_TAGS.has(parent.tagName)) {
      const className = parent.className || ''
      if (!SKIP_CLASSES.some(c => className.includes(c))) {
        targets.push(node)
      }
    }
    node = walker.nextNode()
  }
  return targets
}

async function rewriteBatch(segments) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${xaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: xaiModel,
      messages: [
        { role: 'system', content: 'You are Donald Trump. Rewrite these Wikipedia segments to be Trumpy and confindent. Return ONLY valid JSON: {"segments":["...", "..."]}. Preserve leading/trailing whitespace.' },
        { role: 'user', content: JSON.stringify({ segments }) }
      ],
      response_format: { type: 'json_object' }
    })
  })

  const data = await res.json()
  const content = JSON.parse(data.choices[0].message.content)
  
  // Update cost metrics (rough token estimation: 1 token ~= 4 chars)
  const inputTokens = JSON.stringify(segments).length / 4
  const outputTokens = data.choices[0].message.content.length / 4
  updateCost(inputTokens, outputTokens)

  return content.segments
}

async function processArticle(title) {
  console.log(`[bulk] Starting process for: ${title}`)
  const canonicalUrl = `https://en.wikipedia.org/wiki/${title}`
  
  // Check cache
  const { data: existing } = await supabase.from('articles').select('url').eq('url', canonicalUrl).single()
  if (existing) {
    metrics.articlesSkipped++
    return `Skipped (already exists): ${title}`
  }

  const articleStart = Date.now()
  console.log(`[bulk] Fetching HTML for: ${title}`)
  const { html, displayTitle } = await fetchArticleHtml(title)
  if (!html) return `Failed to fetch: ${title}`

  console.log(`[bulk] Parsing DOM for: ${title}`)
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  const root = dom.window.document.getElementById('root')
  
  // Normalize links
  root.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href')
    if (href?.startsWith('/wiki/')) a.setAttribute('href', `https://en.wikipedia.org${href}`)
  })

  const textNodes = collectTargets(root)
  console.log(`[bulk] Found ${textNodes.length} text segments for: ${title}`)
  const batchSize = 30 
  const batches = []
  for (let i = 0; i < textNodes.length; i += batchSize) {
    batches.push(textNodes.slice(i, i + batchSize))
  }

  console.log(`[bulk] Processing ${batches.length} batches...`)
  
  const CONCURRENCY = 5 // Reduced concurrency to be safer
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY)
    await Promise.all(chunk.map(async (slice) => {
      const segments = slice.map(n => n.nodeValue)
      try {
        const rewritten = await rewriteBatch(segments)
        if (Array.isArray(rewritten)) {
          slice.forEach((node, j) => {
            if (rewritten[j]) node.nodeValue = rewritten[j]
          })
          process.stdout.write(`.`)
        } else {
          process.stdout.write(`?`)
        }
      } catch (e) {
        process.stdout.write(`F`)
        console.error(`\n[error] Batch failed: ${e.message}`)
      }
    }))
  }
  
  console.log(`\n[bulk] All segments processed for: ${title}`)

  // Upsert to Supabase
  console.log(`[bulk] Saving to Supabase: ${title}`)
  const { error } = await supabase.from('articles').upsert({
    url: canonicalUrl,
    title: displayTitle.replace(/<[^>]*>/g, ''),
    html: root.innerHTML,
    rewrite_mode: 'llm',
    source_api_url: canonicalUrl,
    created_at: new Date().toISOString()
  })

  if (error) throw error

  metrics.articlesProcessed++
  const duration = (Date.now() - articleStart) / 1000
  return `✅ Trumpified: ${title} (${duration.toFixed(1)}s)`
}

// 5. Main Execution
async function run() {
  log('🇺🇸 TRUMPEDIA BULK PROCESSOR STARTING 🇺🇸')
  log('----------------------------------------')
  
  try {
    const articles = await getTopArticles(100)
    log(`Found ${articles.length} target articles.`)

    for (const title of articles) {
      try {
        const result = await processArticle(title)
        const elapsed = (Date.now() - metrics.startTime) / 1000
        const avg = elapsed / (metrics.articlesProcessed + metrics.articlesSkipped)
        
        log(`[${metrics.articlesProcessed + metrics.articlesSkipped}/100] ${result}`)
        log(`   Time: ${elapsed.toFixed(0)}s total | Avg: ${avg.toFixed(1)}s/page`)
        log(`   Cost: $${metrics.estimatedCost.toFixed(4)} estimated so far`)
      } catch (err) {
        log(`❌ Error processing ${title}: ${err.message}`)
      }
    }

    log('----------------------------------------')
    log('🇺🇸 BULK PROCESSING COMPLETE 🇺🇸')
    log(`Total Articles: ${metrics.articlesProcessed}`)
    log(`Total Skipped: ${metrics.articlesSkipped}`)
    log(`Total Time: ${((Date.now() - metrics.startTime) / 60000).toFixed(1)} minutes`)
    log(`Final Estimated Cost: $${metrics.estimatedCost.toFixed(2)}`)
  } catch (err) {
    log(`FATAL ERROR: ${err.message}`)
  }
}

run()
