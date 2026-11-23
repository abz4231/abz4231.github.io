// The league's robot. GitHub Actions runs it every 30 minutes (.github/workflows/sync.yml):
// it pulls fixtures and results from football-data.org, keeps the rounds in Firestore up to date,
// scores locked rounds, picks the Champions League doubles, and sends the reminders.
// Secrets it needs: FD_TOKEN, ADMIN_NAME (or ADMIN_EMAIL), ADMIN_PASS, VAPID_PRIVATE.
import { pathToFileURL } from "node:url";
import { firebaseConfig, EMAIL_DOMAIN, VAPID_PUBLIC, COMPS } from "./config.js";
import * as C from "./core.js";

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
const DAY = 24 * 3600e3;

/* ---------- Firestore REST ---------- */

export class TS { constructor(ms) { this.ms = ms; } }
export const ts = (ms) => new TS(ms);

export function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof TS) return { timestampValue: new Date(v.ms).toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(enc) } : {} };
  if (typeof v === "object") return { mapValue: { fields: encFields(v) } };
  throw new Error(`can't store a ${typeof v}`);
}
export function encFields(o) {
  const f = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) f[k] = enc(v);
  return f;
}
export function dec(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if ("mapValue" in v) return decFields(v.mapValue.fields);
  return null;
}
export function decFields(f) {
  const o = {};
  for (const [k, v] of Object.entries(f || {})) o[k] = dec(v);
  return o;
}

export function firestore(token, fetchFn = fetch) {
  async function call(method, url, body) {
    const res = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = (data && data.error) || {};
      const e = new Error(`Firestore ${method} ${res.status} ${err.status || ""}: ${err.message || text.slice(0, 160)}`);
      e.status = res.status;
      e.code = err.status;
      throw e;
    }
    return data;
  }
  const out = (d) => ({ id: d.name.split("/").pop(), data: decFields(d.fields), updateTime: d.updateTime });
  return {
    async list(path) {
      const docs = [];
      let page = "";
      do {
        const data = await call("GET", `${FS_BASE}/${path}?pageSize=300${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
        for (const d of (data && data.documents) || []) docs.push(out(d));
        page = data && data.nextPageToken;
      } while (page);
      return docs;
    },
    // Writes only the named fields. updateTime / mustNotExist refuse the write if someone changed the doc meanwhile.
    async patch(path, fields, { updateTime, mustNotExist } = {}) {
      const q = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`);
      if (updateTime) q.push(`currentDocument.updateTime=${encodeURIComponent(updateTime)}`);
      if (mustNotExist) q.push("currentDocument.exists=false");
      return call("PATCH", `${FS_BASE}/${path}?${q.join("&")}`, { fields: encFields(fields) });
    },
  };
}

/* ---------- outside services ---------- */

export async function signIn(email, password, fetchFn = fetch) {
  const res = await fetchFn(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.idToken) {
    throw new Error(`admin sign-in failed (${(data.error && data.error.message) || res.status}). Check the ADMIN_NAME and ADMIN_PASS secrets.`);
  }
  return { token: data.idToken, uid: data.localId };
}

export async function fetchMatches(code, token, fetchFn = fetch) {
  const res = await fetchFn(`https://api.football-data.org/v4/competitions/${code}/matches`, { headers: { "X-Auth-Token": token } });
  if (!res.ok) {
    const why = res.status === 429 ? "too many requests" : res.status === 403 || res.status === 400 ? "check FD_TOKEN" : "";
    throw new Error(`football-data ${code} ${res.status}${why ? ` (${why})` : ""}`);
  }
  const data = await res.json();
  return data.matches || [];
}

/* ---------- wording ---------- */

const LOCALE = "ar-EG-u-nu-latn";
const fWhen = new Intl.DateTimeFormat(LOCALE, { timeZone: C.TZ, weekday: "long", hour: "numeric", minute: "2-digit" });
const fTime = new Intl.DateTimeFormat(LOCALE, { timeZone: C.TZ, hour: "numeric", minute: "2-digit" });
const pointsWord = (n) => (n === 1 ? "نقطة واحدة" : n === 2 ? "نقطتين" : n >= 3 && n <= 10 ? `${n} نقط` : `${n} نقطة`);
const known = (m) => m.h && m.h !== "؟" && m.a && m.a !== "؟";
// Firestore may hand fields back in any order, so compare with keys sorted at every level.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a == null ? null : a)) === JSON.stringify(canon(b == null ? null : b));

/* ---------- one run ---------- */

