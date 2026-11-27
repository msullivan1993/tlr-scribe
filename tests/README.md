# Worker smoke tests

`node tests/run-all.mjs` (Node 22.5 or newer) copies `worker/worker.js` here as `worker.mjs` and runs each test
against an in-memory D1 database and KV store. Facebook, Discord, Pushover and the Claude triggers are faked, so
nothing leaves your machine.

| Test | Covers |
|---|---|
| `run.mjs` | the scribe connector: get_work, claim, mark, incidents, run logs, single-flight wakes |
| `ctx.mjs` | the transcript poller and radio batches (late transcriptions, corrections) |
| `posts.mjs` | drafts, versions, owner edits winning, publish, supersede, pull back, review API |
| `junk.mjs` | the Whisper hallucination / junk filter |
| `prayers.mjs` | the prayer tracker, the all-time scan and the self-updating Discord message |
| `wake.mjs` | wake timing and the urgent-alert lane |
| `urgent.mjs` | which alert wording counts as urgent |

`node tests/serve.mjs` serves the review page with sample posts at http://localhost:8787/review to click through.
These are smoke tests: they print what happened and fail on crashes, not on every wrong value.
