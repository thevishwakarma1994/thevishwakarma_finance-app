import { useEffect, useState } from "react";
import { getMe } from "./apiClient.js";
import { SignIn } from "./pages/SignIn.js";
import { Home } from "./pages/Home.js";
import { StsExplain } from "./pages/StsExplain.js";
import { CanISpend } from "./pages/CanISpend.js";
import { Money } from "./pages/Money.js";
import { Activity } from "./pages/Activity.js";
import { Add } from "./pages/Add.js";
import { MonthReview } from "./pages/MonthReview.js";
import { CardDetail } from "./pages/CardDetail.js";
import { CycleDetail } from "./pages/CycleDetail.js";
import { People } from "./pages/People.js";
import { PersonDetail } from "./pages/PersonDetail.js";

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
            navigate("/");
          }}
        />
      </div>
    );
  }

  const current = path === "/" || path === "/sign-in" || path === "/home" ? "/" : path;
  const cardMatch = /^\/card\/([^/]+)$/.exec(current);
  const cycleMatch = /^\/cycle\/([^/]+)$/.exec(current);
  const personMatch = /^\/person\/([^/]+)$/.exec(current);

  return (
    <div className="app">
      {current === "/activity" ? (
        <Activity />
      ) : current === "/add" ? (
        <Add onDone={() => navigate("/activity")} />
      ) : current === "/month" ? (
        <MonthReview onOpenActivity={(href) => navigate(href)} />
      ) : current === "/people" ? (
        <People onOpenPerson={(id) => navigate(`/person/${id}`)} />
      ) : personMatch?.[1] ? (
        <PersonDetail personId={personMatch[1]} onBack={() => navigate("/people")} />
      ) : cardMatch?.[1] ? (
        <CardDetail
          cardId={cardMatch[1]}
          onBack={() => navigate("/money")}
          onOpenCycle={(cycleId) => navigate(`/cycle/${cycleId}`)}
        />
      ) : cycleMatch?.[1] ? (
        <CycleDetail
          cycleId={cycleMatch[1]}
          onBack={() => navigate("/money")}
        />
      ) : current === "/sts" ? (
        <StsExplain onBack={() => navigate("/")} />
      ) : current === "/can-i-spend" ? (
        <CanISpend onBack={() => navigate("/")} />
      ) : current === "/money" ? (
        <Money
          onOpenMonth={() => navigate("/month")}
          onOpenCard={(cardId) => navigate(`/card/${cardId}`)}
          onOpenCycle={(cycleId) => navigate(`/cycle/${cycleId}`)}
          onSignedOut={() => {
            setAuthed(false);
            navigate("/sign-in");
          }}
        />
      ) : (
        <Home
          onOpenExplanation={() => navigate("/sts")}
          onOpenAffordability={() => navigate("/can-i-spend")}
          onOpenMonth={() => navigate("/month")}
          onOpenPeople={() => navigate("/people")}
          onOpenCycle={(cycleId) => navigate(`/cycle/${cycleId}`)}
          onAdd={() => navigate("/add")}
          onSignedOut={() => {
            setAuthed(false);
            navigate("/sign-in");
          }}
        />
      )}
      <nav className="nav nav-five">
        <a className={current === "/" ? "active" : ""} href="/" onClick={(event) => {
          event.preventDefault();
          navigate("/");
        }}>
          Home
        </a>
        <a className={current === "/activity" || current.startsWith("/activity") ? "active" : ""} href="/activity" onClick={(event) => {
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
        <a className={current === "/people" || current.startsWith("/person/") ? "active" : ""} href="/people" onClick={(event) => {
          event.preventDefault();
          navigate("/people");
        }}>
          People
        </a>
        <a className={current === "/money" || current.startsWith("/card/") || current.startsWith("/cycle/") ? "active" : ""} href="/money" onClick={(event) => {
          event.preventDefault();
          navigate("/money");
        }}>
          Money
        </a>
      </nav>
    </div>
  );
}
