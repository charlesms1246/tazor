/** True when a message carries raw technical values (addresses, hashes, calldata) worth a "For developers" disclosure.
 * The readable version of such text comes from plain() in ./human.ts. */
export const hasHex = (text: string) => /0x[0-9a-fA-F]{40,}/.test(text);
