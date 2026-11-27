import crypto from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESC_V,
  EXTRACTOR_V,
  SAFE_METHODS,
  parseSemanticMethods,
  type RequestDescriptor,
  type SafeRequestProjection,
  type SemanticAction,
} from './extract.ts'
import { REDACT_V, sanitizeUrl } from './redact.ts'
import { isPerson, messageAuthority } from './messages.ts'
import type { Entry } from './store.ts'
import { readJson, rfDir } from './system.ts'

export const POLICY_VERSION = 'v1'

export type ExecPolicyMode = 'observe' | 'shadow' | 'enforce'
export type ExecPolicyAction = 'allow' | 'deny' | 'escalate' | 'requireApproval'

export type ExecPolicyDecision = {
  decisionId: string
  mode: ExecPolicyMode
  stage: 1 | 2
  action: ExecPolicyAction
  ruleId: string
  policyVersion: string
  surface: 'browser' | 'api'
  family: string
  reason?: string
  ms: number
  approvalRef?: string
}

export type CompactPolicyDecision = {
  decisionId: string
  mode: ExecPolicyMode
  action: ExecPolicyAction
  ruleId: string
  policyVersion: string
  stage?: 1 | 2
  approvalRef?: string
}

export type ApprovalContext = {
  approved: boolean
  approvalRef?: string
  recentApprovedProposals: Array<{ seq: number; text: string; by: string; at: string }>
}

export type ExecPolicyConfig = {
  mode: ExecPolicyMode
  deadlineMs: number
  maxConcurrentShadow: number
  maxShadowQueue: number
  configError?: string
}

export type TriageInput = {
  safe: SafeRequestProjection
  stage1: ExecPolicyDecision
  intent?: { run: number; series?: string; taskSummary?: string }
  recentApprovedProposals: ApprovalContext['recentApprovedProposals']
  cdpCursor?: number
  httpCursor?: number
}

export type TriageVerdict = {
  action: 'allow' | 'deny' | 'escalate' | 'requireApproval'
  ruleId?: string
  reason?: string
}

export type TriageHook = (input: TriageInput, ctx: { decisionId: string; signal: AbortSignal; deadlineMs: number }) => Promise<TriageVerdict> | TriageVerdict

export type EvaluateOptions = {
  mode?: ExecPolicyMode
  log?: readonly Entry[]
  uptoSeq?: number
  epoch?: number
  owner?: string
  workspace?: string
  intent?: { run: number; series?: string; taskSummary?: string }
  signal?: AbortSignal
  deadlineMs?: number
  triageHook?: TriageHook
  onShadowDecision?: (decision: ExecPolicyDecision) => void
}

const VALID_MODES = new Set<ExecPolicyMode>(['observe', 'shadow', 'enforce'])
const STAGE2_HOST_RULE_IDS: Record<ExecPolicyAction, string> = {
  allow: 'stage2_allow',
  deny: 'stage2_deny',
  escalate: 'stage2_escalate',
  requireApproval: 'stage2_require_approval',
}

export function loadExecPolicyConfig(): ExecPolicyConfig {
  let fileCfg: Record<string, unknown> = {}
  let configError: string | undefined
  const baseDir = rfDir()
  const cfgPath = baseDir ? join(baseDir, 'execpolicy.json') : ''
  if (cfgPath && existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        configError = 'execpolicy.json must be a JSON object'
      } else {
        fileCfg = parsed as Record<string, unknown>
      }
    } catch {
      configError = 'execpolicy.json could not be parsed'
    }
  }

  const envRaw = process.env.RF_EXECPOLICY_MODE
  const envMode = envRaw !== undefined ? envRaw.trim().toLowerCase() : undefined
  const fileMode = fileCfg.mode !== undefined ? (typeof fileCfg.mode === 'string' ? fileCfg.mode.trim().toLowerCase() : '__invalid__') : undefined
  const rawMode = envMode !== undefined && envMode !== '' ? envMode : (fileMode !== undefined ? fileMode : 'observe')

  let mode: ExecPolicyMode = 'observe'
  if (configError) {
    // Fail closed on corrupt/unreadable configured policy file!
    mode = 'enforce'
  } else if (!VALID_MODES.has(rawMode as ExecPolicyMode)) {
    // Fail closed on unrecognized configured mode!
    mode = 'enforce'
    configError = `invalid execpolicy mode: ${rawMode}`
  } else {
    mode = rawMode as ExecPolicyMode
  }

  const deadlineMs = typeof fileCfg.deadlineMs === 'number' && Number.isFinite(fileCfg.deadlineMs) && fileCfg.deadlineMs > 0
    ? Math.floor(fileCfg.deadlineMs)
    : 20_000
  const maxConcurrentShadow = typeof fileCfg.maxConcurrentShadow === 'number' && fileCfg.maxConcurrentShadow > 0
    ? Math.floor(fileCfg.maxConcurrentShadow)
    : 4
  const maxShadowQueue = typeof fileCfg.maxShadowQueue === 'number' && fileCfg.maxShadowQueue > 0
    ? Math.floor(fileCfg.maxShadowQueue)
    : 64
  return { mode, deadlineMs, maxConcurrentShadow, maxShadowQueue, ...(configError && { configError }) }
}

