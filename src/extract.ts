import zlib from 'node:zlib'
import {
  buildBodyShape,
  buildFormBodyShape,
  isDataLikeKey,
  isSensitiveValue,
  parseJsonSafe,
  redactFormBody,
  redactJsonValue,
  redactPlainText,
  sanitizeUrl,
  scrubStructuralKey,
  scrubText,
  truncateUtf8HeadTail,
  type ProjectionMode,
  type SecretVault,
  REDACT_V,
} from './redact.ts'

export const DESC_V = 1
export const EXTRACTOR_V = 1
export const MAX_PREFIX_BYTES = 65_536
export const MAX_SAMPLE_BODY_BYTES = 4_096

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const OVERRIDE_HEADERS = ['x-http-method', 'x-http-method-override', 'x-method-override'] as const
const VALID_VERB_RE = /^[A-Z]{3,16}$/

export type BodyOmittedReason =
  | 'live'
  | 'auth-url'
  | 'binary'
  | 'budget'
  | 'decompress-err'
  | 'timeout'
  | 'policy-profile'

export type SemanticAction = {
  family: 'e1-ais' | 'sharepoint' | 'graphql' | 'soap' | 'rest' | 'api' | 'upgrade' | 'graph' | 'databricks' | 'service'
  op: string
  resource?: string
  details?: Record<string, unknown>
  coverage: 'complete' | 'partial' | 'opaque-batch' | 'persisted-query-unknown' | 'unknown'
}

export type Completeness = {
  transport: 'complete' | 'truncated' | 'not-read'
  decode: 'complete' | 'truncated' | 'error' | 'none'
  extract: 'complete' | 'partial' | 'opaque' | 'none'
  reasons?: string[]
}

export type GraphqlOp = 'query' | 'mutation' | 'subscription' | 'mixed' | 'persisted'

export type PolicyDecision = {
  decisionId: string
  mode: 'observe' | 'shadow' | 'enforce'
  stage: 1 | 2
  action: 'allow' | 'deny' | 'escalate' | 'requireApproval'
  ruleId: string
  policyVersion: string
  surface?: 'browser' | 'api'
  family?: string
  reason?: string
  ms: number
  approvalRef?: string
}

export type SafeRequestProjection = {
  descV: 1
  redactV: 1
  extractorV: 1
  surface: 'browser' | 'api'
  target: { site: string } | { connection: string }
  seq: number
  t: string
  kind: 'http' | 'upgrade'
  scheme: 'http' | 'https'
  authority: string
  path: string
  url: string
  method: string
  effectiveMethod: string
  methodSource: 'wire' | 'x-http-method' | 'x-http-method-override' | 'x-method-override'
  isWrite: boolean
  hdr?: Record<string, string>
  hdrConflict?: true
  dest?: string
  from?: string
  reqType?: string
  declaredBytes?: number
  prefixBytes: number
  bodyComplete: boolean
  decodeComplete: boolean
  completeness: Completeness
  actions: SemanticAction[]
  bodyShape?: Record<string, string>
  graphqlOp?: GraphqlOp
  dupKeys?: true
  vaultRedactions?: number
  cdpCursor?: number
  httpCursor?: number
  siteConfigRev?: number
  live?: true
  reqBody?: string
  reqTrunc?: true
  reqOmitted?: BodyOmittedReason
}

export type RequestDescriptor = {
  safe: SafeRequestProjection
  raw?: {
    url: string
    parsedBody?: unknown
    rawBodyText?: string
    declaredBytes?: number
  }
}

export type PolicyContext = {
  decisionId: string
  signal: AbortSignal
  deadlineMs: number
  intent?: { run: number; series?: string; taskSummary?: string }
  recentCdpCursor?: number
  recentHttpCursor?: number
}

export type PolicyHookConfig = {
  mode: 'shadow' | 'enforce'
  liveMode?: 'enforce' | 'shadow' | 'allow'
  deadlineMs?: number
  evaluate: (d: RequestDescriptor, ctx: PolicyContext) => PolicyDecision | Promise<PolicyDecision>
}

export type SemanticMethodInfo = {
  wireMethod: string
  effectiveMethod: string
  methodSource: SafeRequestProjection['methodSource']
  hdr?: Record<string, string>
  hdrConflict: boolean
  invalidOrConflictingOverride: boolean
  attemptedDowngrade: boolean
  overrideEscalated: boolean
  vaultRedactions: number
}

export function parseSemanticMethods(
  method: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  vault?: SecretVault,
): SemanticMethodInfo {
  const wireMethod = (method ?? 'GET').toUpperCase()
  const hdr: Record<string, string> = {}
  let vaultRedactions = 0
  let invalid = false
  const validTokens: Array<{ header: typeof OVERRIDE_HEADERS[number]; verb: string }> = []

  for (const name of OVERRIDE_HEADERS) {
    const rawVal = headers[name]
    if (rawVal === undefined) continue
    const joined = Array.isArray(rawVal) ? rawVal.join(',') : rawVal
    const scrubbed = scrubText(truncateUtf8HeadTail(joined, 256), vault)
    vaultRedactions += scrubbed.vaultRedactions
    hdr[name] = scrubbed.text

    const parts = joined.split(',').map(p => p.trim().toUpperCase())
    if (!parts.length) {
      invalid = true
      continue
    }
    for (const p of parts) {
      if (!p || !VALID_VERB_RE.test(p)) invalid = true
      else validTokens.push({ header: name, verb: p })
    }
  }

  const soapRaw = headers['soapaction']
  if (soapRaw !== undefined) {
    const joined = Array.isArray(soapRaw) ? soapRaw.join(',') : soapRaw
    const scrubbed = scrubText(truncateUtf8HeadTail(joined, 256), vault)
    vaultRedactions += scrubbed.vaultRedactions
    hdr.soapaction = scrubbed.text
  }

  const distinctVerbs = [...new Set(validTokens.map(v => v.verb))]
  const hdrConflict = distinctVerbs.length > 1
  const invalidOrConflictingOverride = invalid || hdrConflict

  let effectiveMethod = wireMethod
  let methodSource: SafeRequestProjection['methodSource'] = 'wire'
  let attemptedDowngrade = false
  let overrideEscalated = false

  if (validTokens.length > 0) {
    const unsafe = validTokens.find(v => !SAFE_METHODS.has(v.verb))
    if (unsafe) {
      effectiveMethod = unsafe.verb
      methodSource = unsafe.header
      if (SAFE_METHODS.has(wireMethod)) overrideEscalated = true
    } else if (SAFE_METHODS.has(wireMethod)) {
      effectiveMethod = validTokens[0].verb
      methodSource = validTokens[0].header
    } else {
      // Never downgrade write -> read
      effectiveMethod = wireMethod
      methodSource = 'wire'
      attemptedDowngrade = true
    }
  }

  return {
    wireMethod,
    effectiveMethod,
    methodSource,
    hdr: Object.keys(hdr).length ? hdr : undefined,
    hdrConflict,
    invalidOrConflictingOverride,
    attemptedDowngrade,
    overrideEscalated,
    vaultRedactions,
  }
}

export type DecompressResult = {
  ok: boolean
  buf: Buffer
  decodeComplete: boolean
  decode: 'complete' | 'truncated' | 'error' | 'none'
  truncated: boolean
  reason?: string
  budgetExceeded?: boolean
  chargedBytes?: number
}

export type DecodeBudgetCharger = {
  tryAcquire: (bytes: number) => boolean
  release: (bytes: number) => void
}

const SUPPORTED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd'])

