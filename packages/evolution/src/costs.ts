/**
 * Cost ledger: append-only JSONL in evolution-private. Unknown usage is null,
 * never 0. Corrections arrive as reconcile records; existing records are never
 * rewritten. Reading pairs start/finish by operationId and drops duplicate
 * eventIds (counting them).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type Stage =
  | 'discovery' | 'validation-plan' | 'generation' | 'offline-check'
  | 'trial-observation' | 'review' | 'milestone-0-probe'

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number | null
  reasoningTokens: number | null
}

export interface CostStart {
  kind: 'start'
  eventId: string
  operationId: string
  experimentId?: string
  candidateId?: string
  trialId?: string
  taskId?: string
  attempt?: string
  stage: Stage
  provider: string
  model: string
  startedAtUtc: string
  budgetRef?: string
  reservationId?: string
}
export interface CostFinish {
  kind: 'finish'
  eventId: string
  operationId: string
  status: 'completed' | 'failed' | 'cancelled' | 'unknown'
  finishedAtUtc: string
  durationMs: number | null
  usage: Usage | null
  usageSource: 'provider' | 'estimate' | 'unknown'
  money: { amount: number; currency: string; priceVersion: string; source: string } | null
  failureReason?: string
}
export interface CostReconcile {
  kind: 'reconcile'
  eventId: string
  operationId?: string
  supersedesEventId?: string
  note: string
  usage: Usage | null
  usageSource: 'provider' | 'estimate' | 'unknown'
  atUtc: string
}
export type CostRecord = CostStart | CostFinish | CostReconcile

export function appendCost(dir: string, rec: CostRecord): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'costs.jsonl'), `${JSON.stringify({ ...rec, eventId: rec.eventId ?? randomUUID() })}\n`)
}

export interface CostPair {
  operationId: string
  start: CostStart | null
  finishes: CostFinish[]
  reconciles: CostReconcile[]
}

export interface CostsSummary {
  pairs: CostPair[]
  duplicateEventIdsDropped: number
  unparsed: number
}

export function readCosts(dir: string): CostsSummary {
  const file = join(dir, 'costs.jsonl')
  if (!existsSync(file)) return { pairs: [], duplicateEventIdsDropped: 0, unparsed: 0 }
  const seen = new Set<string>()
  const byOp = new Map<string, CostPair>()
  let duplicateEventIdsDropped = 0
  let unparsed = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let rec: CostRecord
    try { rec = JSON.parse(line) } catch { unparsed += 1; continue }
    if (seen.has(rec.eventId)) { duplicateEventIdsDropped += 1; continue }
    seen.add(rec.eventId)
    const op = rec.operationId ?? '(reconcile)'
    const pair = byOp.get(op) ?? { operationId: op, start: null, finishes: [], reconciles: [] }
    if (rec.kind === 'start' && !pair.start) pair.start = rec
    else if (rec.kind === 'start') duplicateEventIdsDropped += 1
    if (rec.kind === 'finish') pair.finishes.push(rec)
    if (rec.kind === 'reconcile') pair.reconciles.push(rec)
    byOp.set(op, pair)
  }
  return { pairs: [...byOp.values()], duplicateEventIdsDropped, unparsed }
}
