import crypto from 'node:crypto'
import { closeSync, existsSync, fstatSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  DESC_V,
  E1_MUTATING_FORM_COMMANDS,
  EXTRACTOR_V,
  SAFE_METHODS,
  canonicalizeJsonValue,
  canonicalizeTargetPath,
  classifySqlStatement,
  computeSqlContextDigest,
  computeTargetDigest,
  decodePathSegmentsStrict,
  effectiveAuthority,
  isUploadSessionEndpointPath,
  isValidEmailDomain,
  parseSemanticMethods,
  validateSharePointDeleteIds,
  type RequestDescriptor,
  type SafeRequestProjection,
  type SemanticAction,
} from './extract.ts'
import { REDACT_V, sanitizeUrl, scrubText } from './redact.ts'
import { isPerson, messageAuthority } from './messages.ts'
import { HttpError, openFile, type Entry } from './store.ts'
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
  reservationKey?: string
}

export type CompactPolicyDecision = {
  decisionId: string
  mode: ExecPolicyMode
  action: ExecPolicyAction
  ruleId: string
  policyVersion: string
  stage?: 1 | 2
  approvalRef?: string
  atSeq?: number
}

export type ApprovalScope = {
  action: string
  target?: string
  targetDigest?: string
  domains?: string[]
  ids?: string[]
  sql?: string
  parameters?: unknown
  sqlContextDigest?: string
  warehouseId?: string
  catalog?: string
  schema?: string
  connection?: string
  host?: string
  port?: number
  site?: string
  workspace?: string
  maxUses?: number
}

export type ApprovalContext = {
  approved: boolean
  approvalRef?: string
  reservationKey?: string
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
  approvers?: readonly string[]
  workspace?: string
  instKey?: string
  priorBrowserUses?: ReadonlyMap<string, number>
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

const HEX_64_RE = /^[a-f0-9]{64}$/i
const E1_FORM_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
const DBX_IDENT_RE = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_APPROVAL_USES = 20

function isValidHostname(raw: string): boolean {
  const h = raw.trim()
  if (h.length === 0 || h.length > 253) return false
  if (!HOST_RE.test(h)) return false
  return h.split('.').every(lbl => lbl.length >= 1 && lbl.length <= 63)
}

// Agent-submitted proposal scope keys ONLY: digests and free-text displays are NEVER accepted from the agent;
// the server always computes both the verbatim display fields and the keyed HMAC digests from exact concrete inputs!
const ALLOWED_SCOPE_KEYS = new Set([
  'action',
  'target',
  'domains',
  'ids',
  'sql',
  'parameters',
  'warehouseId',
  'catalog',
  'schema',
  'connection',
  'site',
  'host',
  'port',
  'workspace',
  'maxUses',
])

const CANONICAL_SCOPE_ACTIONS = new Set([
  'graph:sendMail',
  'graph:file_delete',
  'graph:excel_write',
  'databricks:sql',
  'e1_ais_write',
  'sharepoint_destructive_write',
  'http_delete',
])

function isE1AmbiguousOrMalformed(act: SemanticAction): boolean {
  if (act.family !== 'e1-ais') return false
  return (
    act.details?.conflictingActions === true ||
    act.details?.malformedE1Action === true ||
    act.details?.formActionsTruncated === true ||
    act.details?.unattributedMutation === true
  )
}

function isE1WriteAction(act: SemanticAction): boolean {
  if (act.family !== 'e1-ais') return false
  const a = typeof act.details?.action === 'string' ? act.details.action.toUpperCase() : ''
  if (a === 'W' || a === 'C' || a === 'U' || a === 'D' || /:[WCUD]$/i.test(act.op)) return true
  if (act.details?.hasMutatingFormAction === true || isE1AmbiguousOrMalformed(act)) return true
  if (Array.isArray(act.details?.mutatingForms) && (act.details!.mutatingForms as unknown[]).length > 0) return true
  const formActions = Array.isArray(act.details?.formActions) ? (act.details!.formActions as Array<{ command?: unknown }>) : []
  return formActions.some(fa => typeof fa?.command === 'string' && E1_MUTATING_FORM_COMMANDS.has(fa.command.toLowerCase()))
}

function isSharePointDestructive(safe: SafeRequestProjection, act: SemanticAction): boolean {
  if (act.family !== 'sharepoint') return false
  return (
    safe.method === 'DELETE' ||
    safe.effectiveMethod === 'DELETE' ||
    safe.method === 'MERGE' ||
    safe.effectiveMethod === 'MERGE' ||
    act.op === 'sharepoint:delete' ||
    act.details?.destructiveAction === true
  )
}

function normalizeScopeAction(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (['graph:sendmail', 'graph_send_mail', 'graph:send', 'graph:reply', 'graph:replyall', 'graph:forward'].includes(s)) return 'graph:sendMail'
  if (['graph:file_delete', 'graph_file_delete'].includes(s)) return 'graph:file_delete'
  if (['graph:excel_write', 'graph_excel_write'].includes(s)) return 'graph:excel_write'
  if (['databricks:sql', 'databricks_ddl_or_delete', 'databricks:sql_write', 'databricks:sql_ddl'].includes(s)) return 'databricks:sql'
  if (['e1_ais_write', 'e1-ais:w', 'e1_write'].includes(s)) return 'e1_ais_write'
  if (['sharepoint_destructive_write', 'sharepoint:delete', 'sharepoint:merge'].includes(s)) return 'sharepoint_destructive_write'
  if (['http_delete', 'delete'].includes(s)) return 'http_delete'
  return s
}

function isValidExactPathTarget(raw: string): boolean {
  const s = raw.trim()
  if (!s.startsWith('/') || s.length > 2048) return false
  if (s.includes('*') || s.includes('\0') || s.includes('[REDACTED') || s.includes('#') || /[\r\n\t]/.test(s)) return false
  const qIdx = s.indexOf('?')
  const pathOnly = qIdx >= 0 ? s.slice(0, qIdx) : s
  if (pathOnly.includes('..')) return false
  const segs = pathOnly.split('/').filter(Boolean)
  // Reject broad prefixes like '/', '/v1.0', '/beta', '/v1.0/me', '/_api'
  if (segs.length < 2) return false
  const lower0 = segs[0].toLowerCase()
  if ((lower0 === 'v1.0' || lower0 === 'beta') && segs.length < 3) return false
  if ((lower0 === 'v1.0' || lower0 === 'beta') && segs[1].toLowerCase() === 'me' && segs.length < 4) return false
  return true
}

function containsRawSecret(s: string): boolean {
  return scrubText(s).text !== s
}

function safeHexEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (!HEX_64_RE.test(a) || !HEX_64_RE.test(b)) return false
  return crypto.timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'))
}