function decompressSingleLayer(
  input: Buffer,
  encoding: string,
  inputComplete: boolean,
  maxBytes: number,
  maxMs: number,
  charger?: DecodeBudgetCharger,
  rawDeflateFallback = false,
): Promise<DecompressResult> {
  return new Promise(resolve => {
    let stream: zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | zlib.BrotliDecompress | zlib.ZstdDecompress
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        stream = inputComplete ? zlib.createGunzip() : zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
      } else if (encoding === 'deflate') {
        if (rawDeflateFallback) {
          stream = inputComplete ? zlib.createInflateRaw() : zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
        } else {
          stream = inputComplete ? zlib.createInflate() : zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
        }
      } else if (encoding === 'br') {
        stream = inputComplete ? zlib.createBrotliDecompress() : zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
      } else if (encoding === 'zstd') {
        stream = zlib.createZstdDecompress()
      } else {
        resolve({ ok: false, buf: Buffer.alloc(0), decodeComplete: false, decode: 'error', truncated: false, reason: 'unsupported-encoding' })
        return
      }
    } catch {
      resolve({ ok: false, buf: Buffer.alloc(0), decodeComplete: false, decode: 'error', truncated: false, reason: 'codec-init-error' })
      return
    }

    let outBuf = Buffer.alloc(0)
    let outBytes = 0
    let charged = 0
    let done = false
    const start = performance.now()

    const releaseAll = () => {
      if (charged > 0 && charger) {
        charger.release(charged)
        charged = 0
      }
      outBuf = Buffer.alloc(0)
      outBytes = 0
    }

    const timer = setTimeout(() => {
      if (done) return
      done = true
      stream.destroy()
      resolve({
        ok: true,
        buf: outBuf.subarray(0, outBytes),
        decodeComplete: false,
        decode: 'truncated',
        truncated: true,
        reason: 'decompress-cpu-limit',
        chargedBytes: charged,
      })
    }, maxMs)
    timer.unref?.()

    const finish = (res: DecompressResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res)
    }

    stream.on('data', (c: Buffer) => {
      if (done) return
      if (performance.now() - start > maxMs) {
        stream.destroy()
        finish({
          ok: true,
          buf: outBuf.subarray(0, outBytes),
          decodeComplete: false,
          decode: 'truncated',
          truncated: true,
          reason: 'decompress-cpu-limit',
          chargedBytes: charged,
        })
        return
      }
      const need = Math.min(c.length, maxBytes - outBytes)
      if (need > 0) {
        if (outBytes + need > outBuf.length) {
          const oldLen = outBuf.length
          const nextCap = Math.min(maxBytes, Math.max(4096, oldLen * 2, outBytes + need))
          if (charger && !charger.tryAcquire(nextCap)) {
            stream.destroy()
            releaseAll()
            finish({
              ok: false,
              buf: Buffer.alloc(0),
              decodeComplete: false,
              decode: 'error',
              truncated: true,
              reason: 'inflight-budget',
              budgetExceeded: true,
              chargedBytes: 0,
            })
            return
          }
          const next = Buffer.allocUnsafe(nextCap)
          if (outBytes > 0) outBuf.copy(next, 0, 0, outBytes)
          outBuf = next
          if (charger) {
            if (oldLen > 0) charger.release(oldLen)
            charged = nextCap
          }
        }
        c.copy(outBuf, outBytes, 0, need)
        outBytes += need
      }
      if (outBytes >= maxBytes) {
        stream.destroy()
        finish({
          ok: true,
          buf: outBuf.subarray(0, outBytes),
          decodeComplete: false,
          decode: 'truncated',
          truncated: true,
          reason: '>64KiB-decoded',
          chargedBytes: charged,
        })
      }
    })

    stream.on('end', () => {
      const buf = outBuf.subarray(0, outBytes)
      if (!inputComplete) {
        finish({ ok: true, buf, decodeComplete: false, decode: 'truncated', truncated: true, reason: '>64KiB', chargedBytes: charged })
      } else {
        finish({ ok: true, buf, decodeComplete: true, decode: 'complete', truncated: false, chargedBytes: charged })
      }
    })

    stream.on('error', () => {
      const buf = outBuf.subarray(0, outBytes)
      if (!inputComplete) {
        finish({ ok: true, buf, decodeComplete: false, decode: 'truncated', truncated: true, reason: '>64KiB', chargedBytes: charged })
        return
      }
      releaseAll()
      if (encoding === 'deflate' && !rawDeflateFallback) {
        clearTimeout(timer)
        done = true
        void decompressSingleLayer(input, encoding, inputComplete, maxBytes, maxMs, charger, true).then(resolve)
        return
      }
      finish({ ok: false, buf: Buffer.alloc(0), decodeComplete: false, decode: 'error', truncated: false, reason: 'decompress-err', chargedBytes: 0 })
    })

    const SLICE = 4096
    let offset = 0
    const pump = () => {
      while (!done && offset < input.length) {
        const end = Math.min(offset + SLICE, input.length)
        const slice = input.subarray(offset, end)
        offset = end
        if (!stream.write(slice)) {
          stream.once('drain', pump)
          return
        }
      }
      if (!done) stream.end()
    }
    pump()
  })
}

export async function decompressPrefix(
  rawBuf: Buffer,
  contentEncoding: string | undefined,
  bodyComplete: boolean,
  maxBytes = MAX_PREFIX_BYTES,
  maxMs = 50,
  charger?: DecodeBudgetCharger,
): Promise<DecompressResult> {
  if (rawBuf.length === 0) {
    return { ok: true, buf: rawBuf, decodeComplete: bodyComplete, decode: 'none', truncated: !bodyComplete, chargedBytes: 0 }
  }
  const encodings = (contentEncoding ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s && s !== 'identity')
  if (encodings.length === 0) {
    return {
      ok: true,
      buf: rawBuf.subarray(0, maxBytes),
      decodeComplete: bodyComplete && rawBuf.length <= maxBytes,
      decode: bodyComplete && rawBuf.length <= maxBytes ? 'complete' : 'truncated',
      truncated: !bodyComplete || rawBuf.length > maxBytes,
      chargedBytes: 0,
    }
  }
  if (encodings.length > 2 || encodings.some(e => !SUPPORTED_ENCODINGS.has(e))) {
    return {
      ok: false,
      buf: Buffer.alloc(0),
      decodeComplete: false,
      decode: 'error',
      truncated: false,
      reason: 'unsupported-encoding',
      chargedBytes: 0,
    }
  }
  let curBuf = rawBuf
  let curComplete = bodyComplete
  let curCharged = 0
  let anyTruncated = !bodyComplete
  for (let i = encodings.length - 1; i >= 0; i--) {
    const res = await decompressSingleLayer(curBuf, encodings[i], curComplete, maxBytes, maxMs, charger)
    if (curCharged > 0 && charger) {
      charger.release(curCharged)
      curCharged = 0
    }
    if (!res.ok) return res
    curBuf = res.buf
    curComplete = res.decodeComplete
    curCharged = res.chargedBytes ?? 0
    if (res.truncated) anyTruncated = true
  }
  return {
    ok: true,
    buf: curBuf,
    decodeComplete: curComplete && !anyTruncated,
    decode: curComplete && !anyTruncated ? 'complete' : 'truncated',
    truncated: anyTruncated,
    chargedBytes: curCharged,
  }
}

const SAFE_MIME_RE = /^[a-z0-9!#$&^_.+-]{1,40}\/[a-z0-9!#$&^_.+-]{1,64}$/
const STANDARD_MIME_TYPES = new Set(['application', 'audio', 'font', 'image', 'message', 'model', 'multipart', 'text', 'video'])

export function normalizeContentType(header: string | undefined, vault?: SecretVault): string | undefined {
  if (!header) return undefined
  const rawEssence = header.split(';')[0].trim()
  if (!rawEssence) return undefined
  const essence = rawEssence.toLowerCase()
  if (vault && (vault.scrub(rawEssence).count > 0 || vault.scrub(essence).count > 0)) {
    return 'application/octet-stream'
  }
  if (!SAFE_MIME_RE.test(essence)) return 'application/octet-stream'
  const slashIdx = rawEssence.indexOf('/')
  const rawSub = slashIdx >= 0 ? rawEssence.slice(slashIdx + 1) : ''
  const [type, subtype] = essence.split('/')
  if (!STANDARD_MIME_TYPES.has(type)) return 'application/octet-stream'
  if (isSensitiveValue(rawSub) || isSensitiveValue(subtype) || isDataLikeKey(rawSub) || isDataLikeKey(subtype)) {
    return `${type}/<redacted>`
  }
  return essence
}

export function isBinaryContentType(reqType: string | undefined): boolean {
  if (!reqType) return false
  if (reqType === 'multipart/form-data') return true
  if (reqType.startsWith('image/') || reqType.startsWith('video/') || reqType.startsWith('audio/') || reqType.startsWith('font/')) return true
  if (
    reqType === 'application/octet-stream' ||
    reqType === 'application/pdf' ||
    reqType === 'application/zip' ||
    reqType === 'application/gzip' ||
    reqType === 'application/wasm'
  ) {
    return true
  }
  return false
}

export function hasBinaryMagic(buf: Buffer): boolean {
  if (!buf.length) return false
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true
    if (buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && (buf[3] === 0x46 || buf[3] === 0x32)) return true
  }
  if (buf.includes(0x00)) return true
  return false
}

