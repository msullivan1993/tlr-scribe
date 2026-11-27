/**
 * TLR Scribe: ThinLine Radio companion agent (Cloudflare Worker)
 * https://github.com/msullivan1993/tlr-scribe  ·  PolyForm Shield 1.0.0
 * Works with ThinLine Radio's public API. The profile (public safety, railroad...) lives in the
 * instance repo's rules; this Worker is the same for every profile.
 *
 * ThinLine alerts + transcripts --> this Worker --> D1 --> Claude tasks (Scribe connector)
 *                                              --> /review page --> Facebook Page (Graph API)
 *
 * Routes
 *   POST /          ThinLine "custom" alert webhook. Header X-Webhook-Secret = TLR_SECRET.
 *                   The alert is saved in D1 and wakes the Claude task.
 *   POST /mcp       Scribe connector for the Claude tasks (Authorization: Bearer MCP_SECRET).
 *   GET  /review    Draft review page (Cloudflare Access). /review/api is its API.
 *   GET  /status    Settings check. GET /privacy: privacy page for the Meta app.
 *   GET  /          Health check, returns "ok".
 *
 * Bindings
 *   DB (or WAKELOCK)    D1 database: alerts, radio batches, incidents, run logs, posts, corrections.
 *                       Tables are created automatically. Required.
 *   SEEN                KV namespace: poller cursors, wake timing, notice de-dupe. Required.
 *
 * Secrets
 *   TLR_SECRET          Entered in ThinLine's webhook "secret" field.
 *   TLR_API_KEY         ThinLine tlr_... key with the Transcripts capability (poller).
 *   MCP_SECRET          Turns on the Scribe connector at /mcp. Add it in claude.ai as a custom connector
 *                       (URL https://<worker>/mcp, request header Authorization = "Bearer <MCP_SECRET>")
 *                       and attach it to both tasks.
 *   CLAUDE_FIRE_URL / CLAUDE_FIRE_TOKEN  API trigger of the main scheduled task.
 *   CLAUDE_FIRE_URL_LIGHT / CLAUDE_FIRE_TOKEN_LIGHT  (optional) API trigger of the light (Haiku) task.
 *                       Routine radio wakes with no ongoing incident go there; alerts, urgent traffic and
 *                       ongoing incidents go to the main task. A light run that needs the main task writes
 *                       "ESCALATE:" in its run log.
 *   FB_PAGE_ID, FB_PAGE_TOKEN  The Facebook Page and its Page access token (never-expiring Page token).
 *   IMAGE_KEY           The image Worker's key (the Worker builds map image URLs itself).
 *   PUSHOVER_TOKEN, PUSHOVER_USER  (optional) push notices for new drafts, urgent changes and posts.
 *   DISCORD_WEBHOOK_URL (optional) Discord channel for drafts, posts and run logs; split them with
 *                       DISCORD_WEBHOOK_DRAFTS, DISCORD_WEBHOOK_POSTS and DISCORD_WEBHOOK_LOG.
 *   REVIEW_TOKEN        (optional) fallback login for testing: open /review?token=<REVIEW_TOKEN> once.
 *
 * Variables (type "Text")
 *   --- Alerts ---
 *   SEVERITIES          Only keep these alert severities, e.g. "critical,warning". Empty = all.
 *   TALKGROUPS          Only keep alerts on these talkgroups (label or ref). Empty = all.
 *   PREFIX, MAX_CHARS, INCLUDE_TRANSCRIPT  How the alert text stored for the task is built.
 *                       Defaults "🚨", 280, true.
 *   TIMEZONE            Time zone of the times in posts and notices. Default "America/New_York".
 *   WAKE_EVERY_MINUTES  Wake Claude at most this often; alerts in between are batched. Default 3.
 *   ALERT_URGENT_FIRE_MINUTES  Alerts with an urgent word (structure fire, entrapment, water rescue,
 *                       shooting... see URGENT_ALERT) wake Claude within this long instead. Default 3.
 *                       ALERT_URGENT=off disables; ALERT_URGENT_WORDS (regex) replaces the word list.
 *   MAX_RUN_MINUTES     A run counts as in progress until its run log arrives, or this long. Default 15.
 *   --- Backup transcript poller (catches alerts the webhook missed) ---
 *   POLL                "on" to enable (runs with the cron trigger "* * * * *").
 *   TLR_HOST            Your ThinLine address, e.g. https://scanner.example.com
 *   POLL_TALKGROUPS     Talkgroup labels to watch, comma-separated. Default: every channel.
 *   POLL_KEYWORDS       Words/phrases that make a transcript an alert. Default: DEFAULT_POLL_KEYWORDS.
 *   POLL_LOOKBACK_MINUTES  How far back each check looks. Default 20.
 *   POLL_MAX_PAGES      Max 200-call pages per check. Default 8.
 *   CORRECTION_WINDOW_MINUTES  Pass on transcripts corrected in TLR up to this long after. Default 45.
 *   JUNK_PHRASES        Extra Whisper hallucinations to drop, comma-separated, each matched as the
 *                       whole transcript. Built-in list in junkReason().
 *   --- Context (other radio traffic during active incidents; needs POLL) ---
 *   CONTEXT             "on" to save radio traffic batches while an incident is active.
 *   CONTEXT_TALKGROUPS  Channels used for context, comma-separated. Default: every channel.
 *   CONTEXT_WINDOW_MINUTES (60), CONTEXT_MIN_WORDS (6), CONTEXT_MAX_LINES (60),
 *   CONTEXT_EVERY_MINUTES (5), CONTEXT_FIRE_EVERY_MINUTES (30)  Batching and wake timing.
 *   CONTEXT_URGENT_FIRE_MINUTES  Traffic with an incident keyword wakes Claude within this long. Default 2.
 *                       CONTEXT_URGENT=off disables.
 *   HOT_MINUTES         After any draft/post change, use the _HOT timings for this long. Default 60.
 *   CONTEXT_EVERY_MINUTES_HOT (2), CONTEXT_FIRE_EVERY_MINUTES_HOT (3)
 *   ACTIVE_FIRE_EVERY_MINUTES  While an incident is ongoing, context wakes at most this far apart. Default 5.
 *   ACTIVE_IDLE_MINUTES An ongoing incident stops speeding things up after this long unchanged. Default 90.
 *   --- Weather (NWS watches/warnings) ---
 *   WEATHER             "off" to stop checking. Default on.
 *   WX_COUNTIES         NWS UGC county codes with names, e.g. "KYC019=Boyd County, KY;KYC089=Greenup County, KY".
 *                       Empty = no weather checks.
 *   WX_EVERY_MINUTES    Default 5. WX_USER_AGENT: contact string NWS asks for.
 *   --- Review page and Facebook ---
 *   REVIEW_URL          Where the review page is reached (links in notices),
 *                       e.g. https://review.example.com
 *   ACCESS_TEAM, ACCESS_AUD  Cloudflare Access team name and the application's audience tag.
 *   REVIEW_EMAILS       Optional comma-separated emails allowed in (on top of Access's own policy).
 *   FB_API_VERSION      Graph API version. Default v25.0.
 *   IMAGE_BASE          Your image Worker's map URL, e.g. https://<name>.<account>.workers.dev/map.png
 *                       (images are off until IMAGE_BASE and IMAGE_KEY are set).
 *   STALE_DRAFT_HOURS   Drafts untouched this long expire. Default 12.
 *   PRAYERS             "off" to stop the 🙏 prayer tracker (counts prayer comments; needs pages_read_user_content).
 *   PRAYER_EVERY_MINUTES (15), PRAYER_DAYS (3)  How often it checks and how far back posts are recounted.
 *   DISCORD_WEBHOOK_PRAYERS  (secret, optional) a channel where ONE "🙏 Prayers Count" message is kept up to date.
 *   D1_KEEP_DAYS        Days to keep alerts and batches. Default 3. CLEANUP_MINUTE: minute of the hour it runs (30).
 *   PROMO               Promo line(s) for the alert text, separated by "||". Default off.
 *   HASHTAGS            Hashtags appended to the stored alert text. Default none.
 *   PRIVACY_NAME, PRIVACY_EMAIL  Name and contact shown on the /privacy page (Meta app requirement).
 *   PAGE_NAME           Your page's name: review page, privacy page and notices. Default "TLR Scribe".
 *   DISCORD_USERNAME    Name the Discord webhooks post as. Default: PAGE_NAME.
 *   --- Notices ---
 *   PUSHOVER_SOUND, PUSHOVER_PRIORITY (0), PUSHOVER_AUTO_PRIORITY (1), PUSHOVER_URGENT_PRIORITY (1)
 *                       New drafts and auto-posts push; routine updates go to Discord only.
 *   NOTIFY_UPDATES      "off" to skip Discord notices for draft and live-post updates.
 *   NOTIFY_URGENT_TYPES / NOTIFY_URGENT_UPDATES  Optional regex overrides for what counts as urgent.
 */


