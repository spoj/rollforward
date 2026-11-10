import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// A stand-in for Microsoft Entra ID, for the tests that sign in: the code flow with PKCE of a Web app with a client secret, as the
// server does it, signing in whoever the login hint names, else `as`, as a browser that picked that account would, by the names the
// tests know them by; and the refresh tokens that keeps, which renew until `who.gone` says the account is disabled or `who.stale` that its sign-in expired, and answer 503
// while `who.down`.
const NAMES: Record<string, string> = { 'admin@demo.test': 'Demo Admin', 'bob@demo.test': 'Bob' };

export async function idp() {
  const b64 = (s: string) => Buffer.from(s).toString('base64url'), who = { as: '', groups: {} as Record<string, string[]>, gone: new Set<string>(), stale: new Set<string>(), down: false, renewed: [] as string[] };
  const refresh = (email: string) => `rt.${b64(email)}`;
  let issuer = '';
  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, issuer), send = (d: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    if (u.pathname === '/.well-known/openid-configuration') return send({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });
    if (u.pathname === '/authorize') {
      const p = u.searchParams;
      const code = b64(JSON.stringify({ email: p.get('login_hint') ?? who.as, nonce: p.get('nonce'), challenge: p.get('code_challenge'), scope: p.get('scope') }));
      return void res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }).end();
    }
    const f = new URLSearchParams(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    const refused = (description: string) => void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant', error_description: description }));
    if (f.get('grant_type') === 'refresh_token') {
      const email = Buffer.from(f.get('refresh_token')!.slice(3), 'base64url').toString();
      if (who.down) return void res.writeHead(503).end();
      if (f.get('client_secret') !== 'shh' || !f.get('refresh_token')!.startsWith('rt.')) return refused('AADSTS9002313: Invalid request.');
      if (who.gone.has(email)) return refused('AADSTS50057: The user account is disabled.');
      if (who.stale.has(email)) return refused('AADSTS700082: The refresh token has expired due to inactivity.');
      who.renewed.push(email);
      const claims = { iss: issuer, aud: 'rf-test', exp: Date.now() / 1000 + 300, email, sub: `sub-${email}`, tid: 't1', oid: `oid-${email}`, groups: who.groups[email] };
      return send({ id_token: `${b64('{"alg":"none"}')}.${b64(JSON.stringify(claims))}.`, access_token: `at.${b64(email)}`, refresh_token: refresh(email), expires_in: 3600, scope: f.get('scope') });
    }
    const c = JSON.parse(Buffer.from(f.get('code')!, 'base64url').toString());
    if (f.get('client_secret') !== 'shh' || createHash('sha256').update(f.get('code_verifier')!).digest('base64url') !== c.challenge) return void res.writeHead(400).end('{"error":"invalid_grant"}');
    const claims = { iss: issuer, aud: 'rf-test', exp: Date.now() / 1000 + 300, nonce: c.nonce, email: c.email, name: NAMES[c.email], sub: `sub-${c.email}`, tid: 't1', oid: `oid-${c.email}`, groups: who.groups[c.email] };
    send({ id_token: `${b64('{"alg":"none"}')}.${b64(JSON.stringify(claims))}.`, access_token: `at.${b64(c.email)}`, ...(c.scope.split(' ').includes('offline_access') && { refresh_token: refresh(c.email) }) });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    who,
    refresh,
    close: () => server.close(),
    // What a server at `base` needs to sign in through it.
    env: (base: string) => ({ RF_OIDC_ISSUER: issuer, RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'shh', RF_PUBLIC_URL: base }),
    // Signs `email` in at `base` as a browser would, from `login`: the server's answer that sets the session, or refuses it.
    async signIn(base: string, email: string, login = '/auth/login') {
      const out = await fetch(`${base}${login}`, { redirect: 'manual' }), to = new URL(out.headers.get('location')!);
      to.searchParams.set('login_hint', email);
      const back = (await fetch(to, { redirect: 'manual' })).headers.get('location')!;
      return fetch(back, { headers: { cookie: out.headers.getSetCookie()[0].split(';')[0] }, redirect: 'manual' });
    },
  };
}
