import { useState, useRef } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  applyOpeningCard,
  correctOpeningCard,
  applyOpeningClaim,
  correctOpeningClaim,
  applyOpeningReservation,
  correctOpeningReservation,
  ApiError,
  type Account,
} from "../apiClient.js";

// Helper to generate and persist a command ID for the lifetime of a submission attempt
function useCommandId() {
  const ref = useRef<string | null>(null);
  return () => {
    if (!ref.current) {
      ref.current = crypto.randomUUID();
    }
    return ref.current;
  };
}

export function OpeningCardDebtForm({
  cardId,
  cycleId,
  isCorrection,
  currentAmountPaise,
  onDone,
}: {
  cardId: string;
  cycleId: string;
  isCorrection: boolean;
  currentAmountPaise: number;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(isCorrection ? (currentAmountPaise / 100).toString() : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const getCommandId = useCommandId();

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const num = Math.round(parseFloat(amount) * 100);
        if (isNaN(num) || num < 0) {
          setError("Invalid amount");
          return;
        }
        setSubmitting(true);
        setError(null);
        
        const now = new Date();
        const occurredOn = todayKolkata();
        const capturedAt = now.toISOString();
        const commandId = getCommandId();

        const promise = isCorrection
          ? correctOpeningCard({ commandId, occurredOn, capturedAt, creditCardId: cardId, billingCycleId: cycleId, targetAmountPaise: num })
          : applyOpeningCard({ commandId, occurredOn, capturedAt, creditCardId: cardId, billingCycleId: cycleId, amountPaise: num });

        promise
          .then(() => onDone())
          .catch((err) => {
            setError(err instanceof ApiError ? err.message : "Failed to save");
            setSubmitting(false);
          });
      }}
    >
      <p className="muted">
        {isCorrection
          ? "Correct the opening debt that existed on this card before app tracking began."
          : "Record the debt that already existed on this card before app tracking began."}
      </p>
      <label>
        Amount (₹)
        <input
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={submitting}
          autoFocus
          required
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="stack" style={{ flexDirection: "row", marginTop: "1rem" }}>
        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Saving..." : "Save"}
        </button>
        <button className="secondary" type="button" onClick={onDone} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function OpeningClaimForm({
  personId,
  isCorrection,
  claimId,
  currentAmountPaise,
  onDone,
}: {
  personId: string;
  isCorrection: boolean;
  claimId?: string;
  currentAmountPaise?: number;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(isCorrection ? ((currentAmountPaise ?? 0) / 100).toString() : "");
  const [direction, setDirection] = useState<"they_owe_user" | "user_owes_them">("they_owe_user");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const getCommandId = useCommandId();

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const num = Math.round(parseFloat(amount) * 100);
        if (isNaN(num) || num < 0) {
          setError("Invalid amount");
          return;
        }
        setSubmitting(true);
        setError(null);
        
        const now = new Date();
        const occurredOn = todayKolkata();
        const capturedAt = now.toISOString();
        const commandId = getCommandId();

        const promise = isCorrection
          ? correctOpeningClaim({ commandId, occurredOn, capturedAt, claimId: claimId!, targetAmountPaise: num })
          : applyOpeningClaim({ commandId, occurredOn, capturedAt, personId, direction, amountPaise: num });

        promise
          .then(() => onDone())
          .catch((err) => {
            setError(err instanceof ApiError ? err.message : "Failed to save");
            setSubmitting(false);
          });
      }}
    >
      <p className="muted">
        {isCorrection
          ? "Correct the opening balance that existed with this person before app tracking began."
          : "Record the balance that already existed with this person before app tracking began."}
      </p>
      
      {!isCorrection && (
        <div className="stack" style={{ marginBottom: "1rem" }}>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: "normal" }}>
            <input 
              type="radio" 
              name="direction" 
              checked={direction === "they_owe_user"} 
              onChange={() => setDirection("they_owe_user")} 
              disabled={submitting} 
            />
            They owe me
          </label>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: "normal" }}>
            <input 
              type="radio" 
              name="direction" 
              checked={direction === "user_owes_them"} 
              onChange={() => setDirection("user_owes_them")} 
              disabled={submitting} 
            />
            I owe them
          </label>
        </div>
      )}

      <label>
        Amount (₹)
        <input
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={submitting}
          autoFocus
          required
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="stack" style={{ flexDirection: "row", marginTop: "1rem" }}>
        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Saving..." : "Save"}
        </button>
        <button className="secondary" type="button" onClick={onDone} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function OpeningEarmarkForm({
  cycleId,
  accounts,
  isCorrection,
  reservationId,
  currentAmountPaise,
  onDone,
}: {
  cycleId: string;
  accounts: Account[];
  isCorrection: boolean;
  reservationId?: string;
  currentAmountPaise?: number;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(isCorrection ? ((currentAmountPaise ?? 0) / 100).toString() : "");
  const [accountId, setAccountId] = useState(accounts.length > 0 ? accounts[0]?.id ?? "" : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const getCommandId = useCommandId();

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const num = Math.round(parseFloat(amount) * 100);
        if (isNaN(num) || num < 0) {
          setError("Invalid amount");
          return;
        }
        if (!isCorrection && !accountId) {
          setError("Select an account");
          return;
        }

        setSubmitting(true);
        setError(null);
        
        const now = new Date();
        const occurredOn = todayKolkata();
        const capturedAt = now.toISOString();
        const commandId = getCommandId();

        const promise = isCorrection
          ? correctOpeningReservation({ commandId, occurredOn, capturedAt, reservationId: reservationId!, targetAmountPaise: num })
          : applyOpeningReservation({ commandId, occurredOn, capturedAt, sourceAccountId: accountId, billingCycleId: cycleId, amountPaise: num });

        promise
          .then(() => onDone())
          .catch((err) => {
            setError(err instanceof ApiError ? err.message : "Failed to save");
            setSubmitting(false);
          });
      }}
    >
      <p className="muted">
        {isCorrection
          ? "Correct the amount of money earmarked for this cycle."
          : "Mark part of existing money as reserved for this cycle. This does not change your account balance."}
      </p>
      
      {!isCorrection && (
        <label>
          Source Account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={submitting}>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.displayName} ({formatInr(paise(a.availablePaise))} available)</option>
            ))}
          </select>
        </label>
      )}

      <label>
        Amount (₹)
        <input
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={submitting}
          autoFocus
          required
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="stack" style={{ flexDirection: "row", marginTop: "1rem" }}>
        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Saving..." : "Save"}
        </button>
        <button className="secondary" type="button" onClick={onDone} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}
