// Copies the built <tazor-pay-button> bundle (packages/pay/dist/tazor-pay.js, or the merchant demo's copy) into
// public/ so /paylink/ loads the exact same file. Run after `pnpm -C packages/pay build`; tests/paylink.test.ts
// fails if the copies drift.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const built = join(root, 'packages', 'pay', 'dist', 'tazor-pay.js');
const demo = join(root, 'examples', 'merchant-demo', 'tazor-pay.js');
const src = existsSync(built) ? built : demo;
copyFileSync(src, join(root, 'apps', 'web', 'public', 'tazor-pay.js'));
console.log(`public/tazor-pay.js ← ${src.slice(root.length + 1)}`);
