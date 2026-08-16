import { afterEach, describe, expect, it } from "vitest";
import { assertFirebaseAdminConfig } from "../../src/api/auth/firebaseAdmin.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Firebase Admin production config", () => {
  it("allows missing admin credentials outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    expect(() => assertFirebaseAdminConfig()).not.toThrow();
  });

  it("refuses startup when production project id is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.FIREBASE_PROJECT_ID;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/unused.json";
    expect(() => assertFirebaseAdminConfig()).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it("refuses startup when production admin credentials are missing", () => {
    process.env.NODE_ENV = "production";
    process.env.FIREBASE_PROJECT_ID = "thevishwakarmafinanceapp";
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    expect(() => assertFirebaseAdminConfig()).toThrow(/Firebase Admin credentials/);
  });

  it("allows production when a service-account path is configured", () => {
    process.env.NODE_ENV = "production";
    process.env.FIREBASE_PROJECT_ID = "thevishwakarmafinanceapp";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/service-account.json";
    expect(() => assertFirebaseAdminConfig()).not.toThrow();
  });
});
