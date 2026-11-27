# Weather mode (module of profiles/public-safety/RULES.md; read only when REFERENCE FILES says so)

WEATHER MODE (only when STORM_MODE is "on")
Goal: during storms, ice, snow or flooding, never post dozens of separate tree, line and road calls. They go into ONE roundup post instead. Everything else stays separate.
Weather level (per county), from get_work's weather (the Worker updates it whenever NWS watches or warnings change; none means every county is level 0):
- Level 0: no watch or warning. Level 1: a watch (Tornado, Severe Thunderstorm, Flood, Flash Flood, Winter Storm and similar). Level 2: a warning.
- Weather levels only change the threshold below. Never post anything about a watch or warning itself.
STORM CALLS: trees down, power lines or poles down or arcing, a road blocked by trees, debris, mud, rocks or water, high water or water over the road, a road closed for flooding, flooding of yards, basements or streets, and power outage reports.
WINTER STORM CALLS count the same way: slick, icy or snow-covered roads reported by a caller, unit or road crew; vehicles off the road, stuck or sliding because of snow or ice with no injuries; disabled or stuck vehicles blocking a road in snow or ice; road crews (DOH, county or city) requested to salt, plow or treat a road; a road closed for snow or ice.
- SLICK-ROAD MENTIONS COUNT: a unit or dispatcher saying roads are slick, icy or snow-covered in a county ("roads are getting slick out here", "use caution, black ice on KY 3") is a storm call for the tracker ("slick roads reported") even with no incident. Several in a county within 60 minutes can start winter mode before, or without, any NWS winter alert. Record each place once per hour; never put a mention alone in a post outside the roundup.
NEVER STORM CALLS (always their own posts, as usual): crashes with injuries, entrapment, a rollover, a pedestrian struck, or a road closed by the crash (a no-injury slide-off in snow or ice IS a winter storm call), structure and vehicle fires, a tree or line on an occupied home or vehicle with someone trapped or hurt, water rescues and vehicles in water, people trapped, evacuations ordered by officials, major route closures (an interstate or US route closed).
The 🌩️ STORM tracker:
- Whenever a run sees a storm call (an alert or a context entry, including ones the FILTER would otherwise skip, like a tree down with the road still open), record it in the tracker with storm_save {text: the whole tracker}: "🌩️ STORM · <status>", then one line per call: "<time> | <County, ST> | <location per LOCATION rules> | <what> | <open / cleared / road reopened>". Status is "watching" or "ACTIVE since <time>", plus "Roundup: post <id>" once one exists. The current tracker is get_work's storm_tracker; storm_save always replaces the whole text. With STORM_ROUNDUP "county", keep one section per county in the same tracker ("🌩️ STORM · Boyd County, KY · <status>").
- Storm mode starts in a county when the tracker shows at least STORM_THRESHOLD storm calls in that county within 60 minutes, using the threshold for its weather level (5 at level 0, 4 at level 1, 3 at level 2). Neighbouring counties join the same region roundup as soon as they reach their own threshold.
- Below the threshold, storm calls are handled one by one as usual (FILTER).
The roundup post (always a private draft first, never AUTO-POST):
  ⚠️ Storm Damage Calls · <REGION_NAME from LOCALRULES.md, or the county with STORM_ROUNDUP county>
  Multiple locations · <date and time storm mode started>

  <One or two sentences: crews in which counties are responding to multiple calls for trees and power lines down (or flooding) as the storm moves through. Present tense while active.>

  <County, ST>
  • <location>: <tree down / lines down / water over the road / vehicle off the road, no injuries / slick roads reported>, <road blocked or closed when said> (<time>)
  • <location>: <...>, cleared (<time>)

  <next county ...>

  <footer>
- Use 🌊 and "Flooding Calls" instead when most of the calls are water, and "⚠️ Winter Weather Calls" when most are winter road calls (the summary then says crews are responding to slide-offs, stuck vehicles and slick roads as the snow or ice moves through).
- One bullet per storm call, under its county, newest last, with locations written per LOCATION (blocks, intersections, routes; never a private address or a name). Mark "cleared", "road reopened" or "water receding" as traffic says. Never patient or resident details.
- ONE post for the whole event: every run that sees new storm traffic edits the same roundup (draft or published, with post_update) by adding or updating bullets and adjusting the summary. No UPDATE log lines: the bullets are the status. Never start a second roundup while one is open.
- Storm calls that already have their own DRAFT when storm mode starts are folded in: add them as bullets, then post_supersede each such draft {reason: "folded into the storm roundup"}. Storm calls already PUBLISHED stay as they are; add a bullet for them too.
- Ending: when no new storm call has come in for STORM_END_HOURS in any county of the roundup, switch the summary to past tense, add "UPDATE <time>: No new storm calls in the past <STORM_END_HOURS> hours.", and set the tracker status to "ENDED <time>". A storm after that starts a new tracker and roundup.
- Step 7 notes "STORM: <what changed>" (mode started, bullets added, folded drafts, ended).
