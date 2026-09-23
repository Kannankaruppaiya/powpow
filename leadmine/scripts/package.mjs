/**
 * Bundles the extension into dist/leadmine-v<version>.zip.
 *
 * Writes the ZIP by hand (local headers + central directory + EOCD, deflated
 * with node:zlib) so packaging needs no dependencies and no system `zip`,
 * which keeps it working on Windows too.
 *
 * Run with: node scripts/package.mjs
 */
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything Chrome needs at runtime — and nothing else. */
const INCLUDE = ['manifest.json', 'icons', 'src'];
const SKIP_FILE = /\.(md|zip|log)$/i;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function collect(entry) {
  const abs = join(ROOT, entry);
  if (statSync(abs).isFile()) return SKIP_FILE.test(entry) ? [] : [entry];
  return readdirSync(abs).flatMap((child) => collect(join(entry, child)));
}

/** MS-DOS date/time, the only timestamp format the ZIP header carries. */
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(files, now = new Date()) {
  const { time, day } = dosTime(now);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    // ZIP always uses forward slashes, whatever the host separator is.
    const name = Buffer.from(file.split(sep).join('/'), 'utf8');
    const raw = readFileSync(join(ROOT, file));
    const deflated = deflateRawSync(raw, { level: 9 });
    // Fall back to "stored" when compression would make the entry larger.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attrs: regular file
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const files = INCLUDE.flatMap(collect).sort();
const zip = buildZip(files);

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', `leadmine-v${version}.zip`);
writeFileSync(out, zip);

console.log(`packaged ${files.length} files -> ${relative(ROOT, out)} (${(zip.length / 1024).toFixed(1)} KB)`);
for (const f of files) console.log(`  ${f}`);
