# Updating your instance

Core files (`CORE.md`, `profiles/`, `worker/`, `imageworker/`, `tools/`, `tests/`, `docs/`) come from upstream. Your files are in `local/`, which upstream never touches, so updates merge cleanly.

```powershell
git fetch upstream
git merge upstream/main
git push
```

After merging:
- If `worker/` changed, redeploy: `cd worker; npx wrangler deploy --name <your-worker>`. Check the commit notes for new settings.
- If `profiles/<profile>/templates/` changed, compare with your `local/` files and copy any new sections you want (new settings or categories default to the old behavior until you add them).
- Run `node tests/run-all.mjs` if you changed the Worker yourself.

Don't edit core files for local behavior: put it in `local/LOCALRULES.md`, which overrides the profile's RULES.md. If you fix a core bug, open an issue or pull request upstream so everyone gets it.
