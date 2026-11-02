import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pi } from '../src/runner.ts';
import { useSkillsDir } from '../src/skills.ts';

useSkillsDir(join(import.meta.dirname, 'skills'));
const tmp = mkdtempSync(join(tmpdir(), 'rf-')), home = join(tmp, 'home'), series = join(tmp, 'larkfield', 'Weekly');
const agentDir = join(home, '.pi', 'agent'), stray = join(agentDir, 'skills', 'stray');
const agent = pi({ seriesDir: series, instanceDir: join(series, 'w1'), env: { HOME: home, PI_CODING_AGENT_DIR: agentDir }, skills: ['tool'] });

before(async () => {
  mkdirSync(series, { recursive: true });
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, 'SKILL.md'), '---\nname: stray\ndescription: One of the Pi skills of whoever runs the server. Use when testing.\n---\n');
  await agent.start();
});

after(async () => {
  await agent.stop();
  rmSync(tmp, { recursive: true, force: true });
});

test('a run offers the agent the skills its series chose, and not the others nor the Pi skills of whoever runs the server', async () => {
  const offered = (await agent.getCommands()).filter(c => c.source === 'skill').map(c => c.name);
  assert.ok(offered.includes('skill:tool'), `offered: ${offered.join(', ') || 'none'}`);
  assert.ok(!offered.includes('skill:stray'), `offered: ${offered.join(', ')}`);
  assert.ok(!offered.includes('skill:mail-report'), `offered: ${offered.join(', ')}`);
});

test("the agent's scripts reach a skill's files through $RF_SKILLS", async () => {
  const { exitCode, output } = await agent.bash('test -f "$RF_SKILLS/tool/scripts/tool.py"');
  assert.equal(exitCode, 0, `RF_SKILLS does not lead to the skill: ${output}`);
});