export function decodeUtf8Prefix(buf: Buffer, truncated: boolean): string | null {
  if (!buf.length) return ''
  const dec = new TextDecoder('utf-8', { fatal: true })
  const maxTrim = truncated ? Math.min(3, buf.length) : 0
  for (let trim = 0; trim <= maxTrim; trim++) {
    try {
      return dec.decode(trim ? buf.subarray(0, buf.length - trim) : buf)
    } catch {
      // retry with one fewer trailing byte if truncated mid-codepoint
    }
  }
  return null
}

export function classifyGraphqlQuery(
  query: string,
  operationName?: string,
): { op: GraphqlOp; opNames: string[]; opKinds: string[] } {
  type OpDef = { kind: 'query' | 'mutation' | 'subscription'; name?: string }
  const ops: OpDef[] = []
  const len = query.length
  let i = 0
  let depth = 0
  let pendingOp: 'query' | 'mutation' | 'subscription' | null = null
  let pendingName: string | undefined
  let skippingFragmentHeader = false

  const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
  const isNameCont = (c: number) => isNameStart(c) || (c >= 48 && c <= 57)

  while (i < len) {
    const ch = query[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',' || ch === '\ufeff') {
      i++
      continue
    }
    if (ch === '#') {
      while (i < len && query[i] !== '\n' && query[i] !== '\r') i++
      continue
    }
    if (ch === '"') {
      if (query.startsWith('"""', i)) {
        i += 3
        while (i < len) {
          if (query[i] === '\\' && query.startsWith('"""', i + 1)) {
            i += 4
            continue
          }
          if (query.startsWith('"""', i)) {
            i += 3
            break
          }
          i++
        }
      } else {
        i++
        while (i < len) {
          if (query[i] === '\\') {
            i += 2
            continue
          }
          if (query[i] === '"') {
            i++
            break
          }
          i++
        }
      }
      continue
    }
    if (ch === '{') {
      if (depth === 0) {
        if (skippingFragmentHeader) {
          skippingFragmentHeader = false
        } else if (pendingOp) {
          ops.push({ kind: pendingOp, name: pendingName })
          pendingOp = null
          pendingName = undefined
        } else {
          ops.push({ kind: 'query', name: undefined })
        }
      }
      depth++
      i++
      continue
    }
    if (ch === '}') {
      if (depth > 0) depth--
      i++
      continue
    }
    if (ch === '(') {
      let pDepth = 1
      i++
      while (i < len && pDepth > 0) {
        const pc = query[i]
        if (pc === '"') {
          if (query.startsWith('"""', i)) {
            i += 3
            while (i < len && !query.startsWith('"""', i)) i += query[i] === '\\' ? 2 : 1
            i += 3
          } else {
            i++
            while (i < len && query[i] !== '"') i += query[i] === '\\' ? 2 : 1
            i++
          }
          continue
        }
        if (pc === '#') {
          while (i < len && query[i] !== '\n') i++
          continue
        }
        if (pc === '(') pDepth++
        else if (pc === ')') pDepth--
        i++
      }
      continue
    }
    if (ch === '@') {
      i++
      while (i < len && isNameCont(query.charCodeAt(i))) i++
      continue
    }
    const code = query.charCodeAt(i)
    if (isNameStart(code)) {
      const start = i
      i++
      while (i < len && isNameCont(query.charCodeAt(i))) i++
      if (depth === 0) {
        const word = query.slice(start, i)
        if (word === 'fragment') {
          skippingFragmentHeader = true
          pendingOp = null
          pendingName = undefined
        } else if (word === 'query' || word === 'mutation' || word === 'subscription') {
          if (!skippingFragmentHeader) {
            pendingOp = word
            pendingName = undefined
          }
        } else if (pendingOp && pendingName === undefined && !skippingFragmentHeader) {
          pendingName = word
        }
      }
      continue
    }
    i++
  }

  const opNames = ops.map(o => o.name ?? '<anonymous>')
  const opKinds = ops.map(o => o.kind)

  if (ops.length === 0) {
    return { op: 'mixed', opNames, opKinds }
  }
  if (operationName) {
    const matches = ops.filter(o => o.name === operationName)
    if (matches.length !== 1) return { op: 'mixed', opNames, opKinds }
    return { op: matches[0].kind, opNames, opKinds }
  }
  if (ops.length === 1) {
    return { op: ops[0].kind, opNames, opKinds }
  }
  return { op: 'mixed', opNames, opKinds }
}

export function extractSoapBodyRoot(xml: string): string | undefined {
  const clean = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  const bodyMatch = /<(?:[A-Za-z_][\w.-]*:)?Body(?:\s[^>]*)?>([\s\S]*)/i.exec(clean)
  if (!bodyMatch) return undefined
  const inside = bodyMatch[1]
  const childMatch = /<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?=[\s/>])/.exec(inside)
  return childMatch?.[1]
}

// ---- SQL classifier for Databricks statements (comment & string literal safe, zero PII emitted) ----

export type SqlClassification = {
  sqlClass: 'read' | 'write' | 'ddl' | 'unknown'
  statements: string[]
  destructive: boolean
}

