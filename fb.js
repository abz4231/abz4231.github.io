// Thin wrapper over the Firebase SDK. The app only talks to this module, so tests can swap it
// for an in-memory copy. Timestamps come out as epoch milliseconds; write them with ts(ms).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  serverTimestamp, Timestamp, writeBatch, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let app, auth, db;

export function init(config) {
  app = initializeApp(config);
  auth = getAuth(app);
  try {
    db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: memoryLocalCache() });
  }
}

/* ---------- values ---------- */

class TS { constructor(ms) { this.ms = ms; } }
export const ts = (ms) => new TS(ms);
export const SERVER_TIME = { __server: true };
export const DELETE = { __delete: true };

function toStore(v) {
  if (v === SERVER_TIME) return serverTimestamp();
  if (v === DELETE) return deleteField();
  if (v instanceof TS) return Timestamp.fromMillis(v.ms);
  if (Array.isArray(v)) return v.map(toStore);
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = toStore(v[k]); return o; }
  return v;
}
function fromStore(v) {
  if (v instanceof Timestamp) return v.toMillis();
  if (Array.isArray(v)) return v.map(fromStore);
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = fromStore(v[k]); return o; }
  return v;
}
const ref = (path) => doc(db, path);
const cref = (path) => collection(db, path);

/* ---------- auth ---------- */

export function onUser(cb) {
  return onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email } : null));
}
export async function signUp(email, pass) { const c = await createUserWithEmailAndPassword(auth, email, pass); return { uid: c.user.uid, email: c.user.email }; }
export async function signIn(email, pass) { const c = await signInWithEmailAndPassword(auth, email, pass); return { uid: c.user.uid, email: c.user.email }; }
export async function logOut() { await signOut(auth); }
export async function changePassword(oldPass, newPass) {
  const u = auth.currentUser;
  await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, oldPass));
  await updatePassword(u, newPass);
}
// Firebase error code ("auth/wrong-password", "permission-denied", ...)
export const errCode = (e) => (e && (e.code || e.name)) || "unknown";

/* ---------- data ---------- */

export function watchDoc(path, cb, onErr) {
  return onSnapshot(ref(path), (s) => cb(s.exists() ? fromStore(s.data()) : null), (e) => onErr && onErr(e));
}
export function watchCol(path, cb, onErr) {
  return onSnapshot(cref(path), (s) => cb(s.docs.map((d) => ({ id: d.id, ...fromStore(d.data()) }))), (e) => onErr && onErr(e));
}
export async function getOne(path) { const s = await getDoc(ref(path)); return s.exists() ? fromStore(s.data()) : null; }
export async function getAll(path) { const s = await getDocs(cref(path)); return s.docs.map((d) => ({ id: d.id, ...fromStore(d.data()) })); }
export async function put(path, data) { await setDoc(ref(path), toStore(data)); }
export async function merge(path, data) { await setDoc(ref(path), toStore(data), { merge: true }); }
export async function patch(path, data) { await updateDoc(ref(path), toStore(data)); }
export async function remove(path) { await deleteDoc(ref(path)); }
// ops: [{ op: "put" | "merge" | "patch" | "remove", path, data }]
export async function batch(ops) {
  const b = writeBatch(db);
  for (const o of ops) {
    if (o.op === "put") b.set(ref(o.path), toStore(o.data));
    else if (o.op === "merge") b.set(ref(o.path), toStore(o.data), { merge: true });
    else if (o.op === "patch") b.update(ref(o.path), toStore(o.data));
    else if (o.op === "remove") b.delete(ref(o.path));
  }
  await b.commit();
}
