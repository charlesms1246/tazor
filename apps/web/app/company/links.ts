import type { Address } from 'viem';

const ENS_EXPLORER = 'https://sepolia.explorer.ens.domains';

export const ensNameUrl = (ens: string) => `${ENS_EXPLORER}/${ens}`;
export const ensRegistryUrl = (ens: string) => `${ENS_EXPLORER}/${ens}/registry`;
export const ensRolesUrl = (ens: string) => `${ENS_EXPLORER}/${ens}/roles`;
export const ensAddressUrl = (a: Address) => `${ENS_EXPLORER}/${a}`;
export const registryEventsUrl = (registry: Address) => `https://sepolia.etherscan.io/address/${registry}#events`;