const SQL_READ_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'LIST'])
const SQL_WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'CALL', 'PUT'])
const SQL_DDL_VERBS = new Set(['DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'REPLACE', 'GRANT', 'REVOKE', 'OPTIMIZE', 'VACUUM', 'RESTORE'])
const SQL_DESTRUCTIVE_VERBS = new Set(['DROP', 'TRUNCATE', 'DELETE'])

export function classifySqlStatement(sql: string): SqlClassification {
  type Tok = { kind: 'word' | 'lparen' | 'rparen' | 'comma' | 'semi'; text: string }
  const tokens: Tok[] = []
  let i = 0
  const len = sql.length

  while (i < len) {
    const ch = sql[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue }
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < len && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === "'") {
      i++
      while (i < len) {
        if (sql[i] === '\\') { i += 2; continue }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      continue
    }
    if (ch === '"' || ch === '`') {
      const q = ch
      const start = i
      i++
      while (i < len) {
        if (sql[i] === '\\') { i += 2; continue }
        if (sql[i] === q && sql[i + 1] === q) { i += 2; continue }
        if (sql[i] === q) { i++; break }
        i++
      }
      tokens.push({ kind: 'word', text: sql.slice(start, i) })
      continue
    }
    if (ch === '(') { tokens.push({ kind: 'lparen', text: '(' }); i++; continue }
    if (ch === ')') { tokens.push({ kind: 'rparen', text: ')' }); i++; continue }
    if (ch === ',') { tokens.push({ kind: 'comma', text: ',' }); i++; continue }
    if (ch === ';') { tokens.push({ kind: 'semi', text: ';' }); i++; continue }
    const c = sql.charCodeAt(i)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      const start = i
      i++
      while (i < len) {
        const cc = sql.charCodeAt(i)
        if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 95) i++
        else break
      }
      tokens.push({ kind: 'word', text: sql.slice(start, i).toUpperCase() })
      continue
    }
    i++
  }

  // Split token stream into top-level statements separated by ';' at parenDepth === 0
  const rawStmts: Tok[][] = []
  let cur: Tok[] = []
  let depth = 0
  for (const t of tokens) {
    if (t.kind === 'lparen') depth++
    else if (t.kind === 'rparen' && depth > 0) depth--
    if (t.kind === 'semi' && depth === 0) {
      if (cur.length) rawStmts.push(cur)
      cur = []
    } else {
      cur.push(t)
    }
  }
  if (cur.length) rawStmts.push(cur)

  const skipParenGroup = (arr: Tok[], idx: number): number => {
    if (arr[idx]?.kind !== 'lparen') return -1
    let d = 1
    let p = idx + 1
    while (p < arr.length && d > 0) {
      if (arr[p].kind === 'lparen') d++
      else if (arr[p].kind === 'rparen') d--
      p++
    }
    return d === 0 ? p : -1
  }

  const statements: string[] = []
  for (const stmt of rawStmts) {
    const first = stmt[0]
    if (!first || first.kind !== 'word') {
      statements.push('UNKNOWN')
      continue
    }
    let verb = first.text
    if (verb === 'WITH') {
      // Strictly parse CTE list: WITH [RECURSIVE] <name> [(cols)] AS [MATERIALIZED|NOT MATERIALIZED] (<subquery>) [, ...] <mainVerb>
      let p = 1
      if (stmt[p]?.kind === 'word' && stmt[p].text === 'RECURSIVE') p++
      let ok = false
      for (;;) {
        // CTE name (may be any identifier, even a keyword like `select`!)
        if (stmt[p]?.kind !== 'word') { ok = false; break }
        p++
        // Optional column list (...)
        if (stmt[p]?.kind === 'lparen') {
          p = skipParenGroup(stmt, p)
          if (p < 0) { ok = false; break }
        }
        if (stmt[p]?.kind !== 'word' || stmt[p].text !== 'AS') { ok = false; break }
        p++
        // Optional NOT MATERIALIZED / MATERIALIZED
        if (stmt[p]?.kind === 'word' && stmt[p].text === 'NOT') p++
        if (stmt[p]?.kind === 'word' && stmt[p].text === 'MATERIALIZED') p++
        // Required CTE subquery (...)
        if (stmt[p]?.kind !== 'lparen') { ok = false; break }
        p = skipParenGroup(stmt, p)
        if (p < 0) { ok = false; break }
        if (stmt[p]?.kind === 'comma') {
          p++
          continue
        }
        ok = true
        break
      }
      if (!ok || stmt[p]?.kind !== 'word') {
        statements.push('UNKNOWN')
        continue
      }
      verb = stmt[p].text
    }
    // Defense-in-depth: if any top-level word in the statement after CTEs is a write/DDL verb, never misclassify as read!
    if (SQL_READ_VERBS.has(verb)) {
      let d = 0
      let hasMutatingTopLevel = false
      for (let k = 1; k < stmt.length; k++) {
        const tk = stmt[k]
        if (tk.kind === 'lparen') d++
        else if (tk.kind === 'rparen' && d > 0) d--
        else if (d === 0 && tk.kind === 'word' && k > 0 && stmt[k - 1]?.text !== 'AS') {
          // Only flag unmistakable destructive/DML top-level keywords (not e.g. `ORDER` or column aliases)
          if (tk.text === 'DELETE' || tk.text === 'DROP' || tk.text === 'TRUNCATE' || tk.text === 'MERGE' || tk.text === 'INSERT' || tk.text === 'UPDATE') {
            hasMutatingTopLevel = true
            verb = tk.text
            break
          }
        }
      }
      if (hasMutatingTopLevel) {
        statements.push(verb)
        continue
      }
    }
    statements.push(verb)
  }

  if (!statements.length) return { sqlClass: 'unknown', statements: [], destructive: false }

  const destructive = statements.some(v => SQL_DESTRUCTIVE_VERBS.has(v))
  if (statements.some(v => SQL_DDL_VERBS.has(v))) {
    return { sqlClass: 'ddl', statements: statements.slice(0, 16), destructive }
  }
  if (statements.some(v => SQL_WRITE_VERBS.has(v))) {
    return { sqlClass: 'write', statements: statements.slice(0, 16), destructive }
  }
  if (statements.every(v => SQL_READ_VERBS.has(v))) {
    return { sqlClass: 'read', statements: statements.slice(0, 16), destructive: false }
  }
  return { sqlClass: 'unknown', statements: statements.slice(0, 16), destructive }
}

// ---- Graph API semantic helpers (domains & counts only, NEVER raw addresses/subject/body PII) ----

function extractRecipientDomains(obj: Record<string, unknown> | undefined): { domains: string[]; count: number } {
  if (!obj) return { domains: [], count: 0 }
  const msg = (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)
    ? obj.message
    : obj.Message && typeof obj.Message === 'object' && !Array.isArray(obj.Message)
      ? obj.Message
      : obj) as Record<string, unknown>
  const fields = ['toRecipients', 'ccRecipients', 'bccRecipients', 'ToRecipients', 'CcRecipients', 'BccRecipients']
  const domains = new Set<string>()
  let count = 0
  for (const f of fields) {
    const arr = msg[f]
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const ea = (rec.emailAddress ?? rec.EmailAddress) as Record<string, unknown> | undefined
      const addr = typeof ea?.address === 'string' ? ea.address : typeof ea?.Address === 'string' ? ea.Address : undefined
      if (addr) {
        count++
        const at = addr.lastIndexOf('@')
        if (at >= 0) {
          const dom = addr.slice(at + 1).trim().toLowerCase()
          if (dom && /^[a-z0-9.-]+$/.test(dom) && domains.size < 32) domains.add(dom)
        }
      }
    }
  }
  return { domains: [...domains].sort(), count }
}

function extractAttachmentCount(obj: Record<string, unknown> | undefined): number {
  if (!obj) return 0
  const msg = (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)
    ? obj.message
    : obj.Message && typeof obj.Message === 'object' && !Array.isArray(obj.Message)
      ? obj.Message
      : obj) as Record<string, unknown>
  const att = msg.attachments ?? msg.Attachments
  return Array.isArray(att) ? att.length : 0
}

function extractMimeRecipientDomains(rawText: string): { domains: string[]; count: number } {
  try {
    const b64 = rawText.replace(/[ \t\r\n]/g, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4) return { domains: [], count: 0 }
    const decoded = Buffer.from(b64, 'base64').toString('latin1')
    const headEnd = decoded.indexOf('\r\n\r\n')
    const head = headEnd >= 0 ? decoded.slice(0, headEnd) : decoded.slice(0, 8192)
    const unfolded = head.replace(/\r?\n[ \t]+/g, ' ')
    const domains = new Set<string>()
    let count = 0
    for (const line of unfolded.split(/\r?\n/)) {
      if (!/^(?:to|cc|bcc):/i.test(line)) continue
      const matches = line.match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g) ?? []
      for (const m of matches) {
        count++
        const dom = m.slice(m.lastIndexOf('@') + 1).toLowerCase()
        if (domains.size < 32) domains.add(dom)
      }
    }
    return { domains: [...domains].sort(), count }
  } catch {
    return { domains: [], count: 0 }
  }
}

export type ExtractInput = {
  url: URL
  sanitizedPath: string
  method: string
  effectiveMethod: string
  kind: 'http' | 'upgrade'
  surface?: 'browser' | 'api'
  connectionType?: 'graph' | 'databricks' | 'service' | 'link'
  hdr?: Record<string, string>
  rawHeaders: Record<string, string | string[] | undefined>
  reqType?: string
  decodedBuf?: Buffer
  decodeResult?: DecompressResult
  bodyComplete: boolean
  transport: 'complete' | 'truncated' | 'not-read'
  transportReasons?: string[]
  isWrite: boolean
  isAuth: boolean
  isLive: boolean
  projection: ProjectionMode
  vault?: SecretVault
  sampleBudgetOk?: boolean
}

export type ExtractOutput = {
  actions: SemanticAction[]
  bodyShape?: Record<string, string>
  graphqlOp?: GraphqlOp
  dupKeys?: true
  completeness: Completeness
  decodeComplete: boolean
  reqBody?: string
  reqTrunc?: true
  reqOmitted?: BodyOmittedReason
  vaultRedactions: number
  parsedBody?: unknown
  rawBodyText?: string
}