// Inspects an instance's log.jsonl up to `uptoSeq` (default full log) to determine whether the current authority
// epoch has a human sign-off (`op === 'signoff' && approved !== false`).
export function findCurrentEpochApproval(
  log: readonly Entry[] | undefined,
  opts?: { uptoSeq?: number; epoch?: number; owner?: string; workspace?: string },
): ApprovalContext {
  if (!log || !log.length) return { approved: false, recentApprovedProposals: [] }
  const upto = opts?.uptoSeq ?? (log.at(-1)?.seq ?? log.length)
  const slice = log.filter(e => e.seq <= upto)
  if (!slice.length) return { approved: false, recentApprovedProposals: [] }

  // Find latest duplicate or authority boundary in this slice
  let boundarySeq = 0
  let activeEpoch = opts?.epoch
  let activeOwner = opts?.owner
  for (const e of slice) {
    if (e.op === 'duplicate') {
      boundarySeq = Math.max(boundarySeq, e.seq)
    } else if (e.op === 'authority') {
      boundarySeq = Math.max(boundarySeq, e.seq)
      if (typeof e.epoch === 'number') activeEpoch = e.epoch
      if (typeof e.owner === 'string') activeOwner = e.owner
    }
  }
  // If an explicit epoch was provided and there's a run/authority with a matching epoch, enforce it.
  const proposals: ApprovalContext['recentApprovedProposals'] = []
  let latestApprovalRef: string | undefined

  for (const e of slice) {
    if (e.seq <= boundarySeq) continue
    if (e.op !== 'signoff' || e.approved === false || !isPerson(e)) continue
    const auth = messageAuthority(slice, e, upto)
    if (auth.stale) continue
    if (activeEpoch !== undefined && auth.epoch !== undefined && auth.epoch !== activeEpoch) continue
    if (activeOwner !== undefined && auth.owner !== undefined && auth.owner !== activeOwner) continue
    // If signoff targets a proposal comment cN, ensure the proposal itself wasn't from before the boundary or stale
    let proposalText = typeof e.text === 'string' ? e.text : ''
    if (typeof e.on === 'number') {
      const ask = slice.find(x => x.seq === e.on)
      if (ask) {
        if (ask.seq <= boundarySeq) continue
        const askAuth = messageAuthority(slice, ask, upto)
        if (askAuth.stale) continue
        if (activeEpoch !== undefined && askAuth.epoch !== undefined && askAuth.epoch !== activeEpoch) continue
        if (typeof ask.text === 'string' && ask.text) proposalText = ask.text
      }
    }
    const ref = typeof e.on === 'number' ? `c${e.on}` : `seq:${e.seq}`
    latestApprovalRef = ref
    proposals.push({
      seq: e.seq,
      text: proposalText.slice(0, 256),
      by: e.by,
      at: e.at,
    })
  }

  return {
    approved: latestApprovalRef !== undefined,
    ...(latestApprovalRef && { approvalRef: latestApprovalRef }),
    recentApprovedProposals: proposals.slice(-5),
  }
}

function primaryFamily(safe: SafeRequestProjection): string {
  return safe.actions[0]?.family ?? (safe.surface === 'api' ? 'api' : 'rest')
}

function hasOverrideDowngrade(safe: SafeRequestProjection): boolean {
  if (SAFE_METHODS.has(safe.method)) return false
  if (!safe.hdr) return false
  for (const k of ['x-http-method', 'x-http-method-override', 'x-method-override']) {
    const val = safe.hdr[k]
    if (!val) continue
    const verbs = val.split(',').map(v => v.trim().toUpperCase()).filter(Boolean)
    if (verbs.some(v => SAFE_METHODS.has(v))) return true
  }
  return false
}

function hasInvalidOverride(safe: SafeRequestProjection): boolean {
  if (!safe.hdr) return false
  for (const k of ['x-http-method', 'x-http-method-override', 'x-method-override']) {
    const val = safe.hdr[k]
    if (val === undefined) continue
    const parts = val.split(',').map(v => v.trim().toUpperCase())
    if (!parts.length || parts.some(p => !/^[A-Z]{3,16}$/.test(p))) return true
  }
  return false
}

