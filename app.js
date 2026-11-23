// دوري التوقعات: everything on screen. League rules live in core.js, data access in fb.js.
import { firebaseConfig, EMAIL_DOMAIN, VAPID_PUBLIC, COMPS } from "./config.js";
import * as C from "./core.js";
import * as F from "./fb.js";

window.__appStarted = true;

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const local = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const now = () => Date.now();
const COMP_KEYS = Object.keys(COMPS);
const TABS = ["predict", "results", "table", "admin", "me"];
const MIN_PASS = 6;

const LOCALE = "ar-EG-u-nu-latn";
const fDay = new Intl.DateTimeFormat(LOCALE, { timeZone: C.TZ, weekday: "long", day: "numeric", month: "long" });
const fTime = new Intl.DateTimeFormat(LOCALE, { timeZone: C.TZ, hour: "numeric", minute: "2-digit" });
const fShort = new Intl.DateTimeFormat(LOCALE, { timeZone: C.TZ, day: "numeric", month: "short" });
const when = (ms) => `${fDay.format(ms)} · ${fTime.format(ms)}`;

function count(n, one, two, few, many) {
  return n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
}
const days = (n) => count(n, "يوم", "يومين", "أيام", "يوم");
const hours = (n) => count(n, "ساعة", "ساعتين", "ساعات", "ساعة");
const mins = (n) => count(n, "دقيقة", "دقيقتين", "دقايق", "دقيقة");
const games = (n) => count(n, "ماتش واحد", "ماتشين", "ماتشات", "ماتش");
const ptsWord = (n) => count(n, "نقطة واحدة", "نقطتين", "نقط", "نقطة");
const placesWord = (n) => count(n, "مركز واحد", "مركزين", "مراكز", "مركز");

function leftText(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "أقل من دقيقة";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d >= 2) return days(d);
  if (d === 1) return h ? `${days(1)} و${hours(h)}` : days(1);
  if (h) return mm ? `${hours(h)} و${mins(mm)}` : hours(h);
  return mins(mm);
}
function agoText(ms) {
  const m = Math.floor((now() - ms) / 60000);
  if (m < 1) return "دلوقتي";
  if (m < 60) return `من ${mins(m)}`;
  const h = Math.floor(m / 60);
  return h < 24 ? `من ${hours(h)}` : `من ${days(Math.floor(h / 24))}`;
}

/* ---------- state ---------- */

const url = new URLSearchParams(location.search);
const compOr = (v) => (COMP_KEYS.includes(v) ? v : null);
const S = {
  user: undefined, pid: null, busy: false, finishErr: "",
  owner: undefined, players: {}, playersReady: false, playersErr: false,
  rounds: [], roundsReady: false,
  comp: compOr(url.get("comp")) || compOr(local.get("comp")) || "PL",
  tab: TABS.includes(url.get("tab")) ? url.get("tab") : "predict",
  sel: {}, mine: {}, drafts: {}, subs: {}, preds: {}, open: {}, more: {},
  push: undefined, devKey: null, pushBusy: false, sync: undefined,
  form: {}, auth: { step: "pick", pid: null, err: "" },
  adm: { rid: null, edit: null, seed: null, seedBad: [], armed: null },
  pasteOpen: false, pasteMiss: [], saving: false, installEvt: null, nextLock: null,
};
if (url.has("tab") || url.has("comp")) history.replaceState(null, "", location.pathname);

/* ---------- derived data ---------- */

const me = () => (S.pid && S.players[S.pid]) || null;
const ready = () => !!(S.user && me() && me().uid === S.user.uid);
const isMain = () => !!(S.user && S.owner && S.owner.uid === S.user.uid);
const isOwner = () => isMain() || !!(S.user && S.owner && Array.isArray(S.owner.admins) && S.owner.admins.includes(S.user.uid));
const nameOf = (pid) => (S.players[pid] && S.players[pid].name) || "لاعب اتمسح";
const byName = (a, b) => String(a.name).localeCompare(String(b.name), "ar");
const playerList = () => Object.entries(S.players).map(([pid, p]) => ({ pid, ...p, name: p.name || "؟" })).sort(byName);

const roundById = (rid) => S.rounds.find((r) => r.id === rid) || null;
const known = (m) => m.h && m.h !== "؟" && m.a && m.a !== "؟";
const activeMatches = (r) => r.matches.filter((m) => !C.isDead(m));
const compRounds = (comp) => S.rounds.filter((r) => r.comp === comp && Array.isArray(r.matches) && r.matches.length && r.lock);
const openRounds = (comp) => compRounds(comp).filter((r) => r.lock > now() && r.matches.every(known))
  .sort((a, b) => a.lock - b.lock).slice(0, 3);
const lockedRounds = (comp) => compRounds(comp).filter((r) => r.lock <= now()).sort((a, b) => b.lock - a.lock);
function selectedOpen(comp) {
  const list = openRounds(comp);
  return list.find((r) => r.id === S.sel[comp]) || list[0] || null;
}
const isOpen = (rid, i) => (S.open[rid] !== undefined ? S.open[rid] : i === 0);
const livePoints = (r) => (S.preds[r.id] ? C.roundPoints(r, S.preds[r.id]) : r.points || null);
function nextLock() {
  const t = now();
  let best = null;
  for (const r of S.rounds) if (r.lock > t && (best == null || r.lock < best)) best = r.lock;
  return best;
}

// Score boxes show the unsaved draft if there is one, otherwise what is saved.
const savedPicks = (rid) => (S.mine[rid] && S.mine[rid].picks) || {};
function cell(rid, mid, i) {
  const sp = savedPicks(rid)[mid];
  const sv = Array.isArray(sp) && C.isGoal(sp[i]) ? sp[i] : null;
  const d = S.drafts[rid] && S.drafts[rid][mid];
  if (d && d[i] !== undefined) return { v: d[i], dirty: d[i] !== sv, saved: sv != null };
  return { v: sv, dirty: false, saved: sv != null };
}
function dirtyCount(rid) {
  const r = roundById(rid);
  if (!r) return 0;
  return r.matches.filter((m) => cell(rid, m.id, 0).dirty || cell(rid, m.id, 1).dirty).length;
}
const anyDirty = () => Object.keys(S.drafts).some((rid) => roundById(rid) && roundById(rid).lock > now() && dirtyCount(rid) > 0);
function setDraft(rid, mid, i, v) {
  S.drafts[rid] = S.drafts[rid] || {};
  const d = S.drafts[rid][mid] || [undefined, undefined];
  d[i] = v;
  S.drafts[rid][mid] = d;
}

/* ---------- messages ---------- */

const ERRS = {
  "auth/invalid-credential": "الاسم أو الباسورد غلط",
  "auth/invalid-login-credentials": "الاسم أو الباسورد غلط",
  "auth/wrong-password": "الباسورد غلط",
  "auth/user-not-found": "الاسم ده مش متسجل",
  "auth/too-many-requests": "محاولات كتير ورا بعض. استنى شوية وجرّب تاني",
  "auth/network-request-failed": "النت فاصل. اتأكد من النت وجرّب تاني",
  "auth/weak-password": "الباسورد قصير. لازم 6 حروف أو أرقام على الأقل",
  "auth/email-already-in-use": "الاسم ده متسجل قبل كده. لو ده انت، ادخل بالباسورد بتاعك",
  "auth/operation-not-allowed": "الدخول بالباسورد مش متفعّل في Firebase",
  "auth/requires-recent-login": "اخرج وادخل تاني، وبعدين غيّر الباسورد",
  "linked-other": "الاسم ده مربوط بحساب تاني. كلّم المشرف يفك الربط",
  "permission-denied": "مفيش صلاحية للخطوة دي",
  "unavailable": "النت فاصل. جرّب تاني",
  "deadline-exceeded": "النت بطيء. جرّب تاني",
  "sw-missing": "ملف الإشعارات (sw.js) مش موجود على الموقع",
};
const errText = (e) => ERRS[F.errCode(e)] || `حصلت مشكلة (${F.errCode(e)})`;

let toastTimer;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 4200 : 2800);
}

/* ---------- rendering ---------- */

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; paint(); });
}
function paint() {
  const view = $("#view");
  const ae = document.activeElement;
  const k = ae && view.contains(ae) && ae.dataset ? ae.dataset.k : null;
  let sel = null;
  try { if (k && typeof ae.selectionStart === "number") sel = [ae.selectionStart, ae.selectionEnd]; } catch { /* no selection */ }
  view.innerHTML = body();
  chrome();
  if (k) {
    const el = view.querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text box */ }
    }
  }
  S.nextLock = nextLock();
  watchers();
}

function chrome() {
  const ok = ready();
  const meBtn = $("#me-btn");
  meBtn.hidden = !ok;
  if (ok) { meBtn.textContent = me().name; meBtn.setAttribute("aria-pressed", String(S.tab === "me")); }
  const seg = $("#seg");
  seg.hidden = !ok || S.tab === "me";
  for (const b of $$("button", seg)) b.setAttribute("aria-pressed", String(b.dataset.comp === S.comp));
  $("#bar").hidden = !ok;
  if (ok) {
    const tabs = [["predict", "توقّع"], ["results", "النتايج"], ["table", "الترتيب"]];
    if (isOwner()) tabs.push(["admin", "الإدارة"]);
    $("#tabs").innerHTML = tabs.map(([k, label]) =>
      `<button type="button" role="tab" data-act="tab" data-tab="${k}" aria-selected="${S.tab === k}">${label}</button>`).join("");
  }
  updateSavebar();
}

function updateSavebar() {
  const bar = $("#savebar");
  const r = ready() && S.tab === "predict" ? selectedOpen(S.comp) : null;
  const n = r ? dirtyCount(r.id) : 0;
  bar.hidden = !n;
  if (!n) return;
  $("#savebar-msg").textContent = `عدّلت ${games(n)} ولسه ما حفظتش`;
  const btn = $("#savebar-btn");
  btn.dataset.rid = r.id;
  btn.disabled = S.saving;
  btn.textContent = S.saving ? "بيتحفظ…" : "احفظ التوقعات";
}

