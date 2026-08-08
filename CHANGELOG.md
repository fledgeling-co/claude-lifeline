# Changelog

## 0.4.0 (2026-08-09)

The release that makes lifeline keep its main promise, and makes the status window readable at a glance.

### Fixed

- **Stalled agents were never recovered.** This is the big one. lifeline spotted an agent that had gone silent, worked out it was retryable, scheduled a retry, and then quietly dropped it. Silent loss is the whole reason this thing exists, so the one state that names it was the one state that could not be rescued. Found on a run whose agent had been dead for 91 minutes with a retry scheduled 12 minutes earlier. Nudging now happens, and because a retry is really a resume, an agent that turns out to be alive just carries on rather than doing its work twice.
- A stalled agent is now shown straight away but left alone for half an hour before anything is done about it. Ten minutes of quiet is enough to tell you something looks stuck; it is not enough to be sure it is dead.
- An agent that died on an API error and then had one more line written after it (an interrupt, say) was filed as merely quiet rather than lost, because that last line hid the error underneath. It gets looked past now.

### Added

- **Plain-language summaries.** Turn it on and each workflow gets a short title and a line saying where it is, like "waiting on 3 tasks", with a note on each agent saying what it is working on. It reads the recent output lifeline already has, and it does not ask again while nothing has changed, so an agent that is thinking rather than typing costs nothing. It uses your existing Claude login; there is no key to set up. **Off until you turn it on**, because it is the only part of lifeline that spends money.
- The workflow's generated title now leads its row with the run id beside it, so you can still copy the id when you need it.
- A settings menu behind the `···` button: the summaries switch, and how long finished workflows stay in the list. **Hide when finished** is one of the choices.
- Expanding and collapsing a workflow is animated now, using the same movement as the rest of the window. With Reduce Motion on there is no movement at all, rather than a faster version of it.

### Changed

- If you route claude through your own proxy as well, lifeline now writes down what it is forwarding to, so your proxy can tell it is still in the chain and leave the routing alone instead of the two of them overwriting each other. There is a short section in the README about it.

## 0.3.1 (2026-08-08)

A follow-up to 0.3.0. Everything here is a way the last release could quietly stop protecting you, found by reviewing it properly rather than by anyone hitting it.

### Fixed

- **The gateway could be made its own upstream.** A base URL differing only by a trailing slash, a capital letter or the word `localhost` didn't match, so lifeline treated its own address as a foreign proxy and chained itself to itself. Every request then bounced back into the same listener until it ran out of sockets. URLs are compared as endpoints now, and there's a second check that refuses the self-loop outright.
- The wrapper read the gateway's port from your shell, which doesn't carry it. If you'd installed on any port other than 8787 it pinned your settings to a dead one and handed the real gateway its own address as upstream. It reads `config.json` now, the same file the gateway is configured from.
- **The settings heal could write a gateway that wasn't running.** That write is durable and outranks your environment, so one launch while the gateway was down took claude off the air until someone edited the file by hand. It now checks the gateway is answering first, and a stopped gateway once again just means "runs unhealed" rather than "doesn't run".
- Config, settings and the recorded launcher are written through a temp file and renamed, so two sessions starting together can't leave a half-written file. A config that can't be parsed is left alone instead of replaced, which used to drop your port and proxy and silently fall back to the plain API.
- A recorded launcher living outside the versions directory is an npm or homebrew install's own script, and it's the only copy uninstall has. It's no longer overwritten.
- Uninstall could delete a proxy you added *after* installing, because the record said there'd been nothing there. It upgrades that record now.
- Re-running the installer no longer resurrects a proxy you removed, and it repairs the self-referential backup that older installers left behind rather than just declining to make a new one.
- `lifeline doctor` stopped warning that lifeline is holding you back when the version it named was one the wrapper deliberately won't launch yet. It also no longer promises to repair a base URL exported in your shell, which lifeline leaves alone on purpose; it tells you how to change it instead.
- A contract baseline is never recorded from a binary that was still downloading, which would have pinned permanent false drift on a version that's fine.

### Removed

- A stale second uninstaller at `install/uninstall.sh`, unreferenced and carrying the old restore logic.

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
