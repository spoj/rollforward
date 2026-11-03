import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext, getCACertificates, type SecureContext } from 'node:tls';
import { rfDir } from './system.ts';

// rollforward's own certificate authority, which only runs trust: the sandbox's proxy ends TLS for a connection's host with a
// certificate it signs, to put the runner's token in (connections.ts). Its key stays in .rf/ca/, made once; each host's
// certificate is made as it's first needed, for the life of the process. The certificates are X.509 v3 with what strict
// verifiers, such as Python's since 3.13, ask: key identifiers, a critical basicConstraints and key usage.

const der = (tag: number, ...parts: Buffer[]) => {
  const v = Buffer.concat(parts), n = v.length;
  const len = n < 128 ? Buffer.from([n]) : (b => Buffer.concat([Buffer.from([0x80 | b.length]), b]))(Buffer.from(n.toString(16).padStart(n > 0xffff ? 6 : n > 0xff ? 4 : 2, '0'), 'hex'));
  return Buffer.concat([Buffer.from([tag]), len, v]);
};
const seq = (...p: Buffer[]) => der(0x30, ...p);
const oid = (s: string) => {
  const [a, b, ...rest] = s.split('.').map(Number), out = [40 * a + b];
  for (const n of rest) {
    const enc = [n & 0x7f];
    for (let v = n >>> 7; v; v >>>= 7) enc.unshift(0x80 | (v & 0x7f));
    out.push(...enc);
  }
  return der(0x06, Buffer.from(out));
};
const name = (cn: string) => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));
const time = (d: Date) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const bits = (b: Buffer, unused = 0) => der(0x03, Buffer.from([unused]), b);
const TRUE = der(0x01, Buffer.from([0xff]));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [TRUE] : []), der(0x04, value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function certificate(o: { subject: string; key: KeyObject; issuer: string; signer: KeyObject; authority?: Buffer; host?: string; days: number }): string {
  const spki = o.key.export({ type: 'spki', format: 'der' }), id = createHash('sha1').update(spki).digest(), serial = randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), ECDSA_SHA256, name(o.issuer),
    seq(time(new Date(Date.now() - 86_400_000)), time(new Date(Date.now() + o.days * 86_400_000))), name(o.subject), spki,
    der(0xa3, seq(
      ext('2.5.29.19', true, o.host ? seq() : seq(TRUE)),
      ext('2.5.29.15', true, o.host ? bits(Buffer.from([0x80]), 7) : bits(Buffer.from([0x06]), 1)),
      ...(o.host ? [ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), ext('2.5.29.17', false, seq(der(0x82, Buffer.from(o.host))))] : []),
      ext('2.5.29.14', false, der(0x04, id)),
      ext('2.5.29.35', false, seq(der(0x80, o.authority ?? id))),
    )),
  );
  const cert = seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, o.signer)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`.replace('\n\n', '\n');
}

const dir = () => join(rfDir(), 'ca');
let ca: { key: KeyObject; pem: string; id: Buffer } | undefined;
const hosts = new Map<string, SecureContext>(), leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function authority() {
  if (ca) return ca;
  if (!existsSync(join(dir(), 'ca.pem'))) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir(), 'ca.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(join(dir(), 'ca.pem'), certificate({ subject: 'rollforward runs', key: publicKey, issuer: 'rollforward runs', signer: privateKey, days: 3650 }));
  }
  const key = createPrivateKey(readFileSync(join(dir(), 'ca.key'))), pem = readFileSync(join(dir(), 'ca.pem'), 'utf8');
  return (ca = { key, pem, id: createHash('sha1').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest() });
}

// What a run trusts: the system's authorities, and ours.
export const bundle = () => [...getCACertificates('system'), authority().pem].join('\n');

export function contextFor(host: string): SecureContext {
  if (!hosts.has(host)) {
    const a = authority(), cert = certificate({ subject: host, key: leaf.publicKey, issuer: 'rollforward runs', signer: a.key, authority: a.id, host, days: 365 });
    hosts.set(host, createSecureContext({ key: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: cert + a.pem }));
  }
  return hosts.get(host)!;
}
