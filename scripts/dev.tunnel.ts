#!/usr/bin/env ts-node
/**
 * slack-local: Minimal CLI to start an ngrok tunnel, patch Slack manifest locally, run `slack run`, and clean up.
 *
 * Philosophy: fast defaults, almost no logs by default, no preflight checks.
 *
 * Flags:
 *   --port <n>      Tunnel local port (default: 3000)
 *   --manifest <p>  Path to manifest.json (default: ./manifest.json)
 *   --dry-run       Print what would happen, change nothing
 *   --persist       Do not restore manifest on exit
 *   --json          Emit a single JSON summary line (no other logs)
 *   --verbose       Print minimal progress messages
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";

// ---- tiny arg parser ----
function parseArgs(argv: string[]) {
  const args: Record<string, any> = {
    port: 3000,
    manifest: "./manifest.json",
    dryRun: false,
    persist: false,
    json: false,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--persist") args.persist = true;
    else if (a === "--json") args.json = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--manifest") args.manifest = argv[++i];
    else {
      // ignore unknowns to stay minimal
    }
  }
  return args;
}

// ---- logging helpers ----
const out = (s: string) => process.stdout.write(s + "\n");
const log = (enabled: boolean, s: string) => enabled && out(s);

// ---- ngrok helpers ----
function startNgrok(port: number, verbose: boolean) {
  // Let ngrok fail loudly if not installed/auth'd
  const proc = spawn("ngrok", ["http", String(port), "--log=stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Silence stdout unless verbose (ngrok logs are noisy)
  if (verbose) {
    proc.stdout.on("data", (d) => process.stderr.write(d));
    proc.stderr.on("data", (d) => process.stderr.write(d));
  }
  return proc;
}

function getTunnelUrl(timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const endpoint = "http://127.0.0.1:4040/api/tunnels";
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http
        .get(endpoint, (res) => {
          let data = "";
          res.on("data", (c) => {
            data += c;
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const tunnels = (json.tunnels || []) as any[];
              const https = tunnels.find(
                (t) => t?.public_url?.startsWith("https://"),
              );
              if (https) return resolve(https.public_url);
              if (Date.now() > deadline)
                return reject(new Error("Tunnel URL not found before timeout"));
              setTimeout(tryOnce, 250);
            } catch (_error) {
              if (Date.now() > deadline)
                return reject(new Error("Failed to parse ngrok API response"));
              setTimeout(tryOnce, 250);
            }
          });
        })
        .on("error", () => {
          if (Date.now() > deadline)
            return reject(new Error("ngrok API not reachable on :4040"));
          setTimeout(tryOnce, 250);
        });
    };
    tryOnce();
  });
}

// ---- manifest patching ----
function replaceOrigin(url: string, newOrigin: string) {
  try {
    const u = new URL(url);
    const n = new URL(newOrigin);
    u.protocol = n.protocol;
    u.host = n.host;
    return u.toString();
  } catch {
    return url; // non-URL strings untouched
  }
}

type JSONValue = string | number | boolean | null | JSONObject | JSONArray;
interface JSONObject {
  [k: string]: JSONValue;
}
interface JSONArray extends Array<JSONValue> { }

const KNOWN_PATHS = [
  ["settings", "event_subscriptions", "request_url"],
  ["settings", "interactivity", "request_url"],
  ["features", "slash_commands", "*", "url"],
  ["oauth", "redirect_urls", "*"],
];

function get(obj: JSONValue, pathArr: (string | number)[]): any {
  let cur: any = obj;
  for (const key of pathArr) {
    if (cur == null) return undefined;
    cur = cur[key as any];
  }
  return cur;
}

function set(obj: JSONValue, pathArr: (string | number)[], value: any) {
  let cur: any = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (cur[k as any] == null)
      cur[k as any] = typeof pathArr[i + 1] === "number" ? [] : {};
    cur = cur[k as any];
  }
  cur[pathArr[pathArr.length - 1] as any] = value;
}

function expandWildcards(
  obj: any,
  path: (string | number)[],
): (string | number)[][] {
  const idx = path.indexOf("*");
  if (idx === -1) return [path];
  const head = path.slice(0, idx);
  const tail = path.slice(idx + 1);
  const arr = get(obj, head);
  if (!Array.isArray(arr)) return [];
  const out: (string | number)[][] = [];
  for (let i = 0; i < arr.length; i++) {
    out.push([...head, i, ...tail]);
  }
  return out;
}

function collectTargets(manifest: JSONObject): (string | number)[][] {
  const targets: (string | number)[][] = [];
  for (const p of KNOWN_PATHS) {
    const expanded = p.includes("*") ? expandWildcards(manifest, p) : [p];
    for (const pathArr of expanded) {
      const v = get(manifest, pathArr);
      if (typeof v === "string" && /^https?:\/\//.test(v))
        targets.push(pathArr);
    }
  }
  return targets;
}

async function readJSON(filePath: string): Promise<JSONObject> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJSON(filePath: string, data: JSONObject) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// ---- Slack config toggle (manifest source local) ----
async function maybeToggleConfigToLocal(
  projectRoot: string,
): Promise<{ changed: boolean; backupPath?: string }> {
  const cfgPath = path.join(projectRoot, "config.json");
  try {
    const raw = await fs.readFile(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    const prev = cfg?.manifest?.source;
    if (prev === "local") return { changed: false };
    if (!cfg.manifest) cfg.manifest = {};
    cfg.manifest.source = "local";
    const backup = `${cfgPath}.backup`;
    await fs.writeFile(backup, raw, "utf8");
    await fs.writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    return { changed: true, backupPath: backup };
  } catch {
    // If config.json doesn't exist or can't be parsed, ignore silently.
    return { changed: false };
  }
}

async function restoreFile(backupPath?: string, targetPath?: string) {
  if (!backupPath || !targetPath) return;
  try {
    const raw = await fs.readFile(backupPath);
    await fs.writeFile(targetPath, raw);
    await fs.unlink(backupPath).catch(() => { });
  } catch {
    // ignore
  }
}

// ---- main ----
(async function main() {
  const args = parseArgs(process.argv);
  const projectRoot = process.cwd();
  const manifestPath = path.resolve(projectRoot, args.manifest);
  const tempDir = path.join(projectRoot, ".slackdev");
  const tempManifestPath = manifestPath; // inline edit for local-manifest mode (with backup)
  const manifestBackupPath = `${manifestPath}.backup`;

  let ngrokProc: ReturnType<typeof startNgrok> | null = null;
  let cfgBackupPath: string | undefined;
  let cfgChanged = false;
  const patchedKeys: string[] = [];
  let tunnelUrl = "";

  const cleanup = async () => {
    if (args.persist) return; // keep current state
    // restore manifest
    await restoreFile(manifestBackupPath, manifestPath);
    // restore config.json if toggled
    if (cfgChanged)
      await restoreFile(cfgBackupPath, path.join(projectRoot, "config.json"));
    // stop ngrok
    if (ngrokProc && !ngrokProc.killed) {
      try {
        ngrokProc.kill("SIGTERM");
      } catch { }
    }
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });
  process.on("exit", async () => {
    await cleanup();
  });

  try {
    // Toggle Slack CLI to use local manifest if applicable
    const toggled = await maybeToggleConfigToLocal(projectRoot);
    cfgChanged = toggled.changed;
    cfgBackupPath = toggled.backupPath;

    // Read and (maybe) patch manifest
    const manifest = await readJSON(manifestPath);

    // Start ngrok unless dry-run
    if (!args.dryRun) {
      log(args.verbose, `Starting ngrok on port ${args.port}…`);
      ngrokProc = startNgrok(args.port, args.verbose);
      tunnelUrl = await getTunnelUrl();
    } else {
      tunnelUrl = "https://example-tunnel.ngrok-free.app"; // placeholder for dry-run
    }

    // Collect targets and patch
    const targets = collectTargets(manifest);
    for (const p of targets) {
      const current = get(manifest, p);
      if (typeof current === "string") {
        const updated = replaceOrigin(current, tunnelUrl);
        if (updated !== current) {
          set(manifest, p, updated);
          patchedKeys.push(p.map(String).join("."));
        }
      }
    }

    if (args.dryRun) {
      if (args.json) {
        out(
          JSON.stringify({
            tunnelUrl,
            port: args.port,
            manifestPath,
            patchedKeys,
          }),
        );
      } else {
        out(`Would use tunnel: ${tunnelUrl}`);
        out(`Would patch ${patchedKeys.length} field(s)`);
        if (args.verbose) {
          patchedKeys.forEach((k) => { out(`- ${k}`); });
        }
        out(`Would run: slack run`);
      }
      return;
    }

    // Backup + write manifest
    try {
      const raw = await fs.readFile(manifestPath);
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(manifestBackupPath, raw);
    } catch { }
    await writeJSON(tempManifestPath, manifest);

    if (args.json) {
      out(
        JSON.stringify({
          tunnelUrl,
          port: args.port,
          manifestPath: tempManifestPath,
          patchedKeys,
        }),
      );
    } else if (args.verbose) {
      out(`tunnel: ${tunnelUrl}`);
      out(`patched: ${patchedKeys.length}`);
    } else {
      // Bare-minimum: single-line summary
      out(`${tunnelUrl}`);
    }

    // Run slack
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("slack", ["run"], { stdio: "inherit" });
      proc.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`slack run exited with code ${code}`));
      });
      proc.on("error", reject);
    });
  } catch (err: any) {
    if (args.json) {
      out(JSON.stringify({ error: err?.message || String(err) }));
    } else {
      out(err?.message || String(err));
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