const card = (inner, cls = "") => `<section class="card ${cls}">${inner}</section>`;
const pitchIcon = `<svg class="pitch-ic" viewBox="0 0 64 44" aria-hidden="true"><rect x="2" y="2" width="60" height="40" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><line x1="32" y1="2" x2="32" y2="42" stroke="currentColor" stroke-width="2"/><circle cx="32" cy="22" r="7" fill="none" stroke="currentColor" stroke-width="2"/><rect x="2" y="13" width="9" height="18" fill="none" stroke="currentColor" stroke-width="2"/><rect x="53" y="13" width="9" height="18" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const empty = (title, text, extra = "") => card(`${pitchIcon}<h3>${title}</h3><p>${text}</p>${extra}`, "empty");
const loading = (text = "بنحمّل الدوري") => card(`${pitchIcon.replace('class="pitch-ic"', 'class="pitch-ic pulse"')}<h3>${text}</h3><p>ثانية واحدة.</p>`, "empty");

function body() {
  if (S.user === undefined) return loading();
  if (!S.user) return S.busy ? loading("بنجهز حسابك") : authView();
  if (S.playersErr && !Object.keys(S.players).length) return card("مش قادر أقرا أسماء اللاعيبة. المشرف يراجع قواعد Firestore.", "notice bad");
  if (!S.playersReady || !S.roundsReady) return loading();
  if (!ready()) return finishView();
  const top = S.owner === null ? card(`<b>التطبيق لسه ملوش مشرف.</b> لو انت منظّم الدوري، دوس الزرار ده عشان تبقى المشرف وتقدر تضيف النقط اللي فاتت وتعدّل النتايج.
    <div class="actions"><button type="button" class="btn" data-act="claim-owner">أنا المشرف</button></div>`, "notice") : "";
  const rounds = S.roundsErr ? card(`مش قادر أقرا الجولات (${esc(S.roundsErr)}). لو المشكلة فضلت، المشرف يراجع قواعد Firestore.`, "notice bad") : "";
  switch (S.tab) {
    case "results": return top + rounds + resultsView();
    case "table": return top + rounds + tableView();
    case "admin": return isOwner() ? top + adminView() : top + rounds + predictView();
    case "me": return top + meView();
    default: return top + rounds + predictView();
  }
}

/* ---------- sign in ---------- */

function authView() {
  const a = S.auth;
  const err = a.err ? `<p class="err" role="alert">${esc(a.err)}</p>` : "";
  const back = `<button type="button" class="link" data-act="auth-step" data-step="pick">رجوع</button>`;
  const pass = (k, label, ac) => `<div class="field"><label for="${k}">${label}</label><input class="inp" id="${k}" type="password" autocomplete="${ac}" data-k="${k}" data-keep value="${esc(S.form[k] || "")}" required></div>`;
  const nameRO = (name) => `<div class="field"><label for="auth-user">الاسم</label><input class="inp" id="auth-user" autocomplete="username" readonly value="${esc(name)}"></div>`;
  const picked = a.pid && S.players[a.pid];

  if (a.step === "login" && picked) {
    return card(`<div class="card-h"><div><span class="eyebrow">تسجيل الدخول</span><h2>أهلاً يا ${esc(picked.name)}</h2></div></div>
      <form class="stack" data-form="login">${nameRO(picked.name)}${pass("auth-pass", "الباسورد", "current-password")}
      <button type="submit" class="btn wide">دخول</button></form>${err}
      <p class="hint">نسيت الباسورد؟ كلّم المشرف يفك ربط اسمك، وبعدها تختار باسورد جديد.</p><div class="actions">${back}</div>`, "auth");
  }
  if (a.step === "claim" && picked) {
    return card(`<div class="card-h"><div><span class="eyebrow">أول مرة تدخل</span><h2>أهلاً يا ${esc(picked.name)}</h2></div></div>
      <p class="muted sm">اختار باسورد تدخل بيه بعد كده. ${MIN_PASS} حروف أو أرقام على الأقل.</p>
      <form class="stack" data-form="claim">${nameRO(picked.name)}${pass("auth-pass", "الباسورد", "new-password")}${pass("auth-pass2", "اكتبه تاني", "new-password")}
      <button type="submit" class="btn wide">سجّل</button></form>${err}<div class="actions">${back}</div>`, "auth");
  }
  if (a.step === "new" || a.step === "typed") {
    const isNew = a.step === "new";
    return card(`<div class="card-h"><div><span class="eyebrow">${isNew ? "لاعب جديد" : "تسجيل الدخول"}</span><h2>${isNew ? "سجّل اسمك" : "اكتب اسمك"}</h2></div></div>
      <form class="stack" data-form="${a.step}">
        <div class="field"><label for="auth-name">الاسم</label><input class="inp" id="auth-name" autocomplete="username" maxlength="30" data-k="auth-name" data-keep value="${esc(S.form["auth-name"] || "")}" required></div>
        ${pass("auth-pass", "الباسورد", isNew ? "new-password" : "current-password")}${isNew ? pass("auth-pass2", "اكتبه تاني", "new-password") : ""}
        <button type="submit" class="btn wide">${isNew ? "سجّل" : "دخول"}</button></form>${err}
      ${isNew ? `<p class="hint">اكتب اسمك زي ما صحابك عارفينه. هتدخل بيه هو والباسورد بعد كده.</p>` : `<p class="hint">أول مرة؟ <button type="button" class="link" data-act="auth-step" data-step="new">سجّل اسم جديد</button></p>`}
      ${S.playersErr || !Object.keys(S.players).length ? "" : `<div class="actions">${back}</div>`}`, "auth");
  }
  // pick your name
  if (S.playersErr) { S.auth.step = "typed"; return authView(); }
  if (!S.playersReady) return loading();
  const list = playerList();
  if (!list.length) { S.auth.step = "new"; return authView(); }
  return card(`<div class="card-h"><div><span class="eyebrow">ادخل الدوري</span><h2>اختار اسمك</h2></div></div>
    <div class="names">${list.map((p) => `<button type="button" class="name-btn" data-act="auth-pick" data-pid="${esc(p.pid)}">${esc(p.name)}${p.uid ? "" : "<small>أول مرة</small>"}</button>`).join("")}</div>
    <div class="actions"><button type="button" class="link" data-act="auth-step" data-step="new">اسمي مش موجود</button></div>`, "auth");
}

function finishView() {
  if (S.busy) return loading("بنجهز حسابك");
  const p = S.players[S.pid];
  if (p && p.uid && p.uid !== S.user.uid) {
    return card(`<h3>الاسم ده مربوط بحساب تاني</h3><p class="muted">كلّم المشرف يفك ربط اسمك، وبعدين ادخل تاني.</p>
      <div class="actions"><button type="button" class="btn ghost" data-act="logout">خروج</button></div>`);
  }
  const err = S.finishErr ? `<p class="err" role="alert">${esc(S.finishErr)}</p>` : "";
  return card(`<div class="card-h"><div><span class="eyebrow">خطوة أخيرة</span><h2>كمّل تسجيلك</h2></div></div>
    <p class="muted sm">اكتب اسمك نفس ما سجلت بيه بالظبط.</p>
    <form class="stack" data-form="finish"><div class="field"><label for="fin-name">الاسم</label><input class="inp" id="fin-name" data-k="fin-name" data-keep maxlength="30" value="${esc(S.form["fin-name"] || "")}" required></div>
    <button type="submit" class="btn wide">كمّل</button></form>${err}
    <div class="actions"><button type="button" class="link" data-act="logout">خروج</button></div>`, "auth");
}

const validName = (n) => n.length >= 2 && n.length <= 30 && /\p{L}.*\p{L}/u.test(n);
const emailOf = (pid) => C.emailFor(pid, EMAIL_DOMAIN);

async function ensurePlayer(pid, name, uid) {
  const p = await F.getOne(`players/${pid}`);
  if (!p) await F.put(`players/${pid}`, { name, uid, start: { PL: 0, UCL: 0 }, startX: { PL: 0, UCL: 0 }, at: F.SERVER_TIME });
  else if (!p.uid) await F.patch(`players/${pid}`, { uid, at: F.SERVER_TIME });
  else if (p.uid !== uid) throw Object.assign(new Error("linked"), { code: "linked-other" });
}

async function login(pid, pass) {
  if (!pass) { S.auth.err = "اكتب الباسورد"; return render(); }
  S.auth.err = ""; S.busy = true; render();
  try {
    await F.signIn(emailOf(pid), pass);
    S.form = {}; S.auth = { step: "pick", pid: null, err: "" };
  } catch (e) { S.auth.err = errText(e); } finally { S.busy = false; render(); }
}

async function register(name, pass, pass2, knownPid) {
  name = C.cleanName(name);
  const fail = (m) => { S.auth.err = m; render(); };
  if (!validName(name)) return fail("اكتب اسمك (حرفين على الأقل، و30 بالكتير)");
  if ((pass || "").length < MIN_PASS) return fail(`الباسورد لازم يبقى ${MIN_PASS} حروف أو أرقام على الأقل`);
  if (pass !== pass2) return fail("الباسوردين مش زي بعض");
  const pid = knownPid || (await C.pidFor(name));
  const ex = S.players[pid];
  if (ex && ex.uid) return fail("الاسم ده متسجل قبل كده. اختاره من القايمة وادخل بالباسورد بتاعك");
  S.auth.err = ""; S.busy = true; render();
  try {
    let u;
    try { u = await F.signUp(emailOf(pid), pass); } catch (e) {
      if (F.errCode(e) !== "auth/email-already-in-use") throw e;
      u = await F.signIn(emailOf(pid), pass).catch(() => { throw e; }); // registration that stopped half way
    }
    try { await ensurePlayer(pid, ex ? ex.name : name, u.uid); } catch (e) { S.finishErr = errText(e); throw e; }
    S.form = {}; S.auth = { step: "pick", pid: null, err: "" };
  } catch (e) { S.auth.err = errText(e); } finally { S.busy = false; render(); }
}

async function finishSignup(name) {
  name = C.cleanName(name);
  if ((await C.pidFor(name)) !== S.pid) { S.finishErr = "ده مش نفس الاسم اللي سجلت بيه"; return render(); }
  S.busy = true; S.finishErr = ""; render();
  try { await ensurePlayer(S.pid, name, S.user.uid); } catch (e) { S.finishErr = errText(e); } finally { S.busy = false; render(); }
}

/* ---------- predict ---------- */

function byDay(matches) {
  const groups = [];
  for (const m of matches) {
    const d = Number.isFinite(m.ko) ? C.cairoDay(m.ko) : "?";
    let g = groups[groups.length - 1];
    if (!g || g.d !== d) groups.push((g = { d, ko: m.ko, items: [] }));
    g.items.push(m);
  }
  return groups;
}
const dayHead = (g) => `<h3 class="day">${Number.isFinite(g.ko) ? fDay.format(g.ko) : "ميعاده لسه"}</h3>`;

// a single word longer than 10 letters ("Bournemouth") gets a smaller font so it never breaks mid-word
const teamCls = (side, name) => `team ${side}${String(name).split(" ").some((w) => w.length > 10) ? " long" : ""}`;

function scoreBox(prefix, rid, m, i, c, disabled) {
  const team = i ? m.a : m.h;
  const cls = "sc" + (c.dirty ? " dirty" : c.saved ? " saved" : "");
  return `<input class="${cls}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" autocomplete="off" enterkeyhint="next" data-k="${prefix}|${esc(rid)}|${esc(m.id)}|${i}" value="${c.v == null || c.v === "" ? "" : esc(c.v)}" aria-label="أهداف ${esc(team)}"${disabled ? " disabled" : ""}>`;
}

function myRankLine(comp) {
  const { rows } = C.standings(S.players, S.rounds.map((r) => ({ ...r, points: livePoints(r) })), comp);
  const row = rows.find((x) => x.pid === S.pid);
  return row ? `انت رقم ${row.rank} من ${rows.length} · ${row.p} نقطة` : "";
}

function predictView() {
  const comp = S.comp, list = openRounds(comp), r = selectedOpen(comp);
  if (!r) {
    const any = compRounds(comp).length;
    return empty(any ? "مفيش جولة مفتوحة دلوقتي" : "لسه الماتشات منزلتش",
      any ? "الجولة الجاية هتظهر هنا أول ما مواعيدها تتأكد." : "الماتشات بتنزل لوحدها من التحديث التلقائي كل نص ساعة.");
  }
  S.sel[comp] = r.id;
  const N = activeMatches(r).length;
  const saved = C.countPicks(savedPicks(r.id), r.matches);
  const leftMs = r.lock - now();
  const chips = list.length > 1 ? `<div class="rchips" role="group" aria-label="الجولات المفتوحة">${list.map((x) =>
    `<button type="button" class="rchip" data-act="sel-round" data-rid="${esc(x.id)}" aria-pressed="${x.id === r.id}">${esc(x.label)}</button>`).join("")}</div>` : "";
  const state = saved >= N ? `<span class="chip open">متوقّع كله ✓</span>` : saved ? `<span class="chip soon">متوقّع ${saved} من ${N}</span>` : `<span class="chip">لسه ما توقعتش</span>`;
  const miss = S.pasteMiss.length ? `<p class="hint">ماعرفتش السطور دي: ${S.pasteMiss.map((l) => `<span dir="ltr">${esc(l)}</span>`).join("، ")}</p>` : "";
  const paste = S.pasteOpen ? `<div class="paste"><label class="eyebrow" for="paste-box">الصق التوقعات، كل ماتش في سطر. مثلاً: <span dir="ltr">Arsenal 2-1 Chelsea</span></label>
      <textarea class="inp" id="paste-box" data-k="paste" data-keep rows="6" placeholder="Nottingham Forest 1-2 Chelsea">${esc(S.form.paste || "")}</textarea>
      <div class="actions"><button type="button" class="btn sm" data-act="paste" data-rid="${esc(r.id)}">املا الخانات</button><button type="button" class="link" data-act="paste-toggle">اقفل</button></div></div>` : "";
  const rank = myRankLine(comp);
  const rows = byDay(r.matches).map((g) => dayHead(g) + g.items.map((m) => {
    const dead = C.isDead(m);
    const tags = (m.dbl ? `<span class="chip dbl">دابل ×2</span>` : "") + (m.st === "POSTPONED" ? `<span class="chip bad">اتأجل</span>` : "") + (dead ? `<span class="chip bad">اتلغى</span>` : "");
    return `<div class="m"><div class="meta"><span>${Number.isFinite(m.ko) ? fTime.format(m.ko) : ""}</span>${tags}</div>
      <div class="mrow"><div class="${teamCls("home", m.h)}" lang="en">${esc(m.h)}</div><div class="scores">${scoreBox("p", r.id, m, 0, cell(r.id, m.id, 0), dead)}<span class="dash">-</span>${scoreBox("p", r.id, m, 1, cell(r.id, m.id, 1), dead)}</div><div class="${teamCls("away", m.a)}" lang="en">${esc(m.a)}</div></div></div>`;
  }).join("")).join("");
  return card(`${chips}<div class="card-h"><div><span class="eyebrow">${esc(COMPS[comp].short)} · ${esc(r.label)}</span><h2>توقعاتك</h2></div>${state}</div>
      <p class="muted sm">بتقفل <b>${when(r.lock)}</b> (أول ماتش) · باقي <span data-cd="${r.lock}">${leftText(leftMs)}</span></p>
      ${rank ? `<p class="muted sm">${rank}</p>` : ""}
      <div class="actions">${S.pasteOpen ? "" : `<button type="button" class="link" data-act="paste-toggle">الصق توقعاتك مرة واحدة</button>`}</div>
      ${paste}${miss}<div class="mlist">${rows}</div>
      <p class="note">التوقعات بتبان للكل بعد القفل بس. تقدر تعدّل لحد آخر لحظة قبل أول ماتش.</p>`) + whoCard(r);
}

function whoCard(r) {
  const N = activeMatches(r).length, subs = S.subs[r.id];
  if (!subs) return card(`<h3>مين توقّع</h3><p class="muted sm">بنحمّل…</p>`);
  const list = playerList().map((p) => ({ ...p, n: subs[p.pid] ? Number(subs[p.pid].n) || 0 : 0 }));
  const done = list.filter((p) => p.n >= N), part = list.filter((p) => p.n > 0 && p.n < N);
  const none = list.filter((p) => !p.n && p.uid), off = list.filter((p) => !p.n && !p.uid);
  const chip = (p, cls, extra = "") => `<span class="chip ${cls}">${esc(p.name)}${extra}</span>`;
  return card(`<div class="card-h"><h3>مين توقّع</h3><span class="eyebrow">${done.length} من ${list.length}</span></div>
    <div class="who">${done.map((p) => chip(p, "open", " ✓")).join("")}${part.map((p) => chip(p, "soon", ` ${p.n}/${N}`)).join("")}${none.map((p) => chip(p, "")).join("")}${off.map((p) => chip(p, "ghost", " · مش مسجّل")).join("")}</div>`);
}

async function save(rid) {
  const r = roundById(rid);
  if (!r || S.saving) return;
  if (now() >= r.lock) { toast("الجولة قفلت خلاص، مينفعش تتعدل", true); return; }
  const picks = { ...savedPicks(rid) };
  for (const m of r.matches) {
    const a = cell(rid, m.id, 0).v, b = cell(rid, m.id, 1).v;
    if (C.isGoal(a) && C.isGoal(b)) picks[m.id] = [a, b];
    else if (a == null && b == null) delete picks[m.id];
    else {
      toast(`كمّل نتيجة ${m.h} و${m.a}`, true);
      const el = $(`[data-k="${CSS.escape(`p|${rid}|${m.id}|${a == null ? 0 : 1}`)}"]`);
      if (el) el.focus();
      return;
    }
  }
  const n = C.countPicks(picks, r.matches);
  S.saving = true; updateSavebar();
  const slow = setTimeout(() => toast("لسه بيتحفظ… اتأكد إن النت شغال"), 9000);
  try {
    await F.batch([
      { op: "put", path: `rounds/${rid}/preds/${S.pid}`, data: { uid: S.user.uid, picks, at: F.SERVER_TIME } },
      { op: "put", path: `rounds/${rid}/subs/${S.pid}`, data: { n, at: F.SERVER_TIME } },
    ]);
    S.mine[rid] = { ...(S.mine[rid] || {}), uid: S.user.uid, picks };
    S.drafts[rid] = {};
    S.pasteMiss = [];
    const N = activeMatches(r).length;
    toast(n >= N ? "اتحفظ ✓ توقعت الجولة كلها" : `اتحفظ ✓ توقعت ${n} من ${N}`);
  } catch (e) {
    toast(F.errCode(e) === "permission-denied" ? "مش متحفظ: الجولة قفلت أو حسابك مش مربوط" : errText(e), true);
  } finally { clearTimeout(slow); S.saving = false; render(); }
}

function paste(rid) {
  const r = roundById(rid);
  if (!r) return;
  const { filled, unmatched } = C.parsePicks(S.form.paste || "", r.matches.filter((m) => !C.isDead(m)));
  for (const f of filled) { setDraft(rid, f.mid, 0, f.h); setDraft(rid, f.mid, 1, f.a); }
  S.pasteMiss = unmatched;
  if (filled.length) { S.pasteOpen = false; S.form.paste = ""; }
  toast(filled.length ? `اتملى ${games(filled.length)}. راجع ودوس احفظ` : "ماعرفتش أقرا ولا ماتش", !filled.length);
  render();
}

/* ---------- results ---------- */

function statusWord(m) {
  switch (m.st) {
    case "IN_PLAY": case "PAUSED": return "شغّال";
    case "POSTPONED": return "اتأجل";
    case "CANCELLED": case "AWARDED_VOID": return "اتلغى";
    case "SUSPENDED": return "اتوقف";
    case "FINISHED": return "خلص";
    default: return Number.isFinite(m.ko) ? fTime.format(m.ko) : "لسه";
  }
}
function rangeText(r) {
  const kos = r.matches.map((m) => m.ko).filter(Number.isFinite);
  if (!kos.length) return "";
  const a = Math.min(...kos), b = Math.max(...kos);
  return C.cairoDay(a) === C.cairoDay(b) ? fDay.format(a) : `${fShort.format(a)} – ${fShort.format(b)}`;
}
function roundState(r) {
  if (r.matches.every((m) => C.isFinal(m) || C.isDead(m))) return `<span class="chip">خلصت</span>`;
  if (r.matches.some((m) => m.st === "IN_PLAY" || m.st === "PAUSED")) return `<span class="chip soon">شغّالة دلوقتي</span>`;
  return `<span class="chip">قفلت</span>`;
}

function resultMatch(r, m, preds) {
  const fin = C.isFinal(m);
  const live = (m.st === "IN_PLAY" || m.st === "PAUSED") && C.isGoal(m.hg) && C.isGoal(m.ag);
  const mid = fin || live ? `<span class="final${live ? " live" : ""}">${m.hg}<i>-</i>${m.ag}</span>` : `<span class="final wait">${esc(statusWord(m))}</span>`;
  const adj = r.adj || {};
  const list = Object.entries(preds || {}).filter(([, p]) => p && p.picks && Array.isArray(p.picks[m.id]))
    .sort(([a], [b]) => (a === S.pid ? -1 : b === S.pid ? 1 : nameOf(a).localeCompare(nameOf(b), "ar")));
  const chips = list.map(([pid, p]) => {
    const pk = p.picks[m.id];
    const a = adj[pid] || {};
    const skipped = (a.skip || []).map(String).includes(String(m.id));
    const mult = m.dbl && !a.noDbl ? 2 : 1;
    const s = fin && !skipped ? C.score(pk, m) : null;
    const cls = skipped ? "skip" : s === 3 ? "p3" : s === 1 ? "p1" : s == null ? "pn" : "";
    const pt = s ? `<span class="pt">+${s * mult}</span>` : "";
    const by = p.by ? `<span class="by" title="سجّلها المشرف">✎</span>` : "";
    return `<span class="pk ${cls}${pid === S.pid ? " mine" : ""}"${skipped ? ` title="ما اتحسبتش: اتسجّلت بعد ما الماتش بدأ"` : ""}><b>${esc(nameOf(pid))}</b><span class="g">${pk[0]}-${pk[1]}</span>${pt}${by}</span>`;
  }).join("");
  const tags = (m.dbl ? `<span class="chip dbl">دابل ×2</span>` : "") + (live ? `<span class="chip soon">مباشر</span>` : "");
  return `<div class="m"><div class="meta"><span>${Number.isFinite(m.ko) ? fTime.format(m.ko) : ""}</span>${tags}</div>
    <div class="mrow"><div class="${teamCls("home", m.h)}" lang="en">${esc(m.h)}</div>${mid}<div class="${teamCls("away", m.a)}" lang="en">${esc(m.a)}</div></div>
    ${preds ? `<div class="pks">${chips || `<span class="muted sm">محدش توقّع الماتش ده</span>`}</div>` : ""}</div>`;
}

// Star (most points), rocket (biggest climb in the table) and the rarest exact score of a round.
const names = (pids) => pids.map((pid) => nameOf(pid)).join(" و");
function roundAwards(r, pts, preds) {
  const settled = C.roundSettled(r);
  const top = C.roundTop(pts);
  const all = S.rounds.map((x) => ({ ...x, points: x.id === r.id ? pts : livePoints(x) }));
  const rocket = settled ? C.roundRocket(S.players, all, r.comp, r.id) : null;
  return { settled, top, rocket, hit: C.bestHit(r, preds) };
}
function awardsBlock(r, pts, preds) {
  const { settled, top, rocket, hit } = roundAwards(r, pts, preds);
  const row = (ic, title, sub) => `<div class="aw-row"><span class="aw-ic" aria-hidden="true">${ic}</span><div><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div></div>`;
  let h = "";
  if (top) h += settled ? row("⭐", `نجم الجولة: ${esc(names(top.pids))}`, `${ptsWord(top.p)} · ${top.x} مظبوطة`)
    : row("⏱️", `متصدّر الجولة دلوقتي: ${esc(names(top.pids))}`, `${ptsWord(top.p)} لحد دلوقتي`);
  if (rocket) h += row("🚀", `صاروخ الجولة: ${esc(names(rocket.pids))}`, `طلع ${placesWord(rocket.up)} في الترتيب`);
  if (hit) h += row("🎯", `أحلى توقعة: ${esc(names(hit.pids))}`, `<bdi>${hit.m.hg}-${hit.m.ag}</bdi> في <bdi>${esc(hit.m.h)}</bdi> و<bdi>${esc(hit.m.a)}</bdi>${hit.pids.length === 1 ? "، ولوحده" : ""}`);
  if (settled && top) h += `<div class="actions tight"><button type="button" class="btn sm" data-act="share" data-rid="${esc(r.id)}">ابعت النجم للجروب</button></div>`;
  return h ? `<div class="awards">${h}</div>` : "";
}

function roundCard(r, i) {
  const open = isOpen(r.id, i);
  const preds = S.preds[r.id];
  const pts = livePoints(r) || {};
  const mine = pts[S.pid];
  const head = mine ? `نقطك: ${mine.p}` : preds ? "ما توقعتش الجولة دي" : r.points ? "ما توقعتش الجولة دي" : "النقط لسه";
  let inner = "";
  if (open) {
    if (!preds) inner = `<p class="muted sm">بنحمّل التوقعات…</p>`;
    else {
      const tot = Object.entries(pts).sort(([a, x], [b, y]) => y.p - x.p || y.x - x.x || nameOf(a).localeCompare(nameOf(b), "ar"));
      const adj = r.adj || {};
      const late = (pid) => (adj[pid] && adj[pid].mark ? `<small class="late">متأخر</small>` : "");
      inner = awardsBlock(r, pts, preds)
        + (tot.length ? `<div class="rtot">${tot.map(([pid, v]) => `<span class="tt${pid === S.pid ? " mine" : ""}">${esc(nameOf(pid))}${late(pid)} <span class="pt">${v.p}</span></span>`).join("")}</div>` : "")
        + `<div class="mlist">${byDay(r.matches).map((g) => dayHead(g) + g.items.map((m) => resultMatch(r, m, preds)).join("")).join("")}</div>`;
    }
  }
  return `<details class="card rres" data-rid="${esc(r.id)}"${open ? " open" : ""}><summary class="card-h"><div><span class="eyebrow">${esc(r.label)} · ${esc(rangeText(r))}</span><h2>${head}</h2></div>${roundState(r)}<span class="chev" aria-hidden="true"></span></summary>${inner}</details>`;
}

function resultsView() {
  const list = lockedRounds(S.comp);
  if (!list.length) return empty("لسه مفيش نتايج", "أول ما جولة تقفل هتلاقي هنا توقعات الكل ونقط كل واحد.");
  const shown = S.more[S.comp] ? list : list.slice(0, 5);
  return shown.map(roundCard).join("") + (shown.length < list.length ? `<div class="actions"><button type="button" class="btn ghost wide" data-act="more">الجولات الأقدم</button></div>` : "");
}

/* ---------- table ---------- */

function tableView() {
  const { rows, lastLabel, awardsLabel } = C.standings(S.players, S.rounds.map((r) => ({ ...r, points: livePoints(r) })), S.comp);
  const badges = (r) => (r.s ? `<span class="aw${r.star ? " now" : ""}" title="${r.star ? "نجم آخر جولة" : "عدد مرات نجم الجولة"}">⭐${r.s > 1 ? r.s : ""}</span>` : "")
    + (r.rocket ? `<span class="aw now" title="صاروخ آخر جولة">🚀</span>` : "");
  if (!rows.length) return empty("لسه مفيش لاعيبة", "أول ما الناس تسجّل هيظهر الترتيب هنا.");
  const body = rows.map((r) => `<tr class="${r.rank === 1 ? "lead" : ""}${r.pid === S.pid ? " me" : ""}"><td class="rk">${r.rank}</td>
    <td class="nm">${esc(r.name)}${badges(r)}${r.pid === S.pid ? `<span class="you">انت</span>` : ""}${r.claimed ? "" : "<small>لسه ما سجّلش</small>"}</td>
    <td class="pts">${r.p}</td><td class="n">${r.x}</td><td class="n">${r.last == null ? "–" : r.last}</td></tr>`).join("");
  return card(`<div class="card-h"><div><span class="eyebrow">${esc(COMPS[S.comp].name)}</span><h2>الترتيب</h2></div></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th class="nm">الاسم</th><th>النقط</th><th>مظبوطة</th><th>${lastLabel ? esc(lastLabel) : "آخر جولة"}</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="note">لو اتنين متعادلين في النقط، اللي جاب نتايج مظبوطة أكتر بيبقى قدام، ولو لسه متعادلين فاللي عنده نجوم أكتر.<br>⭐ نجم جولة (والرقم عدد المرات) · 🚀 صاروخ ${esc(awardsLabel || "آخر جولة")}</p>`);
}

/* ---------- account ---------- */

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
async function hashKey(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function b64u(s) {
  const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function pushCard() {
  let inner;
  if (!pushSupported()) {
    inner = isIOS() && !isStandalone()
      ? `<p class="muted sm">على الآيفون الإشعارات بتشتغل بس لو التطبيق متضاف للشاشة الرئيسية:</p><ol class="steps sm"><li>دوس زرار المشاركة <b>⬆︎</b> اللي تحت في سفاري.</li><li>اختار <b>Add to Home Screen</b>.</li><li>افتح التطبيق من الأيقونة الجديدة وارجع للصفحة دي.</li></ol>`
      : `<p class="muted sm">المتصفح ده مش بيدعم الإشعارات. افتح التطبيق من كروم.</p>`;
  } else if (Notification.permission === "denied") {
    inner = `<p class="muted sm">الإشعارات مقفولة للموقع ده من إعدادات المتصفح. افتح إعدادات الموقع (القفل جنب اللينك) ← Notifications ← Allow، وارجع هنا.</p>`;
  } else {
    const on = Notification.permission === "granted" && S.devKey && S.push && S.push.subs && S.push.subs[S.devKey];
    const results = !S.push || S.push.results !== false;
    inner = on
      ? `<p class="muted sm">✓ شغّالة على الجهاز ده. هنفكّرك قبل القفل بيوم وبساعتين لو لسه ما توقعتش.</p>
        <label class="toggle-row"><span>ابعتلي نقطي لما الجولة تخلص</span><input type="checkbox" data-act="push-results"${results ? " checked" : ""}></label>
        <div class="actions"><button type="button" class="btn ghost sm" data-act="push-test">جرّب إشعار</button><button type="button" class="link danger" data-act="push-off">وقّفها على الجهاز ده</button></div>`
      : `<p class="muted sm">هنفكّرك قبل القفل بيوم وبساعتين لو لسه ما توقعتش، ونبعتلك نقطك لما الجولة تخلص.</p>
        <div class="actions"><button type="button" class="btn" data-act="push-on"${S.pushBusy ? " disabled" : ""}>${S.pushBusy ? "ثانية…" : "فعّل الإشعارات"}</button></div>`;
  }
  return card(`<h3>الإشعارات</h3>${inner}`);
}

function installCard() {
  if (isStandalone()) return "";
  let inner;
  if (S.installEvt) inner = `<p class="muted sm">نزّله على الشاشة الرئيسية وافتحه زي أي تطبيق.</p><div class="actions"><button type="button" class="btn" data-act="install">نزّل التطبيق</button></div>`;
  else if (isIOS()) inner = `<ol class="steps sm"><li>من سفاري، دوس زرار المشاركة <b>⬆︎</b>.</li><li>اختار <b>Add to Home Screen</b>.</li></ol>`;
  else inner = `<p class="muted sm">من قايمة كروم (<b>⋮</b>) اختار <b>Add to Home screen</b> أو <b>Install app</b>.</p>`;
  return card(`<h3>خلّيه تطبيق على موبايلك</h3>${inner}`);
}

function meView() {
  const p = me();
  const role = isMain() ? `<span class="chip dbl">المشرف</span>` : isOwner() ? `<span class="chip dbl">مشرف</span>` : "";
  const ownerNote = isOwner() ? `<p class="hint">لو غيّرت الباسورد، غيّره كمان في GitHub ← Settings ← Secrets ← <span dir="ltr">ADMIN_PASS</span>، عشان التحديث التلقائي يفضل شغّال.</p>` : "";
  const pf = (k, label, ac) => `<div class="field"><label for="${k}">${label}</label><input class="inp" id="${k}" type="password" autocomplete="${ac}" data-k="${k}" data-keep value="${esc(S.form[k] || "")}" required></div>`;
  return card(`<div class="card-h"><div><span class="eyebrow">حسابك</span><h2>${esc(p.name)}</h2></div>${role}</div>
      <div class="actions"><button type="button" class="btn ghost" data-act="logout">خروج</button></div>`)
    + pushCard() + installCard()
    + card(`<h3>غيّر الباسورد</h3><form class="stack" data-form="pass">
        <input type="text" autocomplete="username" value="${esc(p.name)}" hidden>
        ${pf("pw-old", "الباسورد الحالي", "current-password")}${pf("pw-new", "الباسورد الجديد", "new-password")}${pf("pw-new2", "اكتبه تاني", "new-password")}
        <button type="submit" class="btn">غيّر</button></form>${ownerNote}`);
}

const swReady = () => Promise.race([
  navigator.serviceWorker.ready,
  new Promise((_, no) => setTimeout(() => no(Object.assign(new Error("sw"), { code: "sw-missing" })), 10000)),
]);
async function enablePush() {
  if (!pushSupported()) return toast("المتصفح ده مش بيدعم الإشعارات", true);
  S.pushBusy = true; render();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("لازم توافق على الإشعارات", true); return; }
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
    const j = sub.toJSON();
    const key = await hashKey(j.endpoint);
    const cur = S.push || {};
    const subs = { ...(cur.subs || {}), [key]: { endpoint: j.endpoint, keys: j.keys, at: now() } };
    for (const k of Object.keys(subs).sort((a, b) => (subs[b].at || 0) - (subs[a].at || 0)).slice(10)) delete subs[k];
    await F.put(`push/${S.pid}`, { uid: S.user.uid, subs, results: cur.results !== false, at: F.SERVER_TIME });
    S.devKey = key;
    toast("الإشعارات اتفعّلت ✓");
  } catch (e) { toast(errText(e), true); } finally { S.pushBusy = false; render(); }
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe().catch(() => {});
    const cur = S.push || {};
    const subs = { ...(cur.subs || {}) };
    if (S.devKey) delete subs[S.devKey];
    await F.put(`push/${S.pid}`, { uid: S.user.uid, subs, results: cur.results !== false, at: F.SERVER_TIME });
    S.devKey = null;
    toast("وقّفت الإشعارات على الجهاز ده");
  } catch (e) { toast(errText(e), true); } finally { render(); }
}
async function toggleResults(on) {
  const cur = S.push || {};
  try { await F.put(`push/${S.pid}`, { uid: S.user.uid, subs: cur.subs || {}, results: !!on, at: F.SERVER_TIME }); toast(on ? "هنبعتلك نقطك ✓" : "مش هنبعت النقط"); }
  catch (e) { toast(errText(e), true); render(); }
}
async function testPush() {
  try {
    const reg = await swReady();
    await reg.showNotification("دوري التوقعات", { body: "كده الإشعارات شغّالة ✓", icon: "icon-192.png", badge: "badge-72.png", lang: "ar", dir: "rtl", tag: "test" });
  } catch (e) { toast(errText(e), true); }
}
async function refreshDevKey() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    S.devKey = sub ? await hashKey(sub.endpoint) : null;
    render();
  } catch { /* no service worker yet */ }
}

async function changePass(oldP, newP, newP2) {
  if ((newP || "").length < MIN_PASS) return toast(`الباسورد الجديد لازم ${MIN_PASS} حروف أو أرقام على الأقل`, true);
  if (newP !== newP2) return toast("الباسوردين الجداد مش زي بعض", true);
  try {
    await F.changePassword(oldP, newP);
    for (const k of ["pw-old", "pw-new", "pw-new2"]) delete S.form[k];
    toast("الباسورد اتغيّر ✓");
    render();
  } catch (e) {
    const c = F.errCode(e);
    toast(c === "auth/invalid-credential" || c === "auth/wrong-password" ? "الباسورد الحالي غلط" : errText(e), true);
  }
}

/* ---------- admin ---------- */

const ghRepo = (() => {
  const h = location.hostname;
  if (!h.endsWith(".github.io")) return null;
  const seg = location.pathname.split("/")[1] || "";
  return `${h.split(".")[0]}/${seg && !seg.includes(".") ? seg : h}`;
})();
const armed = (key) => S.adm.armed === key;
function arm(key) {
  if (S.adm.armed === key) { S.adm.armed = null; return true; }
  S.adm.armed = key;
  render();
  setTimeout(() => { if (S.adm.armed === key) { S.adm.armed = null; render(); } }, 4000);
  return false;
}

function adminView() {
  return syncCard() + adminsCard() + seedCard() + playersCard() + roundToolsCard();
}

function adminsCard() {
  if (!isMain()) return "";
  const admins = (S.owner && S.owner.admins) || [];
  const byUid = new Map(playerList().filter((p) => p.uid).map((p) => [p.uid, p]));
  const rows = admins.map((uid) => `<div class="prow-h"><b>${esc(byUid.has(uid) ? byUid.get(uid).name : "حساب مش موجود")}</b>
    <button type="button" class="link danger" data-act="adm-rm" data-uid="${esc(uid)}">${armed(`rm:${uid}`) ? "دوس تاني للتأكيد" : "شيله"}</button></div>`).join("");
  const cands = playerList().filter((p) => p.uid && p.uid !== S.owner.uid && !admins.includes(p.uid));
  const pick = S.form["adm-new"] || "";
  return card(`<div class="card-h"><div><span class="eyebrow">انت المشرف الأساسي</span><h2>المشرفين</h2></div></div>
    <p class="muted sm">اللي تضيفه يقدر يعمل كل حاجة في الإدارة، ما عدا إنه يضيف أو يشيل مشرفين. ومحدش، ولا انت، بيشوف توقعات حد قبل القفل.</p>
    ${rows ? `<div class="stack">${rows}</div>` : ""}
    ${cands.length ? `<div class="field"><label for="adm-new">ضيف مشرف (لازم يكون سجّل في التطبيق)</label><select class="inp" id="adm-new" data-k="adm-new"><option value="">اختار</option>${cands.map((p) => `<option value="${esc(p.uid)}"${p.uid === pick ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div class="actions"><button type="button" class="btn sm" data-act="adm-add">خليه مشرف</button></div>` : `<p class="hint">مفيش حد مسجّل تقدر تضيفه دلوقتي.</p>`}`);
}

