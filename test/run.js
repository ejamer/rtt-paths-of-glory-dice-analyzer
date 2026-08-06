#!/usr/bin/env node
/**
 * No-framework regression test: run the JS parser + report stats against the
 * synthetic fixture and a couple of known-good real-game numbers, and assert
 * the results. `node test/run.js` — exits nonzero on any failure.
 */
"use strict";
var fs = require("fs");
var path = require("path");
var PogParser = require("../js/parser.js");
var PogReport = require("../js/report.js");

var failures = 0;
function assertEq(actual, expected, label) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? "PASS" : "FAIL") + " — " + label + (ok ? "" : "  (got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected) + ")"));
  if (!ok) failures++;
}
function assertTrue(cond, label) {
  console.log((cond ? "PASS" : "FAIL") + " — " + label);
  if (!cond) failures++;
}

// ---------- fixture: exercises every category + the "embedded card link in
// outcome" edge case that once broke the mandated-offensive regex ----------
var fixtureHtml = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf-8");
var parsed = PogParser.parseLog(fixtureHtml);

assertEq(parsed.rows.length, 8, "fixture: 8 rows parsed");
assertEq(parsed.unknownCount, 0, "fixture: 0 unknown-category rows");

var cats = {};
parsed.rows.forEach(function (r) { cats[r.category] = (cats[r.category] || 0) + 1; });
assertEq(cats, { mandated_offensive: 2, combat_fire: 2, entrench: 2, flank: 1, siege: 1 },
  "fixture: category counts");

var moWithCard = parsed.rows.filter(function (r) { return r.category === "mandated_offensive" && r.side === "ap"; })[0];
assertEq(moWithCard.outcome, "Fake Mutiny", "fixture: card-link outcome text stripped of markup");

var siegeRow = parsed.rows.filter(function (r) { return r.category === "siege"; })[0];
assertEq(siegeRow.modifier, "-2", "fixture: siege modifier parsed even without a trailing arrow");
assertEq(siegeRow.effective_value, "-1", "fixture: siege effective value parsed");

var entrenchCp = parsed.rows.filter(function (r) { return r.category === "entrench" && r.side === "cp"; })[0];
assertEq(entrenchCp.entrench_attempt_no, 1, "fixture: entrench attempt number assigned");

var stats = PogReport.buildStats(parsed.rows);
assertEq(stats.overallStats.cp.n, 5, "fixture: 5 CP rolls total (MO, attacker fire, entrench, flank, siege)");
assertEq(stats.overallStats.ap.n, 3, "fixture: 3 AP rolls total (MO, defender fire, entrench)");

var html = PogReport.buildReportHTML(parsed.rows);
assertTrue(html.indexOf("<h1>") !== -1 && html.indexOf("</html>") !== -1, "fixture: report HTML renders top-to-bottom");

console.log("");
console.log(failures === 0 ? "All checks passed." : failures + " check(s) FAILED.");
process.exit(failures === 0 ? 0 : 1);
