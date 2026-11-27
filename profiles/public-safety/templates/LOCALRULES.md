# LOCALRULES.md: this page's coverage, settings and local notes

RULES.md (profiles/public-safety/RULES.md) is the shared rulebook, the same for every page that uses TLR Scribe. This file holds what is specific to YOUR page. The run reads both; where they differ, this file wins. Settings named here are the ones RULES.md refers to.

PAGE
- PROFILE: public-safety
- PAGE_NAME: Example Scanner Page
- REGION_NAME: Example Area   (used in storm roundup headers)
- SITE_ADDRESS: scanner.example.com   (written exactly like this in posts: never with https://, http:// or www.)
- FOOTER (two lines, copied character for character at the end of every post):
  Information is from live scanner transcriptions and may not be complete or accurate.
  🎧 Listen to live scanner traffic and receive alerts ➜ scanner.example.com

COVERAGE
- Counties: <County, ST>; <County, ST>; ...   (the systems and channels are in channels.csv and systems.csv)
- Air medical channels that serve these counties, if any.
- Counties with the same name in different states are different counties: never confuse or combine them.

STATE POLICE (modules/state-police.md; for rules of your own, write a local/state-police.md instead)
- <Agency and post/troop>: covers <counties>.

AIRPORTS (modules/airport.md)
- <System / talkgroup label>: <Airport name>; place "<Airport name, County, ST>".

MUTUAL AID PARTNERS (hints for RULES.md MUTUAL AID)
- <Department> often assists <department or town>.

PLACE NOTES
- Per-state or per-county place rules beyond places.md (for example: "Ohio: use the city, village or town when named, otherwise the township").

DAILY TESTS (RULES.md FILTER, pager tests)
- <County>: tone test around <time>. Real calls still go out at those times.

SETTINGS
- AUTO_POST: off   (off = every incident is a private draft, nothing is ever scheduled; on = AUTO-POST may schedule posts)
- AUTO_POST_DELAY_MINUTES: 5   (an auto-post is published this many minutes after it is created, so you can hold or edit it on the review page)
- DRAFT_ONLY_COUNTIES: none   (incidents in these counties are never auto-posted)
- IMAGES: drafts   (off = no map images; drafts = map image on new private drafts only; all = also on new auto-posts)
- STORM_MODE: on   (off = storm calls are always handled one by one)
- STORM_ROUNDUP: region   (region = one storm roundup post for every affected county; county = a separate roundup per county)
- STORM_THRESHOLD: 5 / 4 / 3   (storm calls in one county within 60 minutes that start storm mode at weather level 0 / 1 / 2)
- STORM_END_HOURS: 2   (storm mode ends this long after the last storm call)

CATEGORIES (what each kind of incident does on this page; RULES.md FILTER says what each one covers)
post = a private draft for review · auto = a draft that may auto-post when AUTO-POST's conditions are met · skip = never posted
- structure_fire: post      (set to auto to let confirmed working fires auto-post)
- vehicle_fire: post
- brush_fire: post
- outdoor_burn: skip        (burns are still posted when spreading or threatening a structure: BURNS)
- smoke_investigation: post
- gas_leak_hazmat: post
- wires_trees_down: post    (storm mode rolls these into one post)
- transformer_arcing: post
- crash_injury: post
- crash_fire_ems: post      (non-injury crashes that fire or EMS are sent to)
- crash_law_only: skip      (unless the road is blocked or closed for a while)
- rescue: post
- missing_search: post
- fight_disturbance: post
- burglary_breakin: post
- robbery: post
- shooting_stabbing: post
- weapons_complaint: post
- pursuit: post
- road_closure: post
- public_alert: post
- airport_alert: post

SENSITIVE CATEGORIES: off by default. An owner may switch one to post, but you are responsible for what your page publishes, including the privacy of the people involved, your scanner sources' terms, and the laws where you are.
- medical: skip              (medical details still appear as updates to a posted incident, e.g. "one patient was transported")
- domestic: skip
- overdose: skip
- mental_health: skip
- death_investigation: skip
- runaway: skip

LOCKED (never posted on any page, and not a setting): suicide or self-harm, sexual offenses, child abuse, juvenile suspects.