const E1_ENDPOINTS = new Set(['formservice', 'appstack', 'dataservice', 'orchestrator', 'file', 'tokenrequest', 'discover', 'defaultconfig'])
const STRUCT_IDENT_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/
const E1_CONTROL_ID_RE = /^[A-Za-z0-9_.-]{1,32}$/
const GQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/
const DBX_IDENT_RE = /^[A-Za-z0-9_.-]{1,64}$/

function validateStructuralIdent(
  val: unknown,
  pattern: RegExp,
  vault?: SecretVault,
  allowNumeric = false,
): { value?: string; vaultRedactions: number } {
  if (typeof val !== 'string' || !val) return { vaultRedactions: 0 }
  if (vault) {
    const sv = vault.scrub(val)
    if (sv.count > 0) return { vaultRedactions: sv.count }
  }
  if (!pattern.test(val)) return { vaultRedactions: 0 }
  if (isSensitiveValue(val)) return { vaultRedactions: 0 }
  if (!allowNumeric && isDataLikeKey(val)) return { vaultRedactions: 0 }
  return { value: val, vaultRedactions: 0 }
}

export function extractSemantic(input: ExtractInput): ExtractOutput {
  const reasons: string[] = [...(input.transportReasons ?? [])]
  let vaultRedactions = 0

  if (input.kind === 'upgrade') {
    return {
      actions: [{ family: 'upgrade', op: 'upgrade:websocket', resource: input.sanitizedPath, coverage: 'complete' }],
      completeness: { transport: 'not-read', decode: 'none', extract: 'complete', ...(reasons.length && { reasons }) },
      decodeComplete: true,
      vaultRedactions: 0,
    }
  }

  try {
    const rawBuf = input.decodedBuf ?? Buffer.alloc(0)
    const decodeRes = input.decodeResult
    const decodeStatus: Completeness['decode'] = decodeRes?.decode ?? (rawBuf.length ? (input.bodyComplete ? 'complete' : 'truncated') : 'none')
    const decodeComplete = decodeRes ? decodeRes.decodeComplete : input.bodyComplete

    if (decodeRes?.reason && !reasons.includes(decodeRes.reason)) reasons.push(decodeRes.reason)
    if (input.isAuth && !reasons.includes('auth-url')) reasons.push('auth-url')
    if (input.isLive && !reasons.includes('live')) reasons.push('live')

    if (decodeRes && !decodeRes.ok) {
      const actions: SemanticAction[] = input.isWrite
        ? [{ family: input.connectionType && input.connectionType !== 'link' ? input.connectionType : 'rest', op: `rest:${input.effectiveMethod}`, resource: input.sanitizedPath, coverage: 'unknown' }]
        : []
      return {
        actions,
        completeness: { transport: input.transport, decode: decodeRes.budgetExceeded ? 'truncated' : 'error', extract: 'none', ...(reasons.length && { reasons }) },
        decodeComplete: false,
        reqOmitted: input.isLive ? 'live' : input.isAuth ? 'auth-url' : decodeRes.budgetExceeded ? 'budget' : 'decompress-err',
        vaultRedactions,
      }
    }

    const hasBody = rawBuf.length > 0
    let isBinary = false
    let decodedText: string | undefined
    if (hasBody) {
      if (isBinaryContentType(input.reqType) || hasBinaryMagic(rawBuf)) {
        isBinary = true
        if (input.reqType === 'multipart/form-data') reasons.push('multipart')
        else reasons.push('binary')
      } else {
        const text = decodeUtf8Prefix(rawBuf, !decodeComplete || !input.bodyComplete)
        if (text === null) {
          isBinary = true
          reasons.push('invalid-utf8')
        } else {
          decodedText = text
        }
      }
    }

    let parsedJson: unknown
    let isJson = false
    let dupKeys = false
    let structuredJsonParseFailed = false
    if (decodedText !== undefined) {
      const trimmed = decodedText.trimStart()
      const looksJson = input.reqType === 'application/json' || Boolean(input.reqType?.endsWith('+json')) || trimmed.startsWith('{') || trimmed.startsWith('[')
      const parsed = parseJsonSafe(decodedText)
      if (parsed.ok) {
        isJson = true
        parsedJson = parsed.value
        dupKeys = parsed.dupKeys
        if (dupKeys) reasons.push('dupKeys')
      } else if (looksJson) {
        structuredJsonParseFailed = true
        reasons.push('json-parse-failed')
      }
    }

    let bodyShape: Record<string, string> | undefined
    if (!input.isLive && hasBody && !isBinary) {
      if (isJson && parsedJson !== null && typeof parsedJson === 'object') {
        const bs = buildBodyShape(parsedJson, input.vault)
        bodyShape = bs.shape
        vaultRedactions += bs.vaultRedactions
      } else if (decodedText !== undefined && input.reqType === 'application/x-www-form-urlencoded') {
        const bs = buildFormBodyShape(decodedText, input.vault)
        bodyShape = bs.shape
        vaultRedactions += bs.vaultRedactions
      }
    }

    const fullyIntact = input.bodyComplete && decodeComplete && !dupKeys
    const defaultCov: SemanticAction['coverage'] = fullyIntact ? 'complete' : 'partial'
    const lowerPath = input.url.pathname.toLowerCase()
    const actions: SemanticAction[] = []
    let graphqlOp: GraphqlOp | undefined
    let extractStatus: Completeness['extract'] = 'none'

    const obj = isJson && parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
      ? (parsedJson as Record<string, unknown>)
      : undefined

    // ---- API-native extractors (surface === 'api') ----
    const isGraph = input.connectionType === 'graph' || (input.surface === 'api' && input.url.hostname.toLowerCase() === 'graph.microsoft.com')
    const isDatabricks = input.connectionType === 'databricks' || (input.surface === 'api' && input.url.hostname.toLowerCase().endsWith('.azuredatabricks.net'))
    const isService = input.connectionType === 'service'

    if (isGraph) {
      const segs = lowerPath.replace(/^\/(?:v1\.0|beta)\//, '').split('/').filter(Boolean)
      const lastSeg = (segs.at(-1) ?? '').replace(/\(.*$/, '').split('.').pop() ?? ''
      const hasIfMatch = Boolean(input.rawHeaders['if-match'])
      const eff = input.effectiveMethod

      if (input.isWrite && ['sendmail', 'send', 'reply', 'replyall', 'forward'].includes(lastSeg)) {
        const isMime = !isJson && input.reqType === 'text/plain' && decodedText !== undefined
        const recips = isMime ? extractMimeRecipientDomains(decodedText!) : extractRecipientDomains(obj)
        const attachmentCount = isMime ? 0 : extractAttachmentCount(obj)
        const opName = lastSeg === 'sendmail' ? 'sendMail' : lastSeg === 'replyall' ? 'replyAll' : lastSeg
        actions.push({
          family: 'graph',
          op: `graph:${opName}`,
          resource: input.sanitizedPath,
          details: {
            recipientDomains: recips.domains,
            recipientCount: recips.count,
            attachmentCount,
            ...(isMime && { isMime: true }),
          },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && eff === 'POST' && lastSeg === 'messages' && (segs.includes('chats') || segs.includes('channels'))) {
        actions.push({
          family: 'graph',
          op: 'graph:teams_message',
          resource: input.sanitizedPath,
          details: { ...(bodyShape && { fieldCount: Object.keys(bodyShape).length }) },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && eff === 'POST' && lastSeg === 'messages') {
        const recips = extractRecipientDomains(obj)
        const attachmentCount = extractAttachmentCount(obj)
        actions.push({
          family: 'graph',
          op: 'graph:draft',
          resource: input.sanitizedPath,
          details: {
            recipientDomains: recips.domains,
            recipientCount: recips.count,
            attachmentCount,
          },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && (segs.includes('messages') || segs.includes('mailfolders')) && (eff === 'PATCH' || lastSeg === 'move')) {
        const fields = obj ? Object.keys(obj).slice(0, 32).map(k => scrubStructuralKey(k, input.vault).key) : []
        actions.push({
          family: 'graph',
          op: 'graph:mail_patch',
          resource: input.sanitizedPath,
          details: { ...(fields.length && { fields }), hasIfMatch },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && segs.includes('workbook')) {
        actions.push({
          family: 'graph',
          op: 'graph:excel_write',
          resource: input.sanitizedPath,
          details: { method: eff, hasIfMatch },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && eff === 'PUT' && lastSeg === 'content') {
        actions.push({
          family: 'graph',
          op: 'graph:file_write',
          resource: input.sanitizedPath,
          details: { hasIfMatch },
          coverage: isBinary ? 'complete' : defaultCov,
        })
        extractStatus = 'complete'
      } else if (input.isWrite && (eff === 'DELETE' || input.method === 'DELETE') && (segs.includes('drives') || segs.includes('drive') || segs.includes('items') || segs.includes('shares'))) {
        actions.push({
          family: 'graph',
          op: 'graph:file_delete',
          resource: input.sanitizedPath,
          details: { hasIfMatch },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite) {
        actions.push({
          family: 'graph',
          op: `graph:${eff}`,
          resource: input.sanitizedPath,
          details: { hasIfMatch },
          coverage: isBinary || structuredJsonParseFailed ? 'partial' : defaultCov,
        })
        extractStatus = isBinary || structuredJsonParseFailed ? 'opaque' : fullyIntact ? 'complete' : 'partial'
      } else {
        actions.push({
          family: 'graph',
          op: `graph:${eff}`,
          resource: input.sanitizedPath,
          coverage: 'complete',
        })
        extractStatus = 'complete'
      }
    } else if (isDatabricks) {
      const cleanPath = lowerPath.replace(/\/$/, '')
      if (cleanPath === '/api/2.0/sql/statements' && input.effectiveMethod === 'POST') {
        const stmtRaw = typeof obj?.statement === 'string' ? obj.statement : undefined
        const cls = stmtRaw ? classifySqlStatement(stmtRaw) : { sqlClass: 'unknown' as const, statements: [], destructive: false }
        const details: Record<string, unknown> = {
          sqlClass: cls.sqlClass,
          statements: cls.statements,
          destructive: cls.destructive,
        }
        const wh = validateStructuralIdent(obj?.warehouse_id, DBX_IDENT_RE, input.vault, true)
        vaultRedactions += wh.vaultRedactions
        if (wh.value) details.warehouseId = wh.value
        const cat = validateStructuralIdent(obj?.catalog, DBX_IDENT_RE, input.vault)
        vaultRedactions += cat.vaultRedactions
        if (cat.value) details.catalog = cat.value
        const sch = validateStructuralIdent(obj?.schema, DBX_IDENT_RE, input.vault)
        vaultRedactions += sch.vaultRedactions
        if (sch.value) details.schema = sch.value

        actions.push({
          family: 'databricks',
          op: `databricks:sql_${cls.sqlClass}`,
          resource: wh.value ?? input.sanitizedPath,
          details,
          coverage: stmtRaw && fullyIntact ? 'complete' : 'partial',
        })
        extractStatus = stmtRaw && fullyIntact ? 'complete' : 'partial'
      } else if (cleanPath.startsWith('/api/2.0/sql/statements/') && cleanPath.endsWith('/cancel')) {
        actions.push({ family: 'databricks', op: 'databricks:sql_cancel', resource: input.sanitizedPath, coverage: 'complete' })
        extractStatus = 'complete'
      } else if (cleanPath.startsWith('/api/2.0/sql/statements/')) {
        actions.push({ family: 'databricks', op: 'databricks:sql_status', resource: input.sanitizedPath, coverage: 'complete' })
        extractStatus = 'complete'
      } else if (cleanPath.startsWith('/api/2.1/unity-catalog/')) {
        actions.push({
          family: 'databricks',
          op: `databricks:unity_catalog_${input.effectiveMethod}`,
          resource: input.sanitizedPath,
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else {
        actions.push({
          family: 'databricks',
          op: `databricks:${input.effectiveMethod}`,
          resource: input.sanitizedPath,
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      }
    } else if (isService) {
      const hasIfMatch = Boolean(input.rawHeaders['if-match'])
      actions.push({
        family: 'service',
        op: `service:${input.effectiveMethod}`,
        resource: input.sanitizedPath,
        ...(hasIfMatch && { details: { hasIfMatch: true } }),
        coverage: isBinary || structuredJsonParseFailed ? 'partial' : defaultCov,
      })
      extractStatus = isBinary || structuredJsonParseFailed ? 'opaque' : fullyIntact ? 'complete' : 'partial'
    }

    // ---- Browser & general HTTP extractors (identical to rollforward-browser) ----
    else if (
      lowerPath.includes('/jderest/') ||
      (!!obj && typeof obj.formName === 'string' && (Array.isArray(obj.formActions) || typeof obj.formServiceAction === 'string' || 'actionRequest' in obj || 'formRequest' in obj))
    ) {
      const m = /\/jderest\/(?:v\d+\/)?([^/;?]+)/i.exec(input.url.pathname)
      const rawEndpoint = m ? m[1].toLowerCase() : 'ais'
      const endpoint = E1_ENDPOINTS.has(rawEndpoint) ? rawEndpoint : 'ais'

      const details: Record<string, unknown> = {}
      const rawFormName = typeof obj?.formName === 'string'
        ? obj.formName
        : typeof (obj?.formRequest as any)?.formName === 'string'
          ? (obj!.formRequest as any).formName
          : typeof obj?.targetName === 'string'
            ? obj.targetName
            : undefined

      const formIdent = validateStructuralIdent(rawFormName, STRUCT_IDENT_RE, input.vault)
      vaultRedactions += formIdent.vaultRedactions
      if (formIdent.value) details.formName = formIdent.value

      const verIdent = validateStructuralIdent(obj?.version, STRUCT_IDENT_RE, input.vault)
      vaultRedactions += verIdent.vaultRedactions
      if (verIdent.value) details.version = verIdent.value

      const rawAction = typeof obj?.action === 'string' ? obj.action : typeof obj?.formServiceAction === 'string' ? obj.formServiceAction : undefined
      const actIdent = validateStructuralIdent(rawAction, /^[A-Za-z][A-Za-z0-9_-]{0,23}$/, input.vault)
      vaultRedactions += actIdent.vaultRedactions
      if (actIdent.value) details.action = actIdent.value

      const targetTypeIdent = validateStructuralIdent(obj?.targetType, STRUCT_IDENT_RE, input.vault)
      vaultRedactions += targetTypeIdent.vaultRedactions
      if (targetTypeIdent.value) details.targetType = targetTypeIdent.value

      const dsTypeIdent = validateStructuralIdent(obj?.dataServiceType, STRUCT_IDENT_RE, input.vault)
      vaultRedactions += dsTypeIdent.vaultRedactions
      if (dsTypeIdent.value) details.dataServiceType = dsTypeIdent.value

      const rawActions = Array.isArray(obj?.formActions)
        ? obj.formActions
        : Array.isArray((obj?.actionRequest as any)?.formActions)
          ? (obj!.actionRequest as any).formActions
          : Array.isArray((obj?.formRequest as any)?.formActions)
            ? (obj!.formRequest as any).formActions
            : undefined
      if (rawActions) {
        const summarized = rawActions.slice(0, 32).map(a => {
          if (!a || typeof a !== 'object') return { command: 'unknown' }
          const rec = a as Record<string, unknown>
          const item: Record<string, string> = {}
          const cmd = validateStructuralIdent(rec.command, STRUCT_IDENT_RE, input.vault)
          vaultRedactions += cmd.vaultRedactions
          if (cmd.value) item.command = cmd.value
          const cid = validateStructuralIdent(rec.controlID, E1_CONTROL_ID_RE, input.vault, true)
          vaultRedactions += cid.vaultRedactions
          if (cid.value) item.controlID = cid.value
          return item
        })
        details.formActions = summarized
        if (rawActions.length > 32) details.formActionsTruncated = true
      }

      const op = actIdent.value ? `${endpoint}:${actIdent.value}` : `${endpoint}:${input.effectiveMethod}`
      const resource = formIdent.value ?? input.sanitizedPath
      actions.push({
        family: 'e1-ais',
        op,
        resource,
        ...(Object.keys(details).length && { details }),
        coverage: defaultCov,
      })
      extractStatus = fullyIntact ? 'complete' : 'partial'
    } else if (lowerPath.includes('/_api/') || lowerPath.includes('/_vti_bin/')) {
      const apiIdx = lowerPath.indexOf('/_api/') >= 0 ? lowerPath.indexOf('/_api/') : lowerPath.indexOf('/_vti_bin/')
      const spResource = input.sanitizedPath.slice(Math.max(0, apiIdx)) || input.sanitizedPath
      if (lowerPath.includes('/$batch')) {
        actions.push({
          family: 'sharepoint',
          op: 'sharepoint:batch',
          resource: spResource,
          details: {
            hasRequestDigest: Boolean(input.rawHeaders['x-requestdigest']),
            hasIfMatch: Boolean(input.rawHeaders['if-match']),
          },
          coverage: 'opaque-batch',
        })
        extractStatus = 'opaque'
      } else {
        const details: Record<string, unknown> = {
          hasIfMatch: Boolean(input.rawHeaders['if-match']),
          hasRequestDigest: Boolean(input.rawHeaders['x-requestdigest']),
        }
        if (input.hdr?.['x-http-method']) details.override = input.hdr['x-http-method']
        const rawMetaType = (obj?.__metadata as any)?.type ?? obj?.['@odata.type']
        const metaIdent = validateStructuralIdent(rawMetaType, /^[#A-Za-z][A-Za-z0-9_.-]{0,63}$/, input.vault)
        vaultRedactions += metaIdent.vaultRedactions
        if (metaIdent.value) details.metadataType = metaIdent.value

        actions.push({
          family: 'sharepoint',
          op: `sharepoint:${input.effectiveMethod}`,
          resource: spResource,
          details,
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      }
    } else if (
      lowerPath.includes('/graphql') ||
      (obj && (typeof obj.query === 'string' || (obj.extensions && typeof obj.extensions === 'object' && 'persistedQuery' in (obj.extensions as Record<string, unknown>)))) ||
      (Array.isArray(parsedJson) && parsedJson.length > 0 && parsedJson.every(item => item && typeof item === 'object' && ('query' in (item as any) || 'extensions' in (item as any))))
    ) {
      const allItems = Array.isArray(parsedJson) ? parsedJson : obj ? [obj] : []
      const batchTruncated = allItems.length > 16
      if (batchTruncated) reasons.push('batch-truncated')
      const opsSeen: GraphqlOp[] = []

      for (let idx = 0; idx < allItems.length; idx++) {
        const rec = allItems[idx] as Record<string, unknown>
        const qStr = typeof rec.query === 'string' ? rec.query : undefined
        const opNameRaw = typeof rec.operationName === 'string' ? rec.operationName : undefined
        const hasPersisted = Boolean(rec.extensions && typeof rec.extensions === 'object' && 'persistedQuery' in (rec.extensions as Record<string, unknown>))

        const safeOpName = validateStructuralIdent(opNameRaw, GQL_IDENT_RE, input.vault)
        vaultRedactions += safeOpName.vaultRedactions

        let varKeys: string[] | undefined
        if (idx < 16 && rec.variables && typeof rec.variables === 'object' && !Array.isArray(rec.variables)) {
          varKeys = Object.keys(rec.variables as Record<string, unknown>).slice(0, 32).map(k => {
            const sk = scrubStructuralKey(k, input.vault)
            vaultRedactions += sk.vaultRedactions
            return sk.key
          })
        }

        if (!qStr && hasPersisted) {
          opsSeen.push('persisted')
          if (idx < 16) {
            actions.push({
              family: 'graphql',
              op: 'graphql:persisted',
              resource: safeOpName.value ?? input.sanitizedPath,
              details: { ...(varKeys && { variableKeys: varKeys }) },
              coverage: 'persisted-query-unknown',
            })
          }
          continue
        }
        if (qStr) {
          const res = classifyGraphqlQuery(qStr, opNameRaw)
          const itemOp: GraphqlOp = dupKeys ? 'mixed' : res.op
          opsSeen.push(itemOp)
          if (idx < 16) {
            const safeNames = res.opNames.slice(0, 16).map(n => {
              if (n === '<anonymous>') return n
              const v = validateStructuralIdent(n, GQL_IDENT_RE, input.vault)
              vaultRedactions += v.vaultRedactions
              return v.value ?? '<redacted>'
            })
            const resource = safeOpName.value ?? (safeNames.length === 1 && safeNames[0] !== '<anonymous>' && safeNames[0] !== '<redacted>' ? safeNames[0] : input.sanitizedPath)
            actions.push({
              family: 'graphql',
              op: `graphql:${itemOp}`,
              resource,
              details: {
                opNames: safeNames,
                opKinds: res.opKinds.slice(0, 16),
                ...(varKeys && { variableKeys: varKeys }),
              },
              coverage: !fullyIntact || itemOp === 'mixed' || batchTruncated ? 'partial' : 'complete',
            })
          }
        } else {
          opsSeen.push('mixed')
          if (idx < 16) {
            actions.push({
              family: 'graphql',
              op: 'graphql:mixed',
              resource: input.sanitizedPath,
              coverage: 'unknown',
            })
          }
        }
      }

      if (opsSeen.length === 0) {
        graphqlOp = 'mixed'
        extractStatus = 'opaque'
      } else if (opsSeen.includes('persisted')) {
        graphqlOp = opsSeen.every(o => o === 'persisted') ? 'persisted' : 'mixed'
        extractStatus = 'opaque'
      } else if (opsSeen.every(o => o === 'query') && fullyIntact && !batchTruncated) {
        graphqlOp = 'query'
        extractStatus = 'complete'
      } else if (opsSeen.every(o => o === 'mutation')) {
        graphqlOp = 'mutation'
        extractStatus = fullyIntact && !batchTruncated ? 'complete' : 'partial'
      } else if (opsSeen.every(o => o === 'subscription')) {
        graphqlOp = 'subscription'
        extractStatus = fullyIntact && !batchTruncated ? 'complete' : 'partial'
      } else {
        graphqlOp = 'mixed'
        extractStatus = 'partial'
      }
    } else if (
      input.hdr?.soapaction ||
      ((input.reqType === 'text/xml' || input.reqType === 'application/soap+xml' || input.reqType === 'application/xml') &&
        decodedText !== undefined &&
        /<(?:[A-Za-z_][\w.-]*:)?Envelope[\s>]/i.test(decodedText))
    ) {
      const claimedRaw = input.hdr?.soapaction?.replace(/^"(.*)"$/, '$1')
      const bodyRootRaw = decodedText ? extractSoapBodyRoot(decodedText) : undefined
      let soapAction: string | undefined
      if (claimedRaw) {
        const s = scrubText(truncateUtf8HeadTail(claimedRaw, 128), input.vault)
        vaultRedactions += s.vaultRedactions
        if (!isSensitiveValue(s.text)) soapAction = s.text
      }
      const rootIdent = validateStructuralIdent(bodyRootRaw, /^[A-Za-z_][\w.-]{0,47}(?::[A-Za-z_][\w.-]{0,47})?$/, input.vault)
      vaultRedactions += rootIdent.vaultRedactions
      const bodyRoot = rootIdent.value
      const rootLocal = bodyRoot?.includes(':') ? bodyRoot.split(':')[1] : bodyRoot
      const actionMismatch = Boolean(soapAction && rootLocal && !soapAction.toLowerCase().includes(rootLocal.toLowerCase()))
      actions.push({
        family: 'soap',
        op: `soap:${bodyRoot || soapAction || 'unknown'}`,
        resource: input.sanitizedPath,
        details: {
          ...(soapAction && { soapAction }),
          ...(bodyRoot && { bodyRootQName: bodyRoot }),
          ...(actionMismatch && { actionMismatch: true }),
        },
        coverage: defaultCov,
      })
      extractStatus = bodyRoot || soapAction ? (fullyIntact ? 'complete' : 'partial') : 'opaque'
    } else if (input.isWrite) {
      actions.push({
        family: input.surface === 'api' ? 'api' : 'rest',
        op: `${input.surface === 'api' ? 'api' : 'rest'}:${input.effectiveMethod}`,
        resource: input.sanitizedPath,
        coverage: isBinary || structuredJsonParseFailed ? 'partial' : defaultCov,
      })
      extractStatus = isBinary || structuredJsonParseFailed ? 'opaque' : fullyIntact ? 'complete' : 'partial'
    }

    let reqBody: string | undefined
    let reqTrunc: true | undefined
    let reqOmitted: BodyOmittedReason | undefined

    if (input.isWrite && (hasBody || input.isLive)) {
      if (input.isLive) {
        reqOmitted = 'live'
      } else if (input.isAuth) {
        reqOmitted = 'auth-url'
      } else if (isBinary) {
        reqOmitted = 'binary'
      } else if (input.projection === 'semantic') {
        reqOmitted = 'policy-profile'
      } else if (structuredJsonParseFailed) {
        reqOmitted = 'policy-profile'
        reqTrunc = true
      } else if (input.sampleBudgetOk === false) {
        reqOmitted = 'budget'
      } else if (decodedText !== undefined) {
        let redactedText: string
        if (isJson) {
          const rj = redactJsonValue(parsedJson, input.vault, false)
          vaultRedactions += rj.vaultRedactions
          redactedText = JSON.stringify(rj.value)
        } else if (input.reqType === 'application/x-www-form-urlencoded') {
          const rf = redactFormBody(decodedText, input.vault)
          vaultRedactions += rf.vaultRedactions
          redactedText = rf.text
        } else {
          const rp = redactPlainText(decodedText, input.vault)
          vaultRedactions += rp.vaultRedactions
          redactedText = rp.text
        }
        if (Buffer.byteLength(redactedText, 'utf8') > MAX_SAMPLE_BODY_BYTES) {
          reqBody = truncateUtf8HeadTail(redactedText, MAX_SAMPLE_BODY_BYTES, 3072, 1020)
          reqTrunc = true
        } else {
          reqBody = redactedText
        }
      }
    }

    if ((!input.bodyComplete || !decodeComplete) && (hasBody || input.transport === 'truncated')) {
      reqTrunc = true
    }

    return {
      actions,
      ...(bodyShape && Object.keys(bodyShape).length > 0 && { bodyShape }),
      ...(graphqlOp && { graphqlOp }),
      ...(dupKeys && { dupKeys: true as const }),
      completeness: {
        transport: input.transport,
        decode: decodeStatus,
        extract: extractStatus,
        ...(reasons.length > 0 && { reasons }),
      },
      decodeComplete,
      ...(reqBody !== undefined && { reqBody }),
      ...(reqTrunc && { reqTrunc }),
      ...(reqOmitted && { reqOmitted }),
      vaultRedactions,
      ...(isJson && !input.isLive && { parsedBody: parsedJson }),
      ...(decodedText !== undefined && !input.isLive && { rawBodyText: decodedText }),
    }
  } catch {
    return {
      actions: input.isWrite
        ? [{ family: input.surface === 'api' ? 'api' : 'rest', op: `${input.surface === 'api' ? 'api' : 'rest'}:${input.effectiveMethod}`, resource: input.sanitizedPath, coverage: 'unknown' }]
        : [],
      completeness: {
        transport: input.transport,
        decode: input.decodeResult?.decode ?? 'none',
        extract: 'none',
        reasons: [...reasons, 'extractor-error'],
      },
      decodeComplete: false,
      vaultRedactions,
    }
  }
}

export function buildApiRequestDescriptor(opts: {
  connection: string
  connectionType?: 'graph' | 'databricks' | 'service' | 'link'
  seq: number
  method: string
  url: URL
  headers: Record<string, string | string[] | undefined>
  rawBody?: Buffer
  bodyComplete: boolean
  transport?: 'complete' | 'truncated' | 'not-read'
  transportReasons?: string[]
  projection?: ProjectionMode
  vault?: SecretVault
}): { descriptor: RequestDescriptor; methods: SemanticMethodInfo } {
  const projection = opts.projection ?? 'semantic'
  const methods = parseSemanticMethods(opts.method, opts.headers, opts.vault)
  const san = sanitizeUrl(opts.url, { projection, vault: opts.vault })
  const reqType = normalizeContentType(
    typeof opts.headers['content-type'] === 'string' ? opts.headers['content-type'] : undefined,
    opts.vault,
  )
  const cl = opts.headers['content-length']
  const declaredBytes = typeof cl === 'string' && /^\d+$/.test(cl.trim()) ? Number(cl.trim()) : undefined
  const prefixBuf = opts.rawBody ? opts.rawBody.subarray(0, MAX_PREFIX_BYTES) : Buffer.alloc(0)
  const hasBodyOnSafeMethod = SAFE_METHODS.has(methods.wireMethod) && (
    prefixBuf.length > 0 || (declaredBytes !== undefined && declaredBytes > 0) || opts.headers['transfer-encoding'] !== undefined
  )
  const isWrite =
    !SAFE_METHODS.has(methods.wireMethod) ||
    !SAFE_METHODS.has(methods.effectiveMethod) ||
    methods.invalidOrConflictingOverride ||
    hasBodyOnSafeMethod

  const transport: Completeness['transport'] = opts.transport ?? (
    opts.rawBody === undefined ? 'not-read' : (opts.bodyComplete && opts.rawBody.length <= MAX_PREFIX_BYTES ? 'complete' : 'truncated')
  )
  const effectiveComplete = opts.bodyComplete && (opts.rawBody === undefined || opts.rawBody.length <= MAX_PREFIX_BYTES)

  const extracted = extractSemantic({
    url: opts.url,
    sanitizedPath: san.path,
    method: methods.wireMethod,
    effectiveMethod: methods.effectiveMethod,
    kind: 'http',
    surface: 'api',
    connectionType: opts.connectionType,
    hdr: methods.hdr,
    rawHeaders: opts.headers,
    reqType,
    decodedBuf: prefixBuf,
    bodyComplete: effectiveComplete,
    transport,
    transportReasons: opts.transportReasons,
    isWrite,
    isAuth: false,
    isLive: false,
    projection,
    vault: opts.vault,
  })

  const vaultRedactions = methods.vaultRedactions + san.vaultRedactions + extracted.vaultRedactions
  const safe: SafeRequestProjection = {
    descV: DESC_V,
    redactV: REDACT_V,
    extractorV: EXTRACTOR_V,
    surface: 'api',
    target: { connection: opts.connection },
    seq: opts.seq,
    t: new Date().toISOString(),
    kind: 'http',
    scheme: san.scheme,
    authority: san.authority,
    path: san.path,
    url: san.url,
    method: methods.wireMethod,
    effectiveMethod: methods.effectiveMethod,
    methodSource: methods.methodSource,
    isWrite,
    ...(methods.hdr && { hdr: methods.hdr }),
    ...(methods.hdrConflict && { hdrConflict: true as const }),
    ...(reqType && { reqType }),
    ...(declaredBytes !== undefined && { declaredBytes }),
    prefixBytes: prefixBuf.length,
    bodyComplete: effectiveComplete,
    decodeComplete: extracted.decodeComplete,
    completeness: extracted.completeness,
    actions: extracted.actions,
    ...(extracted.bodyShape && { bodyShape: extracted.bodyShape }),
    ...(extracted.graphqlOp && { graphqlOp: extracted.graphqlOp }),
    ...(extracted.dupKeys && { dupKeys: true as const }),
    ...(vaultRedactions > 0 && { vaultRedactions }),
    ...(extracted.reqBody !== undefined && { reqBody: extracted.reqBody }),
    ...(extracted.reqTrunc && { reqTrunc: true as const }),
    ...(extracted.reqOmitted && { reqOmitted: extracted.reqOmitted }),
  }

  const descriptor: RequestDescriptor = {
    safe,
    ...(extracted.parsedBody !== undefined || extracted.rawBodyText !== undefined
      ? {
          raw: {
            url: opts.url.href,
            ...(extracted.parsedBody !== undefined && { parsedBody: extracted.parsedBody }),
            ...(extracted.rawBodyText !== undefined && { rawBodyText: extracted.rawBodyText }),
            ...(declaredBytes !== undefined && { declaredBytes }),
          },
        }
      : undefined),
  }

  return { descriptor, methods }
}
