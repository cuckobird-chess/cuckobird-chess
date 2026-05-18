import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const defaultProfileDirectory = path.resolve(process.cwd(), "temp", "profile");
const profileDirectory = path.resolve(process.cwd(), process.argv[2] ?? defaultProfileDirectory);

const formatMs = (value) => {
  if (!Number.isFinite(value)) {
    return "-";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)}ms`;
};

const percentile = (values, ratio) => {
  if (values.length === 0) {
    return undefined;
  }

  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return values[index];
};

const summarize = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    count: sorted.length,
    total,
    avg: sorted.length > 0 ? total / sorted.length : undefined,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)
  };
};

const formatSummary = (summary) => ({
  count: String(summary.count),
  total: formatMs(summary.total),
  avg: formatMs(summary.avg),
  p50: formatMs(summary.p50),
  p95: formatMs(summary.p95),
  max: formatMs(summary.max)
});

const makeTable = (headers, rows, rightAligned = new Set()) => {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[column] ?? "").length)
    )
  );
  const renderRow = (row) =>
    row
      .map((cell, column) => {
        const value = String(cell ?? "");
        return rightAligned.has(column) ? value.padStart(widths[column]) : value.padEnd(widths[column]);
      })
      .join("  ");

  return [
    renderRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(renderRow)
  ].join("\n");
};

const getStatus = (profile) => String(profile.summary?.status ?? "unknown");
const getProfileKind = (profile) => String(profile.summary?.profileKind ?? "capture");

const readProfiles = async () => {
  let filenames;

  try {
    filenames = await readdir(profileDirectory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { profiles: [], skipped: [] };
    }

    throw error;
  }

  const profileFiles = filenames
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  const profiles = [];
  const skipped = [];

  for (const filename of profileFiles) {
    const filePath = path.join(profileDirectory, filename);

    try {
      const profile = JSON.parse(await readFile(filePath, "utf8"));
      profiles.push({ ...profile, filePath, filename });
    } catch (error) {
      skipped.push({
        filename,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { profiles, skipped };
};

const printNoProfiles = () => {
  console.log(`No profiler JSON files found in ${profileDirectory}`);
  console.log("Run `pnpm run start:debug` or `pnpm run crop-board:debug -- path/to/image.png` first.");
};

const main = async () => {
  const { profiles, skipped } = await readProfiles();

  if (profiles.length === 0) {
    printNoProfiles();
    if (skipped.length > 0) {
      console.log(`Skipped ${skipped.length} unreadable file(s).`);
    }
    return;
  }

  const statusCounts = new Map();
  const kindCounts = new Map();
  const captureDurations = [];
  const backgroundDurations = [];
  const stageDurations = new Map();
  const stageErrors = new Map();

  for (const profile of profiles) {
    const status = getStatus(profile);
    const kind = getProfileKind(profile);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);

    if (Number.isFinite(profile.totalDurationMs)) {
      if (kind === "background-engine") {
        backgroundDurations.push(profile.totalDurationMs);
      } else {
        captureDurations.push(profile.totalDurationMs);
      }
    }

    for (const entry of Array.isArray(profile.entries) ? profile.entries : []) {
      if (!Number.isFinite(entry.durationMs) || !entry.name) {
        continue;
      }

      const values = stageDurations.get(entry.name) ?? [];
      values.push(entry.durationMs);
      stageDurations.set(entry.name, values);

      if (entry.error) {
        stageErrors.set(entry.name, (stageErrors.get(entry.name) ?? 0) + 1);
      }
    }
  }

  const captureSummary = formatSummary(summarize(captureDurations));
  const backgroundSummary = formatSummary(summarize(backgroundDurations));
  const statuses = [...statusCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
  const kinds = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(", ");

  console.log(`Profile directory: ${profileDirectory}`);
  console.log(`Profiles: ${profiles.length}${skipped.length > 0 ? ` (${skipped.length} unreadable skipped)` : ""}`);
  console.log(`Kinds: ${kinds || "none"}`);
  console.log(`Statuses: ${statuses || "none"}`);
  console.log(
    `Capture time: total ${captureSummary.total}, avg ${captureSummary.avg}, p50 ${captureSummary.p50}, p95 ${captureSummary.p95}, max ${captureSummary.max}`
  );
  if (backgroundDurations.length > 0) {
    console.log(
      `Background time: total ${backgroundSummary.total}, avg ${backgroundSummary.avg}, p50 ${backgroundSummary.p50}, p95 ${backgroundSummary.p95}, max ${backgroundSummary.max}`
    );
  }

  const stageRows = [...stageDurations.entries()]
    .map(([name, values]) => {
      const rawSummary = summarize(values);
      const summary = formatSummary(rawSummary);
      return {
        totalMs: rawSummary.total,
        row: [
          name,
          summary.count,
          summary.total,
          summary.avg,
          summary.p50,
          summary.p95,
          summary.max,
          String(stageErrors.get(name) ?? 0)
        ]
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs)
    .map((item) => item.row);

  if (stageRows.length > 0) {
    console.log("\nBy Stage");
    console.log(makeTable(
      ["stage", "count", "total", "avg", "p50", "p95", "max", "errors"],
      stageRows,
      new Set([1, 2, 3, 4, 5, 6, 7])
    ));
  }

  const slowCaptureRows = profiles
    .filter((profile) => getProfileKind(profile) !== "background-engine" && Number.isFinite(profile.totalDurationMs))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
    .slice(0, 10)
    .map((profile) => [
      formatMs(profile.totalDurationMs),
      getStatus(profile),
      String(profile.sourceId ?? "-").slice(0, 44),
      profile.filename
    ]);

  if (slowCaptureRows.length > 0) {
    console.log("\nSlowest Captures");
    console.log(makeTable(
      ["total", "status", "source", "file"],
      slowCaptureRows,
      new Set([0])
    ));
  }

  const slowBackgroundRows = profiles
    .filter((profile) => getProfileKind(profile) === "background-engine" && Number.isFinite(profile.totalDurationMs))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
    .slice(0, 10)
    .map((profile) => [
      formatMs(profile.totalDurationMs),
      getStatus(profile),
      String(profile.sourceId ?? "-").slice(0, 44),
      profile.filename
    ]);

  if (slowBackgroundRows.length > 0) {
    console.log("\nSlowest Background Profiles");
    console.log(makeTable(
      ["total", "status", "source", "file"],
      slowBackgroundRows,
      new Set([0])
    ));
  }

  if (skipped.length > 0) {
    console.log("\nSkipped Files");
    console.log(makeTable(
      ["file", "error"],
      skipped.map((item) => [item.filename, item.error])
    ));
  }
};

await main();
