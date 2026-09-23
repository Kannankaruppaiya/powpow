/**
 * Self-healing selectors.
 *
 * Google reshuffles the Maps DOM without warning, and a selector that stops
 * matching used to mean a run that paused itself until somebody edited the
 * `SEL` table by hand. The idea here is Scrapling's (github.com/D4Vinci/
 * Scrapling, `Selector.relocate`): every time a selector works, remember what
 * the element it found *looks like* — its tag, attributes, text, where it
 * sits in the tree, its parent and its siblings. When the selector later finds
 * nothing, score every element of the same kind on the page against that
 * memory and take the best one, if it is close enough.
 *
 * Only for elements that are always there. The results feed, the result
 * links, the detail panel and the Back button exist on every Maps search; a
 * phone button does not — a business without a phone has none — and
 * "relocating" a field that is legitimately absent would put a stranger's
 * number in the row. Optional fields stay exact, and the extraction-health
 * gate still stops a run whose fields go blank.
 *
 * A classic content script, like parse.js: it publishes itself on globalThis
 * so the adapters (and the Node tests) can reach it.
 */
(() => {
  'use strict';

  const STORE_KEY = 'mls.heal';
  const MAX_TEXT = 60;
  const MAX_CANDIDATES = 4000;

  /**
   * Similarity of two strings or two arrays, 0–1.
   *
   * 2·LCS / (|a| + |b|) — the same measure difflib's SequenceMatcher gives
   * for most inputs, and cheap at the lengths compared here, which are
   * capped.
   */
  function ratio(a, b) {
    const x = Array.isArray(a) ? a : String(a || '');
    const y = Array.isArray(b) ? b : String(b || '');
    if (!x.length && !y.length) return 1;
    if (!x.length || !y.length) return 0;
    let prev = new Array(y.length + 1).fill(0);
    for (let i = 1; i <= x.length; i += 1) {
      const row = new Array(y.length + 1).fill(0);
      for (let j = 1; j <= y.length; j += 1) {
        row[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
      }
      prev = row;
    }
    return (2 * prev[y.length]) / (x.length + y.length);
  }

  /** Two attribute maps, half on the names and half on the values. */
  function dictRatio(a, b) {
    const ka = Object.keys(a || {}).sort();
    const kb = Object.keys(b || {}).sort();
    return ratio(ka, kb) * 0.5 + ratio(ka.map((k) => a[k]), kb.map((k) => b[k])) * 0.5;
  }

  const clipText = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

  function attrsOf(el) {
    const out = {};
    for (const attr of el.attributes || []) {
      // Inline styles and generated ids change on every render and say
      // nothing about what the element is.
      if (attr.name === 'style' || /^(data-)?(jsan|jslog|ved)$/.test(attr.name)) continue;
      out[attr.name] = clipText(attr.value);
    }
    return out;
  }

  /** What an element looks like, in terms that survive a redesign. */
  function fingerprintOf(el) {
    if (!el || !el.tagName) return null;
    const parent = el.parentElement;
    const path = [];
    for (let node = el; node && node.tagName && path.length < 8; node = node.parentElement) {
      path.unshift(node.tagName.toLowerCase());
    }
    return {
      tag: el.tagName.toLowerCase(),
      attrs: attrsOf(el),
      text: clipText(el.textContent),
      path,
      parentTag: parent && parent.tagName ? parent.tagName.toLowerCase() : '',
      parentAttrs: parent ? attrsOf(parent) : {},
      siblings: parent ? [...parent.children].slice(0, 12).map((c) => c.tagName.toLowerCase()) : [],
    };
  }

  /**
   * How much a candidate looks like the remembered element, 0–100.
   *
   * The average of every check that applies, the way Scrapling scores it:
   * tag, text, the attribute map, each of the identifying attributes on its
   * own, the path from the root, the parent, and the siblings. `ignore` drops
   * checks that are meant to differ — every result link has its own href and
   * its own business name.
   */
  function score(original, candidate, { ignore = [] } = {}) {
    if (!original || !candidate) return 0;
    const skip = new Set(ignore);
    const strip = (attrs) => {
      const out = {};
      for (const [k, v] of Object.entries(attrs || {})) if (!skip.has(k)) out[k] = v;
      return out;
    };
    let total = 0;
    let checks = 0;
    const add = (value) => {
      total += value;
      checks += 1;
    };

    add(original.tag === candidate.tag ? 1 : 0);
    if (original.text && !skip.has('text')) add(ratio(original.text, candidate.text));
    add(dictRatio(strip(original.attrs), strip(candidate.attrs)));
    for (const key of ['class', 'id', 'role', 'aria-label', 'jsaction', 'href', 'data-item-id']) {
      if (skip.has(key) || !original.attrs || !original.attrs[key]) continue;
      add(ratio(original.attrs[key], (candidate.attrs || {})[key] || ''));
    }
    add(ratio(original.path, candidate.path));
    if (original.parentTag) {
      add(original.parentTag === candidate.parentTag ? 1 : 0);
      add(dictRatio(original.parentAttrs, candidate.parentAttrs));
    }
    if (original.siblings && original.siblings.length) add(ratio(original.siblings, candidate.siblings));
    return Math.round((total / checks) * 10000) / 100;
  }

  /**
   * The best candidate, if it clears the bar. Pure — candidates are
   * [{ fp, el }] — so the tests can drive it without a DOM.
   */
  function bestMatch(original, candidates, { threshold = 60, ignore = [] } = {}) {
    let best = null;
    for (const candidate of candidates || []) {
      const s = score(original, candidate.fp, { ignore });
      if (!best || s > best.score) best = { ...candidate, score: s };
    }
    return best && best.score >= threshold ? best : null;
  }

  /* --------------------------------------------------------------- memory */

  let memory = {};
  const healed = new Set();
  let loaded = null;
  let saveTimer = null;

  function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      try {
        const stored = await chrome.storage.local.get(STORE_KEY);
        memory = stored[STORE_KEY] || {};
      } catch {
        memory = {};
      }
    })();
    return loaded;
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [STORE_KEY]: memory });
      } catch {
        /* storage unavailable (tests) — memory still works for this page */
      }
    }, 500);
  }

  /** Remember a working element, at most once a day per name. */
  function remember(name, el) {
    const today = new Date().toISOString().slice(0, 10);
    if (!el || (memory[name] && memory[name].on === today)) return;
    const fp = fingerprintOf(el);
    if (!fp) return;
    memory[name] = { fp, on: today };
    persist();
  }

  function candidatesFor(fp, root) {
    const scope = root || document;
    return [...scope.querySelectorAll(fp.tag)].slice(0, MAX_CANDIDATES).map((el) => ({ el, fp: fingerprintOf(el) }));
  }

  /** Find `name` again from memory. Null when nothing is remembered or close enough. */
  function relocate(name, root, options = {}) {
    const saved = memory[name];
    if (!saved || !saved.fp) return null;
    const match = bestMatch(saved.fp, candidatesFor(saved.fp, root), options);
    if (!match) return null;
    healed.add(name);
    return match.el;
  }

  /**
   * querySelector, remembering what it found — or, when it finds nothing,
   * relocating from memory.
   */
  function pick(name, selector, root = document, options = {}) {
    const el = root ? root.querySelector(selector) : null;
    if (el) {
      remember(name, el);
      return el;
    }
    return root ? relocate(name, root, options) : null;
  }

  /**
   * querySelectorAll with the same fallback, for lists: relocate one member
   * from memory, then take everything shaped like it — same tag, same parent
   * and grandparent tags, most of the same attribute names. That is
   * Scrapling's `find_similar`, and it is how one remembered result link
   * finds the other hundred.
   */
  function pickAll(name, selector, root = document, options = {}) {
    const found = root ? [...root.querySelectorAll(selector)] : [];
    if (found.length) {
      remember(name, found[0]);
      return found;
    }
    const one = root ? relocate(name, root, { threshold: 55, ...options }) : null;
    if (!one) return [];
    return similarTo(one, root);
  }

  function similarTo(el, root) {
    const fp = fingerprintOf(el);
    const names = Object.keys(fp.attrs);
    const up = (node, n) => {
      let cur = node;
      for (let i = 0; i < n && cur; i += 1) cur = cur.parentElement;
      return cur && cur.tagName ? cur.tagName.toLowerCase() : '';
    };
    return [...(root || document).querySelectorAll(fp.tag)].filter((other) => {
      if (other === el) return true;
      if (up(other, 1) !== up(el, 1) || up(other, 2) !== up(el, 2)) return false;
      const theirs = Object.keys(attrsOf(other));
      const shared = names.filter((n) => theirs.includes(n)).length;
      return shared / Math.max(names.length, theirs.length, 1) >= 0.5;
    });
  }

  globalThis.MLSHeal = {
    ratio,
    dictRatio,
    score,
    bestMatch,
    fingerprintOf,
    load,
    remember,
    relocate,
    pick,
    pickAll,
    healedList: () => [...healed],
    /** Test hook. */
    _setMemory(next) {
      memory = next || {};
      healed.clear();
    },
  };

  try {
    load();
  } catch {
    /* not in an extension (tests) */
  }
})();