function syncCard() {
  const s = S.sync;
  const actions = ghRepo ? `<a class="btn ghost sm" href="https://github.com/${esc(ghRepo)}/actions" target="_blank" rel="noopener">افتح GitHub Actions</a>` : "";
  let line;
  if (s === undefined) line = "بنحمّل…";
  else if (!s) line = "التحديث التلقائي لسه ما اشتغلش. اتأكد إن المفاتيح السرية متحطوطة في GitHub.";
  else {
    const stale = now() - s.at > 2 * 3600e3;
    line = (s.ok ? `آخر تحديث ${agoText(s.at)} ✓` : `آخر محاولة ${agoText(s.at)} فشلت: ${esc(s.msg || "")}`)
      + (s.ok && s.msg ? ` · ${esc(s.msg)}` : "")
      + (stale ? `<br><b>التحديث واقف من أكتر من ساعتين.</b> افتح GitHub واتأكد إنه شغّال.` : "");
  }
  return card(`<div class="card-h"><div><span class="eyebrow">الماتشات والنتايج</span><h2>التحديث التلقائي</h2></div></div>
    <p class="muted sm">${line}</p><p class="hint">بيشتغل كل نص ساعة: بينزّل الماتشات والنتايج، يحسب النقط، يختار الدابل في الأبطال بعد القفل، ويبعت التنبيهات.</p>
    ${actions ? `<div class="actions">${actions}</div>` : ""}`);
}

