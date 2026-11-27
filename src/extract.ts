import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { key as systemKey, rfDir } from './system.ts'
import {
  buildBodyShape,
  buildFormBodyShape,
  isDataLikeKey,
  isSensitiveValue,
  parseJsonSafe,
  redactFormBody,
  redactJsonValue,
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
  const len = xml.length
  let i = 0
  let depth = 0
  let inEnvelope = false
  let inBody = false
  const isNameChar = (c: number) =>
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 46 || c === 58

  while (i < len) {
    const pos = xml.indexOf('<', i)
    if (pos < 0 || pos + 1 >= len) return undefined
    if (xml.startsWith('<!--', pos)) {
      const end = xml.indexOf('-->', pos + 4)
      if (end < 0) return undefined
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', pos)) {
      const end = xml.indexOf('?>', pos + 2)
      if (end < 0) return undefined
      i = end + 2
      continue
    }
    if (xml.startsWith('<![CDATA[', pos)) {
      const end = xml.indexOf(']]>', pos + 9)
      if (end < 0) return undefined
      i = end + 3
      continue
    }
    if (xml.startsWith('<!', pos)) {
      const end = xml.indexOf('>', pos + 2)
      if (end < 0) return undefined
      i = end + 1
      continue
    }
    const nextCh = xml.charCodeAt(pos + 1)
    if (nextCh === 47) { // '</'
      const end = xml.indexOf('>', pos + 2)
      if (end < 0) return undefined
      const closeName = xml.slice(pos + 2, end).trim()
      const colon = closeName.indexOf(':')
      const local = (colon >= 0 ? closeName.slice(colon + 1) : closeName).toLowerCase()
      if (inBody && depth === 2 && local === 'body') return undefined
      if (inEnvelope && depth === 1 && local === 'envelope') return undefined
      if (depth > 0) depth--
      i = end + 1
      continue
    }
    let nameEnd = pos + 1
    while (nameEnd < len && isNameChar(xml.charCodeAt(nameEnd))) nameEnd++
    if (nameEnd === pos + 1) {
      i = pos + 1
      continue
    }
    const qname = xml.slice(pos + 1, nameEnd)
    // Quote-aware scan for tag end '>' so '>' inside attribute values cannot spoof SOAP body root!
    let gt = -1
    let quote = 0
    for (let j = nameEnd; j < len; j++) {
      const ch = xml.charCodeAt(j)
      if (quote) {
        if (ch === quote) quote = 0
      } else if (ch === 34 || ch === 39) {
        quote = ch
      } else if (ch === 62) {
        gt = j
        break
      }
    }
    if (gt < 0) return undefined
    const selfClosing = xml.charCodeAt(gt - 1) === 47
    if (inBody && depth === 2) {
      return qname
    }
    const colon = qname.indexOf(':')
    const local = (colon >= 0 ? qname.slice(colon + 1) : qname).toLowerCase()
    if (depth === 0) {
      if (local !== 'envelope' || selfClosing) return undefined
      inEnvelope = true
      depth = 1
    } else if (inEnvelope && depth === 1 && local === 'body' && !selfClosing) {
      inBody = true
      depth = 2
    } else if (!selfClosing) {
      depth++
    }
    i = gt + 1
  }
  return undefined
}

// ---- Keyed HMAC target & SQL context digests (never leak raw IDs or SQL literals/parameters) ----

let cachedHmacDir = ''
let cachedHmacKey: Buffer | undefined
let fallbackEphemeralKey: Buffer | undefined

export function getPolicyHmacKey(): Buffer {
  const dir = rfDir()
  if (dir) {
    if (cachedHmacKey && cachedHmacDir === dir) return cachedHmacKey
    // Fail closed when a data root is configured: never silently fall back to a process-local key!
    cachedHmacKey = crypto.createHmac('sha256', systemKey('seal.key')).update('rf:execpolicy:hmac:v1').digest()
    cachedHmacDir = dir
    return cachedHmacKey
  }
  if (!fallbackEphemeralKey) fallbackEphemeralKey = crypto.randomBytes(32)
  return fallbackEphemeralKey
}

export function canonicalizeTargetPath(rawPathname: string, foldGraphVersion = false): string {
  let p = rawPathname.trim()
  if (!p.startsWith('/')) p = '/' + p
  // Fold /v1.0 or /beta version prefix case ONLY on Graph connections (never arbitrary services); preserve trailing slashes!
  if (foldGraphVersion) {
    p = p.replace(/^\/(v1\.0|beta)(?=\/|$)/i, (_, v: string) => `/${v.toLowerCase()}`)
  }
  return p
}

export function effectiveAuthority(host: string, port?: string | number, scheme = 'https'): string {
  const h = host.trim().toLowerCase()
  if (!h) return ''
  const rawPort = port !== undefined && port !== null ? String(port).trim() : ''
  const effPort = rawPort || (scheme === 'http' ? '80' : scheme === 'https' ? '443' : '')
  return effPort ? `${h}:${effPort}` : h
}

export function decodePathSegmentsStrict(rawPathname: string): { segments: string[]; decodedPath: string; invalidEncoding: boolean } {
  const parts = rawPathname.split('/')
  const segments: string[] = []
  let invalidEncoding = false
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    if (!seg) continue
    try {
      const dec = decodeURIComponent(seg)
      // Reject encoded separators/CTLs/dot-segments AND residual double-encoding (%XX remaining after one decode)!
      if (/[/\\\x00-\x1f\x7f]/.test(dec) || /%[0-9a-fA-F]{2}/.test(dec) || dec === '.' || dec === '..') {
        invalidEncoding = true
      }
      segments.push(dec)
    } catch {
      invalidEncoding = true
      segments.push(seg)
    }
  }
  return { segments, decodedPath: '/' + segments.join('/'), invalidEncoding }
}

// Detect Node's JSON.rawJSON(...) lossless numeric leaves so they are never mistaken for plain JSON records!
function isRawJsonLeaf(v: unknown): v is { rawJSON: string } {
  return typeof (JSON as unknown as { isRawJSON?: (x: unknown) => boolean }).isRawJSON === 'function' &&
    (JSON as unknown as { isRawJSON: (x: unknown) => boolean }).isRawJSON(v) === true
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v) && !isRawJsonLeaf(v))
}

// Unified strict SharePoint DeleteByIds selector validator shared between proposal validation and runtime extraction.
export function validateSharePointDeleteIds(
  rawIds: unknown,
  rejectValue?: (id: string) => boolean,
): { ok: true; ids: string[]; bodySelector: string } | { ok: false; reason: string } {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 64) {
    return { ok: false, reason: 'SharePoint DeleteByIds scope requires 1..64 explicit concrete ids' }
  }
  const idSet = new Set<string>()
  for (const item of rawIds) {
    let sId: string
    if (typeof item === 'string' && item.trim() && item.trim().length <= 128 && !item.includes('*') && !/[\r\n\0]/.test(item)) {
      sId = item.trim()
    } else if (typeof item === 'number' && Number.isSafeInteger(item)) {
      sId = String(item)
    } else if (isRawJsonLeaf(item)) {
      const rawNum = String(item.rawJSON)
      if (!/^-?(?:0|[1-9]\d*)$/.test(rawNum)) {
        return { ok: false, reason: 'SharePoint DeleteByIds ids must be concrete non-empty strings or integers (no wildcards)' }
      }
      const n = Number(rawNum)
      if (!Number.isSafeInteger(n) || String(n) !== rawNum) {
        return { ok: false, reason: 'SharePoint DeleteByIds ids must be concrete non-empty strings or integers (no wildcards)' }
      }
      sId = rawNum
    } else {
      return { ok: false, reason: 'SharePoint DeleteByIds ids must be concrete non-empty strings or integers (no wildcards)' }
    }
    if (rejectValue?.(sId)) {
      return { ok: false, reason: 'execpolicy ids must not contain raw secrets or credentials' }
    }
    idSet.add(sId)
  }
  if (idSet.size === 0) {
    return { ok: false, reason: 'SharePoint DeleteByIds scope requires 1..64 explicit concrete ids' }
  }
  const ids = [...idSet].sort()
  return { ok: true, ids, bodySelector: JSON.stringify({ op: 'deletebyids', ids }) }
}