// Strict server-side validator & canonicalizer for proposal `execpolicy` scopes (used by POST /api/messages & /comment).
// Rejects agent-supplied digests and displays; always derives both verbatim display fields and keyed HMAC digests on the server.
export function validateAndNormalizeApprovalScope(
  raw: unknown,
  ctx: {
    workspace: string
    connections?: ReadonlyArray<{ name: string; type: string; url?: string }>
    hmacKey?: Buffer
  },
): ApprovalScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'execpolicy scope must be a JSON object')
  }
  const obj = raw as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_SCOPE_KEYS.has(k)) {
      throw new HttpError(400, `unknown execpolicy scope field: ${k}`)
    }
  }
  if (typeof obj.action !== 'string' || !obj.action.trim()) {
    throw new HttpError(400, 'execpolicy scope requires a canonical action')
  }
  const action = normalizeScopeAction(obj.action)
  if (!CANONICAL_SCOPE_ACTIONS.has(action)) {
    throw new HttpError(400, `unsupported execpolicy action: ${obj.action}`)
  }

  let maxUses = 1
  if (obj.maxUses !== undefined) {
    if (typeof obj.maxUses !== 'number' || !Number.isInteger(obj.maxUses) || obj.maxUses < 1 || obj.maxUses > MAX_APPROVAL_USES) {
      throw new HttpError(400, `execpolicy maxUses must be an integer between 1 and ${MAX_APPROVAL_USES}`)
    }
    maxUses = obj.maxUses
  }

  const workspace = ctx.workspace.trim()
  if (!workspace) throw new HttpError(400, 'cannot attach execpolicy scope without an instance workspace')
  if (obj.workspace !== undefined) {
    if (typeof obj.workspace !== 'string' || obj.workspace.trim() !== workspace) {
      throw new HttpError(400, 'execpolicy workspace must match the instance workspace')
    }
  }

  let connection: string | undefined
  if (obj.connection !== undefined) {
    if (typeof obj.connection !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(obj.connection)) {
      throw new HttpError(400, 'execpolicy connection must be a valid connection name')
    }
    connection = obj.connection
  }

  let site: string | undefined
  if (obj.site !== undefined) {
    if (typeof obj.site !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(obj.site)) {
      throw new HttpError(400, 'execpolicy site must be a valid site name')
    }
    site = obj.site
  }

  let port: number | undefined
  if (obj.port !== undefined) {
    if (typeof obj.port !== 'number' || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
      throw new HttpError(400, 'execpolicy port must be an integer between 1 and 65535')
    }
    port = obj.port
  }

  if (action === 'graph:sendMail') {
    if (obj.host !== undefined || port !== undefined || site !== undefined) {
      throw new HttpError(400, 'graph:sendMail scope does not accept host, port, or site')
    }
    if (!Array.isArray(obj.domains) || obj.domains.length === 0 || obj.domains.length > 16) {
      throw new HttpError(400, 'graph:sendMail scope requires 1..16 explicit recipient domains')
    }
    const domains = new Set<string>()
    for (const d of obj.domains) {
      if (typeof d !== 'string' || !isValidEmailDomain(d.trim().toLowerCase())) {
        throw new HttpError(400, 'graph:sendMail domains must be explicit plain ASCII domains (no wildcards)')
      }
      domains.add(d.trim().toLowerCase())
    }
    return {
      action,
      domains: [...domains].sort(),
      ...(connection && { connection }),
      workspace,
      maxUses,
    }
  }

  if (action === 'databricks:sql') {
    if (obj.host !== undefined || port !== undefined || site !== undefined) {
      throw new HttpError(400, 'databricks:sql scope does not accept host, port, or site')
    }
    let warehouseId: string | undefined
    if (obj.warehouseId !== undefined) {
      if (typeof obj.warehouseId !== 'string' || !DBX_IDENT_RE.test(obj.warehouseId)) {
        throw new HttpError(400, 'databricks:sql warehouseId is invalid')
      }
      warehouseId = obj.warehouseId
    }
    let catalog: string | undefined
    if (obj.catalog !== undefined) {
      if (typeof obj.catalog !== 'string' || !DBX_IDENT_RE.test(obj.catalog)) {
        throw new HttpError(400, 'databricks:sql catalog is invalid')
      }
      catalog = obj.catalog
    }
    let schema: string | undefined
    if (obj.schema !== undefined) {
      if (typeof obj.schema !== 'string' || !DBX_IDENT_RE.test(obj.schema)) {
        throw new HttpError(400, 'databricks:sql schema is invalid')
      }
      schema = obj.schema
    }
    if (typeof obj.sql !== 'string' || !obj.sql.trim() || obj.sql.length > 8192) {
      throw new HttpError(400, 'databricks:sql scope requires an exact SQL statement (1..8192 chars)')
    }
    const sqlTrimmed = obj.sql.trim()
    if (containsRawSecret(sqlTrimmed)) {
      throw new HttpError(400, 'execpolicy SQL scope must not contain raw secrets or credentials')
    }
    const cls = classifySqlStatement(sqlTrimmed)
    if (cls.hasDropOrTruncate || cls.hasMergeDelete) {
      throw new HttpError(400, 'DROP, TRUNCATE, INSERT OVERWRITE, REPLACE WHERE, and MERGE ... THEN DELETE are unconditionally denied and cannot be approved')
    }
    let canonicalParams: unknown
    if (obj.parameters !== undefined) {
      try {
        canonicalParams = canonicalizeJsonValue(obj.parameters)
      } catch {
        throw new HttpError(400, 'databricks:sql parameters exceed maximum nesting depth or size')
      }
      const serializedParams = JSON.stringify(canonicalParams)
      if (!serializedParams || serializedParams.length > 8192) {
        throw new HttpError(400, 'databricks:sql parameters exceed maximum length (8192 chars)')
      }
      if (containsRawSecret(serializedParams)) {
        throw new HttpError(400, 'execpolicy SQL parameters must not contain raw secrets or credentials')
      }
    }
    const sqlContextDigest = computeSqlContextDigest({
      sql: sqlTrimmed,
      ...(obj.parameters !== undefined && { parameters: canonicalParams }),
      warehouseId,
      catalog,
      schema,
    }, ctx.hmacKey)
    return {
      action,
      sql: sqlTrimmed,
      ...(obj.parameters !== undefined && { parameters: canonicalParams }),
      sqlContextDigest,
      ...(warehouseId && { warehouseId }),
      ...(catalog && { catalog }),
      ...(schema && { schema }),
      ...(connection && { connection }),
      workspace,
      maxUses,
    }
  }

  if (action === 'e1_ais_write') {
    if (typeof obj.target !== 'string' || !E1_FORM_NAME_RE.test(obj.target.trim())) {
      throw new HttpError(400, 'e1_ais_write scope requires a concrete E1 form name target (no wildcards or paths)')
    }
    const target = obj.target.trim()
    let host: string | undefined
    if (obj.host !== undefined) {
      if (typeof obj.host !== 'string' || !isValidHostname(obj.host)) {
        throw new HttpError(400, 'e1_ais_write host must be a valid hostname')
      }
      host = obj.host.trim().toLowerCase()
    }
    if (port !== undefined && !host) {
      throw new HttpError(400, 'execpolicy port requires host')
    }
    return {
      action,
      target,
      ...(connection && { connection }),
      ...(host && { host }),
      ...(port !== undefined && { port }),
      ...(site && { site }),
      workspace,
      maxUses,
    }
  }

  // Path-targeted destructive/write scopes: graph:file_delete, graph:excel_write, sharepoint_destructive_write, http_delete
  if (typeof obj.target !== 'string' || !isValidExactPathTarget(obj.target)) {
    throw new HttpError(400, `${action} scope requires an exact concrete target path (no wildcards, redactions, or broad prefixes)`)
  }
  const rawTarget = obj.target.trim()
  if (containsRawSecret(rawTarget)) {
    throw new HttpError(400, 'execpolicy target must not contain raw secrets or credentials')
  }
  const qIdx = rawTarget.indexOf('?')
  const rawPathname = qIdx >= 0 ? rawTarget.slice(0, qIdx) : rawTarget
  const rawSearch = qIdx >= 0 ? rawTarget.slice(qIdx) : ''
  const decodedTargetPath = decodePathSegmentsStrict(rawPathname)
  if (decodedTargetPath.invalidEncoding) {
    throw new HttpError(400, `${action} target contains invalid or ambiguous percent-encoding`)
  }
  const decodedTargetLower = decodedTargetPath.decodedPath.toLowerCase()

  let explicitHost: string | undefined
  if (obj.host !== undefined) {
    if (typeof obj.host !== 'string' || !isValidHostname(obj.host)) {
      throw new HttpError(400, `${action} host must be a valid hostname`)
    }
    explicitHost = obj.host.trim().toLowerCase()
  }

  let surface: 'api' | 'browser' = 'api'
  let connType: string | undefined
  let host = ''
  let ids: string[] | undefined
  let bodySelector: string | undefined
  if (action === 'graph:file_delete' || action === 'graph:excel_write') {
    if (action === 'graph:excel_write' && !decodedTargetLower.includes('/workbook/')) {
      throw new HttpError(400, 'graph:excel_write target must be an exact /workbook/... path')
    }
    if (obj.ids !== undefined) throw new HttpError(400, 'ids is only valid for bulk body-selected SharePoint deletes')
    if (explicitHost !== undefined && explicitHost !== 'graph.microsoft.com') {
      throw new HttpError(400, `${action} host must be graph.microsoft.com`)
    }
    surface = 'api'
    connType = 'graph'
    host = 'graph.microsoft.com'
  } else if (action === 'sharepoint_destructive_write') {
    if (!decodedTargetLower.includes('/_api/') && !decodedTargetLower.includes('/_vti_bin/')) {
      throw new HttpError(400, 'sharepoint_destructive_write target must be a /_api/ or /_vti_bin/ path')
    }
    if (!explicitHost) {
      throw new HttpError(400, 'sharepoint_destructive_write requires a valid host')
    }
    host = explicitHost
    surface = site ? 'browser' : 'api'
    connType = 'sharepoint'
    const isDeleteByIds = /\/deletebyids(?:\(|$|\/)/i.test(decodedTargetLower)
    if (isDeleteByIds) {
      const parsed = validateSharePointDeleteIds(obj.ids, containsRawSecret)
      if (!parsed.ok) {
        throw new HttpError(400, parsed.reason)
      }
      ids = parsed.ids
      bodySelector = parsed.bodySelector
    } else if (obj.ids !== undefined) {
      throw new HttpError(400, 'ids is only valid for bulk body-selected SharePoint deletes')
    }
  } else if (action === 'http_delete') {
    if (obj.ids !== undefined) throw new HttpError(400, 'ids is only valid for bulk body-selected SharePoint deletes')
    if (site && connection) {
      throw new HttpError(400, 'http_delete scope cannot specify both site and connection')
    }
    if (site) {
      if (!explicitHost) {
        throw new HttpError(400, 'browser http_delete scope requires host')
      }
      surface = 'browser'
      host = explicitHost
    } else if (connection) {
      surface = 'api'
      const found = ctx.connections?.find(c => c.name === connection)
      connType = found?.type
      if (found?.type === 'service') {
        const expectedSvcHost = `${connection.toLowerCase()}.rf.internal`
        if (explicitHost && explicitHost !== expectedSvcHost) {
          throw new HttpError(400, 'http_delete host conflicts with service connection')
        }
        if (port !== undefined && port !== 443) {
          throw new HttpError(400, 'http_delete port conflicts with service connection')
        }
        host = expectedSvcHost
      } else if (found?.type === 'graph') {
        if (explicitHost && explicitHost !== 'graph.microsoft.com') {
          throw new HttpError(400, 'http_delete host conflicts with graph connection')
        }
        host = 'graph.microsoft.com'
      } else if (explicitHost) {
        host = explicitHost
      } else {
        throw new HttpError(400, 'http_delete scope requires a valid host or known connection')
      }
    } else {
      throw new HttpError(400, 'http_delete scope requires connection or site+host')
    }
    // Restrict /v1.0/ and /beta/ exemption strictly to established Graph destinations!
    const isGraphDest = connType === 'graph' || host === 'graph.microsoft.com'
    const isGraphApiPath = isGraphDest && (decodedTargetLower.startsWith('/v1.0/') || decodedTargetLower.startsWith('/beta/'))
    if (!isGraphApiPath && (decodedTargetLower.includes('/_api/') || decodedTargetLower.includes('/_vti_bin/'))) {
      throw new HttpError(400, 'SharePoint /_api/ and /_vti_bin/ deletes must use action sharepoint_destructive_write')
    }
  }

  if (port !== undefined && !host) {
    throw new HttpError(400, 'execpolicy port requires host')
  }
  const foldGraph = connType === 'graph' || host === 'graph.microsoft.com'
  const canonicalTarget = canonicalizeTargetPath(rawPathname, foldGraph) + rawSearch
  const targetDigest = computeTargetDigest({
    surface,
    connectionType: connType,
    host,
    ...(port !== undefined && { port }),
    rawPathname,
    rawSearch,
    ...(bodySelector && { bodySelector }),
  }, ctx.hmacKey)

  return {
    action,
    target: canonicalTarget,
    ...(ids && { ids }),
    targetDigest,
    ...(connection && { connection }),
    ...(host && { host }),
    ...(port !== undefined && { port }),
    ...(site && { site }),
    workspace,
    maxUses,
  }
}

