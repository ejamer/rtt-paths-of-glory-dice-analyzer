/**
 * Compute dice-roll stats from parsed rows/combats and render a
 * self-contained HTML report string. Pure functions, no DOM dependency —
 * `buildReportHTML` returns an HTML *string*, so this module works
 * identically under Node (for test/run.js) or in a browser, where the
 * caller just does `container.innerHTML = buildReportHTML(rows, combats)`.
 *
 * Report structure follows methodology.md: a broad summary up top (is
 * either side getting better dice, in general), then one section per
 * action type — Combat, Entrench, Siege, Mandated Offensive — each with
 * the specific sub-breakdowns methodology.md calls for.
 */
(function (root) {
  "use strict";

  var PogTables = (typeof module !== "undefined" && module.exports)
    ? require("./tables.js") : root.PogTables;

  var SIDES = ["ap", "cp"]; // AP listed/plotted before CP everywhere a report section splits by side
  var SIDE_NAME = { cp: "Central Powers", ap: "Allied Powers" };
  var SIDE_COLOR = { cp: "#3d6da8", ap: "#b1494a" };
  var RATE_COLOR = "#2a6f4d"; // neutral "success rate" accent — distinct from both side colors
  var CAT_NAME = {
    mandated_offensive: "Mandated Offensive",
    combat_fire: "Combat Fire",
    entrench: "Entrench",
    flank: "Flank Attempt",
    siege: "Siege",
  };
  var CATS = ["mandated_offensive", "combat_fire", "entrench", "flank", "siege"];
  var CHI2_CRIT_05 = 11.07; // df=5, p=0.05

  function mean(xs) { return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : NaN; }
  function pstdev(xs) {
    if (xs.length <= 1) return 0;
    var m = mean(xs);
    var variance = xs.reduce(function (a, x) { return a + (x - m) * (x - m); }, 0) / xs.length;
    return Math.sqrt(variance);
  }
  function fmt(v, nd) {
    nd = nd === undefined ? 2 : nd;
    return v === null || v === undefined || isNaN(v) ? "—" : v.toFixed(nd);
  }
  function pct(succ, total) { return total ? Math.round((succ / total) * 100) : 0; }
  function esc(x) {
    return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function chiSquare(values) {
    var n = values.length, expected = n / 6;
    var obs = {};
    values.forEach(function (v) { obs[v] = (obs[v] || 0) + 1; });
    var chi2 = 0;
    for (var v = 1; v <= 6; v++) {
      var o = obs[v] || 0;
      chi2 += (o - expected) * (o - expected) / expected;
    }
    return chi2;
  }

  function successRate(items) {
    if (!items.length) return null;
    var succ = items.filter(function (r) { return String(r.outcome).toLowerCase().indexOf("success") === 0; }).length;
    return [succ, items.length];
  }

  /** Entrench roll's effective threshold on the *raw* die: target - modifier (modifier is "-1" etc, so this adds back what the modifier relaxed). */
  function entrenchEffectiveTarget(target, modifierStr) {
    var mod = modifierStr ? parseInt(modifierStr, 10) : 0;
    return target - mod;
  }

  /** Compute every stat used by the report, from parsed rows + combats. */
  function buildStats(rows, combats) {
    combats = combats || [];
    var overall = {}, overallStats = {}, chi2 = {}, dist = {};
    SIDES.forEach(function (s) {
      overall[s] = rows.filter(function (r) { return r.side === s; }).map(function (r) { return r.raw_value; });
      overallStats[s] = { n: overall[s].length, mean: mean(overall[s]), std: pstdev(overall[s]) };
      chi2[s] = chiSquare(overall[s]);
      var d = {};
      overall[s].forEach(function (v) { d[v] = (d[v] || 0) + 1; });
      dist[s] = d;
    });

    var perCat = {}, perRole = {};
    SIDES.forEach(function (s) {
      perCat[s] = {};
      CATS.forEach(function (c) {
        perCat[s][c] = rows.filter(function (r) { return r.side === s && r.category === c; }).map(function (r) { return r.raw_value; });
      });
      perRole[s] = { attacker: [], defender: [] };
      rows.filter(function (r) { return r.side === s && r.category === "combat_fire"; }).forEach(function (r) {
        perRole[s][r.role].push(r.raw_value);
      });
    });

    var entRate = {}, flankRate = {};
    SIDES.forEach(function (s) {
      entRate[s] = successRate(rows.filter(function (r) { return r.side === s && r.category === "entrench"; }));
      flankRate[s] = successRate(rows.filter(function (r) { return r.side === s && r.category === "flank"; }));
    });

    // --- combat outcomes (from the log's own victory-line text, not re-derived) ---
    var winTally = {};
    SIDES.forEach(function (s) { winTally[s] = { win: 0, tie: 0, loss: 0 }; });
    combats.forEach(function (c) {
      if (!c.actual) return;
      if (c.actual.winner === "attacker") { winTally[c.attacker.side].win++; winTally[c.defender.side].loss++; }
      else if (c.actual.winner === "defender") { winTally[c.defender.side].win++; winTally[c.attacker.side].loss++; }
      else { winTally[c.attacker.side].tie++; winTally[c.defender.side].tie++; }
    });

    // --- roll-difference histogram: per combat, CP raw roll minus AP raw roll, bucketed -5..+5 ---
    var rollDiffHist = {};
    for (var b = -5; b <= 5; b++) rollDiffHist[b] = 0;
    combats.forEach(function (c) {
      var cpRow = c.attacker.side === "cp" ? c.attacker : c.defender;
      var apRow = c.attacker.side === "ap" ? c.attacker : c.defender;
      if (!cpRow || !apRow) return;
      var diff = Math.max(-5, Math.min(5, cpRow.raw_value - apRow.raw_value));
      rollDiffHist[diff]++;
    });

    // --- expected vs. actual combat outcome, per methodology's CRT-column formula ---
    var expVsActual = {
      comparable: 0, upsetCount: 0,
      upsetsBySide: { cp: 0, ap: 0 }, upsetDetails: { cp: [], ap: [] },
      // "underdog tie": one side was expected to win decisively but the actual result was a
      // tie — counted against expected winner, but not creditable as either side's win.
      underdogTiesBySide: { cp: 0, ap: 0 }, underdogTieDetails: { cp: [], ap: [] },
    };
    combats.forEach(function (c) {
      if (!c.actual || !c.attacker.force_type || !c.defender.force_type) return;
      var expAtt = PogTables.expectedLosses(c.attacker.force_type, c.attacker.cf, c.attacker.column_shift, c.attacker.die_modifier);
      var expDef = PogTables.expectedLosses(c.defender.force_type, c.defender.cf, c.defender.column_shift, c.defender.die_modifier);
      var expWinnerSide = expAtt > expDef ? c.attacker.side : (expAtt < expDef ? c.defender.side : "tie");
      var actWinnerSide = c.actual.winner === "attacker" ? c.attacker.side : (c.actual.winner === "defender" ? c.defender.side : "tie");
      expVsActual.comparable++;
      if (expWinnerSide === actWinnerSide) return;
      expVsActual.upsetCount++;
      var detail = {
        location: c.location, turn: c.turn,
        attacker: c.attacker, defender: c.defender,
        expWinnerSide: expWinnerSide, expAtt: expAtt, expDef: expDef,
        lossRatio: c.actual.attacker_value + ":" + c.actual.defender_value,
      };
      if (actWinnerSide !== "tie") {
        expVsActual.upsetsBySide[actWinnerSide]++;
        expVsActual.upsetDetails[actWinnerSide].push(detail);
      } else if (expWinnerSide !== "tie") {
        // Credited to the side that *wasn't* expected to win: they were supposed to lose this
        // one outright but held on for a tie instead, so the tie reads as a good result for
        // them (and a below-expectation one for the side that was expected to win it).
        var tieBeneficiary = expWinnerSide === "cp" ? "ap" : "cp";
        expVsActual.underdogTiesBySide[tieBeneficiary]++;
        expVsActual.underdogTieDetails[tieBeneficiary].push(detail);
      }
    });

    // --- win rate per turn (not cumulative) ---
    var combatTurns = Array.from(new Set(combats.filter(function (c) { return c.actual; }).map(function (c) { return c.turn; }))).sort(function (a, b) { return a - b; });
    var winTimeline = { turns: combatTurns, cp: [], ap: [] };
    combatTurns.forEach(function (t) {
      var turnCombats = combats.filter(function (c) { return c.actual && c.turn === t; });
      SIDES.forEach(function (s) {
        var n = 0, win = 0;
        turnCombats.forEach(function (c) {
          if (c.attacker.side !== s && c.defender.side !== s) return;
          n++;
          if ((c.actual.winner === "attacker" && c.attacker.side === s) || (c.actual.winner === "defender" && c.defender.side === s)) win++;
        });
        winTimeline[s].push(n ? (win / n * 100) : null);
      });
    });

    // --- forced/canceled retreats, tallied against the side that had to retreat. Length is
    // the rules formula (loss margin, capped at 2), not inferred from unit-movement text. ---
    var retreatBySide = { cp: { forced1: 0, forced2: 0, canceled: 0 }, ap: { forced1: 0, forced2: 0, canceled: 0 } };
    combats.forEach(function (c) {
      if (!c.retreat || !c.actual || c.actual.attacker_value === null) return;
      var losingSide = c.actual.winner === "attacker" ? c.defender.side : (c.actual.winner === "defender" ? c.attacker.side : null);
      if (!losingSide) return;
      var length = Math.max(0, Math.min(2, Math.abs(c.actual.attacker_value - c.actual.defender_value)));
      if (c.retreat.forced) { if (length >= 2) retreatBySide[losingSide].forced2++; else retreatBySide[losingSide].forced1++; }
      if (c.retreat.canceled) retreatBySide[losingSide].canceled++;
    });

    // --- flank attempts by side + modifier level ---
    var flankRows = rows.filter(function (r) { return r.category === "flank"; });
    var flankModifiers = Array.from(new Set(flankRows.map(function (r) { return r.modifier || "none"; })))
      .sort(function (a, b) { return (a === "none" ? 0 : parseInt(a, 10)) - (b === "none" ? 0 : parseInt(b, 10)); });
    var flankBySideMod = {};
    SIDES.forEach(function (s) {
      flankBySideMod[s] = {};
      flankModifiers.forEach(function (modKey) {
        var items = flankRows.filter(function (r) { return r.side === s && (r.modifier || "none") === modKey; });
        flankBySideMod[s][modKey] = successRate(items);
      });
    });

    // --- entrench by nationality and by effective target value, split per side (nationality
    // already implies side, but combining CP+AP in one table buries the side-specific read) ---
    var entrenchRows = rows.filter(function (r) { return r.category === "entrench"; });
    var entrenchByNationality = {}, entrenchByTarget = {};
    SIDES.forEach(function (s) {
      var sideRows = entrenchRows.filter(function (r) { return r.side === s; });
      var nats = Array.from(new Set(sideRows.map(function (r) { return r.nationality; }).filter(Boolean))).sort();
      entrenchByNationality[s] = nats.map(function (nat) {
        var items = sideRows.filter(function (r) { return r.nationality === nat; });
        return { nationality: nat, target: PogTables.entrenchTarget(nat), rate: successRate(items) };
      });
      var targetMap = {};
      sideRows.forEach(function (r) {
        if (!r.nationality) return;
        var target = PogTables.entrenchTarget(r.nationality);
        if (target === null) return;
        var eff = entrenchEffectiveTarget(target, r.modifier);
        targetMap[eff] = targetMap[eff] || [];
        targetMap[eff].push(r);
      });
      entrenchByTarget[s] = Object.keys(targetMap).map(Number).sort(function (a, b) { return a - b; })
        .map(function (eff) { return { effectiveTarget: eff, rate: successRate(targetMap[eff]) }; });
    });

    // --- siege by target value (space's CF), split per side ---
    var siegeRows = rows.filter(function (r) { return r.category === "siege"; });
    var siegeByTarget = {};
    SIDES.forEach(function (s) {
      var sideRows = siegeRows.filter(function (r) { return r.side === s; });
      var targets = Array.from(new Set(sideRows.map(function (r) { return r.target_cf; }).filter(function (v) { return v !== undefined; })))
        .sort(function (a, b) { return a - b; });
      siegeByTarget[s] = targets.map(function (cf) {
        var items = sideRows.filter(function (r) { return r.target_cf === cf; });
        return { cf: cf, rate: successRate(items) };
      });
    });

    // --- mandated offensive: per-turn series + outcome frequency, per side. Outcome text in the
    // log is spelled out ("Austria-Hungary"); normalize to the short code for display. ---
    var moRows = rows.filter(function (r) { return r.category === "mandated_offensive"; });
    var moTurns = Array.from(new Set(moRows.map(function (r) { return r.turn; }))).sort(function (a, b) { return a - b; });
    var mandatedByTurn = { turns: moTurns, cp: {}, ap: {} };
    moRows.forEach(function (r) { mandatedByTurn[r.side][r.turn] = r.raw_value; });
    var mandatedFrequency = {};
    SIDES.forEach(function (s) {
      var freq = {};
      moRows.filter(function (r) { return r.side === s; }).forEach(function (r) {
        var key = PogTables.mandatedShortName(r.outcome);
        freq[key] = (freq[key] || 0) + 1;
      });
      mandatedFrequency[s] = freq;
    });

    var turns = Array.from(new Set(rows.map(function (r) { return r.turn; }))).sort(function (a, b) { return a - b; });
    var perTurn = {};
    SIDES.forEach(function (s) {
      perTurn[s] = {};
      turns.forEach(function (t) {
        var vals = rows.filter(function (r) { return r.side === s && r.turn === t; }).map(function (r) { return r.raw_value; });
        perTurn[s][t] = vals.length ? mean(vals) : null;
      });
    });

    // cumulative (running) average from the first roll — not a fixed-size window — in
    // chronological roll order, so it shows the true average "as of" each point in the game.
    var rolling = {};
    SIDES.forEach(function (s) {
      var seq = rows.filter(function (r) { return r.side === s; }).map(function (r) { return r.raw_value; });
      var runningSum = 0;
      rolling[s] = seq.map(function (v, i) { runningSum += v; return runningSum / (i + 1); });
    });

    return {
      overallStats: overallStats, chi2: chi2, dist: dist, perCat: perCat, perRole: perRole,
      entRate: entRate, flankRate: flankRate,
      winTally: winTally, turns: turns, perTurn: perTurn, rolling: rolling,
      rollDiffHist: rollDiffHist, expVsActual: expVsActual, winTimeline: winTimeline,
      retreatBySide: retreatBySide, flankModifiers: flankModifiers, flankBySideMod: flankBySideMod,
      entrenchByNationality: entrenchByNationality,
      entrenchByTarget: entrenchByTarget, siegeByTarget: siegeByTarget,
      mandatedByTurn: mandatedByTurn, mandatedFrequency: mandatedFrequency,
    };
  }

  // ============================================================
  // ---------- tiny SVG chart builders ----------
  // ============================================================
  function svgBarOverall(stats, width, height) {
    width = width || 420; height = height || 220;
    var m = { l: 50, r: 20, t: 20, b: 40 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b, yMax = 6;
    function y(v) { return m.t + plotH - (v / yMax) * plotH; }
    var bw = plotW / 2 * 0.5;
    var xs = [m.l + plotW * 0.28, m.l + plotW * 0.72];
    var refY = y(3.5);
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Overall average roll per side">'];
    svg.push('<line x1="' + m.l + '" y1="' + y(0) + '" x2="' + (width - m.r) + '" y2="' + y(0) + '" stroke="currentColor" stroke-opacity="0.35"/>');
    svg.push('<line x1="' + m.l + '" y1="' + refY.toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + refY.toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 3"/>');
    svg.push('<text x="' + (width - m.r) + '" y="' + (refY - 4).toFixed(1) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.6">expected 3.5</text>');
    SIDES.forEach(function (s, i) {
      var v = stats.overallStats[s].mean;
      var x = xs[i] - bw / 2;
      var h = plotH - (y(v) - m.t);
      svg.push('<rect x="' + x.toFixed(1) + '" y="' + y(v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + SIDE_COLOR[s] + '" rx="3"/>');
      svg.push('<text x="' + xs[i].toFixed(1) + '" y="' + (y(v) - 8).toFixed(1) + '" font-size="13" text-anchor="middle" fill="currentColor" font-weight="600">' + fmt(v) + '</text>');
      svg.push('<text x="' + xs[i].toFixed(1) + '" y="' + (height - m.b + 18).toFixed(1) + '" font-size="12" text-anchor="middle" fill="currentColor">' + SIDE_NAME[s] + '</text>');
    });
    for (var gv = 0; gv <= 6; gv++) {
      svg.push('<text x="' + (m.l - 8) + '" y="' + (y(gv) + 4).toFixed(1) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.6">' + gv + '</text>');
    }
    svg.push('</svg>');
    return svg.join("");
  }

  function svgDistribution(stats, width, height) {
    width = width || 460; height = height || 240;
    var m = { l: 40, r: 20, t: 20, b: 36 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    var maxPct = 0;
    SIDES.forEach(function (s) {
      var n = stats.overallStats[s].n;
      for (var v = 1; v <= 6; v++) {
        var pct = n ? (stats.dist[s][v] || 0) / n : 0;
        if (pct > maxPct) maxPct = pct;
      }
    });
    maxPct = Math.max(maxPct, 1 / 6) * 1.15;
    function y(p) { return m.t + plotH - (p / maxPct) * plotH; }
    var groupW = plotW / 6, bw = groupW * 0.32;
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Roll distribution by side">'];
    var refY = y(1 / 6);
    svg.push('<line x1="' + m.l + '" y1="' + refY.toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + refY.toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 3"/>');
    svg.push('<text x="' + (width - m.r) + '" y="' + (refY - 4).toFixed(1) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.6">uniform 16.7%</text>');
    svg.push('<line x1="' + m.l + '" y1="' + y(0) + '" x2="' + (width - m.r) + '" y2="' + y(0) + '" stroke="currentColor" stroke-opacity="0.35"/>');
    for (var v = 1; v <= 6; v++) {
      var gx = m.l + (v - 1) * groupW;
      SIDES.forEach(function (s, i) {
        var n = stats.overallStats[s].n;
        var pct = n ? (stats.dist[s][v] || 0) / n : 0;
        var x = gx + groupW / 2 - bw + i * bw;
        var h = plotH - (y(pct) - m.t);
        svg.push('<rect x="' + x.toFixed(1) + '" y="' + y(pct).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + SIDE_COLOR[s] + '" rx="2"/>');
      });
      svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (height - m.b + 18).toFixed(1) + '" font-size="11" text-anchor="middle" fill="currentColor">' + v + '</text>');
    }
    svg.push('</svg>');
    return svg.join("");
  }

  function svgTrend(stats, width, height) {
    width = width || 760; height = height || 260;
    var m = { l: 40, r: 20, t: 20, b: 32 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b, yMin = 1, yMax = 6;
    function y(v) { return m.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }
    var turns = stats.turns;
    var span = Math.max(1, turns[turns.length - 1] - turns[0]);
    function xForTurn(t) { return m.l + (t - turns[0]) / span * plotW; }
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Average roll per turn over time">'];
    var refY = y(3.5);
    svg.push('<line x1="' + m.l + '" y1="' + refY.toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + refY.toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 3"/>');
    for (var gv = 1; gv <= 6; gv++) {
      svg.push('<text x="' + (m.l - 8) + '" y="' + (y(gv) + 4).toFixed(1) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.6">' + gv + '</text>');
      svg.push('<line x1="' + m.l + '" y1="' + y(gv).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + y(gv).toFixed(1) + '" stroke="currentColor" stroke-opacity="0.08"/>');
    }
    turns.forEach(function (t) {
      svg.push('<text x="' + xForTurn(t).toFixed(1) + '" y="' + (height - m.b + 18).toFixed(1) + '" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.7">' + t + '</text>');
    });
    // No connecting line — each turn's roll is an independent event, not a continuous
    // series; thick dots let you compare CP vs AP position on a given turn at a glance.
    SIDES.forEach(function (s) {
      var pts = turns.filter(function (t) { return stats.perTurn[s][t] !== null; })
        .map(function (t) { return [xForTurn(t), y(stats.perTurn[s][t])]; });
      pts.forEach(function (p) {
        svg.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="5.5" fill="' + SIDE_COLOR[s] + '"/>');
      });
    });
    svg.push('<text x="' + m.l + '" y="14" font-size="11" fill="currentColor" opacity="0.7">Turn →</text>');
    svg.push('</svg>');
    return svg.join("");
  }

  function svgRolling(stats, width, height) {
    width = width || 760; height = height || 220;
    var m = { l: 40, r: 20, t: 20, b: 28 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b, yMin = 1, yMax = 6;
    function y(v) { return m.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }
    function x(i, total) { return m.l + (i / Math.max(1, total - 1)) * plotW; }
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Cumulative average roll in roll sequence order">'];
    var refY = y(3.5);
    svg.push('<line x1="' + m.l + '" y1="' + refY.toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + refY.toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 3"/>');
    for (var gv = 1; gv <= 6; gv++) {
      svg.push('<text x="' + (m.l - 8) + '" y="' + (y(gv) + 4).toFixed(1) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.6">' + gv + '</text>');
      svg.push('<line x1="' + m.l + '" y1="' + y(gv).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + y(gv).toFixed(1) + '" stroke="currentColor" stroke-opacity="0.08"/>');
    }
    SIDES.forEach(function (s) {
      var seq = stats.rolling[s];
      var pts = seq.map(function (v, i) { return [x(i, seq.length), y(v)]; });
      var path = "M " + pts.map(function (p) { return p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" L ");
      svg.push('<path d="' + path + '" fill="none" stroke="' + SIDE_COLOR[s] + '" stroke-width="2"/>');
    });
    svg.push('<text x="' + m.l + '" y="14" font-size="11" fill="currentColor" opacity="0.7">Roll # (chronological) →</text>');
    svg.push('</svg>');
    return svg.join("");
  }

  function svgCategoryBars(stats, width, height) {
    width = width || 760; height = height || 260;
    var activeCats = CATS.filter(function (c) { return SIDES.some(function (s) { return stats.perCat[s][c].length; }); });
    var m = { l: 40, r: 20, t: 20, b: 56 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b, yMax = 6;
    function y(v) { return m.t + plotH - (v / yMax) * plotH; }
    var groupW = plotW / activeCats.length, bw = groupW * 0.32;
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Average roll by category and side">'];
    var refY = y(3.5);
    svg.push('<line x1="' + m.l + '" y1="' + refY.toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + refY.toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 3"/>');
    svg.push('<line x1="' + m.l + '" y1="' + y(0) + '" x2="' + (width - m.r) + '" y2="' + y(0) + '" stroke="currentColor" stroke-opacity="0.35"/>');
    for (var gv = 0; gv <= 6; gv++) {
      svg.push('<text x="' + (m.l - 8) + '" y="' + (y(gv) + 4).toFixed(1) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.6">' + gv + '</text>');
    }
    activeCats.forEach(function (c, ci) {
      var gx = m.l + ci * groupW;
      SIDES.forEach(function (s, i) {
        var vals = stats.perCat[s][c];
        var v = vals.length ? mean(vals) : 0;
        var x = gx + groupW / 2 - bw + i * bw;
        var h = plotH - (y(v) - m.t);
        svg.push('<rect x="' + x.toFixed(1) + '" y="' + y(v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + SIDE_COLOR[s] + '" rx="2" opacity="' + (vals.length ? 1 : 0.15) + '"/>');
        if (vals.length) {
          svg.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y(v) - 5).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="currentColor">' + fmt(v) + '</text>');
        }
      });
      svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (height - m.b + 16).toFixed(1) + '" font-size="10.5" text-anchor="middle" fill="currentColor">' + esc(CAT_NAME[c]) + '</text>');
      svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (height - m.b + 30).toFixed(1) + '" font-size="9" text-anchor="middle" fill="currentColor" opacity="0.6">n=' + stats.perCat.cp[c].length + '/' + stats.perCat.ap[c].length + '</text>');
    });
    svg.push('</svg>');
    return svg.join("");
  }

  /** Diverging histogram: per-combat (CP raw roll − AP raw roll), -5..+5. Positive = CP favored (cp color), negative = AP favored (ap color), 0 = neutral. */
  function svgRollDiffHistogram(stats, width, height) {
    width = width || 640; height = height || 240;
    var m = { l: 30, r: 30, t: 20, b: 40 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    var buckets = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
    var maxCount = Math.max(1, Math.max.apply(null, buckets.map(function (b) { return stats.rollDiffHist[b]; })));
    var groupW = plotW / buckets.length, bw = groupW * 0.62;
    var baseY = height - m.b;
    function h(v) { return (v / maxCount) * plotH; }
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Per-combat roll difference, CP minus AP">'];
    svg.push('<line x1="' + m.l + '" y1="' + baseY + '" x2="' + (width - m.r) + '" y2="' + baseY + '" stroke="currentColor" stroke-opacity="0.35"/>');
    buckets.forEach(function (b, i) {
      var count = stats.rollDiffHist[b];
      var barH = h(count);
      var x = m.l + i * groupW + (groupW - bw) / 2;
      var color = b > 0 ? SIDE_COLOR.cp : (b < 0 ? SIDE_COLOR.ap : "currentColor");
      var opacity = b === 0 ? 0.35 : 1;
      svg.push('<rect x="' + x.toFixed(1) + '" y="' + (baseY - barH).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + barH.toFixed(1) + '" fill="' + color + '" opacity="' + opacity + '" rx="2"/>');
      if (count) {
        svg.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (baseY - barH - 5).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="currentColor">' + count + '</text>');
      }
      var label = b === 0 ? "tie" : (b > 0 ? "+" + b : String(b));
      svg.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (baseY + 16).toFixed(1) + '" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.7">' + label + '</text>');
    });
    svg.push('<text x="' + m.l + '" y="' + (height - 4) + '" font-size="10.5" text-anchor="start" fill="' + SIDE_COLOR.ap + '">← AP rolled higher</text>');
    svg.push('<text x="' + (width - m.r) + '" y="' + (height - 4) + '" font-size="10.5" text-anchor="end" fill="' + SIDE_COLOR.cp + '">CP rolled higher →</text>');
    svg.push('</svg>');
    return svg.join("");
  }

  /** Win rate for combats resolved *in that turn* (not cumulative), per side — dots only, since each turn's rate is an independent value. */
  function svgWinRateTimeline(stats, width, height) {
    width = width || 760; height = height || 220;
    var m = { l: 40, r: 20, t: 20, b: 32 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    function y(v) { return m.t + plotH - (v / 100) * plotH; }
    var turns = stats.winTimeline.turns;
    if (!turns.length) return '<p class="note">No resolved combats to chart.</p>';
    var span = Math.max(1, turns[turns.length - 1] - turns[0]);
    function xForTurn(t) { return m.l + (t - turns[0]) / span * plotW; }
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Combat win rate per side, for the combats resolved on each turn">'];
    svg.push('<line x1="' + m.l + '" y1="' + y(50).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + y(50).toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 3"/>');
    [0, 25, 50, 75, 100].forEach(function (gv) {
      svg.push('<text x="' + (m.l - 8) + '" y="' + (y(gv) + 4).toFixed(1) + '" font-size="10" text-anchor="end" fill="currentColor" opacity="0.6">' + gv + '%</text>');
    });
    SIDES.forEach(function (s) {
      turns.forEach(function (t, i) {
        var v = stats.winTimeline[s][i];
        if (v === null) return;
        svg.push('<circle cx="' + xForTurn(t).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="5.5" fill="' + SIDE_COLOR[s] + '"/>');
      });
    });
    svg.push('<text x="' + m.l + '" y="14" font-size="11" fill="currentColor" opacity="0.7">Turn →</text>');
    svg.push('</svg>');
    return svg.join("");
  }

  /** Generic labeled success-rate bar chart, reused for flank/entrench/siege breakdowns. */
  function svgSuccessRateBars(buckets, color, width, height) {
    color = color || RATE_COLOR;
    width = width || 640; height = height || 220;
    var m = { l: 34, r: 20, t: 20, b: 52 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    function y(pctVal) { return m.t + plotH - (pctVal / 100) * plotH; }
    var groupW = plotW / Math.max(1, buckets.length), bw = groupW * 0.5;
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Success rate breakdown">'];
    svg.push('<line x1="' + m.l + '" y1="' + y(0).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + y(0).toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35"/>');
    [0, 25, 50, 75, 100].forEach(function (gv) {
      svg.push('<text x="' + (m.l - 6) + '" y="' + (y(gv) + 4).toFixed(1) + '" font-size="9.5" text-anchor="end" fill="currentColor" opacity="0.6">' + gv + '%</text>');
    });
    buckets.forEach(function (bkt, i) {
      var gx = m.l + i * groupW;
      var x = gx + groupW / 2 - bw / 2;
      if (bkt.rate === null) {
        svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (y(0) - 6).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="currentColor" opacity="0.4">n/a</text>');
      } else {
        var rate = pct(bkt.rate[0], bkt.rate[1]);
        var h = plotH - (y(rate) - m.t);
        svg.push('<rect x="' + x.toFixed(1) + '" y="' + y(rate).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + color + '" rx="2"/>');
        svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (y(rate) - 6).toFixed(1) + '" font-size="10" text-anchor="middle" fill="currentColor" font-weight="600">' + rate + '%</text>');
      }
      svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (height - m.b + 16).toFixed(1) + '" font-size="10" text-anchor="middle" fill="currentColor">' + esc(bkt.label) + '</text>');
      var breakdown = bkt.rate ? (bkt.rate[0] + " succ · " + (bkt.rate[1] - bkt.rate[0]) + " fail") : "n=0";
      svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (height - m.b + 30).toFixed(1) + '" font-size="9" text-anchor="middle" fill="currentColor" opacity="0.6">' + breakdown + '</text>');
    });
    svg.push('</svg>');
    return svg.join("");
  }

  /** One side's mandated-offensive die roll, one dot per turn (values are independent — no connecting line). Y-axis shows both the roll and the nation it assigns. */
  function svgMandatedByTurnSide(stats, side, width, height) {
    width = width || 640; height = height || 220;
    var m = { l: 70, r: 20, t: 20, b: 30 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b, yMin = 1, yMax = 6;
    function y(v) { return m.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }
    var turns = stats.mandatedByTurn.turns;
    if (!turns.length) return '<p class="note">No mandated offensive rolls to chart.</p>';
    // Domain runs 0..(last turn + 1), not first..last turn, so the row lines (which span the
    // full plot width) visibly extend past the leftmost/rightmost dots instead of touching them.
    var span = Math.max(1, turns[turns.length - 1] + 1);
    function xForTurn(t) { return m.l + t / span * plotW; }
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="' + esc(SIDE_NAME[side]) + ' mandated offensive roll per turn">'];
    for (var gv = 1; gv <= 6; gv++) {
      var nation = PogTables.MANDATED_OFFENSE_TABLE[side][gv];
      var nationColor = PogTables.MANDATED_OFFENSE_COLOR[nation];
      svg.push('<text x="' + (m.l - 6) + '" y="' + (y(gv) + 4).toFixed(1) + '" font-size="9.5" text-anchor="end" fill="currentColor" opacity="0.6">' + gv + ' – ' + esc(nation) + '</text>');
      if (nation === "AH (IT)") {
        // Split row: top half-bar in AH's color, bottom half-bar in IT's color — this row
        // means "AH attacks, targeting Italy specifically" so it's visually both nations.
        var ahColor = PogTables.MANDATED_OFFENSE_COLOR.AH, itColor = PogTables.MANDATED_OFFENSE_COLOR.IT;
        svg.push('<line x1="' + m.l + '" y1="' + (y(gv) - 2).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + (y(gv) - 2).toFixed(1) + '" stroke="' + ahColor + '" stroke-width="4" stroke-opacity="0.6"/>');
        svg.push('<line x1="' + m.l + '" y1="' + (y(gv) + 2).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + (y(gv) + 2).toFixed(1) + '" stroke="' + itColor + '" stroke-width="4" stroke-opacity="0.6"/>');
      } else {
        svg.push('<line x1="' + m.l + '" y1="' + y(gv).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + y(gv).toFixed(1) + '" stroke="' +
          (nationColor || "currentColor") + '" stroke-width="' + (nationColor ? 8 : 2) + '" stroke-opacity="' + (nationColor ? 0.6 : 0.08) + '"/>');
      }
    }
    turns.filter(function (t) { return stats.mandatedByTurn[side][t] !== undefined; }).forEach(function (t) {
      svg.push('<circle cx="' + xForTurn(t).toFixed(1) + '" cy="' + y(stats.mandatedByTurn[side][t]).toFixed(1) + '" r="7" fill="' + SIDE_COLOR[side] + '" stroke="#000" stroke-width="1.5"/>');
    });
    svg.push('<text x="' + m.l + '" y="14" font-size="11" fill="currentColor" opacity="0.7">Turn →</text>');
    svg.push('</svg>');
    return svg.join("");
  }

  /** Frequency of each table outcome for one side's mandated offensive rolls. */
  function svgOutcomeFrequency(freq, side, width, height) {
    width = width || 640; height = height || 200;
    var order = Object.keys(PogTables.MANDATED_OFFENSE_TABLE[side]).map(function (k) { return PogTables.MANDATED_OFFENSE_TABLE[side][k]; });
    var labels = Array.from(new Set(order));
    Object.keys(freq).forEach(function (k) { if (labels.indexOf(k) === -1) labels.push(k); });
    var m = { l: 30, r: 20, t: 20, b: 40 };
    var plotW = width - m.l - m.r, plotH = height - m.t - m.b;
    var maxCount = Math.max(1, Math.max.apply(null, labels.map(function (l) { return freq[l] || 0; })));
    function y(v) { return m.t + plotH - (v / maxCount) * plotH; }
    var groupW = plotW / Math.max(1, labels.length), bw = groupW * 0.55;
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="' + esc(SIDE_NAME[side]) + ' mandated offensive outcome frequency">'];
    svg.push('<line x1="' + m.l + '" y1="' + y(0).toFixed(1) + '" x2="' + (width - m.r) + '" y2="' + y(0).toFixed(1) + '" stroke="currentColor" stroke-opacity="0.35"/>');
    labels.forEach(function (label, i) {
      var count = freq[label] || 0;
      var gx = m.l + i * groupW;
      var x = gx + groupW / 2 - bw / 2;
      var h = plotH - (y(count) - m.t);
      svg.push('<rect x="' + x.toFixed(1) + '" y="' + y(count).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + SIDE_COLOR[side] + '" opacity="' + (count ? 1 : 0.15) + '" rx="2"/>');
      if (count) svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (y(count) - 5).toFixed(1) + '" font-size="10" text-anchor="middle" fill="currentColor">' + count + '</text>');
      svg.push('<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (height - m.b + 16).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="currentColor">' + esc(label) + '</text>');
    });
    svg.push('</svg>');
    return svg.join("");
  }

  // ============================================================
  // ---------- HTML table-row builders ----------
  // ============================================================
  function catCompareRows(stats) {
    return CATS.map(function (c) {
      var apV = stats.perCat.ap[c], cpV = stats.perCat.cp[c];
      return '<tr><td>' + CAT_NAME[c] + '</td>' +
        '<td>' + apV.length + '</td><td>' + (apV.length ? fmt(mean(apV)) : "—") + '</td>' +
        '<td>' + cpV.length + '</td><td>' + (cpV.length ? fmt(mean(cpV)) : "—") + '</td></tr>';
    }).join("");
  }

  function roleCompareRows(stats) {
    return SIDES.map(function (s) {
      var att = stats.perRole[s].attacker, deff = stats.perRole[s].defender;
      return '<tr><td>' + SIDE_NAME[s] + '</td>' +
        '<td>' + att.length + '</td><td>' + (att.length ? fmt(mean(att)) : "—") + '</td>' +
        '<td>' + deff.length + '</td><td>' + (deff.length ? fmt(mean(deff)) : "—") + '</td></tr>';
    }).join("");
  }

  function winRows(stats) {
    return SIDES.map(function (s) {
      var w = stats.winTally[s];
      var tot = w.win + w.tie + w.loss;
      return '<tr><td>' + SIDE_NAME[s] + '</td><td>' + w.win + '</td><td>' + w.tie + '</td><td>' + w.loss + '</td>' +
        '<td>' + (tot ? (w.win / tot * 100).toFixed(0) : "0") + '%</td></tr>';
    }).join("");
  }

  function retreatRows(stats) {
    return SIDES.map(function (s) {
      var r = stats.retreatBySide[s];
      return '<tr><td>' + SIDE_NAME[s] + '</td><td>' + r.forced1 + '</td><td>' + r.forced2 + '</td><td>' + r.canceled + '</td></tr>';
    }).join("");
  }

  /** Combats where this side won despite the CRT/stacks predicting the other side (or a tie). */
  /** "(2L)" / "(1R)", with the terrain/reason list as a hover title — or "" if no column shift applied. */
  // Short form only (e.g. "(2L)") — spelling out reasons inline made rows too wide, and a
  // hover title to hold the detail instead doesn't fire reliably in every context this
  // static report can end up embedded in (iframes, downloaded-and-reopened files, etc.).
  function shiftLabel(role) {
    if (!role.column_shift) return "";
    var dir = role.column_shift < 0 ? "L" : "R";
    return ' <span class="shift-note">(' + Math.abs(role.column_shift) + dir + ')</span>';
  }

  /** A combat card's straight bonus/penalty to the roll itself (e.g. "+1 Flamethrowers") — distinct from a column shift. */
  function dieModLabel(role) {
    if (!role.die_modifier) return "";
    var sign = role.die_modifier > 0 ? "+" : "";
    return ' <span class="shift-note">(' + sign + role.die_modifier + ')</span>';
  }

  function upsetDetailRows(details) {
    return details.map(function (d) {
      var att = d.attacker, def = d.defender;
      var expRatio = fmt(d.expAtt, 1) + ":" + fmt(d.expDef, 1);
      return '<tr><td>' + d.turn + '</td><td>' + esc(d.location) + '</td>' +
        '<td><span class="pill pill-' + att.side + '">' + att.side.toUpperCase() + '</span> ' + att.cf + ' CF (' + esc(att.force_type) + ')' + shiftLabel(att) + '</td>' +
        '<td>' + att.raw_value + dieModLabel(att) + '</td>' +
        '<td><span class="pill pill-' + def.side + '">' + def.side.toUpperCase() + '</span> ' + def.cf + ' CF (' + esc(def.force_type) + ')' + shiftLabel(def) + '</td>' +
        '<td>' + def.raw_value + dieModLabel(def) + '</td>' +
        '<td>' + esc(d.lossRatio) + '</td><td>' + expRatio + '</td>' +
        '<td>' + esc(d.expWinnerSide === "tie" ? "Tie" : SIDE_NAME[d.expWinnerSide]) + '</td></tr>';
    }).join("");
  }

  /** A collapsed-by-default detail table for one side's unexpected wins/ties — there can be several of these, so hide them behind a click. */
  function upsetDetailsSection(baseLabel, details) {
    if (!details.length) return '<h4>' + baseLabel + '</h4>\n<p class="note">None.</p>\n';
    return '<h4>' + baseLabel + ' (' + details.length + ')</h4>\n' +
      '<details class="cat-table"><summary><span class="count">click to expand table</span></summary>' +
      '<div class="table-wrap"><table><thead><tr><th>Turn</th><th>Location</th><th>Attacker</th><th>Roll</th>' +
      '<th>Defender</th><th>Roll</th><th>Loss ratio</th><th>Expected ratio</th><th>Expected winner</th></tr></thead>' +
      '<tbody>' + upsetDetailRows(details) + '</tbody></table></div></details>\n';
  }

  function flankModifierRows(stats) {
    var out = [];
    SIDES.forEach(function (s) {
      stats.flankModifiers.forEach(function (modKey) {
        var r = stats.flankBySideMod[s][modKey];
        var label = SIDE_NAME[s] + " — " + (modKey === "none" ? "no modifier" : modKey + " modifier");
        if (r === null) { out.push('<tr><td>' + label + '</td><td colspan="3">n/a</td></tr>'); return; }
        out.push('<tr><td>' + label + '</td><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + pct(r[0], r[1]) + '%</td></tr>');
      });
    });
    return out.join("");
  }

  function rateRows(rate, label) {
    return SIDES.map(function (s) {
      var r = rate[s];
      if (r === null) return '<tr><td>' + SIDE_NAME[s] + '</td><td colspan="3">no ' + label + ' attempts</td></tr>';
      return '<tr><td>' + SIDE_NAME[s] + '</td><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + pct(r[0], r[1]) + '%</td></tr>';
    }).join("");
  }

  function entrenchNationalityRows(bucketList) {
    return bucketList.map(function (b) {
      var r = b.rate, succ = r ? r[0] : 0, total = r ? r[1] : 0;
      return '<tr><td>' + esc(b.nationality) + '</td><td>' + b.target + '</td><td>' + succ + '</td><td>' + (total - succ) + '</td><td>' + total + '</td><td>' + (r ? pct(succ, total) : 0) + '%</td></tr>';
    }).join("");
  }

  function siegeTargetRows(bucketList) {
    return bucketList.map(function (b) {
      var r = b.rate, succ = r ? r[0] : 0, total = r ? r[1] : 0;
      return '<tr><td>' + b.cf + ' CF</td><td>' + succ + '</td><td>' + (total - succ) + '</td><td>' + total + '</td><td>' + (r ? pct(succ, total) : 0) + '%</td></tr>';
    }).join("");
  }

  function detailsTable(catLabel, catRows, showAttempt) {
    var cols = ["Turn", "Action", "Side", "Role", "Space"].concat(showAttempt ? ["Attempt #"] : [], ["Raw", "Modifier", "Effective", "Outcome"]);
    var head = cols.map(function (c) { return "<th>" + c + "</th>"; }).join("");
    var sorted = catRows.slice().sort(function (a, b) { return a.turn - b.turn || (a.action || 0) - (b.action || 0); });
    var bodyRows = sorted.map(function (r) {
      var sideLabel = r.side === "cp" ? "CP" : "AP";
      var attemptTd = showAttempt ? "<td>" + r.entrench_attempt_no + "</td>" : "";
      return '<tr><td>' + r.turn + '</td><td>' + (r.action || "–") + '</td>' +
        '<td><span class="pill pill-' + r.side + '">' + sideLabel + '</span></td>' +
        '<td>' + (esc(r.role) || "–") + '</td><td>' + (esc(r.space) || "–") + '</td>' + attemptTd +
        '<td>' + r.raw_value + '</td><td>' + (esc(r.modifier) || "–") + '</td>' +
        '<td>' + (esc(r.effective_value) || "–") + '</td><td>' + (esc(r.outcome) || "–") + '</td></tr>';
    }).join("");
    var n = catRows.length;
    return '<details class="cat-table"><summary>' + catLabel + ' <span class="count">(' + n +
      ' rolls — click to expand table)</span></summary><div class="table-wrap"><table><thead><tr>' +
      head + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div></details>';
  }

  /** Build the full self-contained report HTML string for a set of parsed rows + combats. */
  function buildReportHTML(rows, combats, meta) {
    combats = combats || [];
    meta = meta || {};
    var stats = buildStats(rows, combats);
    var overallDiff = stats.overallStats.cp.mean - stats.overallStats.ap.mean;
    // Reused by both the summary cards and the Combat section's tables below.
    var wt = stats.winTally;
    var ev = stats.expVsActual;

    var catRowsMap = {};
    CATS.forEach(function (c) { catRowsMap[c] = rows.filter(function (r) { return r.category === c; }); });

    var s = stats;
    var gameLabel = [meta.gameId ? "Game " + esc(meta.gameId) : "", meta.cpPlayer || meta.apPlayer ?
      esc(meta.cpPlayer || "?") + " (CP) vs " + esc(meta.apPlayer || "?") + " (AP)" : ""].filter(Boolean).join(" — ");

    return '<!doctype html>\n<html lang="en"><head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>Paths of Glory — Dice Analysis</title>\n<style>\n' +
      ':root {\n  --bg: #f7f5f1; --panel: #ffffff; --text: #1f2328; --muted: #5b6570; --border: #dfd9cf;\n' +
      '  --cp: ' + SIDE_COLOR.cp + '; --ap: ' + SIDE_COLOR.ap + '; --accent: ' + RATE_COLOR + ';\n}\n' +
      '@media (prefers-color-scheme: dark) {\n  :root { --bg: #16181c; --panel: #1e2126; --text: #e7e6e2; --muted: #9aa2ab; --border: #33383f; }\n}\n' +
      ':root[data-theme="dark"] { --bg: #16181c; --panel: #1e2126; --text: #e7e6e2; --muted: #9aa2ab; --border: #33383f; }\n' +
      ':root[data-theme="light"] { --bg: #f7f5f1; --panel: #ffffff; --text: #1f2328; --muted: #5b6570; --border: #dfd9cf; }\n' +
      '* { box-sizing: border-box; }\n' +
      'body { margin:0; background:var(--bg); color:var(--text); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; line-height:1.5; }\n' +
      'main { max-width: 1100px; margin: 0 auto; padding: 32px 10px 80px; }\n' +
      'h1 { font-size: 1.6rem; margin-bottom:4px; }\n' +
      'h2 { font-size: 1.3rem; margin-top: 52px; padding-bottom:6px; border-bottom: 2px solid var(--text); }\n' +
      'h3 { font-size: 1.05rem; margin-top: 32px; border-bottom: 1px solid var(--border); padding-bottom:6px; }\n' +
      'h2, h3 { scroll-margin-top: 16px; }\n' +
      'h4 { font-size: .82rem; margin: 22px 0 6px; color: var(--muted); text-transform:uppercase; letter-spacing:.04em; }\n' +
      '.toc { margin: 16px 0 0; padding: 12px 18px; background:var(--panel); border:1px solid var(--border); border-radius:8px; font-size:.88rem; }\n' +
      '.toc a { color: var(--text); text-decoration: none; border-bottom: 1px dotted var(--muted); }\n' +
      '.toc a:hover { border-bottom-style: solid; }\n' +
      '.subtitle { color: var(--muted); margin-top:0; margin-bottom: 28px; }\n' +
      '.cards { display:flex; gap:16px; flex-wrap:wrap; margin: 18px 0; }\n' +
      '.card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px 20px; flex:1; min-width:200px; }\n' +
      '.card .big { font-size: 1.7rem; font-weight:700; }\n' +
      '.card .lbl { color:var(--muted); font-size:.82rem; text-transform:uppercase; letter-spacing:.03em; }\n' +
      '.cp-accent { border-top: 3px solid var(--cp); }\n.ap-accent { border-top: 3px solid var(--ap); }\n' +
      '.panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px; margin: 14px 0; overflow-x:auto; }\n' +
      'table { border-collapse: collapse; width:100%; font-size:.9rem; }\n' +
      'th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); white-space:nowrap; }\n' +
      'th { color:var(--muted); font-weight:600; font-size:.78rem; text-transform:uppercase; letter-spacing:.02em; }\n' +
      '.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:.75rem; font-weight:700; color:#fff; }\n' +
      '.pill-cp { background:var(--cp); }\n.pill-ap { background:var(--ap); }\n' +
      '.shift-note { color:var(--muted); font-size:.85em; }\n' +
      '.legend { display:flex; gap:18px; font-size:.85rem; color:var(--muted); margin-top:6px; flex-wrap:wrap; }\n' +
      '.legend span.dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; }\n' +
      '.chart-wrap { display:flex; justify-content:center; }\n' +
      'details.cat-table { margin: 10px 0; }\n' +
      'details.cat-table summary { cursor:pointer; font-weight:600; padding:8px 0; }\n' +
      'details.cat-table .count { font-weight:400; color:var(--muted); font-size:.85rem; }\n' +
      '.table-wrap { max-height: 420px; overflow:auto; margin-top:8px; border:1px solid var(--border); border-radius:8px; }\n' +
      'p.note { color:var(--muted); font-size:.88rem; }\n' +
      '.section-intro { color:var(--muted); font-size:.92rem; margin-top:-4px; }\n' +
      'footer { color:var(--muted); font-size:.8rem; margin-top:50px; }\n' +
      '</style>\n</head>\n<body>\n<main>\n' +
      '<h1>Paths of Glory — Dice Analysis</h1>\n' +
      '<p class="subtitle">' + rows.length + ' die rolls parsed from the game log' + (gameLabel ? ' · ' + gameLabel : '') + '</p>\n' +

      // ---------------- SUMMARY ----------------
      '<h2 id="summary">About This Report</h2>\n' +
      '<p>This report offers a look at how dice results compare across different targets — Combat, Entrench, Siege,\n' +
      'and Mandated Offensive — based on the game log you uploaded. It\'s just for fun: the numbers below are laid\n' +
      'out for browsing, not to render a verdict on either side\'s luck. Use the links below to jump to a section.</p>\n' +
      '<nav class="toc"><strong>Jump to:</strong> ' +
      '<a href="#raw-averages">Raw Averages</a> · <a href="#combat">Combat</a> · <a href="#entrench">Entrench</a> · ' +
      '<a href="#siege">Siege</a> · <a href="#mandated-offensive">Mandated Offensive</a></nav>\n' +

      // ---------------- RAW AVERAGES ----------------
      '<h2 id="raw-averages">Raw Averages</h2>\n' +
      '<div class="cards">\n' +
      '  <div class="card ap-accent"><div class="lbl">Allied Powers avg roll</div><div class="big">' + fmt(s.overallStats.ap.mean) + '</div>' +
      '<div class="lbl">n=' + s.overallStats.ap.n + ' · σ=' + fmt(s.overallStats.ap.std) + '</div></div>\n' +
      '  <div class="card cp-accent"><div class="lbl">Central Powers avg roll</div><div class="big">' + fmt(s.overallStats.cp.mean) + '</div>' +
      '<div class="lbl">n=' + s.overallStats.cp.n + ' · σ=' + fmt(s.overallStats.cp.std) + '</div></div>\n' +
      '  <div class="card"><div class="lbl">Expected (fair d6)</div><div class="big">3.50</div>' +
      '<div class="lbl">both sides within ' + fmt(Math.abs(overallDiff)) + ' of this</div></div>\n' +
      '  <div class="card"><div class="lbl">Combats resolved</div><div class="big">' + (wt.cp.win + wt.cp.tie + wt.cp.loss) + '</div>' +
      '<div class="lbl">AP ' + wt.ap.win + 'W–' + wt.ap.tie + 'T–' + wt.ap.loss + 'L</div></div>\n' +
      '</div>\n' +
      '<p class="section-intro">Every roll of the game, both sides pooled together regardless of what the roll was\n' +
      'for, averaged and compared against the fair-die expectation of 3.5.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgBarOverall(s) + '</div></div>\n' +
      '<h3>Distribution — how close to random?</h3>\n' +
      '<p class="note">Each side\'s rolls broken out 1–6, as a share of that side\'s total rolls, against the 16.7% a\n' +
      'perfectly fair die would produce. A chi-square goodness-of-fit test (critical value ' + CHI2_CRIT_05 + ' at p=0.05,\n' +
      '5 degrees of freedom) flags whether a side\'s distribution is statistically distinguishable from uniform.</p>\n' +
      '<div class="panel">\n  <div class="chart-wrap">' + svgDistribution(s) + '</div>\n  <div class="legend">\n' +
      '    <span><span class="dot" style="background:var(--ap)"></span>Allied Powers (χ²=' + fmt(s.chi2.ap) + ')</span>\n' +
      '    <span><span class="dot" style="background:var(--cp)"></span>Central Powers (χ²=' + fmt(s.chi2.cp) + ')</span>\n' +
      '  </div>\n</div>\n' +
      '<h3>Average roll over time</h3>\n' +
      '<p class="note">Average roll per turn, one dot per side — no connecting line, since each turn\'s average is\n' +
      'its own independent event. Compare the two dots\' height on a given turn to see who rolled higher.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgTrend(s) + '</div>\n  <div class="legend">\n' +
      '    <span><span class="dot" style="background:var(--ap)"></span>Allied Powers</span>\n' +
      '    <span><span class="dot" style="background:var(--cp)"></span>Central Powers</span>\n  </div>\n</div>\n' +
      '<p class="note">Cumulative (running) average from the first roll, in actual chronological roll order — every\n' +
      'category mixed together as it happened — showing how each side\'s average has settled over the course of the\n' +
      'game.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgRolling(s) + '</div></div>\n' +
      '<h3>By category</h3>\n' +
      '<p class="note">Average roll broken out by what the roll was <em>for</em>. Faint bars mean that side made no\n' +
      'rolls in that category. Each category gets its own detailed section below.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgCategoryBars(s) + '</div>\n  <div class="legend">\n' +
      '    <span><span class="dot" style="background:var(--ap)"></span>Allied Powers</span>\n' +
      '    <span><span class="dot" style="background:var(--cp)"></span>Central Powers</span>\n  </div>\n</div>\n' +
      '<p class="note">Same category breakdown as the chart above, as roll counts and averages.</p>\n' +
      '<div class="panel"><table><thead><tr><th>Category</th><th>AP n</th><th>AP avg</th><th>CP n</th><th>CP avg</th></tr></thead>' +
      '<tbody>' + catCompareRows(s) + '</tbody></table></div>\n' +

      // ---------------- COMBAT ----------------
      '<h2 id="combat">Combat</h2>\n' +
      '<p class="section-intro">High combat rolls are always better, but the outcome depends on many factors including \n' +
      'relative strengths of the forces involved, terrain and modifiers, and specific circumstances of each engagement.</p>\n' +
      '<h3>Roll difference, per combat</h3>\n' +
      '<p class="note">CP\'s raw roll minus AP\'s raw roll in each combat, regardless of who attacked or defended —\n' +
      'the "higher is better" head-to-head view, independent of Combat Factors.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgRollDiffHistogram(s) + '</div></div>\n' +
      '<h3>Combat outcomes</h3>\n' +
      '<p class="note">Win/tie/loss per side, straight from the game\'s own "X:Y victory" result for each combat.</p>\n' +
      '<div class="panel"><table><thead><tr><th>Side</th><th>Wins</th><th>Ties</th><th>Losses</th><th>Win rate</th></tr></thead>' +
      '<tbody>' + winRows(s) + '</tbody></table></div>\n' +
      '<h3>Expected vs. actual losses</h3>\n' +
      '<p class="note">For each combat, "expected" losses can be determined from the Combat Results Table using an\n' +
      'with each side\'s strength with column shift and die modifier applied to an average die value (roll of 3.5).</p>\n' +
      '<p class="note">→ <b>Unexpected wins</b> occur when the dice favor the weaker side, allowing them to win a battle\n' +
      'and inflict higher losses on their opponent, despite the odds.</p>\n' +
      '<p class="note">→ <b>Underdog ties</b> occur when one side was expected to win outright, but the actual result was a tie\n' +
      'instead - typically a boon to the weaker side who fought to a draw instead of losing.</p>\n' +
      '<div class="panel"><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>' +
      '<tr><td>Combats compared</td><td>' + ev.comparable + '</td></tr>' +
      '<tr><td>Went against the expected winner</td><td>' + ev.upsetCount + ' (' + pct(ev.upsetCount, ev.comparable) + '%)</td></tr>' +
      '<tr><td>Unexpected wins — Allied Powers</td><td>' + ev.upsetsBySide.ap + '</td></tr>' +
      '<tr><td>Underdog ties — Allied Powers</td><td>' + ev.underdogTiesBySide.ap + '</td></tr>' +
      '<tr><td>Unexpected wins — Central Powers</td><td>' + ev.upsetsBySide.cp + '</td></tr>' +
      '<tr><td>Underdog ties — Central Powers</td><td>' + ev.underdogTiesBySide.cp + '</td></tr>' +
      '</tbody></table></div>\n' +
      SIDES.map(function (sd) {
        return upsetDetailsSection("Unexpected wins — " + SIDE_NAME[sd], ev.upsetDetails[sd]) +
          upsetDetailsSection("Underdog ties — " + SIDE_NAME[sd], ev.underdogTieDetails[sd]);
      }).join("") +
      '<h3>Win rate over time</h3>\n' +
      '<p class="note">One dot per side per turn — the win rate for just the combats resolved <em>that</em> turn, not\n' +
      'a running total, so a single lopsided turn doesn\'t linger in the chart.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgWinRateTimeline(s) + '</div>\n  <div class="legend">\n' +
      '    <span><span class="dot" style="background:var(--ap)"></span>Allied Powers</span>\n' +
      '    <span><span class="dot" style="background:var(--cp)"></span>Central Powers</span>\n  </div>\n</div>\n' +
      '<h3>Retreats</h3>\n' +
      '<p class="note">How often each side was forced to retreat by a lost combat, and how many of those retreats\n' +
      'were canceled (taking extra losses to hold the space instead).</p>\n' +
      '<div class="panel"><table><thead><tr><th>Side</th><th>Forced — 1 space</th><th>Forced — 2 spaces</th><th>Canceled</th></tr></thead>' +
      '<tbody>' + retreatRows(s) + '</tbody></table></div>\n' +
      '<h3>Attacker vs. defender</h3>\n' +
      '<p class="note">Does either side roll better when attacking than when defending?</p>\n' +
      '<div class="panel"><table><thead><tr><th>Side</th><th>Attacker n</th><th>Attacker avg</th><th>Defender n</th><th>Defender avg</th></tr></thead>' +
      '<tbody>' + roleCompareRows(s) + '</tbody></table></div>\n' +
      '<h3>Flank attempts</h3>\n' +
      '<p class="note">A flank attempt lets the attacker inflict losses before the defender can return fire. It\n' +
      'succeeds on a modified roll of 4 or higher, broken out here by side and by the modifier in play.</p>\n' +
      '<div class="panel"><table><thead><tr><th>Side / modifier</th><th>Succeeded</th><th>Total</th><th>Rate</th></tr></thead>' +
      '<tbody>' + flankModifierRows(s) + '</tbody></table></div>\n' +

      // ---------------- ENTRENCH ----------------
      '<h2 id="entrench">Entrench</h2>\n' +
      '<p class="section-intro">Entrenching requires a roll at or under the attempting Army\'s loss factor (a\n' +
      'modifier sometimes relaxes that target by 1).</p>\n' +
      '<div class="panel"><table><thead><tr><th>Entrench attempts</th><th>Succeeded</th><th>Total</th><th>Rate</th></tr></thead>' +
      '<tbody>' + rateRows(s.entRate, "entrench") + '</tbody></table></div>\n' +
      '<h3>By nationality</h3>\n' +
      SIDES.map(function (sd) {
        return '<h4>' + SIDE_NAME[sd] + '</h4>\n<div class="panel"><table><thead><tr><th>Nationality</th><th>Target Roll</th>' +
          '<th>Succeeded</th><th>Failed</th><th>Total</th><th>Rate</th></tr></thead>' +
          '<tbody>' + entrenchNationalityRows(s.entrenchByNationality[sd]) + '</tbody></table></div>\n';
      }).join("") +
      '<h3>By target value</h3>\n' +
      '<p class="note">Target value on the raw entrench roll, after folding in any roll modifier (e.g. a loss factor of 3 with a\n' +
      '−1 modifier tests against an effective target of 4).</p>\n' +
      SIDES.map(function (sd) {
        return '<h4>' + SIDE_NAME[sd] + '</h4>\n<div class="panel"><div class="chart-wrap">' +
          svgSuccessRateBars(s.entrenchByTarget[sd].map(function (b) { return { label: "≤" + b.effectiveTarget, rate: b.rate }; }), SIDE_COLOR[sd]) +
          '</div></div>\n';
      }).join("") +

      // ---------------- SIEGE ----------------
      '<h2 id="siege">Siege</h2>\n' +
      '<p class="section-intro">A single roll against a fort space\'s Combat Factor at the end of a turn; a\n' +
      'modified roll higher than the CF destroys the fort.</p>\n' +
      '<div class="panel"><table><thead><tr><th>Side</th><th>n</th><th>Average roll</th></tr></thead><tbody>' +
      SIDES.map(function (sd) { var vals = s.perCat[sd].siege; return '<tr><td>' + SIDE_NAME[sd] + '</td><td>' + vals.length + '</td><td>' + (vals.length ? fmt(mean(vals)) : "—") + '</td></tr>'; }).join("") +
      '</tbody></table></div>\n' +
      '<h3>Success rate by target value</h3>\n' +
      '<p class="note">Combined CP+AP numbers hide which side is actually sieging well, so this is split per side.</p>\n' +
      SIDES.map(function (sd) {
        return '<h4>' + SIDE_NAME[sd] + '</h4>\n<div class="panel"><table><thead><tr><th>Target (space CF)</th><th>Succeeded</th>' +
          '<th>Failed</th><th>Total</th><th>Rate</th></tr></thead><tbody>' + siegeTargetRows(s.siegeByTarget[sd]) + '</tbody></table></div>\n';
      }).join("") +

      // ---------------- MANDATED OFFENSIVE ----------------
      '<h2 id="mandated-offensive">Mandated Offensive</h2>\n' +
      '<p class="section-intro">Rolled once per side at the start of every turn to assign which power must attack.\n' +
      'Low rolls tend to favor AP, high rolls tend to favor CP, though the exact effect is situational (and the\n' +
      'August 1914 turn is exempt). Each roll is independent, so turns are plotted as dots, not a connected line.</p>\n' +
      SIDES.map(function (sd) {
        return '<h4>' + SIDE_NAME[sd] + '</h4>\n<div class="panel"><div class="chart-wrap">' +
          svgMandatedByTurnSide(s, sd) + '</div></div>\n';
      }).join("") +
      '<h3>Outcome frequency</h3>\n' +
      '<p class="note">How often each possible table outcome (the nation directed to attack, or another effect)\n' +
      'came up across this side\'s mandated offensive rolls.</p>\n' +
      SIDES.map(function (sd) {
        return '<h4>' + SIDE_NAME[sd] + '</h4>\n<div class="panel"><div class="chart-wrap">' +
          svgOutcomeFrequency(s.mandatedFrequency[sd], sd) + '</div></div>\n';
      }).join("") +

      '<h2>Full roll data by category</h2>\n' +
      '<p class="note">Every parsed roll, grouped by category, for auditing the numbers above. The Entrench table\n' +
      'includes the per-space attempt number (kept for reference, not used in the success-rate split above).</p>\n' +
      CATS.map(function (c) { return detailsTable(CAT_NAME[c], catRowsMap[c], c === "entrench"); }).join("\n") + '\n' +
      '<footer>\nGenerated entirely in your browser — no file was uploaded anywhere. ' + rows.length + ' rows parsed' +
      (combats.length ? ', ' + combats.length + ' combats resolved' : '') + '.\n' +
      'Raw d6 value is always the physical roll; "modifier"/"effective" reflect in-game bonuses/penalties applied on top.\n' +
      '</footer>\n</main>\n' +
      // This report is normally embedded via <iframe srcdoc>, whose document URL is
      // "about:srcdoc" — but browsers resolve a plain href="#combat" against the *parent
      // page's* URL, not that. Clicking the TOC then isn't a same-document fragment
      // scroll: it's a real navigation to "<parent page URL>#combat", which the iframe
      // dutifully fetches, replacing the report with a fresh copy of the app shell (the
      // upload prompt). Intercept in-page anchor clicks and scroll manually instead of
      // letting the browser resolve/navigate them at all.
      '<script>\n' +
      '(function () {\n' +
      '  document.addEventListener("click", function (e) {\n' +
      '    var a = e.target.closest("a[href^=\\"#\\"]");\n' +
      '    if (!a || a.getAttribute("href").length < 2) return;\n' +
      '    var target = document.getElementById(a.getAttribute("href").slice(1));\n' +
      '    if (!target) return;\n' +
      '    e.preventDefault();\n' +
      '    target.scrollIntoView({ behavior: "smooth", block: "start" });\n' +
      '  });\n' +
      '})();\n' +
      '</script>\n' +
      '</body></html>';
  }

  var api = { buildStats: buildStats, buildReportHTML: buildReportHTML, SIDES: SIDES, CATS: CATS, CAT_NAME: CAT_NAME };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PogReport = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
