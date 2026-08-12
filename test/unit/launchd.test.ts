/**
 * The launchd check in `lifeline doctor`.
 *
 * On 2026-08-12 a fan-out lost its agents to an upstream error while lifeline had been absent
 * for eighteen hours: three of its agents sat in launchd's PERSISTENT disabled list, where
 * `bootstrap` fails and the wrapper's `kickstart` fails forever without a word. Every other
 * check could only say "not running", which reads like a crash and invites a pointless restart.
 * These cases keep the real cause — and the one command that clears it — on screen.
 */

import { describe, expect, it } from "vitest";
import type { LaunchdCheck } from "../../src/cli/commands.js";
import { launchdVerdict } from "../../src/cli/commands.js";

function check(services: LaunchdCheck["services"]): LaunchdCheck {
  return { services };
}

describe("launchdVerdict", () => {
  it("is quiet when launchd holds every agent", () => {
    const v = launchdVerdict(
      check({ "com.lifeline.gateway": "loaded", "com.lifeline.daemon": "loaded" }),
    );
    expect(v.level).toBe("ok");
  });

  it("fails loudly on a disabled agent and names the command that clears it", () => {
    const v = launchdVerdict(
      check({ "com.lifeline.gateway": "loaded", "com.lifeline.daemon": "disabled" }),
    );
    expect(v.level).toBe("fail");
    expect(v.detail).toContain("com.lifeline.daemon");
    expect(v.detail).toContain("disabled");
    expect(v.detail).toContain("launchctl enable");
    // The property that made this invisible for eighteen hours.
    expect(v.detail).toContain("survives reboots");
  });

  it("reports disabled ahead of absent — it is the state a re-install may not clear", () => {
    const v = launchdVerdict(
      check({ "com.lifeline.gateway": "absent", "com.lifeline.daemon": "disabled" }),
    );
    expect(v.level).toBe("fail");
    expect(v.detail).toContain("launchctl enable");
  });

  it("fails on an unregistered agent and points at the installer", () => {
    const v = launchdVerdict(
      check({ "com.lifeline.gateway": "absent", "com.lifeline.daemon": "loaded" }),
    );
    expect(v.level).toBe("fail");
    expect(v.detail).toContain("com.lifeline.gateway");
    expect(v.detail).toContain("install.sh");
  });

  it("stays quiet where there is no launchd to ask", () => {
    expect(launchdVerdict(check(null)).level).toBe("ok");
  });

  it("treats an unknown state as no evidence rather than as a fault", () => {
    const v = launchdVerdict(
      check({ "com.lifeline.gateway": "unknown", "com.lifeline.daemon": "loaded" }),
    );
    expect(v.level).toBe("ok");
  });
});