function seedCard() {
  const comp = S.comp, prev = S.adm.seed;
  let preview = "";
  if (prev) {
    preview = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="nm">الاسم</th><th>النقط</th><th>مظبوطة</th><th></th></tr></thead><tbody>${prev.map((r) =>
      `<tr><td class="nm">${esc(r.name)}</td><td class="n">${r.p}</td><td class="n">${r.x == null ? "–" : r.x}</td><td><span class="chip ${S.players[r.pid] ? "" : "open"}">${S.players[r.pid] ? "موجود" : "جديد"}</span></td></tr>`).join("")}</tbody></table></div>
      ${S.adm.seedBad.length ? `<p class="hint">سطور ماعرفتش أقراها: ${S.adm.seedBad.map(esc).join("، ")}</p>` : ""}
      <div class="actions"><button type="button" class="btn" data-act="seed-save">احفظ في ${esc(COMPS[comp].short)}</button><button type="button" class="link" data-act="seed-clear">إلغاء</button></div>`;
  }
  return card(`<div class="card-h"><div><span class="eyebrow">${esc(COMPS[comp].name)}</span><h2>النقط اللي فاتت</h2></div></div>
    <p class="muted sm">الصق الترتيب، كل لاعب في سطر: الاسم وبعده النقط وبعدها عدد النتايج المظبوطة لو معاك. مثلاً: محمد 72 9</p>
    <textarea class="inp ta-ar" data-k="seed" data-keep rows="6">${esc(S.form.seed || "")}</textarea>
    <div class="actions"><button type="button" class="btn ghost" data-act="seed-preview">راجع قبل الحفظ</button></div>${preview}`);
}

function playersCard() {
  const list = playerList();
  if (!list.length) return "";
  const rows = list.map((p) => {
    const st = (c) => `${COMPS[c].short}: ${Number((p.start || {})[c]) || 0}${(p.startX || {})[c] ? ` (${p.startX[c]} مظبوطة)` : ""}`;
    const head = `<div class="prow-h"><div><b>${esc(p.name)}</b> <span class="chip ${p.uid ? "open" : ""}">${p.uid ? "مسجّل" : "لسه ما سجّلش"}</span><div class="muted sm">بداية ${COMP_KEYS.map(st).join(" · ")}</div></div>
      <button type="button" class="link" data-act="adm-edit" data-pid="${esc(p.pid)}">${S.adm.edit === p.pid ? "اقفل" : "تعديل"}</button></div>`;
    if (S.adm.edit !== p.pid) return `<div class="prow">${head}</div>`;
    const f = (k, v) => (S.form[k] !== undefined ? S.form[k] : v);
    const num = (k, label, v) => `<div class="field"><label for="${k}">${label}</label><input class="inp num" id="${k}" inputmode="numeric" data-k="${k}" data-keep value="${esc(f(k, v))}"></div>`;
    const fields = COMP_KEYS.map((c) => num(`pe|${p.pid}|${c}|p`, `${COMPS[c].short}: نقط`, Number((p.start || {})[c]) || 0) + num(`pe|${p.pid}|${c}|x`, "مظبوطة", Number((p.startX || {})[c]) || 0)).join("");
    return `<div class="prow">${head}<div class="stack">
      <div class="field"><label for="pe|${esc(p.pid)}|name">الاسم اللي بيظهر</label><input class="inp" id="pe|${esc(p.pid)}|name" data-k="pe|${esc(p.pid)}|name" data-keep maxlength="30" value="${esc(f(`pe|${p.pid}|name`, p.name))}"></div>
      <div class="g4">${fields}</div>
      <div class="actions"><button type="button" class="btn sm" data-act="adm-save-player" data-pid="${esc(p.pid)}">احفظ</button>
      ${p.uid ? `<button type="button" class="btn ghost sm" data-act="adm-unlink" data-pid="${esc(p.pid)}">${armed(`unlink:${p.pid}`) ? "دوس تاني للتأكيد" : "فك الربط (نسي الباسورد)"}</button>` : ""}
      <button type="button" class="link danger" data-act="adm-delete" data-pid="${esc(p.pid)}">${armed(`del:${p.pid}`) ? "دوس تاني عشان يتمسح" : "امسح اللاعب"}</button></div>
      ${p.uid ? `<p class="hint">لو نسي الباسورد: افتح Firebase ← Authentication ← Users، وامسح المستخدم <span dir="ltr">${esc(emailOf(p.pid))}</span>، وبعدها دوس فك الربط. هيختار باسورد جديد أول ما يدخل.</p>` : ""}
    </div></div>`;
  }).join("");
  return card(`<div class="card-h"><div><span class="eyebrow">${list.length} لاعب</span><h2>اللاعيبة</h2></div></div><div>${rows}</div>`);
}

// Late entry choices: which matches count, whether the double counts, whether to show "late".
function lateState(r, fpid) {
  const a = (r.adj || {})[fpid];
  const pick = (k, d) => (S.form[k] !== undefined ? S.form[k] === "1" : d);
  return {
    counts: (m) => pick(`fc|${r.id}|${m.id}`, a ? !(a.skip || []).map(String).includes(String(m.id)) : !(m.ko <= now())),
    dbl: pick(`fdbl|${r.id}`, a ? !a.noDbl : false),
    mark: pick(`fmark|${r.id}`, a ? !!a.mark : true),
  };
}
const clearFriendForm = () => { for (const k of Object.keys(S.form)) if (/^(f|fc|fdbl|fmark)\|/.test(k)) delete S.form[k]; };

function roundToolsCard() {
  const rounds = compRounds(S.comp).sort((a, b) => (a.first || a.lock) - (b.first || b.lock));
  if (!rounds.length) return "";
  if (!S.adm.rid || !rounds.some((r) => r.id === S.adm.rid)) S.adm.rid = (lockedRounds(S.comp)[0] || openRounds(S.comp)[0] || rounds[0]).id;
  const r = roundById(S.adm.rid), locked = r.lock <= now(), rid = r.id;
  const opts = rounds.map((x) => `<option value="${esc(x.id)}"${x.id === rid ? " selected" : ""}>${esc(x.label)}${x.lock <= now() ? " (قفلت)" : ""}</option>`).join("");
  const val = (k, v) => (S.form[k] !== undefined ? S.form[k] : v);
  const matches = r.matches.map((m) => {
    const c0 = { v: val(`r|${rid}|${m.id}|0`, C.isGoal(m.hg) ? m.hg : ""), dirty: false, saved: false };
    const c1 = { v: val(`r|${rid}|${m.id}|1`, C.isGoal(m.ag) ? m.ag : ""), dirty: false, saved: false };
    const tags = (m.manual ? `<span class="chip soon">يدوي</span>` : "") + (m.dbl ? `<span class="chip dbl">دابل</span>` : "");
    return `<div class="m"><div class="meta"><span>${Number.isFinite(m.ko) ? esc(when(m.ko)) : ""} · ${esc(statusWord(m))}</span>${tags}</div>
      <div class="mrow"><div class="${teamCls("home", m.h)}" lang="en">${esc(m.h)}</div><div class="scores">${scoreBox("r", rid, m, 0, c0)}<span class="dash">-</span>${scoreBox("r", rid, m, 1, c1)}</div><div class="${teamCls("away", m.a)}" lang="en">${esc(m.a)}</div></div>
      <div class="actions tight"><button type="button" class="btn sm" data-act="adm-result" data-mid="${esc(m.id)}">سجّل النتيجة</button>
      <button type="button" class="btn ghost sm" data-act="adm-dbl" data-mid="${esc(m.id)}">${m.dbl ? "شيل الدابل" : "خليه دابل"}</button>
      ${m.manual ? `<button type="button" class="link" data-act="adm-auto" data-mid="${esc(m.id)}">رجّعه تلقائي</button>` : `<button type="button" class="link danger" data-act="adm-cancel" data-mid="${esc(m.id)}">${armed(`cancel:${m.id}`) ? "دوس تاني: الماتش اتلغى" : "اتلغى"}</button>`}</div></div>`;
  }).join("");

  const fpid = S.form["adm-friend"] || "";
  const friendOpts = `<option value="">اختار لاعب</option>` + playerList().map((p) => `<option value="${esc(p.pid)}"${p.pid === fpid ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  let friend = "";
  if (fpid) {
    const prev = locked && S.preds[rid] && S.preds[rid][fpid] ? S.preds[rid][fpid].picks || {} : {};
    const ls = lateState(r, fpid);
    friend = `<div class="mlist">${r.matches.map((m) => {
      const pv = Array.isArray(prev[m.id]) ? prev[m.id] : [];
      const c0 = { v: val(`f|${rid}|${m.id}|0`, C.isGoal(pv[0]) ? pv[0] : ""), dirty: false, saved: false };
      const c1 = { v: val(`f|${rid}|${m.id}|1`, C.isGoal(pv[1]) ? pv[1] : ""), dirty: false, saved: false };
      const counts = locked ? `<label class="toggle-row sm"><span>يتحسب له${m.ko <= now() ? " (الماتش بدأ)" : ""}</span><input type="checkbox" data-k="fc|${esc(rid)}|${esc(m.id)}"${ls.counts(m) ? " checked" : ""}></label>` : "";
      return `<div class="m"><div class="mrow"><div class="${teamCls("home", m.h)}" lang="en">${esc(m.h)}</div><div class="scores">${scoreBox("f", rid, m, 0, c0)}<span class="dash">-</span>${scoreBox("f", rid, m, 1, c1)}</div><div class="${teamCls("away", m.a)}" lang="en">${esc(m.a)}</div></div>${counts}</div>`;
    }).join("")}</div>
    ${locked ? `<div class="late-box">
      <label class="toggle-row"><span>الدابل يتحسب له</span><input type="checkbox" data-k="fdbl|${esc(rid)}"${ls.dbl ? " checked" : ""}></label>
      <label class="toggle-row"><span>يبان "متأخر" جنب اسمه</span><input type="checkbox" data-k="fmark|${esc(rid)}"${ls.mark ? " checked" : ""}></label>
      <p class="hint">الجولة قفلت، فده توقع متأخر: الماتشات اللي بدأت مش هتتحسب له، والدابل مش هيتحسب له. غيّر العلامات لو اتفقتوا على غير كده.</p></div>` : ""}
    <div class="paste"><label class="eyebrow" for="friend-paste">أو الصق توقعاته</label><textarea class="inp" id="friend-paste" data-k="friend-paste" data-keep rows="4">${esc(S.form["friend-paste"] || "")}</textarea>
      <div class="actions"><button type="button" class="btn ghost sm" data-act="adm-friend-paste">املا</button></div></div>
    <div class="actions"><button type="button" class="btn" data-act="adm-friend-save">احفظ توقعات ${esc(nameOf(fpid))}</button></div>
    ${locked ? "" : `<p class="hint">اللي هتحفظه هيتحط مكان توقعاته للجولة دي. توقعات الناس مش بتبان لحد، ولا ليك، قبل القفل.</p>`}`;
  }
  return card(`<div class="card-h"><div><span class="eyebrow">${esc(COMPS[S.comp].short)}</span><h2>الجولات</h2></div></div>
    <div class="field"><label for="adm-rid">الجولة</label><select class="inp" id="adm-rid" data-k="adm-rid">${opts}</select></div>
    <p class="hint">${locked ? "الجولة قفلت. أي تعديل هنا بيعيد حساب النقط على طول." : `بتقفل ${esc(when(r.lock))}.`} النتايج بتتحدث لوحدها؛ عدّل بإيدك بس لو حاجة غلط.</p>
    <div class="mlist">${matches}</div>
    ${locked ? `<div class="actions"><button type="button" class="btn ghost sm" data-act="adm-recalc">احسب النقط من الأول</button></div>` : ""}
    <h3 class="sub">سجّل توقعات حد بداله</h3>
    <div class="field"><label for="adm-friend">اللاعب</label><select class="inp" id="adm-friend" data-k="adm-friend">${friendOpts}</select></div>${friend}`);
}

async function loadPreds(rid) {
  if (S.preds[rid]) return S.preds[rid];
  const list = await F.getAll(`rounds/${rid}/preds`);
  return Object.fromEntries(list.map(({ id, ...d }) => [id, d]));
}
async function saveRoundMatches(r, matches) {
  const clean = JSON.parse(JSON.stringify(matches));
  const next = { ...r, matches: clean };
  const data = { matches: clean, done: C.roundDone(next) };
  if (r.lock <= now()) data.points = C.roundPoints(next, await loadPreds(r.id));
  await F.patch(`rounds/${r.id}`, data);
}
async function admMatch(mid, change, msg) {
  const r = roundById(S.adm.rid);
  if (!r) return;
  const matches = r.matches.map((m) => (m.id === mid ? change({ ...m }) : m));
  try { await saveRoundMatches(r, matches); toast(msg); } catch (e) { toast(errText(e), true); }
}
function formGoal(k) {
  const v = S.form[k];
  return v === undefined ? undefined : v === "" ? null : Number(v);
}

async function seedSave() {
  const comp = S.comp, rows = S.adm.seed || [];
  const ops = rows.map((r) => {
    const ex = S.players[r.pid];
    const data = { start: { [comp]: r.p }, at: F.SERVER_TIME };
    if (r.x != null) data.startX = { [comp]: r.x };
    if (!ex) Object.assign(data, { name: r.name, uid: null, start: { PL: 0, UCL: 0, [comp]: r.p }, startX: { PL: 0, UCL: 0, [comp]: r.x || 0 } });
    return { op: "merge", path: `players/${r.pid}`, data };
  });
  try { await F.batch(ops); S.adm.seed = null; S.adm.seedBad = []; S.form.seed = ""; toast(`اتحفظ ✓ ${rows.length} لاعب`); render(); }
  catch (e) { toast(errText(e), true); }
}

/* ---------- share the round's star as a picture ---------- */

async function shareRound(rid) {
  const r = roundById(rid);
  if (!r) return;
  const preds = S.preds[rid] || (await loadPreds(rid).catch(() => ({})));
  const pts = C.roundPoints(r, preds);
  const { top, rocket, hit } = roundAwards(r, pts, preds);
  if (!top) return toast("مفيش نجم للجولة دي", true);
  try { await document.fonts.ready; } catch { /* fonts optional */ }
  const W = 1080, c = document.createElement("canvas");
  c.width = W; c.height = W;
  const g = c.getContext("2d");
  g.fillStyle = "#0F4A34"; g.fillRect(0, 0, W, W);
  g.fillStyle = "rgba(255,255,255,0.04)";
  for (let i = 0; i < 8; i += 2) g.fillRect((i * W) / 8, 0, W / 8, W);
  g.strokeStyle = "rgba(240,246,241,0.2)"; g.lineWidth = 4; g.strokeRect(60, 60, W - 120, W - 120);
  g.direction = "rtl"; g.textAlign = "center"; g.textBaseline = "middle";
  const FONT = '"Alexandria", "Noto Sans Arabic", sans-serif';
  const line = (txt, y, size, weight, color) => {
    let px = size;
    g.font = `${weight} ${px}px ${FONT}`;
    while (g.measureText(txt).width > W - 200 && px > 20) { px -= 2; g.font = `${weight} ${px}px ${FONT}`; }
    g.fillStyle = color; g.fillText(txt, W / 2, y);
  };
  line("دوري التوقعات", 150, 56, 800, "#F0F6F1");
  line(`${COMPS[r.comp].short} · ${r.label}`, 228, 38, 500, "#B5CFBE");
  line("⭐ نجم الجولة ⭐", 370, 46, 700, "#F5E5B2");
  line(names(top.pids), 480, 100, 800, "#FFFFFF");
  line(`${ptsWord(top.p)} · ${top.x} مظبوطة`, 580, 42, 500, "#F0F6F1");
  let y = 710;
  if (rocket) { line(`🚀 الصاروخ: ${names(rocket.pids)}، طلع ${placesWord(rocket.up)}`, y, 38, 600, "#F0F6F1"); y += 95; }
  if (hit) { line(`🎯 أحلى توقعة: ${names(hit.pids)} جاب \u2066${hit.m.hg}-${hit.m.ag}\u2069`, y, 34, 500, "#B5CFBE"); line(`${hit.m.h} - ${hit.m.a}`, y + 55, 32, 500, "#B5CFBE"); }
  line(location.host, 965, 30, 400, "#B5CFBE");
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  if (!blob) return toast("مقدرتش أعمل الصورة", true);
  const file = new File([blob], `star-${r.id}.png`, { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: `⭐ نجم ${COMPS[r.comp].short} ${r.label}: ${names(top.pids)}` });
      return;
    }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("الصورة اتنزلت، ابعتها للجروب");
}

/* ---------- events ---------- */

const ACTS = {
  "tab": (el) => { S.tab = el.dataset.tab; S.pasteMiss = []; window.scrollTo(0, 0); render(); },
  "comp": (el) => { S.comp = el.dataset.comp; local.set("comp", S.comp); S.adm.rid = null; render(); },
  "sel-round": (el) => { S.sel[S.comp] = el.dataset.rid; S.pasteMiss = []; render(); },
  "save": (el) => save(el.dataset.rid),
  "paste-toggle": () => { S.pasteOpen = !S.pasteOpen; render(); },
  "paste": (el) => paste(el.dataset.rid),
  "more": () => { S.more[S.comp] = true; render(); },
  "auth-pick": (el) => {
    const p = S.players[el.dataset.pid];
    if (!p) return;
    S.auth = { step: p.uid ? "login" : "claim", pid: el.dataset.pid, err: "" };
    render();
    setTimeout(() => { const i = $("#auth-pass"); if (i) i.focus(); }, 50);
  },
  "auth-step": (el) => { S.auth = { step: el.dataset.step, pid: null, err: "" }; render(); },
  "claim-owner": async () => {
    try { await F.put("config/owner", { uid: S.user.uid, at: F.SERVER_TIME }); toast("بقيت المشرف ✓"); }
    catch (e) { toast(errText(e), true); }
  },
  "logout": async () => {
    if (anyDirty() && !arm("logout")) { toast("عندك توقعات ما اتحفظتش. دوس خروج تاني لو متأكد", true); return; }
    await F.logOut();
  },
  "push-on": () => enablePush(),
  "push-off": () => disablePush(),
  "push-test": () => testPush(),
  "push-results": (el) => toggleResults(el.checked),
  "install": async () => {
    const e = S.installEvt;
    if (!e) return;
    e.prompt();
    try { await e.userChoice; } catch { /* dismissed */ }
    S.installEvt = null; render();
  },
  "seed-preview": async () => {
    const { rows, bad } = C.parseStandings(S.form.seed || "");
    for (const r of rows) r.pid = await C.pidFor(r.name);
    S.adm.seed = rows.length ? rows : null;
    S.adm.seedBad = bad;
    if (!rows.length) toast("ماعرفتش أقرا ولا سطر", true);
    render();
  },
  "seed-save": () => seedSave(),
  "seed-clear": () => { S.adm.seed = null; S.adm.seedBad = []; render(); },
  "adm-edit": (el) => { S.adm.edit = S.adm.edit === el.dataset.pid ? null : el.dataset.pid; render(); },
  "adm-save-player": async (el) => {
    const pid = el.dataset.pid, p = S.players[pid];
    if (!p) return;
    const g = (k, d) => (S.form[k] !== undefined ? S.form[k] : d);
    const n = (v) => { const x = Number(C.westernDigits(String(v)).trim()); return Number.isFinite(x) ? Math.round(x) : 0; };
    const name = C.cleanName(g(`pe|${pid}|name`, p.name));
    if (!validName(name)) return toast("الاسم قصير أو طويل قوي", true);
    const start = {}, startX = {};
    for (const c of COMP_KEYS) { start[c] = n(g(`pe|${pid}|${c}|p`, (p.start || {})[c] || 0)); startX[c] = n(g(`pe|${pid}|${c}|x`, (p.startX || {})[c] || 0)); }
    try {
      await F.patch(`players/${pid}`, { name, start, startX, at: F.SERVER_TIME });
      for (const k of Object.keys(S.form)) if (k.startsWith(`pe|${pid}|`)) delete S.form[k];
      S.adm.edit = null; toast("اتحفظ ✓"); render();
    } catch (e) { toast(errText(e), true); }
  },
  "adm-unlink": async (el) => {
    const pid = el.dataset.pid;
    if (!arm(`unlink:${pid}`)) return;
    try { await F.patch(`players/${pid}`, { uid: null, at: F.SERVER_TIME }); toast("اتفك الربط ✓"); } catch (e) { toast(errText(e), true); }
  },
  "adm-delete": async (el) => {
    const pid = el.dataset.pid;
    if (!arm(`del:${pid}`)) return;
    try { await F.remove(`players/${pid}`); S.adm.edit = null; toast("اتمسح"); } catch (e) { toast(errText(e), true); }
  },
  "adm-result": (el) => {
    const mid = el.dataset.mid, rid = S.adm.rid;
    const h = formGoal(`r|${rid}|${mid}|0`), a = formGoal(`r|${rid}|${mid}|1`);
    const m = roundById(rid) && roundById(rid).matches.find((x) => x.id === mid);
    if (!m) return;
    const hg = h === undefined ? m.hg : h, ag = a === undefined ? m.ag : a;
    if (!C.isGoal(hg) || !C.isGoal(ag)) return toast("اكتب النتيجة الأول", true);
    admMatch(mid, (x) => Object.assign(x, { hg, ag, st: "FINISHED", manual: true }), "النتيجة اتسجلت ✓");
  },
  "adm-auto": (el) => admMatch(el.dataset.mid, (x) => { delete x.manual; return x; }, "هترجع تلقائي في التحديث الجاي"),
  "adm-cancel": (el) => {
    if (!arm(`cancel:${el.dataset.mid}`)) return;
    admMatch(el.dataset.mid, (x) => Object.assign(x, { st: "CANCELLED", hg: null, ag: null, manual: true }), "الماتش اتلغى ومش هيتحسب");
  },
  "adm-dbl": (el) => admMatch(el.dataset.mid, (x) => Object.assign(x, { dbl: !x.dbl }), "اتعدّل ✓"),
  "adm-recalc": async () => {
    const r = roundById(S.adm.rid);
    if (!r) return;
    try { await saveRoundMatches(r, r.matches); toast("النقط اتحسبت ✓"); } catch (e) { toast(errText(e), true); }
  },
  "share": (el) => shareRound(el.dataset.rid),
  "adm-add": async () => {
    const uid = S.form["adm-new"];
    if (!uid) return toast("اختار حد الأول", true);
    try {
      await F.patch("config/owner", { admins: [...new Set([...((S.owner && S.owner.admins) || []), uid])] });
      S.form["adm-new"] = ""; toast("بقى مشرف ✓");
    } catch (e) { toast(errText(e), true); }
  },
  "adm-rm": async (el) => {
    const uid = el.dataset.uid;
    if (!arm(`rm:${uid}`)) return;
    try { await F.patch("config/owner", { admins: ((S.owner && S.owner.admins) || []).filter((u) => u !== uid) }); toast("اتشال من المشرفين"); }
    catch (e) { toast(errText(e), true); }
  },
  "adm-friend-paste": () => {
    const r = roundById(S.adm.rid);
    if (!r) return;
    const { filled, unmatched } = C.parsePicks(S.form["friend-paste"] || "", r.matches);
    for (const f of filled) { S.form[`f|${r.id}|${f.mid}|0`] = String(f.h); S.form[`f|${r.id}|${f.mid}|1`] = String(f.a); }
    toast(`اتملى ${games(filled.length)}${unmatched.length ? ` · ماعرفتش ${unmatched.length}` : ""}`, !filled.length);
    if (filled.length) S.form["friend-paste"] = "";
    render();
  },
  "adm-friend-save": async () => {
    const r = roundById(S.adm.rid), fpid = S.form["adm-friend"];
    if (!r || !fpid || !S.players[fpid]) return;
    const locked = r.lock <= now();
    const prev = locked && S.preds[r.id] && S.preds[r.id][fpid] ? S.preds[r.id][fpid].picks || {} : {};
    const picks = {};
    for (const m of r.matches) {
      const pv = Array.isArray(prev[m.id]) ? prev[m.id] : [];
      const h = formGoal(`f|${r.id}|${m.id}|0`), a = formGoal(`f|${r.id}|${m.id}|1`);
      const hv = h === undefined ? pv[0] : h, av = a === undefined ? pv[1] : a;
      if (C.isGoal(hv) && C.isGoal(av)) picks[m.id] = [hv, av];
      else if (hv != null || av != null) return toast(`كمّل نتيجة ${m.h} و${m.a}`, true);
    }
    const n = C.countPicks(picks, r.matches);
    try {
      await F.batch([
        { op: "put", path: `rounds/${r.id}/preds/${fpid}`, data: { uid: S.players[fpid].uid || null, picks, at: F.SERVER_TIME, by: S.user.uid } },
        { op: "put", path: `rounds/${r.id}/subs/${fpid}`, data: { n, at: F.SERVER_TIME } },
      ]);
      if (locked) {
        const ls = lateState(r, fpid);
        const adj = { ...(r.adj || {}), [fpid]: { late: now(), skip: r.matches.filter((m) => !ls.counts(m)).map((m) => String(m.id)), noDbl: !ls.dbl, mark: ls.mark } };
        const preds = { ...(await loadPreds(r.id)), [fpid]: { picks } };
        await F.patch(`rounds/${r.id}`, { adj, points: C.roundPoints({ ...r, adj }, preds) });
      }
      clearFriendForm();
      toast(`اتحفظ ✓ ${n} ماتش لـ ${nameOf(fpid)}`);
      render();
    } catch (e) { toast(errText(e), true); }
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "INPUT") return;
  const fn = ACTS[el.dataset.act];
  if (fn) fn(el, e);
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.tagName === "INPUT" && el.type === "checkbox" && el.dataset.act) { const fn = ACTS[el.dataset.act]; if (fn) fn(el, e); return; }
  if (el.tagName === "INPUT" && el.type === "checkbox" && el.dataset.k) { S.form[el.dataset.k] = el.checked ? "1" : "0"; return; }
  if (el.tagName !== "SELECT" || !el.dataset.k) return;
  S.form[el.dataset.k] = el.value;
  if (el.dataset.k === "adm-rid") { S.adm.rid = el.value; clearFriendForm(); for (const k of Object.keys(S.form)) if (k.startsWith("r|")) delete S.form[k]; }
  if (el.dataset.k === "adm-friend") clearFriendForm();
  render();
});