export default {
  // Cron Trigger "* * * * *": poller, wakes, weather, run-log notices, D1 cleanup, due auto-posts.
  async scheduled(event, env, ctx) {
    loadJunkPhrases(env);
    ctx.waitUntil(
      Promise.all([
        pollTranscripts(env, ctx)
          .catch((e) => console.error("poll error", e && e.stack ? e.stack : e))
          .then(() => flushPendingWake(env))
          .catch((e) => console.error("wake error", e)),
        notifyRunlogs(env).catch((e) => console.error("notify error", e && e.stack ? e.stack : e)),
        weatherCheck(env).catch((e) => console.error("weather error", e && e.stack ? e.stack : e)),
        d1Cleanup(env).catch((e) => console.error("d1 cleanup error", e && e.stack ? e.stack : e)),
        postsCron(env).catch((e) => console.error("posts cron error", e && e.stack ? e.stack : e)),
        prayerCheck(env).catch((e) => console.error("prayer check error", e && e.stack ? e.stack : e))
          .then(() => prayerBackfill(env)).catch((e) => console.error("prayer scan error", e && e.stack ? e.stack : e)),
      ]),
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    loadJunkPhrases(env);

    try {
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        return await handleMcp(request, url, env);
      }
      if (url.pathname === "/review" || url.pathname.startsWith("/review/")) {
        return await handleReview(request, url, env, ctx);
      }
      if (request.method === "GET" && (url.pathname === "/privacy" || url.pathname === "/data-deletion")) {
        return privacyPage(env);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return await handleStatus(url, env, ctx);
      }
      if (request.method === "GET") {
        return text("ok");
      }
      if (request.method === "POST") {
        return await handleAlert(request, url, env, ctx);
      }
      return text("method not allowed", 405);
    } catch (err) {
      console.error("relay error", err && err.stack ? err.stack : err);
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// POST /  — ThinLine alert -> saved in D1, Claude woken
// ---------------------------------------------------------------------------
async function handleAlert(request, url, env, ctx) {
  requireEnv(env, ["TLR_SECRET"]);

  if (!(await secretMatches(request.headers.get("X-Webhook-Secret"), env.TLR_SECRET))) {
    return json({ ok: false, error: "bad or missing X-Webhook-Secret" }, 403);
  }

  let alert;
  try {
    alert = await request.json();
  } catch {
    return json({ ok: false, error: "body is not JSON" }, 400);
  }

  const meta = alert.metadata || {};

  // Filters
  const severities = list(env.SEVERITIES);
  if (severities.length && !severities.includes(String(alert.severity || "").toLowerCase())) {
    return json({ ok: true, skipped: `severity "${alert.severity}" not in SEVERITIES` });
  }
  const talkgroups = list(env.TALKGROUPS);
  if (talkgroups.length) {
    const label = String(meta.talkgroupLabel || "").toLowerCase();
    const ref = String(meta.talkgroupRef ?? "").toLowerCase();
    if (!talkgroups.includes(label) && !talkgroups.includes(ref)) {
      return json({ ok: true, skipped: `talkgroup "${meta.talkgroupLabel}" not in TALKGROUPS` });
    }
  }

  const callId = meta.callId;
  if (await alreadySeen(env, callId)) {
    console.log("webhook: call already saved (by the transcript poller), skipping", callId);
    return json({ ok: true, skipped: `call ${callId} already saved` });
  }

  // ThinLine often fires the alert on the tones, before the call is transcribed. Saving it now
  // would give Claude an empty alert and mark the call as done, so the transcript would never
  // arrive. Instead remember it; the poller saves it as an alert once the transcript exists.
  const webhookJunk = junkReason(alert.transcription);
  if (webhookJunk) alert.transcription = `(tones were sent, but the transcript was unreadable: ${webhookJunk})`;
  const hasText = String(alert.transcription || "").trim().length > 0;
  if (!hasText && env.SEEN && callId != null && String(env.POLL || "").toLowerCase() === "on") {
    await markSeen(env, callId, "webhook-notext");
    await env.SEEN.put(`pending:${callId}`, JSON.stringify({ message: alert.message || "", toneSetName: meta.toneSetName || "", alertType: meta.alertType || "", at: Date.now() }), { expirationTtl: 3600 });
    await noteAlert(env);
    console.log("webhook: alert has no transcript yet; waiting for it via the poller", callId, meta.talkgroupLabel);
    return json({ ok: true, deferred: `call ${callId} has no transcript yet; the poller will save it` });
  }

  const saved = await saveAlert(alert, env);
  if (saved.skipped) return json({ ok: true, skipped: saved.skipped });

  if (!saved.ok && env.SEEN && callId != null && String(env.POLL || "").toLowerCase() === "on") {
    // The database refused: hand the call to the poller, which saves it next minute.
    await markSeen(env, callId, "webhook-notext");
    await env.SEEN.put(`pending:${callId}`, JSON.stringify({ message: alert.message || "", toneSetName: meta.toneSetName || "", alertType: meta.alertType || "", at: Date.now() }), { expirationTtl: 3600 });
    await noteAlert(env);
    console.warn("webhook: the alert was not saved; the poller will retry it", callId, saved.status);
  }
  if (saved.ok) {
    await markSeen(env, callId, "webhook");
    await noteAlert(env);
    await rememberSent(env, [{ callId, transcript: alert.transcription, timestamp: alert.timestamp }]).catch(() => {});
  }

  // Wake Claude's scheduled task (batched: at most once every WAKE_EVERY_MINUTES).
  if (saved.ok) {
    const urgent = alertUrgent(env, alert);
    const wake = requestWake(env, `${urgent ? "URGENT " : ""}alert on ${meta.talkgroupLabel || "unknown talkgroup"}`, urgent ? alertUrgentGap(env) : undefined).catch((e) => console.error("claude fire failed", e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(wake);
    else await wake;
  }

  return json({ ok: saved.ok, saved: saved.text }, saved.ok ? 200 : 503);
}

// Builds the alert text and saves it in D1 for the next run.
async function saveAlert(alert, env) {
  let postText = buildText(alert, env);
  if (!postText.trim()) return { skipped: "nothing to save (empty message)" };
  const d1 = await storeItem(env, "alert", { callId: (alert.metadata || {}).callId, body: postText, firstTs: alert.timestamp });
  if (!d1.ok) console.error("alert: could not save to D1", (alert.metadata || {}).callId);
  return d1.ok ? { ok: true, status: 200, text: d1.duplicate ? "already saved" : `saved as ${d1.id}` } : { ok: false, status: 503, text: "D1 save failed" };
}

// ---------------------------------------------------------------------------
// Backup: poll ThinLine transcripts for alerts the webhook missed
// (e.g. ThinLine's per-talkgroup alert cooldown skips the webhook).
// ---------------------------------------------------------------------------
async function alreadySeen(env, callId) {
  if (!env.SEEN || callId == null) return false;
  const v = await env.SEEN.get(`call:${callId}`);
  return v != null && v !== "webhook-notext"; // a tone alert with no transcript yet is still open
}

async function markSeen(env, callId, source) {
  if (!env.SEEN || callId == null) return;
  await env.SEEN.put(`call:${callId}`, source, { expirationTtl: 3 * 86400 });
}

async function pollTranscripts(env, ctx) {
  if (String(env.POLL || "").toLowerCase() !== "on") return { skipped: "POLL is not on" };
  if (!env.SEEN) {
    console.log("poll: no SEEN KV binding, so the poller is off (it would create duplicates)");
    return { skipped: "no SEEN KV binding" };
  }
  requireEnv(env, ["TLR_HOST", "TLR_API_KEY"]);

  const talkgroups = list(env.POLL_TALKGROUPS ?? DEFAULT_POLL_TALKGROUPS);
  const keywords = list(env.POLL_KEYWORDS ?? DEFAULT_POLL_KEYWORDS);
  if (!keywords.length) return { skipped: "no POLL_KEYWORDS" };
  const lookbackMin = Number(env.POLL_LOOKBACK_MINUTES || 20);

  const host = String(env.TLR_HOST).trim().replace(/\/+$/, "");
  let since = Date.now() - lookbackMin * 60000;
  // Context must not lose lines: reach back to the context cursor (at most 60 min) so a
  // backlog older than the lookback is still fetched.
  if (String(env.CONTEXT || "").toLowerCase() === "on") {
    const cursor = Number((await env.SEEN.get("ctx:cursor")) || 0);
    if (cursor) since = Math.max(Date.now() - 60 * 60000, Math.min(since, cursor + 1));
    // On bundle minutes, also look back CORRECTION_WINDOW_MINUTES so transcripts corrected in
    // TLR after they were sent can be passed on as corrections.
    const { every } = await ctxTiming(env);
    const corrWin = Number(env.CORRECTION_WINDOW_MINUTES ?? 45);
    if (corrWin > 0 && Math.floor(Date.now() / 60000) % every === 0) since = Math.min(since, Date.now() - corrWin * 60000);
  }
  // ThinLine returns newest first, at most 200 per request: page back with offset until
  // we reach "since", so busy periods don't silently drop the oldest calls.
  const results = [];
  const maxPages = Number(env.POLL_MAX_PAGES || 8);
  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(`${host}/api/public/v1/transcripts?dateFrom=${since}&limit=200&offset=${page * 200}`, {
      headers: { Authorization: `Bearer ${String(env.TLR_API_KEY).trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error("poll: ThinLine transcripts request failed", res.status, (await res.text()).slice(0, 300));
      if (!results.length) return { error: res.status };
      break;
    }
    const data = safeParse(await res.text());
    const batch = (data && data.results) || [];
    results.push(...batch);
    if (batch.length < 200) break;
    if (page === maxPages - 1) console.warn(`poll: hit POLL_MAX_PAGES (${maxPages}); oldest calls in the window were not fetched`);
  }

  // Oldest first, so items are saved in time order.
  results.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  console.log(`poll: checked ${results.length} transcript(s) from the last ${lookbackMin} min`);
  let saved = 0, urgentSaved = 0, deferred = 0, saveBlocked = false;
  const sentNow = [];
  for (const r of results) {
    const tgLabel = String(r.talkgroupLabel || r.talkgroupName || "");
    if (talkgroups.length && !talkgroups.includes(tgLabel.toLowerCase()) && !talkgroups.includes(String(r.talkgroupRef))) continue;
    const seenAs = r.callId != null ? await env.SEEN.get(`call:${r.callId}`) : null;
    let pending = null;
    if (seenAs === "webhook-notext") {
      if (!String(r.transcript || "").trim()) continue; // still not transcribed: try again next minute
      pending = safeParse((await env.SEEN.get(`pending:${r.callId}`)) || "null") || {};
    }
    const junk = junkReason(r.transcript);
    if (junk && !pending) continue; // a hallucination that happens to contain a keyword: never an alert
    const hit = pending ? "tone alert" : findKeyword(r.transcript, keywords);
    if (!hit) continue;
    if (!pending && seenAs != null) continue;
    if (saveBlocked) { deferred++; continue; } // a save failed this minute: leave the rest for next minute

    await markSeen(env, r.callId, pending ? "poll-after-tone" : "poll"); // claim first so a late webhook won't duplicate it
    if (pending) await kvDelete(env, `pending:${r.callId}`);
    const alert = {
      source: "thinline-radio-poll",
      severity: "info",
      message: (pending && pending.message) || [r.systemLabel, tgLabel].filter(Boolean).join(" / "),
      timestamp: r.timestamp,
      transcription: junk ? `(tones were sent, but the transcript was unreadable: ${junk})` : r.transcript,
      metadata: { callId: r.callId, systemLabel: r.systemLabel, talkgroupLabel: tgLabel, systemRef: r.systemRef, talkgroupRef: r.talkgroupRef, alertType: pending ? (pending.alertType || "tone") : "poll", toneSetName: pending ? pending.toneSetName : undefined, units: r.units },
    };
    const out = await saveAlert(alert, env);
    if (!out.ok && !out.skipped) {
      // NEVER LOSE AN ALERT: undo the claim so the next poll (20-minute lookback) saves it.
      // Keyword lines on poll channels are kept out of context bundles, so a dropped save here
      // would mean the bot never sees the line at all.
      if (pending) {
        await markSeen(env, r.callId, "webhook-notext");
        await env.SEEN.put(`pending:${r.callId}`, JSON.stringify(pending), { expirationTtl: 3600 });
      } else if (r.callId != null) {
        await kvDelete(env, `call:${r.callId}`);
      }
      saveBlocked = true;
      deferred++;
      console.warn(`poll: could not save call ${r.callId} on ${tgLabel} (${out.status}); will retry next minute`);
      continue;
    }
    if (out.ok) sentNow.push(r);
    if (out.ok && alertUrgent(env, alert)) urgentSaved++;
    console.log(`poll: saved missed call ${r.callId} on ${tgLabel} (keyword "${hit}")`, out.status);
    if (out.ok) saved++;
  }
  if (saved) await noteAlert(env);

  if (sentNow.length) await rememberSent(env, sentNow);

  // Context: other radio traffic while an incident is active.
  const ctxSaved = await collectContext(env, results, keywords);

  if (saved) await requestWake(env, `${saved} alert(s) caught by the transcript poller${urgentSaved ? " (URGENT)" : ""}`, urgentSaved ? alertUrgentGap(env) : undefined);
  else if (ctxSaved) {
    const t = await ctxTiming(env);
    const gap = t.fireGap;
    // Routine radio traffic with no ongoing incident can go to the LIGHT task (if configured).
    const light = !lastBundleUrgent && !t.active;
    await requestWake(env, lastBundleUrgent ? "urgent context radio traffic (incident keyword)" : "new context radio traffic",
      lastBundleUrgent ? Math.min(gap, Number(env.CONTEXT_URGENT_FIRE_MINUTES ?? 2)) : gap, light);
  }

  if (saved) console.log(`poll: ${saved} missed alert(s) saved`);
  if (deferred) console.log(`poll: ${deferred} alert(s) left for the next minute (a save failed)`);
  return { saved, deferred, context: ctxSaved };
}

let lastBundleUrgent = false;
// URGENT ALERTS: alerts with one of these words wake Claude within ALERT_URGENT_FIRE_MINUTES (default 3)
// instead of waiting for WAKE_EVERY_MINUTES, so a structure fire or entrapment is never held back by a
// slow routine schedule. ALERT_URGENT=off disables; ALERT_URGENT_WORDS (regex) replaces the list.
const URGENT_ALERT = /\b(STRUCTURE FIRE|HOUSE FIRE|RESIDENTIAL FIRE|COMMERCIAL FIRE|BUILDING FIRE|MOBILE HOME FIRE|TRAILER FIRE|APARTMENT FIRE|WORKING FIRE|FULLY INVOLVED|FIRE SHOWING|FLAMES SHOWING|SMOKE SHOWING|HEAVY SMOKE|MULTIPLE CALLERS|ENTRAP(PED|MENT)|PINNED|EJECTED|WATER RESCUE|SWIFT WATER|IN THE WATER|SHOTS? FIRED|SHOOTING|BEEN SHOT|STABB(ED|ING)|EXPLOSION|PLANE (DOWN|CRASH)|AIRCRAFT (DOWN|CRASH)|OFFICER DOWN|PURSUIT)\b/i;
function alertUrgent(env, alert) {
  if (String(env.ALERT_URGENT || "on").toLowerCase() === "off") return false;
  let re = URGENT_ALERT;
  if (env.ALERT_URGENT_WORDS) { try { re = new RegExp(env.ALERT_URGENT_WORDS, "i"); } catch {} }
  const meta = (alert && alert.metadata) || {};
  return re.test([alert && alert.transcription, alert && alert.message, meta.toneSetName].filter(Boolean).join(" "));
}
function alertUrgentGap(env) {
  return Math.min(Number(env.ALERT_URGENT_FIRE_MINUTES ?? 3), Number(env.WAKE_EVERY_MINUTES ?? 3));
}

const URGENT_CONTEXT = /\b(SHOTS? FIRED|SHOOTING|SHOT AT|BEEN SHOT|STABB(ED|ING)|WORKING FIRE|FULLY INVOLVED|FIRE SHOWING|FLAMES SHOWING|ENTRAP(PED|MENT)|PINNED|EJECTED|ROLLOVER|ROLLED OVER|HEAD ON|PURSUIT|IN THE WATER|OFFICER DOWN)\b/i;

// Atomic wake lock. With the WAKELOCK D1 binding, one conditional UPDATE decides which invocation
// may wake Claude, so concurrent invocations in different locations can't both fire. Without it,
// falls back to the KV timestamp (fast, but racy).
let wakeTableReady = false;
async function wakeDb(env) {
  if (!env.WAKELOCK) return null;
  if (!wakeTableReady) {
    await env.WAKELOCK.batch([
      env.WAKELOCK.prepare("CREATE TABLE IF NOT EXISTS wake (id INTEGER PRIMARY KEY, last INTEGER NOT NULL)"),
      env.WAKELOCK.prepare("INSERT OR IGNORE INTO wake (id, last) VALUES (1, 0)"),
    ]);
    wakeTableReady = true;
  }
  return env.WAKELOCK;
}
async function tryAcquireWake(env, gapMs) {
  const now = Date.now();
  try {
    const db = await wakeDb(env);
    if (db) {
      const r = await db.prepare("UPDATE wake SET last = ?1 WHERE id = 1 AND last <= ?2 RETURNING last").bind(now, now - gapMs).all();
      const got = (r.results || []).length > 0;
      if (got && env.SEEN) await env.SEEN.put("wake:last", String(now)); // for /status only
      return got;
    }
  } catch (e) { console.log("wakelock: D1 error, using KV", String(e)); }
  const last = Number((await env.SEEN.get("wake:last")) || 0);
  if (now - last < gapMs) return false;
  await env.SEEN.put("wake:last", String(now));
  return true;
}
async function releaseWake(env) {
  // After a failed wake, let the next minute retry.
  try { const db = await wakeDb(env); if (db) await db.prepare("UPDATE wake SET last = 0 WHERE id = 1").run(); } catch (e) { console.log("wakelock: release failed", String(e)); }
  if (env.SEEN) await env.SEEN.put("wake:last", "0");
}

// Batches wake-ups: Claude is woken at most once every WAKE_EVERY_MINUTES (default 3).
// A wake that comes too soon is remembered and sent by the once-a-minute cron.
// SINGLE FLIGHT: a run is "in progress" from the wake until its run log arrives (every run
// writes one) or MAX_RUN_MINUTES (default 15) pass. Only the run log of the task that was woken counts
// ("📋 RUNLOG LIGHT" for the light task). New wakes wait instead of starting a second,
// overlapping run, which can draft the same incident twice.
async function runInProgress(env) {
  if (!env.SEEN) return false;
  const started = Number((await env.SEEN.get("run:started")) || 0);
  if (!started) return false;
  const done = Number((await env.SEEN.get("run:done")) || 0);
  if (done >= started) return false;
  return Date.now() - started < Number(env.MAX_RUN_MINUTES || 15) * 60000;
}

async function requestWake(env, reason, minGapMinutes, light = false) {
  if (!env.CLAUDE_FIRE_URL || !env.CLAUDE_FIRE_TOKEN) return;
  if (!env.SEEN) {
    await fireClaude(env, { talkgroupLabel: reason }, { timestamp: Date.now() });
    return;
  }
  const gap = Number(minGapMinutes ?? env.WAKE_EVERY_MINUTES ?? 3) * 60000;
  if (!(await runInProgress(env)) && (await tryAcquireWake(env, gap))) {
    await kvDelete(env, "wake:pending");
    if (await wakeWithRetry(env, reason, light)) { await kvDelete(env, "wake:tries"); console.log("wake: Claude woken -", reason, light ? "(light)" : ""); }
  } else {
    // Remember the wake with ITS OWN minimum gap, so a context wake can't ride the faster alert schedule.
    const prev = safeParse((await env.SEEN.get("wake:pending")) || "null");
    const gapMin = gap / 60000;
    const keep = prev && typeof prev === "object" && prev.gapMin <= gapMin ? { ...prev } : { reason, gapMin };
    keep.light = !!(light && (!prev || typeof prev !== "object" || prev.light)); // any full wake waiting makes it a full run
    await env.SEEN.put("wake:pending", JSON.stringify(keep));
    console.log("wake: batched -", reason);
  }
}

async function flushPendingWake(env) {
  if (!env.SEEN || !env.CLAUDE_FIRE_URL || !env.CLAUDE_FIRE_TOKEN) return;
  const raw = await env.SEEN.get("wake:pending");
  if (!raw) return;
  const pending = safeParse(raw);
  const gapMin = pending && typeof pending === "object" ? Number(pending.gapMin) : Number(env.WAKE_EVERY_MINUTES ?? 3);
  const reason = pending && typeof pending === "object" ? pending.reason : String(raw);
  const light = !!(pending && typeof pending === "object" && pending.light);
  if (await runInProgress(env)) return;
  if (!(await tryAcquireWake(env, gapMin * 60000))) return;
  await kvDelete(env, "wake:pending");
  if (await wakeWithRetry(env, String(reason).startsWith("retry") ? reason.replace(/^retry \d+: /, "") : `batched: ${reason}`, light)) {
    await kvDelete(env, "wake:tries");
    console.log("wake: Claude woken for batched wake -", reason);
  }
}

// ---------------------------------------------------------------------------
// Draft notifications: push a Pushover message when an incident draft (a draft
// attached to a social account) is created or its text changes. Runs every cron
// minute. Remembers a short hash per draft in KV, so each change notifies once.
// The first run only records existing drafts, without notifying.
// ---------------------------------------------------------------------------
// Transcripts already sent to Claude in the last CORRECTION_WINDOW_MINUTES, as one KV value
// { callId: [hash, timestamp] }, so a transcript corrected later in TLR can be detected.
async function loadSent(env) {
  return safeParse((await env.SEEN.get("ctx:sent")) || "{}") || {};
}
async function saveSent(env, map) {
  const keepMs = Math.max(15, Number(env.CORRECTION_WINDOW_MINUTES ?? 45)) * 60000 + 10 * 60000;
  const cutoff = Date.now() - keepMs;
  for (const k of Object.keys(map)) if (!Array.isArray(map[k]) || map[k][1] < cutoff) delete map[k];
  await env.SEEN.put("ctx:sent", JSON.stringify(map));
}
async function rememberSent(env, calls) {
  if (!env.SEEN || Number(env.CORRECTION_WINDOW_MINUTES ?? 45) <= 0) return;
  const map = await loadSent(env);
  for (const r of calls) if (r.callId != null) map[r.callId] = [textHash(String(r.transcript || r.text || "").trim()), Number(r.timestamp || Date.now())];
  await saveSent(env, map);
}

function textHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Posts the FULL post text to a Discord channel webhook, so every draft, auto-post and live
// update is logged in one place.
// Confirmed or serious incidents. The incident type line and new update lines are checked.
// SERIOUS incidents are announced from the run log ("SERIOUS NEW:"), since posts keep their footer.
// Run logs (from runlog_write) go to Discord's log channel; an ESCALATE line wakes the full task
// at once; a "SERIOUS NEW: <post first line>" line sends a high-priority Pushover once.
async function notifyRunlogs(env) {
  if (!env.SEEN || !dbOf(env)) return;
  const db = await store(env);
  const rows = (await db.prepare("SELECT id, created_at, run, text FROM runlogs WHERE created_at > ?1 ORDER BY id").bind(Date.now() - 6 * 3600000).all()).results || [];
  const logHook = env.DISCORD_WEBHOOK_LOG || env.DISCORD_WEBHOOK_URL;
  for (const r of rows) {
    const key = `runlog:d1-${r.id}`;
    if (await env.SEEN.get(key)) continue;
    const body = String(r.text).split("\n").slice(1).join("\n").trim();
    const esc = body.match(/ESCALATE:\s*([^\n]{0,160})/);
    if (esc && r.created_at > Date.now() - 30 * 60000) {
      await env.SEEN.put("wake:pending", JSON.stringify({ reason: `escalated by light run: ${esc[1]}`, gapMin: 0, light: false }));
      console.log("wake: light run escalated -", esc[1]);
    }
    if (/^no new alerts\.?$/i.test(body)) { await env.SEEN.put(key, "1", { expirationTtl: 7 * 86400 }); continue; }
    for (const m of String(r.text).matchAll(/SERIOUS NEW:\s*([^\n]+)/g)) {
      const what = m[1].trim().slice(0, 200);
      const sk = `serious:${textHash(what.toLowerCase())}`;
      if (await env.SEEN.get(sk)) continue;
      await env.SEEN.put(sk, "1", { expirationTtl: 7 * 86400 });
      if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) await sendPushover(env, "‼️ SERIOUS incident", what, Number(env.PUSHOVER_URGENT_PRIORITY ?? 1));
      const postHook = env.DISCORD_WEBHOOK_POSTS || logHook;
      if (postHook) await sendDiscord(env, "‼️ SERIOUS incident", what, 0x8e44ad, postHook);
    }
    if (logHook) {
      const firstLine = String(r.text).split("\n")[0].replace(/^📋\s*RUNLOG\s*/u, "").trim();
      const ok = await sendDiscord(env, `Run log${firstLine ? ` · ${firstLine}` : ""}`, body || "(empty)", 0x7f8c8d, logHook);
      if (!ok) continue; // retry next minute
    }
    await env.SEEN.put(key, "1", { expirationTtl: 7 * 86400 });
  }
}

const URGENT_TYPE = /(^|\s)(Structure Fire|Entrapment|Ejection|Water Rescue|Vehicle in (the )?Water|Pedestrian Struck|Shots Fired|Shooting|Stabbing|Armed Robbery|Robbery|Pursuit|Aircraft|Airport Alert|Explosion)\b/i;
const URGENT_UPDATE = /\b(working (structure )?fire|fire showing|flames showing|fully involved|entrap|ejected|ejection|air medical|aeromedical|helicopter|air evac|healthnet|medflight|med flight|life flight|in pursuit|pursuing|pursuit|fighting with|fight with (an )?officer|at gunpoint|shots fired|has been shot|officer down)/i;
function isUrgent(env, header, updates, text) {
  const typeLine = String(header).split("·")[0];
  const typeRe = env.NOTIFY_URGENT_TYPES ? new RegExp(env.NOTIFY_URGENT_TYPES, "i") : URGENT_TYPE;
  const updRe = env.NOTIFY_URGENT_UPDATES ? new RegExp(env.NOTIFY_URGENT_UPDATES, "i") : URGENT_UPDATE;
  if (!/Possible/i.test(typeLine) && typeRe.test(typeLine)) return true;
  return updates.some((u) => updRe.test(u));
}

// ---------------------------------------------------------------------------
// Weather mode: checks NWS active alerts for the covered counties. When the set of active
// watches/warnings changes, saves a weather note (get_work returns the newest) and sends
// a normal-priority notice. Level 1 = a watch, level 2 = a warning. Posts are never made from it.
const DEFAULT_WX_COUNTIES = ""; // set WX_COUNTIES to turn weather checks on
const WX_EVENTS = /^(Tornado|Severe Thunderstorm|Flash Flood|Flood|Winter Storm|Ice Storm|Blizzard|High Wind|Extreme Wind|Snow Squall|Storm Surge|Hurricane|Tropical Storm) (Watch|Warning)$/;

async function weatherCheck(env) {
  if (!env.SEEN || String(env.WEATHER || "on").toLowerCase() === "off") return;
  const every = Number(env.WX_EVERY_MINUTES || 5) * 60000;
  const lastAt = Number((await env.SEEN.get("wx:at")) || 0);
  if (Date.now() - lastAt < every) return;
  await env.SEEN.put("wx:at", String(Date.now()));

  const counties = new Map();
  for (const part of String(env.WX_COUNTIES || DEFAULT_WX_COUNTIES).split(";")) {
    const [code, name] = part.split("=").map((x) => (x || "").trim());
    if (code) counties.set(code.toUpperCase(), name || code);
  }
  if (!counties.size) return;
  const res = await fetch(`https://api.weather.gov/alerts/active?zone=${[...counties.keys()].join(",")}`, {
    headers: { "User-Agent": String(env.WX_USER_AGENT || `TLR Scribe (${env.REVIEW_URL || "github.com/msullivan1993/tlr-scribe"})`), Accept: "application/geo+json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) { console.warn("weather: NWS request failed", res.status); return; }
  const data = safeParse(await res.text());
  const per = new Map(); // county name -> [{event, level, ends}]
  for (const f of (data && data.features) || []) {
    const p = f.properties || {};
    const m = WX_EVENTS.exec(String(p.event || ""));
    if (!m || p.status === "Test" || p.messageType === "Cancel") continue;
    const level = m[2] === "Warning" ? 2 : 1;
    const ends = p.ends || p.expires || "";
    for (const ugc of (p.geocode && p.geocode.UGC) || []) {
      const name = counties.get(String(ugc).toUpperCase());
      if (!name) continue;
      if (!per.has(name)) per.set(name, []);
      const list = per.get(name);
      if (!list.some((x) => x.event === p.event)) list.push({ event: p.event, level, ends });
    }
  }
  const lines = [...per.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => {
    const level = Math.max(...list.map((x) => x.level));
    const ev = list.sort((a, b) => b.level - a.level).map((x) => `${x.event}${x.ends ? ` (until ${formatLocalTime(x.ends)})` : ""}`).join(", ");
    return `${name}: level ${level}, ${ev}`;
  });
  // Signature ignores end times so extensions don't spam; only the set of county/event pairs.
  const sig = [...per.entries()].map(([n, l]) => n + ":" + l.map((x) => x.event).sort().join("+")).sort().join("|");
  const prevSig = (await env.SEEN.get("wx:sig")) || "";
  await env.SEEN.put("wx:latest", lines.length ? lines.join("\n") : "none");
  if (sig === prevSig) return;

  const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const body = lines.length
    ? `Active NWS watches and warnings in covered counties (level 1 = watch, level 2 = warning):\n${lines.join("\n")}\nAll other covered counties: none.`
    : "No NWS watches or warnings are active in any covered county (weather level 0 everywhere).";
  try { await noteSet(env, "weather", `${now}: ${body}`); } catch (e) { console.warn("weather: D1 save failed; will retry", e && e.message); await env.SEEN.put("wx:at", "0"); return; }
  await env.SEEN.put("wx:sig", sig);
  console.log("weather: changed -", sig || "none");
  const summary = lines.length ? lines.join("\n") : "All watches and warnings have ended.";
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) await sendPushover(env, "🌩️ Weather level change", summary.slice(0, 900), 0);
  const hook = env.DISCORD_WEBHOOK_LOG || env.DISCORD_WEBHOOK_URL;
  if (hook) await sendDiscord(env, "🌩️ Weather level change", summary, 0x3498db, hook);
}

async function sendDiscord(env, title, text, color, hookUrl, link) {
  const payload = {
    username: env.DISCORD_USERNAME || env.PAGE_NAME || "TLR Scribe",
    embeds: [{
      title: title.slice(0, 256),
      description: String(text || "").slice(0, 4000),
      color: color || 0x95a5a6,
      ...((link || env.REVIEW_URL) ? { url: link || String(env.REVIEW_URL).replace(/\/+$/, "") + "/review" } : {}),
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    const res = await fetch(String(hookUrl || env.DISCORD_WEBHOOK_URL).trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.warn("discord failed", res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.warn("discord error", String(e));
    return false;
  }
}

function formatLocalTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

async function sendPushover(env, title, message, priority) {
  const form = new URLSearchParams({
    token: String(env.PUSHOVER_TOKEN).trim(),
    user: String(env.PUSHOVER_USER).trim(),
    title,
    message,
    ...(env.REVIEW_URL ? { url: String(env.REVIEW_URL).replace(/\/+$/, "") + "/review", url_title: "Open the review page" } : {}),
  });
  if (env.PUSHOVER_SOUND) form.set("sound", String(env.PUSHOVER_SOUND).trim());
  const prio = priority != null ? priority : env.PUSHOVER_PRIORITY;
  if (prio) form.set("priority", String(prio).trim());
  try {
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.warn("pushover failed", res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.warn("pushover error", String(e));
    return false;
  }
}

// Deletes a KV key only if it exists. A delete counts toward KV's daily limit even
// when the key is missing; a read is far cheaper on that limit.
async function kvDelete(env, key) {
  if (env.SEEN && (await env.SEEN.get(key)) != null) await env.SEEN.delete(key);
}

// "Hot" mode: while an incident post was created or changed recently (seen by the notifier),
// bundle context and wake Claude faster so live updates keep up with the radio.
async function ctxTiming(env) {
  const hotMin = Number(env.HOT_MINUTES ?? 60);
  const hotAt = env.SEEN && hotMin > 0 ? Number((await env.SEEN.get("ctx:hot")) || 0) : 0;
  const hot = hotAt && Date.now() - hotAt < hotMin * 60000;
  // "active": an incident post labelled "active" was seen in the last few minutes.
  const actAt = env.SEEN ? Number((await env.SEEN.get("ctx:active")) || 0) : 0;
  const active = actAt && Date.now() - actAt < 5 * 60000;
  let every = Math.max(1, Number(hot ? env.CONTEXT_EVERY_MINUTES_HOT ?? 2 : env.CONTEXT_EVERY_MINUTES || 5));
  let fireGap = Number(hot ? env.CONTEXT_FIRE_EVERY_MINUTES_HOT ?? 3 : env.CONTEXT_FIRE_EVERY_MINUTES || 30);
  if (active) {
    const cap = Number(env.ACTIVE_FIRE_EVERY_MINUTES ?? 5);
    fireGap = Math.min(fireGap, cap);
    every = Math.min(every, cap);
  }
  return { hot: !!hot, active: !!active, every, fireGap };
}

const INCIDENT_START = /^(🔥|🚗|🚓|🌊|⚠️)/u;
// Update lines: "UPDATE 4:53 AM: ..." (current format) or "🔄 4:53 AM: ..." (older posts).
const UPDATE_LINE = /^(🔄\s*(?=\d)|UPDATE\s+(?=\d))/u;
function isUpdateLine(x) { return UPDATE_LINE.test(String(x || "")); }
const CLOSED_WORDS = /\b(cleared|clear(ed)? the scene|command (is |has been )?terminated|terminated command|back in (service|quarters)|returning to (the )?station|returning to quarters|units? (are |were )?returning|disregard|cancell?ed|nothing (was )?found|placed? back in service)\b/i;
function isOngoingText(text) {
  const lines = String(text || "").split("\n").map((x) => x.trim()).filter(Boolean);
  if (!lines.length || !INCIDENT_START.test(lines[0])) return false; // not an incident post (or superseded/pending)
  const summary = lines.find((x, i) => i >= 2 && !isUpdateLine(x) && !x.startsWith("📍")) || "";
  if (/\b(responded|was dispatched|were dispatched)\b/i.test(summary)) return false;
  const upd = lines.filter(isUpdateLine);
  if (upd.length && CLOSED_WORDS.test(upd[upd.length - 1])) return false;
  return true;
}

async function noteAlert(env) {
  if (env.SEEN) await env.SEEN.put("ctx:lastAlertAt", String(Date.now()));
}

// Saves non-alert radio traffic from CONTEXT_TALKGROUPS as ONE context batch per
// minute, but only while an incident is active (an alert within CONTEXT_WINDOW_MINUTES).
// Claude attaches lines that belong to an active incident and ignores the rest.
async function collectContext(env, results, keywords) {
  if (String(env.CONTEXT || "").toLowerCase() !== "on" || !env.SEEN) return 0;
  const windowMs = Number(env.CONTEXT_WINDOW_MINUTES || 60) * 60000;
  const lastAlertAt = Number((await env.SEEN.get("ctx:lastAlertAt")) || 0);
  if (!lastAlertAt || Date.now() - lastAlertAt > windowMs) return 0;
  // Bundle context every CONTEXT_EVERY_MINUTES (default 5) instead of every minute:
  // fewer KV writes and fewer context batches for Claude to read. The poller's 20-minute
  // lookback means nothing is missed in between.
  const { every } = await ctxTiming(env);
  const ctxTalkgroups = list(env.CONTEXT_TALKGROUPS ?? DEFAULT_CONTEXT_TALKGROUPS);
  const pollTgs = list(env.POLL_TALKGROUPS ?? DEFAULT_POLL_TALKGROUPS);
  const minWords = Number(env.CONTEXT_MIN_WORDS || 6);
  // Calls already bundled are remembered by call id, so a call transcribed late (after newer
  // calls were bundled) still gets in.
  const bundled = await bundledCallIds(env, results.map((r) => r.callId));
  const floor = lastAlertAt - 10 * 60000; // nothing older than ~10 min before the alert
  const isNewCall = (r) => Number(r.timestamp || 0) > floor && !(r.callId != null && bundled.has(String(r.callId)));
  // URGENT CONTEXT: a new line with an incident keyword (crash, fire, shooting...) on a channel the
  // poller doesn't turn into alerts (law, tac, fireground) is bundled right away instead of waiting
  // for the next CONTEXT_EVERY_MINUTES tick, and wakes Claude within CONTEXT_URGENT_FIRE_MINUTES.
  lastBundleUrgent = false;
  const urgentNow = String(env.CONTEXT_URGENT || "on").toLowerCase() !== "off" && results.some((r) => {
    if (!isNewCall(r)) return false;
    const tg = String(r.talkgroupLabel || r.talkgroupName || "").toLowerCase();
    if (ctxTalkgroups.length && !ctxTalkgroups.includes(tg)) return false;
    return !!(findKeyword(String(r.transcript || "").toLowerCase(), keywords) || URGENT_CONTEXT.test(String(r.transcript || "")));
  });
  if (!urgentNow && Math.floor(Date.now() / 60000) % every !== 0) return 0;
  if (urgentNow) lastBundleUrgent = true;

  const picked = [];
  let junkDropped = 0;
  for (const r of results) {
    if (!isNewCall(r)) continue;
    const tgLabel = String(r.talkgroupLabel || r.talkgroupName || "");
    if (ctxTalkgroups.length && !ctxTalkgroups.includes(tgLabel.toLowerCase())) continue;
    const text = String(r.transcript || "").trim();
    if (text.split(/\s+/).length < minWords) continue;
    if (junkReason(text)) { junkDropped++; continue; } // Whisper hallucinations and acknowledgment-only lines
    const lower = text.toLowerCase();
    // Keyword hits on channels the poller watches become alerts there; on any other
    // channel (e.g. KFD3 FTAC) nothing else picks them up, so keep them as context.
    if (findKeyword(lower, keywords) && pollTgs.includes(tgLabel.toLowerCase())) continue;
    if (await alreadySeen(env, r.callId)) continue; // already sent by the webhook
    picked.push({ ...r, tgLabel, text });
  }
  // Corrections: a transcript sent earlier whose text has since changed in TLR (a person
  // corrected it and submitted it for training).
  const corrWin = Number(env.CORRECTION_WINDOW_MINUTES ?? 45);
  const sentMap = corrWin > 0 ? await loadSent(env) : {};
  const corrections = [];
  if (corrWin > 0) {
    for (const r of results) {
      const prev = r.callId != null ? sentMap[r.callId] : null;
      const now = String(r.transcript || "").trim();
      if (prev && now && prev[0] !== textHash(now)) corrections.push({ ...r, tgLabel: String(r.talkgroupLabel || r.talkgroupName || ""), text: now });
    }
  }
  if (!picked.length && !corrections.length) return 0;

  // Oldest first; anything over the limit waits for the next bundle instead of being dropped.
  const maxLines = Number(env.CONTEXT_MAX_LINES || 60);
  const batch = picked.slice(0, maxLines);
  const fmtLine = (r) => {
    const t = r.text.length > 500 ? r.text.slice(0, 499) + "…" : r.text;
    const u = unitsText(r.units);
    const refs = refsText(r.systemRef, r.talkgroupRef);
    return `🎙️ ${[r.systemLabel, r.tgLabel].filter(Boolean).join(" / ")}${refs ? " " + refs : ""} · 🕒 ${formatWhen(r.timestamp, env)}${u ? ` · 🆔 ${u}` : ""}\n📻 "${t}"`;
  };
  const lines = batch.map(fmtLine);
  if (corrections.length) {
    lines.push("📝 CORRECTED TRANSCRIPTS (checked and fixed by a person in ThinLine; they replace the earlier machine versions of the same calls)");
    lines.push(...corrections.map((r) => "📝 " + fmtLine(r)));
  }
  const text = `📎 CONTEXT (radio traffic, not an alert)\n\n${lines.join("\n\n")}`;

  const d1 = await storeItem(env, "context", { body: text, firstTs: batch.length ? Number(batch[0].timestamp || 0) : null, urgent: lastBundleUrgent });
  if (!d1.ok) {
    console.warn("context: the radio batch was not saved (will retry next minute)");
    return 0;
  }
  await rememberBundled(env, [...batch, ...corrections]);
  if (batch.length) {
    const newest = Math.max(...batch.map((r) => Number(r.timestamp || 0)));
    await env.SEEN.put("ctx:cursor", String(newest));
  }
  if (corrWin > 0) {
    for (const r of [...batch, ...corrections]) if (r.callId != null) sentMap[r.callId] = [textHash(r.text), Number(r.timestamp || Date.now())];
    await saveSent(env, sentMap);
  }
  console.log(`context: saved ${lines.length} line(s) of radio traffic${junkDropped ? ` (${junkDropped} junk line(s) dropped)` : ""}`);
  return lines.length;
}

function formatWhen(ts, env) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: env.TIMEZONE || "America/New_York",
      hour: "numeric", minute: "2-digit", month: "short", day: "numeric",
    }).format(new Date(Number(ts)));
  } catch {
    return "";
  }
}

// Channels polled for alerts and for context. Empty = every channel the TLR key can see. Set POLL_TALKGROUPS / CONTEXT_TALKGROUPS to a comma-separated list of labels to narrow it.
const DEFAULT_CONTEXT_TALKGROUPS = "";
const DEFAULT_POLL_TALKGROUPS = "";

// Whole-word keyword match, so short codes like "atl" don't match inside other words.
function findKeyword(text, keywords) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  return keywords.find((k) => {
    const kk = String(k).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return kk && t.includes(" " + kk + " ");
  });
}


// Words that make a transcript worth posting. Override with POLL_KEYWORDS (comma-separated).
// From the ThinLine keyword lists "Traffic and Fire Incidents" and "Critical",
// minus private medical/mental-health calls. Override with POLL_KEYWORDS (comma-separated).
const DEFAULT_POLL_KEYWORDS =
  "traffic accident,traffic accidents,traffic collision,vehicle collision,crash unknown injuries,crash with reported injuries,crash with entrapment,crash with fatality,hit and run,pedestrian struck,motor vehicle accident,mva,rollover,vehicle rollover,head-on collision,motorcycle accident,bicycle struck,vehicle into structure,vehicle into building,vehicle in water,multi-vehicle,semi rollover,jaws of life,entrapment,ejection,freeway closed,lanes blocked,structure fire,residential structure fire,commercial structure fire,apartment fire,house fire,vehicle fire,brush/grass fire,brush fire,grass fire,wildfire,wildland fire,appliance fire,chimney fire,dumpster fire,electrical fire,transformer fire,explosion,smoke investigation,working fire,fully involved,flames showing,smoke showing,heavy smoke,second alarm,third alarm,defensive operations,offensive attack,fire attack,primary search,knockdown,fire under control,mayday,mutual aid fire,pursuit,subject pursuit,vehicle pursuit,foot pursuit,in pursuit,fleeing vehicle,fleeing suspect,evading,refused to stop,failed to stop,spike strips,stop sticks,pit maneuver,terminate pursuit,pursuit terminated,wrong way driver,reckless driver,stolen vehicle,attempt to locate,atl,active shooter,active shooter incident,officer down,assist officer,shots fired,shooting,stabbing,homicide,homicide or possible homicide,hostage situation,barricaded subject,bomb threat,abduction or kidnapping,amber alert,home invasion,person with gun,person with knife,swat,mass casualties incident,drowning,water rescue,building collapse,aircraft crash,train derailment,hazmat,electrocution,shots being heard,officer needs assistance,officer injured,suspicious package,prisoner escape,civil disturbance/riot,missing juvenile,endangered missing adult,firefighter down,emergency traffic,trapped,gas leak,confined space rescue,trench rescue,high angle rescue";

// ---------------------------------------------------------------------------
// GET /status?secret=...  — health check for every piece
// ---------------------------------------------------------------------------
async function handleStatus(url, env, ctx) {
  if (!(await secretMatches(url.searchParams.get("secret"), env.TLR_SECRET))) {
    return json({ ok: false, error: "add ?secret=<your TLR_SECRET> to the URL" }, 403);
  }
  const out = { checkedAt: new Date().toISOString() };

  const flag = (v) => String(v || "").toLowerCase() === "on";

  out.settings = {
    POLL: flag(env.POLL) ? "on" : "OFF",
    CONTEXT: flag(env.CONTEXT) ? "on" : "OFF",
    SEEN_kv_binding: env.SEEN ? "connected" : "MISSING (Settings -> Bindings -> KV namespace, name SEEN)",
    TLR_HOST: env.TLR_HOST ? String(env.TLR_HOST) : "MISSING",
    TLR_API_KEY: env.TLR_API_KEY ? "set" : "MISSING",
    CLAUDE_FIRE: env.CLAUDE_FIRE_URL && env.CLAUDE_FIRE_TOKEN ? "set" : "MISSING",
    REVIEW_URL: env.REVIEW_URL || "not set (notice links go nowhere)",
    REVIEW_ACCESS: env.ACCESS_TEAM && env.ACCESS_AUD ? "Cloudflare Access" : env.REVIEW_TOKEN ? "token only" : "NOT PROTECTED: set ACCESS_TEAM and ACCESS_AUD",
    IMAGE_KEY: env.IMAGE_KEY ? "set" : "MISSING (no map images)",
    PUSHOVER: env.PUSHOVER_TOKEN && env.PUSHOVER_USER ? "set" : "OFF",
    DISCORD: env.DISCORD_WEBHOOK_URL ? "set" : "OFF",
    DISCORD_DRAFTS: env.DISCORD_WEBHOOK_DRAFTS ? "set" : "default",
    DISCORD_POSTS: env.DISCORD_WEBHOOK_POSTS ? "set" : "default",
    DISCORD_LOG: env.DISCORD_WEBHOOK_LOG ? "set" : "default",
    ACTIVE_INCIDENT: env.SEEN ? (Date.now() - Number((await env.SEEN.get("ctx:active")) || 0) < 300000 ? "yes (wakes every " + (env.ACTIVE_FIRE_EVERY_MINUTES ?? 5) + " min or faster)" : "no") : "n/a",
  };

  // Facebook
  if (fbReady(env)) {
    try { const me = await fbCall(env, String(env.FB_PAGE_ID), { fields: "name" }, "GET"); out.facebook = `ok (${me.name || env.FB_PAGE_ID})`; }
    catch (e) { out.facebook = `ERROR: ${String(e.message || e).slice(0, 150)}`; }
  } else out.facebook = "not connected (set FB_PAGE_ID and FB_PAGE_TOKEN)";

  // ThinLine transcripts
  if (env.TLR_HOST && env.TLR_API_KEY) {
    try {
      const host = String(env.TLR_HOST).trim().replace(/\/+$/, "");
      const since = Date.now() - 60 * 60000;
      const tr = await fetch(`${host}/api/public/v1/transcripts?dateFrom=${since}&limit=200`, {
        headers: { Authorization: `Bearer ${String(env.TLR_API_KEY).trim()}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!tr.ok) {
        out.thinline = `ERROR ${tr.status}: ${(await tr.text()).slice(0, 150)}`;
      } else {
        const data = safeParse(await tr.text());
        const results = (data && data.results) || [];
        const tgs = list(env.POLL_TALKGROUPS ?? DEFAULT_POLL_TALKGROUPS);
        const kws = list(env.POLL_KEYWORDS ?? DEFAULT_POLL_KEYWORDS);
        const watched = results.filter((r) => !tgs.length || tgs.includes(String(r.talkgroupLabel || r.talkgroupName || "").toLowerCase()));
        const matches = watched.filter((r) => findKeyword(r.transcript, kws));
        out.thinline = "ok";
        out.lastHour = {
          transcripts: results.length,
          onWatchedChannels: watched.length,
          matchingAlertKeywords: matches.length,
          channelsSeen: [...new Set(results.map((r) => r.talkgroupLabel || r.talkgroupName))].slice(0, 40),
          newestTranscriptAt: results[0] ? new Date(Number(results[0].timestamp)).toISOString() : null,
        };
        if (env.SEEN) {
          const notSaved = [];
          for (const r of matches.slice(0, 20)) if (!(await alreadySeen(env, r.callId))) notSaved.push(r.callId);
          out.lastHour.matchesNotYetSaved = notSaved;
        }
      }
    } catch (e) {
      out.thinline = `ERROR: ${e && e.name === "TimeoutError" ? "timed out" : e}`;
    }
  } else {
    out.thinline = "not configured (TLR_HOST / TLR_API_KEY)";
  }

  // KV memory
  if (env.SEEN) {
    const keys = await env.SEEN.list({ prefix: "call:", limit: 1000 });
    const t = async (k) => {
      const v = await env.SEEN.get(k);
      return v ? new Date(Number(v)).toISOString() : null;
    };
    out.memory = {
      callsRemembered: keys.keys.length,
      lastAlertSavedAt: await t("ctx:lastAlertAt"),
      contextCursor: await t("ctx:cursor"),
      lastClaudeWake: await t("wake:last"),
      weather: (await env.SEEN.get("wx:latest")) || "not checked yet",
      wakeLock: env.WAKELOCK ? "D1 (atomic)" : "KV only (can double-wake; add the WAKELOCK D1 binding)",
      store: { d1: dbOf(env) ? await d1Counts(env) : "MISSING: bind a D1 database as DB or WAKELOCK", connector: env.MCP_SECRET ? "on (/mcp, header Authorization: Bearer <MCP_SECRET>)" : "off (set MCP_SECRET)" },
    };
  }
  return json(out);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// SYSTEM AND TALKGROUP REFS: the IDs ThinLine gives each system and talkgroup ("[21019/1234]").
// Names can be renamed in TLR; refs don't, so the rules match channels.csv by ref first.
function refsText(sysRef, tgRef) {
  const ok = (x) => x != null && String(x).trim() !== "" && String(x) !== "0";
  if (!ok(sysRef) && !ok(tgRef)) return "";
  return `[${ok(sysRef) ? String(sysRef).trim() : "?"}/${ok(tgRef) ? String(tgRef).trim() : "?"}]`;
}

// ---------------------------------------------------------------------------
// Radio unit IDs (P25 radio ID / MDC / FleetSync) from ThinLine, when it provides them.
// Accepts [{unitRef,label}] or plain numbers. Returns e.g. "894 (BRAVO 71), 1605" or "".
function unitsText(units) {
  if (!Array.isArray(units) || !units.length) return "";
  const out = [];
  for (const u of units) {
    const ref = u && typeof u === "object" ? u.unitRef : u;
    if (ref == null || ref === 0 || ref === "0") continue;
    const label = u && typeof u === "object" ? String(u.label || "").trim() : "";
    const t = label ? `${ref} (${label})` : String(ref);
    if (!out.includes(t)) out.push(t);
  }
  return out.join(", ");
}

function buildText(alert, env) {
  const meta = alert.metadata || {};

  const prefix = env.PREFIX ?? "🚨";
  const headline = alert.message || [meta.systemLabel, meta.talkgroupLabel].filter(Boolean).join(" / ");
  const refs = refsText(meta.systemRef, meta.talkgroupRef);
  const head = [prefix, headline].filter(Boolean).join(" ") + (refs ? " " + refs : "");

  let when = "";
  if (alert.timestamp) {
    try {
      when = new Intl.DateTimeFormat("en-US", {
        timeZone: env.TIMEZONE || "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
        day: "numeric",
      }).format(new Date(Number(alert.timestamp)));
    } catch {
      when = ""; /* bad timezone or timestamp: skip the time line */
    }
  }

  const hashtags = (env.HASHTAGS || "").trim();
  const max = parseInt(env.MAX_CHARS || "280", 10) || 280;
  if (when) when = `🕒 ${when}`;
  const uText = unitsText(meta.units);
  const unitsLine = uText ? `🆔 Units: ${uText}` : "";
  const fixed = [head, when, unitsLine, hashtags].filter(Boolean).join("\n");

  // The transcript gets whatever room is left, so the headline/time/hashtags always survive.
  let transcript = "";
  const includeTranscript = String(env.INCLUDE_TRANSCRIPT ?? "true").toLowerCase() !== "false";
  const raw = includeTranscript && alert.transcription ? String(alert.transcription).trim() : "";
  if (raw) {
    const room = max - fixed.length - 3; // newline + two quote marks
    if (room >= 20) {
      transcript = raw.length > room ? raw.slice(0, room - 1).trimEnd() + "…" : raw;
      transcript = `📻 "${transcript}"`;
    }
  }

  let out = [head, transcript, when, unitsLine, hashtags].filter(Boolean).join("\n");
  if (out.length > max) out = out.slice(0, max - 1) + "…";

  // Promo line is always added at the end and does not count toward MAX_CHARS.
  // One line is picked at random from the list, so posts rotate through them.
  // PROMO can hold your own lines separated by "||", or "off" to disable.
  const promoSetting = (env.PROMO ?? "").trim();
  if (promoSetting.toLowerCase() !== "off") {
    const options = promoSetting ? promoSetting.split("||").map((x) => x.trim()).filter(Boolean) : [];
    if (options.length) out += `\n\n${options[Math.floor(Math.random() * options.length)]}`;
  }
  return out;
}

async function fireClaude(env, meta, alert, light = false) {
  // LIGHT runs (a second scheduled task on a smaller model) handle routine radio-traffic wakes only.
  const useLight = light && env.CLAUDE_FIRE_URL_LIGHT && env.CLAUDE_FIRE_TOKEN_LIGHT;
  const res = await fetch((useLight ? env.CLAUDE_FIRE_URL_LIGHT : env.CLAUDE_FIRE_URL).trim(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(useLight ? env.CLAUDE_FIRE_TOKEN_LIGHT : env.CLAUDE_FIRE_TOKEN).trim()}`,
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: `New draft created from a ThinLine alert (${meta.talkgroupLabel || "unknown talkgroup"}, ${new Date(Number(alert.timestamp) || Date.now()).toISOString()}).`,
    }),
  });
  console.log(useLight ? "claude fire (light)" : "claude fire", res.status, await res.text());
  return res.ok;
}

// Wakes Claude; if Claude is busy or down, queues a retry for the next cron minute (up to 10 tries).
async function wakeWithRetry(env, reason, light = false) {
  let ok = false;
  try { ok = await fireClaude(env, { talkgroupLabel: reason }, { timestamp: Date.now() }, light); }
  catch (e) { console.log("claude fire error", String(e)); }
  if (ok && env.SEEN) {
    // Remember WHICH task was woken: only that task's run log ends the run (a light run's log, or a
    // manual run of the other task, must not let a second run start while this one is still going).
    const usedLight = !!(light && env.CLAUDE_FIRE_URL_LIGHT && env.CLAUDE_FIRE_TOKEN_LIGHT);
    await env.SEEN.put("run:kind", usedLight ? "light" : "main", { expirationTtl: 86400 });
    await env.SEEN.put("run:started", String(Date.now()), { expirationTtl: 86400 });
  }
  if (ok || !env.SEEN) return ok;
  const tries = Number((await env.SEEN.get("wake:tries")) || 0) + 1;
  if (tries > 10) {
    console.log("wake: gave up after 10 tries -", reason);
    await kvDelete(env, "wake:tries");
    return false;
  }
  await env.SEEN.put("wake:tries", String(tries));
  await releaseWake(env);
  await env.SEEN.put("wake:pending", JSON.stringify({ reason: `retry ${tries}: ${reason}`, gapMin: 1, light }));
  console.log(`wake: failed, will retry next minute (try ${tries}) -`, reason);
  return false;
}

async function secretMatches(given, expected) {
  if (!given || !expected) return false;
  given = String(given).trim();
  expected = String(expected).trim(); // ignore stray spaces/newlines from copy-paste
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  // Compare fixed-length digests in constant time
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing Worker variable(s): ${missing.join(", ")}`);
}

function list(value, lower = true) {
  return String(value || "")
    .split(",")
    .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
    .filter(Boolean);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(s, status = 200) {
  return new Response(s, { status, headers: { "Content-Type": "text/plain" } });
}

// ---------------------------------------------------------------------------
// D1 STORE: alerts, radio batches, incidents (tracking), run logs and notes live in the Worker's
// own D1 database.
// Uses the DB binding, or the WAKELOCK binding if there is no DB binding. Tables are created
// automatically on first use.
// ---------------------------------------------------------------------------
let d1SchemaReady = null;
function dbOf(env) { return env.DB || env.WAKELOCK || null; }
async function store(env) {
  const db = dbOf(env);
  if (!db) return null;
  if (!d1SchemaReady) {
    d1SchemaReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, call_id TEXT,
        created_at INTEGER NOT NULL, first_ts INTEGER, urgent INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new', claimed_by TEXT, claimed_at INTEGER, outcome TEXT, done_at INTEGER)`),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS items_call ON items(kind, call_id) WHERE call_id IS NOT NULL"),
      db.prepare("CREATE INDEX IF NOT EXISTS items_status ON items(status, created_at)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL, post_ref TEXT,
        track TEXT NOT NULL DEFAULT '', ended_at INTEGER)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS runlogs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        run TEXT NOT NULL, text TEXT NOT NULL)`),
      db.prepare("CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS ctx_calls (call_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)"),
    ]).catch((e) => { d1SchemaReady = null; throw e; });
  }
  await d1SchemaReady;
  return db;
}

async function storeItem(env, kind, { callId = null, body, firstTs = null, urgent = false }) {
  try {
    const db = await store(env);
    if (!db) return { ok: false };
    const row = await db.prepare(`INSERT OR IGNORE INTO items (kind, call_id, created_at, first_ts, urgent, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`)
      .bind(kind, callId == null ? null : String(callId), Date.now(), firstTs == null ? null : Number(firstTs), urgent ? 1 : 0, String(body)).first();
    return { ok: true, id: row ? row.id : null, duplicate: !row };
  } catch (e) {
    console.error("d1: could not save", kind, e && e.message ? e.message : e);
    return { ok: false };
  }
}

async function noteGet(env, key) {
  const db = await store(env);
  const row = db ? await db.prepare("SELECT text, updated_at FROM notes WHERE key = ?1").bind(key).first() : null;
  return row || null;
}
async function noteSet(env, key, text) {
  const db = await store(env);
  if (!db) return false;
  await db.prepare("INSERT INTO notes (key, text, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at")
    .bind(key, String(text), Date.now()).run();
  return true;
}

// Call ids already put in a radio batch (so a late transcription still gets in, once).
async function bundledCallIds(env, ids) {
  const db = await store(env);
  const out = new Set();
  const list = [...new Set(ids.filter((x) => x != null).map(String))];
  for (let i = 0; db && i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const rows = await db.prepare(`SELECT call_id FROM ctx_calls WHERE call_id IN (${part.map((_, j) => "?" + (j + 1)).join(",")})`).bind(...part).all();
    for (const r of rows.results || []) out.add(String(r.call_id));
  }
  return out;
}
async function rememberBundled(env, calls) {
  const db = await store(env);
  const rows = calls.filter((r) => r.callId != null);
  if (!db || !rows.length) return;
  await db.batch(rows.map((r) => db.prepare("INSERT OR IGNORE INTO ctx_calls (call_id, ts) VALUES (?1, ?2)").bind(String(r.callId), Number(r.timestamp || Date.now()))));
}

async function d1Cleanup(env) {
  if (!dbOf(env) || !env.SEEN) return;
  const hourKey = new Date().toISOString().slice(0, 13);
  if (new Date().getUTCMinutes() < Number(env.CLEANUP_MINUTE ?? 30)) return;
  if ((await env.SEEN.get("d1clean:last")) === hourKey) return;
  await env.SEEN.put("d1clean:last", hourKey, { expirationTtl: 7200 });
  const db = await store(env);
  const now = Date.now(), days = (n) => now - n * 86400000;
  const keep = Number(env.D1_KEEP_DAYS || 3);
  await db.batch([
    db.prepare("DELETE FROM items WHERE created_at < ?1").bind(days(keep)),
    db.prepare("DELETE FROM incidents WHERE status = 'ended' AND updated_at < ?1").bind(days(7)),
    db.prepare("DELETE FROM incidents WHERE status = 'open' AND updated_at < ?1").bind(days(2)),
    db.prepare("DELETE FROM runlogs WHERE created_at < ?1").bind(days(7)),
    db.prepare("DELETE FROM ctx_calls WHERE ts < ?1").bind(days(1)),
  ]);
  console.log("d1: hourly cleanup done");
}

async function d1Counts(env) {
  try {
    const db = await store(env);
    if (!db) return null;
    const r = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM items WHERE status = 'new' AND kind = 'alert') AS new_alerts,
      (SELECT COUNT(*) FROM items WHERE status = 'new' AND kind = 'context') AS new_batches,
      (SELECT COUNT(*) FROM items WHERE status = 'claimed') AS claimed,
      (SELECT COUNT(*) FROM items) AS items,
      (SELECT COUNT(*) FROM incidents WHERE status = 'open') AS open_incidents,
      (SELECT MAX(created_at) FROM runlogs) AS last_runlog`).first();
    return r;
  } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
}

// ---------------------------------------------------------------------------
// SCRIBE CONNECTOR: a small MCP server (Streamable HTTP, JSON responses, no auth beyond the secret
// in the path) that the Claude tasks use.
// Add it in claude.ai as a custom connector: https://<worker>/mcp/<MCP_SECRET>
// ---------------------------------------------------------------------------
const MCP_TOOLS = [
  {
    name: "get_work",
    description: "Everything a run needs to start: new alerts and new radio-traffic batches (oldest first), items another run has claimed, open incidents with their tracking notes, the latest weather levels, the storm tracker and the last run log. Read-only.",
    inputSchema: { type: "object", properties: { max_items: { type: "integer", description: "Most alerts plus batches to return (default 40)." } } },
  },
  {
    name: "claim",
    description: "Claim alerts or batches for this run so no other run handles them. Returns the ids you got and the ids another run already holds. A claim older than 15 minutes counts as abandoned and can be taken.",
    inputSchema: { type: "object", required: ["ids", "run"], properties: { ids: { type: "array", items: { type: "integer" } }, run: { type: "string", enum: ["main", "light"] } } },
  },
  {
    name: "mark",
    description: "Mark alerts or batches as handled, each with a one-line outcome (e.g. \"skipped, medical call\" or \"new private draft: Structure Fire, Ashland\"). Handled items never come back in get_work.",
    inputSchema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["id", "outcome"], properties: { id: { type: "integer" }, outcome: { type: "string" } } } } } },
  },
  {
    name: "release",
    description: "Give back claimed items without handling them (they become new again).",
    inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "integer" } } } },
  },
  {
    name: "recent_items",
    description: "Alerts and batches handled in the last N minutes with their outcomes, for late matches (default 60, at most 240). Read-only.",
    inputSchema: { type: "object", properties: { minutes: { type: "integer" }, kind: { type: "string", enum: ["alert", "context"] } } },
  },
  {
    name: "incident_save",
    description: "Create or update an incident's tracking record (stations, units, channels). Give id to update; leave it out to create. title is the post's first line; track is the full tracking text (stations, units, channels, last traffic). Returns the id.",
    inputSchema: { type: "object", required: ["title", "track"], properties: { id: { type: "integer" }, title: { type: "string" }, post_ref: { type: "string" }, track: { type: "string" } } },
  },
  {
    name: "incident_end",
    description: "Mark an incident as ended (it stops showing as open).",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "integer" }, note: { type: "string" } } },
  },
  {
    name: "runlog_write",
    description: "Write this run's log (step 8). run is \"main\" or \"light\". The text is the log body; the Worker adds the heading and time. Writing it tells the Worker the run has finished.",
    inputSchema: { type: "object", required: ["run", "text"], properties: { run: { type: "string", enum: ["main", "light"] }, text: { type: "string" } } },
  },
  {
    name: "storm_save",
    description: "Replace the storm tracker text (WEATHER MODE). Send an empty text to clear it.",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
];

