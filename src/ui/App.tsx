import { useEffect, useState } from "react";
import { getMe } from "./apiClient.js";
import { SignIn } from "./pages/SignIn.js";
import { Money } from "./pages/Money.js";
import { Activity } from "./pages/Activity.js";
import { Add } from "./pages/Add.js";

function pathOf(): string {
  return window.location.pathname;
}

export function App() {
  const [path, setPath] = useState(pathOf);
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const onPop = () => setPath(pathOf());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then(() => {
        if (!cancelled) setAuthed(true);
      })
      .catch(() => {
        if (!cancelled) setAuthed(false);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  function navigate(to: string) {
    window.history.pushState({}, "", to);
    setPath(to);
  }

  if (!ready) {
    return <div className="app page muted">Loading…</div>;
  }

  if (!authed) {
    return (
      <div className="app">
        <SignIn
          onSignedIn={() => {
            setAuthed(true);
            navigate("/money");
          }}
        />
      </div>
    );
  }

  const current = path === "/" || path === "/sign-in" ? "/money" : path;

  return (
    <div className="app">
      {current === "/activity" ? (
        <Activity />
      ) : current === "/add" ? (
        <Add onDone={() => navigate("/activity")} />
      ) : (
        <Money onSignedOut={() => {
          setAuthed(false);
          navigate("/sign-in");
        }} />
      )}
      <nav className="nav">
        <a className={current === "/money" ? "active" : ""} href="/money" onClick={(event) => {
          event.preventDefault();
          navigate("/money");
        }}>
          Money
        </a>
        <a className={current === "/activity" ? "active" : ""} href="/activity" onClick={(event) => {
          event.preventDefault();
          navigate("/activity");
        }}>
          Activity
        </a>
        <a className={current === "/add" ? "active" : ""} href="/add" onClick={(event) => {
          event.preventDefault();
          navigate("/add");
        }}>
          Add
        </a>
      </nav>
    </div>
  );
}
