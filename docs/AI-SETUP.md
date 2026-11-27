# AI-assisted setup

This is a playbook for an AI assistant (Claude, ChatGPT, Gemini, Copilot or any other) helping a ThinLine Radio server owner set up their own TLR Scribe instance. Give your assistant this file and the repository, then say "Help me set up TLR Scribe."

People can follow it too: it is the same steps as [SETUP.md](SETUP.md), in the order an assistant should walk through them, with what to ask, what to build and what to check.

---

## Instructions for the assistant

You are helping the owner set up TLR Scribe. Work through the phases below in order. At the start of each phase, say in one line what it does. Ask only the questions listed for that phase, and fill in the rest from what the owner has already told you or from the files they give you.

### Ground rules
1. **Secrets never pass through the chat.** API keys, tokens and passwords go into the Cloudflare dashboard (Worker secrets), `npx wrangler secret put`, or a local `.env` file that git ignores. Tell the owner where to put each one. Never ask them to paste one to you, and never write one into a file that gets committed.
2. **The ThinLine Radio database is production.** Only read-only `SELECT` queries on the config tables (`systems`, `talkgroups`), and only through the queries in `tools/`. Never select from `calls` without a time filter, never select the `audio` column, and never write, migrate or run DDL.
3. **Local files only.** Everything the owner customizes goes in `local/`. Do not edit `CORE.md`, `profiles/`, `worker/`, `tools/` or `docs/` for one instance's needs: those come from upstream and are overwritten by updates. A real bug in them goes upstream as an issue or pull request.
4. **Owner's call on content.** Sensitive categories (medical, domestic, overdose, mental health, death investigations, runaways) stay `skip` unless the owner turns one on. If they do, repeat the responsibility note in `local/LOCALRULES.md` once. LOCKED categories in `CORE.md` cannot be turned on.
5. **Ask before anything you can't undo**: deleting files, overwriting an existing `local/` file, deploying over a Worker that already runs.
6. **Commands:** ask once which OS the owner uses. Give PowerShell for Windows and bash for macOS or Linux. Run commands yourself only if you have a shell on their machine; otherwise give them to run and wait for the output.

### Phase 1: What they have
Ask, in one message:
- Their TLR server address (e.g. `https://scanner.example.com`), and whether they can create an API key with the **Transcripts** capability.
- The page or channel they want to post to (a Facebook Page today), and its exact name.
- The counties they cover, with state.
- Whether they have a Cloudflare account, a GitHub account, and an AI platform that can run scheduled or webhook-triggered agents with MCP connectors (see [RUNTIMES.md](RUNTIMES.md)).
- Their time zone.

### Phase 2: Instance repository
Goal: a **private** copy of the repo with `upstream` pointing at tlr-scribe, and `local/` created from the templates.
- Give the commands from [SETUP.md](SETUP.md) step 1. A GitHub fork of a public repo cannot be private, so use the clone-and-rename-remote method.
- Check: `git remote -v` shows `origin` (theirs, private) and `upstream` (tlr-scribe), and `local/LOCALRULES.md` exists.

### Phase 3: Local files
Build each file from what the owner tells you. Show a short summary of each file before writing it.

1. **`local/LOCALRULES.md`**, filled from Phase 1:
   - PAGE: the page name, a region name, the site address (no `https://`) and two FOOTER lines (a disclaimer plus a link line, e.g. "Listen live ➜ scanner.example.com").
   - COVERAGE: the counties.
   - SETTINGS: keep `AUTO_POST: off` for now.
   - CATEGORIES: the defaults, unless the owner asks for changes.
   - STATE POLICE, AIRPORTS, MUTUAL AID PARTNERS, DAILY TESTS: ask once whether any apply. Remove the sections that don't.
