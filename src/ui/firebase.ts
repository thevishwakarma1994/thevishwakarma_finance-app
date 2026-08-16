import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";

export function firebaseWebConfig() {
  return {
    apiKey: (import.meta.env.VITE_FIREBASE_API_KEY ?? "").trim(),
    authDomain: (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "").trim(),
    projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "").trim(),
    appId: (import.meta.env.VITE_FIREBASE_APP_ID ?? "").trim(),
    messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "").trim() || undefined,
    storageBucket: (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "").trim() || undefined,
  };
}

export function firebaseConfigured(): boolean {
  const config = firebaseWebConfig();
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

function firebaseApp(): FirebaseApp {
  if (!firebaseConfigured()) {
    throw new Error(
      "Firebase web configuration is missing. Copy .env.example to .env and set VITE_FIREBASE_* values.",
    );
  }
  const existing = getApps()[0];
  if (existing) return existing;
  return initializeApp(firebaseWebConfig());
}

export function firebaseAuth(): Auth {
  return getAuth(firebaseApp());
}

export function subscribeAuth(listener: (user: User | null) => void): () => void {
  return onAuthStateChanged(firebaseAuth(), listener);
}

export async function currentIdToken(): Promise<string | null> {
  if (!firebaseConfigured()) return null;
  const user = firebaseAuth().currentUser;
  if (!user) return null;
  return user.getIdToken();
}

function prefersRedirectSignIn(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
  if (standalone) return true;
  return /iPhone|iPad|iPod|Android/i.test(nav.userAgent);
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export async function completeGoogleRedirect(): Promise<User | null> {
  if (!firebaseConfigured()) return null;
  try {
    const result = await getRedirectResult(firebaseAuth());
    return result?.user ?? null;
  } catch (error) {
    if (firebaseErrorCode(error) === "auth/popup-closed-by-user") return null;
    throw error;
  }
}

export async function signInWithGoogle(): Promise<"redirect" | User> {
  const auth = firebaseAuth();
  if (prefersRedirectSignIn()) {
    await signInWithRedirect(auth, googleProvider);
    return "redirect";
  }
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    const code = firebaseErrorCode(error);
    if (code === "auth/popup-blocked" || code === "auth/cancelled-popup-request") {
      await signInWithRedirect(auth, googleProvider);
      return "redirect";
    }
    throw error;
  }
}

export function signInWithEmail(email: string, password: string) {
  return signInWithEmailAndPassword(firebaseAuth(), email, password);
}

export function signUpWithEmail(email: string, password: string) {
  return createUserWithEmailAndPassword(firebaseAuth(), email, password);
}

export function sendResetEmail(email: string) {
  return sendPasswordResetEmail(firebaseAuth(), email);
}

export function signOutFirebase() {
  if (!firebaseConfigured()) return Promise.resolve();
  return firebaseSignOut(firebaseAuth());
}

export function firebaseErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return null;
}

export function firebaseErrorMessage(error: unknown): string {
  switch (firebaseErrorCode(error)) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Email or password is incorrect";
    case "auth/email-already-in-use":
      return "An account already exists for this email";
    case "auth/weak-password":
      return "Password should be at least 6 characters";
    case "auth/invalid-email":
      return "Enter a valid email address";
    case "auth/too-many-requests":
      return "Too many attempts. Try again later";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was cancelled";
    default:
      return error instanceof Error ? error.message : "Could not sign in";
  }
}
