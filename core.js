// Pure league logic shared by the web app, the sync job and the tests. No DOM, no network.

export const TZ = "Africa/Cairo";
const HOUR = 3600e3, DAY = 24 * HOUR;

/* ---------- names and accounts ---------- */

// Same name written slightly differently maps to the same key.
export function normName(s) {
  return String(s == null ? "" : s)
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "") // harakat, tatweel
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

export function cleanName(s) {
  return String(s == null ? "" : s).normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function sha256hex(text) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Player id = first 32 hex chars of sha256(normalized name). Spaces and punctuation are ignored,
// so "عبد العزيز" and "عبدالعزيز" are the same player. The login email is derived from it.
export async function pidFor(name) {
  return (await sha256hex("tawaqoat:" + normName(name).replace(/[^\p{L}\p{N}]/gu, ""))).slice(0, 32);
}
export const emailFor = (pid, domain) => `${pid}@${domain}`;

/* ---------- digits and text ---------- */

export function westernDigits(s) {
  return String(s == null ? "" : s)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}
const BIDI = /[‎‏‪-‮⁦-⁩]/g;

/* ---------- scoring ---------- */

export const isGoal = (v) => Number.isInteger(v) && v >= 0 && v <= 30;

// 3 for the exact score, 1 for the right outcome, 0 otherwise. null when not scorable yet.
export function score(pick, m) {
  if (!Array.isArray(pick) || !isGoal(pick[0]) || !isGoal(pick[1])) return null;
  if (!m || !isGoal(m.hg) || !isGoal(m.ag)) return null;
  if (pick[0] === m.hg && pick[1] === m.ag) return 3;
  return Math.sign(pick[0] - pick[1]) === Math.sign(m.hg - m.ag) ? 1 : 0;
}

export const isFinal = (m) => m && m.st === "FINISHED" && isGoal(m.hg) && isGoal(m.ag);
export const isDead = (m) => m && (m.st === "CANCELLED" || m.st === "AWARDED_VOID");

// Points of every player for one round: p = points (doubles count twice), x = exact scores, o = right outcomes.
export function roundPoints(round, preds) {
  const adj = round.adj || {};
  const out = {};
  for (const [pid, pr] of Object.entries(preds || {})) {
    const picks = (pr && pr.picks) || {};
    const a = adj[pid] || {};                       // late entry: matches that don't count, no double
    const skip = new Set((a.skip || []).map(String));
    let p = 0, x = 0, o = 0;
    for (const m of round.matches || []) {
      if (!isFinal(m) || skip.has(String(m.id))) continue;
      const s = score(picks[m.id], m);
      if (s == null) continue;
      p += s * (m.dbl && !a.noDbl ? 2 : 1);
      if (s === 3) x++;
      if (s >= 1) o++;
    }
    out[pid] = { p, x, o };
  }
  return out;
}

// Nothing left in the round can change: every match finished, cancelled or postponed.
export const roundSettled = (r) => !!(r && (r.matches || []).length)
  && r.matches.every((m) => isFinal(m) || isDead(m) || m.st === "POSTPONED");

// The round's best: most points, then most exact scores; equal on both is shared. Nobody if nobody scored.
export function roundTop(points) {
  let best = null;
  for (const [pid, v] of Object.entries(points || {})) {
    if (!v || !(v.p > 0)) continue;
    if (!best || v.p > best.p || (v.p === best.p && v.x > best.x)) best = { p: v.p, x: v.x || 0, pids: [pid] };
    else if (v.p === best.p && v.x === best.x) best.pids.push(pid);
  }
  return best;
}

// The rarest exact score of the round: fewest people got it, then the most goals.
export function bestHit(round, preds) {
  const adj = round.adj || {};
  let best = null;
  for (const m of round.matches || []) {
    if (!isFinal(m)) continue;
    const pids = Object.entries(preds || {}).filter(([pid, pr]) => {
      const skip = (adj[pid] && adj[pid].skip || []).map(String);
      return !skip.includes(String(m.id)) && score(pr && pr.picks && pr.picks[m.id], m) === 3;
    }).map(([pid]) => pid);
    if (!pids.length) continue;
    const goals = m.hg + m.ag;
    if (!best || pids.length < best.pids.length || (pids.length === best.pids.length && goals > best.goals)) best = { mid: m.id, m, pids, goals };
  }
  return best;
}

// League table: points, then exact scores, then stars (times someone was the round's best).
function table(players, rounds, comp) {
  const list = Object.entries(players || {}).map(([pid, pl]) => ({
    pid, name: pl.name || "؟", claimed: !!pl.uid,
    p: (pl.start && Number(pl.start[comp])) || 0,
    x: (pl.startX && Number(pl.startX[comp])) || 0,
    s: 0, last: null,
  }));
  const byPid = new Map(list.map((r) => [r.pid, r]));
  const done = (rounds || []).filter((r) => r.comp === comp && r.points)
    .sort((a, b) => (a.lock || 0) - (b.lock || 0));
  for (const r of done) {
    for (const [pid, v] of Object.entries(r.points)) {
      const row = byPid.get(pid); if (!row) continue;
      row.p += v.p || 0; row.x += v.x || 0;
    }
    const top = roundSettled(r) ? roundTop(r.points) : null;
    if (top) for (const pid of top.pids) if (byPid.has(pid)) byPid.get(pid).s++;
  }
  const lastR = done.filter((r) => Object.keys(r.points).length).pop();
  if (lastR) for (const row of list) row.last = lastR.points[row.pid] ? lastR.points[row.pid].p : 0;
  list.sort((a, b) => b.p - a.p || b.x - a.x || b.s - a.s || a.name.localeCompare(b.name, "ar"));
  let rank = 0;
  list.forEach((row, i) => {
    const prev = list[i - 1];
    rank = prev && prev.p === row.p && prev.x === row.x && prev.s === row.s ? rank : i + 1;
    row.rank = rank;
  });
  return { rows: list, lastLabel: lastR ? lastR.label : null, done };
}

// Who climbed the most places because of this round (only people who played it). Ties: more round points.
export function roundRocket(players, rounds, comp, rid) {
  const mine = (rounds || []).filter((r) => r.comp === comp && r.points);
  const R = mine.find((r) => r.id === rid);
  if (!R || !roundSettled(R)) return null;
  const before = new Map(table(players, mine.filter((r) => (r.lock || 0) < (R.lock || 0)), comp).rows.map((r) => [r.pid, r.rank]));
  const after = table(players, mine.filter((r) => (r.lock || 0) <= (R.lock || 0)), comp).rows;
  let best = null;
  for (const row of after) {
    const pts = R.points[row.pid];
    if (!pts || !before.has(row.pid)) continue;
    const up = before.get(row.pid) - row.rank;
    if (up <= 0) continue;
    if (!best || up > best.up || (up === best.up && pts.p > best.p)) best = { up, p: pts.p, pids: [row.pid] };
    else if (up === best.up && pts.p === best.p) best.pids.push(row.pid);
  }
  return best;
}

export function standings(players, rounds, comp) {
  const t = table(players, rounds, comp);
  const lastDone = t.done.filter((r) => roundSettled(r) && Object.keys(r.points).length).pop();
  const top = lastDone ? roundTop(lastDone.points) : null;
  const rocket = lastDone ? roundRocket(players, rounds, comp, lastDone.id) : null;
  for (const row of t.rows) {
    row.star = !!(top && top.pids.includes(row.pid));
    row.rocket = !!(rocket && rocket.pids.includes(row.pid));
  }
  return { rows: t.rows, lastLabel: t.lastLabel, awardsLabel: lastDone ? lastDone.label : null };
}

const ALIAS = {
  manutd: "manunited", manchesterunited: "manunited", manchesterutd: "manunited", manu: "manunited",
  manchestercity: "mancity", nottinghamforest: "nottmforest", nottingham: "nottmforest", forest: "nottmforest",
  nforest: "nottmforest", nottmforestfc: "nottmforest",
  spurs: "tottenham", tottenhamhotspur: "tottenham", wolverhampton: "wolves", wolverhamptonwanderers: "wolves",
  brightonhovealbion: "brighton", brightonandhovealbion: "brighton", brightonhove: "brighton", westhamunited: "westham",
  newcastleunited: "newcastle", leedsunited: "leeds", ipswichtown: "ipswich", hullcity: "hull", coventrycity: "coventry",
  afcbournemouth: "bournemouth", palace: "crystalpalace", villa: "astonvilla", sunderlandafc: "sunderland",
  parissaintgermain: "psg", parissg: "psg", paris: "psg", intermilan: "inter", internazionale: "inter", fcinternazionalemilano: "inter",
  bayernmunich: "bayern", bayernmunchen: "bayern", fcbayernmunchen: "bayern", fcbayern: "bayern",
  borussiadortmund: "dortmund", bvb: "dortmund", bayerleverkusen: "leverkusen", bayer04leverkusen: "leverkusen",
  rbleipzig: "leipzig", atleticomadrid: "atletico", atleti: "atletico", clubatleticodemadrid: "atletico",
  fcbarcelona: "barcelona", barca: "barcelona", realmadridcf: "realmadrid",
  sportingcp: "sporting", sportinglisbon: "sporting", sportingclubedeportugal: "sporting", realbetis: "betis", realbetisbalompie: "betis",
  clubbrugge: "brugge", clubbruggekv: "brugge", psveindhoven: "psv", rclens: "lens", fcporto: "porto", sscnapoli: "napoli",
  asroma: "roma", shakhtardonetsk: "shakhtar", fcshakhtardonetsk: "shakhtar", slaviaprague: "slavia", slaviapraha: "slavia",
  skslaviapraha: "slavia", vfbstuttgart: "stuttgart", slovanbratislava: "slovan", skslovanbratislava: "slovan",
  aekathens: "aek", aekathensfc: "aek", lasklinz: "lask", linzask: "lask", sabahfk: "sabah", vikingfk: "viking",
  vikingstavanger: "viking", villarrealcf: "villarreal", losclille: "lille", losc: "lille", acmilan: "milan", juve: "juventus",
  fenerbahcesk: "fenerbahce", galatasaraysk: "galatasaray", feyenoordrotterdam: "feyenoord", bodoglimt: "bodo", fkbodoglimt: "bodo",
  olympiquedemarseille: "marseille", om: "marseille", asmonaco: "monaco", monacofc: "monaco", sscnapoli1926: "napoli",
  atalantabc: "atalanta", benfica: "benfica", slbenfica: "benfica", ajaxamsterdam: "ajax", afcajax: "ajax", celticfc: "celtic",
  como1907: "como", eintrachtfrankfurt: "frankfurt", qarabagagdam: "qarabag", qarabagfk: "qarabag",
};

export function canon(s) {
  const k = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o").replace(/æ/gi, "ae").replace(/ß/g, "ss").replace(/ı/g, "i").replace(/ç/gi, "c")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIAS[k] || k;
}

export function sameTeam(a, b) {
  const x = canon(a), y = canon(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length < y.length ? x : y, long = x.length < y.length ? y : x;
  return short.length >= 3 && long.startsWith(short);
}

// "Arsenal 2-1 Everton" lines -> picks for the round's matches (either team order works).
export function parsePicks(text, matches) {
  const filled = [], unmatched = [], used = new Set();
  const lines = westernDigits(text).replace(BIDI, "").replace(/[*_`]/g, "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-•·\d.)\s]+(?=\D)/, "");
    if (!/\d\s*[-–—:]\s*\d/.test(line)) continue;
    const mm = line.match(/^(.*?\D)\s*(\d{1,2})\s*[-–—:]\s*(\d{1,2})\s*(\D.*)$/);
    if (!mm) { unmatched.push(raw.trim()); continue; }
    const t1 = mm[1].trim(), g1 = Number(mm[2]), g2 = Number(mm[3]), t2 = mm[4].trim();
    let found = null;
    for (const m of matches || []) {
      if (used.has(m.id)) continue;
      const hs = [m.h, m.hn], as = [m.a, m.an];
      const is = (t, names) => names.some((n) => n && sameTeam(t, n));
      if (is(t1, hs) && is(t2, as)) { found = { mid: m.id, h: g1, a: g2 }; break; }
      if (is(t1, as) && is(t2, hs)) { found = { mid: m.id, h: g2, a: g1 }; break; }
    }
    if (found) { used.add(found.mid); filled.push(found); } else unmatched.push(raw.trim());
  }
  return { filled, unmatched };
}

// Pasted standings, one player per line: "محمد 72 9", "1. محمد - 72 - 9", "محمد: 72".
// The last number(s) are points and exact scores; a leading number is the rank.
export function parseStandings(text) {
  const rows = [], bad = [];
  for (const raw of westernDigits(text).replace(BIDI, "").split(/\r?\n/)) {
    const line = raw.replace(/[*_`]/g, " ").trim();
    if (!line) continue;
    const toks = line.split(/[\s:،,|\-–—/()]+/).filter(Boolean)
      .filter((t) => !/^(نقط[ةه]?|نقاط|pts?|points?)$/i.test(t));
    const nums = [];
    while (toks.length && /^\d+$/.test(toks[toks.length - 1]) && nums.length < 2) nums.unshift(Number(toks.pop()));
    if (toks.length > 1 && /^\d+\.?$/.test(toks[0])) toks.shift();
    const name = cleanName(toks.join(" "));
    if (!name || !nums.length || !/\p{L}/u.test(name)) { bad.push(raw.trim()); continue; }
    rows.push({ name, p: nums[0], x: nums.length > 1 ? nums[1] : null });
  }
  return { rows, bad };
}

/* ---------- time ---------- */

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const cairoDay = (ms) => dayFmt.format(new Date(ms)); // YYYY-MM-DD in Cairo

/* ---------- rounds from football-data.org ---------- */

const STAGE_AR = {
  PLAYOFFS: "الملحق", LAST_16: "دور الـ16", QUARTER_FINALS: "ربع النهائي",
  SEMI_FINALS: "نص النهائي", FINAL: "النهائي", LEAGUE_STAGE: "الجولة",
};
const LIVE = new Set(["IN_PLAY", "PAUSED", "LIVE"]);

// Result after 90 minutes (extra time and penalties don't count).
export function fdResult(m) {
  const s = m.score || {};
  const pick = (o) => (o && isGoal(o.home) && isGoal(o.away) ? { hg: o.home, ag: o.away } : null);
  if (s.duration && s.duration !== "REGULAR") return pick(s.regularTime) || pick(s.fullTime);
  return pick(s.fullTime);
}

// football-data's short names that are still too long for a phone screen
const DISPLAY = {
  "Wolverhampton": "Wolves", "Brighton Hove": "Brighton", "Leeds United": "Leeds", "Coventry City": "Coventry",
  "Ipswich Town": "Ipswich", "Hull City": "Hull", "Norwich City": "Norwich", "Swansea City": "Swansea", "Stoke City": "Stoke",
  "Bayern München": "Bayern", "Paris Saint-Germain": "PSG",
};
const display = (t) => { const n = (t && (t.shortName || t.name)) || "؟"; return DISPLAY[n] || n; };

function fdMatch(m) {
  const done = m.status === "FINISHED";
  const live = LIVE.has(m.status);
  const r = done || live ? fdResult(m) : null;
  return {
    id: String(m.id),
    h: display(m.homeTeam),
    a: display(m.awayTeam),
    hn: (m.homeTeam && m.homeTeam.name) || "",
    an: (m.awayTeam && m.awayTeam.name) || "",
    ko: Date.parse(m.utcDate),
    st: m.status || "SCHEDULED",
    hg: r ? r.hg : null,
    ag: r ? r.ag : null,
  };
}

// Groups a competition's season into league rounds. League matchdays keep their number;
// knockout stages split into legs by kickoff gaps of more than 4 days.
export function buildRounds(fdMatches, comp, startRound) {
  const rounds = new Map();
  const ko = [];
  for (const m of fdMatches || []) {
    const leagueish = !m.stage || m.stage === "REGULAR_SEASON" || m.stage === "LEAGUE_STAGE";
    if (leagueish && Number.isInteger(m.matchday)) {
      if (m.matchday < startRound) continue;
      const rid = `${comp}-${m.matchday}`;
      if (!rounds.has(rid)) rounds.set(rid, { rid, comp, n: m.matchday, label: `الجولة ${m.matchday}`, matches: [] });
      rounds.get(rid).matches.push(fdMatch(m));
    } else if (!leagueish) ko.push(m);
  }
  const byStage = new Map();
  for (const m of ko) { if (!byStage.has(m.stage)) byStage.set(m.stage, []); byStage.get(m.stage).push(m); }
  for (const [stage, list] of byStage) {
    list.sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
    const legs = [];
    for (const m of list) {
      const t = Date.parse(m.utcDate);
      const cur = legs[legs.length - 1];
      if (!cur || t - cur.last > 4 * DAY) legs.push({ items: [m], last: t }); else { cur.items.push(m); cur.last = t; }
    }
    legs.forEach((leg, i) => {
      const legName = stage === "FINAL" || legs.length === 1 ? "" : i === 0 ? " - ذهاب" : i === 1 ? " - إياب" : ` - ${i + 1}`;
      const rid = `${comp}-${stage}-${i + 1}`;
      rounds.set(rid, { rid, comp, n: null, stage, label: (STAGE_AR[stage] || stage) + legName, matches: leg.items.map(fdMatch) });
    });
  }
  for (const r of rounds.values()) {
    r.matches.sort((a, b) => a.ko - b.ko || a.h.localeCompare(b.h));
    r.first = Math.min(...r.matches.map((m) => m.ko));
  }
  return [...rounds.values()].sort((a, b) => a.first - b.first);
}

// Deadline = first kickoff that is still going ahead. Once passed it never moves.
export function lockFor(matches, prevLock, now) {
  if (prevLock && now >= prevLock) return prevLock;
  const live = (matches || []).filter((m) => m.st !== "POSTPONED" && !isDead(m) && Number.isFinite(m.ko));
  const pool = live.length ? live : (matches || []).filter((m) => Number.isFinite(m.ko));
  return pool.length ? Math.min(...pool.map((m) => m.ko)) : prevLock || null;
}

// Updates a stored round from fresh API data without losing doubles or manual results.
export function mergeRound(stored, fresh, now) {
  const old = new Map(((stored && stored.matches) || []).map((m) => [m.id, m]));
  const matches = fresh.matches.map((m) => {
    const o = old.get(m.id) || {};
    const manual = !!o.manual;
    return {
      ...m,
      dbl: !!o.dbl,
      ...(manual ? { hg: o.hg, ag: o.ag, st: o.st, manual: true } : {}),
    };
  });
  // keep any manually added match the API no longer lists
  for (const o of old.values()) if (o.manual && !matches.some((m) => m.id === o.id)) matches.push(o);
  const lock = lockFor(matches, stored && stored.lock, now);
  return { ...(stored || {}), comp: fresh.comp, n: fresh.n, label: fresh.label, matches, lock };
}

// One random double per Cairo match day (Champions League), chosen after the deadline.
export function pickDoubles(matches, rand = Math.random) {
  const days = new Map();
  for (const m of matches) {
    if (isDead(m) || m.st === "POSTPONED") continue;
    const d = cairoDay(m.ko);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(m.id);
  }
  const chosen = new Set();
  for (const ids of days.values()) chosen.add(ids[Math.floor(rand() * ids.length) % ids.length]);
  return matches.map((m) => ({ ...m, dbl: chosen.has(m.id) }));
}

export const roundDone = (r) => (r.matches || []).every((m) => isFinal(m) || isDead(m));

// Which reminder is due now for an open round: "d1" a day before, "h2" two hours before.
export function reminderDue(round, now) {
  if (!round.lock || now >= round.lock) return null;
  const left = round.lock - now, rem = round.rem || {};
  if (left <= 2 * HOUR + 10 * 60e3 && !rem.h2) return "h2";
  if (left <= DAY && left > 2 * HOUR + 10 * 60e3 && !rem.d1) return "d1";
  return null;
}

export function countPicks(picks, matches) {
  let n = 0;
  for (const m of matches || []) { const p = picks && picks[m.id]; if (Array.isArray(p) && isGoal(p[0]) && isGoal(p[1])) n++; }
  return n;
}
