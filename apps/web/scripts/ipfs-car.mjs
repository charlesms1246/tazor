import { openAsBlob } from 'node:fs';
import { readdir, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Writable } from 'node:stream';
import { createDirectoryEncoderStream, CAREncoderStream } from 'ipfs-car';

const ROOT = join(import.meta.dirname, '..', 'out');
const OUT = process.argv[2] ?? join(import.meta.dirname, '..', 'ipfs', 'site.car');

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(ROOT, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

const paths = await listFiles(ROOT);
const files = await Promise.all(paths.map(async (name) => {
  const blob = await openAsBlob(join(ROOT, name));
  return { name, stream: () => blob.stream() };
}));

const blocks = [];
await createDirectoryEncoderStream(files).pipeTo(new WritableStream({ write(b) { blocks.push(b); } }));
const root = blocks.at(-1).cid;

await mkdir(join(OUT, '..'), { recursive: true });
await new ReadableStream({ start(c) { for (const b of blocks) c.enqueue(b); c.close(); } })
  .pipeThrough(new CAREncoderStream([root]))
  .pipeTo(Writable.toWeb(createWriteStream(OUT)));

console.log(`files ${paths.length}, blocks ${blocks.length}`);
console.log(`car   ${relative(process.cwd(), OUT)}`);
console.log(`root  ${root.toV1().toString()}`);
