import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit, Timer } from 'claude-code'

type Figures = {
  context: SessionContextUsage
  rateLimits: SessionRateLimit[]
  cost?: SessionCost
}

// Order: 5-hour → 7-day → others
const ORDER = ['five_hour', 'seven_day']
const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day' }
const rank = (kind: string) => {
  const i = ORDER.indexOf(kind)
  return i === -1 ? ORDER.length : i
}

// Separator — plain spaces can collapse when rendered, so use em spaces
export const SEP = '\u2003·\u2003'

// Tokens: 999 · 84k · 1M · 1.5M
export const fmtTokens = (n: number) => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

// Time left: 6d 9h · 3h 3m · 42m
export const fmtLeft = (ms: number) => {
  const min = Math.max(0, Math.floor(ms / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const fmtLimit = (r: SessionRateLimit, now: number) => {
  const used = `${Math.round(r.percentUsed)}% used`
  if (!ORDER.includes(r.kind)) return `${used} ${r.kind}`
  if (!r.resetsAt) return used
  return `${used} ${fmtLeft(Date.parse(r.resetsAt) - now)}`
}

export const format = ({ context, rateLimits, cost }: Figures, now: number) => {
  const parts = [...rateLimits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(r => fmtLimit(r, now))

  if (context.tokens !== undefined) {
    // Compute it when the engine gives no percent
    const percent = context.percent ?? (context.tokens / context.window) * 100
    const pct = ` ${Math.round(percent)}%`
    parts.push(`${fmtTokens(context.tokens)}/${fmtTokens(context.window)}${pct}`)
  }
  if (cost) parts.push(`$${cost.usd.toFixed(2)}`)

  return parts.length ? parts.join(SEP) : undefined
}

// Warn once when usage crosses these
const THRESHOLDS = [80, 95]

// Newly crossed thresholds — same kind + reset time means the same window
export const crossed = (rateLimits: SessionRateLimit[], warned: Set<string>) =>
  rateLimits.flatMap(r =>
    THRESHOLDS.filter(t => r.percentUsed >= t)
      .map(t => ({ key: `${r.kind}:${r.resetsAt ?? ''}:${t}`, kind: r.kind, threshold: t }))
      .filter(c => !warned.has(c.key)),
  )

// Drop windows whose reset time has passed
export const fresh = (limits: SessionRateLimit[], now: number) =>
  limits.filter(r => !r.resetsAt || Date.parse(r.resetsAt) > now)

// Some responses carry no rate-limit headers; keep the last known window of
// each kind until it resets, and let newer readings replace it
export const mergeLimits = (known: SessionRateLimit[], next: SessionRateLimit[], now: number) => {
  const kinds = new Set(next.map(r => r.kind))
  return fresh([...next, ...known.filter(r => !kinds.has(r.kind))], now)
}

const STORE_KEY = 'rateLimits'

const isLimit = (v: unknown): v is SessionRateLimit =>
  typeof v === 'object' && v !== null &&
  typeof (v as SessionRateLimit).kind === 'string' &&
  typeof (v as SessionRateLimit).percentUsed === 'number'

// Write the windows to the store only when they changed; returns what is stored now
async function persist($: EngineInterface, limits: SessionRateLimit[], saved: string) {
  const json = JSON.stringify(limits)
  if (json !== saved) await $.store.set(STORE_KEY, limits)
  return json
}

function warn($: EngineInterface, rateLimits: SessionRateLimit[], warned: Set<string>) {
  for (const c of crossed(rateLimits, warned)) {
    warned.add(c.key)
    $.ui.toast(`${LABEL[c.kind] ?? c.kind} limit passed ${c.threshold}%`)
  }
}

export const register: Register = on => {
  let last: Figures | undefined
  // Last known limit windows, also kept in $.store so a new session starts with them
  let known: SessionRateLimit[] = []
  let saved = ''
  const warned = new Set<string>()
  // Keep a single timer even if session.start fires again
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const show = async () => {
      if (!last) return
      const now = await $.clock.now()
      $.ui.status(format({ ...last, rateLimits: fresh(last.rateLimits, now) }, now))
    }

    const stored = await $.store.get(STORE_KEY)
    known = Array.isArray(stored) ? stored.filter(isLimit) : []
    saved = JSON.stringify(known)

    const usage = await $.session.usage()
    known = mergeLimits(known, usage.rateLimits, await $.clock.now())
    saved = await persist($, known, saved)
    last = { ...usage, rateLimits: known }
    await show()
    warn($, known, warned)

    // Time left is in minutes — redraw at the next minute boundary, then every minute
    const now = await $.clock.now()
    timer?.cancel()
    timer = $.clock.after(60_000 - (now % 60_000), () => {
      void show()
      timer = $.clock.every(60_000, () => void show())
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    known = mergeLimits(known, e.rateLimits, now)
    saved = await persist($, known, saved)
    last = { ...e, rateLimits: known }
    $.ui.status(format(last, now))
    warn($, known, warned)
    return next(e)
  })
}
