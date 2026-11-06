// Builds a live proof of _roles[0][account] in an ENSv2 registry and prints it as hex.
// Usage: bun sync-roles.ts <registry> <account>
import { proveRoles } from './prove-roles.ts';

const [registry, account] = process.argv.slice(2);
const proof = await proveRoles(registry, account, {
  onInfo: ({ l1Block, direct }) => console.error(`l1Block=${l1Block} direct=${direct}`),
});
console.log(proof);