export function evaluateStage1(
  safe: SafeRequestProjection,
  mode: ExecPolicyMode,
  approval: ApprovalContext,
  decisionId = crypto.randomUUID(),
): ExecPolicyDecision {
  const start = performance.now()
  const family = primaryFamily(safe)
  const make = (action: ExecPolicyAction, ruleId: string, reason?: string, approvalRef?: string): ExecPolicyDecision => ({
    decisionId,
    mode,
    stage: 1,
    action,
    ruleId,
    policyVersion: POLICY_VERSION,
    surface: safe.surface,
    family,
    ...(reason && { reason }),
    ms: +(performance.now() - start).toFixed(3),
    ...(approvalRef && { approvalRef }),
  })

  // 1. Method-override conflicts, invalid tokens, and write->read downgrade evasion attempts (always deny)
  if (safe.hdrConflict || hasInvalidOverride(safe)) {
    return make('deny', 'method_override_conflict', 'Conflicting or invalid HTTP method override header')
  }
  if (hasOverrideDowngrade(safe)) {
    return make('deny', 'method_override_downgrade', 'HTTP method override attempted to downgrade write to safe verb')
  }

  // 2. Method-override escalation (safe wire verb escalated to unsafe verb)
  const escalatedFromSafe = SAFE_METHODS.has(safe.method) && !SAFE_METHODS.has(safe.effectiveMethod)

  // 3. Action-specific deterministic rules
  for (const act of safe.actions) {
    // Databricks SQL rules
    if (act.family === 'databricks' && act.op.startsWith('databricks:sql_')) {
      const sqlClass = act.details?.sqlClass
      const stmts = Array.isArray(act.details?.statements) ? (act.details!.statements as string[]) : []
      if (stmts.some(s => s === 'DROP' || s === 'TRUNCATE')) {
        return make('deny', 'databricks_destructive_ddl', `Destructive SQL DDL (${stmts.join(',')}) denied`)
      }
      if (sqlClass === 'ddl' || stmts.includes('DELETE')) {
        return approval.approved
          ? make('allow', 'databricks_write_approved', 'Approved by current-epoch human signoff', approval.approvalRef)
          : make('requireApproval', 'databricks_ddl_or_delete', `SQL ${stmts.join(',')} requires human approval`)
      }
      if (sqlClass === 'read' && !safe.dupKeys && safe.bodyComplete && safe.decodeComplete) {
        return make('allow', 'allow_databricks_sql_read')
      }
      if (sqlClass === 'unknown') {
        return make('escalate', 'databricks_sql_unknown', 'Unclassified Databricks SQL statement')
      }
    }

    // Microsoft Graph mail send / reply / forward
    if (act.family === 'graph' && ['graph:sendMail', 'graph:send', 'graph:reply', 'graph:replyAll', 'graph:forward'].includes(act.op)) {
      return approval.approved
        ? make('allow', 'graph_send_mail_approved', 'Approved by current-epoch human signoff', approval.approvalRef)
        : make('requireApproval', 'graph_send_mail', 'Outbound email send requires current-epoch human approval')
    }

    // Microsoft Graph file delete
    if (act.family === 'graph' && act.op === 'graph:file_delete') {
      return approval.approved
        ? make('allow', 'graph_file_delete_approved', 'Approved by current-epoch human signoff', approval.approvalRef)
        : make('requireApproval', 'graph_file_delete', 'File deletion requires current-epoch human approval')
    }

    // Unguarded file overwrite (PUT .../content without If-Match ETag)
    if (act.family === 'graph' && act.op === 'graph:file_write' && act.details?.hasIfMatch === false) {
      return make('escalate', 'unguarded_overwrite_no_if_match', 'File content overwrite without If-Match ETag')
    }

    // E1 AIS write (formServiceAction: 'W' / action: 'W')
    if (act.family === 'e1-ais') {
      const a = typeof act.details?.action === 'string' ? act.details.action.toUpperCase() : ''
      if (a === 'W' || act.op.endsWith(':W')) {
        return approval.approved
          ? make('allow', 'e1_ais_write_approved', 'Approved by current-epoch human signoff', approval.approvalRef)
          : make('requireApproval', 'e1_ais_write', 'JD Edwards E1 AIS write action requires human approval')
      }
    }

    // SharePoint DELETE / MERGE / opaque batch / unguarded PUT (check BOTH wire method and effectiveMethod!)
    if (act.family === 'sharepoint') {
      if (act.coverage === 'opaque-batch') {
        return make('escalate', 'sharepoint_opaque_batch', 'Opaque SharePoint $batch write requires review')
      }
      if (safe.method === 'DELETE' || safe.method === 'MERGE' || safe.effectiveMethod === 'DELETE' || safe.effectiveMethod === 'MERGE') {
        return approval.approved
          ? make('allow', 'sharepoint_destructive_approved', 'Approved by current-epoch human signoff', approval.approvalRef)
          : make('requireApproval', 'sharepoint_destructive_write', `SharePoint ${safe.method === 'DELETE' || safe.effectiveMethod === 'DELETE' ? 'DELETE' : 'MERGE'} requires human approval`)
      }
      if ((safe.method === 'PUT' || safe.effectiveMethod === 'PUT') && act.details?.hasIfMatch === false) {
        return make('escalate', 'unguarded_overwrite_no_if_match', 'SharePoint PUT without If-Match ETag')
      }
    }

    // GraphQL persisted / mixed / mutation
    if (act.family === 'graphql') {
      if (act.coverage === 'persisted-query-unknown' || safe.graphqlOp === 'persisted') {
        return make('escalate', 'graphql_persisted_unknown', 'Persisted GraphQL query cannot be verified as read-only')
      }
      if (safe.graphqlOp === 'mixed') {
        return make('escalate', 'graphql_mixed_operation', 'Ambiguous or mixed GraphQL operation')
      }
      if (safe.graphqlOp === 'query' && !safe.dupKeys && safe.bodyComplete && safe.decodeComplete && !escalatedFromSafe) {
        return make('allow', 'allow_graphql_query')
      }
    }
  }

  // 4. Generic DELETE across any surface (apply stricter rule to BOTH wire method and effectiveMethod so DELETE + override: POST cannot bypass!)
  if (safe.method === 'DELETE' || safe.effectiveMethod === 'DELETE') {
    return approval.approved
      ? make('allow', 'http_delete_approved', 'Approved by current-epoch human signoff', approval.approvalRef)
      : make('requireApproval', 'http_delete', 'HTTP DELETE requires current-epoch human approval')
  }

  // 5. Method-override escalation from safe wire verb
  if (escalatedFromSafe) {
    return make('escalate', 'method_override_escalation', `Safe wire verb ${safe.method} escalated to ${safe.effectiveMethod}`)
  }

  // 6. Integrity/completeness escalations on writes
  if (safe.isWrite) {
    if (safe.dupKeys) {
      return make('escalate', 'write_duplicate_json_keys', 'Write payload contained duplicate JSON keys')
    }
    if (safe.completeness.transport === 'not-read' && safe.declaredBytes !== 0) {
      return make('escalate', 'write_body_not_inspected', 'Body-bearing write was not inspected before dispatch')
    }
    if (safe.completeness.transport === 'truncated' || (safe.completeness.decode !== 'complete' && safe.completeness.decode !== 'none')) {
      return make('escalate', 'write_incomplete_body', 'Write body was truncated or failed decoding')
    }
    if (safe.actions.some(a => a.coverage === 'opaque-batch' || a.coverage === 'persisted-query-unknown' || a.coverage === 'unknown')) {
      return make('escalate', 'write_opaque_payload', 'Write payload semantics could not be extracted')
    }
    return make('allow', 'allow_write_observed')
  }

  // 7. Pure read
  return make('allow', 'allow_read')
}