async function handleMcp(request, url, env) {
  if (!env.MCP_SECRET) return text("MCP_SECRET is not set", 404);
  // The secret comes in a request header (preferred: "Authorization: Bearer <MCP_SECRET>") or,
  // as a fallback, in the path (/mcp/<MCP_SECRET>).
  const auth = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const inPath = url.pathname.startsWith("/mcp/") ? decodeURIComponent(url.pathname.slice("/mcp/".length)) : "";
  if (!(await secretMatches(auth || inPath, env.MCP_SECRET))) return text("not found", 404);
  if (request.method === "GET") return text("method not allowed", 405); // no server-sent stream
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return text("method not allowed", 405);
  const msg = safeParse(await request.text());
  if (msg == null) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  const many = Array.isArray(msg);
  const out = [];
  for (const m of many ? msg : [msg]) {
    const r = await mcpOne(m, env);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(many ? out : out[0]);
}

async function mcpOne(m, env) {
  if (!m || typeof m !== "object" || m.id === undefined || m.id === null || String(m.method || "").startsWith("notifications/")) return null; // notifications get no reply
  const reply = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  try {
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "tlr-scribe", title: "TLR Scribe", version: "1.0.0" },
          instructions: "Store for the TLR Scribe tasks: new alerts and radio batches, claims, tracking records, posts, run logs. Follow CORE.md and the profile RULES.md in the attached repository.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: postToolsOn(env) ? [...MCP_TOOLS, ...POST_TOOLS] : MCP_TOOLS });
      case "tools/call": {
        const name = m.params && m.params.name;
        const args = (m.params && m.params.arguments) || {};
        const isPostTool = postToolsOn(env) && POST_TOOLS.some((t) => t.name === name);
        if (!isPostTool && !MCP_TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
        try {
          const result = isPostTool ? await postTool(name, args, env) : await mcpTool(name, args, env);
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: `error: ${e && e.message ? e.message : e}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${m.method}`);
    }
  } catch (e) {
    return fail(-32603, String(e && e.message ? e.message : e));
  }
}

function localTime(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}
const ids90 = (ids) => [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
const ph = (n, from = 1) => Array.from({ length: n }, (_, i) => "?" + (i + from)).join(",");

async function mcpTool(name, a, env) {
  const db = await store(env);
  if (!db) throw new Error("no D1 database bound (DB or WAKELOCK)");
  const now = Date.now();
  const STALE = 15 * 60000;
  if (name === "get_work") {
    const max = Math.min(Math.max(Number(a.max_items) || 40, 1), 100);
    const fresh = await db.prepare(`SELECT id, kind, created_at, urgent, body FROM items WHERE status = 'new' OR (status = 'claimed' AND claimed_at < ?1)
      ORDER BY id LIMIT ?2`).bind(now - STALE, max).all();
    const held = await db.prepare("SELECT id, kind, claimed_by, claimed_at FROM items WHERE status = 'claimed' AND claimed_at >= ?1 ORDER BY id").bind(now - STALE).all();
    const inc = await db.prepare("SELECT id, title, post_ref, track, created_at, updated_at FROM incidents WHERE status = 'open' ORDER BY id").all();
    const wx = await noteGet(env, "weather");
    const storm = await noteGet(env, "storm");
    const last = await db.prepare("SELECT run, created_at, text FROM runlogs ORDER BY id DESC LIMIT 1").first();
    let corrections = [];
    if (reviewOn(env)) {
      const cdb = await postsDb(env);
      const cr = await cdb.prepare("SELECT id, heard, means, scope, note FROM corrections WHERE active = 1 ORDER BY id").all();
      corrections = cr.results || [];
    }
    const rows = fresh.results || [];
    return {
      now: localTime(now),
      new_alerts: rows.filter((r) => r.kind === "alert").map((r) => ({ id: r.id, saved: localTime(r.created_at), text: r.body })),
      new_context: rows.filter((r) => r.kind === "context").map((r) => ({ id: r.id, saved: localTime(r.created_at), urgent: !!r.urgent, text: r.body })),
      more_waiting: rows.length >= max,
      claimed_by_another_run: (held.results || []).map((r) => ({ id: r.id, kind: r.kind, run: r.claimed_by, since: localTime(r.claimed_at) })),
      open_incidents: (inc.results || []).map((r) => ({ id: r.id, title: r.title, post_ref: r.post_ref, track: r.track, started: localTime(r.created_at), updated: localTime(r.updated_at) })),
      weather: wx ? { text: wx.text, updated: localTime(wx.updated_at) } : null,
      storm_tracker: storm && storm.text ? { text: storm.text, updated: localTime(storm.updated_at) } : null,
      last_runlog: last ? { run: last.run, at: localTime(last.created_at), text: last.text.slice(0, 1500) } : null,
      corrections,
    };
  }
  if (name === "claim") {
    const list = ids90(a.ids);
    const run = a.run === "light" ? "light" : "main";
    if (!list.length) return { claimed: [], held_by_another_run: [] };
    const got = await db.prepare(`UPDATE items SET status = 'claimed', claimed_by = ?1, claimed_at = ?2
      WHERE id IN (${ph(list.length, 4)}) AND (status = 'new' OR (status = 'claimed' AND claimed_at < ?3)) RETURNING id`)
      .bind(run, now, now - STALE, ...list).all();
    const claimed = (got.results || []).map((r) => r.id);
    return { claimed, held_by_another_run: list.filter((id) => !claimed.includes(id)) };
  }
  if (name === "mark") {
    const items = (a.items || []).filter((x) => x && Number.isInteger(Number(x.id))).slice(0, 90);
    if (!items.length) return { marked: 0 };
    await db.batch(items.map((x) => db.prepare("UPDATE items SET status = 'done', outcome = ?1, done_at = ?2 WHERE id = ?3")
      .bind(String(x.outcome || "").slice(0, 500), now, Number(x.id))));
    return { marked: items.length };
  }
  if (name === "release") {
    const list = ids90(a.ids);
    if (list.length) await db.prepare(`UPDATE items SET status = 'new', claimed_by = NULL, claimed_at = NULL WHERE status = 'claimed' AND id IN (${ph(list.length)})`).bind(...list).run();
    return { released: list.length };
  }
  if (name === "recent_items") {
    const min = Math.min(Math.max(Number(a.minutes) || 60, 1), 240);
    const kind = a.kind === "alert" || a.kind === "context" ? a.kind : null;
    const rows = await db.prepare(`SELECT id, kind, created_at, done_at, outcome, body FROM items WHERE status = 'done' AND done_at >= ?1 ${kind ? "AND kind = ?2" : ""} ORDER BY id DESC LIMIT 60`)
      .bind(...(kind ? [now - min * 60000, kind] : [now - min * 60000])).all();
    return { items: (rows.results || []).map((r) => ({ id: r.id, kind: r.kind, saved: localTime(r.created_at), outcome: r.outcome, text: r.kind === "alert" ? r.body : r.body.slice(0, 3000) })) };
  }
  if (name === "incident_save") {
    const title = String(a.title || "").trim().slice(0, 300);
    const track = String(a.track || "").slice(0, 4000);
    const ref = a.post_ref == null ? null : String(a.post_ref).slice(0, 100);
    if (!title) throw new Error("title is required");
    if (a.id != null) {
      const r = await db.prepare("UPDATE incidents SET title = ?1, track = ?2, post_ref = COALESCE(?3, post_ref), updated_at = ?4 WHERE id = ?5 RETURNING id")
        .bind(title, track, ref, now, Number(a.id)).first();
      if (!r) throw new Error(`no incident ${a.id}`);
      return { id: r.id, updated: true };
    }
    const r = await db.prepare("INSERT INTO incidents (created_at, updated_at, title, post_ref, track) VALUES (?1, ?1, ?2, ?3, ?4) RETURNING id").bind(now, title, ref, track).first();
    return { id: r.id, created: true };
  }
  if (name === "incident_end") {
    const r = await db.prepare("UPDATE incidents SET status = 'ended', ended_at = ?1, updated_at = ?1, track = CASE WHEN ?2 = '' THEN track ELSE track || char(10) || 'Ended: ' || ?2 END WHERE id = ?3 RETURNING id")
      .bind(now, String(a.note || "").slice(0, 300), Number(a.id)).first();
    if (!r) throw new Error(`no incident ${a.id}`);
    return { id: r.id, ended: true };
  }
  if (name === "runlog_write") {
    const run = a.run === "light" ? "light" : "main";
    let body = String(a.text || "").trim().slice(0, 12000) || "No new alerts.";
    body = body.replace(/^📋\s*RUNLOG[^\n]*\n+/u, "");
    const textOut = `📋 RUNLOG${run === "light" ? " LIGHT" : ""} ${localTime(now)}\n\n${body}`;
    const r = await db.prepare("INSERT INTO runlogs (created_at, run, text) VALUES (?1, ?2, ?3) RETURNING id").bind(now, run, textOut).first();
    // SINGLE FLIGHT: the woken task's own run log ends its run.
    if (env.SEEN) {
      const runKind = (await env.SEEN.get("run:kind")) || run;
      if (runKind === run) await env.SEEN.put("run:done", String(now), { expirationTtl: 86400 });
    }
    return { id: r.id, saved: true };
  }
  if (name === "storm_save") {
    await noteSet(env, "storm", String(a.text || "").slice(0, 8000));
    return { saved: true };
  }
  throw new Error(`unknown tool ${name}`);
}


// ---------------------------------------------------------------------------
// JUNK FILTER (Tier 0): Whisper hallucinations, repeated-word loops and acknowledgment-only lines.
// Returns a short reason, or "" for a usable transcript. Radio batches drop junk lines; a keyword
// hit that is junk is never an alert; a tone alert keeps the page but loses the junk text.
// Extra phrases: JUNK_PHRASES (comma-separated, matched as the whole transcript).
// ---------------------------------------------------------------------------
const JUNK_EXACT = new Set(["YOU", "THANK YOU", "THANK YOU SO MUCH", "THANKS", "THE", "AIR FORCE ONE", "THANKS FOR WATCHING",
  "THANK YOU FOR WATCHING", "THE END", "AIRPLANE SOUND", "BANG", "BEEP", "BEEPING", "BEEP BEEP", "PHONE RINGING", "WICHITA ARIZONA",
  "T MOBILE", "MUSIC", "APPLAUSE", "SILENCE", "BLANK AUDIO", "NO AUDIO", "INAUDIBLE", "BYE", "OK", "OKAY", "HMM", "UH", "UM", "SO", "PEACE"]);
const JUNK_ANYWHERE = /\b(SUBTITLES BY|AMARA ORG|THANKS FOR WATCHING|PLEASE SUBSCRIBE|LIKE AND SUBSCRIBE|TRANSCRIBED BY|CAPTIONS BY)\b/;
// Status words (on scene, en route, clear, available) are NOT here: "Med 1 on scene" and "units clear" matter.
const ACK_WORDS = new Set(["COPY", "COPIED", "GO", "AHEAD", "THANK", "THANKS", "YOU", "OKAY", "OK", "YES", "YEAH", "YEP", "SIR", "MAAM",
  "NEGATIVE", "AFFIRMATIVE", "WERE", "WE", "ARE", "THATS", "THAT", "RECEIVED", "10", "4", "104",
  "CONTROL", "DISPATCH", "BASE", "COUNTY", "UNIT", "UNITS", "MED", "MEDIC", "STATION", "SQUAD", "ENGINE", "RESCUE", "TRUCK", "TANKER",
  "ADAM", "BOY", "CHARLES", "DAVID", "EDWARD", "FRANK", "GEORGE", "HENRY", "IDA", "JOHN", "KING", "LINCOLN", "MARY", "NORA", "OCEAN", "PAUL",
  "QUEEN", "ROBERT", "SAM", "TOM", "UNION", "VICTOR", "WILLIAM", "XRAY", "YOUNG", "ZEBRA", "ALPHA", "BRAVO", "DELTA", "ECHO", "FOXTROT",
  "GOLF", "HOTEL", "INDIA", "JULIET", "KILO", "LIMA", "MIKE", "NOVEMBER", "OSCAR", "PAPA", "QUEBEC", "ROMEO", "SIERRA", "TANGO", "UNIFORM",
  "WHISKEY", "YANKEE", "ZULU", "TIMES", "AND", "THE", "A", "I", "IM", "ILL", "BE", "TO", "AT", "OF", "IS", "IT"]);
let junkExtra = null;
function junkReason(text, env) {
  const raw = String(text || "").toUpperCase();
  const norm = raw.replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!norm) return "empty";
  if (/^TONES? DETECTED\b.*NO VOICE/.test(norm)) return "tone placeholder";
  if (JUNK_EXACT.has(norm)) return "known hallucination";
  if (junkExtra && junkExtra.has(norm)) return "known hallucination";
  if (JUNK_ANYWHERE.test(norm)) return "known hallucination";
  const words = norm.split(" ");
  // Repetition loops: "QUICK QUICK QUICK ...", "GO AHEAD GO AHEAD GO AHEAD ...".
  if (words.length >= 8) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const top = Math.max(...counts.values());
    if (top / words.length >= 0.5) return "repeated words";
    if (words.length >= 20 && counts.size / words.length < 0.2) return "repeated words";
    let run = 1;
    for (let i = 1; i < words.length; i++) { run = words[i] === words[i - 1] ? run + 1 : 1; if (run >= 6) return "repeated words"; }
  }
  if (/(.)\1{9,}/.test(norm.replace(/ /g, ""))) return "repeated characters";
  // Nothing but acknowledgments, callsign words, phonetics and numbers.
  if (words.length <= 12 && words.every((w) => ACK_WORDS.has(w) || /^\d+$/.test(w))) return "acknowledgment only";
  return "";
}
function loadJunkPhrases(env) {
  if (junkExtra || !env) return;
  junkExtra = new Set(String(env.JUNK_PHRASES || "").split(",").map((x) => x.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// POSTS IN D1 + FACEBOOK (stage 2/3, switched on with REVIEW=on): the bot creates and updates
// drafts through the Scribe connector, the owner reviews them on /review, and the Worker publishes
// straight to the Facebook Page (FB_PAGE_ID, FB_PAGE_TOKEN). Every change is versioned:
// an update based on an old version is refused, so an owner edit is never overwritten.
// ---------------------------------------------------------------------------
let postsSchemaReady = null;
// The review page and the post tools are always on when a D1 database is bound.
function reviewOn(env) { return !!dbOf(env); }
function postToolsOn(env) { return !!dbOf(env); }
async function postsDb(env) {
  const db = await store(env);
  if (!db) return null;
  if (!postsSchemaReady) {
    postsSchemaReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER,
        state TEXT NOT NULL, text TEXT NOT NULL, image TEXT, auto_post_at INTEGER, fb_id TEXT, fb_url TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER, version INTEGER NOT NULL DEFAULT 1,
        last_by TEXT NOT NULL DEFAULT 'bot', owner_edited INTEGER NOT NULL DEFAULT 0, error TEXT, note TEXT, published_by TEXT)`),
      db.prepare("CREATE INDEX IF NOT EXISTS posts_state ON posts(state, updated_at)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS post_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL,
        version INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL, note TEXT)`),
      db.prepare("CREATE INDEX IF NOT EXISTS post_versions_post ON post_versions(post_id, version)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        heard TEXT NOT NULL, means TEXT NOT NULL, scope TEXT, note TEXT, active INTEGER NOT NULL DEFAULT 1)`),
    ]).catch((e) => { postsSchemaReady = null; throw e; });
  }
  await postsSchemaReady;
  return db;
}

