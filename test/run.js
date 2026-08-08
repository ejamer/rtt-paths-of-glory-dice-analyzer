#!/usr/bin/env node
/**
 * No-framework regression test: run the JS parser + report stats + schema
 * builder against the synthetic fixture and a couple of known-good real-game
 * numbers, and assert the results. `node test/run.js` — exits nonzero on
 * any failure.
 */
"use strict";
var fs = require("fs");
var path = require("path");
var PogParser = require("../js/parser.js");
var PogReport = require("../js/report.js");
var PogTables = require("../js/tables.js");
var PogSchema = require("../js/schema.js");

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
// outcome" edge case that once broke the mandated-offensive regex, plus
// retreat/flank-modifier/entrench-nationality/siege-outcome/meta parsing ----------
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
assertEq(siegeRow.target_cf, 1, "fixture: siege target CF captured");
assertEq(siegeRow.outcome, "Fail", "fixture: siege outcome now captured from the separate 'Fort holds' line");

var flankRow = parsed.rows.filter(function (r) { return r.category === "flank"; })[0];
assertEq(flankRow.modifier, "+1", "fixture: flank modifier captured from the '+1 <space>' line");

var entrenchAp = parsed.rows.filter(function (r) { return r.category === "entrench" && r.side === "ap"; })[0];
var entrenchCp = parsed.rows.filter(function (r) { return r.category === "entrench" && r.side === "cp"; })[0];
assertEq(entrenchAp.nationality, "FR", "fixture: entrench nationality captured (AP)");
assertEq(entrenchCp.nationality, "GE", "fixture: entrench nationality captured (CP)");
assertEq(entrenchCp.entrench_attempt_no, 1, "fixture: entrench attempt number assigned");

// ---------- fixture: combined move-and-entrench action — two units of different
// nationalities each declare "entrench" (interleaved with unrelated move context) before
// either "Entrench attempt in <space>" line appears, and the two attempts resolve in the
// REVERSE of declaration order. Naive FIFO pairing would swap the nationalities; matching
// each attempt to its declaration by the "Moved from <space>" origin gets it right. ----------
var combinedEntrenchHtml = fs.readFileSync(path.join(__dirname, "fixture-combined-entrench.html"), "utf-8");
var combinedParsed = PogParser.parseLog(combinedEntrenchHtml);
var combinedEntrenchRows = combinedParsed.rows.filter(function (r) { return r.category === "entrench"; });
assertEq(combinedEntrenchRows.length, 2, "combined entrench: 2 attempts parsed");
assertEq(combinedEntrenchRows.filter(function (r) { return !r.nationality; }).length, 0,
  "combined entrench: no attempt left without a nationality");
var spaceANat = combinedEntrenchRows.filter(function (r) { return r.space === "SpaceA"; })[0].nationality;
var spaceBNat = combinedEntrenchRows.filter(function (r) { return r.space === "SpaceB"; })[0].nationality;
assertEq(spaceANat, "GE", "combined entrench: SpaceA attempt matched to GE 5 by origin space, not declaration order");
assertEq(spaceBNat, "AH", "combined entrench: SpaceB attempt matched to AH 2 by origin space, not declaration order");

var combatFireRows = parsed.rows.filter(function (r) { return r.category === "combat_fire"; });
var combatFireRow = combatFireRows[0], defenderFireRow = combatFireRows[1];
assertEq(combatFireRow.force_type, "Army", "fixture: combat force type (Army/Corps) preserved on the row");
assertEq(combatFireRow.column_shift, -1, "fixture: attacker's '1L for Trenches' column shift captured (-1)");
assertEq(combatFireRow.shift_reasons, "1L for Trenches", "fixture: column shift reason text captured");
assertEq(defenderFireRow.die_modifier, 1, "fixture: defender's '+1 Fake Flamethrowers' die modifier captured");
assertEq(defenderFireRow.die_modifier_reasons, "+1 Fake Flamethrowers", "fixture: die modifier reason text captured");

assertEq(parsed.meta, { gameId: "999", apPlayer: "FakeAP", cpPlayer: "FakeCP" }, "fixture: game metadata parsed from URL comment + chat log");

assertEq(parsed.combats.length, 1, "fixture: one combat assembled");
var combat = parsed.combats[0];
assertEq(combat.actual, { attacker_value: 7, defender_value: 2, winner: "attacker" }, "fixture: combat victory line parsed");
assertEq(combat.retreat, { forced: true, canceled: false }, "fixture: forced retreat captured on the combat");
assertEq(combat.flank_attempt, null, "fixture: this combat had no flank attempt of its own (the flank row belongs to the later entrench action)");
assertEq(combat.attacker.column_shift, -1, "fixture: combat's attacker carries the same column shift");
assertEq(combat.defender.die_modifier, 1, "fixture: combat's defender carries the same die modifier");

