import { useEffect, useState, type FormEvent } from "react";
import { formatInr, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import { DateTime } from "luxon";
import { KOLKATA } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  applySalaryPolicy,
  fetchAccounts,
  fetchSalarySchedule,
  updateAccount,
  type Account,
  type SalaryScheduleView,
} from "../apiClient.js";
import { PageHeader, Sheet } from "../chrome.js";

type Props = {
  onBack: () => void;
};

function ordinal(day: number): string {
  const remainder = day % 10;
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  if (remainder === 1) return `${day}st`;
  if (remainder === 2) return `${day}nd`;
  if (remainder === 3) return `${day}rd`;
  return `${day}th`;
}

function formatDayMonth(iso: string): string {
  return DateTime.fromISO(iso, { zone: KOLKATA }).toFormat("d MMM");
}

export function ManageSalary({ onBack }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [schedule, setSchedule] = useState<SalaryScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [startDay, setStartDay] = useState("4");
  const [typicalDay, setTypicalDay] = useState("5");
  const [endDay, setEndDay] = useState("8");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayKolkata());

  function load() {
    return Promise.all([fetchAccounts(), fetchSalarySchedule()]).then(([accountData, scheduleData]) => {
      setAccounts(accountData.accounts);
      setSchedule(scheduleData);
    });
  }

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load salary");
    });
  }, []);

  const salaryAccount = accounts.find((account) => account.isPrimarySalary);
  const policy = schedule?.policy;

  function openEditor() {
    setAmount(policy ? String(policy.expectedAmountPaise / 100) : "79200");
    setStartDay(String(policy?.windowStartDay ?? 4));
    setTypicalDay(String(policy?.typicalDay ?? 5));
    setEndDay(String(policy?.windowEndDay ?? 8));
    setEffectiveFrom(todayKolkata());
    setEditing(true);
  }

  async function onSaveSchedule(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await applySalaryPolicy({
        expectedAmountPaise: parseInr(amount),
        windowStartDay: Number(startDay),
        typicalDay: Number(typicalDay),
        windowEndDay: Number(endDay),
        effectiveFrom,
      });
      setEditing(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save schedule");
    }
  }

  return (
    <>
      <PageHeader title="Salary" onBack={onBack} />
      <main className="page" data-screen="manage-salary">
        {error ? <p className="danger">{error}</p> : null}
        <p className="page-lead muted">Which account salary lands in, and when it is expected. Expected salary is not money in the bank.</p>

        <p className="section-label">Primary salary account</p>
        <button className="list-row" type="button" onClick={() => setPicking(true)}>
          <span className="list-row-copy">
            <span className="list-row-title">{salaryAccount ? salaryAccount.displayName : "None selected"}</span>
            {salaryAccount ? (
              <span className="muted">{salaryAccount.kind === "cash" ? "Cash" : "Bank"}</span>
            ) : (
              <span className="muted">Choose the account salary is deposited into</span>
            )}
          </span>
          <span className="muted">Change</span>
        </button>

        <p className="section-label">Salary schedule</p>
        {policy ? (
          <div className="status-block">
            <p className="list-row-title">Expected salary</p>
            <p>{formatInr(paise(policy.expectedAmountPaise))}</p>
            <p className="muted">Usually arrives {ordinal(policy.typicalDay ?? policy.windowStartDay)}</p>
            <p className="muted">
              Arrival window {ordinal(policy.windowStartDay)}–{ordinal(policy.windowEndDay)}
            </p>
            {schedule?.nextExpected ? (
              <p className="muted">Next expected {formatDayMonth(schedule.nextExpected.typicalOn)}</p>
            ) : null}
            <button className="secondary compact" type="button" onClick={openEditor} style={{ marginTop: 12 }}>
              Change schedule
            </button>
          </div>
        ) : (
          <div className="status-block">
            <p className="list-row-title">Not configured</p>
            <p className="muted">Add a schedule to track when salary is expected. It will not add cash until you record a payday.</p>
            <button className="secondary compact" type="button" onClick={openEditor} style={{ marginTop: 12 }}>
              Add schedule
            </button>
          </div>
        )}
      </main>
      {picking ? (
        <Sheet title="Salary account" onClose={() => setPicking(false)}>
          {accounts.length === 0 ? (
            <p className="muted">Add a bank account first, then mark it as the salary account.</p>
          ) : null}
          {accounts.map((account) => (
            <button
              className="list-row"
              type="button"
              key={account.id}
              onClick={() =>
                void updateAccount({ accountId: account.id, isPrimarySalary: true })
                  .then(() => {
                    setPicking(false);
                    return load();
                  })
                  .catch((caught: unknown) => {
                    setError(caught instanceof ApiError ? caught.message : "Could not update");
                  })
              }
            >
              <span className="list-row-copy">
                <span className="list-row-title">{account.displayName}</span>
                <span className="muted">{account.kind === "cash" ? "Cash" : "Bank"}</span>
              </span>
              <span className="muted">{account.isPrimarySalary ? "Current" : "Use this"}</span>
            </button>
          ))}
        </Sheet>
      ) : null}
      {editing ? (
        <Sheet title={policy ? "Change schedule" : "Add schedule"} onClose={() => setEditing(false)}>
          <form className="sheet-form" onSubmit={(event) => void onSaveSchedule(event)}>
            <label>
              Expected monthly salary
              <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
            </label>
            <label>
              Window start day
              <input inputMode="numeric" value={startDay} onChange={(event) => setStartDay(event.target.value)} required />
            </label>
            <label>
              Typical salary day
              <input inputMode="numeric" value={typicalDay} onChange={(event) => setTypicalDay(event.target.value)} required />
            </label>
            <label>
              Window end day
              <input inputMode="numeric" value={endDay} onChange={(event) => setEndDay(event.target.value)} required />
            </label>
            <label>
              Effective from
              <input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} required />
            </label>
            <p className="muted">Earlier months keep the previous expected amount.</p>
            <button className="primary" type="submit">
              Save schedule
            </button>
          </form>
        </Sheet>
      ) : null}
    </>
  );
}
