import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCost, readCosts } from '../src/costs.ts'
import { BudgetExceeded, openBudget, reserve, settleBudget, settleReservation } from '../src/budgets.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'evo-costs-')); dirs.push(d); return d }

describe('costs ledger', () => {
  it('pairs start/finish by operationId, drops duplicate eventIds, keeps reconcile separate', () => {
    const d = dir()
    appendCost(d, { kind: 'start', eventId: 'e1', operationId: 'op1', stage: 'generation', provider: 'deepseek-official', model: 'deepseek-v4-flash', startedAtUtc: 'now', attempt: 'a1' })
    appendCost(d, { kind: 'finish', eventId: 'e2', operationId: 'op1', status: 'completed', finishedAtUtc: 'now', durationMs: 10, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null }, usageSource: 'provider', money: null })
    appendCost(d, { kind: 'finish', eventId: 'e2', operationId: 'op1', status: 'completed', finishedAtUtc: 'now', durationMs: 10, usage: null, usageSource: 'unknown', money: null }) // duplicate eventId
    appendCost(d, { kind: 'reconcile', eventId: 'e3', operationId: 'op1', note: 'bill arrived', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null }, usageSource: 'provider', atUtc: 'later' })
    const s = readCosts(d)
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].finishes).toHaveLength(1)
    expect(s.pairs[0].reconciles).toHaveLength(1)
    expect(s.duplicateEventIdsDropped).toBe(1)
    // original file content untouched by reconcile (append-only)
    expect(readFileSync(join(d, 'costs.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(4)
  })

  it('unknown usage stays null in records, never 0', () => {
    const d = dir()
    appendCost(d, { kind: 'start', eventId: 'e1', operationId: 'opU', stage: 'review', provider: 'x', model: 'y', startedAtUtc: 'now' })
    appendCost(d, { kind: 'finish', eventId: 'e2', operationId: 'opU', status: 'unknown', finishedAtUtc: 'now', durationMs: null, usage: null, usageSource: 'unknown', money: null })
    const pair = readCosts(d).pairs[0]
    expect(pair.finishes[0].usage).toBeNull()
    expect(pair.finishes[0].usageSource).toBe('unknown')
  })
})

describe('budgets reserve/settle', () => {
  const base = (d: string, over: Partial<Parameters<typeof openBudget>[1]> = {}) =>
    openBudget(d, { attemptId: 'at1', stage: 'milestone-0-probe', wallClockLimitMs: 60000, callLimit: 2, tokenLimit: 1000, scope: 'test', startedAtUtc: new Date().toISOString(), ...over })

  it('reserves before calls; known usage releases excess down to actual', () => {
    const d = dir(); base(d)
    const r = reserve(d, 'at1', 500)
    expect(settleReservation(d, r, { tokens: 300, calls: 1 })).toBeUndefined()
    const budget = JSON.parse(readFileSync(join(d, 'budgets/at1.json'), 'utf8'))
    expect(budget.reservedTokens).toBe(300) // 500 reserved, 200 excess released
    expect(budget.calls).toBe(1)
  })

  it('unknown usage keeps the reservation; cancelled keeps it too', () => {
    const d = dir(); base(d, { callLimit: 3, tokenLimit: 2000 })
    const r1 = reserve(d, 'at1', 400)
    settleReservation(d, r1, { tokens: null, calls: 1 }) // unknown → keep 400
    const r2 = reserve(d, 'at1', 100)
    settleReservation(d, r2, { tokens: 100, calls: 1 })
    const budget = JSON.parse(readFileSync(join(d, 'budgets/at1.json'), 'utf8'))
    expect(budget.reservedTokens).toBe(500) // unknown r1 keeps 400; known r2 (est==actual) keeps its 100
  })

  it('reservation beyond token limit stops the budget and throws', () => {
    const d = dir(); base(d)
    reserve(d, 'at1', 600)
    expect(() => reserve(d, 'at1', 500)).toThrow(BudgetExceeded)
    const budget = JSON.parse(readFileSync(join(d, 'budgets/at1.json'), 'utf8'))
    expect(budget.status).toBe('stopped')
    expect(budget.stopReason).toBe('budget_exhausted')
    expect(() => reserve(d, 'at1', 1)).toThrow(/stopped/)
  })

  it('an OVERRUN is booked, not kept at the estimate; a breach stops the budget', () => {
    const d = dir(); base(d, { tokenLimit: 500, callLimit: 5 })
    const r = reserve(d, 'at1', 100)
    settleReservation(d, r, { tokens: 900, calls: 1 })
    const budget = JSON.parse(readFileSync(join(d, 'budgets/at1.json'), 'utf8'))
    expect(budget.reservedTokens).toBe(900)   // 100 est + 800 overrun booked
    expect(budget.status).toBe('stopped')     // 900 > 500 → hard gate closed
    expect(budget.stopReason).toBe('budget_exhausted')
    expect(() => reserve(d, 'at1', 1)).toThrow(/stopped/)
  })

  it('a overrun that stays within the limit is booked but does not stop the budget', () => {
    const d = dir(); base(d, { tokenLimit: 2000, callLimit: 5 })
    const r = reserve(d, 'at1', 100)
    settleReservation(d, r, { tokens: 300, calls: 1 })
    const budget = JSON.parse(readFileSync(join(d, 'budgets/at1.json'), 'utf8'))
    expect(budget.reservedTokens).toBe(300)
    expect(budget.status).toBe('open')
  })

  it('call limit stops further reservations; settleBudget lists open reservations', () => {
    const d = dir(); base(d, { callLimit: 1, tokenLimit: 5000 })
    const r = reserve(d, 'at1', 100)
    expect(() => reserve(d, 'at1', 100)).toThrow(/call limit/)
    const summary = settleBudget(d, 'at1')
    expect(summary.calls).toBe(0)
    expect(summary.openReservations).toEqual([r.reservationId])
  })
})
