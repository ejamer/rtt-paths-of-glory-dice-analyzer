/** Turn parsed rows into the same CSV format the CLI (parse_dice.py) writes. */
(function (root) {
  "use strict";

  var FIELDS = ["turn", "action", "side", "category", "role", "space", "raw_value",
                "modifier", "effective_value", "outcome", "entrench_attempt_no",
                "force_type", "nationality", "target_cf"];

  function csvEscape(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function rowsToCsv(rows) {
    var lines = [FIELDS.join(",")];
    rows.forEach(function (r) {
      lines.push(FIELDS.map(function (f) { return csvEscape(r[f]); }).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  var api = { rowsToCsv: rowsToCsv };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PogCsv = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
