import { STEP, type Adapter } from '../../../src/signin.ts';
import { password } from '../../../src/systems.ts';

const signIn: Adapter = {
  async signIn(page, sys) {
    await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
    const pass = page.locator('input[type=password]').first();
    await pass.waitFor({ timeout: STEP });
    await page.locator('input[type=text], input[type=email]').first().fill(sys.username!);
    await pass.fill(password(sys));
    await pass.press('Enter');
  },
};

export default signIn;
