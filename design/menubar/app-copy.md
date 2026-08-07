# lifeline app copy

## First-run / not set up
Heading: lifeline isn't set up yet
Body: lifeline sits next to Claude Code and brings back the workflow agents it quietly drops when they hit a rate limit, a dropped connection, or a usage cap. Setting it up adds three small background helpers: one smooths the API connection so blips get retried, one watches your workflows and recovers agents that fall over, and one re-checks that everything still fits whenever Claude Code updates. Your command stays claude, Anthropic's app is never touched, and one command removes the lot.
Primary button: Set up lifeline
Secondary button: What it changes
Footer: Nothing happens until you say so.

## Setting up (in progress)
Step 1: Starting the connection helper
Step 2: Starting the workflow watcher
Step 3: Routing claude through the helper (claude stays your command)
Step 4: Recording a compatibility fingerprint of your Claude Code
Done: Set up. lifeline's watching.
Footer: About a minute, and reversible any time.

## No workflows running
Heading: Nothing running right now
Body: Start a workflow in Claude Code and it shows up here, watched.

## Watcher quiet
Banner: The watcher's gone quiet; last update {time} ago, so what's below might be stale. Run lifeline doctor in a terminal to check on it.

## Small labels
Pill online: online
Pill not set up: not set up
Pill quiet: quiet
Quit: Quit lifeline
Retry all failed: Retry failed agents
Pause run: Pause run
Resume run: Resume run
Agent retry: Retry
Agent resume: Resume
Show more log: more
Show less log: less
Tooltip healthy: 2 workflows tracked, all healthy
Tooltip attention: 2 workflows tracked, 1 needs a look
