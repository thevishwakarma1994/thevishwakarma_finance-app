import { useState, type FormEvent } from "react";
import { ApiError } from "../apiClient.js";
import { ErrorState } from "../chrome.js";
import {
  firebaseConfigured,
  firebaseErrorMessage,
  sendResetEmail,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
} from "../firebase.js";

type Mode = "signin" | "signup" | "reset";

type Props = {
  onSignedIn: () => void;
};

export function SignIn({ onSignedIn }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = firebaseConfigured();

  async function finishSignedIn() {
    onSignedIn();
  }

  async function onGoogle() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await signInWithGoogle();
      if (result !== "redirect") {
        await finishSignedIn();
      }
    } catch (caught) {
      setError(firebaseErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "reset") {
        await sendResetEmail(email);
        setNotice("Check your email for a reset link");
        return;
      }
      if (mode === "signup") {
        await signUpWithEmail(email, password);
      } else {
        await signInWithEmail(email, password);
      }
      await finishSignedIn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : firebaseErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page" data-screen="sign-in">
      <header className="header" style={{ margin: "var(--space-6) 0 var(--space-4)" }}>
        <span className="header-slot" />
        <h1>Finance App</h1>
        <span className="header-slot" />
      </header>
      {!configured ? (
        <ErrorState message="Firebase is not configured. Add VITE_FIREBASE_* values to .env." />
      ) : (
        <div className="card stack">
          <button className="secondary" type="button" disabled={busy} onClick={() => void onGoogle()}>
            {busy ? "Please wait…" : "Continue with Google"}
          </button>
          <p className="or-divider">OR</p>
          <form className="stack" onSubmit={(event) => void onSubmit(event)}>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            {mode !== "reset" ? (
              <label>
                Password
                <input
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={6}
                />
              </label>
            ) : null}
            {error ? <ErrorState message={error} /> : null}
            {notice ? <p className="muted">{notice}</p> : null}
            <button className="primary" type="submit" disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "signup"
                  ? "Create account"
                  : mode === "reset"
                    ? "Send reset link"
                    : "Sign in"}
            </button>
          </form>
          {mode === "signin" ? (
            <p className="muted">
              New here?{" "}
              <button className="linkish" type="button" onClick={() => setMode("signup")}>
                Create account
              </button>
              {" · "}
              <button className="linkish" type="button" onClick={() => setMode("reset")}>
                Forgot password
              </button>
            </p>
          ) : (
            <p className="muted">
              <button
                className="linkish"
                type="button"
                onClick={() => {
                  setMode("signin");
                  setNotice(null);
                  setError(null);
                }}
              >
                Back to sign in
              </button>
            </p>
          )}
        </div>
      )}
    </main>
  );
}