export async function run({ env, fetchFn = fetch, sendPush = null, now = Date.now(), rand = Math.random, log = () => {} }) {
  const email = env.ADMIN_EMAIL || C.emailFor(await C.pidFor(env.ADMIN_NAME || ""), EMAIL_DOMAIN);
  const { token } = await signIn(email, env.ADMIN_PASS, fetchFn);
  const fs = firestore(token, fetchFn);
  const notes = [];
  const problems = [];
  const report = { written: [], reminders: 0, results: 0 };

  try {
    const stored = new Map((await fs.list("rounds")).map((d) => [d.id, d]));
    const rounds = new Map([...stored.values()].map((d) => [d.id, { id: d.id, ...d.data }]));
    const writes = new Map();
    const queue = (rid, fields) => {
      writes.set(rid, { ...(writes.get(rid) || {}), ...fields });
      Object.assign(rounds.get(rid), fields);
    };

    // 1. fixtures and results
    for (const [comp, cfg] of Object.entries(COMPS)) {
      let list;
      try { list = await fetchMatches(cfg.fd, env.FD_TOKEN, fetchFn); } catch (e) { problems.push(e.message); continue; }
      for (const fresh of C.buildRounds(list, comp, cfg.startRound)) {
        const prev = stored.has(fresh.rid) ? stored.get(fresh.rid).data : null;
        const merged = C.mergeRound(prev, fresh, now);
        merged.first = fresh.first;
        if (fresh.stage) merged.stage = fresh.stage;
        if (!rounds.has(fresh.rid)) rounds.set(fresh.rid, { id: fresh.rid });
        const changed = {};
        for (const k of ["comp", "n", "label", "stage", "first", "lock", "matches"]) {
          if (merged[k] !== undefined && (!prev || !same(prev[k], merged[k]))) changed[k] = merged[k];
        }
        if (Object.keys(changed).length) queue(fresh.rid, changed);
      }
    }

    // 2. doubles: once a round has locked, one random match per match day counts twice
    for (const r of rounds.values()) {
      const cfg = COMPS[r.comp];
      if (!cfg || !cfg.doubles || !r.lock || now < r.lock || r.dblSet || !Array.isArray(r.matches)) continue;
      const chosenByHand = r.matches.some((m) => m.dbl);
      queue(r.id, { matches: chosenByHand ? r.matches : C.pickDoubles(r.matches, rand), dblSet: true });
      if (!chosenByHand) notes.push(`${cfg.short} ${r.label}: الدابل اتختار`);
    }

    // 3. points for rounds that have locked
    for (const r of rounds.values()) {
      if (!r.lock || now < r.lock || !Array.isArray(r.matches)) continue;
      if (r.done && !(writes.get(r.id) || {}).matches) continue;
      const preds = Object.fromEntries((await fs.list(`rounds/${r.id}/preds`)).map((d) => [d.id, d.data]));
      const points = C.roundPoints(r, preds);
      const done = C.roundDone(r);
      const f = {};
      if (!same(points, r.points || {})) f.points = points;
      if (!!r.done !== done) f.done = done;
      if (Object.keys(f).length) queue(r.id, f);
    }

    // 4. save, refusing to overwrite a change the admin made in the app meanwhile
    const skipped = new Set();
    for (const [rid, fields] of writes) {
      const old = stored.get(rid);
      const data = { ...fields };
      if ("lock" in data) data.lock = data.lock == null ? null : ts(data.lock);
      try {
        await fs.patch(`rounds/${rid}`, data, old ? { updateTime: old.updateTime } : { mustNotExist: true });
        report.written.push(rid);
      } catch (e) {
        if (e.code === "FAILED_PRECONDITION" || e.code === "ALREADY_EXISTS" || e.status === 409) { skipped.add(rid); log(`${rid} changed meanwhile, next run`); }
        else throw e;
      }
    }

    // 5. reminders and round results
    const live = [...rounds.values()].filter((r) => !skipped.has(r.id) && Array.isArray(r.matches) && r.matches.length && COMPS[r.comp]);
    const due = live.map((r) => ({ r, kind: C.reminderDue(r, now) })).filter((x) => x.kind && x.r.matches.every(known));
    const finished = live.filter((r) => r.lock && now >= r.lock && !(r.rem && r.rem.res) && C.roundSettled(r) && r.matches.some(C.isFinal));
    if (due.length || finished.length) {
      const players = Object.fromEntries((await fs.list("players")).map((d) => [d.id, d.data]));
      const pushes = Object.fromEntries((await fs.list("push")).map((d) => [d.id, d.data]));
      const cleaned = new Map();
      const notify = async (pid, payload) => {
        const subs = { ...((cleaned.get(pid) || pushes[pid] || {}).subs || {}) };
        if (!sendPush || !Object.keys(subs).length) return 0;
        let ok = 0, dead = false;
        for (const [k, sub] of Object.entries(subs)) {
          try { await sendPush(sub, JSON.stringify(payload)); ok++; } catch (e) {
            if (e.statusCode === 404 || e.statusCode === 410) { delete subs[k]; dead = true; } else log(`push to ${pid} failed: ${e.statusCode || e.message}`);
          }
        }
        if (dead) cleaned.set(pid, { subs });
        return ok ? 1 : 0;
      };

      for (const { r, kind } of due) {
        const cfg = COMPS[r.comp];
        const subs = Object.fromEntries((await fs.list(`rounds/${r.id}/subs`)).map((d) => [d.id, d.data]));
        const N = r.matches.filter((m) => !C.isDead(m)).length;
        const at = kind === "h2" ? `الساعة ${fTime.format(r.lock)}` : fWhen.format(r.lock);
        let sent = 0;
        for (const [pid, p] of Object.entries(players)) {
          if (!p.uid) continue;
          const n = subs[pid] ? Number(subs[pid].n) || 0 : 0;
          if (n >= N) continue;
          sent += await notify(pid, {
            title: `${kind === "h2" ? "⏰ " : ""}${cfg.short}: ${r.label} بتقفل ${at}`,
            body: n ? `توقعت ${n} من ${N} بس. كمّل قبل أول ماتش.` : "لسه ما توقعتش. ادخل توقّع قبل أول ماتش.",
            url: `./?tab=predict&comp=${r.comp}`,
            tag: `rem-${r.id}`,
          });
        }
        await fs.patch(`rounds/${r.id}`, { rem: { ...(r.rem || {}), d1: true, ...(kind === "h2" ? { h2: true } : {}) } });
        report.reminders += sent;
        notes.push(`${cfg.short} ${r.label}: تنبيه ${kind === "h2" ? "الساعتين" : "اليوم"} راح لـ ${sent}`);
      }

      for (const r of finished) {
        const cfg = COMPS[r.comp];
        const lastKo = Math.max(...r.matches.map((m) => m.ko).filter(Number.isFinite));
        let sent = 0;
        if (now - lastKo < 3 * DAY && Object.keys(r.points || {}).length) {
          const compRounds = [...rounds.values()].filter((x) => x.comp === r.comp);
          const table = C.standings(players, compRounds, r.comp);
          const top = C.roundTop(r.points || {});
          const rocket = C.roundRocket(players, compRounds, r.comp, r.id);
          const nm = (pids) => pids.map((pid) => (players[pid] && players[pid].name) || "؟").join(" و");
          const awards = [top ? `⭐ النجم: ${nm(top.pids)} (${pointsWord(top.p)})` : "", rocket ? `🚀 الصاروخ: ${nm(rocket.pids)} (+${rocket.up})` : ""].filter(Boolean).join(" · ");
          for (const [pid, p] of Object.entries(players)) {
            if (!p.uid || (pushes[pid] && pushes[pid].results === false)) continue;
            const mine = r.points && r.points[pid];
            const row = table.rows.find((x) => x.pid === pid);
            const me = mine ? `جبت ${pointsWord(mine.p)}${mine.x ? ` (${mine.x} مظبوطة)` : ""}. انت رقم ${row ? row.rank : "؟"} من ${table.rows.length}.` : "ما توقعتش الجولة دي.";
            sent += await notify(pid, {
              title: `${cfg.short}: ${r.label} خلصت`,
              body: awards ? `${awards}\n${me}` : me,
              url: `./?tab=results&comp=${r.comp}`,
              tag: `res-${r.id}`,
            });
          }
        }
        await fs.patch(`rounds/${r.id}`, { rem: { ...(r.rem || {}), res: true } });
        report.results += sent;
        notes.push(`${cfg.short} ${r.label} خلصت`);
      }

      for (const [pid, { subs }] of cleaned) await fs.patch(`push/${pid}`, { subs });
    }
  } catch (e) {
    problems.push(e.message);
    await fs.patch("config/sync", { at: ts(now), ok: false, msg: problems.join(" · ").slice(0, 400) }).catch(() => {});
    throw e;
  }

  const msg = [...problems, ...notes].join(" · ").slice(0, 400);
  await fs.patch("config/sync", { at: ts(now), ok: !problems.length, msg });
  return { ...report, ok: !problems.length, msg };
}

/* ---------- command line ---------- */

async function main() {
  const env = process.env;
  for (const k of ["FD_TOKEN", "ADMIN_PASS"]) if (!env[k]) throw new Error(`secret ${k} is missing`);
  if (!env.ADMIN_NAME && !env.ADMIN_EMAIL) throw new Error("secret ADMIN_NAME is missing");
  let sendPush = null;
  if (env.VAPID_PRIVATE) {
    const webpush = (await import("web-push")).default;
    const site = `https://${(env.GITHUB_REPOSITORY_OWNER || "tawaqoat").toLowerCase()}.github.io/`;
    webpush.setVapidDetails(site, VAPID_PUBLIC, env.VAPID_PRIVATE.trim());
    sendPush = (sub, payload) => webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 6 * 3600, urgency: "high" });
  } else console.log("VAPID_PRIVATE missing: no notifications this run");
  const res = await run({ env, sendPush, log: console.log });
  console.log(JSON.stringify(res));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
