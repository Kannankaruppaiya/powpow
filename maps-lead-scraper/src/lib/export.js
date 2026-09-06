/**
 * Serialisers for the three download formats.
 *
 * Column order is fixed here so the CSV, the Excel sheet and the JSON keys all
 * line up, and so a rerun produces a diffable file.
 */

export const COLUMNS = [
  { key: 'name', label: 'Business Name' },
  { key: 'category', label: 'Category' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'emailStatus', label: 'Email Status' },
  { key: 'area', label: 'Area' },
  { key: 'city', label: 'City' },
  { key: 'address', label: 'Full Address' },
  { key: 'rating', label: 'Rating' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'website', label: 'Website' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'twitter', label: 'X / Twitter' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'hours', label: 'Opening Hours' },
  { key: 'priceLevel', label: 'Price Level' },
  { key: 'claimed', label: 'Claimed' },
  { key: 'allEmails', label: 'Other Emails' },
  { key: 'plusCode', label: 'Plus Code' },
  { key: 'mapsUrl', label: 'Google Maps URL' },
];

function cell(record, key) {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  return String(value);
}

export function toCsv(records) {
  const escape = (v) => {
    const s = String(v ?? '');
    // Guard against spreadsheet formula injection from scraped text.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const lines = [COLUMNS.map((c) => escape(c.label)).join(',')];
  for (const record of records) {
    lines.push(COLUMNS.map((c) => escape(cell(record, c.key))).join(','));
  }
  // Leading BOM so Excel reads UTF-8 (accented street names) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function toJson(records) {
  const rows = records.map((record) => {
    const row = {};
    for (const c of COLUMNS) row[c.key] = record[c.key] ?? '';
    return row;
  });
  return JSON.stringify(rows, null, 2);
}

/**
 * Excel opens an HTML table saved as .xls natively, which gets us a real
 * spreadsheet without bundling a zip/XLSX writer into the extension.
 */
export function toExcelHtml(records, title = 'Google Maps Leads') {
  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const head = COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = records
    .map(
      (record) =>
        `<tr>${COLUMNS.map((c) => {
          // Force text so long phone numbers keep their leading + and zeros.
          const style = c.key === 'phone' ? ' style="mso-number-format:\\@"' : '';
          return `<td${style}>${esc(cell(record, c.key))}</td>`;
        }).join('')}</tr>`
    )
    .join('');

  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>${esc(title)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>th{background:#0b57d0;color:#fff;text-align:left}td,th{border:1px solid #ccc;padding:4px}</style>
</head><body><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function buildFile(records, format, meta = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const slug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  // The stamp is always truthy, so the search terms have to be defaulted
  // before it is appended — otherwise every file is named after the clock only.
  const search = [slug(meta.category), slug(meta.city)].filter(Boolean).join('_');
  const base = `${search || 'maps-leads'}_${stamp}`;

  if (format === 'json') {
    return { content: toJson(records), mime: 'application/json', filename: `${base}.json` };
  }
  if (format === 'xls') {
    return {
      content: toExcelHtml(records, `${meta.category || 'Leads'} ${meta.city || ''}`.trim()),
      mime: 'application/vnd.ms-excel',
      filename: `${base}.xls`,
    };
  }
  return { content: toCsv(records), mime: 'text/csv;charset=utf-8', filename: `${base}.csv` };
}