export function compactDecision(d: ExecPolicyDecision): CompactPolicyDecision {
  return {
    decisionId: d.decisionId,
    mode: d.mode,
    action: d.action,
    ruleId: d.ruleId,
    policyVersion: d.policyVersion,
    ...(d.stage === 2 && { stage: 2 as const }),
    ...(d.approvalRef && { approvalRef: d.approvalRef }),
  }
}

// Pluggable Stage-1 + Stage-2 ExecPolicy Engine with bounded async shadow execution and fail-closed enforce mode.
export class ExecPolicyEngine {
  private triageHook?: TriageHook
  private shadowActive = 0
  private shadowQueue: Array<() => Promise<void>> = []
  shadowDropped = 0
  shadowCompleted = 0
  shadowErrors = 0

  constructor(triageHook?: TriageHook) {
    this.triageHook = triageHook
  }

  setTriageHook(hook?: TriageHook) {
    this.triageHook = hook
  }

  get shadowPending(): number {
    return this.shadowActive + this.shadowQueue.length
  }

  private enqueueShadow(job: () => Promise<void>, maxConcurrent: number, maxQueue: number): boolean {
    if (this.shadowActive < maxConcurrent) {
      this.runShadow(job, maxConcurrent)
      return true
    }
    if (this.shadowQueue.length >= maxQueue) {
      this.shadowDropped++
      return false
    }
    this.shadowQueue.push(job)
    return true
  }

