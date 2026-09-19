/**
 * Budgets: reserve → call → settle. Reservation happens BEFORE a call with a
 * conservative estimate so the final request cannot blow far past the limit;
 * settling with known usage releases the excess, settling with UNKNOWN usage
 * keeps the reservation (never released to zero); cancelled calls keep their
 * reservation (the provider may still bill). Any limit hit records stop and
 * throws BudgetExceeded — no automatic next attempt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type BudgetStage = 'discovery' | 'validation-plan' | 'generation' | 'offline-check' | 'trial-observation' | 'review' | 'milestone-0-probe'

export interface Budget {
  attemptId: string
  stage: BudgetStage
  wallClockLimitMs: number
  callLimit: number
  tokenLimit: number | null
  scope: string
  startedAtUtc: string
  reservedTokens: number
  openReservations: string[]
  calls: number
  status: 'open' | 'stopped'
  stopReason?: 'timeout' | 'budget_exhausted'
  settled?: { calls: number; tokensTotal: number; withinLimits: boolean }
  finishedAtUtc?: string
  note?: string
  [key: string]: unknown
}
export interface Reservation { reservationId: string; attemptId: string; estTokens: number }
export class BudgetExceeded extends Error {
  readonly code = 'BUDGET_EXCEEDED'
  constructor(attemptId: string, reason: string) { super(`budget ${attemptId}: ${reason}`) }
}
export class BudgetNotFound extends Error { readonly code = 'BUDGET_NOT_FOUND' }

function path(dir: string, attemptId: string): string { return join(dir, 'budgets', `${attemptId}.json`) }
function load(dir: string, attemptId: string): Budget {
  const file = path(dir, attemptId)
  if (!existsSync(file)) throw new BudgetNotFound(`no budget ${attemptId}`)
  return JSON.parse(readFileSync(file, 'utf8')) as Budget
}
function store(dir: string, budget: Budget): void {
  mkdirSync(join(dir, 'budgets'), { recursive: true })
  writeFileSync(path(dir, budget.attemptId), `${JSON.stringify(budget, null, 2)}\n`)
}

export function openBudget(dir: string, b: Omit<Budget, 'reservedTokens' | 'openReservations' | 'calls' | 'status'>): void {
  if (existsSync(path(dir, b.attemptId))) throw new Error(`budget ${b.attemptId} already exists; open a new attemptId instead`)
  store(dir, { ...b, reservedTokens: 0, openReservations: [], calls: 0, status: 'open' })
}

/** Wall-clock check + reserve tokens. Over limit → record stop and throw. */
export function reserve(dir: string, attemptId: string, estTokens: number): Reservation {
  const b = load(dir, attemptId)
  if (b.status !== 'open') throw new BudgetExceeded(attemptId, `already stopped (${b.stopReason})`)
  if (Date.now() - Date.parse(b.startedAtUtc) > b.wallClockLimitMs) {
    b.status = 'stopped'; b.stopReason = 'timeout'; store(dir, b)
    throw new BudgetExceeded(attemptId, 'wall-clock limit reached')
  }
  if (b.calls + b.openReservations.length + 1 > b.callLimit) {
    b.status = 'stopped'; b.stopReason = 'budget_exhausted'; store(dir, b)
    throw new BudgetExceeded(attemptId, `call limit ${b.callLimit} reached`)
  }
  if (b.tokenLimit !== null && b.reservedTokens + estTokens > b.tokenLimit) {
    b.status = 'stopped'; b.stopReason = 'budget_exhausted'; store(dir, b)
    throw new BudgetExceeded(attemptId, `token reservation ${b.reservedTokens + estTokens} would exceed limit ${b.tokenLimit}`)
  }
  const reservation: Reservation = { reservationId: randomUUID(), attemptId, estTokens }
  b.reservedTokens += estTokens
  b.openReservations.push(reservation.reservationId)
  store(dir, b)
  return reservation
}

/** Known usage releases the excess reservation; unknown (null) keeps it. */
export function settleReservation(dir: string, r: Reservation, actual: { tokens: number | null; calls: number }): void {
  const b = load(dir, r.attemptId)
  b.openReservations = b.openReservations.filter(id => id !== r.reservationId)
  b.calls += actual.calls
  if (actual.tokens !== null) {
    const excess = Math.max(0, r.estTokens - actual.tokens)
    b.reservedTokens = Math.max(0, b.reservedTokens - excess)
  }
  store(dir, b)
}

export interface BudgetSummary { attemptId: string; calls: number; reservedTokens: number; openReservations: string[]; stopped: boolean }

export function settleBudget(dir: string, attemptId: string): BudgetSummary {
  const b = load(dir, attemptId)
  if (b.status === 'open') { b.status = 'stopped'; b.finishedAtUtc = new Date().toISOString() }
  store(dir, b)
  return { attemptId: b.attemptId, calls: b.calls, reservedTokens: b.reservedTokens, openReservations: [...b.openReservations], stopped: true }
}