2. **`local/counties.txt`**: one `Name:ST:FIPS` line per county. You may look up FIPS codes; the owner confirms the list.
3. **`local/channels.csv` and `local/systems.csv`**: the talkgroup key.
   - Best source: the owner runs `tools/talkgroups.sql` (read-only) in psql and gives you the CSV. Without database access: `py tools/fetch_channels.py --hours 168` writes `local/channels-seen.csv` from recent calls.
   - From that list, propose rows only for the channels that matter: fire and EMS paging, dispatch, sheriff and police, fireground and tac, state police, air medical.
   - For each row fill `role`, `can_start` (`yes`, or `NO...` for update-only channels: EMS, air medical, tac, fireground) and `default_place`. Ask the owner about any channel whose purpose isn't clear from its name. Never guess a channel's county.
   - Then run `py tools/fetch_channels.py --from <csv> --fill` (or `--fill` alone) to add the system and talkgroup refs.
4. **`local/departments.csv`**: if they use tone-outs, they export with `tools/tonesets.sql`. Build one row per department: system, department, type, stations, units, tone names. Leave cells blank rather than guess.
5. **`local/places.md`, `local/units.md`, `local/codes.md`**: start them nearly empty from the templates. Ask the owner for anything they already know (unit numbering, local 10-codes, place names transcripts get wrong). These grow from real posts later.
6. **Road files**: `py tools/fetch_roads.py` builds `local/roads/` from OpenStreetMap. It is slow (Overpass rate limits): tell the owner to start it and let it run.
- Check: `channels.csv` and `departments.csv` parse as CSV (a field with a comma must be quoted). Every system name in them matches a system name from TLR exactly. Then commit and push.

### Phase 4: Cloudflare Worker
Walk through [SETUP.md](SETUP.md) step 2: D1 database, KV namespace, `worker/wrangler.toml` ids and `[vars]`, deploy, then the secrets (`TLR_SECRET`, `TLR_API_KEY`, `MCP_SECRET`), each typed by the owner into `wrangler secret put` or the dashboard.
- Set `PAGE_NAME`, `TIMEZONE`, `TLR_HOST`, `POLL=on`, `CONTEXT=on`. For weather, build `WX_COUNTIES` from the counties (NWS UGC codes like `KYC019=Boyd County, KY`).
- In ThinLine Radio, add the custom alert webhook pointing to the Worker URL, with `TLR_SECRET` as its secret.
- Check: `https://<worker>/status` shows `thinline: ok`, the D1 and KV bindings, and `connector: on`.

### Phase 5: Review page and publishing
- Cloudflare Access on the review hostname, then `ACCESS_TEAM`, `ACCESS_AUD` and `REVIEW_URL` ([SETUP.md](SETUP.md) step 3).
- Facebook: Meta app, Page token, `FB_PAGE_ID` and `FB_PAGE_TOKEN` as secrets (step 4). The owner does the Meta dashboard steps themselves. Explain each screen, but don't ask for the token.
- Optional: the map image Worker (step 5), and Discord or Pushover notices (step 7).
- Check: `/status` shows `facebook: ok (<page name>)`, and `/review` opens behind the Access login.

### Phase 6: The agent
Set up the scheduled agent on the owner's AI platform ([RUNTIMES.md](RUNTIMES.md)):
- Connector URL: `https://<worker>/mcp/<MCP_SECRET>`. The owner enters it in the platform; it contains the secret.
- Repository: the owner's instance repo, read access.
- Prompt: the one in [SETUP.md](SETUP.md) step 6, with their page name.
- Trigger: a webhook (`CLAUDE_FIRE_URL` / `CLAUDE_FIRE_TOKEN`), or a schedule every few minutes if the platform has no webhook.
- Check: fire one run by hand. Its run log should say it read `CORE.md`, the profile rules and `local/`, and end with `runlog_write`. The review page's Run logs tab shows it.

### Phase 7: First day
- Leave `AUTO_POST: off`. Have the owner review a day of drafts.
- Each wrong post is a fix in `local/`: a misheard place name goes in `places.md`, an unknown unit in `units.md`, a road the map lacks in `local/roads/manual/`. Or use the review page's "teach the bot" box. Never edit the profile rules for a local quirk.
- When drafts look right, the owner may set `AUTO_POST: on` and pick which categories are `auto`.

### When you're done
Summarize for the owner: what is set up, which settings are still off, where to change things (`local/`), and how to update (`git fetch upstream; git merge upstream/main`, see [UPDATING.md](UPDATING.md)).
