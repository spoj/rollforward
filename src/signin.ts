import type { Locator, Page } from 'playwright';
import { HttpError } from './store.ts';
import { waitForCode } from './graph.ts';
import { system, type System } from './systems.ts';

// What a skill's own sign-in (skills/<id>/signin.ts, for a site whose sign-in is more than a user name and a password) is made of,
// and the helpers it builds on. The browser (browser.ts) runs it with the skill's site (skills.ts siteOf): the account in the
// skill's settings, its password sealed. A code the site mails is read from the mailbox of the m365 connection the skill's
// `otp_mail` setting names (M365 Mail if unset). A site that asks for a code again later is answered by `challenge`, which the
// browser calls after each step of a flow.

export type Codes = Set<string>;
export type Adapter = {
  signIn(page: Page, sys: System, codes: Codes): Promise<void>;
  // Answers a code page if one shows; true if it did. `posting` lets the browser send while it answers, as a sign-in does.
  challenge?(page: Page, sys: System, codes: Codes, posting: (on: boolean) => void): Promise<boolean>;
};

const CODE_WAIT = 25_000, RESENDS = 3;
export const STEP = 60_000;

// Waits up to `ms` for the first of `states` to hold, checking twice a second; null if none does.
export async function until<K extends string>(ms: number, states: Record<K, () => Promise<boolean>>): Promise<K | null> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 500)))
    for (const [k, test] of Object.entries(states) as [K, () => Promise<boolean>][]) if (await test().catch(() => false)) return k;
  return null;
}

export const shown = (l: Locator) => l.first().isVisible();
export const pageText = async (page: Page) => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

// Types the code the site just mailed into `box`, key by key (some forms enable their button only on key presses), and submits it.
// `since` is when the site was asked to send it. If none comes within 25 seconds, presses the site's resend, up to three times.
export async function enterCode(sys: System, codes: Codes, since: Date, sender: RegExp, box: Locator, resend: Locator) {
  const id = sys.settings?.otp_mail || 'm365-mail', mail = system(id), mailbox = mail?.settings?.mailbox;
  if (!mail || !mailbox) throw new HttpError(409, `${sys.name} mails a sign-in code, and ${id} is not set up to read it`);
  for (let i = 0; i <= RESENDS; i++) {
    if (i) await resend.first().click({ timeout: 40_000 }); // a resend may count down first
    const code = await waitForCode(mail, mailbox, new Date(since.getTime() - 10_000), sender, CODE_WAIT, '4,8', codes);
    if (code) {
      codes.add(code);
      await box.first().fill('');
      await box.first().pressSequentially(code, { delay: 60 });
      await box.first().press('Enter');
      return;
    }
  }
  throw new HttpError(504, `${sys.name} said it mailed a sign-in code, but none reached ${mailbox} in ${(RESENDS + 1) * CODE_WAIT / 1000} seconds with ${RESENDS} resends; check that mailbox's quarantine and rules for mail from the site`);
}