  private runShadow(job: () => Promise<void>, maxConcurrent: number) {
    this.shadowActive++
    void Promise.resolve()
      .then(job)
      .then(() => { this.shadowCompleted++ })
      .catch(() => { this.shadowErrors++ })
      .finally(() => {
        this.shadowActive--
        const next = this.shadowQueue.shift()
        if (next && this.shadowActive < maxConcurrent) this.runShadow(next, maxConcurrent)
      })
  }

  async evaluate(descriptor: RequestDescriptor, opts: EvaluateOptions = {}): Promise<ExecPolicyDecision> {
    const cfg = loadExecPolicyConfig()
    const decisionId = crypto.randomUUID()
    const start = performance.now()
    const family = primaryFamily(descriptor.safe)

    // Fail closed if policy configuration is invalid/corrupt (unless caller explicitly overrides mode for offline replay/tests).
    if (cfg.configError && opts.mode === undefined) {
      return {
        decisionId,
        mode: 'enforce',
        stage: 1,
        action: 'deny',
        ruleId: 'policy_config_error',
        policyVersion: POLICY_VERSION,
        surface: descriptor.safe.surface,
        family,
        ms: +(performance.now() - start).toFixed(3),
      }
    }

    const mode = opts.mode ?? cfg.mode

    let approval: ApprovalContext
    let stage1: ExecPolicyDecision
    try {
      approval = findCurrentEpochApproval(opts.log, {
        uptoSeq: opts.uptoSeq,
        epoch: opts.epoch,
        owner: opts.owner,
        workspace: opts.workspace,
      })
      stage1 = evaluateStage1(descriptor.safe, mode, approval, decisionId)
    } catch {
      return {
        decisionId,
        mode,
        stage: 1,
        action: mode === 'enforce' ? 'deny' : 'escalate',
        ruleId: 'policy_error',
        policyVersion: POLICY_VERSION,
        surface: descriptor.safe.surface,
        family,
        ms: +(performance.now() - start).toFixed(3),
      }
    }

    const hook = opts.triageHook ?? this.triageHook
    const deadlineMs = opts.deadlineMs ?? cfg.deadlineMs

    // Stage-2 never overrides Stage-1 deny or missing human approval!
    const needsTriage = Boolean(hook) && stage1.action === 'escalate'

    if (mode === 'observe') {
      return stage1
    }

    if (mode === 'shadow') {
      if (needsTriage && hook) {
        // Strictly async zero-latency shadow triage: NEVER blocks or delays the live request!
        const safeCopy: SafeRequestProjection = structuredClone(descriptor.safe)
        const triageInput: TriageInput = {
          safe: safeCopy,
          stage1,
          ...(opts.intent && { intent: opts.intent }),
          recentApprovedProposals: approval.recentApprovedProposals,
          ...(safeCopy.cdpCursor !== undefined && { cdpCursor: safeCopy.cdpCursor }),
          ...(safeCopy.httpCursor !== undefined && { httpCursor: safeCopy.httpCursor }),
        }
        this.enqueueShadow(async () => {
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), deadlineMs)
          timer.unref?.()
          try {
            const verdict = await hook(triageInput, { decisionId, signal: ac.signal, deadlineMs })
            // Stage 2 cannot override a Stage-1 deny or requireApproval (already guarded above, double-checked here)
            const finalAction: ExecPolicyAction = ['allow', 'deny', 'escalate', 'requireApproval'].includes(verdict?.action) ? verdict.action : 'deny'
            const shadowDecision: ExecPolicyDecision = {
              decisionId,
              mode: 'shadow',
              stage: 2,
              action: finalAction,
              ruleId: STAGE2_HOST_RULE_IDS[finalAction],
              policyVersion: POLICY_VERSION,
              surface: safeCopy.surface,
              family,
              ...(verdict.reason && { reason: verdict.reason }),
              ms: +(performance.now() - start).toFixed(3),
            }
            opts.onShadowDecision?.(shadowDecision)
          } finally {
            clearTimeout(timer)
          }
        }, cfg.maxConcurrentShadow, cfg.maxShadowQueue)
      }
      return stage1
    }

    // mode === 'enforce'
    if (stage1.action === 'deny' || stage1.action === 'allow' || stage1.action === 'requireApproval') {
      return stage1
    }

    // stage1.action === 'escalate' in enforce mode
    if (!hook) {
      // Fail closed when escalated without a Stage-2 triage hook
      return {
        ...stage1,
        action: 'deny',
        ruleId: stage1.ruleId,
        ms: +(performance.now() - start).toFixed(3),
      }
    }

    const safeCopy: SafeRequestProjection = structuredClone(descriptor.safe)
    const triageInput: TriageInput = {
      safe: safeCopy,
      stage1,
      ...(opts.intent && { intent: opts.intent }),
      recentApprovedProposals: approval.recentApprovedProposals,
      ...(safeCopy.cdpCursor !== undefined && { cdpCursor: safeCopy.cdpCursor }),
      ...(safeCopy.httpCursor !== undefined && { httpCursor: safeCopy.httpCursor }),
    }

    const ac = new AbortController()
    const onParentAbort = () => ac.abort()
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort()
      else opts.signal.addEventListener('abort', onParentAbort, { once: true })
    }

    let timer: NodeJS.Timeout | undefined
    try {
      const verdict = await Promise.race<TriageVerdict>([
        Promise.resolve().then(() => hook(triageInput, { decisionId, signal: ac.signal, deadlineMs })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort()
            reject(new Error('policy_timeout'))
          }, deadlineMs)
          timer.unref?.()
        }),
      ])
      if (ac.signal.aborted) throw new Error('policy_aborted')
      if (!verdict || !['allow', 'deny', 'escalate', 'requireApproval'].includes(verdict.action)) {
        throw new Error('policy_invalid_verdict')
      }
      return {
        decisionId,
        mode: 'enforce',
        stage: 2,
        action: verdict.action,
        ruleId: STAGE2_HOST_RULE_IDS[verdict.action],
        policyVersion: POLICY_VERSION,
        surface: safeCopy.surface,
        family,
        ...(verdict.reason && { reason: verdict.reason }),
        ms: +(performance.now() - start).toFixed(3),
      }
    } catch {
      return {
        decisionId,
        mode: 'enforce',
        stage: 2,
        action: 'deny',
        ruleId: 'policy_error',
        policyVersion: POLICY_VERSION,
        surface: safeCopy.surface,
        family,
        ms: +(performance.now() - start).toFixed(3),
      }
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onParentAbort)
    }
  }
}