function focusNext(el) {
  const group = el.closest(".mlist") || document;
  const boxes = $$(".sc:not(:disabled)", group);
  const i = boxes.indexOf(el);
  if (i >= 0 && i < boxes.length - 1) boxes[i + 1].focus();
  else el.blur();
}

document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.k) return;
  if (el.classList.contains("sc")) {
    const v = C.westernDigits(el.value).replace(/\D/g, "").slice(0, 2);
    if (v !== el.value) el.value = v;
    const [kind, rid, mid, i] = el.dataset.k.split("|");
    if (kind === "p") {
      setDraft(rid, mid, Number(i), v === "" ? null : Number(v));
      const c = cell(rid, mid, Number(i));
      el.classList.toggle("dirty", c.dirty);
      el.classList.toggle("saved", !c.dirty && c.saved);
      updateSavebar();
    } else S.form[el.dataset.k] = v;
    if (v.length >= 1 && e.inputType && !e.inputType.startsWith("delete")) focusNext(el);
    return;
  }
  if (el.dataset.keep !== undefined) S.form[el.dataset.k] = el.value;
});

document.addEventListener("focusin", (e) => {
  const el = e.target;
  // select() also focuses in Chrome, so only select a box that still has the focus
  if (el.classList && el.classList.contains("sc")) setTimeout(() => { if (document.activeElement === el) try { el.select(); } catch { /* gone */ } }, 0);
});

