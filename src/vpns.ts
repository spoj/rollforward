import { getDomain } from 'tldts';
import { asPerson, can, type Me } from './auth.ts';
import { browserJson } from './browsers.ts';
import { checkHost, connections, types } from './connections.ts';
import { HttpError } from './store.ts';
import { act, changes, readJson, writeJson } from './system.ts';

export type Vpn = { type: 'fortinet'; gateway: string };
export type VpnRow = Vpn & { name: string; connected: boolean; since?: string; error?: string };
export type Via = { url: string; token: string; hosts: string[] };
export const vpnDefinitions = () => readJson<Record<string, Vpn>>('vpns.json', {});
type SignIn = { person: string; vpn: string; definitionGeneration?: number; generation: number; expires: number; saving?: boolean };
const signIns = new Map<string, SignIn>(), generations = new Map<string, number>(), definitionGenerations = new Map<string, number>();
const tunnels = new Map<string, { person: string; vpn: string; id: string; token: string; since: string }>();
let changing: Promise<void> = Promise.resolve();

function requireVpn(me: Me) {
  if (!can(me, 'vpn')) throw new HttpError(403, 'VPN access requires an explicit vpn capability and RF_TUNNEL_URL');
}

function currentVpnSignIn(signing: SignIn) {
  const me = asPerson(signing.person), definition = vpnDefinitions()[signing.vpn];
  if (!me || !can(me, 'vpn')) throw new HttpError(403, 'VPN access requires an explicit vpn capability and an active person');
  if (!definition || definitionGenerations.get(signing.vpn) !== signing.definitionGeneration || generations.get(`${signing.person} ${signing.vpn}`) !== signing.generation)
    throw new HttpError(409, 'This VPN sign-in was superseded; sign in again.');
  return definition;
}

function changeTunnel(action: () => Promise<void>) {
  changing = changing.then(action, action);
  return changing;
}

async function tunnelJson(method: string, path: string, body?: unknown) {
  const base = process.env.RF_TUNNEL_URL!.replace(/\/$/, '');
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${process.env.RF_TUNNEL_KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) })
    .catch(e => { throw new HttpError(502, `the tunnel service at ${base} does not answer: ${e.message}`); });
  const answer = await res.json();
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new HttpError(502, `tunnel service: ${answer.error}`);
  return answer;
}

export async function vpns(me: Me): Promise<VpnRow[]> {
  requireVpn(me);
  const remote = [...tunnels.values()].some(t => t.person === me.email) ? await tunnelJson('GET', '/tunnels') as { id: string; up: boolean }[] : [];
  return Object.entries(vpnDefinitions()).map(([name, definition]) => {
    const own = tunnels.get(`${me.email} ${name}`), status = own && remote.find(t => t.id === own.id);
    return { name, ...definition, connected: status?.up === true,
      ...(own && { since: own.since, ...(!status?.up && { error: status ? 'The VPN is down; connect again.' : 'The VPN ended; connect again.' }) }) };
  });
}

export function addVpn(me: Me, name: string, definition: Vpn) {
  requireVpn(me);
  if (me.role !== 'admin') throw new HttpError(403, 'admins define VPNs');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new HttpError(400, "a VPN's name is lowercase letters, digits and dashes");
  if (definition.type !== 'fortinet') throw new HttpError(400, 'type: fortinet');
  const gateway = String(definition.gateway).trim().toLowerCase(), match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+):(\d+)$/.exec(gateway);
  if (!match || !(Number(match[2]) > 0 && Number(match[2]) <= 65535)) throw new HttpError(400, 'gateway: host:port, such as vpn.example.com:10443');
  const all = vpnDefinitions();
  if (all[name]) throw new HttpError(409, `a VPN ${name} already exists`);
  all[name] = { type: 'fortinet', gateway };
  definitionGenerations.set(name, (definitionGenerations.get(name) ?? 0) + 1);
  writeJson('vpns.json', all);
  act(me.email, { op: 'vpn-add', name, ...all[name] });
}

export async function removeVpn(me: Me, name: string) {
  requireVpn(me);
  if (me.role !== 'admin') throw new HttpError(403, 'admins define VPNs');
  if (!vpnDefinitions()[name]) throw new HttpError(404, `no VPN ${name}`);
  definitionGenerations.set(name, (definitionGenerations.get(name) ?? 0) + 1);
  await changeTunnel(async () => {
    const all = vpnDefinitions();
    if (!all[name]) throw new HttpError(404, `no VPN ${name}`);
    for (const [key, tunnel] of tunnels) if (tunnel.vpn === name) {
      await tunnelJson('DELETE', `/tunnels/${tunnel.id}`);
      tunnels.delete(key);
    }
    delete all[name];
    writeJson('vpns.json', all);
    act(me.email, { op: 'vpn-remove', name });
  });
}

export async function startVpnSignIn(me: Me, name: string): Promise<string> {
  requireVpn(me);
  const definition = vpnDefinitions()[name];
  if (!definition) throw new HttpError(404, `no VPN ${name}`);
  const key = `${me.email} ${name}`, generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  const ttl_s = Number(process.env.RF_SIGNIN_S ?? 600);
  const signing = { person: me.email, vpn: name, definitionGeneration: definitionGenerations.get(name), generation, expires: Date.now() + ttl_s * 1000 };
  const start = new URL(`https://${definition.gateway}/remote/saml/start`);
  await checkHost(start.hostname, false);
  currentVpnSignIn(signing);
  for (const [id, before] of signIns) if (before.person === me.email && before.vpn === name) {
    await cancelVpnSignIn(me, id);
    currentVpnSignIn(signing);
  }
  const except = [process.env.RF_PUBLIC_URL, process.env.RF_BROWSER_URL ?? 'http://127.0.0.1:8797'].filter(Boolean).map(u => new URL(u!).hostname)
    .concat(connections().flatMap(c => types[c.type].hosts ?? []));
  const { id } = await browserJson('POST', '/sessions', { site: { hosts: [], open: true, except, start_url: start.href }, ttl_s });
  try { currentVpnSignIn(signing); } catch (e) { await browserJson('DELETE', `/sessions/${id}`); throw e; }
  signIns.set(id, signing);
  return id;
}