export function isUploadSessionEndpointPath(rawPathname: string): boolean {
  const { decodedPath, invalidEncoding } = decodePathSegmentsStrict(rawPathname)
  if (invalidEncoding) return false
  const p = decodedPath.toLowerCase()
  return (
    /\/_api\/v2\.\d+\/.+\/uploadsession\/?$/i.test(p) ||
    /\/attachmentsessions\/[^/]+\/?$/i.test(p) ||
    /^\/(?:[^/]+\/)*uploadsession\/?$/i.test(p)
  )
}

export function computeTargetDigest(
  input: {
    surface: 'browser' | 'api'
    connectionType?: string
    host: string
    port?: string | number
    scheme?: string
    rawPathname: string
    rawSearch?: string
    resourceId?: string
    bodySelector?: string
  },
  hmacKey?: Buffer,
): string {
  const k = hmacKey ?? getPolicyHmacKey()
  const connType = (input.connectionType ?? '').toLowerCase()
  const foldGraph = connType === 'graph' || input.host.trim().toLowerCase() === 'graph.microsoft.com'
  const auth = effectiveAuthority(input.host, input.port, input.scheme ?? 'https')
  const tuple: string[] = [
    input.surface,
    connType,
    auth,
    canonicalizeTargetPath(input.rawPathname, foldGraph),
    input.rawSearch ?? '',
    input.resourceId ?? '',
  ]
  if (input.bodySelector) tuple.push(input.bodySelector)
  const payload = JSON.stringify(tuple)
  return crypto.createHmac('sha256', k).update(`target:${payload}`).digest('hex')
}

export const MAX_CANONICAL_DEPTH = 16
const MAX_CANONICAL_NODES = 512

