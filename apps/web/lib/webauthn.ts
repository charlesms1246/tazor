export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100';
export const WHITECHAIN_RPC = 'https://rpc.testnet.whitechain.io';

export type Hex = `0x${string}`;
export type PasskeyPublicKey = { credentialId: string; x: Hex; y: Hex };
export type PasskeySignature = {
  hash: Hex; r: Hex; s: Hex; rawS: Hex; wasHighS: boolean;
  authenticatorData: Hex; clientDataJSON: string; typeIndex: number; challengeIndex: number;
};

const toHex = (b: Uint8Array): Hex =>
  `0x${Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')}`;
const bigToHex32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sha256 = async (d: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', d));

export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error('bad DER sequence');
  let i = 2;
  const readInt = () => {
    if (der[i] !== 0x02) throw new Error('bad DER integer');
    const len = der[i + 1];
    const v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return BigInt(toHex(v));
  };
  const r = readInt();
  const s = readInt();
  return { r, s };
}

export function normalizeLowS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

export function publicKeyFromSpki(spki: Uint8Array): { x: Hex; y: Hex } {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error('expected uncompressed P-256 point');
  return { x: toHex(point.slice(1, 33)), y: toHex(point.slice(33, 65)) };
}

export async function webauthnMessageHash(authenticatorData: Uint8Array, clientDataJSON: Uint8Array<ArrayBuffer>) {
  const clientHash = await sha256(clientDataJSON);
  const msg = new Uint8Array(authenticatorData.length + 32);
  msg.set(authenticatorData);
  msg.set(clientHash, authenticatorData.length);
  return toHex(await sha256(msg));
}

export async function createPasskey(userName: string): Promise<PasskeyPublicKey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: 'Tazor' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: userName, displayName: userName },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
    },
  })) as PublicKeyCredential;
  const res = cred.response as AuthenticatorAttestationResponse;
  if (res.getPublicKeyAlgorithm() !== -7) throw new Error('passkey is not ES256');
  const spki = res.getPublicKey();
  if (!spki) throw new Error('authenticator returned no public key');
  return { credentialId: b64url(new Uint8Array(cred.rawId)), ...publicKeyFromSpki(new Uint8Array(spki)) };
}

export async function signChallenge(credentialId: string, challenge: Uint8Array<ArrayBuffer>): Promise<PasskeySignature> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge,
      allowCredentials: [{ type: 'public-key', id: fromB64url(credentialId) }],
      userVerification: 'required',
    },
  })) as PublicKeyCredential;
  const res = cred.response as AuthenticatorAssertionResponse;
  const authData = new Uint8Array(res.authenticatorData);
  const clientData = new Uint8Array(res.clientDataJSON);
  const hash = await webauthnMessageHash(authData, clientData);
  const { r, s } = parseDerSignature(new Uint8Array(res.signature));
  const low = normalizeLowS(s);
  const clientDataJSON = new TextDecoder().decode(clientData);
  const typeIndex = clientDataJSON.indexOf('"type":');
  const challengeIndex = clientDataJSON.indexOf('"challenge":');
  if (typeIndex < 0 || challengeIndex < 0) throw new Error('unexpected clientDataJSON');
  return {
    hash, r: bigToHex32(r), s: bigToHex32(low), rawS: bigToHex32(s), wasHighS: low !== s,
    authenticatorData: toHex(authData), clientDataJSON, typeIndex, challengeIndex,
  };
}

export async function verifyOnChain(hash: Hex, r: Hex, s: Hex, x: Hex, y: Hex): Promise<Hex> {
  const data = `0x${[hash, r, s, x, y].map((v) => v.slice(2)).join('')}`;
  const resp = await fetch(WHITECHAIN_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: P256_PRECOMPILE, data }, 'latest'] }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export const isValidResult = (result: Hex) => result.length === 66 && BigInt(result) === 1n;