export const defaultExecPolicy = new ExecPolicyEngine()

// ---- Offline deterministic replay over saved instDir/log.jsonl + instDir/browser/*.jsonl ----

export type ReplayVerdict = ExecPolicyAction | 'insufficient_evidence'

export type ReplayRecordResult = {
  source: 'api' | 'browser'
  file: string
  index: number
  t: string
  method: string
  effectiveMethod: string
  url: string
  verdict: ReplayVerdict
  ruleId: string
  recordedAction?: ExecPolicyAction
  recordedRuleId?: string
  agreed: boolean | null
  insufficientReason?: string
}

export type ReplaySummary = {
  instDir: string
  total: number
  apiCount: number
  browserCount: number
  counts: Record<ReplayVerdict, number>
  agreements: number
  disagreements: number
  results: ReplayRecordResult[]
}

function readJsonlSafe(filePath: string): any[] {
  if (!existsSync(filePath)) return []
  const raw = readFileSync(filePath, 'utf8')
  const out: any[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { out.push(JSON.parse(trimmed)) } catch {}
  }
  return out
}

function reconstructSafeFromApiCall(e: Entry, seq: number): { safe?: SafeRequestProjection; insufficientReason?: string } {
  const name = typeof e.name === 'string' ? e.name : 'unknown'
  const method = typeof e.method === 'string' ? e.method.toUpperCase() : 'GET'
  const effectiveMethod = typeof e.effectiveMethod === 'string' ? e.effectiveMethod.toUpperCase() : method
  const pathStr = typeof e.path === 'string' ? e.path : '/'
  const actions = Array.isArray(e.actions) ? (e.actions as SemanticAction[]) : undefined
  if (!actions) {
    if (SAFE_METHODS.has(method) && SAFE_METHODS.has(effectiveMethod)) {
      const san = sanitizeUrl(pathStr.startsWith('http') ? pathStr : `https://${name}${pathStr.startsWith('/') ? '' : '/'}${pathStr}`, { projection: 'semantic' })
      return {
        safe: {
          descV: DESC_V,
          redactV: REDACT_V,
          extractorV: EXTRACTOR_V,
          surface: 'api',
          target: { connection: name },
          seq,
          t: e.at,
          kind: 'http',
          scheme: san.scheme,
          authority: san.authority,
          path: san.path,
          url: san.url,
          method,
          effectiveMethod,
          methodSource: 'wire',
          isWrite: false,
          prefixBytes: 0,
          bodyComplete: true,
          decodeComplete: true,
          completeness: { transport: 'not-read', decode: 'none', extract: 'none' },
          actions: [],
        },
      }
    }
    return { insufficientReason: 'legacy_api_call_without_actions' }
  }

  const san = sanitizeUrl(pathStr.startsWith('http') ? pathStr : `https://${name}${pathStr.startsWith('/') ? '' : '/'}${pathStr}`, { projection: 'semantic' })
  const isWrite = typeof e.isWrite === 'boolean' ? e.isWrite : (!SAFE_METHODS.has(method) || !SAFE_METHODS.has(effectiveMethod))
  const storedComp = e.completeness as SafeRequestProjection['completeness'] | undefined
  if (isWrite && !storedComp) {
    return { insufficientReason: 'api_call_missing_completeness' }
  }
  const comp: SafeRequestProjection['completeness'] = storedComp ?? { transport: 'not-read', decode: 'none', extract: 'complete' }
  return {
    safe: {
      descV: DESC_V,
      redactV: REDACT_V,
      extractorV: EXTRACTOR_V,
      surface: 'api',
      target: { connection: name },
      seq,
      t: e.at,
      kind: 'http',
      scheme: san.scheme,
      authority: san.authority,
      path: san.path,
      url: san.url,
      method,
      effectiveMethod,
      methodSource: 'wire',
      isWrite,
      prefixBytes: 0,
      bodyComplete: comp.transport === 'complete',
      decodeComplete: comp.decode === 'complete' || comp.decode === 'none',
      completeness: comp,
      actions,
      ...(e.bodyShape && typeof e.bodyShape === 'object' ? { bodyShape: e.bodyShape as Record<string, string> } : {}),
      ...(e.hdr && typeof e.hdr === 'object' ? { hdr: e.hdr as Record<string, string> } : {}),
      ...(e.hdrConflict ? { hdrConflict: true as const } : {}),
      ...(e.dupKeys ? { dupKeys: true as const } : {}),
      ...(typeof e.graphqlOp === 'string' ? { graphqlOp: e.graphqlOp as SafeRequestProjection['graphqlOp'] } : {}),
    },
  }
}

