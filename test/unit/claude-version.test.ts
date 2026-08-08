/**
 * The Claude Code version check in `lifeline doctor`.
 *
 * lifeline owns ~/.local/bin/claude, so Claude Code's updater can no longer repoint it — which
 * makes "which version you actually launch" lifeline's responsibility, and something that can
 * silently fall behind. It did: a recorded absolute path was preferred over the newest install,
 * pinning claude to whatever was current on install day across two releases without a word.
 * These cases keep that failure loud.
 */

import { describe, expect, it } from "vitest";
import type { ClaudeVersionCheck } from "../../src/cli/commands.js";
import { baseUrlVerdict, claudeVersionVerdict } from "../../src/cli/commands.js";

function check(over: Partial<ClaudeVersionCheck> = {}): ClaudeVersionCheck {
  return { active: "2.1.226", newest: "2.1.226", unmanaged: false, ...over };
}

describe("claudeVersionVerdict", () => {
  it("is quiet when the launched version is the newest installed", () => {
    const verdict = claudeVersionVerdict(check());
    expect(verdict.level).toBe("ok");
    expect(verdict.detail).toContain("2.1.226");
  });

  it("warns — and names both versions — when the launcher is behind", () => {
    const verdict = claudeVersionVerdict(check({ active: "2.1.224", newest: "2.1.226" }));
    expect(verdict.level).toBe("warn");
    expect(verdict.detail).toContain("2.1.224");
    expect(verdict.detail).toContain("2.1.226");
  });

  it("tells the user how to distinguish a stale record from a real pin", () => {
    const verdict = claudeVersionVerdict(check({ active: "2.1.224", newest: "2.1.226" }));
    expect(verdict.detail).toContain("run claude once");
    expect(verdict.detail).toContain("pinning");
  });

  it("orders by version number, not string — 2.1.9 is behind 2.1.10", () => {
    expect(claudeVersionVerdict(check({ active: "2.1.9", newest: "2.1.10" })).level).toBe("warn");
    expect(claudeVersionVerdict(check({ active: "2.1.10", newest: "2.1.9" })).level).toBe("ok");
  });

  it("stays quiet on a non-standard install with no versions directory", () => {
    const verdict = claudeVersionVerdict(check({ active: null, newest: null, unmanaged: true }));
    expect(verdict.level).toBe("ok");
  });

  it("does not warn before claude has ever been launched through the wrapper", () => {
    const verdict = claudeVersionVerdict(check({ active: null }));
    expect(verdict.level).toBe("ok");
    expect(verdict.detail).toContain("not been launched");
  });

  it("does not warn when the launcher is somehow ahead of the newest on disk", () => {
    expect(claudeVersionVerdict(check({ active: "2.1.227", newest: "2.1.226" })).level).toBe("ok");
  });
});

/**
 * The routing check. lifeline is only in the request path if claude actually resolves to the
 * gateway, and Claude Code resolves settings.json BEFORE the environment. The original check
 * read the shell alone, so a proxy parked in settings.json produced a scary `fail` in one
 * shell and a clean `ok` in another while claude bypassed the gateway in both.
 */
describe("baseUrlVerdict", () => {
  const GATEWAY = "http://127.0.0.1:8787";
  const PROXY = "http://127.0.0.1:8858";

  it("is quiet when settings.json names the gateway, and says what sits behind it", () => {
    const v = baseUrlVerdict({ settings: GATEWAY, shell: null }, GATEWAY, PROXY);
    expect(v.level).toBe("ok");
    expect(v.detail).toContain("settings.json");
    expect(v.detail).toContain(PROXY);
  });

  it("is quiet when nothing is set — the wrapper exports the gateway at launch", () => {
    expect(baseUrlVerdict({ settings: null, shell: null }, GATEWAY, PROXY).level).toBe("ok");
  });

  it("warns when settings.json points at a proxy, because claude bypasses the gateway", () => {
    const v = baseUrlVerdict({ settings: PROXY, shell: null }, GATEWAY, "https://api.anthropic.com");
    expect(v.level).toBe("warn");
    expect(v.detail).toContain("bypassing lifeline");
  });

  it("lets settings.json outrank the shell — the order Claude Code itself uses", () => {
    // The shell says gateway, but settings.json wins, so this is a bypass and must warn.
    const v = baseUrlVerdict({ settings: PROXY, shell: GATEWAY }, GATEWAY, PROXY);
    expect(v.level).toBe("warn");
    expect(v.detail).toContain("settings.json");
  });

  it("falls back to the shell only when settings.json sets nothing", () => {
    const v = baseUrlVerdict({ settings: null, shell: GATEWAY }, GATEWAY, PROXY);
    expect(v.level).toBe("ok");
    expect(v.detail).toContain("this shell");
  });

  it("tells the user the bypass self-repairs, rather than leaving them to fix it", () => {
    const v = baseUrlVerdict({ settings: PROXY, shell: null }, GATEWAY, PROXY);
    expect(v.detail).toContain("re-chains");
  });

  it("ignores trailing slashes and case when matching the gateway", () => {
    expect(baseUrlVerdict({ settings: `${GATEWAY}/`, shell: null }, GATEWAY, PROXY).level).toBe("ok");
  });
});