function normalizeSafeAuthority(safe: SafeRequestProjection): string {
  const raw = (safe.authority ?? '').trim().toLowerCase()
  if (!raw) return ''
  const scheme = (safe.scheme ?? 'https').toLowerCase()
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    if (close < 0) return ''
    const host = raw.slice(0, close + 1)
    const rest = raw.slice(close + 1)
    if (rest.startsWith(':')) return effectiveAuthority(host, rest.slice(1), scheme)
    return effectiveAuthority(host, undefined, scheme)
  }
  const colon = raw.lastIndexOf(':')
  const host = colon > 0 ? raw.slice(0, colon) : raw
  const portPart = colon > 0 ? raw.slice(colon + 1) : undefined
  if (!isValidHostname(host) && host !== 'localhost') return ''
  return effectiveAuthority(host, portPart, scheme)
}

function matchesApprovalScope(safe: SafeRequestProjection, scope: ApprovalScope): boolean {
  if (!scope || typeof scope !== 'object' || typeof scope.action !== 'string' || !scope.action.trim()) return false
  if (scope.connection !== undefined && safe.target.connection !== scope.connection) return false
  if (scope.site !== undefined && safe.target.site !== scope.site) return false
  // Enforce every supplied host/port authority constraint across ALL scope actions (incl. E1)!
  // Resolve omitted scope.port as HTTPS default 443 (NEVER letting an http:// request match a port-443/default-HTTPS scope!).
  if (scope.port !== undefined && !scope.host) return false
  if (scope.host !== undefined) {
    const expectedAuth = effectiveAuthority(scope.host, scope.port, 'https')
    const reqAuth = normalizeSafeAuthority(safe)
    if (!reqAuth || reqAuth !== expectedAuth) return false
  }

  const actClass = normalizeScopeAction(scope.action)
  const isDelete = safe.method === 'DELETE' || safe.effectiveMethod === 'DELETE'

  if (actClass === 'graph:sendMail') {
    if (isDelete) return false
    const mailAct = safe.actions.find(a => a.family === 'graph' && ['graph:sendMail', 'graph:send', 'graph:reply', 'graph:replyAll', 'graph:forward'].includes(a.op))
    if (!mailAct) return false
    // Fail closed unless the extractor proved complete delivery recipient coverage!
    if (mailAct.details?.recipientsComplete !== true) return false
    if (scope.targetDigest !== undefined && !safeHexEqual(mailAct.details?.targetDigest, scope.targetDigest)) return false
    const allowedDomains = Array.isArray(scope.domains)
      ? scope.domains.filter((d): d is string => typeof d === 'string' && isValidEmailDomain(d.trim().toLowerCase())).map(d => d.trim().toLowerCase())
      : []
    if (!allowedDomains.length) return false
    const reqDomains = Array.isArray(mailAct.details?.recipientDomains)
      ? (mailAct.details!.recipientDomains as unknown[]).filter((d): d is string => typeof d === 'string' && d.length > 0).map(d => d.toLowerCase())
      : []
    if (!reqDomains.length) return false
    const allowedSet = new Set(allowedDomains)
    return reqDomains.every(d => allowedSet.has(d))
  }

  if (actClass === 'graph:file_delete') {
    const delAct = safe.actions.find(a => a.family === 'graph' && a.op === 'graph:file_delete')
    if (!delAct) return false
    return safeHexEqual(delAct.details?.targetDigest, scope.targetDigest)
  }

  if (actClass === 'graph:excel_write') {
    // Never let an excel_write approval unlock an HTTP DELETE on the same workbook path!
    if (isDelete) return false
    const xlAct = safe.actions.find(a => a.family === 'graph' && a.op === 'graph:excel_write')
    if (!xlAct) return false
    return safeHexEqual(xlAct.details?.targetDigest, scope.targetDigest)
  }

  if (actClass === 'databricks:sql') {
    const sqlAct = safe.actions.find(a => a.family === 'databricks' && a.op.startsWith('databricks:sql_'))
    if (!sqlAct) return false
    if (typeof scope.warehouseId === 'string' && scope.warehouseId && sqlAct.details?.warehouseId !== scope.warehouseId) return false
    return safeHexEqual(sqlAct.details?.sqlContextDigest, scope.sqlContextDigest)
  }

  if (actClass === 'e1_ais_write') {
    if (isDelete) return false
    const e1Act = safe.actions.find(a => isE1WriteAction(a))
    if (!e1Act || isE1AmbiguousOrMalformed(e1Act)) return false
    const hasTarget = typeof scope.target === 'string' && scope.target.trim().length > 0
    const hasDigest = scope.targetDigest !== undefined
    if (!hasTarget && !hasDigest) return false
    // Enforce EVERY supplied E1 constraint AND require every mutating form in a batch to match scope.target!
    if (hasTarget) {
      const wantForm = scope.target!.trim()
      if (!E1_FORM_NAME_RE.test(wantForm)) return false
      const mutForms = Array.isArray(e1Act.details?.mutatingForms)
        ? (e1Act.details!.mutatingForms as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0)
        : undefined
      if (mutForms && mutForms.length > 0) {
        if (!mutForms.every(f => f === wantForm)) return false
      } else if (e1Act.resource !== wantForm) {
        return false
      }
    }
    if (hasDigest) {
      if (!safeHexEqual(e1Act.details?.targetDigest, scope.targetDigest)) return false
    }
    return true
  }

  if (actClass === 'sharepoint_destructive_write') {
    const spAct = safe.actions.find(a => isSharePointDestructive(safe, a))
    if (!spAct) return false
    if (spAct.details?.bodySelectionIncomplete === true || spAct.details?.ambiguousPathEncoding === true) return false
    if (!safeHexEqual(spAct.details?.targetDigest, scope.targetDigest)) return false
    if (Array.isArray(scope.ids) && spAct.details?.selectedIdCount !== scope.ids.length) return false
    return true
  }

  if (actClass === 'http_delete') {
    if (!isDelete) return false
    const actDigest = safe.actions.find(a => typeof a.details?.targetDigest === 'string')?.details?.targetDigest
    return safeHexEqual(actDigest, scope.targetDigest)
  }

  return false
}

