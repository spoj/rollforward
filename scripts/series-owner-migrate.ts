import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tree } from '../src/system.ts';

const POLICY_BLOCKER = 'Apply unavailable: owner-authenticated offline consent/eligibility verification and legacy work-item transition policy require approval. No conversion or queue cancellation is implemented.';

type Decision = { owner?: string; consentEvidence?: unknown; eligibilityEvidence?: unknown };
type Submission = { series?: Record<string, Decision>; work?: Record<string, unknown>; acknowledgements?: { stopped?: boolean; updaterIdle?: boolean; fullBackupVerified?: boolean } };

export function planSeriesOwners(root: string) {
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    const path = join(entry.parentPath, entry.name), stat = lstatSync(path);
    return { path: relative(root, path), type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other', size: stat.size };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const read = (path: string) => {
    if (!files.some(f => f.path === path && f.type === 'file')) throw new Error(`snapshot requires a regular file: ${path}`);
    return readFileSync(join(root, path), 'utf8');
  };
  const raw = read('.rf/tree.json'), tree: Tree = JSON.parse(raw);
  if ('format' in tree || !tree.workspaces || !tree.series || existsSync(join(root, '.rf/authority-format.json')))
    throw new Error('plan requires a complete legacy snapshot, not converted or sidecar-only authority data');
  const issues: string[] = [];
  const series = Object.entries(tree.series).map(([id, s]) => {
    if (!/^[\w-]+$/.test(id)) throw new Error(`invalid series id: ${id}`);
    if (!tree.workspaces[s.workspace]) issues.push(`series ${id}: missing workspace ${s.workspace}`);
    return { id, workspace: s.workspace, candidates: [] as { person: string; kind: string; path: string; sha256: string; seq?: number }[], instances: [] as string[] };
  });
  for (const f of files.filter(f => /^series\/[^/]+\/series.json$/.test(f.path))) {
    const id = f.path.split('/')[1], s = series.find(s => s.id === id), raw = read(f.path), settings = JSON.parse(raw);
    if (!s) { issues.push(`orphan series settings: ${id}`); continue; }
    if (settings.version !== undefined || settings.owner !== undefined || settings.consent !== undefined) issues.push(`series ${id}: contains nonlegacy authority`);
    if (settings.shared?.by) s.candidates.push({ person: settings.shared.by, kind: 'legacy-sharer', path: f.path, sha256: createHash('sha256').update(raw).digest('hex') });
  }
  const work: { id: string; kind: string; evidence: unknown }[] = [];
  for (const f of files.filter(f => /^instances\/[^/]+$/.test(f.path))) {
    const metaPath = `${f.path}/instance.json`, logPath = `${f.path}/log.jsonl`;
    if (!files.some(f => f.path === metaPath) || !files.some(f => f.path === logPath)) { issues.push(`incomplete instance: ${f.path}`); continue; }
    const meta = JSON.parse(read(metaPath)), raw = read(logPath), s = series.find(s => s.id === meta.series);
    if (!s) { issues.push(`instance ${f.path}: unknown series ${meta.series}`); continue; }
    s.instances.push(f.path.split('/')[1]);
    if (!raw.endsWith('\n')) issues.push(`torn or empty history: ${logPath}`);
    const lines = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)), sha256 = createHash('sha256').update(raw).digest('hex');
    if (lines.some(e => e.op === 'delete')) {
      for (const row of lines.find(e => e.op === 'delete').runs ?? []) if (row.runner)
        s.candidates.push({ person: row.runner, kind: 'historical-tombstone-executor', path: logPath, sha256 });
      continue;
    }
    const last = lines.findLast(e => ['create', 'duplicate', 'takeover', 'assign', 'logins'].includes(e.op));
    const person = last?.op === 'assign' ? last.to : last?.by;
    if (typeof person === 'string') s.candidates.push({ person, kind: 'legacy-current-runner-candidate', path: logPath, seq: last.seq, sha256 });
    else issues.push(`unknown current runner: ${logPath}`);
    const screen = JSON.parse(read(`${f.path}/screen.json`));
    if (screen.status === 'open') work.push({ id: `instance:${f.path.split('/')[1]}`, kind: 'open-instance-review', evidence: { series: s.id, logPath, sha256, lastRun: lines.findLast(e => e.op === 'run'), lastDone: lines.findLast(e => e.op === 'done') } });
  }
  if (files.some(f => f.path === '.rf/wakes.json')) {
    const wakes = JSON.parse(read('.rf/wakes.json'));
    for (const kind of ['pending', 'requests']) for (const [id, evidence] of Object.entries(wakes[kind] ?? {})) work.push({ id: `${kind}:${id}`, kind, evidence });
  }
  for (const f of files.filter(f => /^series\/[^/]+$/.test(f.path))) if (!series.some(s => s.id === f.path.split('/')[1])) issues.push(`orphan series directory: ${f.path}`);
  return {
    mode: 'readonly-plan', files, treeProof: createHash('sha256').update(raw).digest('hex'), issues,
    series: series.map(s => {
      const runners = [...new Set(s.candidates.filter(c => c.kind === 'legacy-current-runner-candidate').map(c => c.person))];
      return { ...s, classification: runners.length > 1 ? 'mixed-candidates' : runners.length === 1 ? 'unique-candidate-not-owner' : 'no-current-candidate' };
    }),
    work, blockers: [POLICY_BLOCKER],
  };
}

export function applySeriesOwners(root: string, submission: Submission = {}): never {
  const plan = planSeriesOwners(root), decisions = submission.series ?? {}, work = submission.work ?? {}, ack = submission.acknowledgements;
  const ids = plan.series.map(s => s.id), workIds = plan.work.map(w => w.id);
  const report = {
    missingOwners: ids.filter(id => typeof decisions[id]?.owner !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(decisions[id].owner!)),
    missingConsentEvidence: ids.filter(id => !decisions[id]?.consentEvidence),
    missingEligibilityEvidence: ids.filter(id => !decisions[id]?.eligibilityEvidence),
    extraSeries: Object.keys(decisions).filter(id => !ids.includes(id)),
    missingWorkDecisions: workIds.filter(id => !work[id]), extraWork: Object.keys(work).filter(id => !workIds.includes(id)),
    missingAcknowledgements: ['stopped', 'updaterIdle', 'fullBackupVerified'].filter(key => ack?.[key as keyof typeof ack] !== true),
    snapshotIssues: plan.issues, blockers: plan.blockers,
  };
  throw new Error(`migration decision coverage / policy refusal (no files changed):\n${JSON.stringify(report, null, 2)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, mode = 'plan', decisions, ...extra] = process.argv.slice(2);
  if (!root || !['plan', 'apply'].includes(mode) || extra.length || (mode === 'plan' && decisions)) {
    console.error('usage: node scripts/series-owner-migrate.ts SNAPSHOT [plan | apply DECISIONS.json]; read-only by default; apply is policy-blocked');
    process.exitCode = 2;
  } else {
    try {
      if (mode === 'apply') applySeriesOwners(resolve(root), decisions ? JSON.parse(readFileSync(resolve(decisions), 'utf8')) : {});
      else console.log(JSON.stringify(planSeriesOwners(resolve(root)), null, 2));
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
  }
}
