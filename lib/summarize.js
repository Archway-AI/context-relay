import { estimateTokens } from "./artifact-store.js";

function nonEmptyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function interestingLines(lines) {
  const important = lines.filter((line) =>
    /\b(fail|failed|error|warning|warn|assert|expected|received|exception|traceback|todo|fixme)\b/i.test(line),
  );
  return important.length > 0 ? important.slice(0, 12) : lines.slice(0, 12);
}

function searchSummary(lines) {
  const byFile = new Map();
  for (const line of lines) {
    const match = line.match(/^([^:\n]+):(\d+):(.*)$/);
    if (!match) {
      continue;
    }
    const file = match[1];
    const entry = byFile.get(file) || { count: 0, firstLines: [] };
    entry.count += 1;
    if (entry.firstLines.length < 3) {
      entry.firstLines.push(`${match[2]}:${match[3].trim()}`);
    }
    byFile.set(file, entry);
  }
  if (byFile.size === 0) {
    return [];
  }
  return [
    `search_matches: ${lines.length}`,
    `files_with_matches: ${byFile.size}`,
    ...Array.from(byFile.entries())
      .slice(0, 10)
      .map(([file, entry]) => `- ${file}: ${entry.count} matches (${entry.firstLines.join("; ")})`),
  ];
}

function gitStatusSummary(lines) {
  const statusLines = lines.filter((line) => /^[ MADRCU?!]{2}\s+/.test(line));
  if (statusLines.length === 0) {
    return [];
  }
  const counts = new Map();
  for (const line of statusLines) {
    const status = line.slice(0, 2);
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return [
    `git_status_paths: ${statusLines.length}`,
    `status_counts: ${Array.from(counts.entries())
      .map(([status, count]) => `${JSON.stringify(status)}=${count}`)
      .join(", ")}`,
    ...statusLines.slice(0, 20).map((line) => `- ${line}`),
  ];
}

function jsonSummary(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }
  const lines = [];
  if (Array.isArray(parsed)) {
    lines.push(`json_root: array(${parsed.length})`);
    lines.push(...summarizeJsonRows(parsed));
  } else if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    lines.push(`json_root: object(${keys.length} keys)`);
    lines.push(`keys: ${keys.slice(0, 12).join(", ")}`);
    for (const key of keys) {
      const value = parsed[key];
      if (Array.isArray(value)) {
        lines.push(`${key}: array(${value.length})`);
        lines.push(...summarizeJsonRows(value).map((line) => `${key}.${line}`));
      }
    }
  }
  return lines.slice(0, 18);
}

function summarizeJsonRows(rows) {
  const objectRows = rows.filter((row) => row && typeof row === "object" && !Array.isArray(row));
  if (objectRows.length === 0) {
    return [];
  }
  const keyCounts = new Map();
  const statusCounts = new Map();
  const examples = [];
  for (const row of objectRows) {
    for (const key of Object.keys(row)) {
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
    if (typeof row.status === "string") {
      statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1);
    }
    if (examples.length < 5 && (row.status === "warning" || row.status === "error" || row.error)) {
      examples.push(JSON.stringify(row));
    }
  }
  const lines = [
    `object_rows: ${objectRows.length}`,
    `row_keys: ${Array.from(keyCounts.keys()).slice(0, 12).join(", ")}`,
  ];
  if (statusCounts.size > 0) {
    lines.push(
      `status_counts: ${Array.from(statusCounts.entries())
        .map(([status, count]) => `${status}=${count}`)
        .join(", ")}`,
    );
  }
  lines.push(...examples.map((example) => `example: ${example}`));
  return lines;
}

export function summarize({ commandText, rawText, exitCode, durationMs }) {
  const lines = nonEmptyLines(rawText);
  const specialized =
    commandText.startsWith("rg ") || commandText.startsWith("grep ")
      ? searchSummary(lines)
      : commandText.startsWith("git status")
        ? gitStatusSummary(lines)
        : jsonSummary(rawText);
  const selected = specialized.length > 0 ? specialized : interestingLines(lines);
  return [
    `command: ${commandText}`,
    `exit_code: ${exitCode}`,
    `duration_ms: ${durationMs}`,
    `raw_lines: ${lines.length}`,
    `raw_estimated_tokens: ${estimateTokens(rawText)}`,
    "highlights:",
    ...selected.map((line) => (line.startsWith("- ") ? line : `- ${line}`)),
  ].join("\n");
}

export function envelope({ commandText, cwd, exitCode, durationMs, mode, reasonCode, marker, summary }) {
  const lines = [
    "CR compressed output",
    `command: ${commandText}`,
    `cwd: ${cwd}`,
    `exit_code: ${exitCode}`,
    `duration_ms: ${durationMs}`,
    `mode: ${mode}`,
    `reason: ${reasonCode}`,
  ];
  if (marker) {
    lines.push(`raw: ${marker}`);
  }
  lines.push("", "summary:", summary);
  return `${lines.join("\n")}\n`;
}

export function dryRunReport({ commandText, rawText, exitCode, durationMs, reasonCode }) {
  return `${rawText}\nCR dry-run report\ncommand: ${commandText}\nexit_code: ${exitCode}\nduration_ms: ${durationMs}\nreason: ${reasonCode}\nraw_estimated_tokens: ${estimateTokens(rawText)}\n`;
}