// Inspects an instance's log.jsonl up to `uptoSeq` (default full log) to determine whether the current authority
// epoch has an authorized, workspace-bound, structured, unconsumed human sign-off matching `opts.safe`.
export function findCurrentEpochApproval(
  log: readonly Entry[] | undefined,
  opts?: {
    uptoSeq?: number
    epoch?: number
    owner?: string
    approvers?: readonly string[]
    workspace?: string
    instKey?: string
    safe?: SafeRequestProjection
    priorBrowserUses?: ReadonlyMap<string, number>
    inFlightReservations?: ReadonlyMap<string, ReadonlySet<string>>
  },
): ApprovalContext {
  if (!log || !log.length) return { approved: false, recentApprovedProposals: [] }
  const upto = opts?.uptoSeq ?? (log.at(-1)?.seq ?? log.length)
  const slice = log.filter(e => e.seq <= upto)
  if (!slice.length) return { approved: false, recentApprovedProposals: [] }

  // Find latest duplicate or authority boundary in this slice, plus inferred owner & workspace.
  let boundarySeq = 0
  let activeEpoch = opts?.epoch
  let activeOwner = opts?.owner
  let logWorkspace: string | undefined
  let creatorOwner: string | undefined
  for (const e of slice) {
    if (e.op === 'create' && isPerson(e) && !creatorOwner) {
      creatorOwner = e.by
    }
    if (e.op === 'duplicate') {
      boundarySeq = Math.max(boundarySeq, e.seq)
    } else if (e.op === 'authority') {
      boundarySeq = Math.max(boundarySeq, e.seq)
      if (typeof e.epoch === 'number') activeEpoch = e.epoch
      if (typeof e.owner === 'string') activeOwner = e.owner
      if (typeof e.workspace === 'string') logWorkspace = e.workspace
    } else if (e.op === 'run' && e.authority && typeof e.authority === 'object') {
      const ra = e.authority as { epoch?: unknown; owner?: unknown; workspace?: unknown }
      if (activeEpoch === undefined && typeof ra.epoch === 'number') activeEpoch = ra.epoch
      if (activeOwner === undefined && typeof ra.owner === 'string') activeOwner = ra.owner
      if (typeof ra.workspace === 'string') logWorkspace = ra.workspace
    }
  }
  const effectiveOwner = activeOwner ?? creatorOwner
  const expectedWorkspace = opts?.workspace ?? logWorkspace

  // If caller specified a workspace and the log's active authority belongs to a DIFFERENT workspace, deny immediately.
  if (opts?.workspace !== undefined && logWorkspace !== undefined && logWorkspace !== opts.workspace) {
    return { approved: false, recentApprovedProposals: [] }
  }

  // Authorized sign-off actors: series owner (or creator in minimal logs) plus any explicit host-configured approvers.
  // FAIL CLOSED when no authorized actor can be established!
  const authorizedActors = new Set<string>()
  if (effectiveOwner) authorizedActors.add(effectiveOwner.toLowerCase())
  if (opts?.approvers) {
    for (const a of opts.approvers) {
      if (typeof a === 'string' && a.trim()) authorizedActors.add(a.trim().toLowerCase())
    }
  }
  if (authorizedActors.size === 0) {
    return { approved: false, recentApprovedProposals: [] }
  }

  const proposals: ApprovalContext['recentApprovedProposals'] = []
  let matchedApprovalRef: string | undefined
  let matchedReservationKey: string | undefined

  for (const e of slice) {
    if (e.seq <= boundarySeq) continue
    if (e.op !== 'signoff' || e.approved === false || !isPerson(e)) continue
    // Authority check: signoff MUST come from an authorized owner/approver (never an arbitrary viewer!).
    if (!authorizedActors.has(e.by.toLowerCase())) continue

    const auth = messageAuthority(slice, e, upto)
    if (auth.stale) continue
    if (activeEpoch !== undefined && auth.epoch !== undefined && auth.epoch !== activeEpoch) continue
    if (activeOwner !== undefined && auth.owner !== undefined && auth.owner !== activeOwner) continue

    // Signoff MUST reference a current-epoch proposal comment carrying structured execpolicy scope.
    if (typeof e.on !== 'number') continue
    const ask = slice.find(x => x.seq === e.on)
    if (!ask || ask.op !== 'comment' || (ask.ask !== 'proposal' && ask.ask !== true)) continue
    if (ask.seq <= boundarySeq) continue
    const askAuth = messageAuthority(slice, ask, upto)
    if (askAuth.stale) continue
    if (activeEpoch !== undefined && askAuth.epoch !== undefined && askAuth.epoch !== activeEpoch) continue

    const proposalText = typeof ask.text === 'string' && ask.text ? ask.text : (typeof e.text === 'string' ? e.text : '')
    proposals.push({
      seq: e.seq,
      text: proposalText.slice(0, 256),
      by: e.by,
      at: e.at,
    })

    const scope = ask.execpolicy as ApprovalScope | undefined
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || typeof scope.action !== 'string' || !scope.action.trim()) {
      continue
    }

    // Fail-closed workspace binding: whenever expectedWorkspace is known, proposal MUST declare an exact match!
    const scopeWs = typeof scope.workspace === 'string' ? scope.workspace.trim() : ''
    if (expectedWorkspace !== undefined) {
      if (!scopeWs || scopeWs !== expectedWorkspace) continue
    } else if (scopeWs) {
      // Proposal is workspace-scoped, but caller/log didn't establish a matching workspace -> fail closed.
      continue
    }

    // Scope matching against the evaluated request (required when opts.safe is supplied).
    if (opts?.safe && !matchesApprovalScope(opts.safe, scope)) continue

    // Single-use / bounded count consumption: count deduplicated durable pre-flight `send`, completed `call`,
    // in-flight synchronous reservations, and prior browser uses against `maxUses` (default 1, cap 20).
    const ref = `c${e.on}`
    const maxUses = typeof scope.maxUses === 'number' && Number.isInteger(scope.maxUses) && scope.maxUses >= 1 && scope.maxUses <= MAX_APPROVAL_USES
      ? scope.maxUses
      : 1
    const resKey = opts?.instKey ? `${opts.instKey}\0${boundarySeq}:${activeEpoch ?? ''}\0${ref}` : undefined
    const countedDecisions = new Set<string>()
    for (const prior of slice) {
      if (prior.seq <= e.seq) continue
      if (prior.op === 'send' && prior.approvalRef === ref) {
        countedDecisions.add(typeof prior.decisionId === 'string' && prior.decisionId ? prior.decisionId : `send:${prior.seq}`)
      } else if (prior.op === 'call') {
        const pol = prior.policy as CompactPolicyDecision | undefined
        if (pol?.approvalRef === ref && pol?.action === 'allow') {
          countedDecisions.add(pol.decisionId || `call:${prior.seq}`)
        }
      }
    }
    if (resKey && opts?.inFlightReservations) {
      const liveSet = opts.inFlightReservations.get(resKey)
      if (liveSet) {
        for (const decId of liveSet) countedDecisions.add(decId)
      }
    }
    const usedCount = countedDecisions.size + (opts?.priorBrowserUses?.get(ref) ?? 0)
    if (usedCount >= maxUses) continue

    matchedApprovalRef = ref
    matchedReservationKey = resKey
  }

  return {
    approved: matchedApprovalRef !== undefined,
    ...(matchedApprovalRef && { approvalRef: matchedApprovalRef }),
    ...(matchedReservationKey && { reservationKey: matchedReservationKey }),
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

  // 2. Mandatory transport & body-integrity facts (checked upfront so action-specific allows can never bypass them!)
  const hasDeleteVerb = safe.method === 'DELETE' || safe.effectiveMethod === 'DELETE'
  const escalatedFromSafe = SAFE_METHODS.has(safe.method) && !SAFE_METHODS.has(safe.effectiveMethod)
  const writeBodyNotInspected = safe.isWrite && safe.completeness.transport === 'not-read' && safe.declaredBytes !== 0
  const writeIncompleteBody = safe.isWrite && (safe.completeness.transport === 'truncated' || (safe.completeness.decode !== 'complete' && safe.completeness.decode !== 'none'))
  const writeDupKeys = safe.isWrite && Boolean(safe.dupKeys)
  const bodyIntegrityFailure: { ruleId: string; reason: string } | undefined = writeDupKeys
    ? { ruleId: 'write_duplicate_json_keys', reason: 'Write payload contained duplicate JSON keys' }
    : writeBodyNotInspected
      ? { ruleId: 'write_body_not_inspected', reason: 'Body-bearing write was not inspected before dispatch' }
      : writeIncompleteBody
        ? { ruleId: 'write_incomplete_body', reason: 'Write body was truncated or failed decoding' }
        : undefined
  const approvedOrIntegrity = (ruleId: string, approvalRef?: string) =>
    bodyIntegrityFailure
      ? make('escalate', bodyIntegrityFailure.ruleId, bodyIntegrityFailure.reason)
      : make('allow', ruleId, 'Approved by current-epoch human signoff', approvalRef)

  // 3a. Unconditional action-level denies first (DROP/TRUNCATE/INSERT OVERWRITE/REPLACE WHERE/MERGE...THEN DELETE,
  //     and uninspectable Databricks SQL submissions that cannot be verified free of mandatory-deny statements!)
  for (const act of safe.actions) {
    if (act.family === 'databricks' && act.op.startsWith('databricks:sql_')) {
      const stmts = Array.isArray(act.details?.statements) ? (act.details!.statements as string[]) : []
      if (
        act.details?.hasDropOrTruncate === true ||
        act.details?.hasMergeDelete === true ||
        stmts.some(s => s === 'DROP' || s === 'TRUNCATE')
      ) {
        return make('deny', 'databricks_destructive_ddl', `Destructive SQL (${stmts.join(',') || 'DROP/TRUNCATE/MERGE DELETE'}) denied`)
      }
      if (act.details?.uninspectable === true) {
        return make('deny', 'databricks_sql_uninspectable', 'Uninspectable Databricks SQL statement denied')
      }
    }
  }

  // 3b. Action-specific deterministic rules
  for (const act of safe.actions) {
    // Databricks SQL rules
    if (act.family === 'databricks' && act.op.startsWith('databricks:sql_')) {
      const sqlClass = act.details?.sqlClass
      const stmts = Array.isArray(act.details?.statements) ? (act.details!.statements as string[]) : []
      if (sqlClass === 'ddl' || act.details?.hasDelete === true || act.details?.destructive === true || stmts.includes('DELETE')) {
        return approval.approved
          ? approvedOrIntegrity('databricks_write_approved', approval.approvalRef)
          : make('requireApproval', 'databricks_ddl_or_delete', `SQL ${stmts.join(',') || String(sqlClass)} requires human approval`)
      }
      if (act.details?.ambiguous === true || sqlClass === 'unknown') {
        return make('escalate', 'databricks_sql_unknown', 'Ambiguous or unclassified Databricks SQL statement')
      }
      if (sqlClass === 'read' && !hasDeleteVerb && !escalatedFromSafe && !bodyIntegrityFailure && safe.bodyComplete && safe.decodeComplete) {
        return make('allow', 'allow_databricks_sql_read')
      }
    }

    // Microsoft Graph mail send / reply / forward
    if (act.family === 'graph' && ['graph:sendMail', 'graph:send', 'graph:reply', 'graph:replyAll', 'graph:forward'].includes(act.op)) {
      if (!approval.approved) {
        return make('requireApproval', 'graph_send_mail', 'Outbound email send requires current-epoch human approval')
      }
      if (!hasDeleteVerb) {
        return approvedOrIntegrity('graph_send_mail_approved', approval.approvalRef)
      }
    }

    // Microsoft Graph file delete (including POST .../permanentDelete)
    if (act.family === 'graph' && act.op === 'graph:file_delete') {
      return approval.approved
        ? approvedOrIntegrity('graph_file_delete_approved', approval.approvalRef)
        : make('requireApproval', 'graph_file_delete', 'File deletion requires current-epoch human approval')
    }

    // Microsoft Graph Excel workbook write
    if (act.family === 'graph' && act.op === 'graph:excel_write') {
      if (!approval.approved) {
        return make('requireApproval', 'graph_excel_write', 'Excel workbook write requires current-epoch human approval')
      }
      if (!hasDeleteVerb) {
        return approvedOrIntegrity('graph_excel_write_approved', approval.approvalRef)
      }
    }

    // Microsoft Graph / SharePoint / Outlook upload-session binary PUT chunk (granted link, prefix inspected)
    if (act.family === 'graph' && act.op === 'graph:upload_session_chunk') {
      if (
        !hasDeleteVerb &&
        !escalatedFromSafe &&
        !writeDupKeys &&
        safe.completeness.transport !== 'not-read' &&
        safe.completeness.decode !== 'error'
      ) {
        return make('allow', 'allow_upload_session_chunk')
      }
    }

    // Microsoft Graph file content write (PUT .../content): require strong non-* If-Match; allow governed binary/streamed upload once prefix is read!
    if (act.family === 'graph' && act.op === 'graph:file_write') {
      if (act.details?.hasIfMatch === false) {
        return make('escalate', 'unguarded_overwrite_no_if_match', 'File content overwrite without If-Match ETag')
      }
      if (
        act.details?.hasIfMatch === true &&
        !hasDeleteVerb &&
        !escalatedFromSafe &&
        !writeDupKeys &&
        safe.completeness.transport !== 'not-read' &&
        safe.completeness.decode !== 'error'
      ) {
        return make('allow', 'allow_governed_file_write')
      }
    }

    // E1 AIS write: escalate malformed/conflicting/truncated/unattributed payloads (never eligible for ordinary approval!)
    if (act.family === 'e1-ais' && isE1AmbiguousOrMalformed(act)) {
      return make('escalate', 'e1_ais_ambiguous_or_malformed', 'E1 AIS payload has ambiguous, conflicting, truncated, or malformed actions')
    }
    if (isE1WriteAction(act)) {
      if (!approval.approved) {
        return make('requireApproval', 'e1_ais_write', 'JD Edwards E1 AIS write action requires human approval')
      }
      if (!hasDeleteVerb) {
        return approvedOrIntegrity('e1_ais_write_approved', approval.approvalRef)
      }
    }

    // SharePoint DELETE / MERGE / recycle() / opaque batch / incomplete selector / unguarded PUT
    if (act.family === 'sharepoint') {
      if (act.coverage === 'opaque-batch') {
        return make('escalate', 'sharepoint_opaque_batch', 'Opaque SharePoint $batch write requires review')
      }
      if (safe.isWrite && (act.details?.bodySelectionIncomplete === true || act.details?.ambiguousPathEncoding === true)) {
        return make('escalate', 'sharepoint_incomplete_selector', 'SharePoint write has incomplete body selector or ambiguous path encoding')
      }
      if (isSharePointDestructive(safe, act)) {
        return approval.approved
          ? approvedOrIntegrity('sharepoint_destructive_approved', approval.approvalRef)
          : make('requireApproval', 'sharepoint_destructive_write', `SharePoint ${hasDeleteVerb || act.op === 'sharepoint:delete' ? 'DELETE' : 'MERGE'} requires human approval`)
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
      if (safe.graphqlOp === 'query' && !hasDeleteVerb && !escalatedFromSafe && !bodyIntegrityFailure && safe.bodyComplete && safe.decodeComplete) {
        return make('allow', 'allow_graphql_query')
      }
    }
  }

  // 4. Generic DELETE across any surface (apply stricter rule to BOTH wire method and effectiveMethod so DELETE + override: POST cannot bypass!)
  if (hasDeleteVerb) {
    return approval.approved
      ? approvedOrIntegrity('http_delete_approved', approval.approvalRef)
      : make('requireApproval', 'http_delete', 'HTTP DELETE requires current-epoch human approval')
  }

  // 5. Method-override escalation from safe wire verb
  if (escalatedFromSafe) {
    return make('escalate', 'method_override_escalation', `Safe wire verb ${safe.method} escalated to ${safe.effectiveMethod}`)
  }

  // 5b. Fallback for granted SharePoint / Outlook upload-session PUT chunks (anchored endpoint only, prefix inspected)
  if (
    safe.surface === 'api' &&
    safe.method === 'PUT' &&
    safe.effectiveMethod === 'PUT' &&
    /(?:^|\.)(?:sharepoint\.com|svc\.ms|outlook\.office(?:365)?\.com)$/i.test(safe.authority) &&
    isUploadSessionEndpointPath(safe.path) &&
    !writeDupKeys &&
    safe.completeness.transport !== 'not-read' &&
    safe.completeness.decode !== 'error'
  ) {
    return make('allow', 'allow_upload_session_chunk')
  }

  // 6. Integrity/completeness escalations on writes
  if (safe.isWrite) {
    if (bodyIntegrityFailure) {
      return make('escalate', bodyIntegrityFailure.ruleId, bodyIntegrityFailure.reason)
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

// Pluggable Stage-1 + Stage-2 ExecPolicy Engine with bounded async shadow execution,
// synchronous atomic approval reservation, and fail-closed enforce mode.
export class ExecPolicyEngine {
  private triageHook?: TriageHook
  private shadowActive = 0
  private shadowQueue: Array<() => Promise<void>> = []
  private approvalReservations = new Map<string, Set<string>>()
  shadowDropped = 0
  shadowCompleted = 0
  shadowErrors = 0

  constructor(triageHook?: TriageHook) {
    this.triageHook = triageHook
  }

  setTriageHook(hook?: TriageHook) {
    this.triageHook = hook
  }

  releaseApprovalReservation(reservationKey: string | undefined, decisionId: string) {
    if (!reservationKey) return
    const set = this.approvalReservations.get(reservationKey)
    if (!set) return
    set.delete(decisionId)
    if (set.size === 0) this.approvalReservations.delete(reservationKey)
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
    // Defer to macrotask turn (setImmediate) so synchronous hook startup never delays live request forwarding.
    // Keep setImmediate ref'd so libuv sets poll timeout = 0 and dispatches immediately on the next tick.
    setImmediate(() => {
      void Promise.resolve()
        .then(job)
        .then(() => { this.shadowCompleted++ })
        .catch(() => { this.shadowErrors++ })
        .finally(() => {
          this.shadowActive--
          const next = this.shadowQueue.shift()
          if (next && this.shadowActive < maxConcurrent) this.runShadow(next, maxConcurrent)
        })
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
        approvers: opts.approvers,
        workspace: opts.workspace,
        instKey: opts.instKey,
        safe: descriptor.safe,
        priorBrowserUses: opts.priorBrowserUses,
        inFlightReservations: this.approvalReservations,
      })
      stage1 = evaluateStage1(descriptor.safe, mode, approval, decisionId)
      // Synchronously reserve approval use BEFORE any async yield so concurrent parallel requests
      // can never double-spend a single-use or bounded-use approval!
      if (stage1.action === 'allow' && stage1.approvalRef && approval.reservationKey && opts.instKey) {
        let set = this.approvalReservations.get(approval.reservationKey)
        if (!set) {
          set = new Set()
          this.approvalReservations.set(approval.reservationKey, set)
        }
        set.add(decisionId)
        stage1 = { ...stage1, reservationKey: approval.reservationKey }
      }
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
          let timer: NodeJS.Timeout | undefined
          try {
            // Race against deadlineMs so a hook that ignores AbortSignal still releases its shadow worker slot!
            const verdict = await Promise.race<TriageVerdict>([
              Promise.resolve().then(() => hook(triageInput, { decisionId, signal: ac.signal, deadlineMs })),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  ac.abort()
                  reject(new Error('shadow_timeout'))
                }, deadlineMs)
                timer.unref?.()
              }),
            ])
            if (ac.signal.aborted) return
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
            if (timer) clearTimeout(timer)
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

const MAX_REPLAY_LOG_BYTES = 12 * 1024 * 1024

function parseJsonlBuffer(rawBuf: Buffer): { entries: any[]; malformedLines: number[] } {
  if (rawBuf.length === 0) return { entries: [], malformedLines: [] }
  const raw = rawBuf.toString('utf8')
  const entries: any[] = []
  const malformedLines: number[] = []
  const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0 || /^[ \t\r]+$/.test(line)) {
      malformedLines.push(i + 1)
      continue
    }
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        malformedLines.push(i + 1)
        continue
      }
      entries.push(parsed)
    } catch {
      malformedLines.push(i + 1)
    }
  }
  return { entries, malformedLines }
}

