import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentUri } from '../src/deposit.ts';

test('EIP-681 USDT transfer request on Whitechain Sepolia', () => {
  const to = '0x5ea4be1059864e05e587d285f2cebfb4acfb02f2';
  assert.equal(
    paymentUri(to, 200_000n),
    'ethereum:0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7@1874/transfer?address=0x5EA4be1059864e05e587d285F2ceBFb4acFB02f2&uint256=200000',
  );
  assert.match(paymentUri(to, '1', { chainId: 1875, token: '0xF95604a4034d8407d3F1256De56C9ae37F299cb8' }), /^ethereum:0xF95604a4034d8407d3F1256De56C9ae37F299cb8@1875\/transfer\?address=0x5EA4/);
  assert.throws(() => paymentUri(to, 0n));
});
