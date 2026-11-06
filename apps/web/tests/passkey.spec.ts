import { test, expect } from '@playwright/test';
import { verifyOnChain, isValidResult, P256_N, type Hex } from '../lib/webauthn';

const N = 100;
const hex32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;

test('passkey signatures verify on the Whitechain P-256 precompile', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });

  await page.goto('/developers/');
  await page.getByTestId('create').click();
  const x = (await page.getByTestId('x').textContent()) as Hex;
  const y = (await page.getByTestId('y').textContent()) as Hex;
  expect(x).toMatch(/^0x[0-9a-f]{64}$/);

  let pass = 0;
  let highS = 0;
  let last = { hash: '' as Hex, r: '' as Hex, s: '' as Hex, rawS: '' as Hex };
  let lastHigh: typeof last | null = null;
  for (let i = 1; i <= N; i++) {
    await page.getByTestId('sign').click();
    await expect(page.getByTestId('count')).toHaveText(String(i), { timeout: 30_000 });
    const err = await page.getByTestId('error').count();
    expect(err).toBe(0);
    last = {
      hash: (await page.getByTestId('hash').textContent()) as Hex,
      r: (await page.getByTestId('r').textContent()) as Hex,
      s: (await page.getByTestId('s').textContent()) as Hex,
      rawS: (await page.getByTestId('raw-s').textContent()) as Hex,
    };
    expect(BigInt(last.s) <= P256_N / 2n).toBe(true);
    if ((await page.getByTestId('high-s').textContent()) === 'true') { highS++; lastHigh = last; }
    if ((await page.getByTestId('valid').textContent()) === 'true') pass++;
  }

  const tamperedHash = hex32(BigInt(last.hash) ^ 1n);
  const tampered = await verifyOnChain(tamperedHash, last.r, last.s, x, y);
  const tamperedS = await verifyOnChain(last.hash, last.r, hex32(BigInt(last.s) ^ 1n), x, y);
  let highForm = 'no high-s sample in this run';
  if (lastHigh) {
    const raw = await verifyOnChain(lastHigh.hash, lastHigh.r, lastHigh.rawS, x, y);
    highForm = `rawS > n/2: ${BigInt(lastHigh.rawS) > P256_N / 2n}, precompile on raw high-s: ${JSON.stringify(raw)}`;
  }
  const mirror = hex32(P256_N - BigInt(last.s));
  const mirrorRes = await verifyOnChain(last.hash, last.r, mirror, x, y);

  console.log(`\npasskey x=${x}\npasskey y=${y}`);
  console.log(`assertions: ${N}, precompile returned 1: ${pass}/${N}`);
  console.log(`raw high-s signatures: ${highS}/${N} (all normalised to low-s before submit)`);
  console.log(`negative tampered hash -> ${JSON.stringify(tampered)} valid=${isValidResult(tampered)}`);
  console.log(`negative tampered s    -> ${JSON.stringify(tamperedS)} valid=${isValidResult(tamperedS)}`);
  console.log(`high-s form: ${highForm}`);
  console.log(`n - s (high form of last sig): detectable high=${BigInt(mirror) > P256_N / 2n}, precompile -> ${JSON.stringify(mirrorRes)}`);

  expect(pass).toBe(N);
  expect(isValidResult(tampered)).toBe(false);
  expect(isValidResult(tamperedS)).toBe(false);
});