function readJsonlStrict(filePath: string): { entries: any[]; malformedLines: number[]; rawBuf?: Buffer } {
  if (!existsSync(filePath)) return { entries: [], malformedLines: [] }
  const rawBuf = readFileSync(filePath)
  const { entries, malformedLines } = parseJsonlBuffer(rawBuf)
  return { entries, malformedLines, rawBuf }
}

function readFdBounded(fd: number, maxBytes: number): Buffer | undefined {
  const st = fstatSync(fd)
  if (st.size > maxBytes) return undefined
  const chunks: Buffer[] = []
  let total = 0
  const chunkSize = 64 * 1024
  for (;;) {
    const remaining = maxBytes + 1 - total
    const buf = Buffer.allocUnsafe(Math.min(chunkSize, remaining))
    const n = readSync(fd, buf, 0, buf.length, null)
    if (n === 0) break
    total += n
    if (total > maxBytes) return undefined
    chunks.push(n === buf.length ? buf : buf.subarray(0, n))
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
}

function readContainedFileOnce(baseDir: string, relFile: string, maxBytes: number): { status: 'ok' | 'missing' | 'oversize'; buf?: Buffer } {
  const fd = openFile(baseDir, relFile)
  if (fd === undefined) return { status: 'missing' }
  try {
    const buf = readFdBounded(fd, maxBytes)
    if (!buf) return { status: 'oversize' }
    return { status: 'ok', buf }
  } finally {
    closeSync(fd)
  }
}

function loadHostBrowserManifestHashes(instId: string, manifestsDir?: string): Map<string, string> | undefined {
  let dir = manifestsDir
  if (!dir) {
    try { dir = join(rfDir(), 'browser-manifests') } catch { return undefined }
  }
  if (!dir || !existsSync(dir)) return undefined
  const hashes = new Map<string, string>()
  let foundAny = false
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const m = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { inst?: string; file?: string; artifacts?: Record<string, string> }
      if (m?.inst === instId && m.file && typeof m.artifacts?.[m.file] === 'string') {
        foundAny = true
        hashes.set(m.file, m.artifacts[m.file])
      }
    } catch {}
  }
  return foundAny ? hashes : undefined
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
  opts?: { triageHook?: TriageHook; mode?: ExecPolicyMode; instId?: string; manifestsDir?: string },
): Promise<ReplaySummary> {
  const mode = opts?.mode ?? 'observe'
  const engine = new ExecPolicyEngine(opts?.triageHook)
  const instLogParsed = readJsonlStrict(join(instDir, 'log.jsonl'))
  const instLog = instLogParsed.entries as Entry[]
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

  for (const badLine of instLogParsed.malformedLines) {
    apiCount++
    counts.insufficient_evidence++
    results.push({
      source: 'api',
      file: 'log.jsonl',
      index: badLine,
      t: '',
      method: 'UNKNOWN',
      effectiveMethod: 'UNKNOWN',
      url: '',
      verdict: 'insufficient_evidence',
      ruleId: 'insufficient_evidence',
      agreed: null,
      insufficientReason: 'malformed_instance_log_line',
    })
  }

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

    // Bound approval lookup strictly to the persisted admission-time cursor (`policy.atSeq`), falling back to `sent - 1` or `seq - 1`.
    const uptoSeq = typeof recorded?.atSeq === 'number'
      ? recorded.atSeq
      : typeof e.sent === 'number'
        ? Math.max(0, e.sent - 1)
        : Math.max(0, e.seq - 1)
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

  // 2. Replay browser/*.jsonl (excluding *.cdp.jsonl), verifying host SHA-256 manifests when present
  const browserDir = join(instDir, 'browser')
  const instId = opts?.instId ?? basename(instDir)
  const manifestHashes = loadHostBrowserManifestHashes(instId, opts?.manifestsDir)
  const diskFiles = existsSync(browserDir)
    ? readdirSync(browserDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.cdp.jsonl')).sort()
    : []
  const allRelFiles = new Set<string>(diskFiles.map(f => `browser/${f}`))
  if (manifestHashes) {
    for (const rel of manifestHashes.keys()) allRelFiles.add(rel)
  }

  const browserApprovalUses = new Map<string, number>()
  for (const relFile of [...allRelFiles].sort()) {
    if (manifestHashes && !manifestHashes.has(relFile)) {
      // Extra unmanifested workspace file cannot inject entries into replay
      browserCount++
      counts.insufficient_evidence++
      results.push({
        source: 'browser', file: relFile, index: 0, t: '', method: 'UNKNOWN', effectiveMethod: 'UNKNOWN', url: '',
        verdict: 'insufficient_evidence', ruleId: 'insufficient_evidence', agreed: null,
        insufficientReason: 'unmanifested_browser_log_file',
      })
      continue
    }

    // Open ONCE via contained openFile() and hash + parse that single buffer (zero TOCTOU / symlink escape!)
    const readRes = readContainedFileOnce(instDir, relFile, MAX_REPLAY_LOG_BYTES)
    if (readRes.status === 'missing') {
      if (manifestHashes) {
        browserCount++
        counts.insufficient_evidence++
        results.push({
          source: 'browser', file: relFile, index: 0, t: '', method: 'UNKNOWN', effectiveMethod: 'UNKNOWN', url: '',
          verdict: 'insufficient_evidence', ruleId: 'insufficient_evidence', agreed: null,
          insufficientReason: 'missing_manifested_browser_log',
        })
      }
      continue
    }
    if (readRes.status === 'oversize' || !readRes.buf) {
      browserCount++
      counts.insufficient_evidence++
      results.push({
        source: 'browser', file: relFile, index: 0, t: '', method: 'UNKNOWN', effectiveMethod: 'UNKNOWN', url: '',
        verdict: 'insufficient_evidence', ruleId: 'insufficient_evidence', agreed: null,
        insufficientReason: 'browser_log_manifest_mismatch',
      })
      continue
    }

    if (manifestHashes) {
      const expectedSha = manifestHashes.get(relFile)!
      const actualSha = crypto.createHash('sha256').update(readRes.buf).digest('hex')
      if (actualSha !== expectedSha) {
        browserCount++
        counts.insufficient_evidence++
        results.push({
          source: 'browser', file: relFile, index: 0, t: '', method: 'UNKNOWN', effectiveMethod: 'UNKNOWN', url: '',
          verdict: 'insufficient_evidence', ruleId: 'insufficient_evidence', agreed: null,
          insufficientReason: 'browser_log_manifest_mismatch',
        })
        continue
      }
    }

    const parsed = parseJsonlBuffer(readRes.buf)
    for (const badLine of parsed.malformedLines) {
      browserCount++
      counts.insufficient_evidence++
      results.push({
        source: 'browser', file: relFile, index: badLine, t: '', method: 'UNKNOWN', effectiveMethod: 'UNKNOWN', url: '',
        verdict: 'insufficient_evidence', ruleId: 'insufficient_evidence', agreed: null,
        insufficientReason: 'malformed_browser_jsonl_line',
      })
    }
    const records = parsed.entries
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
              file: relFile,
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
            file: relFile,
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
            file: relFile,
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
        const decision = await engine.evaluate({ safe }, { mode, log: instLog, uptoSeq, priorBrowserUses: browserApprovalUses })
        if (decision.action === 'allow' && decision.approvalRef) {
          browserApprovalUses.set(decision.approvalRef, (browserApprovalUses.get(decision.approvalRef) ?? 0) + 1)
        }

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
          file: relFile,
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
