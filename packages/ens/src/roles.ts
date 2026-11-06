const role = (nybble: number) => 1n << BigInt(4 * nybble);
const admin = (r: bigint) => r << 128n;

export const ROLE_REGISTRAR = role(0);
export const ROLE_REGISTER_RESERVED = role(1);
export const ROLE_SET_PARENT = role(2);
export const ROLE_UNREGISTER = role(3);
export const ROLE_RENEW = role(4);
export const ROLE_SET_SUBREGISTRY = role(5);
export const ROLE_SET_RESOLVER = role(6);
export const ROLE_CAN_TRANSFER_ADMIN = admin(role(7));
export const ROLE_SET_URI = role(9);
export const ROLE_CAN_NAME = role(30);
export const ROLE_UPGRADE = role(31);

export const ROLE_APPROVER = role(16);
export const ROLE_TAZOR_ADMIN = role(17);
export const ROLE_AGENT = role(18);
export const ROLE_APPROVER_ADMIN = admin(ROLE_APPROVER);
export const ROLE_TAZOR_ADMIN_ADMIN = admin(ROLE_TAZOR_ADMIN);
export const ROLE_AGENT_ADMIN = admin(ROLE_AGENT);

const REGISTRY_ROOT_ROLES = [
  ROLE_REGISTRAR, ROLE_REGISTER_RESERVED, ROLE_SET_PARENT, ROLE_UNREGISTER, ROLE_RENEW,
  ROLE_SET_SUBREGISTRY, ROLE_SET_RESOLVER, ROLE_SET_URI, ROLE_CAN_NAME,
].reduce((a, r) => a | r | admin(r), 0n);

export const COMPANY_ADMIN_ROLES =
  REGISTRY_ROOT_ROLES | ROLE_CAN_TRANSFER_ADMIN |
  ROLE_TAZOR_ADMIN | ROLE_TAZOR_ADMIN_ADMIN | ROLE_APPROVER_ADMIN | ROLE_AGENT_ADMIN;

// The company name keeps its registry link fixed: no unregister or subregistry change.
export const COMPANY_NAME_ROLES = [ROLE_SET_RESOLVER, ROLE_SET_URI]
  .reduce((a, r) => a | r | admin(r), ROLE_CAN_TRANSFER_ADMIN);

export const NAME_OWNER_ROLES = [ROLE_UNREGISTER, ROLE_SET_SUBREGISTRY, ROLE_SET_RESOLVER, ROLE_SET_URI]
  .reduce((a, r) => a | r | admin(r), ROLE_CAN_TRANSFER_ADMIN);
