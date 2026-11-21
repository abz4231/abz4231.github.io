// Firebase web config for the tawaqoat-league project. These values are public by design:
// access is controlled by firestore.rules, not by keeping them secret.
export const firebaseConfig = {
  apiKey: "AIzaSyB5HcLOw8sqp2pkwAr5oksHZatAKkcJSi0",
  authDomain: "tawaqoat-league.firebaseapp.com",
  projectId: "tawaqoat-league",
  storageBucket: "tawaqoat-league.firebasestorage.app",
  messagingSenderId: "98100912812",
  appId: "1:98100912812:web:a9fba12cffca80c85c3509",
};

// Accounts are created from the player's name; this domain is never emailed.
export const EMAIL_DOMAIN = "tawaqoat.app";

// Public half of the notification (VAPID) key pair. The private half is the VAPID_PRIVATE secret in GitHub.
export const VAPID_PUBLIC = "BFEvJdE5gjui-vHF7JH-i6X_O75ZorPE_ecM6O5RbQuyPnxWgq-pGb_wIMRVymbFbhj9EDVPDX8It2TynOHdo80";

// Competitions the league plays and the first round the app runs (earlier rounds come in as starting points).
// doubles: one random match per match day counts twice, revealed after the deadline.
export const COMPS = {
  PL: { fd: "PL", name: "الدوري الإنجليزي", short: "الإنجليزي", startRound: 12 },
  UCL: { fd: "CL", name: "دوري أبطال أوروبا", short: "الأبطال", startRound: 6, doubles: true },
};
