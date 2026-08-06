/**
 * Parse Paths of Glory game-log HTML into an array of per-roll row objects.
 * Direct port of parse_dice.py — see that file (and PROCESS.md) in
 * ~/paths_of_glory_dice_analysis/ for the reference implementation and the
 * reasoning behind each pattern. Keep the two in sync when either changes.
 *
 * Pure function, no DOM dependency — works identically in a browser
 * <script> tag (exposes `window.PogParser`) or under Node (`require`),
 * which is what makes test/run.js possible without a browser.
 */
(function (root) {
  "use strict";

  // --- context-setting patterns (checked before the generic die pattern) ---
  var TURN_RE      = '<div class="h1">Turn (\\d+)';
  var ACTION_RE    = '<div class="h3 (cp|ap)">Turn \\d+ – Action (\\d+)</div>';
  var H4_RE        = '<div class="h4 group (cp|ap)"><span class="spacetip">([^<]+)</span></div>';
  var MANDATED_HDR = '<div>Mandated offensives:</div>';
  var MO_LINE_RE   = '<div>(CP|AP): <span class="die (cp|ap) d(\\d)"></span> → (.*?)</div>';
  var ATT_FIRE_RE  = '<div class="group (cp|ap)">Attacker\'s fire \\((\\d+) CF\\):</div>';
  var DEF_FIRE_RE  = '<div class="group (cp|ap)">Defender\'s fire \\((\\d+) CF\\):</div>';
  var ENTRENCH_RE  = '<div>Entrench attempt in <span class="spacetip">([^<]+)</span></div>';
  var FLANK_RE     = '<div class="group (cp|ap)">Flank attempt:</div>';
  var SIEGE_HDR_RE = '<div>Siege at <span class="spacetip">([^<]+)</span> \\((\\d+) CF\\):';
  var DIE_RE       = '<span class="die (ap|cp) d(\\d)"></span>([^<]*)';

  var COMBINED = new RegExp(
    [TURN_RE, ACTION_RE, H4_RE, MANDATED_HDR, MO_LINE_RE,
     ATT_FIRE_RE, DEF_FIRE_RE, ENTRENCH_RE, FLANK_RE, SIEGE_HDR_RE, DIE_RE].join("|"),
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

  /**
   * @param {string} rawText - a full Rally page save, or just a <div id="log">...</div> excerpt.
   * @returns {{rows: Array<Object>, unknownCount: number}}
   */
  function parseLog(rawText) {
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
    var ENTRENCH_M = new RegExp("^" + ENTRENCH_RE);
    var SIEGE_HDR_M = new RegExp("^" + SIEGE_HDR_RE);
    var DIE_M = new RegExp("^" + DIE_RE);

    var rows = [];
    var turn = null, actionNum = null;
    var combatSpace = null;
    var pendingFire = null; // {role, cf}
    var pendingEntrenchSpace = null;
    var pendingFlank = false;
    var pendingSiegeSpace = null;

    COMBINED.lastIndex = 0;
    var m;
    while ((m = COMBINED.exec(text))) {
      var g = m[0];
      if (g.indexOf('<div class="h1">Turn') === 0) {
        turn = parseInt(g.match(TURN_M)[1], 10);
        actionNum = null; combatSpace = null;
      } else if (g.indexOf('<div class="h3') === 0) {
        var am = g.match(ACTION_M);
        actionNum = parseInt(am[2], 10);
        combatSpace = null;
      } else if (g.indexOf('<div class="h4') === 0) {
        var hm = g.match(H4_M);
        combatSpace = hm[2];
      } else if (g.indexOf("<div>Mandated offensives:") === 0) {
        // no-op, just a marker in the source
      } else if (g.indexOf("<div>CP:") === 0 || g.indexOf("<div>AP:") === 0) {
        var mo = g.match(MO_LINE_M);
        var outcome = stripTags(mo[4]).trim();
        rows.push({ turn: turn, action: 0, side: mo[2], category: "mandated_offensive",
                    role: "", space: "", raw_value: parseInt(mo[3], 10), modifier: "",
                    effective_value: "", outcome: outcome });
      } else if (g.indexOf('<div class="group') === 0 && g.indexOf("Attacker's fire") !== -1) {
        var af = g.match(ATT_FIRE_M);
        pendingFire = { role: "attacker", cf: parseInt(af[2], 10) };
      } else if (g.indexOf('<div class="group') === 0 && g.indexOf("Defender's fire") !== -1) {
        var df = g.match(DEF_FIRE_M);
        pendingFire = { role: "defender", cf: parseInt(df[2], 10) };
      } else if (g.indexOf("<div>Entrench attempt in") === 0) {
        pendingEntrenchSpace = g.match(ENTRENCH_M)[1];
      } else if (g.indexOf('<div class="group') === 0 && g.indexOf("Flank attempt:") !== -1) {
        pendingFlank = true;
      } else if (g.indexOf("<div>Siege at") === 0) {
        pendingSiegeSpace = g.match(SIEGE_HDR_M)[1];
      } else {
        // a die roll
        var dm = g.match(DIE_M);
        var side = dm[1], raw = parseInt(dm[2], 10), trail = dm[3];
        var pt = parseTrail(trail);
        if (pendingFire !== null) {
          rows.push({ turn: turn, action: actionNum, side: side, category: "combat_fire",
                      role: pendingFire.role, space: combatSpace || "", raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: "cf=" + pendingFire.cf });
          pendingFire = null;
        } else if (pendingEntrenchSpace !== null) {
          rows.push({ turn: turn, action: actionNum, side: side, category: "entrench",
                      role: "", space: pendingEntrenchSpace, raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: pt.outcome });
          pendingEntrenchSpace = null;
        } else if (pendingFlank) {
          rows.push({ turn: turn, action: actionNum, side: side, category: "flank",
                      role: "", space: combatSpace || "", raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: pt.outcome });
          pendingFlank = false;
        } else if (pendingSiegeSpace !== null) {
          rows.push({ turn: turn, action: actionNum, side: side, category: "siege",
                      role: "", space: pendingSiegeSpace, raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: pt.outcome });
          pendingSiegeSpace = null;
        } else {
          rows.push({ turn: turn, action: actionNum, side: side, category: "unknown",
                      role: "", space: combatSpace || "", raw_value: raw,
                      modifier: pt.modifier, effective_value: pt.effective, outcome: pt.outcome });
        }
      }
    }

    // entrench attempt-number (per side+space, in chronological log order) —
    // kept for reference in the data export, not used in success-rate stats.
    var entSeen = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.category === "entrench") {
        var key = r.side + "|" + r.space;
        entSeen[key] = (entSeen[key] || 0) + 1;
        r.entrench_attempt_no = entSeen[key];
      } else {
        r.entrench_attempt_no = "";
      }
    }

    var unknownCount = rows.filter(function (r) { return r.category === "unknown"; }).length;
    return { rows: rows, unknownCount: unknownCount };
  }

  var api = { parseLog: parseLog, parseTrail: parseTrail };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PogParser = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
