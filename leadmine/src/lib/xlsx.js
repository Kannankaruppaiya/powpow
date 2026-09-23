/**
 * A real .xlsx writer — OOXML parts in a ZIP container, no dependencies.
 *
 * The previous export wrote an HTML table and named it .xls. Excel opens that,
 * but warns that the file's contents do not match its extension every single
 * time, and other tools reject it outright. This produces a genuine
 * SpreadsheetML workbook instead.
 *
 * Compression uses the platform's own CompressionStream('deflate-raw'), which
 * both Chrome and Node provide, so nothing has to be bundled. Where it is
 * missing the writer falls back to stored (uncompressed) entries, which is
 * still a valid ZIP.
 */

const encoder = new TextEncoder();

/* ------------------------------------------------------------------- OOXML */

/** Control characters XML 1.0 forbids outright, even escaped. */
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** XML text escaping, plus stripping the control characters XML forbids. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** "A", "B", … "Z", "AA", … — the column name for a 1-based index. */
export function columnName(index) {
  let n = index;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * Every value is written as an inline string, including numeric-looking ones.
 *
 * A phone number like 04423456789 loses its leading zero the moment Excel
 * treats it as a number, and "+91 98765 43210" becomes a formula error. A
 * left-aligned column is a much smaller problem than silently corrupted data.
 */
function cellXml(ref, value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text === '') return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(headers, rows) {
  const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  // Freeze the header row so a 5,000-row sheet stays navigable.
  parts.push(
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
  );
  parts.push('<sheetData>');

  parts.push(`<row r="1">${headers.map((h, i) => cellXml(`${columnName(i + 1)}1`, h)).join('')}</row>`);

  rows.forEach((row, rowIndex) => {
    const r = rowIndex + 2;
    const cells = row.map((value, i) => cellXml(`${columnName(i + 1)}${r}`, value)).join('');
    parts.push(`<row r="${r}">${cells}</row>`);
  });

  parts.push('</sheetData>');
  // An autofilter on the header row, which is what people reach for first.
  if (headers.length) {
    parts.push(`<autoFilter ref="A1:${columnName(headers.length)}${rows.length + 1}"/>`);
  }
  parts.push('</worksheet>');
  return parts.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/** Excel rejects a sheet name over 31 chars or containing : \ / ? * [ ] */
export function safeSheetName(name) {
  const cleaned = String(name || 'Sheet1').replace(/[:\\/?*\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

/* --------------------------------------------------------------------- ZIP */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // stored entries are still a valid ZIP
  }
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Build a ZIP from [{ name, bytes }] entries. */
export async function zip(entries, now = new Date()) {
  const { time, day } = dosDateTime(now);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = entry.bytes;
    const deflated = await deflateRaw(raw);
    // Fall back to stored when compression would not actually help.
    const useDeflate = deflated && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, day, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(38, 0, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  const parts = [...locals, ...central, new Uint8Array(eocd.buffer)];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ public */

/**
 * Build a workbook from a header row and rows of values.
 * Returns the bytes of a .xlsx file.
 */
export async function buildXlsx({ headers, rows, sheetName = 'Leads' }) {
  const files = [
    { name: '[Content_Types].xml', bytes: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', bytes: encoder.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', bytes: encoder.encode(workbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: encoder.encode(WORKBOOK_RELS) },
    { name: 'xl/worksheets/sheet1.xml', bytes: encoder.encode(sheetXml(headers || [], rows || [])) },
  ];
  return zip(files);
}
