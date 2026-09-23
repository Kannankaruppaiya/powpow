import { buildXlsx } from './xlsx.js';
import { sequencerRows, SEQUENCER_COLUMNS, STATUS_LABEL } from './crm.js';
import { effectiveVerdict, VERDICT_LABEL } from './qualify.js';
import { peopleSummary } from './link.js';

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
  // What the business's own website says about itself — its schema.org
  // description, the people it names, its headcount. Read during the email
  // pass at no extra request.
  { key: 'siteDescription', label: 'Website Description' },
  { key: 'sitePeople', label: 'People Named On Website' },
  { key: 'employees', label: 'Employees' },
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

/*
 * Posts. A post is a lead because of when it was written and what it asks, so
 * those come first; the reason it was judged to ask comes with it, and so
 * does the reason a row was set aside when set-aside rows are shown.
 */
export const POSTS_COLUMNS = [
  { key: 'postedAt', label: 'Posted On' },
  { key: 'ageDays', label: 'Age (Days)' },
  { key: 'intent', label: 'Intent' },
  { key: 'score', label: 'Score' },
  { key: 'signals', label: 'Why' },
  { key: 'author', label: 'Author' },
  { key: 'authorUrl', label: 'Author Profile' },
  { key: 'text', label: 'Post' },
  { key: 'emails', label: 'Emails In Post' },
  { key: 'phones', label: 'Phones In Post' },
  { key: 'postUrl', label: 'Post URL' },
  { key: 'searchCategory', label: 'Search' },
  { key: 'setAside', label: 'Set Aside Because' },
];

/** The name this set had when LinkedIn was the only source of people. */
export const LINKEDIN_COLUMNS = PEOPLE_COLUMNS;

/** Kept as the default so existing callers and tests keep working. */
export const COLUMNS = MAPS_COLUMNS;

/*
 * What the user and the judge said about each lead.
 *
 * Kept in the notes store, not on the record, so a re-scrape cannot wipe
 * them (see store.js). Joined in only at export time, and only when there is
 * something to join — a file with eleven empty columns on the end is a file
 * that looks broken.
 */
export const ANNOTATION_COLUMNS = [
  { key: 'fit', label: 'Fit' },
  { key: 'fitReason', label: 'Why' },
  { key: 'services', label: 'What They Do / Need' },
  { key: 'decisionMaker', label: 'Decision Maker' },
  { key: 'size', label: 'Size' },
  { key: 'personEmail', label: 'Person Email' },
  { key: 'personEmailStatus', label: 'Person Email Status' },
  { key: 'linked', label: 'Linked' },
  { key: 'status', label: 'Status' },
  { key: 'followUpOn', label: 'Follow Up On' },
  { key: 'doNotContact', label: 'Do Not Contact' },
];

/**
 * Records with their notes and links folded in, as export fields.
 *
 * `linked` maps a person's key to the business they work at; `people` maps a
 * business's key to the people found working there.
 */
export function annotate(records, { notes = new Map(), linked = new Map(), people = new Map(), isSuppressed } = {}) {
  return (records || []).map((record) => {
    const note = notes.get(record.key) || {};
    const verdict = effectiveVerdict(note);
    const business = linked.get(record.key);
    const staff = people.get(record.key);
    const dnc = isSuppressed ? isSuppressed(record, note) : Boolean(note.suppressed);
    return {
      ...record,
      fit: verdict ? VERDICT_LABEL[verdict] : '',
      fitReason: note.feedback && note.feedbackWhy ? note.feedbackWhy : note.reason || '',
      services: note.services || '',
      decisionMaker: note.decisionMaker || '',
      size: note.size || '',
      personEmail: note.personEmail || '',
      personEmailStatus: note.personEmail ? note.personEmailStatus || '' : '',
      linked: business
        ? `Works at ${business.name}${business.phone ? ` · ${business.phone}` : ''}${business.website ? ` · ${business.website}` : ''}`
        : staff && staff.length
          ? peopleSummary(staff)
          : '',
      status: note.status ? STATUS_LABEL[note.status] || note.status : '',
      followUpOn: note.followUpOn || '',
      doNotContact: dnc ? 'Yes' : '',
    };
  });
}

/** Whether any record carries an annotation worth a column. */
export function hasAnnotations(records) {
  return (records || []).some((r) => ANNOTATION_COLUMNS.some((c) => r[c.key]));
}

/** Choose columns from what the records actually are. */
export function columnsFor(records) {
  const first = (records || []).find((r) => r && r.source);
  const id = first ? first.source : '';
  if (id === 'posts') return POSTS_COLUMNS;
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
export async function buildFile(records, format, meta = {}, extras = null) {
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

  /*
   * For a cold-email tool: its own column names, only rows with an address,
   * and never a lead that is suppressed, judged a poor fit or closed. A
   * sequencer mails every row it is given, so this is the last place a "no"
   * can be honoured.
   */
  if (format === 'sequencer') {
    const rows = sequencerRows(records, (extras && extras.notes) || new Map(), {
      isSuppressed: (extras && extras.isSuppressed) || (() => false),
      linked: (extras && extras.linked) || new Map(),
    });
    return {
      content: toCsv(rows, SEQUENCER_COLUMNS),
      mime: 'text/csv;charset=utf-8',
      filename: `${base}_cold-email.csv`,
      count: rows.length,
    };
  }

  let rows = records;
  let columns = columnsFor(records);
  if (extras) {
    const annotated = annotate(records, extras);
    if (hasAnnotations(annotated)) {
      rows = annotated;
      columns = [...columns, ...ANNOTATION_COLUMNS];
    }
  }

  if (format === 'json') {
    return { content: toJson(rows, columns), mime: 'application/json', filename: `${base}.json` };
  }

  if (format === 'xlsx' || format === 'xls') {
    const { headers, rows: cells } = toRows(rows, columns);
    const sheetName = `${meta.category || 'Leads'} ${meta.city || ''}`.trim();
    return {
      content: await buildXlsx({ headers, rows: cells, sheetName }),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${base}.xlsx`,
    };
  }

  return { content: toCsv(rows, columns), mime: 'text/csv;charset=utf-8', filename: `${base}.csv` };
}
