import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commit } from '../src/git.ts';
import { openSkills, pushSkill, skills, versionsOf } from '../src/skills.ts';
import { createInstance, HttpError, Instance, openStore, wipe } from '../src/store.ts';

const who = { name: 'Alice', email: 'alice@demo.test' };

test('B-R4-DATA-03a: commit() atomically replaces .git/rf-seen.json and rebuilds a partial cache without hiding fs errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-03a-git-'));
  try {
    openStore(root);
    const inst = createInstance('s', 'I', who.email, []), cache = join(inst.dir, '.git', 'rf-seen.json');
    writeFileSync(join(inst.dir, 'working', 'report.txt'), 'first');
    await commit(inst.dir, who, 'healthy control');

    const origWrite = fs.writeFileSync;
    fs.writeFileSync = ((path, bytes, ...args) => {
      if (String(path).includes('rf-seen.json')) {
        origWrite(path, '{"partial":');
        throw Object.assign(new Error('synthetic EFBIG'), { code: 'EFBIG' });
      }
      return origWrite(path, bytes, ...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(commit(inst.dir, who, 'partial cache write'), /EFBIG/);
    } finally {
      fs.writeFileSync = origWrite;
      syncBuiltinESMExports();
    }

    JSON.parse(readFileSync(cache, 'latin1'));
    writeFileSync(join(inst.dir, 'working', 'report.txt'), 'second');
    await commit(inst.dir, who, 'after failed cache write');

    writeFileSync(cache, '{"working/report.txt":[');
    writeFileSync(join(inst.dir, 'working', 'report.txt'), 'third');
    await inst.close(who);
    assert.equal(inst.doc.status, 'closed');

    const inst2 = createInstance('s', 'I2', who.email, []), cache2 = join(inst2.dir, '.git', 'rf-seen.json');
    writeFileSync(join(inst2.dir, 'working', 'f.txt'), 'x');
    await commit(inst2.dir, who, 'init');
    rmSync(cache2);
    mkdirSync(cache2);
    await assert.rejects(commit(inst2.dir, who, 'eisdir'), /EISDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-R4-DATA-03a: pushSkill() atomically writes .pushed.json and versionsOf() skips partial unpublished metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-03a-skills-'));
  try {
    openSkills(root);
    const files = { 'SKILL.md': Buffer.from('---\nname: demo\ndescription: test\n---\n').toString('base64') };
    pushSkill('demo', files, who.email);
    assert.equal(versionsOf('demo').length, 1);

    const origWrite = fs.writeFileSync;
    fs.writeFileSync = ((path, bytes, ...args) => {
      if (String(path).includes('/2/.pushed.json')) {
        origWrite(path, '{"version":2,"by":');
        throw Object.assign(new Error('synthetic EFBIG'), { code: 'EFBIG' });
      }
      return origWrite(path, bytes, ...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => pushSkill('demo', files, who.email), /EFBIG/);
    } finally {
      fs.writeFileSync = origWrite;
      syncBuiltinESMExports();
    }

    assert.equal(readlinkSync(join(root, 'skills', 'live', 'demo')), '../versions/demo/1');
    assert.deepEqual(skills().map(s => s.id), ['demo']);
    assert.deepEqual(versionsOf('demo').map(v => v.version), [1]);

    mkdirSync(join(root, 'skills', 'versions', 'demo', '3'), { recursive: true });
    writeFileSync(join(root, 'skills', 'versions', 'demo', '3', '.pushed.json'), '{"version":3,"by":');
    assert.deepEqual(versionsOf('demo').map(v => v.version), [1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-R4-DATA-03b: commit() bounds open directory descriptors on deep working/ trees and checks parent inodes', () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-03b-'));
  try {
    const dir = join(root, 'deep');
    mkdirSync(join(dir, 'working'), { recursive: true });
    let fd = openSync(join(dir, 'working'), constants.O_RDONLY | constants.O_DIRECTORY);
    for (let n = 0; n < 80; n++) {
      mkdirSync(`/proc/self/fd/${fd}/d`);
      const next = openSync(`/proc/self/fd/${fd}/d`, constants.O_RDONLY | constants.O_DIRECTORY);
      closeSync(fd);
      fd = next;
    }
    writeFileSync(`/proc/self/fd/${fd}/leaf.txt`, 'deep\n');
    closeSync(fd);

    const gitHref = pathToFileURL(join(import.meta.dirname, '..', 'src', 'git.ts')).href;
    const script = `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { readdirSync } from 'node:fs';
      import { commit } from ${JSON.stringify(gitHref)};
      const before = readdirSync('/proc/self/fd').length;
      const hash = await commit(${JSON.stringify(dir)}, ${JSON.stringify(who)}, 'deep');
      assert.equal(readdirSync('/proc/self/fd').length, before);
      const leaf = 'working/' + 'd/'.repeat(80) + 'leaf.txt';
      assert.equal(execFileSync('git', ['show', hash + ':' + leaf], { cwd: ${JSON.stringify(dir)}, encoding: 'utf8' }), 'deep\\n');
    `;
    execFileSync('bash', ['-c', 'ulimit -n 256; exec "$@"', 'limit', process.execPath, '--input-type=module', '-e', script], { stdio: 'pipe', timeout: 10_000 });
    execFileSync('bash', ['-c', 'ulimit -n 64; exec "$@"', 'limit', process.execPath, '--input-type=module', '-e', script], { stdio: 'pipe', timeout: 10_000 });

    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { commit } from ${JSON.stringify(gitHref)};
      const base = ${JSON.stringify(join(root, 'move'))}, tree = base + '/inst', out = base + '/out';
      fs.mkdirSync(tree + '/working/z', { recursive: true });
      fs.mkdirSync(out + '/working', { recursive: true });
      fs.writeFileSync(out + '/secret.txt', 'outside');
      const before = fs.readdirSync('/proc/self/fd').length, orig = fs.readdirSync;
      let seenZ = false;
      fs.readdirSync = (...args) => {
        const r = orig(...args);
        if (!seenZ && typeof args[0] === 'string' && args[0].startsWith('/proc/self/fd/') && args[1]?.withFileTypes && r.length === 0) {
          seenZ = true;
          fs.renameSync(tree + '/working/z', out + '/working/z');
        }
        return r;
      };
      syncBuiltinESMExports();
      await assert.rejects(commit(tree, { name: 'A', email: 'a@b' }, 'moved'), /a folder moved/);
      fs.readdirSync = orig;
      syncBuiltinESMExports();
      assert.equal(fs.readdirSync('/proc/self/fd').length, before);
    `], { stdio: 'pipe', timeout: 10_000 });
  } finally {
    wipe(Buffer.from(root));
  }
});

test('B-R4-DATA-13: Instance.put() rejects non-object screen JSON and non-object items with HttpError 400', () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-13-'));
  try {
    openStore(root);
    const inst = createInstance('s', 'I', who.email, []);
    for (const bad of ['null', '[]', '123', '"text"']) {
      assert.throws(() => inst.put(bad, 1), (e: unknown) => e instanceof HttpError && e.status === 400, bad);
    }
    for (const item of [null, 123, 'x', []]) {
      assert.throws(
        () => inst.put(JSON.stringify({ rev: inst.doc.rev, items: [item] }), 1),
        (e: unknown) => e instanceof HttpError && e.status === 400,
        JSON.stringify(item),
      );
    }
    assert.throws(
      () => inst.put(JSON.stringify({ rev: inst.doc.rev + 1, items: [] }), 1),
      (e: unknown) => e instanceof HttpError && e.status === 409,
    );
    const before = inst.doc.rev;
    inst.put(JSON.stringify({ rev: before, items: [] }), 1);
    assert.equal(inst.doc.rev, before + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const action of ['user', 'signout', 'unoffer'] as const) {
  for (const when of ['after', 'during'] as const) {
    test(`B-R4-DATA-10: ${action} revocation ${when} site-drive discovery leaves no index cache`, () => {
      const root = mkdtempSync(join(tmpdir(), `r4-10-${action}-${when}-`));
      try {
        const out = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
          import { mock } from 'node:test';
          import { existsSync, readdirSync } from 'node:fs';
          import { join, resolve } from 'node:path';
          import { pathToFileURL } from 'node:url';
          const mod = name => pathToFileURL(resolve('src', name + '.ts')).href;
          const { initSystem } = await import(mod('system'));
          const auth = await import(mod('auth'));
          const logins = await import(mod('logins'));
          const entra = await import(mod('entra'));
          mock.module(mod('entra'), { exports: { ...entra, token: async () => 'synthetic' } });

          const email = 'bob@demo.test', offer = 'm365:site:tenant,site,web';
          initSystem(${JSON.stringify(root)});
          auth.upsertUser(email, { role: 'user' });
          logins.saveLogin(email, { id: 'm365', kind: 'm365', name: 'M365', since: '2026-11-15T00:00:00Z', offers: [{ id: offer, name: 'Site Finance' }] }, 'synthetic');

          const entered = Promise.withResolvers(), release = Promise.withResolvers();
          globalThis.fetch = async url => {
            if (!String(url).includes('/sites/tenant,site,web/drives?')) throw new Error('unexpected ' + url);
            entered.resolve();
            await release.promise;
            return Response.json({ value: [{ id: 'drive-1' }] });
          };

          const ix = await import(mod('indexes'));
          const act = ${JSON.stringify(action)}, timing = ${JSON.stringify(when)};
          const revoke = () => {
            if (act === 'user') { ix.forget(email); auth.removeUser(email); }
            if (act === 'signout') { logins.signOut(email, 'm365'); ix.forget(email); }
            if (act === 'unoffer') { logins.unoffer(email, 'm365', offer); ix.forget(email, offer); }
          };

          ix.track(email);
          await entered.promise;
          if (timing === 'during') revoke();
          release.resolve();
          for (let i = 0; i < 20; i++) await new Promise(ok => setImmediate(ok));
          if (timing === 'after') {
            revoke();
            for (let i = 0; i < 20; i++) await new Promise(ok => setImmediate(ok));
          }
          const dir = join(logins.personDir(email), 'index');
          console.log(JSON.stringify({
            personExists: existsSync(logins.personDir(email)),
            indexes: ix.indexes(),
            files: existsSync(dir) ? readdirSync(dir) : [],
          }));
        `], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10_000 }).trim();
        const res = JSON.parse(out.split('\n').at(-1)!);
        if (action === 'user') assert.equal(res.personExists, false);
        assert.deepEqual(res.indexes, []);
        assert.deepEqual(res.files, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('B-R4-DATA-10: unoffer + re-offer during discovery discards stale drive listing', () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-10-reoffer-'));
  try {
    const out = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import { mock } from 'node:test';
      import { readFileSync, readdirSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const mod = name => pathToFileURL(resolve('src', name + '.ts')).href;
      const { initSystem } = await import(mod('system'));
      const auth = await import(mod('auth'));
      const logins = await import(mod('logins'));
      const entra = await import(mod('entra'));
      mock.module(mod('entra'), { exports: { ...entra, token: async () => 'synthetic' } });

      const email = 'bob@demo.test', offer = 'm365:site:tenant,site,web';
      initSystem(${JSON.stringify(root)});
      auth.upsertUser(email, { role: 'user' });
      logins.saveLogin(email, { id: 'm365', kind: 'm365', name: 'M365', since: '2026-11-15T00:00:00Z', offers: [{ id: offer, name: 'Site Finance' }] }, 'synthetic');

      let calls = 0;
      const firstEntered = Promise.withResolvers(), releaseFirst = Promise.withResolvers();
      globalThis.fetch = async () => {
        if (++calls === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return Response.json({ value: [{ id: 'stale-drive' }] });
        }
        return Response.json({ value: [{ id: 'fresh-drive' }] });
      };

      const ix = await import(mod('indexes'));
      ix.track(email);
      await firstEntered.promise;
      logins.unoffer(email, 'm365', offer);
      ix.forget(email, offer);
      logins.saveLogin(email, { id: 'm365', kind: 'm365', name: 'M365', since: '2026-11-15T00:00:00Z', offers: [{ id: offer, name: 'Site Finance' }] }, 'synthetic');
      ix.track(email);
      releaseFirst.resolve();
      for (let i = 0; i < 30; i++) await new Promise(ok => setImmediate(ok));
      const dir = join(logins.personDir(email), 'index');
      const [file] = readdirSync(dir).filter(f => f.endsWith('.json'));
      const cache = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      console.log(JSON.stringify(Object.keys(cache.parts)));
    `], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10_000 }).trim();
    assert.deepEqual(JSON.parse(out.split('\n').at(-1)!), ['fresh-drive']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
