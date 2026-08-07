# Paths of Glory — Dice Analyzer

**🔗 https://ejamer.github.io/rtt-paths-of-glory-dice-analyzer/**

A static, no-backend web page that turns a saved *Paths of Glory* game log
(from [Rally the Troops](https://rally-the-troops.com/)) into a dice-roll
analysis — average rolls per side, distribution vs. a fair d6, trends over
time, and a breakdown by roll type (combat fire, entrench, flank, siege,
mandated offensive).

Nothing you upload is ever transmitted anywhere — there's no server
component and no `fetch`/`XMLHttpRequest` calls; the file you drop is read
and parsed entirely client-side. Rally requires login to view most games,
so this tool can't fetch one for you: save the page yourself while logged
in, then upload that file here.

## Using it

1. Open the game on Rally the Troops while logged in.
2. Save the page as **Webpage, Complete** (Chrome: File → Save Page As →
   format dropdown → "Webpage, Complete"). This is the only save option that
   works — "HTML Only" and "Single File" don't capture the rendered log (see
   the comment above the drop zone in `index.html` for why).
3. Drop the resulting `.htm` file onto the page (the `<pagename>_files/`
   folder saved alongside it is never read — safe to ignore).
4. View the report inline, or download the raw parsed data as JSON, or a
   standalone copy of the report HTML.

## How it's built

Zero dependencies, zero build step — plain `<script>` tags, no bundler, no
framework:

- `js/parser.js` — turns the log HTML into an array of per-roll row objects
  (turn, action, side, category, role, space, raw value, modifier, effective
  value, outcome, plus force type/nationality/target CF where applicable)
  and a `combats` array that groups each combat's attacker/defender fire,
  flank attempt, victory-line result, and retreat into one record.
  Classifies every `<span class="die {ap|cp} d{1-6}">` into one of five
  categories from the surrounding trigger text.
- `js/tables.js` — the Corps/Army Fire Tables, Army Loss Factors, and
  Mandated Offensive tables from `methodology.md`, plus the lookup helpers
  (expected losses, entrench target) built on them.
- `js/report.js` — computes the stats (means, chi-square uniformity check,
  combat win/loss tally, expected-vs-actual outcomes, retreats, per-category
  success-rate breakdowns, per-turn + rolling trend) and renders a
  self-contained report as an HTML string, with hand-built inline SVG charts
  (no charting library).
- `js/schema.js` — the same parsed data reshaped into the nested per-event
  JSON export described in `methodology.md` (game metadata, combat results,
  entrench/siege/mandated-offensive rolls).
- `js/app.js` — the only browser-specific file: wires up the upload/drop
  zone, renders the report into an `<iframe srcdoc>`, and the two download
  buttons (JSON, report HTML).

`parser.js`, `report.js`, `tables.js`, and `schema.js` are UMD-style
(`module.exports` under Node, `window.Pog*` in a browser), so the exact same
code that runs on the page also runs under the test suite.

This is a browser port of a local Python pipeline (`parse_dice.py` /
`build_report.py`) that does the same thing from the command line — the two
are kept in sync by hand, since there's no shared source of truth. If you
fix a parsing bug in one, check whether the other needs it too (see
`test/run.js`, which exists specifically to catch that kind of drift).

## Testing

No framework — `node test/run.js` runs the parser and report-stats code
against a small synthetic fixture (`test/fixture.html`, entirely made-up
game data) covering all five roll categories plus a couple of edge cases
that have broken this parser before (a mandated-offensive roll whose
outcome text contains a card link instead of plain text; a siege roll
whose modifier/result use a Unicode minus sign `−` rather than an ASCII
hyphen). Run it after any change to `js/parser.js`, `js/report.js`,
`js/tables.js`, or `js/schema.js`.

## Deploying

Static site, no build step — GitHub Pages serves it directly from `main`
(Settings → Pages → Deploy from branch → `main` / `/ (root)`).
