import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  isValidResult, normalizeLowS, parseDerSignature, publicKeyFromSpki, verifyOnChain, webauthnMessageHash, P256_N,
} from '../lib/webauthn.ts';

const CHALLENGES = [
  '0xb7399b5d83c93cf90a0e136bc1f0b4817ff78004f1bcba9ea9c07f645e7b707b',
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0x1111111111111111111111111111111111111111111111111111111111111111',
] as const;
const OUT = join(import.meta.dirname, '..', '..', '..', 'contracts', 'test', 'fixtures', 'webauthn.json');
const ORIGIN = 'http://localhost:4175';

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}` as `0x${string}`;
const hex32 = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}` as `0x${string}`;
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route(`${ORIGIN}/**`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));
const cdp = await page.context().newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
});
await page.goto(`${ORIGIN}/`);

const toB64 = `(b) => btoa(String.fromCharCode(...new Uint8Array(b)))`;
const created = await page.evaluate(async (toB64Src) => {
  const toB64 = eval(toB64Src);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: 'Tazor' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'fixture', displayName: 'fixture' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
    },
  })) as PublicKeyCredential;
  const res = cred.response as AuthenticatorAttestationResponse;
  return { rawId: toB64(cred.rawId), spki: toB64(res.getPublicKey()!) };
}, toB64);

const { x, y } = publicKeyFromSpki(b64(created.spki));
const credentialId = hex(b64(created.rawId));
const assertions = [];
for (const challenge of CHALLENGES) {
  const got = await page.evaluate(async ([toB64Src, rawId, chHex]) => {
    const toB64 = eval(toB64Src);
    const from64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const ch = Uint8Array.from(chHex.slice(2).match(/../g)!, (h) => parseInt(h, 16));
    const cred = (await navigator.credentials.get({
      publicKey: { rpId: location.hostname, challenge: ch, allowCredentials: [{ type: 'public-key', id: from64(rawId) }], userVerification: 'required' },
    })) as PublicKeyCredential;
    const res = cred.response as AuthenticatorAssertionResponse;
    return { authenticatorData: toB64(res.authenticatorData), clientDataJSON: toB64(res.clientDataJSON), signature: toB64(res.signature) };
  }, [toB64, created.rawId, challenge] as const);

  const authenticatorData = b64(got.authenticatorData);
  const clientDataBytes = b64(got.clientDataJSON);
  const clientDataJSON = Buffer.from(clientDataBytes).toString('utf8');
  const { r, s: rawS } = parseDerSignature(b64(got.signature));
  const s = normalizeLowS(rawS);
  const hash = await webauthnMessageHash(authenticatorData, clientDataBytes);
  const typeIndex = clientDataJSON.indexOf('"type":');
  const challengeIndex = clientDataJSON.indexOf('"challenge":');
  const expected = `"challenge":"${Buffer.from(challenge.slice(2), 'hex').toString('base64url')}"`;
  if (clientDataJSON.slice(typeIndex, typeIndex + 21) !== '"type":"webauthn.get"') throw new Error('type check');
  if (clientDataJSON.slice(challengeIndex, challengeIndex + expected.length) !== expected) throw new Error('challenge check');
  const flags = authenticatorData[32];
  const precompile = await verifyOnChain(hash, hex32(r), hex32(s), x, y);
  console.log(
    `challenge ${challenge}\n  flags=0x${flags.toString(16)} typeIndex=${typeIndex} challengeIndex=${challengeIndex} rawHighS=${rawS > P256_N / 2n}` +
      `\n  hash=${hash}\n  precompile(low-s)=${precompile} valid=${isValidResult(precompile)}`,
  );
  if (!isValidResult(precompile)) throw new Error('precompile rejected signature');
  assertions.push({
    challenge, authenticatorData: hex(authenticatorData), clientDataJSON, messageHash: hash,
    r: hex32(r), s: hex32(s), rawS: hex32(rawS), typeIndex, challengeIndex,
  });
}
await browser.close();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ x, y, credentialId, rpId: 'localhost', origin: ORIGIN, assertions }, null, 2)}\n`);
console.log(`wrote ${OUT}`);
