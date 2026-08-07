/**
 * Static Paths of Glory reference tables (Corps/Army Fire Tables, Army Loss
 * Factors, Mandated Offensive tables) plus the pure lookup helpers built on
 * top of them. Shared by js/report.js (expected-vs-actual combat stats,
 * entrench/siege target-value breakdowns) and js/schema.js (the JSON
 * export's expected_losses_inflicted / expected_combat_winner fields), so
 * the numbers can't drift between the two.
 *
 * Pure data + pure functions, no DOM dependency — same UMD pattern as the
 * rest of js/.
 */
(function (root) {
  "use strict";

  // Row index 0..5 = die roll 1..6. Column index = CF bucket, see
  // corpsColumn()/armyColumn() below for how a raw CF maps to a column.
  var CORPS_TABLE = [
    [0, 0, 0, 1, 1, 1, 1, 1, 2], // die 1
    [0, 0, 1, 1, 1, 1, 1, 2, 2], // die 2
    [0, 0, 1, 1, 1, 2, 2, 2, 3], // die 3
    [0, 1, 1, 1, 2, 2, 2, 3, 3], // die 4
    [1, 1, 1, 2, 2, 2, 3, 3, 4], // die 5
    [1, 1, 1, 2, 2, 3, 3, 4, 4], // die 6
  ];
  // Columns: 0, 1, 2, 3, 4, 5, 6, 7, 8+
  var CORPS_COLUMNS = ["0", "1", "2", "3", "4", "5", "6", "7", "8+"];

  var ARMY_TABLE = [
    [0, 1, 1, 2, 2, 3, 3, 4, 4, 5], // die 1
    [1, 1, 2, 2, 3, 3, 4, 4, 5, 5], // die 2
    [1, 2, 2, 3, 3, 4, 4, 5, 5, 7], // die 3
    [1, 2, 3, 3, 4, 4, 5, 5, 7, 7], // die 4
    [2, 3, 3, 4, 4, 5, 5, 7, 7, 7], // die 5
    [2, 3, 4, 4, 5, 5, 7, 7, 7, 7], // die 6
  ];
  // Columns: 1, 2, 3, 4, 5, 6-8, 9-11, 12-14, 15, 16+
  var ARMY_COLUMNS = ["1", "2", "3", "4", "5", "6-8", "9-11", "12-14", "15", "16+"];

  // Army Loss Factors — also the entrench target number for that nationality.
  var ARMY_LOSS_FACTOR = {
    FR: 3, BR: 3, IT: 2, RU: 2, BE: 3, USA: 3, SB: 2, // AP
    GE: 3, AH: 2, TU: 2, // CP
  };

  var MANDATED_OFFENSE_TABLE = {
    cp: { 1: "AH", 2: "AH (IT)", 3: "TU", 4: "GE", 5: "None", 6: "None" },
    ap: { 1: "FR", 2: "FR", 3: "BR", 4: "IT", 5: "IT", 6: "RU" },
  };

  // One pale accent per nation, for the mandated-offensive per-turn chart's row
  // gridlines — a visual "which row is which" cue distinct from the strong
  // cp/ap/accent colors used for actual data marks elsewhere in the report.
  var MANDATED_OFFENSE_COLOR = {
    AH: "#e7e7e7", "AH (IT)": "#c9701f", TU: "#f2c477", GE: "#96afbf",
    FR: "#3d6da8", // matches report.js's current SIDE_COLOR.cp — keep in sync if that changes
    BR: "#dcd3b3", IT: "#fff99a", RU: "#d0b681",
    None: null,
  };

  // The game log spells outcomes out in full ("Austria-Hungary", "Turkey", …);
  // the report displays the short code used in MANDATED_OFFENSE_TABLE instead.
  var MANDATED_OFFENSE_LONG_TO_SHORT = {
    "Austria-Hungary": "AH",
    "Austria-Hungary (Italy)": "AH (IT)",
    "Turkey": "TU",
    "Germany": "GE",
    "France": "FR",
    "Britain": "BR",
    "Russia": "RU",
    "Italy": "IT",
    "None": "None",
  };

  /** Log outcome text ("Austria-Hungary") -> short code ("AH"). Unrecognized text passes through unchanged. */
  function mandatedShortName(outcomeText) {
    return Object.prototype.hasOwnProperty.call(MANDATED_OFFENSE_LONG_TO_SHORT, outcomeText)
      ? MANDATED_OFFENSE_LONG_TO_SHORT[outcomeText] : outcomeText;
  }

  /** CF (0-7, 8+) -> column index into CORPS_TABLE rows. */
  function corpsColumn(cf) {
    return Math.max(0, Math.min(8, cf));
  }

  /** CF (1, 2, 3, 4, 5, 6-8, 9-11, 12-14, 15, 16+) -> column index into ARMY_TABLE rows. */
  function armyColumn(cf) {
    if (cf <= 1) return 0;
    if (cf === 2) return 1;
    if (cf === 3) return 2;
    if (cf === 4) return 3;
    if (cf === 5) return 4;
    if (cf <= 8) return 5;
    if (cf <= 11) return 6;
    if (cf <= 14) return 7;
    if (cf === 15) return 8;
    return 9;
  }

  /**
   * Column shifts (from terrain, entrenchment, cards — e.g. "1L for Trenches")
   * move the *column index* itself, not the CF number: a shifted CF is looked
   * up on a neighboring bracket of the same table, clamped at the table's
   * edges. Net shift is right-positive (R), left-negative (L).
   */
  function shiftedColumn(forceType, cf, shift) {
    var base = forceType === "Corps" ? corpsColumn(cf) : armyColumn(cf);
    var maxCol = forceType === "Corps" ? 8 : 9;
    return Math.max(0, Math.min(maxCol, base + (shift || 0)));
  }

  /**
   * Look up a single (forceType, cf, dieRoll) result from the right table,
   * with an optional net column shift and an optional net die-roll modifier
   * (a combat card can add straight to the roll, e.g. "+1 Flamethrowers" —
   * distinct from a column shift, and clamped to a valid 1-6 row same as
   * the game does).
   */
  function fireResult(forceType, cf, dieRoll, shift, dieModifier) {
    var effRoll = Math.max(1, Math.min(6, dieRoll + (dieModifier || 0)));
    var row = effRoll - 1, col = shiftedColumn(forceType, cf, shift);
    return forceType === "Corps" ? CORPS_TABLE[row][col] : ARMY_TABLE[row][col];
  }

  /**
   * Expected losses inflicted for a given force type + CF (+ optional net
   * column shift / die modifier — both deterministic once cards are
   * committed to the combat, so folded in the same way), per
   * methodology.md: "sums the results for die roll of 3 and 4, then divides
   * by 2" — a fixed proxy for a typical (not probability-weighted) roll,
   * not a full expectation over all six faces.
   */
  function expectedLosses(forceType, cf, shift, dieModifier) {
    return (fireResult(forceType, cf, 3, shift, dieModifier) + fireResult(forceType, cf, 4, shift, dieModifier)) / 2;
  }

  /** Entrench target (= Army Loss Factor) for a nationality code, or null if unknown. */
  function entrenchTarget(nationality) {
    return Object.prototype.hasOwnProperty.call(ARMY_LOSS_FACTOR, nationality)
      ? ARMY_LOSS_FACTOR[nationality] : null;
  }

  /**
   * Table-predicted mandated offensive result for a side+roll. Kept only as
   * a fallback/cross-check — the log's own outcome text is authoritative
   * (it already reflects turn-1 exemptions etc. this static table can't).
   */
  function mandatedOffenseResult(side, roll) {
    var t = MANDATED_OFFENSE_TABLE[side];
    return t ? (t[roll] || null) : null;
  }

  var api = {
    CORPS_TABLE: CORPS_TABLE, CORPS_COLUMNS: CORPS_COLUMNS,
    ARMY_TABLE: ARMY_TABLE, ARMY_COLUMNS: ARMY_COLUMNS,
    ARMY_LOSS_FACTOR: ARMY_LOSS_FACTOR, MANDATED_OFFENSE_TABLE: MANDATED_OFFENSE_TABLE,
    MANDATED_OFFENSE_COLOR: MANDATED_OFFENSE_COLOR,
    MANDATED_OFFENSE_LONG_TO_SHORT: MANDATED_OFFENSE_LONG_TO_SHORT,
    corpsColumn: corpsColumn, armyColumn: armyColumn, shiftedColumn: shiftedColumn,
    fireResult: fireResult, expectedLosses: expectedLosses,
    entrenchTarget: entrenchTarget, mandatedOffenseResult: mandatedOffenseResult,
    mandatedShortName: mandatedShortName,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PogTables = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
