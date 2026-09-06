# DESIGN.md

How this extension should look and behave. Every value below exists as a token
in `src/panel/tokens.css` — change it there, not in a component.

Built against the design skills in
[owl-listener/designer-skills](https://github.com/owl-listener/designer-skills),
in the DESIGN.md format from
[voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md).

---

## The problem this design solves

The first version put thirteen controls on one screen — two selects, three text
fields, five checkboxes — in seven different font sizes, fifteen of eighteen
declarations at 12px or smaller. Nothing looked more important than anything
else, and starting a search meant reading all of it first.

Three rules fixed that, and every decision below follows from them:

1. **One primary action per view.** If two things compete, one of them is wrong.
2. **Anything with a sensible default is disclosed, not displayed.**
3. **Name the outcome, not the mechanism.** "~600 results · about 25 minutes",
   not "Coverage: balanced — 9 cells".

---

## The name

Two names, one product. `LeadMine` is the brand: short, spellable, and it
carries "lead" — the word people actually type. The manifest's `name` is the
full store title, `LeadMine — Google Maps & LinkedIn Lead Scraper`, because
that string is what the Chrome Web Store indexes; `short_name` is the brand
alone, for the places Chrome has no room.

The UI only ever says LeadMine. Keyword tails belong in a store listing, not
in a header the user reads forty times a day.

## The mark

A horseshoe magnet with three points being drawn into it. "Lead magnet" is
already the term for the thing that pulls prospects in, so the mark says what
the product does using a word its users have.

The poles are cut out of the arms rather than painted on, so the tile gradient
shows through and the magnet reads two-tone the way a real one does. The points
above it fade out at small sizes; the magnet does not, and that is the test —
at 16px it is still unmistakably a magnet.

`icons/logo.svg` is the source; `npm run icons` renders the PNG sizes Chrome
needs through Chromium, so the mark gets real anti-aliasing, masking and
gradients rather than a hand-rolled rasteriser's approximation.

Two earlier marks were drawn and thrown away: a pin cut into rows, which
flattened until it stopped reading as a pin, and a pin whose hole was a sheet,
which was clean but said nothing a hundred other tools do not. The rule that
survived both is that a mark has to still work at 16px and still mean
something there.

## Colour

Colour has three jobs here and only three. It took a rewrite to get to that.

The first version painted the accent on everything with a job — the primary
button, the progress bar, the selected card, the count badge, the active tab.
An accent used everywhere is not an accent. Raycast's primary button is plain
white; Linear's colour lives on the mark, the focus ring and almost nothing
else.

| Job | What does it | Why |
| --- | --- | --- |
| **The primary action** | `--action`: near-black on light, white on dark | Prominence comes from contrast, not hue. There is one per view, so it does not need a colour to be found |
| **Selection and identity** | `--accent`, at 10–14% as a tint | The mark, the focus ring, the chosen coverage card, the checked option |
| **Status** | `--ok` `--warn` `--danger`, each with a soft tint | The only place a hue carries meaning, so it is the only place a hue appears |

Surfaces are layered — `--canvas`, `--surface`, `--surface-2`, `--elevated` —
rather than two flat greys, and hairlines are alpha rather than a fixed grey,
so a border sits correctly on whatever is beneath it in either theme.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--canvas` | `#ffffff` | `#0b0c0e` | The page |
| `--surface` | `#fafafb` | `#121316` | Table headers, callouts |
| `--action` | `#14161c` | `#f4f5f7` | The one button that matters |
| `--accent` | `#5460d8` | `#8b95ff` | Mark, focus, selection |
| `--hairline` | `rgba(12,14,20,.09)` | `rgba(255,255,255,.08)` | Dividers |

Stat tiles are outlined rather than filled: four grey blocks read heavier than
the numbers they carry, which is backwards.

## Type

Five sizes, not nine. The panel is 400px wide, so body sits at 14px rather than
the 16px a full page would take — a deliberate deviation, made once, applied
everywhere.

| Token | Size | Weight | Used for |
| --- | --- | --- | --- |
| `--t-figure` | 24px | 600 | The numbers on stat tiles |
| `--t-title` | 15px | 600 | View titles, product name |
| `--t-body` | 14px | 400/500 | Inputs, buttons, choices, most copy |
| `--t-label` | 13px | 500 | Field labels, disclosure summaries |
| `--t-small` | 12px | 400 | Helper text, captions, table cells |

Two faces, not one. The UI face carries labels, prose and business names —
things that get read. A mono face carries phone numbers, emails, ratings and
counts, because those are machine values and a column of them set in a
proportional face cannot be scanned down. Everything numeric also sets
`font-variant-numeric: tabular-nums`, so figures do not jitter as a run
progresses.

## Motion

Four durations and three curves, as tokens — enough for this surface, and few
enough that no component invents its own.

| Token | Value | Use |
| --- | --- | --- |
| `--t-fast` | 120ms | Hover, focus, press |
| `--t-normal` | 200ms | Showing and hiding, view changes |
| `--t-slow` | 320ms | Progress, layout-affecting change |
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` | Most transitions |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Entering |
| `--ease-linear` | `linear` | Loops only — the spinner, the indeterminate bar |

Motion is confirmation, never decoration: a button press moves 1px, a view
fades and rises 3px. `prefers-reduced-motion` is handled once, at the system
level, not per component.

## Space

A 4px scale: `4 · 8 · 12 · 16 · 24 · 32`. Nothing off-scale. Panel padding and
the gap between form fields are both `--s-4` (16px), which is what gives the
column its rhythm.

## Shape

`6px` on small controls, `8px` on inputs and buttons, `12px` on containers,
pill on badges. Focus is always a 3px accent-tinted ring, never a border swap
that shifts layout.

---

## Components

**Segmented control** — for exactly two options (the source). Cheaper to read
than a select: both choices are visible without opening anything.

**Choice cards** — for three options with consequences (how thorough). Each
card names the outcome and its cost in time. A select would hide two of the
three and make the user open it to compare.

**Disclosure** — everything with a working default. Five checkboxes behind
"More options" is not five fewer features; it is five fewer decisions before
the first run.

**Stat tiles** — a 2×2 grid of large numbers with small labels. This is the
only place `--t-figure` is used, so progress is legible from across a desk.

**Callouts** — a left rule in the semantic colour, never a filled box. The
LinkedIn account-risk notice is `--warn` and sits directly above the Start
button, where the decision is actually made.

---

## The four states

The form and the run never share the screen. While a scrape is going, the
settings that started it are not what the user needs.

| State | What is on screen | Primary action |
| --- | --- | --- |
| **Idle** | Source, the search, how thorough, disclosure | **Start** |
| **Running** | Spinner, what it is doing now, progress, live counts | **Stop** |
| **Paused** | Why it stopped, what was collected so far | **Resume** |
| **Finished** | Counts, what was found per field | **See results** |
| **Results** | Virtualised table, filter | **Download** |
| **Results, empty** | The mark, one line, a way back | **Go to search** |

One primary action per state is enforced in code, not by convention: Resume and
See results share a row, and only the one that answers the current question is
indigo.

Resume lives in the run view, not on the form. It was on the form once, and a
paused run hides the form — so the only button that mattered was unreachable
exactly when it was needed.

The running state says what it is doing in words — "Opening each listing…",
"Looking for emails…" — not the internal phase name.

## Language

| Do not write | Write |
| --- | --- |
| Coverage: balanced — 9 cells | Balanced · ~600 results · about 25 minutes |
| Verify emails (MX lookup) | Check the emails are real |
| Skip businesses from earlier runs | Skip ones I've already downloaded |
| sendable | usable |
| Category / City | What are you looking for? / Where? |
| 1 searches failed | *the actual reason the search failed* |

## Accessibility

- Every field keeps a visible, persistent label — a placeholder is never the
  only label.
- The segmented control and choice cards are real radio groups; the visually
  hidden `<select>`s behind them stay authoritative so there is one source of
  truth for saved settings and tests.
- Focus is always visible, and `prefers-reduced-motion` disables the spinner
  and the indeterminate bar.
- Colour is never the only signal: an undeliverable email is struck through as
  well as red.
