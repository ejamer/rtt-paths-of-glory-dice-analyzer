# Paths of Glory — Dice Analyzer

**🔗 Live site: https://ejamer.github.io/rtt-paths-of-glory-dice-analyzer/**
*(GitHub Pages hasn't successfully deployed yet as of this writing — link is here regardless so it's easy to find/bookmark once it is.)*

A static, no-backend web page that turns a saved *Paths of Glory* game log
(from [Rally the Troops](https://rally-the-troops.com/)) into a dice-roll
analysis — average rolls per side, distribution vs. a fair d6, trends over
time, and a breakdown by roll type (combat fire, entrench, flank, siege,
mandated offensive).

**Nothing you upload is ever transmitted anywhere.** The page has no server
component — it's plain HTML/CSS/JS, and the file you pick is read and parsed
entirely client-side (`FileReader`, no `fetch`/`XMLHttpRequest` calls at
all). That's a deliberate design choice, not just a privacy nicety: Rally
requires login to view most games, and this tool has no way to (and won't
try to) fetch a game on your behalf — you save the page yourself while
logged in, and upload that file here.

## Using it

1. Open the game on Rally the Troops while logged in.
2. Save the page as **"Webpage, Complete"** (in Chrome: File → Save Page As →
   format dropdown → "Webpage, Complete"). This matters — see below.
3. Drop the resulting `.htm` file onto the page (you can ignore the
   `<pagename>_files/` folder saved alongside it; the tool never reads it).
4. View the report inline, or download the cleaned CSV / a standalone copy
   of the report HTML.

**"Webpage, Complete" is the only save option that actually works, and this
was confirmed by testing all three** against the real parser, not assumed:

| Save option | Extension | Works? | Why |
|---|---|---|---|
| Webpage, HTML Only | `.html` | ❌ | Saves the raw HTML the server sends *before* the page's JavaScript runs — `<div id="log">` is present but empty, since the log is rendered client-side after load. Same problem with plain "View Page Source." |
| **Webpage, Complete** | `.htm` | ✅ | Captures the live DOM *after* JavaScript has rendered it — this is the one with actual game data in it. |
| Webpage, Single File | `.mhtml` | ❌ | MHTML is a MIME-wrapped format (quoted-printable/base64 inside email-style headers), not plain HTML — the parser doesn't unwrap it. |

The parser locates and extracts just the `<div id="log">...</div>` portion of
whatever you give it, since that's the only place a die roll ever appears —
so a full "Complete" page save works fine as input, no manual trimming needed.

## How it's built

Zero dependencies, zero build step — plain `<script>` tags, no bundler, no
framework:

- `js/parser.js` — turns the log HTML into an array of per-roll row objects
  (turn, action, side, category, role, space, raw value, modifier, effective
  value, outcome). Classifies every `<span class="die {ap|cp} d{1-6}">` into
  one of five categories from the surrounding trigger text.
- `js/report.js` — computes the stats (means, chi-square uniformity check,
  combat win/loss tally, entrench success by modifier, per-turn + rolling
  trend) and renders a self-contained report as an HTML string, with
  hand-built inline SVG charts (no charting library).
- `js/csv.js` — the same row objects as a downloadable CSV.
- `js/app.js` — the only browser-specific file: wires up the upload/drop
  zone, renders the report into an `<iframe srcdoc>`, and the two download
  buttons.

`parser.js` and `report.js` are written UMD-style (`module.exports` under
Node, `window.PogParser`/`window.PogReport` in a browser) so the exact same
code that runs on the page also runs under the test suite.

This is a browser port of a local Python pipeline
(`parse_dice.py` / `build_report.py`) that does the same thing from the
command line — **the two are kept in sync by hand**, since there's no
shared source of truth. If you fix a parsing bug in one, check whether the
other needs the same fix (see `test/run.js`, which exists specifically to
catch that kind of drift).

## Testing

No framework — `node test/run.js` runs the parser and report-stats code
against a small synthetic fixture (`test/fixture.html`, entirely made-up
game data, safe to commit) covering all five roll categories plus a couple
of edge cases that have broken this parser before (a mandated-offensive
roll whose outcome text contains a card link instead of plain text; a
siege roll whose modifier/result use a Unicode minus sign `−` rather than
an ASCII hyphen). Run it after any change to `js/parser.js` or
`js/report.js`.

## Deploying

Static site, no build step — GitHub Pages serves it directly from `main`
(Settings → Pages → Deploy from branch → `main` / `/ (root)`).
