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

function warn($: EngineInterface, rateLimits: SessionRateLimit[], warned: Set<string>) {
  for (const c of crossed(rateLimits, warned)) {
    warned.add(c.key)
    $.ui.toast(`${LABEL[c.kind] ?? c.kind} limit passed ${c.threshold}%`)
  }
}

export const register: Register = on => {
  let last: Figures | undefined
  const warned = new Set<string>()
  // Keep a single timer even if session.start fires again
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const show = async () => last && $.ui.status(format(last, await $.clock.now()))

    last = await $.session.usage()
    await show()
    warn($, last.rateLimits, warned)

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
    last = e
    $.ui.status(format(e, await $.clock.now()))
    warn($, e.rateLimits, warned)
    return next(e)
  })
}
