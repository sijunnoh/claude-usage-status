import type { SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { SEP, crossed, fmtLeft, fmtTokens, format } from './register'

const now = Date.parse('2026-10-15T00:00:00Z')

test('5-hour first, then usage and time left', () => {
  expect(
    format(
      {
        context: { tokens: 84000, window: 200000, percent: 42 },
        rateLimits: [
          { kind: 'seven_day', percentUsed: 8, resetsAt: '2026-10-21T09:00:00Z' },
          { kind: 'five_hour', percentUsed: 14.4, resetsAt: '2026-10-15T03:03:00Z' },
        ],
        cost: { usd: 1.234 },
      },
      now,
    ),
  ).toBe(['14% used 3h 3m', '8% used 6d 9h', '84k/200k 42%', '$1.23'].join(SEP))
})

test('time-left format', () => {
  expect(fmtLeft(42 * 60000)).toBe('42m')
  expect(fmtLeft(-1)).toBe('0m')
})

test('clears when there is nothing to show', () => {
  expect(format({ context: { window: 200000 }, rateLimits: [] }, now)).toBeUndefined()
})

test('each threshold warns once per window', () => {
  const warned = new Set<string>()
  const base = { kind: 'five_hour', percentUsed: 96, resetsAt: '2026-10-15T03:00:00Z' }
  const r = [base]
  const first = crossed(r, warned)
  expect(first.map(c => c.threshold)).toEqual([80, 95])
  first.forEach(c => warned.add(c.key))
  expect(crossed(r, warned)).toEqual([])
  // warns again after a reset
  expect(crossed([{ ...base, resetsAt: '2026-10-15T08:00:00Z' }], warned)).toHaveLength(2)
})

test('token format', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(84_400)).toBe('84k')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtTokens(1_500_000)).toBe('1.5M')
})

test('computes context percent when missing', () => {
  expect(format({ context: { tokens: 50_000, window: 200_000 }, rateLimits: [] }, now)).toBe('50k/200k 25%')
})

test('start → minute boundary → time left ticks down every minute', async ($, on) => {
  // start 20s past a minute boundary
  const clock = mock.clock(on, { now: Date.parse('2026-10-15T00:00:20Z') })
  const statuses: (string | undefined)[] = []
  const usage: SessionUsage = {
    startedAt: 0,
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-15T01:00:00Z' }],
  }
  on('session.usage', () => ({ value: usage }))
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(statuses.at(-1)).toBe('10% used 59m')

  await clock.advance(40_000) // 00:01:00 — minute boundary
  expect(statuses.at(-1)).toBe('10% used 59m')
  await clock.advance(60_000) // 00:02:00
  expect(statuses.at(-1)).toBe('10% used 58m')

  // a turn-end measurement redraws at once
  await $.session.measure({ ...usage, rateLimits: [{ ...usage.rateLimits[0]!, percentUsed: 30 }], changed: ['rateLimits'] })
  expect(statuses.at(-1)).toBe('30% used 58m')
})

test('a second session.start keeps one timer', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let count = 0
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1, resetsAt: new Date(3_600_000).toISOString() }] } }))
  on('ui.status', () => (count++, { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  count = 0
  await clock.advance(60_000)
  expect(count).toBe(1)
})
