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

**Segmented control, three up** — for how thorough. This was three stacked
cards, a hundred pixels each: a third of the panel spent on one setting that
has a good default. The three names sit on one row now, and the consequence of
whichever is chosen is written underneath — "Deep" on its own tells nobody it
means an hour.

**Disclosure** — everything with a working default. Five checkboxes behind
"More options" is not five fewer features; it is five fewer decisions before
the first run. The exception is a setting that has no default anywhere else:
"how many profiles" is the *only* thing bounding a LinkedIn run, which has no
grid, so on that source it comes out of the disclosure and takes the slot the
grid would have used. One slot, one question, whichever source is chosen.

**Stat tiles** — one row of four large numbers with small labels, ruled above
and below. This is the only place `--t-figure` is used, so progress is legible
from across a desk. As a 2×2 grid of bordered boxes they cost a third of the
screen to carry four numbers.

**Lead cards** — one card per result, three lines: name and its marker, then
the contact line, then the email and the category. This replaced a
six-column table, which in a 400px panel gave each column about 55px and
ellipsised every value on screen — a table you had to download before you
could read it. Reading down instead of across fits all of it. Phone, email and
a LinkedIn profile link are buttons that put themselves on the clipboard,
because that is what anyone does with a lead next.

**Callouts** — a left rule in the semantic colour, never a filled box. The
LinkedIn account-risk notice is `--warn` and sits directly above the Start
button, where the decision is actually made.

**The planner panel** — a plain hairline card *below* the fields it helps you
fill in, folded shut until it can do something. The first version had this
backwards: tinted in `--accent-soft`, three hundred pixels tall, and sitting
above the two fields that actually run a search, which made the optional
helper the loudest and tallest thing in the panel. Without an API key it can
do nothing, so it starts folded and its summary is the whole offer; once a key
is there it opens by default, and whichever state the user puts it in is
remembered and never overridden again.

**The action bar** — one row pinned below the pane, carrying that view's single
action: Start on the search side, Download on the results side. See below.

**The filter chip** — a `--warn` pill in the action bar, shown only when the
narrowing filter holds a term, and clicking it clears the term. It rides beside
the button whose meaning it changes.

---

## The planner is a proposal, never a decision

A model suggesting searches is an assistant. A model *starting* searches is a
system that spends an hour of someone's afternoon on a guess.

So the plan arrives as tick-boxes with its reasoning next to each line, and it
lands in the batch box — the same editable text the user could have typed —
rather than going straight to the queue. Three separate moments to say no:
untick a line, edit the text, don't press Start.

Every proposal shows **why** it is there ("They resell to hundreds of smaller
buyers"). A list of eight searches with no reasoning cannot be judged, only
accepted; the reasons are what make unticking possible.

When one missing fact would change every search, it asks one question rather
than filling the box with plausible guesses. "I need suppliers" gets "suppliers
of what?", not eight searches for the wrong thing.

---

## The four states

The form and the run never share the screen. While a scrape is going, the
settings that started it are not what the user needs.

| State | What is on screen | Primary action |
| --- | --- | --- |
| **Idle** | Source, the search, how much, disclosure | **Start** |
| **Running** | Spinner, which search, progress, live counts, latest arrivals | **Stop** |
| **Paused** | Why it stopped, what was collected so far | **Resume** |
| **Finished** | Counts, what was found per field | **See results** |
| **Results** | Virtualised lead cards, filter | **Download** |
| **Results, empty** | The mark, one line, a way back | **Go to search** |

The status chip in the masthead reports the run *on screen*. When a run has
been left behind — dismissed, or finished before a restart — the chip goes with
it: "Done" over an empty form reads as this search having finished, which is
the opposite of true.

One primary action per state is enforced in code, not by convention: Resume and
See results share the bar, and only the one that answers the current question
carries `--action`.

Every one of these lives in the action bar, so none of them can be scrolled
away from. Resume was on the form once, and a paused run hides the form — the
only button that mattered was unreachable exactly when it was needed. The bar
makes that class of bug structurally impossible.

**A run has to keep proving it is alive.** Twenty-five minutes of a spinner and
four numbers that tick is indistinguishable from a hang, and the rest of that
screen was empty. So the run says which search it is on — "Search 4 of 10 ·
dentists, Chennai" — and lists the last few names to arrive, each one fading in
as it lands.

**A finished run stops owning the screen once the extension restarts.** The
run view is for a run you are watching; after a reload you are not watching it
any more, and the form is what you need. Three reloads in a row showed the
same dead run's error, which reads as the reload having done nothing. The rows
stay in Results and the tab count is the way back to them. A *paused* run is
the exception — it is unfinished, and Resume lives in the run view.

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
| Generate search queries with AI | Not sure what to search for? |
| Invalid API key (401) | That API key was rejected. Check it in More options. |
| 1 searches failed | *the actual reason the search failed* |

## The action never scrolls away

The form was 1,050px of controls in a 760px panel, so opening LeadMine showed
no way to start anything: **Start** was three hundred pixels below the fold, at
the end of a form most people had not finished reading. Every other view had
the same shape — the buttons that end a run were at the bottom of the run view,
and Download was above a table that pushed it off screen.

So the bar comes out of the panes and is pinned under them, and it carries
exactly one question: *what do I do now?* Only the answers that apply are in
it — Start belongs to the form, Stop to a run, New search and See results to a
finished one, Download to the results view. One primary at a time, in the same
place every time.

Two things follow from this. The form no longer has to fit above a button, so
it can be as long as it needs to be; and the filter chip has somewhere to live
where it cannot scroll out of sight.

---

## A finished run hands over

A run exists for the rows it produced. Reaching them used to mean noticing a
tab and clicking it, so the panel now switches to Results on the
running → done edge — once, on the transition, never on a later poll, and
never over a run the user has already dismissed.

---

## One scroller per view

The panel is a flex column: masthead, tabs, then the pane, which is the only
thing that scrolls. Two scrollbars appeared once and the cause is worth
recording, because the CSS looked correct: the visually-hidden inputs behind
the segmented control and the choice cards are `position: absolute`, and with
no positioned ancestor they resolve against the *initial containing block* —
so they sat outside the pane's scroller, at their static position near the foot
of the form, and stretched the page behind it to the form's full height.

Any control that hides a real input under a styled label must be
`position: relative`, and the pane is too. A test asserts exactly one
scrollable element per view.

---

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
