import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { BadRequest, encodePayOne, type PayRequest } from './payment.ts';
import { resolveCounterfactual, type Deploy } from './erc6492.ts';

const invoiceDigestAbi = parseAbi([
  'struct InvoiceAuth { bytes32 invoiceHash; address account; address payee; uint256 amount; uint64 expiry; uint256 nonce; }',
  'function invoiceDigest(InvoiceAuth auth) view returns (bytes32)',
  'function registryOf(address account) view returns (address)',
]);

/** payOne calldata with inner signatures, plus the ERC-6492 approver deploys to send first. */
export async function preparePayOne(
  client: PublicClient, factory: Address, paymentModule: Address, r: PayRequest,
): Promise<{ data: Hex; deploys: Deploy[] }> {
  // refuse before any deploy if the payment can't succeed for a reason unrelated to the signature
  const reg = await client.readContract({ address: paymentModule, abi: invoiceDigestAbi, functionName: 'registryOf', args: [r.account] });
  if (/^0x0{40}$/i.test(reg)) throw new BadRequest(`account ${r.account} has no PaymentModule configuration`);
  const digest = () => client.readContract({ address: paymentModule, abi: invoiceDigestAbi, functionName: 'invoiceDigest', args: [r.auth] });
  const { signatures, deploys } = await resolveCounterfactual(client, factory, r.approvers, r.signatures, digest);
  return { data: encodePayOne({ ...r, signatures }), deploys };
}
