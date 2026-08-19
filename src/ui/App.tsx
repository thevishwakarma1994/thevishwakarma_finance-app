import { useAppearance } from "./appearance.js";
import { useEffect, useState } from "react";
import { useAuthSession } from "./authSession.js";
import { SignIn } from "./pages/SignIn.js";
import { Home } from "./pages/Home.js";
import { StsExplain } from "./pages/StsExplain.js";
import { CanISpend } from "./pages/CanISpend.js";
import { Money } from "./pages/Money.js";
import { Activity } from "./pages/Activity.js";
import { Add, AddChooser, type AddDefaults, type AddIntent } from "./pages/Add.js";
import { MonthReview } from "./pages/MonthReview.js";
import { CardDetail } from "./pages/CardDetail.js";
import { CycleDetail } from "./pages/CycleDetail.js";
import { People } from "./pages/People.js";
import { PersonDetail } from "./pages/PersonDetail.js";
import { ComingUp } from "./pages/ComingUp.js";
import { ObligationDetail } from "./pages/ObligationDetail.js";
import { Manage } from "./pages/Manage.js";
import { ManageAccounts } from "./pages/ManageAccounts.js";
import { ManageCards } from "./pages/ManageCards.js";
import { ManageCategories } from "./pages/ManageCategories.js";
import { ManageSalary } from "./pages/ManageSalary.js";
import { ManageBills } from "./pages/ManageBills.js";
import { AccountDetail } from "./pages/AccountDetail.js";
import { clearCachedHomeView } from "./homeCache.js";
import { PlusIcon } from "./chrome.js";
import { ActivityIcon, HomeIcon, MoneyIcon, PeopleIcon } from "./icons.js";

type AddSession =
  | { phase: "chooser"; afterSave: "activity" | "stay" }
  | {
      phase: "flow";
      intent: AddIntent;
      defaults?: AddDefaults;
      afterSave: "activity" | "stay";
      fromChooser: boolean;
    };

function pathOf(): string {
  return window.location.pathname;
}

function isRootTab(path: string): boolean {
  return path === "/" || path === "/activity" || path === "/people" || path === "/money";
}

function activeTab(path: string): "home" | "activity" | "people" | "money" {
  if (path === "/activity" || path.startsWith("/activity")) return "activity";
  if (path === "/people" || path.startsWith("/person/")) return "people";
  if (
    path === "/money" ||
    path.startsWith("/money/") ||
    path.startsWith("/card/") ||
    path.startsWith("/cycle/") ||
    path.startsWith("/account/")
  ) {
    return "money";
  }
  return "home";
}

