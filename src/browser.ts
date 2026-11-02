import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { HttpError, type Instance } from './store.ts';
import { isWrite, matches, password, type System } from './systems.ts';
import type { Adapter, Codes } from './signin.ts';
import { runFlow, saveNew } from './flow.ts';
import { findFlow, loadSignIn, siteOf, skillMissing } from './skills.ts';

// The browser the server runs for skills with a website of their own (skills.ts siteOf): it signs in with the account in the
// skill's settings, so the password never reaches the agent, and then takes the skill's flows (flow.ts). It reaches only the site's
// hosts, and stops every request that is a write (see systems.ts) but those a flow names as reads that post.

const ACTION_MS = 30_000;

let browser: Promise<Browser> | undefined;
const launch = () => (browser ??= chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] }));

// A browser context that looks like an ordinary Chrome: some portals turn away headless Chrome's own user agent.
export async function newContext(): Promise<BrowserContext> {
  const b = await launch();
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${b.version().split('.')[0]}.0.0.0 Safari/537.36`;
  return b.newContext({ acceptDownloads: true, userAgent, locale: 'en-US', viewport: { width: 1400, height: 900 } });
}

export async function closeBrowser() {
  const b = browser;
  browser = undefined;
  await (await b)?.close();
}

// `writes`: let writes through, while signing in. `reads`: while a flow runs, the requests its file names as reads that post.
type Session = { sys: System; signin?: Adapter; context: BrowserContext; page: Page; writes: boolean; reads: string[]; blocked: string[]; codes: Codes };

async function openContext(sys: System, signin?: Adapter): Promise<Session> {
  const context = await newContext();
  context.setDefaultTimeout(ACTION_MS);
  const origins = new Set([new URL(sys.url!).origin, ...sys.extra_origins.map(o => new URL(o).origin)]);
  const s: Session = { sys, signin, context, page: await context.newPage(), writes: false, reads: [], blocked: [], codes: new Set() };
  await context.route('**/*', route => {
    const r = route.request(), u = new URL(r.url());
    if (!/^https?:$/.test(u.protocol)) return route.continue();
    if (!origins.has(u.origin)) {
      s.blocked.push(`Stopped a request to ${u.origin}: the browser stays on ${[...origins].join(', ')}.`);
      return route.abort('blockedbyclient');
    }
    if (!s.writes && isWrite(sys, r.method(), r.url()) && !matches(s.reads, r.method(), r.url())) {
      s.blocked.push(`Stopped ${r.method()} ${u.pathname}: it is a write to ${sys.name}, and the flow does not name it as a read.`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return s;
}

// Waits for a navigation the last action may have started; most actions start none, so only briefly.
const settle = (page: Page) => page.waitForNavigation({ timeout: 3000, waitUntil: 'domcontentloaded' }).catch(() => {});

// Signs in with the skill's own steps, or else by filling the sign-in form: the password field, the field before it and Enter.
async function login(s: Session) {
  const { sys, page } = s;
  s.writes = true; // the sign-in form posts
  try {
    if (s.signin) return await s.signin.signIn(page, sys, s.codes).catch(e => { throw blockedToo(s, e); });
    await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
    const pass = page.locator('input[type=password]').first();
    if (!(await pass.count())) return; // no sign-in page
    const user = page.locator('input:not([type=password]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])').first();
    if (await user.count()) await user.fill(sys.username!);
    await pass.fill(password(sys));
    const nav = settle(page);
    await pass.press('Enter');
    await nav;
    if (await page.locator('input[type=password]').count()) throw new HttpError(502, `${sys.name} did not take the account. Ask an admin to check it under Skills.`);
  } finally {
    s.writes = false;
  }
}

// An error, with the requests the browser stopped meanwhile, as they are the likely cause (such as a sign-in host not yet among the
// skill's site.hosts).
function blockedToo(s: Session, e: unknown): HttpError {
  const err = e as Error & { status?: number }, stopped = [...new Set(s.blocked.splice(0))];
  return new HttpError(err.status ?? 502, err.message.split('\n')[0] + (stopped.length ? `\n${stopped.slice(0, 8).join('\n')}` : ''));
}

export async function testLogin(sys: System, signin?: Adapter): Promise<string> {
  const s = await openContext(sys, signin);
  try {
    await login(s);
    return `Signed in to ${sys.name} as ${sys.username}: "${await s.page.title()}" at ${new URL(s.page.url()).origin}`;
  } finally {
    await s.context.close();
  }
}

// A path under the instance's working/, where the agent's files go.
export function workingFile(instDir: string, file: string | undefined): string {
  const rel = posix.normalize(String(file ?? '').replace(/^working\//, ''));
  if (!file || rel.startsWith('..') || rel.startsWith('/') || /^[a-z]:/i.test(rel)) throw new HttpError(400, 'FILE is a path under your working/, such as "vouchers 09.06.2026.csv"');
  const path = join(instDir, 'working', rel);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

// One run's use of the browser: a signed-in session per skill, closed when the run ends.
export class Browsing {
  sessions = new Map<string, Session>();
  inst: Instance;
  skills: string[];
  constructor(inst: Instance, skills: string[]) {
    this.inst = inst;
    this.skills = skills;
  }

  // `rf flow SKILL/FLOW [--var NAME=VALUE ...]`. A failure leaves a screenshot in working/ and names the step.
  async flow(name: string, args: string[]): Promise<string> {
    const vars: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const m = args[i] === '--var' ? /^(\w+)=(.*)$/s.exec(args[++i] ?? '') : null;
      if (!m) throw new HttpError(400, 'rf flow SKILL/FLOW [--var NAME=VALUE ...]');
      vars[m[1]] = m[2];
    }
    const found = findFlow(this.skills, name), need = skillMissing(found.skill);
    if (need.length) throw new HttpError(409, `${found.skill.name} is not set up yet: it needs ${need.join(', ')}. An admin sets it up under Skills.`);
    let s = this.sessions.get(found.skill.id);
    if (!s) {
      s = await openContext(siteOf(found.skill), await loadSignIn(found.skill));
      try {
        await login(s);
      } catch (e) {
        await s.context.close().catch(() => {});
        throw e;
      }
      this.sessions.set(found.skill.id, s);
    }
    const sess = s, t0 = Date.now();
    sess.reads = found.flow.reads_that_post ?? [];
    try {
      const out = await runFlow(sess.page, found.flow, {
        base: sess.sys.url!, dir: join(this.inst.dir, 'working'), vars: { ...found.vars, today: new Date().toLocaleDateString('sv'), ...vars },
        challenge: () => sess.signin?.challenge?.(sess.page, sess.sys, sess.codes, on => { sess.writes = on; }) ?? Promise.resolve(false),
      });
      this.inst.append('agent', 'flow', { skill: found.skill.id, flow: name, vars, files: out.files, steps: out.steps, ms: Date.now() - t0 });
      return `Ran ${name}: ${out.steps} steps. Saved: ${out.files.join(', ') || 'nothing'}.`;
    } catch (e) {
      const err = blockedToo(sess, e);
      const shot = await sess.page.screenshot({ fullPage: true }).then(b => saveNew(join(this.inst.dir, 'working'), `${name.replace('/', ' ')} stopped.png`, b), () => '');
      if (shot) err.message += `\nA screenshot of the page is ${shot}.`;
      this.inst.append('agent', 'flow', { skill: found.skill.id, flow: name, vars, error: err.message, ms: Date.now() - t0 });
      throw err;
    } finally {
      sess.reads = [];
    }
  }

  async close() {
    await Promise.all([...this.sessions.values()].map(s => s.context.close().catch(() => {})));
    this.sessions.clear();
  }
}
