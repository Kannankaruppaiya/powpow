export const COLUMNS = [
  ['name', 'Name'],
  ['category', 'Category'],
  ['phone', 'Phone'],
  ['email', 'Email'],
  ['area', 'Area'],
  ['address', 'Address'],
  ['rating', 'Rating'],
  ['reviews', 'Reviews'],
  ['website', 'Website'],
  ['plusCode', 'Plus code'],
  ['query', 'Search query'],
  ['url', 'Maps URL'],
];

function cell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows) {
  const lines = [COLUMNS.map((c) => cell(c[1])).join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => cell(row[c[0]])).join(','));
  }
  // BOM keeps Excel happy with non-ASCII business names.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