function postOut(r) {
  if (!r) return null;
  return {
    id: r.id, state: r.state, version: r.version, text: r.text, image: safeParse(r.image || "null"),
    incident_id: r.incident_id, auto_post_at: r.auto_post_at ? localTime(r.auto_post_at) : null,
    created: localTime(r.created_at), updated: localTime(r.updated_at), last_by: r.last_by,
    owner_edited: !!r.owner_edited, published: r.published_at ? localTime(r.published_at) : null,
    published_by: r.published_by || null, // owner = the page owner pressed Publish; worker = auto-post
    fb_url: r.fb_url || null, error: r.error || null,
  };
}
function cleanImage(img) {
  if (!img || typeof img !== "object") return null;
  const out = {};
  for (const k of ["e", "l1", "l2", "l3", "mode", "q", "lat", "lon", "z"]) {
    if (img[k] != null && String(img[k]).trim() !== "") out[k] = String(img[k]).slice(0, 200);
  }
  return out.l1 || out.q || out.lat ? out : null;
}
function imageUrl(env, img) {
  if (!img || !env.IMAGE_KEY) return null;
  if (!env.IMAGE_BASE) return null;
  const base = String(env.IMAGE_BASE);
  const u = new URL(base);
  u.searchParams.set("key", env.IMAGE_KEY);
  for (const [k, v] of Object.entries(img)) u.searchParams.set(k, v);
  return u.toString();
}

