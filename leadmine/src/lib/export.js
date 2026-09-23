import { buildXlsx } from './xlsx.js';

/**
 * Serialisers for the three download formats.
 *
 * Column order is fixed here so the CSV, the Excel sheet and the JSON keys all
 * line up, and so a rerun produces a diffable file.
 */

/**
 * Column sets per source.
 *
 * A LinkedIn person and a Maps business share almost no fields, so one merged
 * table would be mostly blank either way. The exporter picks the set that
 * matches what was actually scraped.
 */
export const MAPS_COLUMNS = [
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

/*
 * People, from either door.
 *
 * LinkedIn's own search and a search engine's results describe the same
 * person with the same fields, so one column set covers both — and a file
 * holding rows from both keeps every column either of them filled. Which door
 * a row came through is a column of its own: a public-web row has no
 * connection degree because there is no degree to have, not because the
 * scrape missed it.
 */
export const PEOPLE_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'headline', label: 'Headline' },
  { key: 'company', label: 'Company' },
  { key: 'location', label: 'Location' },
  { key: 'degree', label: 'Connection' },
  { key: 'openToWork', label: 'Open To Work' },
  { key: 'summary', label: 'Match Context' },
  { key: 'profileUrl', label: 'Profile URL' },
  { key: 'photoUrl', label: 'Photo URL' },
  { key: 'searchCategory', label: 'Search' },
  { key: 'source', label: 'Found Via' },
];

/** The name this set had when LinkedIn was the only source of people. */
export const LINKEDIN_COLUMNS = PEOPLE_COLUMNS;

/** Kept as the default so existing callers and tests keep working. */
export const COLUMNS = MAPS_COLUMNS;

/** Choose columns from what the records actually are. */
export function columnsFor(records) {
  const first = (records || []).find((r) => r && r.source);
  const id = first ? first.source : '';
  return id === 'linkedin' || id === 'web' ? PEOPLE_COLUMNS : MAPS_COLUMNS;
}

function cell(record, key) {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  return String(value);
}

export function toCsv(records, columns = columnsFor(records)) {
  const escape = (v) => {
    const s = String(v ?? '');
    // Guard against spreadsheet formula injection from scraped text.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const lines = [columns.map((c) => escape(c.label)).join(',')];
  for (const record of records) {
    lines.push(columns.map((c) => escape(cell(record, c.key))).join(','));
  }
  // Leading BOM so Excel reads UTF-8 (accented street names) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function toJson(records, columns = columnsFor(records)) {
  const rows = records.map((record) => {
    const row = {};
    for (const c of columns) row[c.key] = record[c.key] ?? '';
    return row;
  });
  return JSON.stringify(rows, null, 2);
}

/** The header labels and value rows a spreadsheet needs. */
export function toRows(records, columns = columnsFor(records)) {
  return {
    headers: columns.map((c) => c.label),
    rows: (records || []).map((record) => columns.map((c) => cell(record, c.key))),
  };
}

/**
 * Build the downloadable file.
 *
 * Async because the workbook writer compresses through CompressionStream; CSV
 * and JSON resolve immediately.
 */
export async function buildFile(records, format, meta = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const slug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  // The stamp is always truthy, so the search terms have to be defaulted
  // before it is appended — otherwise every file is named after the clock only.
  const search = [slug(meta.category), slug(meta.city)].filter(Boolean).join('_');
  const source = meta.source || ((records || []).find((r) => r && r.source) || {}).source || '';
  const base = `${source ? `${slug(source)}_` : ''}${search || 'leads'}_${stamp}`;

  if (format === 'json') {
    return { content: toJson(records), mime: 'application/json', filename: `${base}.json` };
  }

  if (format === 'xlsx' || format === 'xls') {
    const { headers, rows } = toRows(records);
    const sheetName = `${meta.category || 'Leads'} ${meta.city || ''}`.trim();
    return {
      content: await buildXlsx({ headers, rows, sheetName }),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${base}.xlsx`,
    };
  }

  return { content: toCsv(records), mime: 'text/csv;charset=utf-8', filename: `${base}.csv` };
}