export function App() {
  const { appearance, setAppearance } = useAppearance();
  const [path, setPath] = useState(pathOf);
  const [addSession, setAddSession] = useState<AddSession | null>(null);
  const [monthBack, setMonthBack] = useState("/");
  const { state, beginBootstrap, retry, signOut } = useAuthSession();

  useEffect(() => {
    const onPop = () => setPath(pathOf());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(to: string) {
    window.history.pushState({}, "", to);
    setPath(to);
  }

  function openMonth(from: string) {
    setMonthBack(from);
    navigate("/month");
  }

  function afterSignOut() {
    clearCachedHomeView();
    void signOut().then(() => navigate("/sign-in"));
  }

  if (state.phase === "initializing" || state.phase === "bootstrap_loading") {
    return (
      <div className="app page muted" data-auth-phase={state.phase}>
        Loading…
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <div className="app" data-auth-phase="denied">
        <main className="page">
          <header className="header">
            <span className="header-slot" />
            <h1>Access denied</h1>
            <span className="header-slot" />
          </header>
          <p className="danger">{state.message ?? "This account is disabled"}</p>
          <button className="secondary" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </main>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="app" data-auth-phase="error">
        <main className="page">
          <header className="header">
            <span className="header-slot" />
            <h1>Could not load your workspace</h1>
            <span className="header-slot" />
          </header>
          <p className="danger">{state.message ?? "Could not reach the server"}</p>
          <button className="primary" type="button" onClick={retry}>
            Retry
          </button>
        </main>
      </div>
    );
  }

  if (state.phase === "unauthenticated") {
    return (
      <div className="app" data-auth-phase="unauthenticated">
        <SignIn onSignedIn={beginBootstrap} />
      </div>
    );
  }

  const current = path === "/" || path === "/sign-in" || path === "/home" ? "/" : path;
  const cardMatch = /^\/card\/([^/]+)$/.exec(current);
  const cycleMatch = /^\/cycle\/([^/]+)$/.exec(current);
  const personMatch = /^\/person\/([^/]+)$/.exec(current);
  const obligationMatch = /^\/obligation\/([^/]+)$/.exec(current);
  const accountMatch = /^\/account\/([^/]+)$/.exec(current);
  const tab = activeTab(current);
  const showFab = isRootTab(current) && addSession === null;

  return (
    <div className="app" data-auth-phase="ready">
      {current === "/activity" ? (
        <Activity />
      ) : current === "/month" ? (
        <MonthReview onOpenActivity={(href) => navigate(href)} onBack={() => navigate(monthBack)} />
      ) : current === "/people" ? (
        <People onOpenPerson={(id) => navigate(`/person/${id}`)} />
      ) : personMatch?.[1] ? (
        <PersonDetail
          personId={personMatch[1]}
          onBack={() => navigate("/people")}
          onCapture={(intent, personId) =>
            setAddSession({
              phase: "flow",
              intent,
              defaults: { personId },
              afterSave: "stay",
              fromChooser: false,
            })
          }
        />
      ) : cardMatch?.[1] ? (
        <CardDetail
          cardId={cardMatch[1]}
          onBack={() => navigate("/money")}
          onOpenCycle={(cycleId) => navigate(`/cycle/${cycleId}`)}
          onCapture={(intent, defaults) =>
            setAddSession({
              phase: "flow",
              intent,
              defaults,
              afterSave: "stay",
              fromChooser: false,
            })
          }
        />
      ) : cycleMatch?.[1] ? (
        <CycleDetail
          cycleId={cycleMatch[1]}
          onBack={() => navigate("/money")}
          onCapture={(intent, defaults) =>
            setAddSession({
              phase: "flow",
              intent,
              defaults,
              afterSave: "stay",
              fromChooser: false,
            })
          }
        />
      ) : accountMatch?.[1] ? (
        <AccountDetail
          accountId={accountMatch[1]}
          onBack={() => navigate("/money")}
          onMoveMoney={(accountId) =>
            setAddSession({
              phase: "flow",
              intent: "transfer",
              defaults: { fromAccountId: accountId },
              afterSave: "stay",
              fromChooser: false,
            })
          }
        />
      ) : current === "/sts" ? (
        <StsExplain onBack={() => navigate("/")} />
      ) : current === "/can-i-spend" ? (
        <CanISpend onBack={() => navigate("/")} />
      ) : current === "/coming-up" ? (
        <ComingUp
          onBack={() => navigate("/")}
          onOpenCycle={(cycleId) => navigate(`/cycle/${cycleId}`)}
          onOpenObligation={(id) => navigate(`/obligation/${id}`)}
        />
      ) : obligationMatch?.[1] ? (
        <ObligationDetail instanceId={obligationMatch[1]} onBack={() => navigate("/coming-up")} />
      ) : current === "/money/manage" ? (
        <Manage
          appearance={appearance}
          onSelectAppearance={setAppearance}
          onBack={() => navigate("/money")}
          onOpenAccounts={() => navigate("/money/manage/accounts")}
          onOpenCards={() => navigate("/money/manage/cards")}
          onOpenCategories={() => navigate("/money/manage/categories")}
          onOpenSalary={() => navigate("/money/manage/salary")}
          onOpenBills={() => navigate("/money/manage/bills")}
          onSignOut={afterSignOut}
        />
      ) : current === "/money/manage/accounts" ? (
        <ManageAccounts onBack={() => navigate("/money/manage")} />
      ) : current === "/money/manage/cards" ? (
        <ManageCards onBack={() => navigate("/money/manage")} />
      ) : current === "/money/manage/categories" ? (
        <ManageCategories onBack={() => navigate("/money/manage")} />
      ) : current === "/money/manage/salary" ? (
        <ManageSalary onBack={() => navigate("/money/manage")} />
      ) : current === "/money/manage/bills" ? (
        <ManageBills onBack={() => navigate("/money/manage")} />
      ) : current === "/money" ? (
        <Money
          onOpenMonth={() => openMonth("/money")}
          onOpenCard={(cardId) => navigate(`/card/${cardId}`)}
          onOpenAccount={(accountId) => navigate(`/account/${accountId}`)}
          onOpenManage={() => navigate("/money/manage")}
        />
      ) : (
        <Home
          onOpenExplanation={() => navigate("/sts")}
          onOpenAffordability={() => navigate("/can-i-spend")}
          onOpenMonth={() => openMonth("/")}
          onOpenPeople={() => navigate("/people")}
          onOpenCycle={(cycleId) => navigate(`/cycle/${cycleId}`)}
          onOpenComingUp={() => navigate("/coming-up")}
          onOpenObligation={(id) => navigate(`/obligation/${id}`)}
          onOpenSalary={() => navigate("/money/manage/salary")}
          onOpenMoney={() => navigate("/money")}
        />
      )}
      {showFab ? (
        <button
          className="fab"
          type="button"
          aria-label="Add"
          data-fab="true"
          onClick={() => setAddSession({ phase: "chooser", afterSave: "activity" })}
        >
          <PlusIcon />
        </button>
      ) : null}
      <nav className="nav" data-primary-nav="true">
        <a
          className={tab === "home" ? "active" : ""}
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          <HomeIcon /><span>Home</span>
        </a>
        <a
          className={tab === "activity" ? "active" : ""}
          href="/activity"
          onClick={(event) => {
            event.preventDefault();
            navigate("/activity");
          }}
        >
          <ActivityIcon /><span>Activity</span>
        </a>
        <a
          className={tab === "people" ? "active" : ""}
          href="/people"
          onClick={(event) => {
            event.preventDefault();
            navigate("/people");
          }}
        >
          <PeopleIcon /><span>People</span>
        </a>
        <a
          className={tab === "money" ? "active" : ""}
          href="/money"
          onClick={(event) => {
            event.preventDefault();
            navigate("/money");
          }}
        >
          <MoneyIcon /><span>Money</span>
        </a>
      </nav>
      {addSession?.phase === "chooser" ? (
        <AddChooser
          onClose={() => setAddSession(null)}
          onPick={(intent) =>
            setAddSession({
              phase: "flow",
              intent,
              afterSave: addSession.afterSave,
              fromChooser: true,
            })
          }
        />
      ) : null}
      {addSession?.phase === "flow" ? (
        <Add
          intent={addSession.intent}
          defaults={addSession.defaults}
          onClose={() => setAddSession(null)}
          onBackToChooser={
            addSession.fromChooser
              ? () => setAddSession({ phase: "chooser", afterSave: addSession.afterSave })
              : undefined
          }
          onDone={() => {
            const stay = addSession.afterSave === "stay";
            setAddSession(null);
            if (!stay) navigate("/activity");
          }}
        />
      ) : null}
    </div>
  );
}
