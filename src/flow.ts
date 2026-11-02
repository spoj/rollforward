import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { HttpError } from './store.ts';

// A skill's flow: fixed steps the server takes in the skill's website, signed in with the account in the skill's settings, such as
// opening a report, choosing its period and downloading it, so the same steps give the same file and the agent spends no model time
// clicking. A flow file lives in a skill (skills/<skill>/<name>.flow.json) and is run by `rf flow SKILL/NAME [--var name=value ...]`.
// It reaches only the site's hosts (the skill's site.hosts) and makes no write. Some sites read with a POST (a sign-in's token
// exchange, single sign-on); a flow names those in `reads_that_post` ("POST */saml2/*", or a bare URL pattern for any method), and
// only those get through, only while it runs, so what the flow file says is all it can send.
//
//   { "vars": ["invoices"], "reads_that_post": ["POST */as/token.oauth2"], "steps": [
//     { "goto": "{portal}" },                              an address, relative to the site's; a {name} inside one is
//                                                          encoded, and one that is the whole address is taken as it is
//     { "click": { "role": "radio", "name": "Payments" } }, a target: {"text": …}, {"role": …, "name": …} or {"css": …}; text and
//                                                          name match whole and exactly, or as "/regex/flags"; only visible ones
//     { "fill": { "css": "#q" }, "value": "{invoice}" },  { "press": "Enter" },  { "reload": true },  { "pause": 1000 },
//     { "wait": { "text": "Viewing" } },  { "wait": { "gone": ".busy" } },  { "wait": { "any": [target, …] }, "timeout": 120000 },
//     { "stop_if": { "text": "/No results/i" }, "message": "no such invoice" },
//     { "expect": { "css": "input" }, "value": "Last 12 Months" },
//     { "download": { "text": "Export to CSV" }, "save": "Report {today}.csv" } ] }
//
// {today} is today here; other {name}s come from --var, then the skill's settings.

export type Target = { text?: string; role?: string; name?: string; css?: string };
export type Step = {
  goto?: string; reload?: boolean; click?: Target; fill?: Target; value?: string; press?: string; pause?: number;
  wait?: Target & { gone?: string; any?: Target[] }; timeout?: number; stop_if?: Target; message?: string; expect?: Target;
  download?: Target; save?: string;
};
export type Flow = { vars?: string[]; reads_that_post?: string[]; steps: Step[] };

const STEP_MS = 60_000, WAIT_MS = 120_000, MAX_STEPS = 100;
const ACTIONS = ['goto', 'reload', 'click', 'fill', 'press', 'pause', 'wait', 'stop_if', 'expect', 'download'];

export function readFlow(path: string): Flow {
  let f: Flow;
  try { f = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new HttpError(500, `${path} is not a readable flow: ${(e as Error).message}`); }
  if (!f || !Array.isArray(f.steps) || !f.steps.length || f.steps.length > MAX_STEPS) throw new HttpError(500, `${path} needs 1 to ${MAX_STEPS} "steps"`);
  f.steps.forEach((s, i) => {
    const kinds = ACTIONS.filter(a => a in s);
    if (kinds.length !== 1) throw new HttpError(500, `${path} step ${i + 1}: one of ${ACTIONS.join(', ')}`);
  });
  return f;
}

const regex = (s: string) => { const m = /^\/(.+)\/([a-z]*)$/s.exec(s); return m ? new RegExp(m[1], m[2]) : null; };

function locate(page: Page, t: Target): Locator {
  let l: Locator;
  if (t.css) l = page.locator(t.css);
  else if (t.role) l = page.getByRole(t.role as any, t.name === undefined ? {} : { name: regex(t.name) ?? t.name, exact: !regex(t.name) });
  else if (t.text !== undefined) l = page.getByText(regex(t.text) ?? t.text, { exact: !regex(t.text) });
  else throw new HttpError(500, 'a target is {"text": …}, {"role": …, "name": …} or {"css": …}');
  return l.filter({ visible: true }).first();
}