async function savePostVersion(db, id, version, by, text, note) {
  await db.prepare("INSERT INTO post_versions (post_id, version, at, by, text, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, version, Date.now(), by, text, note || null).run();
}

// The one place posts change. by = bot | owner | worker. expectVersion guards against overwriting.
async function changePost(env, id, by, expectVersion, fields, note) {
  const db = await postsDb(env);
  const cur = await db.prepare("SELECT * FROM posts WHERE id = ?1").bind(Number(id)).first();
  if (!cur) throw new Error(`no post ${id}`);
  if (expectVersion != null && Number(expectVersion) !== cur.version) {
    const who = cur.last_by === "owner" ? "the owner edited it" : `it was changed by ${cur.last_by}`;
    throw new Error(`post ${id} changed since you read it (${who}; now version ${cur.version}). Read it again with post_list and apply your change to the current text; never undo the owner's edits.`);
  }
  const next = { ...cur, ...fields };
  const version = cur.version + 1;
  const ownerEdited = by === "owner" && fields.text != null && fields.text !== cur.text ? 1 : cur.owner_edited;
  await db.prepare(`UPDATE posts SET state = ?1, text = ?2, image = ?3, auto_post_at = ?4, fb_id = ?5, fb_url = ?6, published_at = ?7,
      error = ?8, note = ?9, version = ?10, last_by = ?11, owner_edited = ?12, updated_at = ?13, incident_id = ?14, published_by = ?15 WHERE id = ?16`)
    .bind(next.state, next.text, next.image, next.auto_post_at, next.fb_id, next.fb_url, next.published_at,
      next.error ?? null, next.note ?? null, version, by, ownerEdited, Date.now(), next.incident_id ?? null, next.published_by ?? null, cur.id).run();
  if (fields.text != null && fields.text !== cur.text) await savePostVersion(db, cur.id, version, by, next.text, note);
  else if (fields.state && fields.state !== cur.state) await savePostVersion(db, cur.id, version, by, next.text, note || `state: ${cur.state} -> ${fields.state}`);
  return await db.prepare("SELECT * FROM posts WHERE id = ?1").bind(cur.id).first();
}

// --- Facebook Graph API ---------------------------------------------------
function fbReady(env) { return !!(env.FB_PAGE_ID && env.FB_PAGE_TOKEN); }
async function fbCall(env, path, params, method = "POST") {
  const ver = env.FB_API_VERSION || "v25.0";
  const body = new URLSearchParams({ ...params, access_token: String(env.FB_PAGE_TOKEN).trim() });
  const url = `https://graph.facebook.com/${ver}/${path}` + (method === "GET" ? `?${body}` : "");
  const res = await fetch(url, { method, body: method === "GET" ? undefined : body, signal: AbortSignal.timeout(30000) });
  const data = safeParse(await res.text()) || {};
  if (!res.ok || data.error) {
    const err = data.error || {};
    // Expired or revoked token (OAuthException 190, or 102/463/467): alert the owner once every 6 hours.
    if (err.code === 190 || err.code === 102 || [463, 467, 460].includes(err.error_subcode)) await fbTokenAlert(env, err.message || "token refused");
    throw new Error(`Facebook ${res.status}: ${err.message || "request failed"}`);
  }
  return data;
}
async function fbPublish(env, text, img) {
  const photo = imageUrl(env, img);
  if (photo) {
    try {
      const r = await fbCall(env, `${env.FB_PAGE_ID}/photos`, { url: photo, message: text, published: "true" });
      return { fb_id: r.post_id || r.id };
    } catch (e) {
      console.warn("facebook: photo post failed, posting text only", String(e)); // HARD RULE 2: retry without the image
    }
  }
  const r = await fbCall(env, `${env.FB_PAGE_ID}/feed`, { message: text });
  return { fb_id: r.id };
}
async function fbPermalink(env, fbId) {
  try { const r = await fbCall(env, fbId, { fields: "permalink_url" }, "GET"); return r.permalink_url || null; } catch { return null; }
}
async function fbReadText(env, fbId) {
  const r = await fbCall(env, fbId, { fields: "message" }, "GET");
  return String(r.message || "");
}
async function fbEdit(env, fbId, text) { await fbCall(env, fbId, { message: text }); }

// Publish a draft or a due scheduled post. Returns the updated row.
async function publishPost(env, id, by, expectVersion) {
  if (!fbReady(env)) throw new Error("Facebook is not connected (set FB_PAGE_ID and FB_PAGE_TOKEN)");
  const db = await postsDb(env);
  const cur = await db.prepare("SELECT * FROM posts WHERE id = ?1").bind(Number(id)).first();
  if (!cur) throw new Error(`no post ${id}`);
  if (!["draft", "scheduled", "failed"].includes(cur.state)) throw new Error(`post ${id} is ${cur.state}, not a draft`);
  if (expectVersion != null && Number(expectVersion) !== cur.version) throw new Error(`post ${id} changed since you opened it; reload`);
  // Claim it so two publishes can't race (cron + button).
  const claim = await db.prepare("UPDATE posts SET state = 'publishing', updated_at = ?1 WHERE id = ?2 AND state = ?3 RETURNING id").bind(Date.now(), cur.id, cur.state).first();
  if (!claim) throw new Error(`post ${id} is already being published`);
  try {
    const { fb_id } = await fbPublish(env, cur.text, safeParse(cur.image || "null"));
    const fb_url = await fbPermalink(env, fb_id);
    const row = await changePost(env, cur.id, by, null, { state: "published", fb_id, fb_url, published_at: Date.now(), error: null, published_by: by }, `published by ${by}`);
    await notifyPost(env, row, "published");
    return row;
  } catch (e) {
    await changePost(env, cur.id, "worker", null, { state: "failed", error: String(e.message || e).slice(0, 300) }, "publish failed");
    throw e;
  }
}

// Update a live post's text, keeping edits made on Facebook itself.
async function updateLivePost(env, cur, by, newText, note) {
  if (!fbReady(env)) throw new Error("Facebook is not connected");
  const live = await fbReadText(env, cur.fb_id);
  if (live.trim() && live.trim() !== String(cur.text).trim()) {
    // Edited on Facebook since we last wrote it: take that as an owner edit and refuse a stale update.
    await changePost(env, cur.id, "owner", null, { text: live }, "edited on Facebook");
    if (by !== "owner") throw new Error(`post ${cur.id} was edited on Facebook by the owner. Read it again with post_list and apply your change to the current text.`);
  }
  await fbEdit(env, cur.fb_id, newText);
  return await changePost(env, cur.id, by, null, { text: newText }, note);
}

// --- Notifications for D1 posts ---------------------------------------------
function postLink(env, id) {
  return env.REVIEW_URL ? `${String(env.REVIEW_URL).replace(/\/+$/, "")}/review#post-${id}` : undefined;
}
async function notifyPost(env, row, event) {
  try {
    const text = String(row.text || "");
    const lines = text.split("\n");
    const header = lines[0] || "";
    const updates = lines.filter((x) => isUpdateLine(x));
    const urgent = isUrgent(env, header, updates, text);
    const body = text.split(/\nInformation is from live scanner/)[0].trim();
    if (event === "created") {
      const hook = env.DISCORD_WEBHOOK_DRAFTS || env.DISCORD_WEBHOOK_URL;
      const title = row.state === "scheduled" ? `⏱️ Auto-post at ${localTime(row.auto_post_at)}: ${header}` : `📝 New draft: ${header}`;
      if (hook) await sendDiscord(env, title, body, urgent ? 0xe74c3c : 0x3498db, hook, postLink(env, row.id));
      if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) await sendPushover(env, title.slice(0, 100), body.slice(0, 900), urgent ? Number(env.PUSHOVER_URGENT_PRIORITY ?? 1) : row.state === "scheduled" ? Number(env.PUSHOVER_AUTO_PRIORITY ?? 1) : null);
    } else if (event === "updated") {
      const hook = env.DISCORD_WEBHOOK_DRAFTS || env.DISCORD_WEBHOOK_URL;
      const last = updates.length ? updates[updates.length - 1] : "(summary changed)";
      if (hook && String(env.NOTIFY_UPDATES || "on").toLowerCase() !== "off") await sendDiscord(env, `🔄 ${row.state === "published" ? "Live post updated" : "Draft updated"}: ${header}`, last, 0x95a5a6, hook, postLink(env, row.id));
    } else if (event === "published") {
      const hook = env.DISCORD_WEBHOOK_POSTS || env.DISCORD_WEBHOOK_URL;
      if (hook) await sendDiscord(env, `✅ Published: ${header}`, body.slice(0, 1500), 0x2ecc71, hook, row.fb_url || postLink(env, row.id));
    }
  } catch (e) { console.warn("notify post failed", String(e)); }
}

// --- Cron: publish due auto-posts, expire stale drafts, keep "active" fresh -----
// ---------------------------------------------------------------------------
// 🙏 PRAYER TRACKER (for fun): counts "prayers" comments on the Page's posts. Every PRAYER_EVERY_MINUTES (15)
// the Worker reads the Page's posts from the last PRAYER_DAYS (3) days and recounts any post whose comment
// count changed. Only numbers are stored (no comment text, no names). Needs pages_read_user_content on the
// Page token. PRAYERS=off disables. Covers every Page post, including ones made by hand.
// ---------------------------------------------------------------------------
const PRAYER_RE = /🙏|\b(pray|prays|prayed|praying|prayin|prayn|prayer|prayers|pryer|pryers|prayerz|prayres|praers)\b/iu;
let prayerSchemaReady = null;
async function prayerDb(env) {
  const db = await store(env);
  if (!db) return null;
  if (!prayerSchemaReady) {
    prayerSchemaReady = db.prepare(`CREATE TABLE IF NOT EXISTS prayers (fb_id TEXT PRIMARY KEY, title TEXT, created_at INTEGER,
      prayers INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, checked_at INTEGER)`).run()
      .catch((e) => { prayerSchemaReady = null; throw e; });
  }
  await prayerSchemaReady;
  return db;
}
async function prayerCheck(env, force) {
  if (!fbReady(env) || String(env.PRAYERS || "on").toLowerCase() === "off") return;
  const every = Number(env.PRAYER_EVERY_MINUTES || 15) * 60000;
  const last = Number((await env.SEEN.get("prayer:last")) || 0);
  if (!force && Date.now() - last < every) return;
  await env.SEEN.put("prayer:last", String(Date.now()), { expirationTtl: 86400 });
  const db = await prayerDb(env);
  const since = Math.floor((Date.now() - Number(env.PRAYER_DAYS || 3) * 86400000) / 1000);
  const feed = await fbCall(env, `${env.FB_PAGE_ID}/posts`, {
    fields: "id,message,created_time,comments.filter(stream).limit(0).summary(true)", since: String(since), limit: "50",
  }, "GET");
  let checked = 0;
  for (const post of feed.data || []) if (await prayerCountPost(env, db, post)) checked++;
  if (checked) console.log("prayer tracker: recounted", checked, "post(s)");
  await prayerDiscord(env).catch((e) => console.warn("prayer discord", String(e)));
}
// Recounts one post when its comment total changed (or force). Returns true when it recounted.
async function prayerCountPost(env, db, post, maxPages = 10) {
  const total = Number((post.comments && post.comments.summary && post.comments.summary.total_count) || 0);
  const row = await db.prepare("SELECT comments FROM prayers WHERE fb_id = ?1").bind(post.id).first();
  if (row && row.comments === total) return false;
  const title = String(post.message || "").split("\n")[0].slice(0, 120);
  const created = Date.parse(post.created_time) || Date.now();
  let prayers = 0, seen = 0, after = null;
  for (let page = 0; page < maxPages && total > 0; page++) {
    const params = { fields: "message", filter: "stream", limit: "100" };
    if (after) params.after = after;
    const c = await fbCall(env, `${post.id}/comments`, params, "GET");
    for (const cm of c.data || []) { seen++; if (PRAYER_RE.test(String(cm.message || ""))) prayers++; }
    after = c.paging && c.paging.next && c.paging.cursors ? c.paging.cursors.after : null;
    if (!after) break;
  }
  await db.prepare(`INSERT INTO prayers (fb_id, title, created_at, prayers, comments, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(fb_id) DO UPDATE SET title = ?2, prayers = ?4, comments = ?5, checked_at = ?6`)
    .bind(post.id, title, created, prayers, Math.max(total, seen), Date.now()).run();
  return true;
}
// ALL-TIME SCAN: started from the review page's 🙏 tab. Each cron minute counts the next 25 older posts
// (paging cursor kept in KV "prayer:bf"), until Facebook has no older posts. Safe to stop and restart.
async function prayerBackfill(env) {
  if (!fbReady(env)) return;
  const st = safeParse((await env.SEEN.get("prayer:bf")) || "null");
  if (!st || st.done) return;
  const db = await prayerDb(env);
  // Page feeds page by TIME (paging.next carries until= and __paging_token), not by cursor:
  // keep the next URL (without the token) and follow it.
  let feed;
  if (st.next) {
    const u = new URL(st.next);
    u.searchParams.set("access_token", String(env.FB_PAGE_TOKEN).trim());
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(30000) });
    feed = safeParse(await res.text()) || {};
    if (!res.ok || feed.error) {
      const err = feed.error || {};
      if (err.code === 190) await fbTokenAlert(env, err.message || "token refused");
      throw new Error(`Facebook ${res.status}: ${err.message || "request failed"}`);
    }
  } else {
    feed = await fbCall(env, `${env.FB_PAGE_ID}/posts`, { fields: "id,message,created_time,comments.filter(stream).limit(0).summary(true)", limit: "25" }, "GET");
  }
  for (const post of feed.data || []) { await prayerCountPost(env, db, post, 20); st.posts = (st.posts || 0) + 1; }
  const last = (feed.data || []).slice(-1)[0];
  if (last) st.oldest = last.created_time;
  st.next = null;
  if (feed.paging && feed.paging.next) {
    const n = new URL(feed.paging.next);
    n.searchParams.delete("access_token");
    st.next = n.toString();
  }
  delete st.after;
  if (!st.next || !(feed.data || []).length) { st.done = true; st.finished = Date.now(); await env.SEEN.put("prayer:discord_sig", ""); }
  await env.SEEN.put("prayer:bf", JSON.stringify(st));
  if (st.done) await prayerDiscord(env).catch(() => {});
}

