import { encodeFunctionData, getAddress, isHex, parseAbi, size, slice, type Address, type Hex, type PublicClient } from 'viem';
import { BadRequest } from './payment.ts';

export const approverFactoryAbi = parseAbi([
  'function createAccount(bytes[] signers) returns (address)',
  'function predictAddress(bytes[] signers) view returns (address)',
  'function webAuthnVerifier() view returns (address)',
]);

export function parseSigner(body: unknown, webAuthnVerifier: Address): Hex {
  const signer = (body as { signer?: unknown } | null)?.signer;
  if (typeof signer !== 'string' || !isHex(signer, { strict: true }) || signer.length % 2 !== 0) {
    throw new BadRequest('signer must be hex');
  }
  const n = size(signer);
  if (n === 20) return signer;
  if (n === 84 && getAddress(slice(signer, 0, 20)) === getAddress(webAuthnVerifier)) return signer;
  throw new BadRequest('signer must be a 20-byte EOA or an 84-byte passkey id for the factory WebAuthn verifier');
}

export function createApproverDeployer(client: PublicClient, factory: Address) {
  let verifier: Promise<Address> | undefined;
  return {
    factory,
    webAuthnVerifier: () =>
      (verifier ??= client.readContract({ address: factory, abi: approverFactoryAbi, functionName: 'webAuthnVerifier' })
        .catch((e) => { verifier = undefined; throw e; })),
    predict: (signer: Hex) =>
      client.readContract({ address: factory, abi: approverFactoryAbi, functionName: 'predictAddress', args: [[signer]] }),
    isDeployed: async (account: Address) => ((await client.getCode({ address: account })) ?? '0x') !== '0x',
    createCalldata: (signer: Hex) => encodeFunctionData({ abi: approverFactoryAbi, functionName: 'createAccount', args: [[signer]] }),
  };
}

export type ApproverDeployer = ReturnType<typeof createApproverDeployer>;
