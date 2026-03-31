/**
 * Bullhorn SIA Staffing Indicator Scraper
 * Pulls data from all 5 Infogram chart embeds on:
 * https://www.bullhorn.com/insights/staffing-industry-indicator/
 *
 * Usage:
 *   node scrape.js              → saves JSON + CSV to ./output/
 *   node scrape.js --json       → JSON only
 *   node scrape.js --csv        → CSV only
 *   node scrape.js --stdout     → print to console, no files
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

// ─── Config ──────────────────────────────────────────────────────────────────

const SOURCE_URL =
  "https://www.bullhorn.com/insights/staffing-industry-indicator/";

const CHARTS = [
  // Scorecard table (current-week snapshot, no chart series)
  { id: "2727a150-ae63-4e23-abc9-c0d5e9960f8b", label: "total_us_staffing", sector: null },
  // Chart embeds — sector is what the data actually represents (not the embed label)
  { id: "60a7be6c-516f-4793-afb0-0efa8981ba27", label: "it_staffing",      sector: "Total US" },
  { id: "87105adf-178c-473c-89ec-c868ed20de9a", label: "light_industrial", sector: "IT" },
  { id: "098aa765-e53e-43b9-9fed-e66b47abb126", label: "office_clerical",  sector: "Light Industrial" },
  { id: "d3ff9169-a574-4e62-9f60-9ec2a09dca80", label: "sia_perspective",  sector: "Office Clerical" },
];

const OUTPUT_DIR = path.join(__dirname, "output");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Chart type classification ───────────────────────────────────────────────

function classifyChart(sheetnames) {
  const s = (sheetnames || []).join(" ").toLowerCase();
  if (s.includes("hours per w")) return "avg_weekly_hours";
  if (s.includes("yoy")) return "yoy_change";
  return "staffing_indicator";
}

// ─── Core: extract data from one Infogram iframe ─────────────────────────────

async function extractInfogramData(browser, chartId, label) {
  const url = `https://e.infogram.com/${chartId}?src=embed`;
  log(`  Fetching chart: ${label} (${chartId})`);

  const page = await browser.newPage();

  // Capture all JSON responses from infogram's data requests
  const intercepted = [];
  page.on("response", async (response) => {
    const ct = response.headers()["content-type"] || "";
    if (ct.includes("json")) {
      try {
        const body = await response.json();
        intercepted.push({ url: response.url(), data: body });
      } catch (_) {}
    }
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // Strategy 1: grab data from window object Infogram exposes
    const windowData = await page.evaluate(() => {
      // Infogram stores chart config/data in various globals
      const candidates = [
        window.infographicData,
        window.__INITIAL_STATE__,
        window.__infogram_data__,
        window.infogramData,
        window.__data__,
      ];
      for (const c of candidates) {
        if (c) return { source: "window_global", data: c };
      }

      // Fallback: find it in inline <script> tags
      const scripts = Array.from(document.querySelectorAll("script:not([src])"));
      for (const s of scripts) {
        const text = s.textContent || "";
        // Look for the data payload pattern Infogram uses
        const match = text.match(/window\.infographicData\s*=\s*({.+});?\s*$/s) ||
                      text.match(/window\.__INITIAL_STATE__\s*=\s*({.+});?\s*$/s) ||
                      text.match(/window\.__infogram_data__\s*=\s*({.+});?\s*$/s) ||
                      text.match(/"data"\s*:\s*(\[.+\])/s);
        if (match) {
          try {
            return { source: "inline_script", data: JSON.parse(match[1]) };
          } catch (_) {}
        }
      }

      // Last resort: return all inline script content for manual inspection
      return {
        source: "raw_scripts",
        data: scripts.map((s) => s.textContent.slice(0, 500)),
      };
    });

    // Strategy 2: pull table/series data directly from rendered DOM
    const domData = await page.evaluate(() => {
      const results = [];

      // Infogram renders accessible table elements alongside charts
      document.querySelectorAll("table").forEach((table) => {
        const headers = Array.from(table.querySelectorAll("th")).map(
          (th) => th.textContent.trim()
        );
        const rows = Array.from(table.querySelectorAll("tr")).map((tr) =>
          Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim())
        ).filter((r) => r.length > 0);
        if (headers.length || rows.length) results.push({ headers, rows });
      });

      // Also grab any SVG text labels (axis labels, data labels)
      const svgTexts = Array.from(document.querySelectorAll("svg text"))
        .map((t) => t.textContent.trim())
        .filter(Boolean);

      return { tables: results, svgLabels: svgTexts };
    });

    // Strategy 1b: extract CHART entity series from infographicData
    const chartSeries = [];
    let scorecardRows = null;
    if (
      windowData.source === "window_global" &&
      windowData.data?.elements?.content?.content?.entities
    ) {
      const entities = windowData.data.elements.content.content.entities;
      for (const entity of Object.values(entities)) {
        if (entity.type === "CHART" && entity.props?.chartData?.data) {
          const sn = entity.props.chartData.sheetnames || [];
          chartSeries.push({
            type: classifyChart(sn),
            sheetnames: sn,
            data: entity.props.chartData.data,
          });
        }
      }

      // Strategy 1c: for scorecard/table infographics (no CHART entities),
      // reconstruct table by grouping TEXT entities by vertical position
      if (chartSeries.length === 0) {
        const textItems = [];
        for (const entity of Object.values(entities)) {
          if (entity.type !== "TEXT") continue;
          const blocks = entity.props?.content?.blocks ?? [];
          const text = blocks
            .map((b) => (b.text || "").trim())
            .filter(Boolean)
            .join(" ");
          if (text) textItems.push({ top: entity.top, left: entity.left, text });
        }
        textItems.sort((a, b) => a.top - b.top || a.left - b.left);
        // Group into rows (items within ±20px vertically belong to same row)
        const groups = [];
        for (const item of textItems) {
          const g = groups.find((g) => Math.abs(g.top - item.top) <= 20);
          if (g) g.cells.push(item);
          else groups.push({ top: item.top, cells: [item] });
        }
        for (const g of groups) g.cells.sort((a, b) => a.left - b.left);
        scorecardRows = groups.map((g) => g.cells.map((c) => c.text));
      }
    }

    // Strategy 3: check intercepted network responses for chart data
    const dataResponses = intercepted.filter(
      (r) =>
        r.url.includes("infogram") &&
        !r.url.includes("analytics") &&
        !r.url.includes("tracking")
    );

    return {
      chartId,
      label,
      url,
      scrapedAt: new Date().toISOString(),
      windowData,
      chartSeries,
      scorecardRows,
      domData,
      networkData: dataResponses,
    };
  } catch (err) {
    log(`  ⚠️  Error on ${label}: ${err.message}`);
    return {
      chartId,
      label,
      url,
      scrapedAt: new Date().toISOString(),
      error: err.message,
    };
  } finally {
    await page.close();
  }
}

// ─── Flatten chart data into CSV rows ────────────────────────────────────────

function flattenToRows(result) {
  const rows = [];
  const base = {
    scraped_at: result.scrapedAt,
    chart_label: result.label,
    chart_id: result.chartId,
  };

  // Strategy 1b: chartSeries extracted from infographicData CHART entities
  // Each series: { sheetnames: [...], data: [ [[header, seriesName], [date, val], ...], ... ] }
  if (result.chartSeries?.length) {
    for (const cs of result.chartSeries) {
      for (const series of cs.data) {
        if (!Array.isArray(series) || series.length < 2) continue;
        const header = series[0]; // ["Week ending", "Series Name"]
        const seriesName = header[1] || "value";
        for (let i = 1; i < series.length; i++) {
          const [date, val] = series[i];
          rows.push({ ...base, series: seriesName, week_ending: date, value: val });
        }
      }
    }
    if (rows.length) return rows;
  }

  // Strategy 1c: scorecard/table infographic — TEXT entities grouped by position
  // scorecardRows is array of rows, each row is array of cell strings
  // First row = column headers, second row may be date, remaining = data rows
  if (result.scorecardRows?.length >= 2) {
    const headerRow = result.scorecardRows[0]; // ["Week ending", "Indexed value*", ...]
    // Find the week-ending date row (single-cell row with a date-like value)
    let weekEnding = "";
    let dataStartIdx = 1;
    if (result.scorecardRows[1]?.length === 1) {
      weekEnding = result.scorecardRows[1][0];
      dataStartIdx = 2;
    }
    for (let i = dataStartIdx; i < result.scorecardRows.length; i++) {
      const cells = result.scorecardRows[i];
      if (cells.length < 2) continue;
      const obj = { ...base, week_ending: weekEnding };
      // First cell is the row label (e.g. "US staffing")
      obj.series = cells[0];
      // Remaining cells align to header columns (skip "Week ending" col)
      for (let j = 1; j < cells.length; j++) {
        const colName = headerRow[j] || `col_${j}`;
        obj[colName] = cells[j];
      }
      rows.push(obj);
    }
    if (rows.length) return rows;
  }

  // Try DOM tables (most structured when available)
  if (result.domData?.tables?.length) {
    for (const table of result.domData.tables) {
      const { headers, rows: tableRows } = table;
      for (const row of tableRows) {
        const obj = { ...base };
        headers.forEach((h, i) => {
          obj[h || `col_${i}`] = row[i] ?? "";
        });
        rows.push(obj);
      }
    }
    if (rows.length) return rows;
  }

  // Fall back to network data if tables were empty
  if (result.networkData?.length) {
    for (const nr of result.networkData) {
      const d = nr.data;
      if (Array.isArray(d)) {
        d.forEach((item, i) => {
          rows.push({ ...base, network_url: nr.url, index: i, ...flatten(item) });
        });
      } else if (typeof d === "object") {
        rows.push({ ...base, network_url: nr.url, ...flatten(d) });
      }
    }
    if (rows.length) return rows;
  }

  // Nothing structured found — return a single diagnostic row
  rows.push({ ...base, note: "no_structured_data_extracted" });
  return rows;
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    } else {
      out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
  }
  return out;
}

// ─── Save outputs ─────────────────────────────────────────────────────────────

function saveJSON(results) {
  const file = path.join(OUTPUT_DIR, `bullhorn_indicator_${todayStr()}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  log(`✅ JSON saved → ${file}`);
  return file;
}

function saveCSV(results) {
  const allRows = results.flatMap(flattenToRows);
  if (!allRows.length) {
    log("⚠️  No rows to write to CSV");
    return;
  }

  // Collect all unique keys across all rows
  const allKeys = [...new Set(allRows.flatMap(Object.keys))];
  const lines = [
    allKeys.join(","),
    ...allRows.map((row) =>
      allKeys.map((k) => {
        const val = row[k] ?? "";
        const s = String(val).replace(/"/g, '""');
        return s.includes(",") || s.includes("\n") || s.includes('"')
          ? `"${s}"`
          : s;
      }).join(",")
    ),
  ];

  const file = path.join(OUTPUT_DIR, `bullhorn_indicator_${todayStr()}.csv`);
  fs.writeFileSync(file, lines.join("\n"));
  log(`✅ CSV saved → ${file}`);
  return file;
}

function addSheet(wb, sheetName, tabData) {
  if (!tabData || tabData.length < 2) return;
  const headers = tabData[0];
  const dataRows = tabData.slice(1);

  const ws = wb.addWorksheet(sheetName);

  // Header row
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD9EAD3" },
  };

  // Data rows — coerce numeric strings to numbers
  for (const row of dataRows) {
    ws.addRow(
      row.map((v, i) => {
        if (i === 0) return v; // date column stays as string
        const n = parseFloat(String(v).replace("%", ""));
        return isNaN(n) ? v : n;
      })
    );
  }

  // Auto-fit columns
  ws.columns.forEach((col, i) => {
    const maxLen = Math.max(
      String(headers[i] ?? "").length,
      ...dataRows.map((r) => String(r[i] ?? "").length)
    );
    col.width = Math.min(maxLen + 4, 40);
  });

  ws.views = [{ state: "frozen", ySplit: 1 }];
}

async function saveExcel(results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bullhorn SIA Scraper";
  wb.created = new Date();

  // Sectors in display order — map label → sector name
  const SECTOR_ORDER = [
    { label: "it_staffing",      name: "Total US" },
    { label: "light_industrial", name: "IT" },
    { label: "office_clerical",  name: "Light Industrial" },
    { label: "sia_perspective",  name: "Office Clerical" },
  ];

  const CHART_TYPE_ORDER = [
    { type: "staffing_indicator", suffix: "Staffing Indicator" },
    { type: "yoy_change",         suffix: "YoY Change" },
    { type: "avg_weekly_hours",   suffix: "Avg Weekly Hours" },
  ];

  for (const sector of SECTOR_ORDER) {
    const result = results.find((r) => r.label === sector.label);
    if (!result?.chartSeries?.length) continue;

    for (const ct of CHART_TYPE_ORDER) {
      const cs = result.chartSeries.find((c) => c.type === ct.type);
      if (!cs) continue;

      // Tab 0 = full history (all time)
      const tabData = cs.data[0];
      const sheetName = `${sector.name} - ${ct.suffix}`.slice(0, 31);
      addSheet(wb, sheetName, tabData);
      log(`  ✔ Sheet: ${sheetName} (${(tabData?.length ?? 1) - 1} rows)`);
    }
  }

  const file = path.join(OUTPUT_DIR, `bullhorn_indicator_${todayStr()}.xlsx`);
  await wb.xlsx.writeFile(file);
  log(`✅ Excel saved → ${file}`);
  return file;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes("--json");
  const csvOnly = args.includes("--csv");
  const excelOnly = args.includes("--excel");
  const stdoutOnly = args.includes("--stdout");
  const saveFiles = !stdoutOnly;

  log("🚀 Starting Bullhorn SIA Indicator scraper");
  log(`   Source: ${SOURCE_URL}`);
  log(`   Charts: ${CHARTS.length}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const results = [];

  try {
    for (const chart of CHARTS) {
      const result = await extractInfogramData(browser, chart.id, chart.label);
      results.push(result);

      // Brief summary per chart
      const seriesCount = result.chartSeries?.length ?? 0;
      const scorecardCount = result.scorecardRows?.length ?? 0;
      const tableCount = result.domData?.tables?.length ?? 0;
      const netCount = result.networkData?.length ?? 0;
      log(
        `  → ${chart.label}: ${seriesCount} chart series, ${scorecardCount} scorecard rows, ${tableCount} DOM tables, ${netCount} network responses`
      );
    }
  } finally {
    await browser.close();
  }

  if (stdoutOnly) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  ensureOutputDir();

  if (!csvOnly && !excelOnly) saveJSON(results);
  if (!jsonOnly && !excelOnly) saveCSV(results);
  if (!jsonOnly && !csvOnly) await saveExcel(results);

  log("✨ Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