async function prayerStats(env) {
  const db = await prayerDb(env);
  const tz = env.TIMEZONE || "America/New_York", now = Date.now();
  const local = new Date(new Date(now).toLocaleString("en-US", { timeZone: tz }));
  const dayStart = new Date(local).setHours(0, 0, 0, 0) - (local.getTime() - now);
  const sum = async (from) => db.prepare("SELECT COALESCE(SUM(prayers),0) AS p, COALESCE(SUM(comments),0) AS c, COUNT(*) AS n FROM prayers WHERE created_at >= ?1").bind(from).first();
  const today = await sum(dayStart), week = await sum(now - 7 * 86400000), all = await sum(0);
  const top = await db.prepare("SELECT title, prayers, comments, created_at FROM prayers WHERE prayers > 0 ORDER BY prayers DESC LIMIT 10").all();
  const topWeek = await db.prepare("SELECT title, prayers FROM prayers WHERE prayers > 0 AND created_at >= ?1 ORDER BY prayers DESC LIMIT 3").bind(now - 7 * 86400000).all();
  const rowsAll = await db.prepare("SELECT title, prayers, comments FROM prayers").all();
  const types = {};
  for (const x of rowsAll.results || []) { const t = prayerType(x.title); const o = (types[t] = types[t] || { type: t, prayers: 0, comments: 0, posts: 0 }); o.prayers += x.prayers; o.comments += x.comments; o.posts++; }
  return { today, week, all, top: top.results || [], topWeek: topWeek.results || [],
    types: Object.values(types).filter((t) => t.posts).sort((a, b) => b.prayers / b.posts - a.prayers / a.posts).slice(0, 12) };
}
// ONE Discord message in DISCORD_WEBHOOK_PRAYERS, edited in place whenever a count changes (never a new post,
// unless the message was deleted). The message id is kept in KV.
async function prayerDiscord(env) {
  const hook = env.DISCORD_WEBHOOK_PRAYERS;
  if (!hook) return;
  const st = await prayerStats(env);
  const pct = (x) => (x.c ? ` (${Math.round((100 * x.p) / x.c)}% of comments)` : "");
  const lines = [
    `**Today:** 🙏 ${st.today.p}${pct(st.today)}`,
    `**Last 7 days:** 🙏 ${st.week.p}${pct(st.week)}`,
    `**All time:** 🙏 ${st.all.p}${pct(st.all)}`,
  ];
  if (st.topWeek.length) lines.push("", "**Most prayed for this week**", ...st.topWeek.map((t, i) => `${i + 1}. ${t.title} · 🙏 ${t.prayers}`));
  const sig = lines.join("\n");
  if (sig === (await env.SEEN.get("prayer:discord_sig"))) return;
  const payload = { embeds: [{ title: "🙏 Prayers Count", description: sig.slice(0, 4000), color: 0xf5a623,
    footer: { text: "Updated " + localTime(Date.now()) } }], allowed_mentions: { parse: [] } };
  const base = String(hook).split("?")[0];
  const msgId = await env.SEEN.get("prayer:discord_msg");
  let res = msgId ? await fetch(`${base}/messages/${msgId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) : null;
  if (!res || res.status === 404) {
    res = await fetch(`${base}?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const m = safeParse(await res.text()) || {};
    if (res.ok && m.id) await env.SEEN.put("prayer:discord_msg", m.id);
  }
  if (res.ok) await env.SEEN.put("prayer:discord_sig", sig);
}
function prayerType(title) {
  return String(title || "").split(" · ")[0].replace(/^[^\p{L}\p{N}]+/u, "").trim() || "Other";
}

async function postsCron(env) {
  if (!reviewOn(env)) return;
  const db = await postsDb(env);
  const now = Date.now();
  if (fbReady(env)) {
    const due = await db.prepare("SELECT id FROM posts WHERE state = 'scheduled' AND auto_post_at <= ?1 ORDER BY id LIMIT 5").bind(now).all();
    for (const r of due.results || []) {
      try { await publishPost(env, r.id, "worker"); console.log("auto-post published", r.id); }
      catch (e) { console.error("auto-post failed", r.id, String(e)); }
    }
  }
  // A publish that died mid-way (Worker restart) is retried as failed after 5 minutes.
  await db.prepare("UPDATE posts SET state = 'failed', error = 'publish interrupted; check Facebook before retrying' WHERE state = 'publishing' AND updated_at < ?1").bind(now - 5 * 60000).run();
  const staleH = Number(env.STALE_DRAFT_HOURS || 12);
  await db.prepare("UPDATE posts SET state = 'expired', updated_at = ?1 WHERE state = 'draft' AND updated_at < ?2").bind(now, now - staleH * 3600000).run();
  // Ongoing incidents keep context wakes frequent.
  const idleMs = Number(env.ACTIVE_IDLE_MINUTES ?? 90) * 60000;
  const recent = await db.prepare("SELECT text FROM posts WHERE state IN ('draft', 'scheduled', 'published') AND updated_at > ?1").bind(now - idleMs).all();
  if ((recent.results || []).some((r) => isOngoingText(r.text)) && env.SEEN) await env.SEEN.put("ctx:active", String(now), { expirationTtl: 3600 });
}

// --- Connector tools for posts (listed only with REVIEW=on) ---------------
const POST_TOOLS = [
  {
    name: "post_list",
    description: "Drafts and scheduled auto-posts (any age) and posts published in the last 24 hours, each with id, state, version, full text and image parameters. Read-only. Use it in step 2 and before every post_update.",
    inputSchema: { type: "object", properties: { hours: { type: "integer", description: "How far back to list published posts (default 24, at most 72)." } } },
  },
  {
    name: "post_create",
    description: "Create a private draft (default) or, only for an incident that meets AUTO-POST, a scheduled auto-post (auto_post_minutes = AUTO_POST_DELAY_MINUTES). text is the complete post. image is the map image parameters (e, l1, l2, l3, mode, q or lat+lon, optional z), never a URL. incident_id links the tracking record. Returns id and version.",
    inputSchema: { type: "object", required: ["text"], properties: {
      text: { type: "string" }, incident_id: { type: "integer" }, auto_post_minutes: { type: "integer" },
      image: { type: "object", properties: { e: { type: "string" }, l1: { type: "string" }, l2: { type: "string" }, l3: { type: "string" }, mode: { type: "string" }, q: { type: "string" }, lat: { type: "string" }, lon: { type: "string" }, z: { type: "string" } } },
    } },
  },
  {
    name: "post_update",
    description: "Replace a post's text (draft, scheduled or published; a published post is edited on Facebook). version must be the version you just read; if the post changed since (an owner edit), the update is refused and you must read it again and apply your change to the current text. image may be changed on drafts and scheduled posts only.",
    inputSchema: { type: "object", required: ["id", "version", "text"], properties: {
      id: { type: "integer" }, version: { type: "integer" }, text: { type: "string" }, note: { type: "string" },
      image: { type: "object", properties: { e: { type: "string" }, l1: { type: "string" }, l2: { type: "string" }, l3: { type: "string" }, mode: { type: "string" }, q: { type: "string" }, lat: { type: "string" }, lon: { type: "string" }, z: { type: "string" } } },
    } },
  },
  {
    name: "post_supersede",
    description: "Retire a duplicate draft (it disappears from review). reason names the kept post. Drafts only.",
    inputSchema: { type: "object", required: ["id", "reason"], properties: { id: { type: "integer" }, reason: { type: "string" } } },
  },
  {
    name: "post_pull_back",
    description: "Turn a scheduled auto-post back into a private draft before it publishes (AUTO-POST, Pull back).",
    inputSchema: { type: "object", required: ["id", "reason"], properties: { id: { type: "integer" }, reason: { type: "string" } } },
  },
];

async function postTool(name, a, env) {
  const db = await postsDb(env);
  const now = Date.now();
  if (name === "post_list") {
    const hours = Math.min(Math.max(Number(a.hours) || 24, 1), 72);
    const rows = await db.prepare(`SELECT * FROM posts WHERE state IN ('draft', 'scheduled', 'publishing', 'failed') OR (state = 'published' AND published_at > ?1) ORDER BY id`).bind(now - hours * 3600000).all();
    return { posts: (rows.results || []).map(postOut), facebook: fbReady(env) ? "connected" : "not connected" };
  }
  if (name === "post_create") {
    const text = String(a.text || "").trim();
    if (!text) throw new Error("text is required");
    const img = cleanImage(a.image);
    const mins = Number(a.auto_post_minutes);
    const scheduled = Number.isFinite(mins) && mins > 0;
    const r = await db.prepare(`INSERT INTO posts (incident_id, state, text, image, auto_post_at, created_at, updated_at, version, last_by)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, 'bot') RETURNING *`)
      .bind(a.incident_id == null ? null : Number(a.incident_id), scheduled ? "scheduled" : "draft", text, img ? JSON.stringify(img) : null, scheduled ? now + mins * 60000 : null, now).first();
    await savePostVersion(db, r.id, 1, "bot", text, scheduled ? `auto-post in ${mins} min` : "draft");
    await notifyPost(env, r, "created");
    return { id: r.id, version: 1, state: r.state, auto_post_at: scheduled ? localTime(r.auto_post_at) : null };
  }
  if (name === "post_update") {
    const cur = await db.prepare("SELECT * FROM posts WHERE id = ?1").bind(Number(a.id)).first();
    if (!cur) throw new Error(`no post ${a.id}`);
    if (Number(a.version) !== cur.version) {
      const who = cur.last_by === "owner" ? "the owner edited it" : `changed by ${cur.last_by}`;
      throw new Error(`post ${cur.id} changed since you read it (${who}; now version ${cur.version}). Read it again with post_list and apply your change to the current text; never undo the owner's edits.`);
    }
    const text = String(a.text || "").trim();
    if (!text) throw new Error("text is required");
    let row;
    if (cur.state === "published") {
      row = await updateLivePost(env, cur, "bot", text, a.note);
    } else if (["draft", "scheduled", "failed"].includes(cur.state)) {
      const fields = { text };
      let img;
      if (a.image && typeof a.image === "object") {
        // A partial image (e.g. only a new q) keeps the current lines and emoji instead of wiping them.
        const old = safeParse(cur.image || "null") || {};
        const merged = { ...old, ...a.image };
        if (a.image.q && !a.image.lat) { delete merged.lat; delete merged.lon; }
        if (a.image.lat && !a.image.q) delete merged.q;
        img = cleanImage(merged);
      }
      if (img !== undefined) fields.image = img ? JSON.stringify(img) : null;
      row = await changePost(env, cur.id, "bot", a.version, fields, a.note);
    } else {
      throw new Error(`post ${cur.id} is ${cur.state}; it cannot be updated`);
    }
    await notifyPost(env, row, "updated");
    return { id: row.id, version: row.version, state: row.state };
  }
  if (name === "post_supersede") {
    const cur = await db.prepare("SELECT state FROM posts WHERE id = ?1").bind(Number(a.id)).first();
    if (!cur) throw new Error(`no post ${a.id}`);
    if (cur.state !== "draft") throw new Error(`post ${a.id} is ${cur.state}; only drafts can be superseded`);
    const row = await changePost(env, Number(a.id), "bot", null, { state: "superseded", note: String(a.reason || "").slice(0, 300) }, `superseded: ${a.reason || ""}`);
    return { id: row.id, state: row.state };
  }
  if (name === "post_pull_back") {
    const r = await db.prepare("UPDATE posts SET state = 'draft', auto_post_at = NULL, updated_at = ?1, version = version + 1, last_by = 'bot', note = ?2 WHERE id = ?3 AND state = 'scheduled' RETURNING *")
      .bind(now, `pulled back: ${String(a.reason || "").slice(0, 300)}`, Number(a.id)).first();
    if (!r) throw new Error(`post ${a.id} is not a scheduled auto-post (it may already be published)`);
    await savePostVersion(db, r.id, r.version, "bot", r.text, `pulled back: ${a.reason || ""}`);
    return { id: r.id, state: r.state, version: r.version };
  }
  throw new Error(`unknown tool ${name}`);
}


// Public privacy policy and data-deletion page for the Meta app (GET /privacy, /data-deletion).
function privacyPage(env) {
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const name = esc(env.PRIVACY_NAME || env.PAGE_NAME || "TLR Scribe");
  const contact = env.PRIVACY_EMAIL ? `<a href="mailto:${esc(env.PRIVACY_EMAIL)}">${esc(env.PRIVACY_EMAIL)}</a>` : "a message to our Facebook page";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy policy · ${name}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1d1f23}h1{font-size:26px}h2{font-size:19px;margin-top:28px}</style></head><body>
<h1>Privacy policy</h1>
<p>This policy covers the ${name} publishing app, which posts public-safety incident updates to the ${name} Facebook page. Last updated November 26, 2026.</p>
<h2>What the app does</h2>
<p>The app writes posts about fire, crash, law enforcement and weather incidents, based on public scanner radio traffic, and publishes them to our own Facebook page. Posts are reviewed by the page owner or follow fixed publishing rules.</p>
<h2>Information we collect from Facebook users</h2>
<p>None. The app does not log anyone in, does not read profiles, messages, comments or reactions, and does not collect, store or share personal data about Facebook users. It uses Facebook only to publish and edit posts on our own page.</p>
<h2>Information in posts</h2>
<p>Posts leave out personal details such as names, phone numbers, license plates, dates of birth and apartment numbers. If you believe a post contains information about you that should not be there, contact us and we will review and correct or remove it.</p>
<h2>Data deletion</h2>
<p>Because the app stores no data about Facebook users, there is nothing to delete on our side. To ask for a post to be corrected or removed, or for any other privacy request, send ${contact}. We respond to requests promptly.</p>
<h2>Contact</h2>
<p>${name}: ${contact}.</p>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

async function fbTokenAlert(env, why) {
  try {
    if (env.SEEN && (await env.SEEN.get("fb:tokenalert"))) return;
    if (env.SEEN) await env.SEEN.put("fb:tokenalert", "1", { expirationTtl: 6 * 3600 });
    const msg = `Facebook refused the Page token (${String(why).slice(0, 200)}). Posts can't publish until FB_PAGE_TOKEN is replaced.`;
    if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) await sendPushover(env, "⚠️ Facebook token problem", msg, 1);
    const hook = env.DISCORD_WEBHOOK_LOG || env.DISCORD_WEBHOOK_URL;
    if (hook) await sendDiscord(env, "⚠️ Facebook token problem", msg, 0xe67e22, hook);
  } catch (e) { console.warn("token alert failed", String(e)); }
}

