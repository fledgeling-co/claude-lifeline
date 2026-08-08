# Changelog

## 0.3.0 (2026-08-08)

If you've had lifeline installed for a while, it was quietly holding your `claude` on the version you had on install day. This release fixes that, along with a few other things that could go wrong without saying so.

### Fixed

- **Claude Code updates take effect again.** lifeline takes over the `claude` command, so Claude Code's own updater can't repoint it any more; lifeline was then launching a path it recorded at install time and never looked at again. It resolves the newest version you've got now, every time you launch. Worth a quick `claude --version` if you've been on lifeline for more than a day or two.
- A version file appears the moment its download starts, and the contract check ran on that first flicker. It read a half-written binary, decided something it depends on had moved, and dropped into **reduced mode for about ten seconds on every update**. It waits for the file to go quiet now.
- Uninstall restored the binary recorded on install day, which by then could be several versions old. It leaves you on a **current** Claude Code now.
- **Re-running the installer no longer damages what it saved.** It overwrote the backup of your original `claude` launcher with lifeline's own wrapper, so uninstall could cheerfully "restore" the wrapper; and if your settings were already chained, it dropped any proxy out of the route and sent traffic straight to the API. Both get written once now, then left alone.
- Versions were ordered by file date, through a `sort` whose reverse flag macOS quietly ignores, so **2.1.9 could come out ahead of 2.1.226**.

### Added

- **lifeline can't be bypassed silently.** Claude Code reads `~/.claude/settings.json` itself, and that beats anything lifeline sets when it launches you. So if the base URL there drifts off the gateway (a restored backup, another tool writing the file, a proxy added back by hand) lifeline was simply out of the request path, with retries quietly not happening and everything still looking fine. The wrapper re-chains it at launch now, and says so when it does. It works the same either way: whatever it displaces becomes the gateway's upstream, so you get `claude -> lifeline -> proxy -> api` with a proxy in front, or `claude -> lifeline -> api` without one. Set `LIFELINE_NO_SETTINGS_HEAL=1` if you'd rather it kept its hands off your settings.
- `lifeline doctor` reports the Claude Code version you last launched against the newest you have installed, so it **can't fall behind without telling you**.

### Changed

- `lifeline doctor` checks the route you'll actually take. It read the base URL from your shell, which isn't the one Claude Code uses; a proxy sitting in settings.json showed as a failure in one terminal and fine in another, while lifeline was bypassed in both. A bypass reads as a **warning rather than a failure** now, because launching claude repairs it.
- If an update is still downloading when you start claude, it runs the previous version instead of a half-finished file.

Note: the version pin is the one worth acting on. Everything else here either heals itself or only shows up at uninstall time.
