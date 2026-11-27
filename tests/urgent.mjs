const src = (await import("node:fs")).readFileSync("./worker.mjs","utf8");
const m = src.match(/const URGENT_ALERT = (.*);\n/); const re = eval(m[1]);
for (const t of ["STATION 93 RESPOND TO A STRUCTURE FIRE AT 1200 WINCHESTER","CAR VS DEER NO INJURIES","MEDIC 2 RESPOND CHEST PAIN","CALLER ADVISING SMOKE SHOWING FROM THE ROOF","ENTRAPMENT ON US 23","FIRE ALARM GENERAL","SHOTS FIRED ON 13TH STREET"]) console.log(re.test(t)?"URGENT ":"normal ", t);