// ---------------------------------------------------------------------------
// REVIEW PAGE (/review) and its API (/review/api/*). Protected by Cloudflare Access: set
// ACCESS_TEAM (the team name in <team>.cloudflareaccess.com) and ACCESS_AUD (the Access
// application's audience tag); optionally REVIEW_EMAILS (comma-separated) to allow only those.
// REVIEW_TOKEN is a fallback for testing: open /review?token=<REVIEW_TOKEN> once (sets a cookie).
// ---------------------------------------------------------------------------
let accessKeys = null, accessKeysAt = 0;
function b64urlBytes(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
// Returns the token's payload, or { _fail: "<reason>" } (reasons are safe to show: no secrets).
async function verifyAccessJwt(token, env) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { _fail: "the sign-in token is malformed" };
  const header = safeParse(new TextDecoder().decode(b64urlBytes(parts[0])));
  const payload = safeParse(new TextDecoder().decode(b64urlBytes(parts[1])));
  if (!header || !payload || header.alg !== "RS256") return { _fail: "the sign-in token is not an Access token" };
  const team = String(env.ACCESS_TEAM).trim().replace(/^https?:\/\//, "").replace(/\.cloudflareaccess\.com.*$/, "");
  if (payload.iss && payload.iss !== `https://${team}.cloudflareaccess.com`) return { _fail: `ACCESS_TEAM does not match: the token comes from ${payload.iss}, so ACCESS_TEAM should be "${String(payload.iss).replace(/^https:\/\//, "").replace(/\.cloudflareaccess\.com$/, "")}"` };
  if (!accessKeys || Date.now() - accessKeysAt > 3600000 || !accessKeys.some((k) => k.kid === header.kid)) {
    const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { _fail: `could not load the Access keys for team "${team}" (HTTP ${r.status}); check ACCESS_TEAM` };
    accessKeys = ((await r.json()) || {}).keys || [];
    accessKeysAt = Date.now();
  }
  const jwk = accessKeys.find((k) => k.kid === header.kid);
  if (!jwk) return { _fail: `the token's signing key is not one of team "${team}"'s keys; check ACCESS_TEAM` };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return { _fail: "the token's signature did not verify" };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const want = String(env.ACCESS_AUD).trim();
  if (!aud.includes(want)) return { _fail: `ACCESS_AUD does not match this application (yours starts "${want.slice(0, 6)}", the token's starts "${String(aud[0] || "").slice(0, 6)}"; ${want.length} vs ${String(aud[0] || "").length} characters)` };
  if (!payload.exp || payload.exp * 1000 < Date.now()) return { _fail: "the sign-in has expired; reload to sign in again" };
  return payload;
}
function cookieOf(request, name) {
  const m = String(request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}
async function reviewAuth(request, url, env) {
  let why = "";
  if (env.ACCESS_TEAM && env.ACCESS_AUD) {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || cookieOf(request, "CF_Authorization");
    const p = jwt ? await verifyAccessJwt(jwt, env).catch((e) => ({ _fail: `check failed: ${e && e.message ? e.message : e}` })) : { _fail: "no Access sign-in reached the Worker (open the page at the review address, not workers.dev, and make sure the Access application covers that hostname)" };
    if (p && !p._fail) {
      const allow = list(env.REVIEW_EMAILS || "");
      if (!allow.length || allow.includes(String(p.email || "").toLowerCase())) return { ok: true, who: p.email || "owner" };
      why = `${p.email || "this email"} is not in REVIEW_EMAILS`;
    } else why = p._fail;
  } else why = "ACCESS_TEAM and ACCESS_AUD are not both set";
  if (env.REVIEW_TOKEN) {
    const given = url.searchParams.get("token") || cookieOf(request, "scribe_review");
    if (given && (await secretMatches(given, env.REVIEW_TOKEN))) return { ok: true, who: "owner", setCookie: !!url.searchParams.get("token") };
  }
  return { ok: false, why };
}

async function handleReview(request, url, env, ctx) {
  if (!reviewOn(env)) return text("The review page needs the D1 database binding (DB or WAKELOCK).", 404);
  const auth = await reviewAuth(request, url, env);
  if (!auth.ok) return text(`Not signed in. Open this page through Cloudflare Access.\nReason: ${auth.why || "unknown"}`, 403);
  const path = url.pathname.replace(/^\/review\/?/, "");
  if (!path.startsWith("api/")) {
    const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
    if (auth.setCookie) headers["Set-Cookie"] = `scribe_review=${encodeURIComponent(url.searchParams.get("token"))}; Path=/review; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`;
    const pageName = String(env.PAGE_NAME || "TLR Scribe").replace(/[<>&"]/g, "");
    return new Response(REVIEW_HTML.replaceAll("__PAGE_NAME__", pageName), { headers });
  }
  // Browsers only: a cross-site POST can't carry our cookies (SameSite) and Access checks the JWT.
  const route = path.slice(4);
  const db = await postsDb(env);
  const body = request.method === "POST" ? safeParse(await request.text()) || {} : {};
  const ok = (o) => json(o);
  try {
    if (route === "list") {
      const rows = await db.prepare(`SELECT * FROM posts WHERE state IN ('draft', 'scheduled', 'failed', 'publishing') OR (state = 'published' AND published_at > ?1) ORDER BY id DESC`).bind(Date.now() - 48 * 3600000).all();
      const all = (rows.results || []).map(postOut);
      try {
        const pdb = await prayerDb(env);
        const pr = await pdb.prepare("SELECT fb_id, prayers, comments FROM prayers WHERE created_at > ?1").bind(Date.now() - 4 * 86400000).all();
        const byId = new Map((pr.results || []).map((x) => [x.fb_id, x]));
        const fbIds = new Map((rows.results || []).map((x) => [x.id, x.fb_id]));
        for (const p of all) { const x = byId.get(fbIds.get(p.id)); if (x) { p.prayers = x.prayers; p.comments = x.comments; } }
      } catch {}
      return ok({
        draft: all.filter((p) => p.state === "draft" || p.state === "failed" || p.state === "publishing"),
        scheduled: all.filter((p) => p.state === "scheduled"),
        published: all.filter((p) => p.state === "published"),
        facebook: fbReady(env) ? "connected" : "not connected",
      });
    }
    if (route.startsWith("post")) {
      const id = Number(url.searchParams.get("id"));
      const r = await db.prepare("SELECT * FROM posts WHERE id = ?1").bind(id).first();
      if (!r) return json({ error: "not found" }, 404);
      const v = await db.prepare("SELECT version, at, by, note FROM post_versions WHERE post_id = ?1 ORDER BY version DESC LIMIT 25").bind(id).all();
      const inc = r.incident_id ? await db.prepare("SELECT title, track FROM incidents WHERE id = ?1").bind(r.incident_id).first() : null;
      return ok({ ...postOut(r), versions: (v.results || []).map((x) => ({ ...x, at: localTime(x.at) })), track: inc ? inc.track : null });
    }
    if (route === "save" && request.method === "POST") {
      const cur = await db.prepare("SELECT * FROM posts WHERE id = ?1").bind(Number(body.id)).first();
      if (!cur) return json({ error: "not found" }, 404);
      if (Number(body.version) !== cur.version) return json({ error: "This post changed since you opened it (the bot added something). Go back and open it again." }, 409);
      const textNew = String(body.text || "").trim();
      if (!textNew) return json({ error: "The post text is empty." }, 400);
      let row;
      if (cur.state === "published") {
        // Text goes to Facebook. A redrawn image is only saved here: Facebook cannot swap the photo on a
        // live post through the API, so the review page offers it as a download to replace by hand.
        row = cur;
        if (textNew !== cur.text) row = await updateLivePost(env, cur, "owner", textNew, "edited on the review page");
        if (body.image_set) {
          const img = cleanImage(body.image);
          const val = img ? JSON.stringify(img) : null;
          if (val !== row.image) row = await changePost(env, cur.id, "owner", row.version, { image: val }, "image redrawn (replace the photo on Facebook by hand)");
        }
      } else {
        const fields = { text: textNew };
        if (body.image_set) { const img = cleanImage(body.image); fields.image = img ? JSON.stringify(img) : null; }
        row = await changePost(env, cur.id, "owner", body.version, fields, "edited on the review page");
      }
      return ok({ id: row.id, version: row.version });
    }
    if (route === "publish" && request.method === "POST") {
      let cur = await db.prepare("SELECT * FROM posts WHERE id = ?1").bind(Number(body.id)).first();
      if (!cur) return json({ error: "not found" }, 404);
      if (Number(body.version) !== cur.version) return json({ error: "This post changed since you opened it (the bot added something). Go back and open it again before publishing." }, 409);
      const textNew = String(body.text || "").trim();
      if (textNew && textNew !== cur.text) cur = await changePost(env, cur.id, "owner", cur.version, { text: textNew }, "edited before publishing");
      const row = await publishPost(env, cur.id, "owner", cur.version);
      return ok({ id: row.id, state: row.state, fb_url: row.fb_url });
    }
    if (route === "discard" && request.method === "POST") {
      const r = await db.prepare("UPDATE posts SET state = 'discarded', updated_at = ?1, version = version + 1, last_by = 'owner' WHERE id = ?2 AND state IN ('draft', 'scheduled', 'failed') RETURNING id, version, text").bind(Date.now(), Number(body.id)).first();
      if (!r) return json({ error: "Only drafts and auto-posts can be discarded." }, 400);
      await savePostVersion(db, r.id, r.version, "owner", r.text, "discarded");
      return ok({ id: r.id });
    }
    if (route === "pullback" && request.method === "POST") {
      const r = await db.prepare("UPDATE posts SET state = 'draft', auto_post_at = NULL, updated_at = ?1, version = version + 1, last_by = 'owner' WHERE id = ?2 AND state = 'scheduled' RETURNING id, version, text").bind(Date.now(), Number(body.id)).first();
      if (!r) return json({ error: "It is no longer scheduled (it may have just published)." }, 400);
      await savePostVersion(db, r.id, r.version, "owner", r.text, "held as draft by owner");
      return ok({ id: r.id });
    }
    if (route.startsWith("image")) {
      const img = cleanImage(Object.fromEntries(url.searchParams));
      const u = imageUrl(env, img);
      if (!u) return json({ error: "no image (IMAGE_KEY not set or no parameters)" }, 400);
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") || "image/png", "Cache-Control": "private, max-age=3600" } });
    }
    if (route === "corrections" && request.method === "GET") {
      const r = await db.prepare("SELECT id, created_at, heard, means, scope, note FROM corrections WHERE active = 1 ORDER BY id DESC").all();
      return ok({ corrections: (r.results || []).map((c) => ({ ...c, created: new Date(c.created_at).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) })) });
    }
    if (route === "corrections" && request.method === "POST") {
      const heard = String(body.heard || "").trim().slice(0, 120), means = String(body.means || "").trim().slice(0, 200);
      if (!heard || !means) return json({ error: "Fill in both 'heard as' and 'means'." }, 400);
      const r = await db.prepare("INSERT INTO corrections (created_at, heard, means, scope, note) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id").bind(Date.now(), heard, means, String(body.scope || "").slice(0, 120) || null, String(body.note || "").slice(0, 300) || null).first();
      return ok({ id: r.id });
    }
    if (route === "corrections/delete" && request.method === "POST") {
      await db.prepare("UPDATE corrections SET active = 0 WHERE id = ?1").bind(Number(body.id)).run();
      return ok({ ok: true });
    }
    if (route === "prayers") {
      if (url.searchParams.get("scan") === "start") await env.SEEN.put("prayer:bf", JSON.stringify({ started: Date.now(), posts: 0 }));
      if (url.searchParams.get("scan") === "stop") { const b = safeParse((await env.SEEN.get("prayer:bf")) || "null"); if (b) { b.done = true; await env.SEEN.put("prayer:bf", JSON.stringify(b)); } }
      if (url.searchParams.get("refresh")) await prayerCheck(env, true).catch((e) => console.warn("prayer refresh", String(e)));
      const st = await prayerStats(env);
      const last = Number((await env.SEEN.get("prayer:last")) || 0);
      const bf = safeParse((await env.SEEN.get("prayer:bf")) || "null");
      const scan = bf ? { running: !bf.done, posts: bf.posts || 0, oldest: bf.oldest ? new Date(bf.oldest).toLocaleDateString("en-US", { timeZone: env.TIMEZONE || "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null } : null;
      return ok({ scan, today: st.today, week: st.week, all: st.all, last: last ? localTime(last) : null,
        top: st.top.map((x) => ({ ...x, when: localTime(x.created_at) })), types: st.types });
    }
    if (route === "runlogs") {
      const r = await db.prepare("SELECT created_at, run, text FROM runlogs ORDER BY id DESC LIMIT 20").all();
      return ok({ runlogs: r.results || [] });
    }
    return json({ error: "unknown route" }, 404);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}

const REVIEW_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#0f1115\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<title>__PAGE_NAME__ · Review</title>\n<style>\n:root{--bg:#0f1115;--card:#181b22;--card2:#14171d;--line:#2a2f38;--line2:#22262e;--text:#e8eaed;--muted:#9aa1ab;--blue:#2f6fed;--red:#ff8a85;--fire:#ff6b66;--crash:#f5a623;--green:#8fd19e}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,\"Segoe UI\",Inter,sans-serif;-webkit-text-size-adjust:100%}\nbutton,input,select,textarea{font:inherit;color:inherit}\na{color:inherit}\n.wrap{max-width:640px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}\nheader{position:sticky;top:0;z-index:5;background:var(--bg);padding:14px 16px 10px;border-bottom:1px solid var(--line2);display:flex;align-items:center;gap:10px}\nheader h1{margin:0;font-size:22px;font-weight:700;flex:1}\nheader .sub{font-size:12px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}\n.iconbtn{width:44px;height:44px;border-radius:22px;border:1px solid var(--line);background:var(--card);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}\n.tabs{display:flex;gap:8px;padding:10px 16px;overflow-x:auto}\n.tab{height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--line);background:transparent;color:#c9ced6;white-space:nowrap;cursor:pointer}\n.tab.on{background:var(--text);color:var(--bg);border-color:var(--text);font-weight:600}\nmain{flex:1;padding:6px 16px 24px;display:flex;flex-direction:column;gap:12px}\n.card{display:flex;gap:12px;padding:12px;border-radius:14px;background:var(--card);border:1px solid var(--line);text-decoration:none;cursor:pointer}\n.card.new{border-color:var(--crash)}\n.thumb{width:72px;height:72px;border-radius:10px;object-fit:cover;flex-shrink:0;background:var(--card2)}\n.meta{display:flex;flex-direction:column;gap:3px;min-width:0}\n.kicker{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}\n.title{font-size:16px;font-weight:600;line-height:1.25}\n.small{font-size:13px;color:var(--muted)}\n.empty{padding:40px 10px;text-align:center;color:var(--muted)}\n.btn{height:48px;border-radius:12px;border:1px solid var(--line);background:var(--card);font-weight:600;cursor:pointer;padding:0 14px}\n.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff;height:52px;font-size:17px}\n.btn.danger{color:var(--red);border-color:#3a2424}\n.btn:disabled{opacity:.5}\n.row{display:flex;gap:10px}\n.row>*{flex:1}\ntextarea{width:100%;min-height:300px;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--card);line-height:1.45;resize:vertical}\ninput,select{width:100%;height:48px;padding:0 12px;border-radius:12px;border:1px solid var(--line);background:var(--card)}\ntextarea:focus,input:focus,select:focus{outline:2px solid #4c8dff;outline-offset:-2px}\nlabel{font-size:14px;font-weight:500;display:flex;flex-direction:column;gap:6px}\nh2{margin:6px 0 0;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}\n.chip{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:13px;background:var(--card);border:1px solid var(--line);font-size:12px;color:#c9ced6;margin:0 6px 6px 0}\n.mapimg{width:100%;border-radius:12px;display:block;background:var(--card2);min-height:120px}\n.seg{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;padding:4px;border-radius:12px;background:var(--card);border:1px solid var(--line)}\n.seg button{height:40px;border-radius:9px;border:none;background:transparent;color:#c9ced6;font-weight:600;cursor:pointer}\n.seg button.on{background:var(--blue);color:#fff}\n.box{padding:14px;border-radius:12px;background:var(--card2);border:1px solid var(--line2);display:flex;flex-direction:column;gap:10px}\n.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#232833;border:1px solid var(--line);padding:12px 16px;border-radius:12px;max-width:90vw;z-index:20;display:none}\n.log{white-space:pre-wrap;font-size:13px;padding:12px;border-radius:12px;background:var(--card);border:1px solid var(--line)}\n.ver{font-size:13px;color:var(--muted);border-top:1px solid var(--line2);padding-top:8px}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <header>\n    <button class=\"iconbtn\" id=\"back\" aria-label=\"Back\" style=\"display:none\" onclick=\"goBack()\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\"><path d=\"M15 18l-6-6 6-6\"/></svg></button>\n    <div style=\"flex:1\"><div class=\"sub\">__PAGE_NAME__</div><h1 id=\"htitle\">Drafts</h1></div>\n    <button class=\"iconbtn\" aria-label=\"Refresh\" onclick=\"route()\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\"><path d=\"M21 12a9 9 0 1 1-3-6.7\"/><path d=\"M21 3v6h-6\"/></svg></button>\n  </header>\n  <div class=\"tabs\" id=\"tabs\"></div>\n  <main id=\"main\"><div class=\"empty\">Loading…</div></main>\n</div>\n<div class=\"toast\" id=\"toast\" role=\"status\"></div>\n<script>\nconst API = location.pathname.replace(/\\/+$/, \"\") + \"/api/\";\nconst $ = (s) => document.querySelector(s);\nconst esc = (x) => String(x == null ? \"\" : x).replace(/[&<>\"']/g, (c) => ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c]));\nlet state = { tab: \"draft\", list: null, post: null };\nfunction toast(msg, ms) { const t = $(\"#toast\"); t.textContent = msg; t.style.display = \"block\"; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = \"none\"), ms || 3500); }\nasync function api(path, body) {\n  const r = await fetch(API + path, body ? { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify(body) } : {});\n  const j = await r.json().catch(() => ({ error: \"bad response\" }));\n  if (!r.ok || j.error) throw new Error(j.error || (\"HTTP \" + r.status));\n  return j;\n}\nfunction imgSrc(image) { if (!image) return \"\"; const q = new URLSearchParams(image); return API + \"image?\" + q.toString(); }\nconst TABS = [[\"draft\", \"Drafts\"], [\"scheduled\", \"Auto-posts\"], [\"published\", \"Live\"], [\"prayers\", \"🙏\"], [\"fixes\", \"Fixes\"], [\"logs\", \"Run logs\"]];\nfunction setHeader(title, showBack, showTabs) {\n  $(\"#htitle\").textContent = title; $(\"#back\").style.display = showBack ? \"flex\" : \"none\";\n  $(\"#tabs\").style.display = showTabs ? \"flex\" : \"none\";\n  $(\"#tabs\").innerHTML = TABS.map(([k, v]) => {\n    const n = state.list && state.list[k] ? \" · \" + state.list[k].length : \"\";\n    return `<button class=\"tab ${state.tab === k ? \"on\" : \"\"}\" onclick=\"state.tab='${k}';location.hash='';route()\">${v}${[\"fixes\", \"logs\", \"prayers\"].includes(k) ? \"\" : n}</button>`;\n  }).join(\"\");\n}\nasync function route() {\n  const m = location.hash.match(/^#post-(\\d+)(\\/fix)?$/);\n  try {\n    if (m) return m[2] ? await showFix(Number(m[1])) : await showPost(Number(m[1]));\n    if (state.tab === \"logs\") return await showLogs();\n    if (state.tab === \"prayers\") return await showPrayers();\n    if (state.tab === \"fixes\") return await showFixes();\n    await showList();\n  } catch (e) { $(\"#main\").innerHTML = `<div class=\"empty\">${esc(e.message)}</div>`; }\n}\nwindow.addEventListener(\"hashchange\", () => { state.busy = false; route(); });\n// AUTO-REFRESH: every 20 s while the page is visible, and right away when you come back to it.\n// Lists redraw only when something changed. An open post redraws when the bot or Facebook changed it,\n// unless you are editing it: then a banner offers the newer version instead of wiping your edits.\n// The fix screen is never refreshed underneath you.\nasync function autoRefresh() {\n  if (document.hidden || state.busy) return;\n  const m = location.hash.match(/^#post-(\\d+)(\\/fix)?$/);\n  try {\n    if (m) { if (!m[2]) await showPost(Number(m[1]), true); }\n    else if (state.tab === \"logs\") await showLogs(true);\n    else if (state.tab === \"prayers\") await showPrayers(true);\n    else if (state.tab !== \"fixes\") await showList(true);\n  } catch (e) {}\n}\nsetInterval(autoRefresh, 20000);\ndocument.addEventListener(\"visibilitychange\", () => { if (!document.hidden) autoRefresh(); });\n// Back goes UP one level (fix -> post -> list), never through browser history:\n// after a save or publish the history can hold the same post twice.\nfunction goBack() {\n  const m = location.hash.match(/^#post-(\\d+)(\\/fix)?$/);\n  location.hash = m && m[2] ? \"#post-\" + m[1] : \"\";\n}\n\nasync function showList(quiet) {\n  const list = await api(\"list\");\n  const sig = JSON.stringify([state.tab, list]);\n  if (quiet && sig === state.listSig) return;\n  state.list = list; state.listSig = sig;\n  setHeader({ draft: \"Drafts\", scheduled: \"Auto-posts\", published: \"Live posts\" }[state.tab], false, true);\n  const items = state.list[state.tab] || [];\n  const fb = state.list.facebook === \"connected\" ? \"\" : `<div class=\"box small\">Facebook is not connected yet, so Publish is off.</div>`;\n  if (!items.length) { $(\"#main\").innerHTML = fb + `<div class=\"empty\">Nothing here right now.</div>`; return; }\n  $(\"#main\").innerHTML = fb + items.map((p) => {\n    const lines = String(p.text).split(\"\\n\");\n    const kick = p.state === \"scheduled\" ? `<span style=\"color:var(--fire)\">Auto-post at ${esc(p.auto_post_at)}</span>`\n      : p.state === \"failed\" ? `<span style=\"color:var(--red)\">Publish failed</span>`\n      : p.state === \"published\" ? `Published ${esc(p.published)}${p.prayers != null ? ` · 🙏 ${p.prayers}/${p.comments}` : \"\"}` : `${p.owner_edited ? \"Edited by you · \" : \"\"}Updated ${esc(p.updated)}`;\n    const thumb = p.image ? `<img class=\"thumb\" loading=\"lazy\" alt=\"\" src=\"${imgSrc(p.image)}\">` : `<div class=\"thumb\"></div>`;\n    return `<a class=\"card\" href=\"#post-${p.id}\">${thumb}<div class=\"meta\"><span class=\"kicker\">${kick}</span><span class=\"title\">${esc(lines[0])}</span><span class=\"small\">${esc((lines[1] || \"\").split(\" · \")[0])}</span></div></a>`;\n  }).join(\"\");\n}\n\n// X VERSION of a post: the header (type · place), the location/time line, then as many whole sentences\n// of the summary as fit in 280 (X counts an emoji as 2). No links. Updates go out as replies (Copy update).\nfunction xLen(t) { let n = 0; for (const ch of t) n += ch.codePointAt(0) > 0x2fff ? 2 : 1; return n; }\nfunction xText(text) {\n  const lines = String(text).split(\"\\n\");\n  const head = [lines[0], lines[1]].filter(Boolean).join(\"\\n\");\n  const body = (lines.slice(2).find((l) => l.trim() && !/^(🔄|UPDATE)/.test(l.trim())) || \"\").trim();\n  let out = head;\n  for (const sent of body.match(/[^.!?]+[.!?]+(\\s|$)|[^.!?]+$/g) || []) {\n    const next = out + (out === head ? \"\\n\\n\" : \" \") + sent.trim();\n    if (xLen(next) > 280) break;\n    out = next;\n  }\n  return out;\n}\nfunction xUpdate(text) {\n  const ups = String(text).split(\"\\n\").filter((l) => /^(🔄\\s*)?UPDATE\\b/i.test(l.trim()));\n  if (!ups.length) return \"\";\n  let u = ups[ups.length - 1].trim();\n  while (xLen(u) > 275) u = u.replace(/\\s*\\S+$/, \"\") + \"…\";\n  return u;\n}\n\nasync function showPost(id, quiet) {\n  const p0 = await api(\"post?id=\" + id);\n  if (quiet && state.post && state.post.id === p0.id) {\n    const old = state.post;\n    if (p0.version === old.version && p0.state === old.state) return;\n    const t = $(\"#txt\");\n    const editing = t && (t.value !== old.text || document.activeElement === t);\n    if (editing || state.busy) {\n      const n = $(\"#newer\");\n      if (n) { n.style.display = \"block\"; n.textContent = `Newer version (v${p0.version}, ${p0.last_by}) · tap to load it. Your unsaved edits will be lost.`; }\n      return;\n    }\n    toast(`Updated by ${p0.last_by}`);\n  }\n  const p = (state.post = p0);\n  setHeader(p.state === \"published\" ? \"Live post\" : p.state === \"scheduled\" ? \"Auto-post\" : \"Review draft\", true, false);\n  const editable = [\"draft\", \"scheduled\", \"failed\", \"published\"].includes(p.state);\n  const canPublish = [\"draft\", \"scheduled\", \"failed\"].includes(p.state);\n  const img = p.image ? `<img class=\"mapimg\" alt=\"Map image for this post\" src=\"${imgSrc(p.image)}\">` : `<div class=\"box small\">No map image.</div>`;\n  $(\"#main\").innerHTML = `\n    <div class=\"box small\" id=\"newer\" style=\"display:none;cursor:pointer;color:var(--fire)\" onclick=\"state.post=null;route()\"></div>\n    ${img}\n    <div>${p.state === \"scheduled\" ? `<span class=\"chip\" style=\"color:var(--fire)\">Auto-post at ${esc(p.auto_post_at)}</span>` : \"\"}\n      <span class=\"chip\">${esc(p.state)}</span><span class=\"chip\">Updated ${esc(p.updated)} by ${esc(p.last_by)}</span>\n      ${p.fb_url ? `<a class=\"chip\" href=\"${esc(p.fb_url)}\" target=\"_blank\" rel=\"noopener\">Open on Facebook</a>` : \"\"}\n      ${p.error ? `<span class=\"chip\" style=\"color:var(--red)\">${esc(p.error)}</span>` : \"\"}</div>\n    <a class=\"btn\" style=\"display:flex;align-items:center;justify-content:center;text-decoration:none\" href=\"#post-${p.id}/fix\">${p.state === \"published\" ? \"Fix location &amp; redraw image\" : \"Fix location, label &amp; image\"}</a>\n    <label for=\"txt\">Post text${editable ? \" · tap to edit\" : \"\"}</label>\n    <textarea id=\"txt\" ${editable ? \"\" : \"readonly\"}>${esc(p.text)}</textarea>\n    ${canPublish ? `<button class=\"btn primary\" id=\"pub\" ${state.list && state.list.facebook !== \"connected\" ? \"disabled\" : \"\"}>Publish to Facebook</button>` : \"\"}\n    <div class=\"row\">\n      ${editable ? `<button class=\"btn\" id=\"save\">${p.state === \"published\" ? \"Save to Facebook\" : \"Save edits\"}</button>` : \"\"}\n      ${p.state === \"scheduled\" ? `<button class=\"btn\" id=\"pull\">Hold as draft</button>` : \"\"}\n      ${canPublish ? `<button class=\"btn danger\" id=\"discard\">Discard</button>` : \"\"}\n    </div>\n    ${p.state === \"published\" ? `<h2>Post to X</h2><div class=\"box\">\n      <div class=\"small\">Short version for X (${xLen(xText(p.text))}/280): type, location and as much of the summary as fits. No links. Share opens your phone's share sheet with the map image attached: pick X.</div>\n      <div class=\"log\" id=\"xtxt\">${esc(xText(p.text))}</div>\n      <div class=\"row\"><button class=\"btn primary\" id=\"xshare\">Share to X</button><button class=\"btn\" id=\"xcopy\">Copy text</button></div>\n      ${xUpdate(p.text) ? `<div class=\"small\">Latest update (post it as a reply under your X post):</div><div class=\"log\" id=\"xupd\">${esc(xUpdate(p.text))}</div><button class=\"btn\" id=\"xcopyupd\">Copy update</button>` : \"\"}\n    </div>` : \"\"}\n    ${p.track ? `<h2>Tracking</h2><div class=\"log\">${esc(p.track)}</div>` : \"\"}\n    <h2>History</h2>${(p.versions || []).map((v) => `<div class=\"ver\">v${v.version} · ${esc(v.at)} · ${esc(v.by)}${v.note ? \" · \" + esc(v.note) : \"\"}</div>`).join(\"\")}`;\n  const txt = () => $(\"#txt\").value;\n  const busy = (b) => { state.busy = b; document.querySelectorAll(\"#main button\").forEach((x) => (x.disabled = b)); };\n  if ($(\"#save\")) $(\"#save\").onclick = async () => { busy(true); try { await api(\"save\", { id: p.id, version: p.version, text: txt() }); toast(\"Saved\"); await showPost(p.id); } catch (e) { toast(e.message, 6000); busy(false); } };\n  if ($(\"#pub\")) $(\"#pub\").onclick = async () => {\n    if (!confirm(\"Publish this post to the Facebook page now?\")) return;\n    busy(true);\n    try { const r = await api(\"publish\", { id: p.id, version: p.version, text: txt() }); toast(\"Published\"); location.hash = \"#post-\" + r.id; await showPost(r.id); }\n    catch (e) { toast(e.message, 8000); busy(false); }\n  };\n  if ($(\"#discard\")) $(\"#discard\").onclick = async () => { if (!confirm(\"Discard this draft?\")) return; busy(true); try { await api(\"discard\", { id: p.id }); toast(\"Discarded\"); location.hash = \"\"; } catch (e) { toast(e.message, 6000); busy(false); } };\n  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast(\"Copied\"); } catch { toast(\"Copy failed; long-press the text instead\"); } };\n  if ($(\"#xcopy\")) $(\"#xcopy\").onclick = () => copy(xText(p.text));\n  if ($(\"#xcopyupd\")) $(\"#xcopyupd\").onclick = () => copy(xUpdate(p.text));\n  if ($(\"#xshare\")) $(\"#xshare\").onclick = async () => {\n    const text = xText(p.text);\n    try {\n      if (p.image && navigator.canShare) {\n        const blob = await (await fetch(imgSrc(p.image))).blob();\n        const file = new File([blob], \"map.png\", { type: blob.type || \"image/png\" });\n        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }\n      }\n    } catch (e) { if (e && e.name === \"AbortError\") return; }\n    window.open(\"https://x.com/intent/post?text=\" + encodeURIComponent(text), \"_blank\", \"noopener\");\n  };\n  if ($(\"#pull\")) $(\"#pull\").onclick = async () => { busy(true); try { await api(\"pullback\", { id: p.id }); toast(\"Held as a draft\"); await showPost(p.id); } catch (e) { toast(e.message, 6000); busy(false); } };\n}\n\nconst MODES = [[\"pin\", \"Pin\", \"Exact address or intersection: a pin at zoom 18.\"], [\"block\", \"Block\", \"A home: a soft circle on the block, no pin.\"], [\"road\", \"Road\", \"A road or interstate exit: a wider circle.\"], [\"mile\", \"MM\", \"Interstate mile marker: wide circle, zoom 14.5.\"], [\"town\", \"Town\", \"Town view, no marker.\"]];\nasync function showFix(id) {\n  const p = (state.post = await api(\"post?id=\" + id));\n  setHeader(\"Fix details\", true, false);\n  const lines = String(p.text).split(\"\\n\");\n  const [labelPart, placePart] = (lines[0] || \"\").split(\" · \");\n  const [locPart, ...rest] = (lines[1] || \"\").split(\" · \");\n  const datePart = rest.join(\" · \");\n  const img = Object.assign({ e: \"\", l1: \"\", l2: \"\", l3: \"\", mode: \"town\", q: \"\", lat: \"\", lon: \"\", z: \"\" }, p.image || {});\n  $(\"#main\").innerHTML = `\n    <img class=\"mapimg\" id=\"prev\" alt=\"Map preview\" src=\"${p.image ? imgSrc(p.image) : \"\"}\">\n    ${p.state === \"published\" ? `<div class=\"box small\">This post is live. Text changes go to Facebook when you save. Facebook can't swap the photo automatically: redraw it here, tap <b>Download image</b>, then on Facebook edit the post, remove the old photo and add the new one.</div>\n    <a class=\"btn\" id=\"dl\" download=\"map.png\" style=\"display:flex;align-items:center;justify-content:center;text-decoration:none\" href=\"${p.image ? imgSrc(p.image) : \"#\"}\">Download image</a>` : \"\"}\n    <h2>Post</h2>\n    <label>Label<input id=\"f_label\" value=\"${esc(labelPart || \"\")}\"></label>\n    <label>Town or place (after the ·)<input id=\"f_place\" value=\"${esc(placePart || \"\")}\"></label>\n    <label>Location line<input id=\"f_loc\" value=\"${esc(locPart || \"\")}\"></label>\n    <h2>Map image</h2>\n    <div class=\"seg\" role=\"group\" aria-label=\"How the location is marked\">${MODES.map(([k, v]) => `<button data-m=\"${k}\" class=\"${img.mode === k ? \"on\" : \"\"}\">${v}</button>`).join(\"\")}</div>\n    <div class=\"small\" id=\"modehelp\"></div>\n    <label>Find this place (address, cross streets or town)<input id=\"f_q\" value=\"${esc(img.q)}\"></label>\n    <div class=\"row\"><label>Latitude<input id=\"f_lat\" inputmode=\"decimal\" value=\"${esc(img.lat)}\"></label><label>Longitude<input id=\"f_lon\" inputmode=\"decimal\" value=\"${esc(img.lon)}\"></label></div>\n    <div class=\"small\">Latitude and longitude, when filled, win over the search text (used for mile markers).</div>\n    <label>Zoom (blank = default for the mode)<input id=\"f_z\" inputmode=\"decimal\" value=\"${esc(img.z)}\"></label>\n    <label>Image line 1<input id=\"f_l1\" value=\"${esc(img.l1)}\"></label>\n    <label>Image line 2<input id=\"f_l2\" value=\"${esc(img.l2)}\"></label>\n    <label>Image line 3<input id=\"f_l3\" value=\"${esc(img.l3)}\"></label>\n    <label style=\"flex-direction:row;align-items:center;justify-content:space-between;min-height:44px\">Attach the image<input type=\"checkbox\" id=\"f_img\" ${p.image ? \"checked\" : \"\"} style=\"width:22px;height:22px\"></label>\n    <button class=\"btn\" id=\"preview\">Preview map</button>\n    <div class=\"box\"><h2 style=\"margin:0\">Teach the bot this fix</h2>\n      <div class=\"small\">Saved as a correction the bot reads every run, like places.md. Example: heard \"GRACELAND\" on Lincoln County fire means Branchland.</div>\n      <label>Heard as<input id=\"c_heard\" placeholder=\"e.g. GRACELAND\"></label>\n      <label>Means<input id=\"c_means\" placeholder=\"e.g. Branchland (Lincoln County, WV)\"></label>\n      <label>Where it applies (optional)<input id=\"c_scope\" placeholder=\"e.g. Lincoln WV fire channels\"></label>\n    </div>\n    <button class=\"btn primary\" id=\"savefix\">Save and redraw</button>`;\n  let mode = img.mode;\n  const help = () => ($(\"#modehelp\").textContent = (MODES.find((x) => x[0] === mode) || [, , \"\"])[2]);\n  help();\n  document.querySelectorAll(\".seg button\").forEach((b) => (b.onclick = () => { mode = b.dataset.m; document.querySelectorAll(\".seg button\").forEach((x) => x.classList.toggle(\"on\", x === b)); help(); }));\n  const curImage = () => {\n    if (!$(\"#f_img\").checked) return null;\n    const o = { e: img.e || (labelPart || \"\").trim().split(\" \")[0], l1: $(\"#f_l1\").value, l2: $(\"#f_l2\").value, l3: $(\"#f_l3\").value, mode, q: $(\"#f_q\").value, lat: $(\"#f_lat\").value, lon: $(\"#f_lon\").value, z: $(\"#f_z\").value };\n    for (const k of Object.keys(o)) if (!String(o[k]).trim()) delete o[k];\n    return o;\n  };\n  $(\"#preview\").onclick = async () => {\n    const o = curImage();\n    if (!o) { toast(\"Turn on \\u201cAttach the image\\u201d first.\"); return; }\n    const btn = $(\"#preview\"); btn.disabled = true; btn.textContent = \"Drawing map\\u2026\"; $(\"#prev\").style.opacity = \".4\";\n    try {\n      const r = await fetch(imgSrc(o) + \"&t=\" + Date.now());\n      if (!r.ok) {\n        const t = await r.text(); let msg = t;\n        try { msg = JSON.parse(t).error || t; } catch {}\n        throw new Error(\"Couldn't draw the map: \" + String(msg).slice(0, 200));\n      }\n      const blob = await r.blob();\n      $(\"#prev\").src = URL.createObjectURL(blob);\n      if ($(\"#dl\")) $(\"#dl\").href = imgSrc(o);\n      toast(\"Preview updated\");\n    } catch (e) { toast(e.message, 8000); }\n    finally { btn.disabled = false; btn.textContent = \"Preview map\"; $(\"#prev\").style.opacity = \"1\"; }\n  };\n  $(\"#savefix\").onclick = async () => {\n    const newLines = lines.slice();\n    newLines[0] = [$(\"#f_label\").value.trim(), $(\"#f_place\").value.trim()].filter(Boolean).join(\" · \");\n    newLines[1] = [$(\"#f_loc\").value.trim(), datePart].filter(Boolean).join(\" · \");\n    try {\n      const heard = $(\"#c_heard\").value.trim(), means = $(\"#c_means\").value.trim();\n      if (heard && means) await api(\"corrections\", { heard, means, scope: $(\"#c_scope\").value.trim() });\n      await api(\"save\", { id: p.id, version: p.version, text: newLines.join(\"\\n\"), image: curImage(), image_set: true });\n      toast(\"Saved\"); location.hash = \"#post-\" + p.id;\n    } catch (e) { toast(e.message, 6000); }\n  };\n}\n\nasync function showFixes() {\n  setHeader(\"Bot fixes\", false, true);\n  const r = await api(\"corrections\");\n  $(\"#main\").innerHTML = `<div class=\"box\"><h2 style=\"margin:0\">Add a fix</h2>\n      <label>Heard as<input id=\"c_heard\" placeholder=\"e.g. GRACELAND\"></label>\n      <label>Means<input id=\"c_means\" placeholder=\"e.g. Branchland (Lincoln County, WV)\"></label>\n      <label>Where it applies (optional)<input id=\"c_scope\"></label>\n      <button class=\"btn\" id=\"add\">Save fix</button></div>` +\n    ((r.corrections || []).map((c) => `<div class=\"card\" style=\"cursor:default\"><div class=\"meta\" style=\"flex:1\"><span class=\"title\">${esc(c.heard)} → ${esc(c.means)}</span><span class=\"small\">${esc(c.scope || \"everywhere\")} · added ${esc(c.created)}</span></div><button class=\"btn danger\" data-del=\"${c.id}\" style=\"height:44px\">Remove</button></div>`).join(\"\") || `<div class=\"empty\">No fixes saved yet.</div>`);\n  $(\"#add\").onclick = async () => { try { await api(\"corrections\", { heard: $(\"#c_heard\").value, means: $(\"#c_means\").value, scope: $(\"#c_scope\").value }); toast(\"Saved\"); showFixes(); } catch (e) { toast(e.message); } };\n  document.querySelectorAll(\"[data-del]\").forEach((b) => (b.onclick = async () => { if (!confirm(\"Remove this fix?\")) return; await api(\"corrections/delete\", { id: Number(b.dataset.del) }); showFixes(); }));\n}\n\nasync function showPrayers(quiet, refresh, scan) {\n  const r = await api(\"prayers\" + (refresh ? \"?refresh=1\" : scan ? \"?scan=\" + scan : \"\"));\n  const sig = JSON.stringify(r); if (quiet && sig === state.prSig) return; state.prSig = sig;\n  setHeader(\"Prayer meter\", false, true);\n  const pct = (x) => (x.c ? Math.round((100 * x.p) / x.c) + \"% of comments\" : \"no comments yet\");\n  const stat = (label, x) => `<div class=\"box\" style=\"flex:1;align-items:center;gap:2px\"><div class=\"small\">${label}</div><div style=\"font-size:30px;font-weight:700\">🙏 ${x.p}</div><div class=\"small\">${pct(x)}</div></div>`;\n  $(\"#main\").innerHTML = `\n    <div class=\"row\">${stat(\"Today\", r.today)}${stat(\"7 days\", r.week)}</div>\n    ${stat(\"All time\", r.all)}\n    <h2>Most prayed for</h2>\n    ${(r.top || []).map((t, i) => `<div class=\"card\" style=\"cursor:default\"><div class=\"meta\"><span class=\"kicker\">#${i + 1} · ${esc(t.when)}</span><span class=\"title\">${esc(t.title)}</span><span class=\"small\">🙏 ${t.prayers} of ${t.comments} comments</span></div></div>`).join(\"\") || `<div class=\"empty\">No prayers counted yet.</div>`}\n    <h2>Prayers per post, by call type</h2>\n    ${(r.types || []).map((t) => `<div class=\"ver\">${esc(t.type)} · 🙏 ${(t.prayers / t.posts).toFixed(1)} per post · ${t.posts} post${t.posts === 1 ? \"\" : \"s\"}</div>`).join(\"\") || `<div class=\"small\">Nothing yet.</div>`}\n    <div class=\"small\">Last checked ${esc(r.last || \"never\")}. Counts only, no names or comment text are kept.</div>\n    <button class=\"btn\" id=\"prnow\">Check now</button>\n    <div class=\"box small\">${!r.scan ? \"All time counts posts from the last few days until you scan the Page's older posts.\"\n      : r.scan.running ? `Scanning older posts: ${r.scan.posts} so far${r.scan.oldest ? \", back to \" + esc(r.scan.oldest) : \"\"}. About 25 posts a minute; this page updates on its own.`\n      : `Scanned ${r.scan.posts} posts${r.scan.oldest ? \", back to \" + esc(r.scan.oldest) : \"\"}.`}\n      ${r.scan && r.scan.running ? `<button class=\"btn\" id=\"prscan\" data-a=\"stop\">Stop scanning</button>` : `<button class=\"btn\" id=\"prscan\" data-a=\"start\">${r.scan ? \"Scan again\" : \"Count all past posts\"}</button>`}</div>`;\n  $(\"#prscan\").onclick = async () => { const a = $(\"#prscan\").dataset.a; if (a === \"start\" && !confirm(\"Count prayers on every older post? It runs in the background, about 25 posts a minute.\")) return; try { await showPrayers(false, false, a); toast(a === \"start\" ? \"Scan started\" : \"Scan stopped\"); } catch (e) { toast(e.message, 6000); } };\n  $(\"#prnow\").onclick = async () => { $(\"#prnow\").disabled = true; try { await showPrayers(false, true); toast(\"Counted\"); } catch (e) { toast(e.message, 6000); $(\"#prnow\").disabled = false; } };\n}\n\nasync function showLogs(quiet) {\n  setHeader(\"Run logs\", false, true);\n  const r = await api(\"runlogs\");\n  const sig = JSON.stringify(r.runlogs || []); if (quiet && sig === state.logSig) return; state.logSig = sig;\n  $(\"#main\").innerHTML = (r.runlogs || []).map((l) => `<div class=\"log\">${esc(l.text)}</div>`).join(\"\") || `<div class=\"empty\">No run logs yet.</div>`;\n}\nroute();\n</script>\n</body>\n</html>\n";
