# Maps Lead Scraper

A Chrome extension (Manifest V3) that sweeps Google Maps for every business in a
given **city + category** and exports the listings as a CSV you can download.

## What you get per listing

| Column | Source |
| --- | --- |
| Name, Category, Rating, Reviews | Maps listing panel |
| Phone | Maps listing panel |
| Address, Area, Plus code | Maps listing panel (Area is derived from the address) |
| Website | Maps listing panel |
| **Email** | **Not on Maps** — fetched from the business website, when it has one |
| Maps URL, Search query | Recorded so every row is traceable |

### About the email column

Google Business Profile has no email field. Nothing on a Maps listing contains an
email address, no matter how completely the owner filled the profile in. The only
way to get one is to follow the listing's **website** link and read the address off
that site's pages, which is what the optional "look for emails" pass does:

1. Fetch the website homepage, look for `mailto:` links and plain-text addresses.
2. If none, follow up to three `contact` / `about` / `enquiry` links and try those.

Realistically that yields an email for roughly a third of listings. Businesses with
no website — common for small local shops — can never produce one.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `maps-scraper` folder.

## Use

1. Click the extension icon.
2. Enter a category (`clothing shop`) and a city (`Coimbatore`).
3. Optionally tick email lookup, and open **Coverage settings** to widen the sweep.
4. Click **Start**, and leave Chrome open — the extension drives a background tab.
5. When it finishes, click **Download CSV**.

You can **Stop** at any time; whatever has been collected so far is kept and stays
downloadable.

## How the coverage grid works

Google returns at most ~120 results for one search, so a single query can never
return "every clothing shop in the city". The extension instead runs the same
search from a grid of map centres and merges the results, de-duplicating on
Google's internal place id.

- **Grid size** — 3 means a 3×3 grid, so 9 searches. 5 means 25.
- **Tile size** — the spacing between grid centres in km. 3×3 grid × 3 km covers
  roughly 9 km across.
- **Zoom** — lower zoom pulls a wider area per search but returns coarser results.

A dense city centre needs a larger grid with smaller tiles; a small town is fine
with 1×1.

## Limits and things worth knowing

- **This scrapes the Maps UI, which is against Google's Terms of Service.** Expect
  CAPTCHAs and temporary rate limiting on large runs, and note the extension
  cannot be published to the Chrome Web Store. It is intended to be loaded
  unpacked, for your own use.
- **Google changes its markup.** The extractor uses the most stable hooks
  available (`data-item-id="address"`, `phone:tel:`, `authority`) but a Maps
  redesign can still break it, in which case the selectors in
  `lib/injected.js` need updating.
- **Pace.** Deliberate pauses sit between every search and listing to stay
  unremarkable. A 200-listing run takes roughly 10–15 minutes, more with email
  lookup.
- **The sanctioned alternative** is the Google Places API: paid, stable, no
  CAPTCHAs, no ToS problem — and still no email field.
- **If you use the output for outreach**, scraped business contacts fall under
  GDPR / CAN-SPAM / India's DPDP Act depending on where you and they are.

## Layout

```
manifest.json      permissions and entry points
background.js      orchestrates the run: grid sweep, listing reads, email pass
popup.html/.js     the UI, progress polling and CSV download
lib/injected.js    the functions injected into the Maps tab
lib/email.js       website fetch and email extraction
lib/csv.js         CSV columns and escaping
```