export async function replayExecPolicy(
  instDir: string,
  opts?: { triageHook?: TriageHook; mode?: ExecPolicyMode },
): Promise<ReplaySummary> {
  const mode = opts?.mode ?? 'observe'
  const engine = new ExecPolicyEngine(opts?.triageHook)
  const instLog = readJsonlSafe(join(instDir, 'log.jsonl')) as Entry[]
  const results: ReplayRecordResult[] = []
  const counts: Record<ReplayVerdict, number> = {
    allow: 0,
    deny: 0,
    escalate: 0,
    requireApproval: 0,
    insufficient_evidence: 0,
  }
  let apiCount = 0
  let browserCount = 0
  let agreements = 0
  let disagreements = 0

  // 1. Replay API proxy `call` entries from instDir/log.jsonl
  for (let i = 0; i < instLog.length; i++) {
    const e = instLog[i]
    if (e.op !== 'call') continue
    if (e.name === 'openrouter' || e.name === 'exa') continue
    apiCount++
    const recorded = e.policy as CompactPolicyDecision | undefined
    const recon = reconstructSafeFromApiCall(e, e.seq)
    if (!recon.safe) {
      counts.insufficient_evidence++
      results.push({
        source: 'api',
        file: 'log.jsonl',
        index: e.seq,
        t: e.at,
        method: String(e.method ?? 'GET'),
        effectiveMethod: String(e.effectiveMethod ?? e.method ?? 'GET'),
        url: String(e.path ?? ''),
        verdict: 'insufficient_evidence',
        ruleId: 'insufficient_evidence',
        recordedAction: recorded?.action,
        recordedRuleId: recorded?.ruleId,
        agreed: null,
        insufficientReason: recon.insufficientReason,
      })
      continue
    }

    // Bound approval lookup strictly to entries BEFORE dispatch (`sent - 1` for writes, else `seq - 1`) so mid-flight signoffs cannot retroactively approve!
    const uptoSeq = typeof e.sent === 'number' ? Math.max(0, e.sent - 1) : Math.max(0, e.seq - 1)
    const decision = await engine.evaluate({ safe: recon.safe }, { mode, log: instLog, uptoSeq })
    const agreed = recorded ? decision.action === recorded.action : null
    if (agreed === true) agreements++
    else if (agreed === false) disagreements++
    counts[decision.action]++
    results.push({
      source: 'api',
      file: 'log.jsonl',
      index: e.seq,
      t: e.at,
      method: recon.safe.method,
      effectiveMethod: recon.safe.effectiveMethod,
      url: recon.safe.url,
      verdict: decision.action,
      ruleId: decision.ruleId,
      recordedAction: recorded?.action,
      recordedRuleId: recorded?.ruleId,
      agreed,
    })
  }

  // 2. Replay browser/*.jsonl (excluding *.cdp.jsonl)
  const browserDir = join(instDir, 'browser')
  if (existsSync(browserDir)) {
    const files = readdirSync(browserDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.cdp.jsonl')).sort()
    for (const file of files) {
      const records = readJsonlSafe(join(browserDir, file))
      for (let idx = 0; idx < records.length; idx++) {
        const r = records[idx]
        if (!r || r.rec === '_summary' || r.rec === 'http_end') continue
        browserCount++
        const recorded = r.policy as CompactPolicyDecision | undefined
        const method = typeof r.method === 'string' ? r.method.toUpperCase() : 'GET'
        const effectiveMethod = typeof r.effectiveMethod === 'string' ? r.effectiveMethod.toUpperCase() : method
        const url = typeof r.url === 'string' ? r.url : ''
        const t = typeof r.t === 'string' ? r.t : ''

        // Check for missing v2 descriptor or capped/incomplete evidence on writes
        const isV2 = r.descV === 1 && typeof r.completeness === 'object' && Array.isArray(r.actions)
        if (!isV2) {
          const isLegacyRead = SAFE_METHODS.has(method) && SAFE_METHODS.has(effectiveMethod)
          if (!isLegacyRead) {
            counts.insufficient_evidence++
            results.push({
              source: 'browser',
              file: `browser/${file}`,
              index: r.n ?? idx + 1,
              t,
              method,
              effectiveMethod,
              url,
              verdict: 'insufficient_evidence',
              ruleId: 'insufficient_evidence',
              recordedAction: recorded?.action,
              recordedRuleId: recorded?.ruleId,
              agreed: null,
              insufficientReason: 'legacy_browser_entry_without_v2_descriptor',
            })
            continue
          }
          counts.allow++
          results.push({
            source: 'browser',
            file: `browser/${file}`,
            index: r.n ?? idx + 1,
            t,
            method,
            effectiveMethod,
            url,
            verdict: 'allow',
            ruleId: 'allow_read',
            recordedAction: recorded?.action,
            recordedRuleId: recorded?.ruleId,
            agreed: recorded ? recorded.action === 'allow' : null,
          })
          continue
        }

        if (r.logCapped && r.isWrite) {
          counts.insufficient_evidence++
          results.push({
            source: 'browser',
            file: `browser/${file}`,
            index: r.n ?? idx + 1,
            t,
            method,
            effectiveMethod,
            url,
            verdict: 'insufficient_evidence',
            ruleId: 'insufficient_evidence',
            recordedAction: recorded?.action,
            recordedRuleId: recorded?.ruleId,
            agreed: null,
            insufficientReason: 'log_capped_minimal_record',
          })
          continue
        }

        // Determine instance log seq up to this browser entry's timestamp
        const uptoEntry = t ? instLog.findLast(e => e.at <= t) : instLog.at(-1)
        const uptoSeq = uptoEntry?.seq ?? 0
        const safe = r as SafeRequestProjection
        const decision = await engine.evaluate({ safe }, { mode, log: instLog, uptoSeq })

        // Never treat truncated/opaque writes as deterministic allow during offline replay
        let verdict: ReplayVerdict = decision.action
        let insufficientReason: string | undefined
        if (
          safe.isWrite &&
          verdict === 'allow' &&
          (!safe.bodyComplete || !safe.decodeComplete || safe.completeness.extract === 'opaque')
        ) {
          verdict = 'insufficient_evidence'
          insufficientReason = 'truncated_or_opaque_write'
        }

        const agreed = recorded && verdict !== 'insufficient_evidence' ? verdict === recorded.action : null
        if (agreed === true) agreements++
        else if (agreed === false) disagreements++
        counts[verdict]++
        results.push({
          source: 'browser',
          file: `browser/${file}`,
          index: r.n ?? idx + 1,
          t,
          method,
          effectiveMethod,
          url,
          verdict,
          ruleId: verdict === 'insufficient_evidence' ? 'insufficient_evidence' : decision.ruleId,
          recordedAction: recorded?.action,
          recordedRuleId: recorded?.ruleId,
          agreed,
          ...(insufficientReason && { insufficientReason }),
        })
      }
    }
  }

  return {
    instDir,
    total: results.length,
    apiCount,
    browserCount,
    counts,
    agreements,
    disagreements,
    results,
  }
}

export { parseSemanticMethods }
