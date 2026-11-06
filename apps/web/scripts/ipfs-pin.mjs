// Pins the static build on Pinata. Prefers the CAR upload (keeps the reproducible root CID);
// falls back to a folder upload. Needs PINATA_JWT in the environment.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const jwt = process.env.PINATA_JWT;
if (!jwt) { console.error('PINATA_JWT is required'); process.exit(1); }
const car = process.argv[2] ?? 'ipfs/site.car';
const expected = process.argv[3];
const name = process.env.PIN_NAME ?? 'tazor-web';

async function pinCar() {
  const fd = new FormData();
  fd.append('file', new File([readFileSync(car)], `${name}.car`, { type: 'application/vnd.ipld.car' }));
  fd.append('network', 'public');
  fd.append('car', 'true');
  fd.append('name', `${name}.car`);
  const res = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, cid: body?.data?.cid, body };
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

async function pinFolder() {
  const fd = new FormData();
  for (const f of walk('out').sort()) fd.append('file', new File([readFileSync(f)], relative('out', f)), `site/${relative('out', f)}`);
  fd.append('pinataMetadata', JSON.stringify({ name }));
  fd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: fd });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, cid: body?.IpfsHash, body };
}

let r = await pinCar();
let mode = 'car';
if (!r.ok || !r.cid) {
  console.log(`car upload not available (HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}); using folder upload`);
  r = await pinFolder();
  mode = 'folder';
}
if (!r.ok || !r.cid) { console.error(`pin failed (HTTP ${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`); process.exit(1); }
console.log(`mode ${mode}`);
console.log(`cid ${r.cid}`);
if (expected) console.log(`matches reproducible CID: ${r.cid === expected}`);
