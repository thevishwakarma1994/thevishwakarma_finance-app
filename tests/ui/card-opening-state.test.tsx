/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type CardBody = Awaited<ReturnType<typeof import("../../src/ui/apiClient.js").fetchCard>>;

const api = vi.hoisted(() => ({
  fetchCard: vi.fn(),
  applyOpeningCard: vi.fn(async (_input: Record<string, unknown>) => ({ eventId: "evt-1" })),
  correctOpeningCard: vi.fn(async (_input: Record<string, unknown>) => ({ eventId: "evt-2" })),
}));

vi.mock("../../src/ui/apiClient.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/ui/apiClient.js")>(
    "../../src/ui/apiClient.js",
  );
  return {
    ApiError: actual.ApiError,
    fetchCard: api.fetchCard,
    fetchPeople: vi.fn(async () => ({ people: [] })),
    fetchAccounts: vi.fn(async () => ({ accounts: [] })),
    updateCard: vi.fn(async () => ({})),
    applyOpeningCard: api.applyOpeningCard,
    correctOpeningCard: api.correctOpeningCard,
    applyOpeningClaim: vi.fn(),
    correctOpeningClaim: vi.fn(),
    applyOpeningReservation: vi.fn(),
    correctOpeningReservation: vi.fn(),
  };
});

import { CardDetail } from "../../src/ui/pages/CardDetail.js";

/**
 * `transactions` is always empty here on purpose: listActivity never surfaces
 * opening meanings, so the opening actions must come from `openingCardState`.
 */
function cardBody(openingCardState: CardBody["openingCardState"]): CardBody {
  return {
    id: "c1",
    displayName: "Amex",
    issuer: "Amex",
    mask: "1001",
    label: "Amex •1001",
    creditLimitPaise: null,
    defaultPaymentAccountId: null,
    defaultOwnerPersonId: null,
    defaultOwnerName: null,
    status: "active",
    outstandingPaise: 20_000_00,
    currentCycle: null,
    nextDueOn: "2026-08-30",
    statementDay: 10,
    dueDaysAfterStatement: 20,
    cycles: [],
    transactions: [],
    openingCardState,
    openingReservations: [],
  } as unknown as CardBody;
}

const noOpening = {
  hasBaseOpening: false,
  billingCycleId: null,
  currentEffectiveAmountPaise: 0,
  baseEventId: null,
  canSetOpening: true,
  canCorrectOpening: false,
};

const correctableOpening = {
  hasBaseOpening: true,
  billingCycleId: "cycle-1",
  currentEffectiveAmountPaise: 20_000_00,
  baseEventId: "cmd-open-card",
  canSetOpening: false,
  canCorrectOpening: true,
};

const lockedOpening = {
  hasBaseOpening: true,
  billingCycleId: "cycle-1",
  currentEffectiveAmountPaise: 20_000_00,
  baseEventId: "cmd-open-card",
  canSetOpening: false,
  canCorrectOpening: false,
};

function renderCard() {
  render(
    <CardDetail cardId="c1" onBack={() => {}} onOpenCycle={() => {}} onCapture={() => {}} />,
  );
  return waitFor(() => screen.getByRole("heading", { name: "Amex •1001" }));
}

/** happy-dom does not perform implicit form submission from a submit button. */
function submitOpeningForm() {
  const form = screen.getByRole("dialog").querySelector("form");
  if (!form) throw new Error("Expected an opening form in the sheet");
  fireEvent.submit(form);
}

describe("CardDetail opening-debt provenance", () => {
  beforeEach(() => {
    api.fetchCard.mockReset();
    api.applyOpeningCard.mockClear();
    api.correctOpeningCard.mockClear();
  });

  afterEach(cleanup);

  it("offers Set opening debt when no base opening exists", async () => {
    api.fetchCard.mockResolvedValue(cardBody(noOpening));
    await renderCard();
    expect(screen.getByRole("button", { name: "Set opening debt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Correct opening debt" })).toBeNull();
  });

  it("offers Correct opening debt from the read model, not from activity history", async () => {
    api.fetchCard.mockResolvedValue(cardBody(correctableOpening));
    await renderCard();
    expect(screen.getByRole("button", { name: "Correct opening debt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set opening debt" })).toBeNull();
  });

  it("offers no opening action once cycle lifecycle activity has begun", async () => {
    api.fetchCard.mockResolvedValue(cardBody(lockedOpening));
    await renderCard();
    expect(screen.queryByRole("button", { name: "Set opening debt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Correct opening debt" })).toBeNull();
  });

  it("shows Correct opening debt immediately after a successful opening apply", async () => {
    api.fetchCard
      .mockResolvedValueOnce(cardBody(noOpening))
      .mockResolvedValue(cardBody(correctableOpening));
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Set opening debt" }));
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "20000" } });
    submitOpeningForm();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Correct opening debt" })).toBeTruthy();
    });
    expect(api.applyOpeningCard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Set opening debt" })).toBeNull();
  });

  it("sends the opening cycle and effective amount when correcting", async () => {
    api.fetchCard.mockResolvedValue(cardBody(correctableOpening));
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Correct opening debt" }));
    // The form seeds from the effective opening debt, not from correction targets.
    expect(screen.getByLabelText<HTMLInputElement>("Amount (₹)").value).toBe("20000");

    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "18000" } });
    submitOpeningForm();

    await waitFor(() => {
      expect(api.correctOpeningCard).toHaveBeenCalledTimes(1);
    });
    expect(api.correctOpeningCard.mock.calls[0]![0]).toMatchObject({
      creditCardId: "c1",
      billingCycleId: "cycle-1",
      targetAmountPaise: 18_000_00,
    });
  });
});
