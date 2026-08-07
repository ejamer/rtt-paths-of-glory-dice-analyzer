/** Browser glue: file upload -> parse -> render report in an iframe + offer downloads.
 * Nothing in this file ever calls fetch()/XMLHttpRequest — the uploaded file
 * is read locally via FileReader and never transmitted anywhere.
 */
(function () {
  "use strict";

  var dropZone = document.getElementById("drop-zone");
  var fileInput = document.getElementById("file-input");
  var status = document.getElementById("status");
  var warning = document.getElementById("warning");
  var resultsSection = document.getElementById("results");
  var reportFrame = document.getElementById("report-frame");
  var downloadCsvBtn = document.getElementById("download-csv");
  var downloadJsonBtn = document.getElementById("download-json");
  var downloadReportBtn = document.getElementById("download-report");

  var currentRows = null;
  var currentParsed = null;
  var currentReportHtml = null;
  var currentBaseName = "paths-of-glory";
  var reportHeightObserver = null;

  /** Size #report-frame to its content's actual height instead of scrolling internally — a
   * fixed iframe height would either clip taller reports (double scrollbar: page + iframe) or
   * leave a blank gap under shorter ones. srcdoc content is same-origin to the parent, so
   * contentWindow.document is reachable synchronously once the iframe fires "load". A
   * ResizeObserver on top of that catches height changes *after* load too — expanding one of
   * the report's own <details class="cat-table"> blocks resizes the document without firing
   * "load" again, and this needs to track that just as much as the initial size.
   *
   * The iframe itself has scrolling="no" (see index.html/style.css) so it never shows a
   * scrollbar of its own — but that also means undershooting this height by even a subpixel
   * would silently clip content instead of just scrolling, so pad it a couple px above what
   * scrollHeight (which rounds down) reports. */
  function watchReportFrameHeight() {
    if (reportHeightObserver) { reportHeightObserver.disconnect(); reportHeightObserver = null; }
    var doc;
    try { doc = reportFrame.contentWindow && reportFrame.contentWindow.document; } catch (e) { return; }
    if (!doc || !doc.documentElement) return;
    var resize = function () { reportFrame.style.height = (doc.documentElement.scrollHeight + 2) + "px"; };
    resize();
    if (typeof ResizeObserver === "function") {
      reportHeightObserver = new ResizeObserver(resize);
      reportHeightObserver.observe(doc.documentElement);
    }
  }

  function setStatus(msg, isError) {
    status.textContent = msg;
    status.className = isError ? "status error" : "status";
  }

  function baseNameFor(filename) {
    var stem = filename.replace(/\.html?$/i, "");
    stem = stem.replace(/\s*-\s*source\s*$/i, "");
    return stem || "paths-of-glory";
  }

  function downloadText(text, filename, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function handleFile(file) {
    if (!file) return;
    currentBaseName = baseNameFor(file.name);
    setStatus("Reading " + file.name + " …", false);
    warning.hidden = true;
    resultsSection.hidden = true;

    var reader = new FileReader();
    reader.onerror = function () {
      setStatus("Couldn't read that file.", true);
    };
    reader.onload = function () {
      try {
        var text = String(reader.result);
        var parsed = PogParser.parseLog(text);
        if (!parsed.rows.length) {
          setStatus("No dice rolls found. Is this the right file (a Paths of Glory game page source, " +
            "or its <div id=\"log\">...</div> excerpt)?", true);
          return;
        }
        currentRows = parsed.rows;
        currentParsed = parsed;
        currentReportHtml = PogReport.buildReportHTML(parsed.rows, parsed.combats, parsed.meta);
        reportFrame.srcdoc = currentReportHtml;
        resultsSection.hidden = false;
        setStatus("Parsed " + parsed.rows.length + " die rolls from " + file.name + ".", false);
        if (parsed.unknownCount > 0) {
          warning.hidden = false;
          warning.textContent = "Heads up: " + parsed.unknownCount + " roll(s) in this log didn't match any " +
            "known roll type and were skipped from the stats below. The site's HTML may have changed since this " +
            "parser was written — the numbers above are still accurate for everything that WAS recognized.";
        }
      } catch (err) {
        console.error(err);
        setStatus("Something went wrong parsing that file: " + err.message, true);
      }
    };
    reader.readAsText(file);
  }

  fileInput.addEventListener("change", function (e) {
    handleFile(e.target.files[0]);
  });

  ["dragenter", "dragover"].forEach(function (evt) {
    dropZone.addEventListener(evt, function (e) {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    dropZone.addEventListener(evt, function (e) {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove("dragover");
    });
  });
  dropZone.addEventListener("drop", function (e) {
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });
  dropZone.addEventListener("click", function () { fileInput.click(); });

  reportFrame.addEventListener("load", watchReportFrameHeight);

  downloadCsvBtn.addEventListener("click", function () {
    if (!currentRows) return;
    downloadText(PogCsv.rowsToCsv(currentRows), currentBaseName + " - dice_rolls.csv", "text/csv");
  });
  downloadJsonBtn.addEventListener("click", function () {
    if (!currentParsed) return;
    var json = PogSchema.buildGameJSON(currentParsed);
    downloadText(PogSchema.stringifyGameJSON(json), currentBaseName + " - data.json", "application/json");
  });
  downloadReportBtn.addEventListener("click", function () {
    if (!currentReportHtml) return;
    downloadText(currentReportHtml, currentBaseName + " - report.html", "text/html");
  });
})();
