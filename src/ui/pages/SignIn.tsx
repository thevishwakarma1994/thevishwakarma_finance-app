import { useState, type FormEvent } from "react";
import { ApiError, signIn } from "../apiClient.js";

type Props = {
  onSignedIn: () => void;
};

export function SignIn({ onSignedIn }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(password);
      onSignedIn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Sign in</h1>
      </header>
      <form className="card stack" onSubmit={onSubmit}>
        <p className="muted">One owner. Enter the workspace password.</p>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? <p className="danger">{error}</p> : null}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </main>
  );
}
