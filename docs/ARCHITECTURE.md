# Architecture

## Flow
1. **Ingest.** ThinLine Radio sends alerts to the Worker's webhook. A backup poller (`POLL=on`, every minute) reads TLR's transcripts API for alert keywords the webhook missed, and while an incident is active it saves the surrounding radio traffic as context batches (`CONTEXT=on`).
2. **Wake.** The Worker batches new items and fires the Claude scheduled task through its API trigger, at most every `WAKE_EVERY_MINUTES` (urgent words sooner). Routine wakes can go to a cheaper light task. A run counts as in progress until its run log arrives.
3. **Agent run.** The task calls `get_work` on the scribe connector (MCP at `/mcp`), reads `CORE.md`, the profile's `RULES.md` and `local/`, and creates or updates drafts, tracking records and the storm tracker. It finishes with `runlog_write`.
4. **Review.** Drafts appear on `/review` (Cloudflare Access). The owner edits, publishes, holds or discards them. Scheduled auto-posts, when enabled, publish after a delay unless held.
5. **Publish.** The Worker posts to the Facebook Page (Graph API) and edits live posts as updates arrive. Discord and Pushover get notices.

## Storage
- **D1** (`DB`): alerts, context batches, incidents (tracking records), posts and their versions, run logs, corrections, storm tracker, prayer counts. Tables are created on first use; old alerts and batches are cleaned after `D1_KEEP_DAYS`.
- **KV** (`SEEN`): poller cursors, wake timing, notice de-duplication.

## Safety
- The agent never publishes. Only the Worker publishes: on the owner's action, or a scheduled auto-post the rules allowed.
- Post versions: the owner's edits win. An agent update against an old version is refused and must be re-applied to the current text.
- Secrets are Worker secrets only.
- LOCKED categories in `CORE.md` cannot be turned on by local settings.

## Profiles
A profile is a `RULES.md` plus templates. The Worker and connector are the same for every profile; the profile decides what traffic matters and what the output looks like. `public-safety` is complete; `railroad` is planned.

## Tools
- `tools/fetch_roads.py`: builds road files from OpenStreetMap (roads, route names, intersections and road points with coordinates, interstate exits, addressed places).
- `tools/roadmatch.py`: sound-alike road matching for garbled transcripts (consonant skeletons, weighted edits for radio and accent confusions, cross-road boost).
- `tools/build_worker.py`: inlines `worker/review.html` into `worker.js`.
