# TLR Scribe

A companion agent for ThinLine Radio servers. It reads live scanner transcriptions and turns them into reviewed posts, summaries and alerts for social media, Discord and more.

TLR Scribe is an independent project built to work with ThinLine Radio's API. It is not part of ThinLine Radio or run by its developer; the name is used with the developer's permission.

## How it works

```
ThinLine Radio alerts + transcripts
        │  (webhook + backup poller)
        ▼
Cloudflare Worker ── D1 database ── review page (Cloudflare Access) ──► Facebook Page
        │                                   ▲
        │ wakes                             │ drafts
        ▼                                   │
Claude scheduled task ── scribe connector (MCP) ┘
   reads CORE.md + profiles/<profile>/RULES.md + your local/ files
```

- The **Worker** (`worker/`) stores alerts and the radio traffic around them, wakes the agent, serves the review page and publishes what you approve.
- The **agent** is a Claude scheduled task. It follows `CORE.md`, a **profile** (`profiles/public-safety/RULES.md`; railroad is planned) and your own settings in `local/`.
- The **image Worker** (`imageworker/`, optional) draws map images for posts.
- Nothing is published unless you publish it on the review page, or you turn on scheduled auto-posts for the categories you choose.

## Get started
- [docs/AI-SETUP.md](docs/AI-SETUP.md): hand this to your AI assistant (Claude, ChatGPT, Gemini...) and it walks you through setup.
- [docs/SETUP.md](docs/SETUP.md): deploy the Workers, create your instance repo and the scheduled task.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): what each part does.
- [docs/UPDATING.md](docs/UPDATING.md): pull core updates into your instance without touching your local files.
- [docs/RUNTIMES.md](docs/RUNTIMES.md): run the agent on Claude (the tested setup) or another AI platform.

## Repository layout
| Path | What |
|---|---|
| `CORE.md` | Rules every agent follows, whatever the profile |
| `profiles/<profile>/RULES.md` | What the agent does for that kind of traffic |
| `profiles/<profile>/templates/` | Blank `local/` files to copy when you set up |
| `local/` | **Your instance only** (not in this repo): coverage, settings, channels, departments, places, roads |
| `worker/` | The Cloudflare Worker (`worker.js`; `review.html` is inlined by `tools/build_worker.py`) |
| `imageworker/` | Optional map image Worker |
| `tools/` | Road builder (`fetch_roads.py`), road sound-alike matcher (`roadmatch.py`), channel ref filler (`fetch_channels.py`), TLR database exports (`tonesets.sql`, `talkgroups.sql`) |
| `tests/` | `node tests/run-all.mjs` runs the Worker tests against an in-memory D1 |

## Your responsibility
You decide what your page publishes. Sensitive categories (medical, domestic, overdose, mental health, death investigations, runaways) are off by default; if you switch one on, you are responsible for the privacy of the people involved, your scanner sources' terms and the laws where you are. Some categories are locked off for everyone.

## License
[PolyForm Shield 1.0.0](LICENSE). Free to use, change and run for your own TLR server and page, including a paid scanner service. You may not sell TLR Scribe itself or offer it as a competing product or service.
Road data from OpenStreetMap contributors (ODbL). Fonts in `imageworker/fonts` are under the SIL Open Font License.
