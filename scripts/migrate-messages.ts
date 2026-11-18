import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTHORITY_FORMAT, authorityTree, checkSeriesAuthority } from '../src/authority-format.ts';
import { deletedEntry, eventsFile, instanceAnchor, instanceMessage, jsonLines, messageFloor, messagesFile, notesFile, projectInstance, projectNotes, readEntries, readMessages, seriesNote, storedMessage, unprojectedMessage, validateInstanceLog, validateMessage, type StoredMessage } from '../src/message-store.ts';
import { answered, answers, waitsOn } from '../src/messages.ts';
import type { SeriesSettings } from '../src/series.ts';
import type { Entry, Meta } from '../src/store.ts';
import { replaceFile } from '../src/system.ts';
import { planSkillMigration, publishSkillMigration } from './migrate-skills.ts';

const LEGACY_READER = '0.7.0'; // The exact minReader written by v0.7.9, not a semver range.
type Pending = { entry: Entry; anchor: StoredMessage['anchor']; time: number; stream: string; legacyOpen?: true };
type RequestRef = { series: string; label: string; inst?: string; target?: string; message?: number };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Preflight the stopped copy before touching the envelope, logs or live skills. Working/, Git and session/ are not inputs.
// An interrupted copy must be discarded, not resumed.
export function migrateMessageCopy(copy: string, apply = false, progress?: (line: string) => void) {
  const root = resolve(copy), st = lstatSync(root);
  if (!st.isDirectory() || realpathSync(root) !== root) throw new Error('the stopped copy must be a real directory, not a symlink');
  // Even a bind mount on the same device can point back into the original.
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => line.split(' ')[4]?.replace(/\\([0-7]{3})/g,
    (_, octal) => String.fromCharCode(parseInt(octal, 8))).startsWith(prefix)))
    throw new Error('the stopped copy must not contain mounts');
  function pathIs(path: string, kind: 'file' | 'directory', optional = false) {
    const found = lstatSync(path, { throwIfNoEntry: false });
    if (!found && optional) return false;
    if (!found || found.dev !== st.dev || (kind === 'file' ? !found.isFile() || found.nlink !== 1 : !found.isDirectory()))
      throw new Error(`${path}: expected a private regular ${kind} in the stopped copy (no links or other filesystems)`);
    return true;
  }
  function absent(path: string) {
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`${path}: unsafe or partial conversion`);
  }
  const rf = join(root, '.rf'), manifest = join(rf, 'tree.json'), lock = join(rf, 'migrate-messages.lock');
  pathIs(rf, 'directory');
  pathIs(manifest, 'file');
  absent(manifest + '.tmp');
  absent(lock);
  const before = readFileSync(manifest, 'utf8'), envelope = JSON.parse(before);
  if (envelope?.state === 'incomplete') throw new Error('incomplete message conversion; discard this copy and start with a fresh stopped copy');
  if (envelope?.state !== 'complete' || envelope.format !== AUTHORITY_FORMAT.format || envelope.version !== AUTHORITY_FORMAT.version
    || Object.keys(envelope).length !== 5 || ![LEGACY_READER, AUTHORITY_FORMAT.minReader].includes(envelope.minReader))
    throw new Error('unsupported format: expected the complete v0.7.9 series-owner envelope');
  const converted = envelope.minReader === AUTHORITY_FORMAT.minReader;
  const tree = authorityTree({ ...envelope, minReader: AUTHORITY_FORMAT.minReader });
  const books = join(root, 'series'), instances = join(root, 'instances');
  pathIs(books, 'directory', true);
  const ids = pathIs(instances, 'directory', true) ? readdirSync(instances).sort() : [];
  const plans = new Map<string, { dir: string; settings: SeriesSettings; legacyNotes: Entry[]; pending: Pending[]; records: StoredMessage[] }>();
  const periods = new Map<string, { series: string; deleted: boolean }>();
  const events = new Map<string, { source: string; projection: string; eventRows: Entry[]; legacy: Entry[] }>();
  let eventCount = 0;
  progress?.(`Preflight: ${Object.keys(tree.series).length} series, ${ids.length} instances${converted ? ' (converted)' : ''}`);
  const deletedLabels = new Map<string, Set<string>>();
  const openedBy = new Map<string, Record<string, unknown>>();
  const seen = join(rf, 'seen');
  for (const sid of Object.keys(tree.series).sort()) {
    const dir = join(books, sid), notes = notesFile(dir);
    pathIs(dir, 'directory');
    const settingsFile = join(dir, 'series.json');
    pathIs(settingsFile, 'file');
    const settings: SeriesSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    const legacyNotes = pathIs(dirname(notes), 'directory', true) && pathIs(notes, 'file', true) ? readEntries(notes) : [];
    absent(notes + '.tmp');
    absent(messagesFile(dir) + '.tmp');
    absent(messageFloor(dir) + '.tmp');
    if (!converted) for (const path of [messagesFile(dir), messageFloor(dir), join(dir, 'events')]) absent(path);
    else if (pathIs(messageFloor(dir), 'file', true)) {
      const floor = Number(readFileSync(messageFloor(dir), 'utf8'));
      if (!Number.isSafeInteger(floor) || floor <= 0) throw new Error(`${dir}: invalid message ID floor`);
    }
    let time = -Infinity;
    const pending: Pending[] = [];
    if (!converted) for (const e of legacyNotes) {
      if (!seriesNote(e.op)) throw new Error(`${notes}: invalid series note op at seq ${e.seq}`);
      pending.push({ entry: e, anchor: {}, time: time = Math.max(time, Date.parse(e.at)), stream: '' });
    }
    if (converted) pathIs(messagesFile(dir), 'file');
    plans.set(sid, { dir, settings, legacyNotes, pending, records: converted ? readMessages(dir) : [] });
  }
  checkSeriesAuthority(root, tree);
  if (!converted && pathIs(seen, 'directory', true)) for (const { settings: { owner } } of plans.values()) {
    if (!owner || openedBy.has(owner)) continue;
    if (/[/\\\0]/.test(owner)) throw new Error('invalid series owner for a read marker');
    const marker = join(seen, owner + '.json');
    const opened: unknown = pathIs(marker, 'file', true) ? JSON.parse(readFileSync(marker, 'utf8')).at : {};
    if (!record(opened) || Object.values(opened).some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0))
      throw new Error(`${marker}: invalid read marker`);
    openedBy.set(owner, opened);
  }
  const byInstance = Map.groupBy([...plans.values()].flatMap(p => p.records.filter(m => m.anchor.instance)), m => m.anchor.instance!);
  for (const id of ids) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`invalid instance directory name: ${id}`);
    const dir = join(instances, id), meta = join(dir, 'instance.json'), projection = join(dir, 'log.jsonl');
    pathIs(dir, 'directory');
    pathIs(meta, 'file');
    pathIs(projection, 'file');
    absent(projection + '.tmp');
    const m: Meta = JSON.parse(readFileSync(meta, 'utf8')), plan = plans.get(m?.series);
    if (!plan || typeof m.label !== 'string') throw new Error(`${meta}: invalid or unpublished instance`);
    absent(join(dir, 'events.jsonl'));
    const source = eventsFile(plan.dir, id), legacy = readEntries(projection);
    validateInstanceLog(projection, legacy);
    let eventRows: Entry[];
    if (converted) {
      pathIs(join(plan.dir, 'events'), 'directory');
      pathIs(dirname(source), 'directory');
      pathIs(source, 'file');
      absent(source + '.tmp');
      eventRows = readEntries(source);
      if (jsonLines(projectInstance(source, eventRows, byInstance.get(id) ?? [])) !== jsonLines(legacy))
        throw new Error(`${projection}: instance projection mismatch`);
    } else {
      eventRows = [];
      const openNotes = new Set<Entry>();
      if (legacy[0].op !== 'delete') {
        const screen = join(dir, 'screen.json');
        const status = pathIs(screen, 'file', true) ? JSON.parse(readFileSync(screen, 'utf8'))?.status : 'open';
        if (!['open', 'closed', 'abandoned', 'deleted'].includes(status)) throw new Error(`${screen}: invalid instance status`);
        if (status === 'open') {
          const inst = { log: legacy, copied: legacy.findLast(e => e.op === 'duplicate')?.seq ?? 0 };
          const { owner = '', epoch } = plan.settings, marks = openedBy.get(owner);
          const opened = marks && Object.hasOwn(marks, id) ? marks[id] as number : 0;
          const settled = new Set(legacy.filter(e => e.op === 'settle').map(e => e.on));
          for (const { e } of waitsOn(inst, owner, opened, 0)) {
            if (e.op !== 'comment' || e.ask || e.by === e.authorityOwner || settled.has(e.seq)) continue;
            const ask = answers(inst, e);
            if (ask?.to === e.by && (ask.authorityEpoch === undefined ||
              ask.authorityEpoch === (e.authorityEpoch ?? epoch) && ask.authorityOwner === (e.authorityOwner ?? owner))) continue;
            if (!answered(legacy, e)) openNotes.add(e);
          }
        }
      }
      let time = -Infinity;
      for (const e of legacy) {
        if (seriesNote(e.op) || unprojectedMessage(e.op)) throw new Error(`${projection}: misplaced message at seq ${e.seq}`);
        if (instanceMessage(e)) plan.pending.push({ entry: e, anchor: instanceAnchor(id, e, legacy), time: time = Math.max(time, Date.parse(e.at)), stream: id,
          ...(openNotes.has(e) && { legacyOpen: true }) });
        else eventRows.push(e.op === 'delete' ? deletedEntry(e) : e);
      }
    }
    if (!converted) events.set(id, { source, projection, eventRows, legacy });
    eventCount += eventRows.length;
    const deleted = eventRows[0]?.op === 'delete';
    periods.set(id, { series: m.series, deleted });
    if (periods.size % 100 === 0) progress?.(`Preflight: checked ${periods.size}/${ids.length} instances`);
    if (deleted) {
      if (!deletedLabels.has(m.series)) deletedLabels.set(m.series, new Set());
      deletedLabels.get(m.series)!.add(m.label);
    }
  }
  const wakesPath = join(rf, 'wakes.json');
  absent(wakesPath + '.tmp');
  let wakes: unknown = { pending: {}, fired: {}, requests: {} };
  if (pathIs(wakesPath, 'file', true)) {
    const text = readFileSync(wakesPath, 'utf8');
    try { wakes = JSON.parse(text); } catch { throw new Error(`${wakesPath}: invalid scheduler state`); }
  }
  if (!record(wakes) || !record(wakes.pending) || !record(wakes.fired) || !record(wakes.requests)) throw new Error(`${wakesPath}: invalid scheduler state`);
  const requests = new Map<string, RequestRef>(), lastRequestTime = new Map<string, number>();
  for (const [requestId, r] of Object.entries(wakes.requests)) {
    const keys = ['series', 'label', 'inst', 'target', ...(converted ? ['message'] : ['from', 'at', 'text'])];
    if (!record(r) || !/^[\w-]+$/.test(requestId) || Object.keys(r).some(k => !keys.includes(k))
      || typeof r.series !== 'string' || !plans.has(r.series) || typeof r.label !== 'string' || !r.label
      || (r.inst !== undefined && (typeof r.inst !== 'string' || !periods.has(r.inst)))
      || (r.target !== undefined && (typeof r.target !== 'string' || periods.get(r.target)?.series !== r.series)))
      throw new Error(`${wakesPath}: invalid scheduler request`);
    const ref: RequestRef = { series: r.series, label: r.label, ...(r.inst !== undefined && { inst: r.inst }), ...(r.target !== undefined && { target: r.target }) };
    const plan = plans.get(ref.series)!, holes = deletedLabels.get(ref.series);
    const gone = (ref.inst && periods.get(ref.inst)!.deleted)
      || (ref.target ? periods.get(ref.target)!.deleted : holes?.has(ref.label))
      || (tree.series[ref.series].single && holes?.size);
    if (converted) {
      const message = r.message;
      if (typeof message !== 'number' || !Number.isSafeInteger(message) || message <= 0) throw new Error(`${wakesPath}: invalid request reference`);
      const row = plan.records.find(m => m.id === message);
      if (row && (row.entry.op !== 'request' || row.entry.requestId !== requestId || row.anchor.instance !== ref.target
        || row.entry.label !== ref.label || row.entry.source !== ref.inst)) throw new Error(`${wakesPath}: invalid request reference`);
      if (gone || plan.records.some(m => m.id > message && m.anchor.instance === ref.target && m.entry.op === 'request-decision'
        && m.entry.requestId === requestId && m.entry.request === message)) continue;
      if (!row) throw new Error(`${wakesPath}: invalid request reference`);
      ref.message = message;
    } else {
      if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at)) || typeof r.from !== 'string' || !r.from
        || (r.text !== undefined && typeof r.text !== 'string')) throw new Error(`${wakesPath}: invalid legacy request`);
      if (gone) continue;
      const entry: Entry = { seq: 1, at: r.at, by: ref.inst ? 'agent' : r.from, op: 'request', requestId, from: r.from, label: ref.label,
        ...(ref.inst && { source: ref.inst }), ...(r.text !== undefined && { text: r.text }) };
      const time = Math.max(lastRequestTime.get(ref.series) ?? -Infinity, Date.parse(r.at));
      lastRequestTime.set(ref.series, time);
      plan.pending.push({ entry, anchor: ref.target ? { instance: ref.target } : {}, time, stream: '~' });
    }
    requests.set(requestId, ref);
  }
  for (const [sid, p] of plans) {
    // Timestamp order between streams, source order within each log or scheduler map even when the clock went back.
    if (!converted) p.records = p.pending.sort((a, b) => a.time - b.time || (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.entry.seq - b.entry.seq))
      .map(({ anchor, entry, legacyOpen }, i) => storedMessage(i + 1, anchor, entry, legacyOpen));
    for (const r of p.records) {
      validateMessage(r, messagesFile(p.dir));
      if (!converted && r.entry.op === 'request') requests.get(r.entry.requestId as string)!.message = r.id;
      if (!r.anchor.instance) continue;
      const inst = periods.get(r.anchor.instance);
      if (inst?.series !== sid || inst.deleted) throw new Error(`${p.dir}: invalid anchor on message ${r.id}`);
      if (converted) continue;
      const rs = byInstance.get(r.anchor.instance);
      if (rs) rs.push(r); else byInstance.set(r.anchor.instance, [r]);
    }
    if (jsonLines(projectNotes(p.dir, p.records)) !== jsonLines(p.legacyNotes)) throw new Error(`${p.dir}: notes projection mismatch`);
  }
  for (const [id, e] of events) {
    const expected = !converted && e.legacy[0].op === 'delete' ? [deletedEntry(e.legacy[0])] : e.legacy;
    const actual = projectInstance(e.source, e.eventRows, byInstance.get(id) ?? []);
    if (jsonLines(actual) !== jsonLines(expected)) throw new Error(`${e.projection}: instance projection mismatch`);
  }
  progress?.(`Preflight: validated ${plans.size} series, ${periods.size} instances`);
  const skills = planSkillMigration(root, progress);
  if (converted && skills.length) throw new Error('converted copy still needs skill migration; use a fresh stopped copy');
  if (apply && !converted) {
    progress?.('Apply: writing canonical streams to the stopped copy');
    const fd = openSync(lock, 'wx', 0o600);
    try {
      if (readFileSync(manifest, 'utf8') !== before || skills.some(v => lstatSync(v.dir, { throwIfNoEntry: false }) || readlinkSync(v.pointer) !== v.previous))
        throw new Error('the stopped copy changed during preflight');
      replaceFile(manifest, JSON.stringify({ ...AUTHORITY_FORMAT, state: 'incomplete', tree }), true);
      for (const p of plans.values()) replaceFile(messagesFile(p.dir), jsonLines(p.records), true);
      const directories = new Set<string>();
      let written = 0;
      for (const e of events.values()) {
        mkdirSync(dirname(e.source), { recursive: true, mode: 0o700 });
        replaceFile(e.source, jsonLines(e.eventRows), true);
        directories.add(dirname(dirname(e.source)));
        directories.add(dirname(dirname(dirname(e.source))));
        if (e.legacy[0].op === 'delete' && jsonLines(e.legacy) !== jsonLines(e.eventRows)) replaceFile(e.projection, jsonLines(e.eventRows), true);
        if (++written % 100 === 0) progress?.(`Apply: wrote ${written}/${ids.length} instance streams`);
      }
      for (const directory of directories) {
        const d = openSync(directory, 'r');
        try { fsyncSync(d); } finally { closeSync(d); }
      }
      if (Object.keys(wakes.requests).length) replaceFile(wakesPath, JSON.stringify({ ...wakes, requests: Object.fromEntries(requests) }, null, 1), true);
      publishSkillMigration(skills);
      replaceFile(manifest, JSON.stringify({ ...AUTHORITY_FORMAT, tree }), true);
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  const counts = { series: plans.size, instances: periods.size, messages: 0, notes: 0, instanceMessages: 0, events: eventCount, requests: requests.size };
  for (const p of plans.values()) {
    counts.messages += p.records.length;
    counts.notes += p.legacyNotes.length;
    counts.instanceMessages += p.records.filter(r => instanceMessage(r.entry)).length;
  }
  return { status: converted ? 'already converted' : apply ? 'converted' : 'dry run', ...counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, copy, from, source, mode, ...extra] = process.argv.slice(2);
  try {
    if (flag !== '--stopped-copy' || !copy || from !== '--source' || !source || extra.length || ![undefined, '--dry-run', '--apply'].includes(mode))
      throw new Error('usage: node scripts/migrate-messages.ts --stopped-copy COPY --source ORIGINAL [--dry-run | --apply]');
    const original = realpathSync(source), target = realpathSync(copy), a = lstatSync(original), b = lstatSync(target);
    if (!a.isDirectory() || (a.dev === b.dev && a.ino === b.ino) || target.startsWith(original.endsWith(sep) ? original : original + sep)
      || original.startsWith(target.endsWith(sep) ? target : target + sep))
      throw new Error('COPY must be separate from ORIGINAL, and neither directory may contain the other');
    console.log(JSON.stringify(migrateMessageCopy(copy, mode === '--apply', console.error)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
