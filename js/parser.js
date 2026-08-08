/**
 * Parse Paths of Glory game-log HTML into an array of per-roll row objects,
 * plus a `combats` array that groups each combat's attacker/defender fire,
 * flank attempt, and retreat into one record (used by the report's
 * expected-vs-actual stats and by the JSON export), and best-effort game
 * metadata (game id, player names) pulled from outside the log div itself.
 *
 * Pure function, no DOM dependency — works identically in a browser
 * <script> tag (exposes `window.PogParser`) or under Node (`require`),
 * which is what makes test/run.js possible without a browser.
 */
(function (root) {
  "use strict";

  // --- context-setting patterns (checked before the generic die pattern) ---
  var TURN_RE       = '<div class="h1">Turn (\\d+)';
  var ACTION_RE     = '<div class="h3 (cp|ap)">Turn \\d+ – Action (\\d+)</div>';
  var H4_RE         = '<div class="h4 group (cp|ap)"><span class="spacetip">([^<]+)</span></div>';
  var MANDATED_HDR  = '<div>Mandated offensives:</div>';
  var MO_LINE_RE    = '<div>(CP|AP): <span class="die (cp|ap) d(\\d)"></span> → (.*?)</div>';
  var ATT_FIRE_RE   = '<div class="group (cp|ap)">Attacker\'s fire \\((\\d+) CF\\):</div>';
  var DEF_FIRE_RE   = '<div class="group (cp|ap)">Defender\'s fire \\((\\d+) CF\\):</div>';
  var VICTORY_RE    = '<div class="bold group (?:cp|ap)">(\\d+):(\\d+) (?:(attacker|defender) victory|no combat winner)</div>';
  var RETREAT_RE    = '<div class="group (?:cp|ap)">Retreat( canceled)?:</div>';
  // Precedes a run of unit lines within a combined Move action — the units listed after it either
  // move on ("<unit> → <dest>") or stay and entrench in this origin space ("<unit> entrench"),
  // which is how an entrenching unit's space is recovered when the log has no standalone
  // "Entrench attempt in <space>" immediately after its declaration (see pendingEntrenchQueue below).
  var MOVED_FROM_RE = '<div>Moved from <span class="spacetip">([^<]+)</span></div>';
  var ENTRENCH_UNIT_RE = '<div class="i"><span class="piecetip (?:ap|cp)-unit"[^>]*>([^<]+)</span> entrench</div>';
  var ENTRENCH_RE   = '<div>Entrench attempt in <span class="spacetip">([^<]+)</span></div>';
  var FLANK_RE      = '<div class="group (cp|ap)">Flank attempt:</div>';
  var FLANK_MOD_RE  = '<div class="i(?: group (?:cp|ap))?">([+−-]\\d+) <span class="spacetip">[^<]+</span></div>';
  var COLUMN_SHIFT_RE = '<div class="i group (?:cp|ap)">(\\d+)([LR]) for ([^<]+)</div>';
  var DIE_MOD_RE    = '<div class="i group (?:cp|ap)">([+−-]\\d+) <span class="cardtip (?:cp|ap)-card"[^>]*>([^<]+)</span></div>';
  var SIEGE_HDR_RE  = '<div>Siege at <span class="spacetip">([^<]+)</span> \\((\\d+) CF\\):';
  var SIEGE_RESULT_RE = '<div class="i">(Fort holds|Fort destroyed)</div>';
  var DIE_RE        = '<span class="die (ap|cp) d(\\d)"></span>([^<]*)';

  var COMBINED = new RegExp(
    [TURN_RE, ACTION_RE, H4_RE, MANDATED_HDR, MO_LINE_RE,
     ATT_FIRE_RE, DEF_FIRE_RE, VICTORY_RE, RETREAT_RE, MOVED_FROM_RE, ENTRENCH_UNIT_RE, ENTRENCH_RE,
     FLANK_RE, FLANK_MOD_RE, COLUMN_SHIFT_RE, DIE_MOD_RE, SIEGE_HDR_RE, SIEGE_RESULT_RE, DIE_RE].join("|"),
    "g"
  );

  function stripTags(s) {
    return s.replace(/<[^>]+>/g, "");
  }

  /** Pull modifier / effective value / outcome text out of the text following a die span. */
  // NOTE: the source HTML uses the Unicode MINUS SIGN (−, U+2212), not an
  // ASCII hyphen, for negative numbers (e.g. siege results like "− 2 = −1").
  // Both signed-number groups below must accept it, and the captured value
  // must be normalized to an ASCII "-" so downstream numeric parsing works.
  function normalizeMinus(s) { return s.replace(/−/g, "-"); }

  /** "GE 3" / "(GE 2)" / "RU CAU" / "GEc" / "TU YLD" -> "GE" / "RU" / "TU". */
  function nationalityOf(pieceName) {
    var m = pieceName.match(/^\(?([A-Z]{2,3})/);
    return m ? m[1] : "";
  }

  function parseTrail(trailRaw) {
    var trail = trailRaw.trim();
    var modifier = "", effective = "", outcome = "";
    var m;
    m = trail.match(/^[−-]\s*(\d+)\s*=\s*([−-]?\d+)\s*→\s*(.+)$/);
    if (m) return { modifier: "-" + m[1], effective: normalizeMinus(m[2]), outcome: m[3].trim() };
    m = trail.match(/^[−-]\s*(\d+)\s*=\s*([−-]?\d+)\s*$/);
    if (m) return { modifier: "-" + m[1], effective: normalizeMinus(m[2]), outcome: "" };
    m = trail.match(/^→\s*(.+)$/);
    if (m) return { modifier: modifier, effective: effective, outcome: m[1].trim() };
    m = trail.match(/^×\s*(\d+)\+?\s*\((Army|Corps)\)\s*=\s*([−-]?\d+)/);
    if (m) return { modifier: modifier, effective: normalizeMinus(m[3]), outcome: m[2] };
    if (trail === "Success" || trail === "Fail" || trail === "Failure") {
      return { modifier: modifier, effective: effective, outcome: trail };
    }
    return { modifier: modifier, effective: effective, outcome: outcome };
  }

  /** Best-effort game id + player names, pulled from outside the log div (URL comment, chat log). */
  function parseMeta(rawText) {
    var meta = { gameId: "", apPlayer: "", cpPlayer: "" };
    var gm = rawText.match(/[?&]game=(\d+)/);
    if (gm) meta.gameId = gm[1];
    var userRe = /class="user (Central_Powers|Allied_Powers) player_\d+">([^<]+)<\/span>/g;
    var um;
    while ((um = userRe.exec(rawText))) {
      if (um[1] === "Central_Powers" && !meta.cpPlayer) meta.cpPlayer = um[2];
      if (um[1] === "Allied_Powers" && !meta.apPlayer) meta.apPlayer = um[2];
      if (meta.cpPlayer && meta.apPlayer) break;
    }
    return meta;
  }

  /**
   * @param {string} rawText - a full Rally page save, or just a <div id="log">...</div> excerpt.
   * @returns {{rows: Array<Object>, unknownCount: number, combats: Array<Object>, meta: Object}}
   */
  function parseLog(rawText) {
    var meta = parseMeta(rawText);
    var text = rawText;

    // Extract just <div id="log">...</div> if this is a full page save
    // (balanced-tag scan — only <div>/</div> nesting matters here, everything
    // inside is inline spans).
    var logStart = text.indexOf('<div id="log">');
    if (logStart !== -1) {
      var depth = 0, end = null;
      var tagRe = /<div[ >]|<\/div>/g;
      tagRe.lastIndex = logStart;
      var tm;
      while ((tm = tagRe.exec(text))) {
        depth += tm[0].charAt(1) === "d" ? 1 : -1; // "<div" vs "</div"
        if (depth === 0) { end = tm.index + tm[0].length; break; }
      }
      text = text.slice(logStart, end === null ? text.length : end);
    }

    // normalize spacetip spans that still carry onmouseenter/.../onclick attributes
    text = text.replace(/<span class="spacetip"[^>]*>/g, '<span class="spacetip">');

    var TURN_M = new RegExp("^" + TURN_RE);
    var ACTION_M = new RegExp("^" + ACTION_RE);
    var H4_M = new RegExp("^" + H4_RE);
    var MO_LINE_M = new RegExp("^" + MO_LINE_RE);
    var ATT_FIRE_M = new RegExp("^" + ATT_FIRE_RE);
    var DEF_FIRE_M = new RegExp("^" + DEF_FIRE_RE);
    var VICTORY_M = new RegExp("^" + VICTORY_RE);
    var RETREAT_M = new RegExp("^" + RETREAT_RE);
    var MOVED_FROM_M = new RegExp("^" + MOVED_FROM_RE);
    var ENTRENCH_UNIT_M = new RegExp("^" + ENTRENCH_UNIT_RE);
    var ENTRENCH_M = new RegExp("^" + ENTRENCH_RE);
    var FLANK_MOD_M = new RegExp("^" + FLANK_MOD_RE);
    var COLUMN_SHIFT_M = new RegExp("^" + COLUMN_SHIFT_RE);
    var DIE_MOD_M = new RegExp("^" + DIE_MOD_RE);
    var SIEGE_HDR_M = new RegExp("^" + SIEGE_HDR_RE);
    var SIEGE_RESULT_M = new RegExp("^" + SIEGE_RESULT_RE);
    var DIE_M = new RegExp("^" + DIE_RE);

    var rows = [];
    var combats = [], combatsByKey = {};
    var turn = null, actionNum = null;
    var combatSpace = null, currentCombat = null;
    var pendingFire = null; // {role, cf}
    var pendingFireShift = 0, pendingFireShiftReasons = []; // net column shift (R=+, L=-) accumulated between the fire header and its die
    var pendingFireDieMod = 0, pendingFireDieModReasons = []; // net die-roll modifier (e.g. "+1 Flamethrowers") accumulated the same way
    var pendingEntrench = null; // {space, nationality}
    // Queue of {nationality, space} from "<unit> entrench" declaration lines, not yet claimed by an
    // "Entrench attempt in <space>" line. In a combined move-and-entrench action, several units can
    // each declare "entrench" up front (interleaved with unrelated move lines for other units), and
    // the "Entrench attempt in <space>" + die-roll lines that resolve them are grouped together
    // afterward, one per unit — so a single pending slot isn't enough once more than one unit
    // declares entrench in the same action. `space` (recovered from the preceding "Moved from
    // <space>" line — an entrenching unit didn't move on, so it stayed at that origin) lets an
    // attempt line find its matching declaration by space rather than assuming declaration order
    // matches attempt order; declarations with no such context (plain, non-combined entrench
    // actions) carry space: null and are matched by FIFO order among themselves instead.
    var pendingEntrenchQueue = [];
    var currentMoveOrigin = null; // space named by the most recent "Moved from <space>" line, reset each action
    var pendingFlank = false;
    var pendingFlankModifier = "";
    var pendingSiegeSpace = null;
    var pendingSiegeRowIndex = null;

    COMBINED.lastIndex = 0;
    var m;
    while ((m = COMBINED.exec(text))) {
      var g = m[0];
      if (g.indexOf('<div class="h1">Turn') === 0) {
        turn = parseInt(g.match(TURN_M)[1], 10);
        actionNum = null; combatSpace = null; currentCombat = null;
        currentMoveOrigin = null; pendingEntrenchQueue = [];
      } else if (g.indexOf('<div class="h3') === 0) {
        var am = g.match(ACTION_M);
        actionNum = parseInt(am[2], 10);
        combatSpace = null; currentCombat = null;
        currentMoveOrigin = null; pendingEntrenchQueue = [];
      } else if (g.indexOf('<div class="h4') === 0) {
        var hm = g.match(H4_M);
        combatSpace = hm[2];
        var key = turn + "|" + actionNum + "|" + combatSpace;
        if (!combatsByKey[key]) {
          combatsByKey[key] = { turn: turn, action: actionNum, location: combatSpace,
            attacker: null, defender: null, flank_attempt: null, retreat: null };
          combats.push(combatsByKey[key]);
        }
        currentCombat = combatsByKey[key];
      } else if (g.indexOf("<div>Mandated offensives:") === 0) {
        // no-op, just a marker in the source
      } else if (g.indexOf("<div>CP:") === 0 || g.indexOf("<div>AP:") === 0) {
        var mo = g.match(MO_LINE_M);
        var outcome = stripTags(mo[4]).trim();
        rows.push({ turn: turn, action: 0, side: mo[2], category: "mandated_offensive",
                    role: "", space: "", raw_value: parseInt(mo[3], 10), modifier: "",
                    effective_value: "", outcome: outcome, force_type: "", nationality: "" });
      } else if (g.indexOf('<div class="group') === 0 && g.indexOf("Attacker's fire") !== -1) {
        var af = g.match(ATT_FIRE_M);
        pendingFire = { role: "attacker", cf: parseInt(af[2], 10) };
        pendingFireShift = 0; pendingFireShiftReasons = [];
        pendingFireDieMod = 0; pendingFireDieModReasons = [];
      } else if (g.indexOf('<div class="group') === 0 && g.indexOf("Defender's fire") !== -1) {
        var df = g.match(DEF_FIRE_M);
        pendingFire = { role: "defender", cf: parseInt(df[2], 10) };
        pendingFireShift = 0; pendingFireShiftReasons = [];
        pendingFireDieMod = 0; pendingFireDieModReasons = [];
      } else if (pendingFire !== null && COLUMN_SHIFT_M.test(g)) {
        var csm = g.match(COLUMN_SHIFT_M);
        var amount = parseInt(csm[1], 10) * (csm[2] === "L" ? -1 : 1);
        pendingFireShift += amount;
        pendingFireShiftReasons.push(csm[1] + csm[2] + " for " + csm[3]);
      } else if (pendingFire !== null && DIE_MOD_M.test(g)) {
        // A combat card can add straight to the die roll itself (before the ×CF lookup),
        // separate from — and stacking with — any column shift above. Verified against a
        // real game: raw roll + this modifier (clamped 1-6) is the row the CRT lookup
        // actually used in every case checked.
        var dmm = g.match(DIE_MOD_M);
        pendingFireDieMod += parseInt(normalizeMinus(dmm[1]), 10);
        pendingFireDieModReasons.push(normalizeMinus(dmm[1]) + " " + dmm[2]);
      } else if (g.indexOf('<div class="bold group') === 0) {
        var vm = g.match(VICTORY_M);
        if (currentCombat) {
          currentCombat.actual = { attacker_value: parseInt(vm[1], 10), defender_value: parseInt(vm[2], 10),
                                    winner: vm[3] || "tie" };
        }
      } else if (g.indexOf('<div class="group') === 0 && /Retreat( canceled)?:<\/div>$/.test(g)) {
        var rm = g.match(RETREAT_M);
        if (currentCombat) {
          currentCombat.retreat = currentCombat.retreat || { forced: false, canceled: false };
          if (rm[1]) currentCombat.retreat.canceled = true; else currentCombat.retreat.forced = true;
        }
      } else if (g.indexOf("<div>Moved from") === 0) {
        currentMoveOrigin = g.match(MOVED_FROM_M)[1];
      } else if (g.indexOf('<div class="i"><span class="piecetip') === 0 && g.indexOf(" entrench</div>") !== -1) {
        var eum = g.match(ENTRENCH_UNIT_M);
        pendingEntrenchQueue.push({ nationality: nationalityOf(eum[1]), space: currentMoveOrigin });
      } else if (g.indexOf("<div>Entrench attempt in") === 0) {
        var attemptSpace = g.match(ENTRENCH_M)[1];
        // Prefer a declaration whose "Moved from <space>" origin matches this attempt's space —
        // that's the unit that actually stayed put and entrenched here. Only fall back to FIFO
        // (oldest declaration with no recorded space) for plain, non-combined entrench actions,
        // where there's normally just the one declaration anyway.
        var qi = -1, qq;
        for (qq = 0; qq < pendingEntrenchQueue.length; qq++) {
          if (pendingEntrenchQueue[qq].space === attemptSpace) { qi = qq; break; }
        }
        if (qi === -1) {
          for (qq = 0; qq < pendingEntrenchQueue.length; qq++) {
            if (pendingEntrenchQueue[qq].space === null) { qi = qq; break; }
          }
        }
        var entrenchNationality = qi === -1 ? "" : pendingEntrenchQueue.splice(qi, 1)[0].nationality;
        pendingEntrench = { space: attemptSpace, nationality: entrenchNationality };
      } else if (g.indexOf('<div class="group') === 0 && g.indexOf("Flank attempt:") !== -1) {
        pendingFlank = true;
        pendingFlankModifier = "";
      } else if (pendingFlank && /^<div class="i(?: group (?:cp|ap))?">[+−-]\d+ <span class="spacetip">/.test(g)) {
        var fmm = g.match(FLANK_MOD_M);
        pendingFlankModifier = normalizeMinus(fmm[1]);
      } else if (g.indexOf("<div>Siege at") === 0) {
        var sh = g.match(SIEGE_HDR_M);
        pendingSiegeSpace = { space: sh[1], cf: parseInt(sh[2], 10) };
      } else if (g.indexOf('<div class="i">Fort') === 0) {
        var srm = g.match(SIEGE_RESULT_M);
        if (pendingSiegeRowIndex !== null) {
          rows[pendingSiegeRowIndex].outcome = srm[1] === "Fort destroyed" ? "Success" : "Fail";
          pendingSiegeRowIndex = null;
        }
      } else {
        // a die roll
        var dm = g.match(DIE_M);
        var side = dm[1], raw = parseInt(dm[2], 10), trail = dm[3];
        var pt = parseTrail(trail);
        if (pendingFire !== null) {
          // `modifier` (via parseTrail's "×CF" branch) is always "" — a combat card's roll
          // bonus doesn't appear inline in the die's own trailing text, it's the separate
          // "+N <card>" line accumulated into pendingFireDieMod above (see DIE_MOD_RE).
          rows.push({ turn: turn, action: actionNum, side: side, category: "combat_fire",
                      role: pendingFire.role, space: combatSpace || "", raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: "cf=" + pendingFire.cf,
                      force_type: pt.outcome, nationality: "",
                      column_shift: pendingFireShift, shift_reasons: pendingFireShiftReasons.join(", "),
                      die_modifier: pendingFireDieMod, die_modifier_reasons: pendingFireDieModReasons.join(", ") });
          if (currentCombat) {
            currentCombat[pendingFire.role] = { side: side, raw_value: raw, effective_value: pt.effective,
              force_type: pt.outcome, cf: pendingFire.cf,
              column_shift: pendingFireShift, shift_reasons: pendingFireShiftReasons.slice(),
              die_modifier: pendingFireDieMod, die_modifier_reasons: pendingFireDieModReasons.slice() };
          }
          pendingFire = null;
          pendingFireShift = 0; pendingFireShiftReasons = [];
          pendingFireDieMod = 0; pendingFireDieModReasons = [];
        } else if (pendingEntrench !== null) {
          rows.push({ turn: turn, action: actionNum, side: side, category: "entrench",
                      role: "", space: pendingEntrench.space, raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: pt.outcome,
                      force_type: "", nationality: pendingEntrench.nationality });
          pendingEntrench = null;
        } else if (pendingFlank) {
          rows.push({ turn: turn, action: actionNum, side: side, category: "flank",
                      role: "", space: combatSpace || "", raw_value: raw,
                      modifier: pendingFlankModifier, effective_value: pt.effective, outcome: pt.outcome,
                      force_type: "", nationality: "" });
          if (currentCombat) {
            currentCombat.flank_attempt = { side: side, modifier: pendingFlankModifier, raw_value: raw, result: pt.outcome };
          }
          pendingFlank = false;
          pendingFlankModifier = "";
        } else if (pendingSiegeSpace !== null) {
          rows.push({ turn: turn, action: actionNum, side: side, category: "siege",
                      role: "", space: pendingSiegeSpace.space, raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: pt.outcome,
                      force_type: "", nationality: "", target_cf: pendingSiegeSpace.cf });
          pendingSiegeRowIndex = rows.length - 1;
          pendingSiegeSpace = null;
        } else {
          rows.push({ turn: turn, action: actionNum, side: side, category: "unknown",
                      role: "", space: combatSpace || "", raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: pt.outcome,
                      force_type: "", nationality: "" });
        }
      }
    }

    // entrench attempt-number (per side+space, in chronological log order) —
    // kept for reference in the data export, not used in success-rate stats.
    var entSeen = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.category === "entrench") {
        var ekey = r.side + "|" + r.space;
        entSeen[ekey] = (entSeen[ekey] || 0) + 1;
        r.entrench_attempt_no = entSeen[ekey];
      } else {
        r.entrench_attempt_no = "";
      }
    }

    // drop any combat shells that never got both an attacker and a defender
    // fire roll (e.g. a flank attempt that ended the combat before return fire)
    combats = combats.filter(function (c) { return c.attacker && c.defender; });

    var unknownCount = rows.filter(function (r) { return r.category === "unknown"; }).length;
    return { rows: rows, unknownCount: unknownCount, combats: combats, meta: meta };
  }

  var api = { parseLog: parseLog, parseTrail: parseTrail, nationalityOf: nationalityOf };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PogParser = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
