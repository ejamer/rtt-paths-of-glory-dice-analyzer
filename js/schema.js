/**
 * Assemble the nested per-event JSON export described in methodology.md
 * (game_metadata, combat_results, entrench_rolls, siege_rolls,
 * mandated_offense_rolls) from parser.js's flat rows + combats + meta.
 * Uses js/tables.js for expected_losses_inflicted / expected_combat_winner
 * so the numbers can't drift from what the report shows.
 *
 * A few places fill in gaps or resolve ambiguity in the methodology.md
 * sketch rather than deviating from it outright:
 *   - combat_results is an array (one entry per combat) — the sketch's
 *     singular object was illustrative.
 *   - retreat is `{ forced, canceled }`, not a distance — see methodology.md.
 *   - siege_attempt_<#> includes attempting_faction (the besieging side),
 *     which the sketch's siege_rolls entry didn't list but the roll can't be
 *     interpreted without.
 *   - column_modifier and die_modifier are the net cumulative column shift
 *     (e.g. "1L for Swamp, 1L for Trenches") and net roll bonus (e.g. "+1
 *     Flamethrowers") the parser found between the fire header and its die
 *     — both already folded into expected_losses_inflicted /
 *     expected_combat_winner below. combat_cards is still [] — which cards
 *     were committed to a combat isn't captured, only ones that modified
 *     the roll or column.
 */
(function (root) {
  "use strict";

  var PogTables = (typeof module !== "undefined" && module.exports)
    ? require("./tables.js") : root.PogTables;

  function upper(side) { return side === "cp" ? "CP" : "AP"; }
  function successOrFail(outcome) { return /^success/i.test(String(outcome)) ? "success" : "fail"; }

  function combatDetails(role) {
    return {
      combat_cards: [],
      combat_factor: role.cf,
      column_modifier: (role.shift_reasons || []).join(", "),
      actual_roll: role.raw_value,
      die_modifier: (role.die_modifier_reasons || []).join(", "),
      expected_losses_inflicted: role.force_type ? PogTables.expectedLosses(role.force_type, role.cf, role.column_shift, role.die_modifier) : null,
      actual_losses_inflicted: role.effective_value === "" ? null : parseInt(role.effective_value, 10),
    };
  }

  function buildCombatResults(combats) {
    return combats.filter(function (c) { return c.actual; }).map(function (c) {
      var expAtt = c.attacker.force_type ? PogTables.expectedLosses(c.attacker.force_type, c.attacker.cf, c.attacker.column_shift, c.attacker.die_modifier) : null;
      var expDef = c.defender.force_type ? PogTables.expectedLosses(c.defender.force_type, c.defender.cf, c.defender.column_shift, c.defender.die_modifier) : null;
      var expectedWinner = (expAtt === null || expDef === null) ? null :
        (expAtt > expDef ? upper(c.attacker.side) : (expAtt < expDef ? upper(c.defender.side) : "Tie"));
      var actualWinner = c.actual.winner === "attacker" ? upper(c.attacker.side)
        : (c.actual.winner === "defender" ? upper(c.defender.side) : "Tie");
      return {
        location: c.location,
        attacker: upper(c.attacker.side),
        flank_attempt: c.flank_attempt ? {
          modifier: c.flank_attempt.modifier || "",
          actual_roll: c.flank_attempt.raw_value,
          result: successOrFail(c.flank_attempt.result),
        } : null,
        attacker_details: combatDetails(c.attacker),
        defender_details: combatDetails(c.defender),
        expected_combat_winner: expectedWinner,
        actual_combat_winner: actualWinner,
        loss_ratio: c.actual.attacker_value + ":" + c.actual.defender_value,
        retreat: c.retreat || { forced: false, canceled: false },
      };
    });
  }

  function buildEntrenchRolls(rows) {
    var entrenchRows = rows.filter(function (r) { return r.category === "entrench"; });
    var out = {
      ap_rolls: entrenchRows.filter(function (r) { return r.side === "ap"; }).map(function (r) { return r.raw_value; }),
      cp_rolls: entrenchRows.filter(function (r) { return r.side === "cp"; }).map(function (r) { return r.raw_value; }),
    };
    entrenchRows.forEach(function (r, i) {
      out["entrench_attempt_" + (i + 1)] = {
        attempting_faction: upper(r.side),
        location: r.space,
        modifier: r.modifier || "",
        target: r.nationality ? PogTables.entrenchTarget(r.nationality) : null,
        actual_roll: r.raw_value,
        result: successOrFail(r.outcome),
      };
    });
    return out;
  }

  function buildSiegeRolls(rows) {
    var siegeRows = rows.filter(function (r) { return r.category === "siege"; });
    var out = {};
    siegeRows.forEach(function (r, i) {
      out["siege_attempt_" + (i + 1)] = {
        attempting_faction: upper(r.side),
        location: r.space,
        target: r.target_cf === undefined ? null : r.target_cf,
        modifier: r.modifier || "",
        actual_roll: r.raw_value,
        result: successOrFail(r.outcome),
      };
    });
    return out;
  }

  function buildMandatedOffenseRolls(rows) {
    var moRows = rows.filter(function (r) { return r.category === "mandated_offensive"; });
    var out = {
      ap_rolls: moRows.filter(function (r) { return r.side === "ap"; }).map(function (r) { return r.raw_value; }),
      cp_rolls: moRows.filter(function (r) { return r.side === "cp"; }).map(function (r) { return r.raw_value; }),
    };
    var byTurn = {};
    moRows.forEach(function (r) { byTurn[r.turn] = byTurn[r.turn] || {}; byTurn[r.turn][r.side] = r; });
    Object.keys(byTurn).forEach(function (turn) {
      var t = byTurn[turn];
      out["turn_" + turn] = {
        ap_roll: t.ap ? t.ap.raw_value : null,
        ap_result: t.ap ? t.ap.outcome : null,
        cp_roll: t.cp ? t.cp.raw_value : null,
        cp_result: t.cp ? t.cp.outcome : null,
      };
    });
    return out;
  }

  /** @param {{rows: Array, combats: Array, meta: Object}} parsed - the object returned by PogParser.parseLog. */
  function buildGameJSON(parsed) {
    var rows = parsed.rows, combats = parsed.combats || [], meta = parsed.meta || {};
    return {
      game_metadata: { game_id: meta.gameId || "", ap_player: meta.apPlayer || "", cp_player: meta.cpPlayer || "" },
      all_ap_rolls: rows.filter(function (r) { return r.side === "ap"; }).map(function (r) { return r.raw_value; }),
      all_cp_rolls: rows.filter(function (r) { return r.side === "cp"; }).map(function (r) { return r.raw_value; }),
      combat_results: buildCombatResults(combats),
      entrench_rolls: buildEntrenchRolls(rows),
      siege_rolls: buildSiegeRolls(rows),
      mandated_offense_rolls: buildMandatedOffenseRolls(rows),
    };
  }

  var api = { buildGameJSON: buildGameJSON };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PogSchema = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
