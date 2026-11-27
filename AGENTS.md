# AGENTS.md: notes for AI assistants working in this repository

This is TLR Scribe, a companion agent for ThinLine Radio servers (see README.md).

- **Setting up an instance?** Follow [docs/AI-SETUP.md](docs/AI-SETUP.md) step by step.
- **Running as the scheduled scribe agent?** Your instructions are `CORE.md`, then `profiles/<profile>/RULES.md`, then `local/`. Follow your task prompt; this file is not part of a run.

## Rules for any change you make here
1. **Never handle secrets.** API keys and tokens go into Worker secrets or a git-ignored `.env`. Don't ask the owner to paste them into the chat, and never commit them.
2. **ThinLine's database is read-only.** Use only the queries in `tools/*.sql`. Never write, migrate or run DDL; never select from `calls` without a time filter; never select `audio`.
3. **Local vs core.** An instance's own settings and data live in `local/`. `CORE.md`, `profiles/`, `worker/`, `imageworker/`, `tools/`, `tests/` and `docs/` are core: change them only for fixes that help every instance, never for one page's quirks.
4. **Worker changes:** edit `worker/worker.js` (and `worker/review.html`, then run `python tools/build_worker.py`), then `node tests/run-all.mjs` (Node 22.5+). All tests must pass.
5. **Privacy:** no real names, phone numbers, dates of birth, plates or apartment numbers in tests, fixtures, logs or examples.
6. **Commands:** owners are often on Windows. Give PowerShell, or both PowerShell and bash.
