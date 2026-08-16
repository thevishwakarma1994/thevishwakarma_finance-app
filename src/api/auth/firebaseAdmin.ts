import { initializeApp, cert, getApps, type App, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { VerifiedIdentity } from "../../app/provisionUser.js";

export function normalizeFirebasePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

function credentialFromEnv() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    return cert(JSON.parse(json) as ServiceAccount);
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? normalizeFirebasePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
    : "";
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (clientEmail && privateKey && projectId) {
    return cert({ projectId, clientEmail, privateKey });
  }
  return undefined;
}

function firebaseApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || process.env.VITE_FIREBASE_PROJECT_ID?.trim();
  const credential = credentialFromEnv();
  if (credential) {
    return initializeApp({ credential, projectId });
  }
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID is required to verify ID tokens");
  }
  return initializeApp({ projectId });
}

export function assertFirebaseAdminConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID is required in production");
  }
  if (!credentialFromEnv() && !process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    throw new Error("Firebase Admin credentials are required in production");
  }
}

/** Always check revocation and Firebase-disabled users. Extra Auth round-trip is required for this app. */
export async function verifyFirebaseIdToken(token: string): Promise<VerifiedIdentity> {
  const decoded = await getAuth(firebaseApp()).verifyIdToken(token, true);
  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    displayName: decoded.name ?? null,
  };
}
