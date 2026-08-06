/**
 * Compute dice-roll stats from parsed rows and render a self-contained HTML
 * report string. Direct port of build_report.py — see that file (and
 * PROCESS.md) in ~/paths_of_glory_dice_analysis/ for the reference
 * implementation. Keep the two in sync when either changes.
 *
 * Pure functions, no DOM dependency — `buildReportHTML` returns an HTML
 * *string* (same as the Python version writing report.html), so this module
 * works identically under Node (for test/run.js) or in a browser, where the
 * caller just does `container.innerHTML = buildReportHTML(rows)`.
 */
(function (root) {
  "use strict";

  var SIDES = ["cp", "ap"];
  var SIDE_NAME = { cp: "Central Powers", ap: "Allied Powers" };
  var SIDE_COLOR = { cp: "#b1494a", ap: "#3d6da8" };
  var CAT_NAME = {
    mandated_offensive: "Mandated Offensive",
    combat_fire: "Combat Fire",
    entrench: "Entrench",
    flank: "Flank Attempt",
    siege: "Siege",
  };
  var CATS = ["mandated_offensive", "combat_fire", "entrench", "flank", "siege"];
  var CHI2_CRIT_05 = 11.07; // df=5, p=0.05
  var WINDOW = 12; // rolling-average window, in rolls

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

  /** Compute every stat used by the report, from the parsed rows array. */
  function buildStats(rows) {
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

    var allEnt = rows.filter(function (r) { return r.category === "entrench"; });
    var entRateBySideMod = {};
    SIDES.forEach(function (s) {
      [false, true].forEach(function (mod) {
        var items = allEnt.filter(function (r) { return r.side === s && Boolean(r.modifier) === mod; });
        entRateBySideMod[s + "|" + mod] = successRate(items);
      });
    });

    // combat win/loss: group combat_fire rows by (turn, action, space)
    var combats = {};
    rows.filter(function (r) { return r.category === "combat_fire"; }).forEach(function (r) {
      var key = r.turn + "|" + r.action + "|" + r.space;
      combats[key] = combats[key] || {};
      combats[key][r.role] = r;
    });
    var winTally = {};
    SIDES.forEach(function (s) { winTally[s] = { win: 0, tie: 0, loss: 0 }; });
    Object.keys(combats).forEach(function (key) {
      var roles = combats[key];
      if (!roles.attacker || !roles.defender) return;
      var av = parseInt(roles.attacker.effective_value, 10), dv = parseInt(roles.defender.effective_value, 10);
      if (isNaN(av) || isNaN(dv)) return;
      var attSide = roles.attacker.side, defSide = roles.defender.side;
      if (av > dv) { winTally[attSide].win++; winTally[defSide].loss++; }
      else if (av < dv) { winTally[defSide].win++; winTally[attSide].loss++; }
      else { winTally[attSide].tie++; winTally[defSide].tie++; }
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

    var rolling = {};
    SIDES.forEach(function (s) {
      var seq = rows.filter(function (r) { return r.side === s; }).map(function (r) { return r.raw_value; });
      rolling[s] = seq.map(function (_, i) {
        var w = seq.slice(Math.max(0, i - WINDOW + 1), i + 1);
        return mean(w);
      });
    });

    return {
      overallStats: overallStats, chi2: chi2, dist: dist, perCat: perCat, perRole: perRole,
      entRate: entRate, flankRate: flankRate, entRateBySideMod: entRateBySideMod,
      winTally: winTally, turns: turns, perTurn: perTurn, rolling: rolling,
    };
  }

  // ============================================================
  // ---------- tiny SVG chart builders (mirror the Python versions) ----------
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
    SIDES.forEach(function (s) {
      var pts = turns.filter(function (t) { return stats.perTurn[s][t] !== null; })
        .map(function (t) { return [xForTurn(t), y(stats.perTurn[s][t])]; });
      var path = "M " + pts.map(function (p) { return p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" L ");
      svg.push('<path d="' + path + '" fill="none" stroke="' + SIDE_COLOR[s] + '" stroke-width="2.5"/>');
      pts.forEach(function (p) {
        svg.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3" fill="' + SIDE_COLOR[s] + '"/>');
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
    var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px" role="img" aria-label="Rolling average roll (window=' + WINDOW + ') in roll sequence order">'];
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

  // ============================================================
  // ---------- HTML table-row builders ----------
  // ============================================================
  function catCompareRows(stats) {
    return CATS.map(function (c) {
      var cpV = stats.perCat.cp[c], apV = stats.perCat.ap[c];
      return '<tr><td>' + CAT_NAME[c] + '</td>' +
        '<td>' + cpV.length + '</td><td>' + (cpV.length ? fmt(mean(cpV)) : "—") + '</td>' +
        '<td>' + apV.length + '</td><td>' + (apV.length ? fmt(mean(apV)) : "—") + '</td></tr>';
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

  function entrenchModifierRows(stats) {
    function row(label, r) {
      if (r === null) return '<tr><td>' + label + '</td><td colspan="3">n/a</td></tr>';
      var succ = r[0], n = r[1];
      return '<tr><td>' + label + '</td><td>' + succ + '</td><td>' + n + '</td><td>' + (succ / n * 100).toFixed(0) + '%</td></tr>';
    }
    var out = [];
    SIDES.forEach(function (s) {
      [[false, "no modifier"], [true, "with modifier"]].forEach(function (pair) {
        out.push(row(SIDE_NAME[s] + " — " + pair[1], stats.entRateBySideMod[s + "|" + pair[0]]));
      });
    });
    return out.join("");
  }

  function rateRows(rate, label) {
    return SIDES.map(function (s) {
      var r = rate[s];
      if (r === null) return '<tr><td>' + SIDE_NAME[s] + '</td><td colspan="3">no ' + label + ' attempts</td></tr>';
      var succ = r[0], n = r[1];
      return '<tr><td>' + SIDE_NAME[s] + '</td><td>' + succ + '</td><td>' + n + '</td><td>' + (succ / n * 100).toFixed(0) + '%</td></tr>';
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

  /** Build the full self-contained report HTML string for a set of parsed rows. */
  function buildReportHTML(rows) {
    var stats = buildStats(rows);
    var overallDiff = stats.overallStats.cp.mean - stats.overallStats.ap.mean;
    var betterSide = overallDiff > 0 ? "cp" : (overallDiff < 0 ? "ap" : null);

    var verdictBits = [];
    if (Math.abs(overallDiff) < 0.15) {
      verdictBits.push(
        "Overall raw die averages are nearly identical (CP " + fmt(stats.overallStats.cp.mean) + " vs " +
        "AP " + fmt(stats.overallStats.ap.mean) + ", both close to the fair-die expectation of 3.5), and neither " +
        "side's distribution is far enough from uniform to call the dice themselves biased " +
        "(chi-square " + fmt(stats.chi2.cp) + " / " + fmt(stats.chi2.ap) + ", critical value at p=0.05 is " + CHI2_CRIT_05 + ")."
      );
    } else {
      var lead = SIDE_NAME[betterSide];
      var other = betterSide === "cp" ? "ap" : "cp";
      verdictBits.push(
        lead + " has rolled noticeably higher on average (" + fmt(stats.overallStats[betterSide].mean) + " vs " +
        fmt(stats.overallStats[other].mean) + "), though with only " +
        (stats.overallStats.cp.n + stats.overallStats.ap.n) + " rolls total this could still be within normal variance."
      );
    }
    var wt = stats.winTally;
    verdictBits.push(
      "Where the two sides really diverge is combat <em>outcomes</em>: " + SIDE_NAME.cp + " has won " +
      wt.cp.win + " of " + (wt.cp.win + wt.cp.tie + wt.cp.loss) +
      " resolved combats to " + SIDE_NAME.ap + "'s " + wt.ap.win + ". That's driven as much by Combat Factor " +
      "totals (bigger stacks push the CRT result up almost regardless of the roll) as by the dice, so treat it as " +
      "a \"how the war is going\" number, not a pure luck number — the raw averages above are the fairer luck comparison."
    );
    var verdict = verdictBits.join(" ");

    var catRowsMap = {};
    CATS.forEach(function (c) { catRowsMap[c] = rows.filter(function (r) { return r.category === c; }); });

    var s = stats;
    return '<!doctype html>\n<html lang="en"><head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>Paths of Glory — Dice Analysis</title>\n<style>\n' +
      ':root {\n  --bg: #f7f5f1; --panel: #ffffff; --text: #1f2328; --muted: #5b6570; --border: #dfd9cf;\n' +
      '  --cp: ' + SIDE_COLOR.cp + '; --ap: ' + SIDE_COLOR.ap + ';\n}\n' +
      '@media (prefers-color-scheme: dark) {\n  :root { --bg: #16181c; --panel: #1e2126; --text: #e7e6e2; --muted: #9aa2ab; --border: #33383f; }\n}\n' +
      ':root[data-theme="dark"] { --bg: #16181c; --panel: #1e2126; --text: #e7e6e2; --muted: #9aa2ab; --border: #33383f; }\n' +
      ':root[data-theme="light"] { --bg: #f7f5f1; --panel: #ffffff; --text: #1f2328; --muted: #5b6570; --border: #dfd9cf; }\n' +
      '* { box-sizing: border-box; }\n' +
      'body { margin:0; background:var(--bg); color:var(--text); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; line-height:1.5; }\n' +
      'main { max-width: 900px; margin: 0 auto; padding: 32px 20px 80px; }\n' +
      'h1 { font-size: 1.6rem; margin-bottom:4px; }\n' +
      'h2 { font-size: 1.15rem; margin-top: 40px; border-bottom: 1px solid var(--border); padding-bottom:8px; }\n' +
      '.subtitle { color: var(--muted); margin-top:0; margin-bottom: 28px; }\n' +
      '.cards { display:flex; gap:16px; flex-wrap:wrap; margin: 18px 0; }\n' +
      '.card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px 20px; flex:1; min-width:200px; }\n' +
      '.card .big { font-size: 1.7rem; font-weight:700; }\n' +
      '.card .lbl { color:var(--muted); font-size:.82rem; text-transform:uppercase; letter-spacing:.03em; }\n' +
      '.cp-accent { border-top: 3px solid var(--cp); }\n.ap-accent { border-top: 3px solid var(--ap); }\n' +
      '.panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin: 14px 0; overflow-x:auto; }\n' +
      'table { border-collapse: collapse; width:100%; font-size:.9rem; }\n' +
      'th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--border); white-space:nowrap; }\n' +
      'th { color:var(--muted); font-weight:600; font-size:.78rem; text-transform:uppercase; letter-spacing:.02em; }\n' +
      '.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:.75rem; font-weight:700; color:#fff; }\n' +
      '.pill-cp { background:var(--cp); }\n.pill-ap { background:var(--ap); }\n' +
      '.legend { display:flex; gap:18px; font-size:.85rem; color:var(--muted); margin-top:6px; }\n' +
      '.legend span.dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; }\n' +
      '.chart-wrap { display:flex; justify-content:center; }\n' +
      'details.cat-table { margin: 10px 0; }\n' +
      'details.cat-table summary { cursor:pointer; font-weight:600; padding:8px 0; }\n' +
      'details.cat-table .count { font-weight:400; color:var(--muted); font-size:.85rem; }\n' +
      '.table-wrap { max-height: 420px; overflow:auto; margin-top:8px; border:1px solid var(--border); border-radius:8px; }\n' +
      'p.note { color:var(--muted); font-size:.88rem; }\n' +
      'footer { color:var(--muted); font-size:.8rem; margin-top:50px; }\n' +
      '</style>\n</head>\n<body>\n<main>\n' +
      '<h1>Paths of Glory — Dice Analysis</h1>\n' +
      '<p class="subtitle">' + rows.length + ' die rolls parsed from the game log</p>\n' +
      '<div class="cards">\n' +
      '  <div class="card cp-accent"><div class="lbl">Central Powers avg roll</div><div class="big">' + fmt(s.overallStats.cp.mean) + '</div>' +
      '<div class="lbl">n=' + s.overallStats.cp.n + ' · σ=' + fmt(s.overallStats.cp.std) + '</div></div>\n' +
      '  <div class="card ap-accent"><div class="lbl">Allied Powers avg roll</div><div class="big">' + fmt(s.overallStats.ap.mean) + '</div>' +
      '<div class="lbl">n=' + s.overallStats.ap.n + ' · σ=' + fmt(s.overallStats.ap.std) + '</div></div>\n' +
      '  <div class="card"><div class="lbl">Expected (fair d6)</div><div class="big">3.50</div>' +
      '<div class="lbl">both sides within ' + fmt(Math.abs(overallDiff)) + ' of this</div></div>\n' +
      '  <div class="card"><div class="lbl">Combats resolved</div><div class="big">' + (wt.cp.win + wt.cp.tie + wt.cp.loss) + '</div>' +
      '<div class="lbl">CP ' + wt.cp.win + 'W–' + wt.cp.tie + 'T–' + wt.cp.loss + 'L</div></div>\n' +
      '</div>\n' +
      '<h2>Is one side getting better dice?</h2>\n<p>' + verdict + '</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgBarOverall(s) + '</div></div>\n' +
      '<h2>Distribution — how close to random?</h2>\n' +
      '<p class="note">Each side\'s rolls broken out 1–6, as a share of that side\'s total rolls, against the 16.7% a\n' +
      'perfectly fair die would produce. A chi-square goodness-of-fit test (critical value ' + CHI2_CRIT_05 + ' at p=0.05,\n' +
      '5 degrees of freedom) flags whether a side\'s distribution is statistically distinguishable from uniform —\n' +
      'neither side crosses that line here, so both dice pools read as fair.</p>\n' +
      '<div class="panel">\n  <div class="chart-wrap">' + svgDistribution(s) + '</div>\n  <div class="legend">\n' +
      '    <span><span class="dot" style="background:var(--cp)"></span>Central Powers (χ²=' + fmt(s.chi2.cp) + ')</span>\n' +
      '    <span><span class="dot" style="background:var(--ap)"></span>Allied Powers (χ²=' + fmt(s.chi2.ap) + ')</span>\n' +
      '  </div>\n</div>\n' +
      '<h2>Average roll over time</h2>\n' +
      '<p class="note">Per-turn average (solid line, one point per turn) shows the big swings; the rolling average\n' +
      'below (window of ' + WINDOW + ' rolls, in the actual chronological roll order — mandated offensive, combat fire,\n' +
      'entrench, flank and siege rolls all mixed together as they happened) smooths that out to show hot/cold streaks\n' +
      'independent of how many rolls happened in a given turn.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgTrend(s) + '</div>\n  <div class="legend">\n' +
      '    <span><span class="dot" style="background:var(--cp)"></span>Central Powers</span>\n' +
      '    <span><span class="dot" style="background:var(--ap)"></span>Allied Powers</span>\n  </div>\n</div>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgRolling(s) + '</div></div>\n' +
      '<h2>By category</h2>\n' +
      '<p class="note">Average roll broken out by what the roll was <em>for</em>. Faint bars mean that side made no\n' +
      'rolls in that category.</p>\n' +
      '<div class="panel"><div class="chart-wrap">' + svgCategoryBars(s) + '</div>\n  <div class="legend">\n' +
      '    <span><span class="dot" style="background:var(--cp)"></span>Central Powers</span>\n' +
      '    <span><span class="dot" style="background:var(--ap)"></span>Allied Powers</span>\n  </div>\n</div>\n' +
      '<div class="panel"><table><thead><tr><th>Category</th><th>CP n</th><th>CP avg</th><th>AP n</th><th>AP avg</th></tr></thead>' +
      '<tbody>' + catCompareRows(s) + '</tbody></table></div>\n' +
      '<h2>Combat fire: attacker vs. defender</h2>\n' +
      '<p class="note">Does either side roll better when attacking than when defending?</p>\n' +
      '<div class="panel"><table><thead><tr><th>Side</th><th>Attacker n</th><th>Attacker avg</th><th>Defender n</th><th>Defender avg</th></tr></thead>' +
      '<tbody>' + roleCompareRows(s) + '</tbody></table></div>\n' +
      '<h2>Combat outcomes</h2>\n' +
      '<p class="note">Per combat, whichever side\'s CRT result (die × Combat Factors, looked up on the table) came out\n' +
      'higher is the "win" here — reflects force strength as well as the roll, see the caveat above.</p>\n' +
      '<div class="panel"><table><thead><tr><th>Side</th><th>Wins</th><th>Ties</th><th>Losses</th><th>Win rate</th></tr></thead>' +
      '<tbody>' + winRows(s) + '</tbody></table></div>\n' +
      '<h2>Entrench &amp; flank success rates</h2>\n' +
      '<p class="note">Entrench attempts split by side and by whether a modifier was applied to the roll (e.g.\n' +
      '"d6 − 1 = 5") before checking success/failure.</p>\n' +
      '<div class="panel"><table><thead><tr><th>Entrench attempts</th><th>Succeeded</th><th>Total</th><th>Rate</th></tr></thead>' +
      '<tbody>' + entrenchModifierRows(s) + '</tbody></table></div>\n' +
      '<div class="panel"><table><thead><tr><th>Flank attempts</th><th>Succeeded</th><th>Total</th><th>Rate</th></tr></thead>' +
      '<tbody>' + rateRows(s.flankRate, "flank") + '</tbody></table></div>\n' +
      '<h2>Full roll data by category</h2>\n' +
      '<p class="note">Every parsed roll, grouped by category, for auditing the numbers above. The Entrench table\n' +
      'includes the per-space attempt number (kept for reference, not used in the success-rate split above).</p>\n' +
      CATS.map(function (c) { return detailsTable(CAT_NAME[c], catRowsMap[c], c === "entrench"); }).join("\n") + '\n' +
      '<footer>\nGenerated entirely in your browser — no file was uploaded anywhere. ' + rows.length + ' rows parsed.\n' +
      'Raw d6 value is always the physical roll; "modifier"/"effective" reflect in-game bonuses/penalties applied on top.\n' +
      '</footer>\n</main>\n</body></html>';
  }

  var api = { buildStats: buildStats, buildReportHTML: buildReportHTML, SIDES: SIDES, CATS: CATS, CAT_NAME: CAT_NAME };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PogReport = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
