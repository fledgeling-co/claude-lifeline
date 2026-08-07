# lifeline

**A resilience layer for Claude Code's Workflow feature. It stops your multi-agent runs from quietly losing work.**

Set-and-forget, one command, macOS. It never touches Anthropic's signed binary.

```bash
curl -fsSL https://raw.githubusercontent.com/lprhodes/lifeline/main/install.sh | bash
```

Your command is still `claude`. It just stops losing your work.

## Why this exists

I ran the numbers over every dynamic-workflow run on my machine. 1,054 of them. 646 (61%) silently lost at least one agent, and 1,816 of 4,630 agents (39%) died along the way.

Here's the part that got me: you'd never know. When a workflow agent hits an API error, the runtime treats it as terminal. It returns `null`, zero retries. The `parallel()` / `pipeline()` `.filter(Boolean)` quietly drops the dead one, and the whole run reports **`completed`**. So "the workflow finished" and "the work actually got done" turn out to be unrelated claims.

The things doing the killing, in order:

- **session / usage limits: 1,168 deaths.** These don't heal on their own; they reset at a fixed time.
- **rate limits (429): 271.** Retryable, and nobody was retrying.
- **ConnectionRefused: 197.** Usually a local proxy or gateway blinking, not the model.
- **5xx / overload.** Server-side, temporary, retryable.
- **"all accounts exhausted"** from multi-account proxies.

Backoff-free, retry-free, silent. That's the gap lifeline fills.

## What it does

- **Auto-retry for every retryable failure.** Exponential backoff with full jitter, up to 30 attempts, and the retry state survives a process restart. Rate limits, 5xx, and connectivity errors heal on their own.
- **It knows what's worth retrying.** 429/529 honour `Retry-After`; 5xx back off with jitter; ConnectionRefused becomes a connectivity signal rather than a wasted attempt; "prompt too long" is terminal and never blind-retried (throwing it at the wall 30 times helps nobody).
- **Retry and Resume are the same button.** Press it on a failed agent or workflow and the red cross clears. Auto-retry presses it for you. Pressing it again when there's nothing to do is safe.
- **Usage-limit recovery that understands multiple accounts.** When you hit a limit, the agent parks in a paused state and retries on a schedule, picking up whichever proxy account frees up first. It does not hard-sleep to a single reset time, because if you're running several accounts they reset at different times.
- **A failed agent while its siblings are still working shows as a warning, not an error.** The run only goes red when the whole thing actually fails. One dropped agent out of twelve shouldn't look like a house fire.
- **Pause a single agent, or a whole workflow** (which pauses all its subagents). Manually, or automatically.
- **Connectivity-aware auto-pause.** Network drops, the run pauses instead of burning through retries. Network comes back, agents resume on jittered timing so they don't all stampede the API at once.
- **Live queue changes.** Enqueue new work, drop pending items, or message a specific agent as new work turns up, without tearing the whole workflow down and rebuilding it.
- **Templating.** The workflows you run over and over get saved as reusable, parameterised templates and re-run on demand.
- **The CLI's own model knows about all of this.** The new capabilities are exposed through the tool descriptions, so Claude knows it can pause a run, resume it, add work, and reach for a template.
- **A version check that fails closed.** lifeline fingerprints the CLI's stable contracts. When Claude Code auto-updates, a background watcher re-checks compatibility and tells you if a new patch is needed. It won't mis-apply against a version it doesn't recognise; it says so and stays out of the way.

## How it works (and what it doesn't touch)

The installed Claude Code CLI is now a Bun-compiled, code-signed binary with its logic in bytecode. You can't safely patch that in place, and even if you could, it'd break on the next update. So lifeline doesn't try.

It works at three stable seams instead:

- a small local **gateway** on the API path that heals transport failures (the retries and connectivity handling);
- a **daemon** that watches the workflow journal on disk and drives recovery (the silent-loss detection, the 30-retry ledger, the usage-limit parking);
- a **control plane**, an MCP server plus a `lifeline` status view, for the pause, resume, enqueue, and templating controls.

Anthropic's binary stays untouched and signed. `claude` stays `claude`.

## Install

macOS, one command:

```bash
curl -fsSL https://raw.githubusercontent.com/lprhodes/lifeline/main/install.sh | bash
```

It installs the gateway, the daemon, the MCP server, the `lifeline` CLI, and a launchd watcher; repoints your own `claude` launcher through the gateway; and then leaves you alone.

Note: if you set `ANTHROPIC_API_KEY` directly it bypasses the gateway, so lifeline can't heal transport errors on that path. The installer flags this and shows you how to route through it instead.

## Status and roadmap

v1 is the resilience core, the part that kills the top three failure modes above:

- auto-retry with backoff and the 30-attempt ledger
- usage-limit and accounts-exhausted recovery
- silent-loss detection and resume
- the MCP server that teaches Claude's own model to check status, retry, pause, and resume
- the one-command installer and fail-closed version check
- the fault-injection eval harness

Staged after that:

- **the control-plane UI**: the richer status view and the red-cross-to-warning display, plus enqueue/dequeue of work in a running workflow
- **templating**: save and reuse your common workflows
- **an optional deeper hook** for the npm/`node` install of Claude Code, where the built-in view itself can be recoloured

(Messaging a specific running agent already works natively in Claude Code via SendMessage; lifeline doesn't duplicate it.)

I'd rather ship the core that stops the bleeding first and be honest that the rest is coming, than claim the whole thing on day one.

## A note on the built-in feature

lifeline doesn't replace Claude Code's Workflow feature; it hardens the one that's already there. You keep the built-in fan-out, the journal, the resume path. lifeline is the layer that makes them hold up when the API has a bad night.

## Licence

MIT.
