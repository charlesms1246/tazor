import { encodeFunctionData, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { BadRequest, UINT256_MAX, addr, hex, uint, type InvoiceAuth } from './payment.ts';
import { resolveCounterfactual, type Deploy } from './erc6492.ts';

export const PAYMENT_MODULE_V2: Address = '0x906620D82e2959351c81D731C67EA46DF71E36f3';

export const payRunAbi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'function payRun(address account, InvoiceAuth[] auths, address[] approvers, bytes[] signatures)',
  'function runDigest(InvoiceAuth[] auths) view returns (bytes32)',
  'function registryOf(address account) view returns (address)',
]);

const UINT64_MAX = (1n << 64n) - 1n;
export const MAX_RUN = 50;

export type PayRunRequest = { account: Address; auths: InvoiceAuth[]; approvers: Address[]; signatures: Hex[] };

export function parsePayRunRequest(body: unknown): PayRunRequest {
  if (typeof body !== 'object' || body === null) throw new BadRequest('body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.auths) || b.auths.length === 0 || b.auths.length > MAX_RUN) throw new BadRequest(`auths must be an array of 1..${MAX_RUN}`);
  if (!Array.isArray(b.approvers) || !Array.isArray(b.signatures) || b.approvers.length === 0 || b.approvers.length !== b.signatures.length) {
    throw new BadRequest('approvers and signatures must be non-empty arrays of the same length');
  }
  const account = addr(b.account, 'account');
  const auths = b.auths.map((v, i) => {
    const a = v as Record<string, unknown>;
    if (typeof a !== 'object' || a === null) throw new BadRequest(`auths[${i}] must be an object`);
    const auth: InvoiceAuth = {
      invoiceHash: hex(a.invoiceHash, `auths[${i}].invoiceHash`, 32),
      account: addr(a.account, `auths[${i}].account`),
      payee: addr(a.payee, `auths[${i}].payee`),
      amount: uint(a.amount, `auths[${i}].amount`, UINT256_MAX),
      expiry: uint(a.expiry, `auths[${i}].expiry`, UINT64_MAX),
      nonce: uint(a.nonce, `auths[${i}].nonce`, UINT256_MAX),
    };
    if (!isAddressEqual(auth.account, account)) throw new BadRequest(`auths[${i}].account must equal account`);
    return auth;
  });
  return {
    account, auths,
    approvers: b.approvers.map((v, i) => addr(v, `approvers[${i}]`)),
    signatures: b.signatures.map((v, i) => hex(v, `signatures[${i}]`)),
  };
}

export const encodePayRun = (r: PayRunRequest): Hex =>
  encodeFunctionData({ abi: payRunAbi, functionName: 'payRun', args: [r.account, r.auths, r.approvers, r.signatures] });

const registryOf = async (client: PublicClient, module: Address, account: Address): Promise<Address> => {
  try {
    return await client.readContract({ address: module, abi: payRunAbi, functionName: 'registryOf', args: [account] });
  } catch {
    return zeroAddress;
  }
};

/** PaymentModuleV2 if the account is configured there, else v1; refused if configured on neither. */
export async function pickModule(client: PublicClient, account: Address, v1: Address, v2: Address): Promise<Address> {
  if (!isAddressEqual(await registryOf(client, v2, account), zeroAddress)) return v2;
  if (!isAddressEqual(await registryOf(client, v1, account), zeroAddress)) return v1;
  throw new BadRequest(`account ${account} has no PaymentModule configuration`);
}

/** Module, payRun calldata (inner signatures) and any ERC-6492 approver deploys to send first. */
export async function preparePayRun(
  client: PublicClient, factory: Address, v1: Address, v2: Address, r: PayRunRequest,
): Promise<{ to: Address; data: Hex; deploys: Deploy[] }> {
  const to = await pickModule(client, r.account, v1, v2);
  const digest = () => client.readContract({ address: to, abi: payRunAbi, functionName: 'runDigest', args: [r.auths] });
  const { signatures, deploys } = await resolveCounterfactual(client, factory, r.approvers, r.signatures, digest);
  return { to, data: encodePayRun({ ...r, signatures }), deploys };
}