export function canonicalizeJsonValue(val: unknown, depth = 0, state = { nodes: 0 }): unknown {
  if (depth > MAX_CANONICAL_DEPTH) throw new RangeError(`JSON nesting depth exceeds ${MAX_CANONICAL_DEPTH}`)
  if (++state.nodes > MAX_CANONICAL_NODES) throw new RangeError(`JSON structure exceeds ${MAX_CANONICAL_NODES} nodes`)
  if (val === null || val === undefined || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(v => canonicalizeJsonValue(v, depth + 1, state))
  const out = Object.create(null) as Record<string, unknown>
  for (const k of Object.keys(val as Record<string, unknown>).sort()) {
    Object.defineProperty(out, k, {
      value: canonicalizeJsonValue((val as Record<string, unknown>)[k], depth + 1, state),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return out
}

export function computeSqlContextDigest(
  input: { sql: string; parameters?: unknown; warehouseId?: string; catalog?: string; schema?: string },
  hmacKey?: Buffer,
): string {
  const k = hmacKey ?? getPolicyHmacKey()
  const hasParameters = input.parameters !== undefined
  const payload = JSON.stringify({
    sql: input.sql.trim(),
    hasParameters,
    ...(hasParameters && { parameters: canonicalizeJsonValue(input.parameters) }),
    warehouseId: input.warehouseId ?? '',
    catalog: input.catalog ?? '',
    schema: input.schema ?? '',
  })
  return crypto.createHmac('sha256', k).update(`sql:${payload}`).digest('hex')
}

// Strict RFC 9110 §8.8.3.2 / §13.1.1 linear strong entity-tag list scanner:
// handles commas inside quoted opaque tags ("a,b"), validates every character inside quotes against RFC 9110 etagc
// (%x21 / %x23-7E / %x80-FF, rejecting spaces, tabs, CTLs), and rejects '*', weak W/"...", empty "", and trailing commas.
function isRfc9110Etagc(c: number): boolean {
  return c === 0x21 || (c >= 0x23 && c <= 0x7e) || (c >= 0x80 && c <= 0xff)
}

export function hasStrongIfMatch(rawHeaders: Record<string, string | string[] | undefined>): boolean {
  const raw = rawHeaders['if-match']
  const val = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : ''
  const len = val.length
  let i = 0
  const skipOws = () => { while (i < len && (val.charCodeAt(i) === 0x20 || val.charCodeAt(i) === 0x09)) i++ }

  skipOws()
  if (i >= len) return false
  let count = 0
  for (;;) {
    skipOws()
    if (i >= len || val.charCodeAt(i) !== 0x22) return false // must start with '"' (rejects *, W/, unquoted)
    i++ // consume opening '"'
    const tagStart = i
    while (i < len && val.charCodeAt(i) !== 0x22) {
      if (!isRfc9110Etagc(val.charCodeAt(i))) return false
      i++
    }
    if (i >= len || i === tagStart) return false // unclosed quote or empty ""
    i++ // consume closing '"'
    count++
    skipOws()
    if (i >= len) break
    if (val.charCodeAt(i) !== 0x2c) return false // must be ',' between list members
    i++ // consume ','
    skipOws()
    if (i >= len) return false // reject trailing comma
  }
  return count > 0
}

export const E1_MUTATING_FORM_COMMANDS = new Set([
  'doaction',
  'setcontrolvalue',
  'setcheckboxvalue',
  'setradiobutton',
  'setcombovalue',
  'setgridcellvalue',
  'insertgridrow',
  'deletegridrow',
  'updategridrow',
  'clickgridcell',
])

// ---- SQL classifier for Databricks statements (Spark SqlBaseLexer compatible, zero PII emitted) ----

export type SqlClassification = {
  sqlClass: 'read' | 'write' | 'ddl' | 'unknown'
  statements: string[]
  destructive: boolean
  hasDropOrTruncate: boolean
  hasDelete: boolean
  hasMergeDelete?: boolean
  hasUnknownStatement?: boolean
  ambiguous?: boolean
}

const SQL_READ_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'LIST'])
const SQL_WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'CALL', 'PUT'])
const SQL_DDL_VERBS = new Set(['DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'REPLACE', 'GRANT', 'REVOKE', 'OPTIMIZE', 'VACUUM', 'RESTORE'])
const SQL_DESTRUCTIVE_VERBS = new Set(['DROP', 'TRUNCATE', 'DELETE'])

export function classifySqlStatement(sql: string): SqlClassification {
  type Tok = { kind: 'word' | 'lparen' | 'rparen' | 'comma' | 'semi' | 'other'; text: string }
  const tokens: Tok[] = []
  let i = 0
  const len = sql.length
  let ambiguous = false

  while (i < len) {
    const ch = sql[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue }
    // Spark SqlBaseLexer SIMPLE_COMMENT: ends on \r OR \n, and honors \+newline continuation (fail-closed ambiguous on \r or continuation).
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < len) {
        const c0 = sql[i]
        if (c0 === '\\' && (sql[i + 1] === '\n' || sql[i + 1] === '\r')) {
          ambiguous = true
          i++
          if (sql[i] === '\r' && sql[i + 1] === '\n') i += 2
          else i++
          continue
        }
        if (c0 === '\r') {
          ambiguous = true
          if (sql[i + 1] === '\n') i += 2
          else i++
          break
        }
        if (c0 === '\n') {
          i++
          break
        }
        i++
      }
      continue
    }
    // Spark SqlBaseLexer BRACKETED_COMMENT: nests /* ... */ (fail-closed ambiguous on nesting or unclosed comment).
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      let commentDepth = 1
      while (i < len && commentDepth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          ambiguous = true
          commentDepth++
          i += 2
          continue
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          commentDepth--
          i += 2
          continue
        }
        i++
      }
      if (commentDepth > 0) ambiguous = true
      continue
    }
    // Spark raw string literals: r'...', R'...', r"...", R"..." (backslash does NOT escape quotes).
    if ((ch === 'r' || ch === 'R') && (sql[i + 1] === "'" || sql[i + 1] === '"')) {
      const q = sql[i + 1]
      i += 2
      let closed = false
      while (i < len) {
        if (sql[i] === q) { i++; closed = true; break }
        i++
      }
      if (!closed) ambiguous = true
      tokens.push({ kind: 'other', text: '' })
      continue
    }
    if (ch === "'") {
      i++
      let closed = false
      while (i < len) {
        if (sql[i] === '\\') { i += 2; continue }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; closed = true; break }
        i++
      }
      if (!closed) ambiguous = true
      tokens.push({ kind: 'other', text: '' })
      continue
    }
    // Spark SqlBaseLexer BACKQUOTED_IDENTIFIER: '`' ( ~'`' | '``' )* '`'
    // Backslash is ALWAYS a literal character inside backticks, NEVER an escape! Only `` escapes a backtick.
    if (ch === '`') {
      const start = i
      i++
      let closed = false
      while (i < len) {
        if (sql[i] === '`' && sql[i + 1] === '`') { i += 2; continue }
        if (sql[i] === '`') { i++; closed = true; break }
        i++
      }
      if (!closed) ambiguous = true
      tokens.push({ kind: 'word', text: sql.slice(start, i) })
      continue
    }
    if (ch === '"') {
      const start = i
      i++
      let closed = false
      while (i < len) {
        if (sql[i] === '\\') { i += 2; continue }
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue }
        if (sql[i] === '"') { i++; closed = true; break }
        i++
      }
      if (!closed) ambiguous = true
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
    // Preserve non-comment, non-whitespace characters (numbers/operators/punctuation) so standalone literal segments
    // like `INSERT INTO t VALUES (1); 123` never vanish and always classify as UNKNOWN!
    if (!/\s/.test(ch)) {
      tokens.push({ kind: 'other', text: '' })
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
  let hasMergeDelete = false
  let hasOverwriteOrReplaceWhere = false

  for (const stmt of rawStmts) {
    const first = stmt[0]
    if (!first || first.kind !== 'word') {
      statements.push('UNKNOWN')
      continue
    }
    let verb = first.text
    let mainIdx = 0
    if (verb === 'WITH') {
      // Strictly parse CTE list: WITH [RECURSIVE] <name> [(cols)] AS [MATERIALIZED|NOT MATERIALIZED] (<subquery>) [, ...] <mainVerb>
      let p = 1
      if (stmt[p]?.kind === 'word' && stmt[p].text === 'RECURSIVE') p++
      let ok = false
      for (;;) {
        if (stmt[p]?.kind !== 'word') { ok = false; break }
        p++
        if (stmt[p]?.kind === 'lparen') {
          p = skipParenGroup(stmt, p)
          if (p < 0) { ok = false; break }
        }
        if (stmt[p]?.kind !== 'word' || stmt[p].text !== 'AS') { ok = false; break }
        p++
        if (stmt[p]?.kind === 'word' && stmt[p].text === 'NOT') p++
        if (stmt[p]?.kind === 'word' && stmt[p].text === 'MATERIALIZED') p++
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
      mainIdx = p
    }
    // Scan ALL top-level tokens of EVERY statement (including Spark FROM-first multi-insert `FROM src INSERT OVERWRITE ...`)
    // for destructive clauses regardless of leading verb!
    {
      let d = 0
      let prevWord = ''
      let sawInsert = verb === 'INSERT'
      for (let k = mainIdx; k < stmt.length; k++) {
        const tk = stmt[k]
        if (tk.kind === 'lparen') { d++; prevWord = '' }
        else if (tk.kind === 'rparen') { if (d > 0) d--; prevWord = '' }
        else if (d === 0 && tk.kind === 'word') {
          if (tk.text === 'INSERT') sawInsert = true
          if (prevWord === 'INSERT' && tk.text === 'OVERWRITE') {
            hasOverwriteOrReplaceWhere = true
          }
          if (sawInsert && prevWord === 'REPLACE' && tk.text === 'WHERE') {
            hasOverwriteOrReplaceWhere = true
          }
          if (prevWord === 'THEN' && tk.text === 'DELETE') {
            hasMergeDelete = true
          }
          prevWord = tk.text
        } else if (d === 0) {
          prevWord = ''
        }
      }
    }
    // Defense-in-depth: if any top-level word in the statement after CTEs is a write/DDL verb, never misclassify as read!
    if (SQL_READ_VERBS.has(verb)) {
      let d = 0
      let hasMutatingTopLevel = false
      for (let k = mainIdx + 1; k < stmt.length; k++) {
        const tk = stmt[k]
        if (tk.kind === 'lparen') d++
        else if (tk.kind === 'rparen' && d > 0) d--
        else if (d === 0 && tk.kind === 'word' && k > 0 && stmt[k - 1]?.text !== 'AS') {
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
    const normalizedVerb = (SQL_READ_VERBS.has(verb) || SQL_WRITE_VERBS.has(verb) || SQL_DDL_VERBS.has(verb)) ? verb : 'UNKNOWN'
    statements.push(normalizedVerb)
  }

  let hasDropOrTruncate = hasOverwriteOrReplaceWhere || statements.some(v => v === 'DROP' || v === 'TRUNCATE')
  let hasDelete = hasMergeDelete || statements.some(v => v === 'DELETE')
  const hasUnknownStatement = statements.some(v => v === 'UNKNOWN')
  // Fail-closed: if lexer hit ambiguous Spark comment/string constructs, also scan raw text for destructive verbs
  // and NEVER classify as 'read'.
  if (ambiguous) {
    if (!hasDropOrTruncate && /\b(?:DROP|TRUNCATE)\b|\bINSERT\s+OVERWRITE\b|\bREPLACE\s+WHERE\b/i.test(sql)) hasDropOrTruncate = true
    if (!hasMergeDelete && /\bMERGE\b[\s\S]*\bTHEN\s+DELETE\b/i.test(sql)) hasMergeDelete = true
    if (!hasDelete && /\bDELETE\b/i.test(sql)) hasDelete = true
  }
  const destructive = hasDropOrTruncate || hasDelete || hasMergeDelete || statements.some(v => SQL_DESTRUCTIVE_VERBS.has(v))
  const extraFlags = {
    ...(hasMergeDelete && { hasMergeDelete: true }),
    ...(hasUnknownStatement && { hasUnknownStatement: true }),
  }

  if (!statements.length) {
    return { sqlClass: 'unknown', statements: [], destructive, hasDropOrTruncate, hasDelete, ...extraFlags, ...(ambiguous && { ambiguous: true }) }
  }
  if (ambiguous) {
    return { sqlClass: 'unknown', statements: statements.slice(0, 16), destructive, hasDropOrTruncate, hasDelete, ...extraFlags, ambiguous: true }
  }
  if (statements.some(v => SQL_DDL_VERBS.has(v))) {
    return { sqlClass: 'ddl', statements: statements.slice(0, 16), destructive, hasDropOrTruncate, hasDelete, ...extraFlags }
  }
  if (statements.some(v => SQL_WRITE_VERBS.has(v))) {
    return { sqlClass: 'write', statements: statements.slice(0, 16), destructive, hasDropOrTruncate, hasDelete, ...extraFlags }
  }
  if (statements.every(v => SQL_READ_VERBS.has(v))) {
    return { sqlClass: 'read', statements: statements.slice(0, 16), destructive: false, hasDropOrTruncate: false, hasDelete: false }
  }
  return { sqlClass: 'unknown', statements: statements.slice(0, 16), destructive, hasDropOrTruncate, hasDelete, ...extraFlags }
}

// ---- Graph API semantic helpers (domains & counts only, NEVER raw addresses/subject/body PII) ----

const MAX_MIME_HEAD_BYTES = 8192
const MAX_RECIPIENT_DOMAINS = 32

function isValidEmailLocal(s: string): boolean {
  if (!s.length || s.length > 256) return false
  if (s.startsWith('.') || s.endsWith('.') || s.includes('..')) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const ok =
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 46 || c === 95 || c === 37 || c === 43 || c === 45
    if (!ok) return false
  }
  return true
}

export function isValidEmailDomain(s: string): boolean {
  if (!s.length || s.length > 253) return false
  if (s.startsWith('.') || s.endsWith('.')) return false
  const lastDot = s.lastIndexOf('.')
  if (lastDot <= 0 || s.length - lastDot - 1 < 2) return false
  // TLD must be ASCII letters only
  for (let i = lastDot + 1; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false
  }
  let labelLen = 0
  let labelStart = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 46) {
      if (labelLen === 0 || labelLen > 63 || s.charCodeAt(labelStart) === 45 || s.charCodeAt(i - 1) === 45) return false
      labelLen = 0
      labelStart = i + 1
      continue
    }
    const ok =
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 45
    if (!ok) return false
    labelLen++
  }
  return labelLen > 0 && labelLen <= 63 && s.charCodeAt(labelStart) !== 45 && s.charCodeAt(s.length - 1) !== 45
}

// Strict plain ASCII addr-spec parser: rejects quoted locals, IP-literals, trailing dots, underscores, IDN, comments, etc.
function parsePlainEmailDomain(rawAddr: string): string | null {
  const s = rawAddr.trim()
  if (!s || s.length > 512) return null
  const firstAt = s.indexOf('@')
  if (firstAt <= 0 || firstAt !== s.lastIndexOf('@') || firstAt >= s.length - 1) return null
  const local = s.slice(0, firstAt)
  const dom = s.slice(firstAt + 1)
  if (!isValidEmailLocal(local) || !isValidEmailDomain(dom)) return null
  return dom.toLowerCase()
}

function keyedCI(obj: Record<string, unknown>, lowerKey: string): unknown[] {
  const out: unknown[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lowerKey) out.push(v)
  }
  return out
}

