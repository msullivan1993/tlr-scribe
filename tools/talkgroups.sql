-- Every system and talkgroup configured in TLR, with the refs the scribe matches on.
-- Read-only (two small config tables; never touches calls). Run in psql connected to thinline_radio,
-- ideally as the read-only role. Writes C:\temp\talkgroups.csv (create C:\temp first).
-- Then: py tools\fetch_channels.py --from C:\temp\talkgroups.csv --fill
\copy (SELECT s."label" AS system, t."label" AS label, t."name" AS name, s."systemRef" AS system_ref, t."talkgroupRef" AS talkgroup_ref FROM "talkgroups" t JOIN "systems" s ON s."systemId" = t."systemId" ORDER BY 1, 2) TO 'C:/temp/talkgroups.csv' WITH (FORMAT csv, HEADER)
