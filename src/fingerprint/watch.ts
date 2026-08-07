/**
 * launchd-side version watcher.
 *
 * Claude Code drops a new `versions/<ver>` roughly daily. When one appears we re-run the contract
 * probes and let `checkInstalledVersion` decide: verified versions are blessed silently, drift
 * raises the incompatibility flag that `lifeline doctor` surfaces. The watcher only ever reads.
 */

import { watch } from "chokidar";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeLogger } from "../shared/logger.js";
import { claudeVersionsDir } from "../shared/paths.js";
import type { FingerprintDeps, VersionCheck } from "./index.js";
import { checkInstalledVersion, isVersionName } from "./index.js";

const log = makeLogger("version-watch");

/**
 * A version file is ~265MB, so the `add` event fires long before the download finishes. Wait for
 * the size to settle before probing it.
 */
const DEFAULT_SETTLE_MS = 5_000;

export interface Watcher {
  stop(): void;
}

export interface WatchVersionsDeps extends FingerprintDeps {
  /** Called once per newly appeared version entry. */
  onNewVersion?: (version: string, path: string) => void;
  /** Write-settle threshold, ms. */
  settleMs?: number;
}

export interface StartWatcherDeps extends WatchVersionsDeps {
  /** Called after every completed check — the notification hook. */
  onCheck?: (result: VersionCheck) => void;
  /** Check once at startup as well as on new versions. Defaults to true. */
  checkOnStart?: boolean;
}

/** Watch the versions directory and report version-shaped entries as they appear. */
export function watchVersions(deps: WatchVersionsDeps = {}): Watcher {
  const dir = (deps.versionsDir ?? claudeVersionsDir)();
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;

  const watcher = watch(dir, {
    depth: 0,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: settleMs, pollInterval: 500 },
  });

  const onEntry = (path: string): void => {
    const name = basename(path);
    if (!isVersionName(name)) return;
    log.info(`new Claude Code version detected: ${name}`);
    deps.onNewVersion?.(name, path);
  };

  watcher.on("add", onEntry);
  watcher.on("addDir", onEntry);
  watcher.on("error", (err: unknown) => log.error(`watcher error on ${dir}`, String(err)));

  log.info(`watching ${dir}`);
  return {
    stop() {
      void watcher.close();
    },
  };
}

/**
 * Wire the watcher to the fingerprint check. Checks are serialised — an update that lands while a
 * probe is running is coalesced into a single follow-up pass rather than racing it.
 */
export function startWatcher(deps: StartWatcherDeps = {}): Watcher {
  let inFlight = false;
  let queued = false;
  let stopped = false;

  const runCheck = (reason: string): void => {
    if (stopped) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    void checkInstalledVersion(deps)
      .then((result) => {
        log.debug(`check (${reason}) -> ${result.reason}`);
        deps.onCheck?.(result);
      })
      .catch((err: unknown) => log.error(`version check failed (${reason})`, String(err)))
      .finally(() => {
        inFlight = false;
        if (queued && !stopped) {
          queued = false;
          runCheck("coalesced");
        }
      });
  };

  const watcher = watchVersions({
    ...deps,
    onNewVersion: (version, path) => {
      deps.onNewVersion?.(version, path);
      runCheck(`new-version:${version}`);
    },
  });

  if (deps.checkOnStart !== false) runCheck("startup");

  return {
    stop() {
      stopped = true;
      watcher.stop();
    },
  };
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  // launchd's WatchPaths re-launches this process on every versions-dir change, so under
  // launchd we run one check and exit (`--once`); resident chokidar watching is for
  // running it by hand or from the daemon.
  if (process.argv.includes("--once")) {
    const { checkInstalledVersion } = await import("./index.js");
    const result = await checkInstalledVersion();
    console.log(JSON.stringify({ version: result.version, compatible: result.compatible, reason: result.reason }));
    process.exit(result.compatible ? 0 : 2);
  } else {
    startWatcher();
  }
}