function extractRecipientDomains(obj: Record<string, unknown> | undefined): { domains: string[]; count: number; complete: boolean } {
  if (!obj) return { domains: [], count: 0, complete: false }
  const msgVals = keyedCI(obj, 'message')
  let complete = true
  let msg: Record<string, unknown>
  if (msgVals.length > 1) {
    // Ambiguous multiple case-variants of `message`
    complete = false
    const firstObj = msgVals.find(v => v && typeof v === 'object' && !Array.isArray(v))
    msg = (firstObj ?? obj) as Record<string, unknown>
  } else if (msgVals.length === 1) {
    if (!msgVals[0] || typeof msgVals[0] !== 'object' || Array.isArray(msgVals[0])) {
      return { domains: [], count: 0, complete: false }
    }
    msg = msgVals[0] as Record<string, unknown>
    // If top-level ALSO has recipient fields outside `message`, mark incomplete
    if (
      keyedCI(obj, 'torecipients').length > 0 ||
      keyedCI(obj, 'ccrecipients').length > 0 ||
      keyedCI(obj, 'bccrecipients').length > 0
    ) {
      complete = false
    }
  } else {
    msg = obj
  }

  const domains = new Set<string>()
  let count = 0
  let resolvedCount = 0
  const recipFieldNames = ['torecipients', 'ccrecipients', 'bccrecipients'] as const

  for (const fname of recipFieldNames) {
    const matches = keyedCI(msg, fname)
    for (const arr of matches) {
      if (arr === undefined || arr === null) continue
      if (!Array.isArray(arr)) {
        complete = false
        continue
      }
      for (const item of arr) {
        count++
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          complete = false
          continue
        }
        const eaVals = keyedCI(item as Record<string, unknown>, 'emailaddress')
        if (eaVals.length !== 1 || !eaVals[0] || typeof eaVals[0] !== 'object' || Array.isArray(eaVals[0])) {
          complete = false
          continue
        }
        const addrVals = keyedCI(eaVals[0] as Record<string, unknown>, 'address')
        if (addrVals.length !== 1 || typeof addrVals[0] !== 'string' || !addrVals[0].trim()) {
          complete = false
          continue
        }
        const dom = parsePlainEmailDomain(addrVals[0])
        if (!dom) {
          complete = false
          continue
        }
        resolvedCount++
        if (domains.size >= MAX_RECIPIENT_DOMAINS && !domains.has(dom)) {
          complete = false
        } else {
          domains.add(dom)
        }
      }
    }
  }

  return {
    domains: [...domains].sort(),
    count,
    complete: complete && count > 0 && count === resolvedCount,
  }
}

function extractAttachmentCount(obj: Record<string, unknown> | undefined): number {
  if (!obj) return 0
  const msgVals = keyedCI(obj, 'message')
  const msg = (msgVals[0] && typeof msgVals[0] === 'object' && !Array.isArray(msgVals[0])
    ? msgVals[0]
    : obj) as Record<string, unknown>
  const attVals = keyedCI(msg, 'attachments')
  let total = 0
  for (const att of attVals) if (Array.isArray(att)) total += att.length
  return total
}

function isPlainDisplayName(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const ok =
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 32 || c === 9 || c === 46 || c === 45 || c === 95 || c === 39
    if (!ok) return false
  }
  return true
}