var stats = PogReport.buildStats(parsed.rows, parsed.combats);
assertEq(stats.overallStats.cp.n, 5, "fixture: 5 CP rolls total (MO, attacker fire, entrench, flank, siege)");
assertEq(stats.overallStats.ap.n, 3, "fixture: 3 AP rolls total (MO, defender fire, entrench)");
assertEq(stats.winTally.cp, { win: 1, tie: 0, loss: 0 }, "fixture: win tally now sourced from the victory-line text");
assertEq(stats.retreatBySide.ap, { forced1: 0, forced2: 1, canceled: 0 },
  "fixture: retreat tallied against the losing (defending) side, length = clamp(loss margin, 0, 2)");
assertEq(stats.flankBySideMod.cp["+1"], [1, 1], "fixture: flank success rate broken out by modifier level");

var html = PogReport.buildReportHTML(parsed.rows, parsed.combats, parsed.meta);
assertTrue(html.indexOf("<h1>") !== -1 && html.indexOf("</html>") !== -1, "fixture: report HTML renders top-to-bottom");
["About This Report", "Combat", "Entrench", "Siege", "Mandated Offensive"].forEach(function (section) {
  assertTrue(html.indexOf("<h2>" + section) !== -1 || html.indexOf(">" + section + "<") !== -1 || html.indexOf(section) !== -1,
    "fixture: report includes the " + section + " section");
});

// ---------- js/tables.js: exercises the CRT lookups the report/schema rely on ----------
assertEq(PogTables.expectedLosses("Army", 10), 4.5, "tables: expected losses = avg(fireResult(die3), fireResult(die4)) for Army CF=10");
assertEq(PogTables.expectedLosses("Army", 10, -1), 4, "tables: a -1 (1L) column shift moves the lookup to CF 10's neighboring (weaker) column");
assertEq(PogTables.shiftedColumn("Corps", 1, -5), 0, "tables: column shift clamps at the table's low edge, doesn't go negative");
assertEq(PogTables.expectedLosses("Army", 10, 0, 1), 5, "tables: a +1 die modifier shifts the lookup row (die 3->4, 4->5) for CF 10");
assertEq(PogTables.fireResult("Army", 5, 6, 0, 5), 5, "tables: die+modifier clamps at row 6, doesn't overflow the table");
assertEq(PogTables.entrenchTarget("GE"), 3, "tables: entrench target for GE (Army Loss Factor)");
assertEq(PogTables.entrenchTarget("ZZ"), null, "tables: unknown nationality returns null, not a crash");

// ---------- js/schema.js: the nested JSON export ----------
var json = PogSchema.buildGameJSON(parsed);
assertEq(json.game_metadata, { game_id: "999", ap_player: "FakeAP", cp_player: "FakeCP" }, "schema: game_metadata");
assertEq(json.all_cp_rolls.length, 5, "schema: all_cp_rolls flat array");
assertEq(json.combat_results.length, 1, "schema: one combat_results entry");
assertEq(json.combat_results[0].loss_ratio, "7:2", "schema: loss_ratio from the victory line");
assertEq(json.combat_results[0].actual_combat_winner, "CP", "schema: actual_combat_winner");
assertEq(json.combat_results[0].retreat, { forced: true, canceled: false }, "schema: retreat counts, not a distance");
assertEq(json.entrench_rolls.entrench_attempt_1.attempting_faction, "AP", "schema: entrench_attempt_1 faction");
assertEq(json.entrench_rolls.entrench_attempt_1.target, 3, "schema: entrench_attempt_1 target (FR loss factor)");
assertEq(json.combat_results[0].attacker_details.column_modifier, "1L for Trenches", "schema: column_modifier populated from the captured shift");
assertEq(json.combat_results[0].defender_details.die_modifier, "+1 Fake Flamethrowers", "schema: die_modifier populated from the captured roll bonus");
assertEq(json.siege_rolls.siege_attempt_1.result, "fail", "schema: siege_attempt_1 result now populated");
assertEq(json.mandated_offense_rolls.turn_1.cp_result, "None", "schema: mandated_offense_rolls turn_1 cp_result");

var jsonText = PogSchema.stringifyGameJSON(json);
assertEq(JSON.parse(jsonText), json, "schema: stringifyGameJSON round-trips to the same data as buildGameJSON");
assertTrue(/"all_cp_rolls": \[[\d, ]+\]/.test(jsonText), "schema: all_cp_rolls rendered on one line, not one number per line");
assertTrue(/"combat_results": \[\n\s+\{/.test(jsonText), "schema: combat_results (array of objects) still multi-line");

console.log("");
console.log(failures === 0 ? "All checks passed." : failures + " check(s) FAILED.");
process.exit(failures === 0 ? 0 : 1);