document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.matches || !d.matches("details.rres")) return;
  const rid = d.dataset.rid;
  if (S.open[rid] === d.open) return;
  const list = lockedRounds(S.comp);
  const i = list.findIndex((r) => r.id === rid);
  if (isOpen(rid, i) === d.open) { S.open[rid] = d.open; return; }
  S.open[rid] = d.open;
  render();
}, true);

document.addEventListener("submit", (e) => {
  const f = e.target;
  if (!f.dataset || !f.dataset.form) return;
  e.preventDefault();
  const v = (k) => S.form[k] || "";
  switch (f.dataset.form) {
    case "login": return login(S.auth.pid, v("auth-pass"));
    case "claim": return register(nameOf(S.auth.pid), v("auth-pass"), v("auth-pass2"), S.auth.pid);
    case "new": return register(v("auth-name"), v("auth-pass"), v("auth-pass2"));
    case "typed": return C.pidFor(v("auth-name")).then((pid) => login(pid, v("auth-pass")));
    case "finish": return finishSignup(v("fin-name"));
    case "pass": return changePass(v("pw-old"), v("pw-new"), v("pw-new2"));
  }
});

window.addEventListener("beforeunload", (e) => { if (anyDirty()) { e.preventDefault(); e.returnValue = ""; } });
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvt = e; render(); });
window.addEventListener("appinstalled", () => { S.installEvt = null; render(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
setInterval(() => {
  if (S.nextLock && now() >= S.nextLock) return render();
  for (const el of $$("[data-cd]")) el.textContent = leftText(Number(el.dataset.cd) - now());
}, 15000);

/* ---------- live data ---------- */

const W = new Map();
const retry = (key) => () => setTimeout(() => {
  const stop = W.get(key);
  if (!stop) return;
  try { stop(); } catch { /* already stopped */ }
  W.delete(key);
  render();
}, 20000);
const predsWatch = (rid) => () => F.watchCol(`rounds/${rid}/preds`, (list) => {
  S.preds[rid] = Object.fromEntries(list.map(({ id, ...d }) => [id, d]));
  render();
}, retry(`preds:${rid}`));

function watchers() {
  const want = new Map();
  const signed = !!S.user;
  want.set(`players:${signed ? 1 : 0}`, () => F.watchCol("players", (list) => {
    S.players = Object.fromEntries(list.map(({ id, ...p }) => [id, p]));
    S.playersReady = true; S.playersErr = false;
    render();
  }, () => { S.playersErr = true; S.playersReady = true; render(); }));
  if (signed) {
    want.set("owner", () => F.watchDoc("config/owner", (d) => { S.owner = d; render(); }, () => { S.owner = null; render(); }));
    want.set("rounds", () => F.watchCol("rounds", (list) => {
      S.rounds = list; S.roundsReady = true; S.roundsErr = null;
      render();
    }, (e) => { S.roundsReady = true; S.roundsErr = F.errCode(e); render(); }));
    if (S.pid) want.set("push", () => F.watchDoc(`push/${S.pid}`, (d) => { S.push = d; render(); }, () => { S.push = null; }));
    if (isOwner()) want.set("sync", () => F.watchDoc("config/sync", (d) => { S.sync = d; render(); }, () => { S.sync = null; render(); }));
    if (ready()) {
      for (const comp of COMP_KEYS) for (const r of openRounds(comp)) {
        want.set(`mine:${r.id}`, () => F.watchDoc(`rounds/${r.id}/preds/${S.pid}`, (d) => { S.mine[r.id] = d; render(); }, retry(`mine:${r.id}`)));
      }
      const r = S.tab === "predict" ? selectedOpen(S.comp) : null;
      if (r) want.set(`subs:${r.id}`, () => F.watchCol(`rounds/${r.id}/subs`, (list) => {
        S.subs[r.id] = Object.fromEntries(list.map(({ id, ...d }) => [id, d]));
        render();
      }, retry(`subs:${r.id}`)));
      if (S.tab === "results") lockedRounds(S.comp).forEach((x, i) => { if (isOpen(x.id, i) && (S.more[S.comp] || i < 5)) want.set(`preds:${x.id}`, predsWatch(x.id)); });
      if (S.tab === "admin" && isOwner() && S.adm.rid) {
        const x = roundById(S.adm.rid);
        if (x && x.lock <= now()) want.set(`preds:${x.id}`, predsWatch(x.id));
      }
    }
  }
  for (const [k, stop] of W) if (!want.has(k)) { try { stop(); } catch { /* ignore */ } W.delete(k); }
  for (const [k, start] of want) if (!W.has(k)) W.set(k, start());
}

/* ---------- start ---------- */

F.init(firebaseConfig);
F.onUser((u) => {
  if (!u) {
    Object.assign(S, { user: null, pid: null, owner: undefined, rounds: [], roundsReady: false, mine: {}, drafts: {}, subs: {}, preds: {}, open: {},
      push: undefined, sync: undefined, tab: "predict", form: {}, adm: { rid: null, edit: null, seed: null, seedBad: [], armed: null }, finishErr: "" });
    if (!S.busy) S.auth = { step: "pick", pid: null, err: "" };
  } else {
    S.user = u;
    S.pid = u.email ? u.email.split("@")[0] : null;
  }
  render();
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(refreshDevKey).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type !== "open" || !d.url) return;
    const q = new URL(d.url, location.href).searchParams;
    if (TABS.includes(q.get("tab"))) S.tab = q.get("tab");
    if (compOr(q.get("comp"))) S.comp = q.get("comp");
    render();
  });
}
render();