// Linear O(N) fail-closed MIME recipient header scanner (capped at 8 KiB, zero backtracking regexes).
export function extractMimeRecipientDomains(rawText: string): { domains: string[]; count: number; complete: boolean } {
  try {
    // Decode up to MAX_MIME_HEAD_BYTES + 4 bytes so we can verify header termination within the 8 KiB cap.
    const maxB64Chars = Math.ceil(((MAX_MIME_HEAD_BYTES + 4) * 4) / 3) + 8
    let b64 = ''
    let hitInputCap = false
    let i = 0
    for (; i < rawText.length; i++) {
      const c = rawText.charCodeAt(i)
      if (c === 32 || c === 9 || c === 13 || c === 10) continue
      if (b64.length >= maxB64Chars) {
        hitInputCap = true
        break
      }
      const ok =
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 43 || c === 47 || c === 61
      if (!ok) return { domains: [], count: 0, complete: false }
      b64 += rawText[i]
    }
    if (!b64.length) return { domains: [], count: 0, complete: false }
    // Align partial prefix to 4-char base64 boundary when truncated
    const aligned = hitInputCap ? b64.slice(0, b64.length - (b64.length % 4)) : b64
    if (!aligned.length || aligned.length % 4 !== 0) return { domains: [], count: 0, complete: false }
    const decoded = Buffer.from(aligned, 'base64').toString('latin1')

    const crlfEnd = decoded.indexOf('\r\n\r\n')
    const lfEnd = decoded.indexOf('\n\n')
    let headEnd = -1
    if (crlfEnd >= 0 && lfEnd >= 0) headEnd = Math.min(crlfEnd, lfEnd)
    else if (crlfEnd >= 0) headEnd = crlfEnd
    else if (lfEnd >= 0) headEnd = lfEnd

    // Fail closed whenever the MIME header block does not terminate with \r\n\r\n or \n\n within MAX_MIME_HEAD_BYTES!
    let complete = headEnd >= 0 && headEnd <= MAX_MIME_HEAD_BYTES

    const cut = headEnd >= 0 ? Math.min(headEnd, MAX_MIME_HEAD_BYTES) : Math.min(decoded.length, MAX_MIME_HEAD_BYTES)
    const head = decoded.slice(0, cut)
    const unfolded = head.replace(/\r?\n[ \t]+/g, ' ')
    const domains = new Set<string>()
    let parsedCount = 0
    let resolvedCount = 0

    for (const line of unfolded.split(/\r?\n/)) {
      if (!line) continue
      const colon = line.indexOf(':')
      if (colon <= 0) {
        complete = false
        continue
      }
      const hdrName = line.slice(0, colon).trim().toLowerCase()
      const isResentRecip = hdrName === 'resent-to' || hdrName === 'resent-cc' || hdrName === 'resent-bcc'
      if (isResentRecip) {
        complete = false
      }
      if (hdrName !== 'to' && hdrName !== 'cc' && hdrName !== 'bcc' && !isResentRecip) continue

      const val = line.slice(colon + 1)
      // Fail closed on RFC 5322 comments (...), quoted strings "...", group syntax : ;, encoded-words =?, or non-ASCII/control bytes
      let hasUnsafeSyntax = false
      for (let k = 0; k < val.length; k++) {
        const ch = val.charCodeAt(k)
        if (
          ch === 34 || // "
          ch === 40 || // (
          ch === 41 || // )
          ch === 58 || // :
          ch === 59 || // ;
          ch === 92 || // \
          ch > 126 ||
          (ch < 32 && ch !== 9)
        ) {
          hasUnsafeSyntax = true
          break
        }
        if (ch === 61 && val.charCodeAt(k + 1) === 63) { // =?
          hasUnsafeSyntax = true
          break
        }
      }
      if (hasUnsafeSyntax) {
        complete = false
      }

      const parts = val.split(',')
      for (const rawPart of parts) {
        const part = rawPart.trim()
        if (!part) {
          complete = false
          continue
        }
        parsedCount++
        let candidate: string | null = null
        const lt = part.indexOf('<')
        const gt = part.indexOf('>')
        if (lt < 0 && gt < 0) {
          candidate = part
        } else if (lt >= 0 && gt > lt && gt === part.length - 1 && part.indexOf('<', lt + 1) < 0 && part.indexOf('>', gt + 1) < 0) {
          const display = part.slice(0, lt).trim()
          if (!display || isPlainDisplayName(display)) {
            candidate = part.slice(lt + 1, gt).trim()
          }
        }
        if (!candidate) {
          complete = false
          continue
        }
        const dom = parsePlainEmailDomain(candidate)
        if (!dom) {
          complete = false
          continue
        }
        resolvedCount++
        if (domains.size >= MAX_RECIPIENT_DOMAINS && !domains.has(dom)) {
          complete = false
        } else {
          domains.add(dom)
        }
      }
    }

    return {
      domains: [...domains].sort(),
      count: resolvedCount,
      complete: complete && parsedCount > 0 && parsedCount === resolvedCount,
    }
  } catch {
    return { domains: [], count: 0, complete: false }
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
  linkProvenance?: { sourceType?: string; linkKind?: 'upload_session' | 'download' | 'redirect' }
  hmacKey?: Buffer
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

const E1_ENDPOINTS = new Set(['formservice', 'batchformservice', 'appstack', 'dataservice', 'orchestrator', 'file', 'tokenrequest', 'discover', 'defaultconfig'])
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

  const isDatabricksSqlSubmit =
    input.isWrite &&
    (input.connectionType === 'databricks' || (input.surface === 'api' && input.url.hostname.toLowerCase().endsWith('.azuredatabricks.net'))) &&
    input.url.pathname.toLowerCase().replace(/\/+$/, '') === '/api/2.0/sql/statements'

  try {
    const rawBuf = input.decodedBuf ?? Buffer.alloc(0)
    const decodeRes = input.decodeResult
    const decodeStatus: Completeness['decode'] = decodeRes?.decode ?? (rawBuf.length ? (input.bodyComplete ? 'complete' : 'truncated') : 'none')
    const decodeComplete = decodeRes ? decodeRes.decodeComplete : input.bodyComplete

    if (decodeRes?.reason && !reasons.includes(decodeRes.reason)) reasons.push(decodeRes.reason)
    if (input.isAuth && !reasons.includes('auth-url')) reasons.push('auth-url')
    if (input.isLive && !reasons.includes('live')) reasons.push('live')

    if (decodeRes && !decodeRes.ok) {
      const actions: SemanticAction[] = isDatabricksSqlSubmit
        ? [{ family: 'databricks', op: 'databricks:sql_unknown', resource: input.sanitizedPath, details: { sqlClass: 'unknown', uninspectable: true }, coverage: 'unknown' }]
        : input.isWrite
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

    const obj = isJson && isPlainRecord(parsedJson)
      ? parsedJson
      : undefined
    let omitSampleBody = false

    // ---- API-native extractors (surface === 'api') ----
    const surface: 'browser' | 'api' = input.surface ?? 'browser'
    const decodedPathInfo = decodePathSegmentsStrict(input.url.pathname)
    const decodedLowerPath = decodedPathInfo.decodedPath.toLowerCase()
    const makeTargetDigest = (resourceId?: string, bodySelector?: string, connTypeOverride?: string) =>
      computeTargetDigest({
        surface,
        connectionType: connTypeOverride !== undefined ? connTypeOverride : input.connectionType,
        host: input.url.hostname,
        port: input.url.port,
        scheme: input.url.protocol.replace(/:$/, ''),
        rawPathname: input.url.pathname,
        rawSearch: input.url.search,
        ...(resourceId && { resourceId }),
        ...(bodySelector && { bodySelector }),
      }, input.hmacKey)
    const isGraphHost = input.url.hostname.toLowerCase() === 'graph.microsoft.com'
    const isGraph = input.connectionType === 'graph' || (input.surface === 'api' && isGraphHost)
    const isDatabricks = input.connectionType === 'databricks' || (input.surface === 'api' && input.url.hostname.toLowerCase().endsWith('.azuredatabricks.net'))
    const isService = input.connectionType === 'service'
    // Restrict /v1.0/ and /beta/ exemption strictly to established Graph destinations (graph.microsoft.com)!
    const isGraphApiPath = isGraphHost && (decodedLowerPath.startsWith('/v1.0/') || decodedLowerPath.startsWith('/beta/'))
    const isSharePointRoute =
      !isGraphApiPath && (
        decodedLowerPath.includes('/_api/') ||
        decodedLowerPath.includes('/_vti_bin/') ||
        (decodedPathInfo.invalidEncoding && (
          /(?:^|\.)sharepoint\.com$/i.test(input.url.hostname) ||
          (() => {
            const twice = decodePathSegmentsStrict(decodedPathInfo.decodedPath).decodedPath.toLowerCase()
            return twice.includes('/_api/') || twice.includes('/_vti_bin/')
          })()
        ))
      )
    const isUploadSessionHost = /(?:^|\.)(?:sharepoint\.com|svc\.ms|outlook\.office(?:365)?\.com)$/i.test(input.url.hostname)
    const spDestructiveOp = /\/(?:recycle|recyclewithparameters|deleteobject|deletebyids?|deleteall|deleteallsecondstageitems|deletewithparameters)(?:\(|$|\/)/i.test(decodedLowerPath)
    const isSpBatchPath = /(?:^|\/)(?:_api|_vti_bin)(?:\/[^/]*)?\/\$batch\/?$/i.test(decodedLowerPath)
    const isSpDeleteOrAmbiguous = isSharePointRoute && (spDestructiveOp || isSpBatchPath || decodedPathInfo.invalidEncoding)
    const isGrantedUploadChunk =
      !isSpDeleteOrAmbiguous &&
      input.surface === 'api' &&
      input.connectionType === 'link' &&
      input.method === 'PUT' &&
      input.effectiveMethod === 'PUT' &&
      isUploadSessionHost &&
      (input.linkProvenance?.linkKind === 'upload_session' || isUploadSessionEndpointPath(input.url.pathname))

    if (isGrantedUploadChunk) {
      actions.push({
        family: 'graph',
        op: 'graph:upload_session_chunk',
        resource: input.sanitizedPath,
        details: {
          uploadSession: true,
          ...(input.linkProvenance?.sourceType && { sourceType: input.linkProvenance.sourceType }),
          targetDigest: makeTargetDigest(),
        },
        coverage: isBinary || input.transport === 'truncated' ? 'complete' : defaultCov,
      })
      extractStatus = 'complete'
    } else if (isSharePointRoute) {
      // Classify supported SharePoint REST routes BEFORE generic Graph, Databricks, service, and E1 heuristics!
      const sanLower = input.sanitizedPath.toLowerCase()
      const apiIdx = sanLower.indexOf('/_api/') >= 0 ? sanLower.indexOf('/_api/') : sanLower.indexOf('/_vti_bin/')
      const spResource = apiIdx >= 0 ? input.sanitizedPath.slice(apiIdx) : input.sanitizedPath
      const hasIfMatch = hasStrongIfMatch(input.rawHeaders)
      const isDeleteByIds = /\/deletebyids(?:\(|$|\/)/i.test(decodedLowerPath)
      // Suppress body-derived key paths (bodyShape), raw samples (reqBody), and metadata values on DeleteByIds
      // AND on ambiguously/double-encoded SharePoint routes BEFORE any sub-op branching!
      const suppressSpBody = isDeleteByIds || decodedPathInfo.invalidEncoding
      if (suppressSpBody) {
        omitSampleBody = true
        bodyShape = undefined
      }
      // Anchor $batch strictly to the SharePoint REST endpoint suffix (NOT arbitrary site prefixes like /sites/$batch/_api/...)!
      if (isSpBatchPath) {
        actions.push({
          family: 'sharepoint',
          op: 'sharepoint:batch',
          resource: spResource,
          details: {
            hasRequestDigest: Boolean(input.rawHeaders['x-requestdigest']),
            hasIfMatch,
            ...(decodedPathInfo.invalidEncoding && { ambiguousPathEncoding: true }),
            ...(input.isWrite && { targetDigest: makeTargetDigest(undefined, undefined, 'sharepoint') }),
          },
          coverage: 'opaque-batch',
        })
        extractStatus = 'opaque'
      } else {
        const destructiveAction = spDestructiveOp
        let bodySelector: string | undefined
        let selectedIdCount: number | undefined
        let bodySelectionIncomplete = false
        if (isDeleteByIds && input.isWrite) {
          if (!fullyIntact || !obj) {
            bodySelectionIncomplete = true
          } else {
            const idMatches = keyedCI(obj, 'ids')
            const allowedMetaKeys = new Set(['__metadata', '@odata.type'])
            const extraKeys = Object.keys(obj).filter(k => k.toLowerCase() !== 'ids' && !allowedMetaKeys.has(k.toLowerCase()))
            if (idMatches.length !== 1 || extraKeys.length > 0) {
              bodySelectionIncomplete = true
            } else {
              const parsed = validateSharePointDeleteIds(idMatches[0])
              if (!parsed.ok) {
                bodySelectionIncomplete = true
              } else {
                selectedIdCount = parsed.ids.length
                bodySelector = parsed.bodySelector
              }
            }
          }
        }
        // Keep runtime selector strings local to targetDigest computation — NEVER copy raw IDs or body metadata on DeleteByIds or ambiguous routes!
        const details: Record<string, unknown> = {
          hasIfMatch,
          hasRequestDigest: Boolean(input.rawHeaders['x-requestdigest']),
          ...(destructiveAction && { destructiveAction: true }),
          ...(decodedPathInfo.invalidEncoding && { ambiguousPathEncoding: true }),
          ...(bodySelectionIncomplete && { bodySelectionIncomplete: true }),
          ...(selectedIdCount !== undefined && { selectedIdCount }),
          ...(input.isWrite && !bodySelectionIncomplete && { targetDigest: makeTargetDigest(undefined, bodySelector, 'sharepoint') }),
        }
        if (input.hdr?.['x-http-method']) details.override = input.hdr['x-http-method']
        if (!suppressSpBody) {
          const rawMetaType = (obj?.__metadata as any)?.type ?? obj?.['@odata.type']
          const metaIdent = validateStructuralIdent(rawMetaType, /^[#A-Za-z][A-Za-z0-9_.-]{0,63}$/, input.vault)
          vaultRedactions += metaIdent.vaultRedactions
          if (metaIdent.value) details.metadataType = metaIdent.value
        }

        actions.push({
          family: 'sharepoint',
          op: destructiveAction ? 'sharepoint:delete' : `sharepoint:${input.effectiveMethod}`,
          resource: spResource,
          details,
          coverage: decodedPathInfo.invalidEncoding || bodySelectionIncomplete ? 'unknown' : defaultCov,
        })
        extractStatus = decodedPathInfo.invalidEncoding || bodySelectionIncomplete ? 'opaque' : fullyIntact ? 'complete' : 'partial'
      }
    } else if (isGraph) {
      const segs = lowerPath.replace(/^\/(?:v1\.0|beta)\//, '').split('/').filter(Boolean)
      // Decode & strip OData parenthesized keys (e.g. messages('AAMk...'), mailFolders('inbox')) on intermediate segments
      // to match Graph connector collection recognition while keeping raw pathname intact for targetDigest!
      const segCollections = segs.map(s => {
        let dec = s
        try { dec = decodeURIComponent(s) } catch {}
        return dec.toLowerCase().replace(/\(.*$/, '')
      })
      const lastSeg = (segCollections.at(-1) ?? '').split('.').pop() ?? ''
      const hasIfMatch = hasStrongIfMatch(input.rawHeaders)
      const eff = input.effectiveMethod

      if (input.isWrite && ['sendmail', 'send', 'reply', 'replyall', 'forward'].includes(lastSeg)) {
        const isMime = !isJson && input.reqType === 'text/plain' && decodedText !== undefined
        const recips = isMime ? extractMimeRecipientDomains(decodedText!) : extractRecipientDomains(obj)
        const attachmentCount = isMime ? 0 : extractAttachmentCount(obj)
        const opName = lastSeg === 'sendmail' ? 'sendMail' : lastSeg === 'replyall' ? 'replyAll' : lastSeg
        // reply / replyAll / draft send carry implicit server-side recipients not provable from request body alone!
        const recipientsComplete = (lastSeg === 'sendmail' || lastSeg === 'forward') ? recips.complete : false
        actions.push({
          family: 'graph',
          op: `graph:${opName}`,
          resource: input.sanitizedPath,
          details: {
            recipientDomains: recips.domains,
            recipientCount: recips.count,
            recipientsComplete,
            attachmentCount,
            targetDigest: makeTargetDigest(),
            ...(isMime && { isMime: true }),
          },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && eff === 'POST' && lastSeg === 'messages' && (segCollections.includes('chats') || segCollections.includes('channels'))) {
        actions.push({
          family: 'graph',
          op: 'graph:teams_message',
          resource: input.sanitizedPath,
          details: { ...(bodyShape && { fieldCount: Object.keys(bodyShape).length }), targetDigest: makeTargetDigest() },
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
            recipientsComplete: recips.complete,
            attachmentCount,
            targetDigest: makeTargetDigest(),
          },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && (segCollections.includes('messages') || segCollections.includes('mailfolders')) && (eff === 'PATCH' || lastSeg === 'move')) {
        const fields = obj ? Object.keys(obj).slice(0, 32).map(k => scrubStructuralKey(k, input.vault).key) : []
        actions.push({
          family: 'graph',
          op: 'graph:mail_patch',
          resource: input.sanitizedPath,
          details: { ...(fields.length && { fields }), hasIfMatch, targetDigest: makeTargetDigest() },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && segCollections.includes('workbook')) {
        actions.push({
          family: 'graph',
          op: 'graph:excel_write',
          resource: input.sanitizedPath,
          details: { method: eff, hasIfMatch, targetDigest: makeTargetDigest() },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite && eff === 'PUT' && lastSeg === 'content') {
        actions.push({
          family: 'graph',
          op: 'graph:file_write',
          resource: input.sanitizedPath,
          details: { hasIfMatch, targetDigest: makeTargetDigest() },
          coverage: isBinary || input.transport === 'truncated' ? 'complete' : defaultCov,
        })
        extractStatus = 'complete'
      } else if (
        input.isWrite &&
        (eff === 'DELETE' || input.method === 'DELETE' || lastSeg === 'permanentdelete') &&
        (segCollections.includes('drives') || segCollections.includes('drive') || segCollections.includes('items') || segCollections.includes('shares') || segCollections.includes('messages') || segCollections.includes('mailfolders'))
      ) {
        actions.push({
          family: 'graph',
          op: 'graph:file_delete',
          resource: input.sanitizedPath,
          details: {
            hasIfMatch,
            targetDigest: makeTargetDigest(),
            ...(lastSeg === 'permanentdelete' && { permanentDelete: true }),
          },
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else if (input.isWrite) {
        actions.push({
          family: 'graph',
          op: `graph:${eff}`,
          resource: input.sanitizedPath,
          details: { hasIfMatch, targetDigest: makeTargetDigest() },
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
      if (cleanPath === '/api/2.0/sql/statements' && (input.method === 'POST' || input.effectiveMethod === 'POST')) {
        const stmtRaw = typeof obj?.statement === 'string' ? obj.statement : undefined
        const stmtTrimmed = stmtRaw?.trim() ?? ''
        const cls = stmtTrimmed
          ? classifySqlStatement(stmtRaw!)
          : { sqlClass: 'unknown' as const, statements: [], destructive: false, hasDropOrTruncate: false, hasDelete: false }
        const uninspectableSql =
          !stmtTrimmed ||
          structuredJsonParseFailed ||
          !fullyIntact ||
          isBinary ||
          cls.ambiguous === true ||
          cls.hasUnknownStatement === true ||
          cls.sqlClass === 'unknown'
        const details: Record<string, unknown> = {
          sqlClass: cls.sqlClass,
          statements: cls.statements,
          destructive: cls.destructive,
          ...(cls.hasDropOrTruncate && { hasDropOrTruncate: true }),
          ...(cls.hasDelete && { hasDelete: true }),
          ...(cls.hasMergeDelete && { hasMergeDelete: true }),
          ...(cls.hasUnknownStatement && { hasUnknownStatement: true }),
          ...(cls.ambiguous && { ambiguous: true }),
          ...(uninspectableSql && { uninspectable: true }),
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
        if (Array.isArray(obj?.parameters) && obj.parameters.length > 0) {
          details.parameterCount = obj.parameters.length
        }
        // Only compute sqlContextDigest for approvable non-read SQL (skip read-only SELECTs AND unconditionally denied
        // DROP/TRUNCATE/INSERT OVERWRITE/REPLACE WHERE/MERGE...THEN DELETE so 512+ param nodes never downgrade a deny!).
        if (stmtRaw && cls.sqlClass !== 'read' && !cls.hasDropOrTruncate && !cls.hasMergeDelete && !uninspectableSql) {
          details.sqlContextDigest = computeSqlContextDigest({
            sql: stmtRaw,
            ...(obj && 'parameters' in obj ? { parameters: obj.parameters } : {}),
            warehouseId: typeof obj?.warehouse_id === 'string' ? obj.warehouse_id : undefined,
            catalog: typeof obj?.catalog === 'string' ? obj.catalog : undefined,
            schema: typeof obj?.schema === 'string' ? obj.schema : undefined,
          }, input.hmacKey)
        }

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
          ...(input.isWrite && { details: { targetDigest: makeTargetDigest() } }),
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      } else {
        actions.push({
          family: 'databricks',
          op: `databricks:${input.effectiveMethod}`,
          resource: input.sanitizedPath,
          ...(input.isWrite && { details: { targetDigest: makeTargetDigest() } }),
          coverage: defaultCov,
        })
        extractStatus = fullyIntact ? 'complete' : 'partial'
      }
    } else if (
      // Explicit E1 /jderest/ routes take precedence ahead of generic `isService` fallback!
      decodedLowerPath.includes('/jderest/') ||
      (decodedPathInfo.invalidEncoding && decodePathSegmentsStrict(decodedPathInfo.decodedPath).decodedPath.toLowerCase().includes('/jderest/')) ||
      (!isService && !!obj && (
        (typeof obj.formName === 'string' && (Array.isArray(obj.formActions) || typeof obj.formServiceAction === 'string' || 'actionRequest' in obj || 'formRequest' in obj)) ||
        Array.isArray(obj.formRequests)
      ))
    ) {
      const m = /\/jderest\/(?:v\d+\/)?([^/;?]+)/i.exec(decodedPathInfo.decodedPath)
      const rawEndpoint = m ? m[1].toLowerCase() : 'ais'
      const endpoint = E1_ENDPOINTS.has(rawEndpoint) ? rawEndpoint : 'ais'

      const details: Record<string, unknown> = {}
      let malformedE1Action = false
      let conflictingActions = false
      let unattributedMutation = false
      let hasMutatingFormAction = false
      const mutatingForms = new Set<string>()
      const allFormNames: string[] = []
      const scalarActionValues: string[] = []
      const allRawActions: unknown[] = []
      let sawFormActionsField = false

      // Process each E1 request unit (top-level + each batch formRequests[] entry) independently so per-form
      // mutation associations are preserved, every logical unit must carry at least one usable leaf E1 field
      // (rejecting empty wrappers like { formRequest: {} }), and a single-form approval NEVER covers another form!
      const inspectE1Unit = (unit: Record<string, unknown>): boolean => {
        const containers: Record<string, unknown>[] = [unit]
        for (const subKey of ['actionRequest', 'formRequest'] as const) {
          if (subKey in unit && unit[subKey] !== undefined) {
            if (isPlainRecord(unit[subKey])) {
              containers.push(unit[subKey] as Record<string, unknown>)
            } else {
              malformedE1Action = true
            }
          }
        }
        let hasUsableField = false
        const unitFormNames: string[] = []
        for (const c of containers) {
          for (const fk of ['formName', 'targetName'] as const) {
            if (fk in c && c[fk] !== undefined && c[fk] !== null) {
              if (typeof c[fk] === 'string' && (c[fk] as string).trim()) {
                const ident = validateStructuralIdent(c[fk], STRUCT_IDENT_RE, input.vault)
                vaultRedactions += ident.vaultRedactions
                if (ident.value) { unitFormNames.push(ident.value); hasUsableField = true }
                else malformedE1Action = true
              } else {
                malformedE1Action = true
              }
            }
          }
        }
        const uniqueUnitForms = [...new Set(unitFormNames)]
        if (uniqueUnitForms.length > 1) malformedE1Action = true
        const unitForm = uniqueUnitForms.length === 1 ? uniqueUnitForms[0] : undefined
        if (unitForm) allFormNames.push(unitForm)

        const unitScalars: string[] = []
        for (const c of containers) {
          for (const k of ['action', 'formServiceAction'] as const) {
            if (k in c && c[k] !== undefined && c[k] !== null) {
              if (typeof c[k] === 'string' && (c[k] as string).trim()) {
                const v = (c[k] as string).trim()
                unitScalars.push(v)
                scalarActionValues.push(v)
                hasUsableField = true
              } else {
                malformedE1Action = true
              }
            }
          }
        }
        const normUnitScalars = [...new Set(unitScalars.map(s => s.toUpperCase()))]
        if (normUnitScalars.length > 1) conflictingActions = true
        let unitMutates = normUnitScalars.some(s => s === 'W' || s === 'C' || s === 'U' || s === 'D')

        for (const c of containers) {
          if ('formActions' in c && c.formActions !== undefined) {
            sawFormActionsField = true
            if (Array.isArray(c.formActions)) {
              for (const a of c.formActions) {
                allRawActions.push(a)
                if (!isPlainRecord(a)) {
                  malformedE1Action = true
                  continue
                }
                const cmd = a.command
                if (typeof cmd !== 'string' || !cmd.trim()) {
                  malformedE1Action = true
                  continue
                }
                hasUsableField = true
                if (E1_MUTATING_FORM_COMMANDS.has(cmd.toLowerCase())) {
                  unitMutates = true
                  hasMutatingFormAction = true
                }
              }
            } else {
              malformedE1Action = true
            }
          }
          // Legitimate read/data-service leaf fields (never counting bare empty wrappers formRequest/actionRequest!)
          if (typeof c.dataServiceType === 'string' && c.dataServiceType.trim()) hasUsableField = true
          if ((typeof c.findOnEntry === 'string' && c.findOnEntry.trim()) || typeof c.findOnEntry === 'boolean') hasUsableField = true
          if (typeof c.returnControlIDs === 'string' && c.returnControlIDs.trim()) hasUsableField = true
          if (
            (typeof c.maxPageSize === 'string' && c.maxPageSize.trim()) ||
            (typeof c.maxPageSize === 'number' && Number.isFinite(c.maxPageSize)) ||
            isRawJsonLeaf(c.maxPageSize)
          ) {
            hasUsableField = true
          }
        }
        if (unitMutates) {
          if (unitForm) mutatingForms.add(unitForm)
          else unattributedMutation = true
        }
        return hasUsableField
      }

      if (obj) {
        const rootUsable = inspectE1Unit(obj)
        // On single-unit endpoints (formservice, dataservice), ALWAYS enforce rootUsable even if formRequests[] is present!
        if (input.isWrite && (endpoint === 'formservice' || endpoint === 'dataservice') && !rootUsable) {
          malformedE1Action = true
        }
        if ('formRequests' in obj && obj.formRequests !== undefined) {
          if (Array.isArray(obj.formRequests) && obj.formRequests.length > 0) {
            for (const item of obj.formRequests) {
              if (!isPlainRecord(item) || !inspectE1Unit(item)) {
                malformedE1Action = true
              }
            }
          } else {
            malformedE1Action = true
          }
        } else if (endpoint === 'batchformservice' && input.isWrite) {
          malformedE1Action = true
        }
      } else if (
        parsedJson !== undefined ||
        structuredJsonParseFailed ||
        (input.isWrite && (endpoint === 'formservice' || endpoint === 'batchformservice' || endpoint === 'dataservice'))
      ) {
        // Empty, non-object (array/number/primitive), or unparseable JSON body on an E1 write endpoint is malformed!
        malformedE1Action = true
      }

      const uniqueAllForms = [...new Set(allFormNames)]
      const primaryForm = uniqueAllForms[0]
      if (primaryForm) details.formName = primaryForm
      if (mutatingForms.size > 0) details.mutatingForms = [...mutatingForms].sort()
      if (unattributedMutation) details.unattributedMutation = true

      const verIdent = validateStructuralIdent(obj?.version, STRUCT_IDENT_RE, input.vault)
      vaultRedactions += verIdent.vaultRedactions
      if (verIdent.value) details.version = verIdent.value

      const mutatingScalar = scalarActionValues.find(s => ['W', 'C', 'U', 'D'].includes(s.toUpperCase()))
      const primaryScalar = mutatingScalar ?? scalarActionValues[0]
      const actIdent = validateStructuralIdent(primaryScalar, /^[A-Za-z][A-Za-z0-9_-]{0,23}$/, input.vault)
      vaultRedactions += actIdent.vaultRedactions
      if (actIdent.value) details.action = actIdent.value
      if (conflictingActions) details.conflictingActions = true

      const targetTypeIdent = validateStructuralIdent(obj?.targetType, STRUCT_IDENT_RE, input.vault)
      vaultRedactions += targetTypeIdent.vaultRedactions
      if (targetTypeIdent.value) details.targetType = targetTypeIdent.value

      const dsTypeIdent = validateStructuralIdent(obj?.dataServiceType, STRUCT_IDENT_RE, input.vault)
      vaultRedactions += dsTypeIdent.vaultRedactions
      if (dsTypeIdent.value) details.dataServiceType = dsTypeIdent.value

      if (sawFormActionsField) {
        if (hasMutatingFormAction) details.hasMutatingFormAction = true
        const summarized = allRawActions.slice(0, 32).map(a => {
          if (!isPlainRecord(a)) return { command: 'unknown' }
          const rec = a
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
        if (allRawActions.length > 32) details.formActionsTruncated = true
      }
      if (malformedE1Action) details.malformedE1Action = true

      if (input.isWrite) details.targetDigest = makeTargetDigest(primaryForm)

      const op = actIdent.value ? `${endpoint}:${actIdent.value}` : `${endpoint}:${input.effectiveMethod}`
      const resource = primaryForm ?? input.sanitizedPath
      actions.push({
        family: 'e1-ais',
        op,
        resource,
        ...(Object.keys(details).length && { details }),
        coverage: defaultCov,
      })
      extractStatus = fullyIntact ? 'complete' : 'partial'
    } else if (isService) {
      const hasIfMatch = hasStrongIfMatch(input.rawHeaders)
      actions.push({
        family: 'service',
        op: `service:${input.effectiveMethod}`,
        resource: input.sanitizedPath,
        details: { ...(hasIfMatch && { hasIfMatch: true }), ...(input.isWrite && { targetDigest: makeTargetDigest() }) },
        coverage: isBinary || structuredJsonParseFailed ? 'partial' : defaultCov,
      })
      extractStatus = isBinary || structuredJsonParseFailed ? 'opaque' : fullyIntact ? 'complete' : 'partial'
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
          ...(input.isWrite && { targetDigest: makeTargetDigest() }),
        },
        coverage: defaultCov,
      })
      extractStatus = bodyRoot || soapAction ? (fullyIntact ? 'complete' : 'partial') : 'opaque'
    } else if (input.isWrite) {
      actions.push({
        family: input.surface === 'api' ? 'api' : 'rest',
        op: `${input.surface === 'api' ? 'api' : 'rest'}:${input.effectiveMethod}`,
        resource: input.sanitizedPath,
        details: { targetDigest: makeTargetDigest() },
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
      } else if (input.projection === 'semantic' || omitSampleBody) {
        reqOmitted = 'policy-profile'
      } else if (structuredJsonParseFailed) {
        reqOmitted = 'policy-profile'
        reqTrunc = true
      } else if (input.sampleBudgetOk === false) {
        reqOmitted = 'budget'
      } else if (decodedText !== undefined) {
        let redactedText: string | undefined
        if (isJson) {
          const rj = redactJsonValue(parsedJson, input.vault, false)
          vaultRedactions += rj.vaultRedactions
          redactedText = JSON.stringify(rj.value)
        } else if (input.reqType === 'application/x-www-form-urlencoded') {
          const rf = redactFormBody(decodedText, input.vault)
          vaultRedactions += rf.vaultRedactions
          redactedText = rf.text
        } else {
          // Never emit unparsed plaintext body samples (fail-closed policy-profile omission).
          reqOmitted = 'policy-profile'
        }
        if (redactedText !== undefined) {
          if (Buffer.byteLength(redactedText, 'utf8') > MAX_SAMPLE_BODY_BYTES) {
            reqBody = truncateUtf8HeadTail(redactedText, MAX_SAMPLE_BODY_BYTES, 3072, 1020)
            reqTrunc = true
          } else {
            reqBody = redactedText
          }
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
      actions: isDatabricksSqlSubmit
        ? [{ family: 'databricks', op: 'databricks:sql_unknown', resource: input.sanitizedPath, details: { sqlClass: 'unknown', uninspectable: true }, coverage: 'unknown' }]
        : input.isWrite
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
  linkProvenance?: { sourceType?: string; linkKind?: 'upload_session' | 'download' | 'redirect' }
  hmacKey?: Buffer
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
    linkProvenance: opts.linkProvenance,
    hmacKey: opts.hmacKey,
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