export function isVpnSignIn(email: string, id: string): boolean {
  const signing = signIns.get(id), me = asPerson(email);
  return !!signing && signing.person === email && !!me && can(me, 'vpn');
}

export async function saveVpnSignIn(me: Me, id: string) {
  requireVpn(me);
  const signing = signIns.get(id);
  if (!signing || signing.person !== me.email) throw new HttpError(404, 'no such VPN sign-in');
  if (signing.saving) throw new HttpError(409, 'This VPN sign-in is being connected.');
  signing.saving = true;
  try {
    const { state } = await browserJson('DELETE', `/sessions/${id}`);
    if (Date.now() >= signing.expires || state === null) throw new HttpError(410, 'This VPN sign-in expired; sign in again.');
    const definition = currentVpnSignIn(signing), host = new URL(`https://${definition.gateway}`).hostname;
    const cookie = state.cookies.find((c: { name: string; domain: string; value: string; expires: number }) => c.name === 'SVPNCOOKIE'
      && (c.domain === host || (c.domain.startsWith('.') && (host === c.domain.slice(1) || host.endsWith(c.domain))))
      && c.value && !/[\s;]/.test(c.value) && (c.expires <= 0 || c.expires > Date.now() / 1000));
    if (!cookie) throw new HttpError(409, 'The VPN gateway has no SVPNCOOKIE; sign in to the VPN first, then Connect.');
    await changeTunnel(async () => {
      const definition = currentVpnSignIn(signing);
      const key = `${me.email} ${signing.vpn}`, before = tunnels.get(key);
      if (before) {
        await tunnelJson('DELETE', `/tunnels/${before.id}`);
        tunnels.delete(key);
        changes.emit('change', 'tree');
      }
      currentVpnSignIn(signing);
      const { id, token } = await tunnelJson('POST', '/tunnels', { ...definition, cookie: `SVPNCOOKIE=${cookie.value}` });
      try { currentVpnSignIn(signing); } catch (e) { await tunnelJson('DELETE', `/tunnels/${id}`); throw e; }
      tunnels.set(key, { person: me.email, vpn: signing.vpn, id, token, since: new Date().toISOString() });
      act(me.email, { op: 'vpn-connect', name: signing.vpn });
      changes.emit('change', 'tree');
    });
  } finally {
    signIns.delete(id);
  }
}

export async function cancelVpnSignIn(me: Me, id: string) {
  requireVpn(me);
  const signing = signIns.get(id);
  if (!signing || signing.person !== me.email) throw new HttpError(404, 'no such VPN sign-in');
  signIns.delete(id);
  const key = `${me.email} ${signing.vpn}`;
  if (generations.get(key) === signing.generation) generations.set(key, signing.generation + 1);
  if (!signing.saving) await browserJson('DELETE', `/sessions/${id}`);
}

export async function disconnectVpn(me: Me, name: string) {
  requireVpn(me);
  if (!vpnDefinitions()[name]) throw new HttpError(404, `no VPN ${name}`);
  const key = `${me.email} ${name}`;
  generations.set(key, (generations.get(key) ?? 0) + 1);
  await changeTunnel(async () => {
    const tunnel = tunnels.get(key);
    if (!tunnel) return;
    await tunnelJson('DELETE', `/tunnels/${tunnel.id}`);
    tunnels.delete(key);
    act(me.email, { op: 'vpn-disconnect', name });
    changes.emit('change', 'tree');
  });
}

export async function reapVpns() {
  if (!process.env.RF_TUNNEL_URL) return;
  await changeTunnel(async () => {
    await Promise.all((await tunnelJson('GET', '/tunnels') as { id: string }[]).map(t => tunnelJson('DELETE', `/tunnels/${t.id}`)));
    tunnels.clear();
    signIns.clear();
  });
}

export function vpnHosts(url: string): string[] {
  const host = new URL(url).hostname, domain = getDomain(host, { allowPrivateDomains: true });
  return domain ? [domain, `*.${domain}`] : [host];
}

export async function vpnVia(email: string, website: { url: string; via?: string }): Promise<Via | undefined> {
  if (!website.via) return;
  const me = asPerson(email), key = `${email} ${website.via}`, own = tunnels.get(key);
  if (!me || !can(me, 'vpn') || !vpnDefinitions()[website.via] || !own)
    throw Object.assign(new HttpError(409, `connect VPN ${website.via} first on the Logins page, as ${email}; this run goes on without the website`), { refused: true });
  const remote = (await tunnelJson('GET', '/tunnels').catch(e => { throw Object.assign(e, { refused: true }); }) as { id: string; up: boolean }[]).find(t => t.id === own.id);
  const current = asPerson(email);
  if (!remote?.up || tunnels.get(key) !== own || !current || !can(current, 'vpn') || !vpnDefinitions()[website.via])
    throw Object.assign(new HttpError(409, `VPN ${website.via} ${remote ? 'is down' : 'ended'}; connect it again on the Logins page`), { refused: true });
  const url = process.env.RF_TUNNEL_PROXY;
  if (!url) throw Object.assign(new HttpError(409, 'RF_TUNNEL_PROXY must name the tunnel proxy the browser service can reach'), { refused: true });
  return { url, token: own.token, hosts: vpnHosts(website.url) };
}
