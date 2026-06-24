import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = "cr-artifact-v0.1";
export const DEFAULT_TTL_HOURS = 8;

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function storeRoot(env = process.env) {
  return env.CONTEXT_RELAY_STORE_DIR || path.join(os.homedir(), ".context-relay");
}

export function newRunId() {
  return randomBytes(4).toString("hex");
}

export function newArtifactNonce() {
  return randomBytes(6).toString("hex");
}

export function artifactMarker(artifact) {
  return `[artifact:cr:${artifact.artifact_id} bytes=${artifact.content.bytes} tokens=${artifact.content.estimated_tokens} reason=${artifact.policy.reason_code} retrieve="context-relay retrieve ${artifact.artifact_id}"]`;
}

function gitMetadata(cwd) {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    return {
      workspace: match?.[1] || path.basename(path.dirname(root)),
      repo: match?.[2] || path.basename(root),
    };
  } catch {
    return {
      workspace: path.basename(path.dirname(cwd)),
      repo: path.basename(cwd),
    };
  }
}

export class ArtifactStore {
  constructor(options = {}) {
    this.root = options.root || storeRoot();
    this.runId = options.runId || process.env.CONTEXT_RELAY_RUN_ID || newRunId();
    this.now = options.now || (() => new Date());
  }

  artifactPath(artifactId) {
    return path.join(this.root, "artifacts", `${artifactId}.json`);
  }

  statsPath() {
    return path.join(this.root, "events.jsonl");
  }

  artifactsDir() {
    return path.join(this.root, "artifacts");
  }

  async put({ rawText, command, cwd, mode, reasonCode, redacted = false }) {
    const hash = sha256(rawText);
    const artifactId = `cr_${this.runId}_${newArtifactNonce()}`;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + DEFAULT_TTL_HOURS * 60 * 60 * 1000);
    const git = gitMetadata(cwd);
    const payload = {
      artifact_id: artifactId,
      schema_version: SCHEMA_VERSION,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      workspace: git.workspace,
      repo: git.repo,
      source: {
        surface: "cli",
        command,
      },
      content: {
        sha256: hash,
        bytes: Buffer.byteLength(rawText, "utf8"),
        estimated_tokens: estimateTokens(rawText),
        redacted,
        mime: "text/plain",
      },
      policy: {
        mode,
        reason_code: reasonCode,
        redaction_policy: redacted ? "standard-secret-redaction" : "none",
      },
      raw_base64: Buffer.from(rawText, "utf8").toString("base64"),
    };

    await mkdir(path.dirname(this.artifactPath(artifactId)), { recursive: true });
    await writeFile(this.artifactPath(artifactId), `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  async get(artifactId) {
    let payload;
    try {
      payload = JSON.parse(await readFile(this.artifactPath(artifactId), "utf8"));
    } catch (error) {
      const miss = new Error(`CR_RETRIEVE_MISSING: artifact ${artifactId} was not found`);
      miss.code = "CR_RETRIEVE_MISSING";
      throw miss;
    }

    if (payload.schema_version !== SCHEMA_VERSION) {
      const mismatch = new Error(`CR_RETRIEVE_SCHEMA_MISMATCH: ${artifactId}`);
      mismatch.code = "CR_RETRIEVE_SCHEMA_MISMATCH";
      throw mismatch;
    }

    const rawText = Buffer.from(payload.raw_base64 || "", "base64").toString("utf8");
    if (sha256(rawText) !== payload.content.sha256) {
      const corrupt = new Error(`CR_RETRIEVE_HASH_MISMATCH: ${artifactId}`);
      corrupt.code = "CR_RETRIEVE_HASH_MISMATCH";
      throw corrupt;
    }

    if (new Date(payload.expires_at).getTime() <= this.now().getTime()) {
      const expired = new Error(`CR_RETRIEVE_EXPIRED: artifact ${artifactId} expired at ${payload.expires_at}`);
      expired.code = "CR_RETRIEVE_EXPIRED";
      expired.expiresAt = payload.expires_at;
      throw expired;
    }

    return { payload, rawText };
  }

  async readStats() {
    const stats = {
      runs: 0,
      raw: 0,
      compressed: 0,
      passthrough: 0,
      blocked: 0,
      retrievals: 0,
      retrieval_miss: 0,
      raw_bytes: 0,
      sent_bytes: 0,
      retrieval_bytes: 0,
      gross_saved_bytes: 0,
      net_saved_bytes: 0,
      gross_saved_estimated_tokens: 0,
      net_saved_estimated_tokens: 0,
      gross_efficiency_percent: 0,
      net_efficiency_percent: 0,
    };
    const events = await this.readEvents();
    for (const event of events) {
      stats[event.kind] = (stats[event.kind] || 0) + 1;
      if (event.kind !== "retrievals" && event.kind !== "retrieval_miss") {
        stats.runs += 1;
      }
      stats.raw_bytes += event.rawBytes || 0;
      stats.sent_bytes += event.sentBytes || 0;
      stats.retrieval_bytes += event.retrievalBytes || 0;
    }
    stats.gross_saved_bytes = Math.max(0, stats.raw_bytes - stats.sent_bytes);
    stats.net_saved_bytes = Math.max(0, stats.raw_bytes - stats.sent_bytes - stats.retrieval_bytes);
    stats.gross_saved_estimated_tokens = Math.ceil(stats.gross_saved_bytes / 4);
    stats.net_saved_estimated_tokens = Math.ceil(stats.net_saved_bytes / 4);
    if (stats.raw_bytes > 0) {
      stats.gross_efficiency_percent = Number(((stats.gross_saved_bytes / stats.raw_bytes) * 100).toFixed(1));
      stats.net_efficiency_percent = Number(((stats.net_saved_bytes / stats.raw_bytes) * 100).toFixed(1));
    }
    return stats;
  }

  async readEvents() {
    let text = "";
    try {
      text = await readFile(this.statsPath(), "utf8");
    } catch {
      return [];
    }
    const events = [];
    for (const line of text.split(/\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore corrupt event lines; the store is append-only local telemetry.
      }
    }
    return events;
  }

  async record(event) {
    await mkdir(path.dirname(this.statsPath()), { recursive: true });
    await appendFile(this.statsPath(), `${JSON.stringify({ ...event, at: this.now().toISOString() })}\n`);
  }

  async cleanup({ all = false } = {}) {
    let artifacts = [];
    try {
      artifacts = await readdir(this.artifactsDir());
    } catch {
      artifacts = [];
    }

    let removedArtifacts = 0;
    for (const file of artifacts) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const artifactPath = path.join(this.artifactsDir(), file);
      let shouldRemove = all;
      if (!shouldRemove) {
        try {
          const payload = JSON.parse(await readFile(artifactPath, "utf8"));
          const expiresAt = new Date(payload.expires_at).getTime();
          shouldRemove = !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime();
        } catch {
          shouldRemove = true;
        }
      }
      if (shouldRemove) {
        await rm(artifactPath, { force: true });
        removedArtifacts += 1;
      }
    }

    let removedEvents = false;
    if (all) {
      await rm(this.statsPath(), { force: true });
      removedEvents = true;
    }

    return {
      removed_artifacts: removedArtifacts,
      removed_events: removedEvents,
      mode: all ? "all" : "expired",
    };
  }
}
