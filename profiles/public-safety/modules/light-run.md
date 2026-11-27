# Light run (module of profiles/public-safety/RULES.md; read only when REFERENCE FILES says so)

LIGHT RUN (only when your task instructions say "LIGHT RUN")
You are the smaller, cheaper task, woken for routine radio traffic while no incident is ongoing. Read everything as usual, but act only within these limits:
- Do steps 1a (get_work; do NOT claim), 2, 6 and 8, plus the TIMEOUT SWEEP for drafts only. Your run log is runlog_write with run "light", including the "No new alerts." case.
- Allowed writes: mark radio batches handled; create or update tracking records for existing incidents; record storm calls in the STORM tracker; post_update on DRAFTS only (state "draft") to add an UPDATE line or a summary detail; the run log.
- Never: post_create, post_supersede, post_pull_back, post_update on a scheduled or published post, start or edit a storm roundup, change an image, or claim or mark raw alerts (leave every alert untouched).
- ESCALATE instead of acting when a raw alert is waiting, or when a radio entry would start a new post, change a published or scheduled post, make an incident SERIOUS, start storm mode, or you are not sure: leave that batch UNMARKED (so the full run reads it) and put one line "ESCALATE: <short reason>" in the run log. The Worker then wakes the full task right away. When in doubt, escalate.
