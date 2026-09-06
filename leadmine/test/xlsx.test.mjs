import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

import { buildXlsx, zip, crc32, columnName, safeSheetName, escapeXml } from '../src/lib/xlsx.js';

/** Minimal ZIP reader, so the tests verify the container rather than trusting it. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let at = 0;

  while (at < bytes.length - 4 && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const compressed = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));

    const bodyAt = at + 30 + nameLen + extraLen;
    const body = bytes.subarray(bodyAt, bodyAt + compressed);
    // The writer emits raw DEFLATE (method 8, no zlib header), matching what
    // CompressionStream('deflate-raw') produces.
    const raw = method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(body))) : body;

    files[name] = { text: new TextDecoder().decode(raw), method };
    at = bodyAt + compressed;
  }
  return files;
}

test('columnName counts like a spreadsheet', () => {
  assert.equal(columnName(1), 'A');
  assert.equal(columnName(26), 'Z');
  assert.equal(columnName(27), 'AA');
  assert.equal(columnName(52), 'AZ');
  assert.equal(columnName(53), 'BA');
  assert.equal(columnName(703), 'AAA');
});

test('escapeXml escapes markup and drops characters XML forbids', () => {
  assert.equal(
    escapeXml('a & b < c > "d" \'e\''),
    'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;'
  );
  // A stray control character would make the whole workbook unreadable.
  assert.equal(escapeXml('bad\x07char\x00here'), 'badcharhere');
  // Tab and newline are legal XML and must survive.
  assert.equal(escapeXml('keep\tthis\nplease'), 'keep\tthis\nplease');
});

test('safeSheetName obeys Excel rules on length and characters', () => {
  assert.equal(safeSheetName('dentists: Chennai/TN [big]'), 'dentists Chennai TN big');
  assert.equal(safeSheetName(''), 'Sheet1');
  assert.equal(safeSheetName(null), 'Sheet1');
  assert.equal(safeSheetName('x'.repeat(50)).length, 31);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('buildXlsx produces every part a workbook needs', async () => {
  const files = readZip(await buildXlsx({ headers: ['Name'], rows: [['A']] }));
  for (const part of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/worksheets/sheet1.xml',
  ]) {
    assert.ok(files[part], `missing part ${part}`);
  }
});

test('every value is written as an inline string', async () => {
  // The whole reason for this module: Excel eats the leading zero otherwise.
  const files = readZip(await buildXlsx({ headers: ['Phone'], rows: [['04423456789']] }));
  const sheet = files['xl/worksheets/sheet1.xml'].text;
  assert.ok(sheet.includes('t="inlineStr"'));
  assert.ok(sheet.includes('>04423456789<'));
  assert.ok(!sheet.includes('t="n"'), 'nothing should be typed as a number');
});

test('the sheet carries a frozen header and an autofilter', async () => {
  const files = readZip(
    await buildXlsx({ headers: ['A', 'B'], rows: [['1', '2'], ['3', '4']] })
  );
  const sheet = files['xl/worksheets/sheet1.xml'].text;
  assert.ok(sheet.includes('state="frozen"'));
  assert.ok(sheet.includes('ref="A1:B3"'), 'autofilter spans the header plus both rows');
});

test('empty cells are omitted rather than written blank', async () => {
  const files = readZip(await buildXlsx({ headers: ['A', 'B'], rows: [['x', '']] }));
  const sheet = files['xl/worksheets/sheet1.xml'].text;
  assert.ok(sheet.includes('r="A2"'));
  assert.ok(!sheet.includes('r="B2"'), 'a blank cell should not be emitted');
});

test('markup in scraped text cannot break the workbook', async () => {
  const files = readZip(await buildXlsx({ headers: ['Name'], rows: [['Ben & Jerry <"Ltd">']] }));
  assert.ok(
    files['xl/worksheets/sheet1.xml'].text.includes('Ben &amp; Jerry &lt;&quot;Ltd&quot;&gt;')
  );
});

test('a workbook with no rows is still valid', async () => {
  const files = readZip(await buildXlsx({ headers: ['Name'], rows: [] }));
  assert.ok(files['xl/worksheets/sheet1.xml'].text.includes('<sheetData>'));
});

test('the sheet name reaches the workbook part', async () => {
  const files = readZip(
    await buildXlsx({ headers: ['A'], rows: [], sheetName: 'dentists/Chennai' })
  );
  assert.ok(files['xl/workbook.xml'].text.includes('name="dentists Chennai"'));
});

test('zip deflates what compresses and stores what does not', async () => {
  const enc = new TextEncoder();
  const files = readZip(
    await zip([
      { name: 'big.txt', bytes: enc.encode('a'.repeat(5000)) },
      { name: 'tiny.txt', bytes: enc.encode('a') },
    ])
  );

  assert.equal(files['big.txt'].method, 8, 'repetitive text should deflate');
  assert.equal(files['big.txt'].text.length, 5000, 'and round-trip intact');
  assert.equal(files['tiny.txt'].method, 0, 'one byte is not worth compressing');
});

test('a large sheet stays small and fast', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => [`Business ${i}`, '04423456789']);
  const started = Date.now();
  const bytes = await buildXlsx({ headers: ['Name', 'Phone'], rows });
  const elapsed = Date.now() - started;

  assert.ok(bytes.length < 1_000_000, `5,000 rows should stay under 1 MB, got ${bytes.length}`);
  assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
  assert.ok(readZip(bytes)['xl/worksheets/sheet1.xml'].text.includes('Business 4999'));
});
