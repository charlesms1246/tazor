export type Timing = {
  action: string;
  bank: string;
  tazor: string;
  status: 'measured' | 'estimate' | 'pending';
  proof?: { label: string; url: string }[];
};

const wc = (tx: string) => `https://explorer.testnet.whitechain.io/tx/${tx}`;
const sep = (tx: string) => `https://sepolia.etherscan.io/tx/${tx}`;

export const TIMINGS: Timing[] = [
  {
    action: 'Pay an approved invoice', bank: 'SEPA Instant: up to 10 s', tazor: '3.6 s', status: 'measured',
    proof: [{ label: 'payment', url: wc('0xbceeaa443a3e17a19037a677a459a88dcd11a7e17b01ebd431118c997ce84f21') }],
  },
  {
    action: 'Pay with our servers down (Ethereum fallback)', bank: 'Not possible if the provider is down', tazor: '69 s via Ethereum', status: 'measured',
    proof: [
      { label: 'Ethereum forward', url: sep('0x2e387ff547f1100cc6ef5baf780acaf19a220b0b0ce7d140b7dc06e8ec561019') },
      { label: 'Whitechain payment', url: wc('0xa00dbd6923b79335f4ee60733adaa0f68652a47915141ddba0e6719b48eea30e') },
    ],
  },
  {
    action: 'Set up a direct debit (mandate)', bank: 'e-NACH: 1–4 business days', tazor: 'Instant (one transaction)', status: 'measured',
    proof: [{ label: 'first collection', url: wc('0x593e6ac94971ca40c6ee3b8c67f0064a43044ba6bfeabe88181906d4c46210b2') }],
  },
  {
    action: 'Change who may approve', bank: '7–10 working days', tazor: '100 s (ENS change on Ethereum to role synced on Whitechain)', status: 'measured',
    proof: [
      { label: 'ENS grant', url: sep('0xc6de52196314c651b27cfb769f37855d12b6eb30b24061a3b7a4cdc8baa67516') },
      { label: 'Whitechain sync', url: wc('0x2798c3911a6b494b0bb5dc65a00c61219d8fda339a182346d84c82bab465bc7e') },
    ],
  },
  {
    action: 'Remove a person', bank: '7–10 working days', tazor: '3.06 s', status: 'measured',
    proof: [{ label: 'revocation', url: wc('0x027e1cfd06b86adaadab600b98b9444c98178c56ff038ef09daacb3df6ecd6ef') }],
  },
  {
    action: 'Issue a credit note', bank: '–', tazor: 'One transaction', status: 'measured',
    proof: [{ label: 'credit note', url: wc('0x4be6a82a6f5a8aa7df415cecda37f693d2e4b09659474765fac407d9da1b4c38') }],
  },
];