const show = (t: Target) => JSON.stringify(t);

export type RunOptions = {
  base: string; vars: Record<string, string>; dir: string; // dir: the instance's working/
  challenge?: () => Promise<unknown>; // after a step that may navigate, answers any sign-in code the site asks for again
};

// Runs the steps; the files saved are named relative to the instance ("working/…"). A failure says which step and why.
export async function runFlow(page: Page, flow: Flow, o: RunOptions): Promise<{ files: string[]; steps: number }> {
  const missing = (flow.vars ?? []).filter(v => !(v in o.vars));
  if (missing.length) throw new HttpError(400, `the flow needs --var ${missing.map(v => `${v}=…`).join(' --var ')}`);
  const fill = (s: string, url = false) => s.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in o.vars)) throw new HttpError(400, `the flow uses {${k}}, which is neither a --var nor a setting of the skill`);
    return url ? encodeURIComponent(o.vars[k]) : o.vars[k];
  });
  const files: string[] = [];
  let n = 0;
  try {
    for (const s of flow.steps) {
      n++;
      // A whole address from a setting is taken as it is; a {name} inside an address is encoded.
      if (s.goto !== undefined) await page.goto(new URL(fill(s.goto, !/^\{\w+\}$/.test(s.goto)), o.base).href, { waitUntil: 'domcontentloaded', timeout: STEP_MS });
      else if (s.reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP_MS });
      else if (s.click) await locate(page, s.click).click({ timeout: STEP_MS });
      else if (s.fill) await locate(page, s.fill).fill(fill(s.value ?? ''), { timeout: STEP_MS });
      else if (s.press) await page.keyboard.press(s.press);
      else if (s.pause !== undefined) await page.waitForTimeout(Math.min(s.pause, WAIT_MS));
      else if (s.wait) {
        const ms = s.timeout ?? WAIT_MS;
        if (s.wait.gone) await page.locator(s.wait.gone).filter({ visible: true }).first().waitFor({ state: 'hidden', timeout: ms });
        else if (s.wait.any) await Promise.any(s.wait.any.map(t => locate(page, t).waitFor({ timeout: ms })))
          .catch(() => { throw new Error(`none of ${s.wait!.any!.map(show).join(', ')} showed in ${ms / 1000}s`); });
        else await locate(page, s.wait).waitFor({ timeout: ms });
      } else if (s.stop_if) {
        if (await locate(page, s.stop_if).isVisible()) throw new HttpError(404, fill(s.message ?? `the page shows ${show(s.stop_if)}`));
      } else if (s.expect) {
        const l = locate(page, s.expect), want = fill(s.value ?? ''), got = await l.inputValue().catch(() => l.innerText());
        if (got.trim() !== want) throw new Error(`${show(s.expect)} shows "${got.trim()}", not "${want}"`);
      } else if (s.download) {
        const [d] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), locate(page, s.download).click({ timeout: STEP_MS })]);
        files.push(saveNew(o.dir, fill(s.save ?? d.suggestedFilename()), readFileSync(await d.path())));
      }
      if (s.goto !== undefined || s.reload || s.click || s.press) await o.challenge?.();
    }
  } catch (e) {
    const err = e as Error & { status?: number };
    throw new HttpError(err.status ?? 502, `step ${n} (${Object.keys(flow.steps[n - 1]).join(', ')}): ${err.message.split('\n')[0]}`);
  }
  return { files, steps: n };
}

// Saves under working/, never over a file already there: the new one gets " (2)", " (3)"...
export function saveNew(dir: string, name: string, bytes: Buffer): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'download', dot = clean.lastIndexOf('.');
  mkdirSync(dir, { recursive: true });
  let file = clean;
  for (let k = 2; existsSync(join(dir, file)); k++) file = dot > 0 ? `${clean.slice(0, dot)} (${k})${clean.slice(dot)}` : `${clean} (${k})`;
  writeFileSync(join(dir, file), bytes);
  return `working/${file}`;
}
