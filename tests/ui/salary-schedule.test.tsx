/** @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  fetchSalarySchedule: vi.fn(),
  applySalaryPolicy: vi.fn(async () => ({ policyId: "policy-1" })),
  updateAccount: vi.fn(async () => ({})),
  fetchCategories: vi.fn(async () => ({ categories: [] })),
  fetchCards: vi.fn(async () => ({ cards: [] })),
  fetchComingCardPayments: vi.fn(async () => ({ items: [] })),
  fetchPeople: vi.fn(async () => ({ people: [] })),
  fetchHome: vi.fn(),
  previewOrCommitIncome: vi.fn(),
}));

vi.mock("../../src/ui/apiClient.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/ui/apiClient.js")>(
    "../../src/ui/apiClient.js",
  );
  return {
    ...actual,
    fetchAccounts: api.fetchAccounts,
    fetchSalarySchedule: api.fetchSalarySchedule,
    applySalaryPolicy: api.applySalaryPolicy,
    updateAccount: api.updateAccount,
    fetchCategories: api.fetchCategories,
    fetchCards: api.fetchCards,
    fetchComingCardPayments: api.fetchComingCardPayments,
    fetchPeople: api.fetchPeople,
    fetchHome: api.fetchHome,
    previewOrCommitIncome: api.previewOrCommitIncome,
  };
});

import { Add } from "../../src/ui/pages/Add.js";
import { Home } from "../../src/ui/pages/Home.js";
import { ManageSalary } from "../../src/ui/pages/ManageSalary.js";

const hdfc = {
  id: "acc-hdfc",
  displayName: "HDFC",
  kind: "bank",
  mask: "2581",
  isPrimarySalary: true,
  balancePaise: 0,
  reservedPaise: 0,
  pendingSurplusPaise: 0,
  availablePaise: 0,
  reservedDetails: [],
  hasOpening: true,
};

const configuredSchedule = {
  primarySalaryAccount: { id: "acc-hdfc", displayName: "HDFC", kind: "bank" },
  policy: {
    expectedAmountPaise: 7_920_000,
    windowStartDay: 4,
    typicalDay: 5,
    windowEndDay: 8,
    effectiveFrom: "2026-08-01",
  },
  nextExpected: {
    fundingCycleId: "fc-sep",
    year: 2026,
    month: 9,
    typicalOn: "2026-09-05",
    windowStart: "2026-09-04",
    windowEnd: "2026-09-08",
    expectedAmountPaise: 7_920_000,
    status: "upcoming",
  },
  receivableCycles: [
    {
      fundingCycleId: "fc-aug-delayed",
      year: 2026,
      month: 8,
      typicalOn: "2026-08-05",
      windowStart: "2026-08-04",
      windowEnd: "2026-08-08",
      expectedAmountPaise: 7_920_000,
      status: "salary_delayed",
    },
    {
      fundingCycleId: "fc-sep",
      year: 2026,
      month: 9,
      typicalOn: "2026-09-05",
      windowStart: "2026-09-04",
      windowEnd: "2026-09-08",
      expectedAmountPaise: 7_920_000,
      status: "upcoming",
    },
  ],
};

function homeBody(overrides: Record<string, unknown> = {}) {
  return {
    asOf: "2026-08-16",
    currentCycleSafeToSpend: 0,
    liquidTotal: 0,
    reservedTotal: 0,
    availableLiquid: 0,
    includedObligationsTotal: 0,
    salaryStatus: null,
    salaryWindowStart: null,
    salaryWindowEnd: null,
    salaryTypicalOn: null,
    expectedSalaryPaise: 0,
    delayed: false,
    incomePolicyConfigured: false,
    riskFlags: ["salary_schedule_not_configured"],
    explanationItems: [],
    coming: [],
    monthSpentPaise: 0,
    previousMonthSpentPaise: 0,
    people: [],
    accounts: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("salary schedule UI", () => {
  it("shows an unconfigured Manage Salary state", async () => {
    api.fetchAccounts.mockResolvedValue({ accounts: [hdfc] });
    api.fetchSalarySchedule.mockResolvedValue({
      primarySalaryAccount: { id: "acc-hdfc", displayName: "HDFC", kind: "bank" },
      policy: null,
      nextExpected: null,
      receivableCycles: [],
    });
    render(<ManageSalary onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Not configured")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    expect(screen.getByText("Applies from the next eligible salary period.")).toBeTruthy();
  });

  it("shows the configured salary schedule", async () => {
    api.fetchAccounts.mockResolvedValue({ accounts: [hdfc] });
    api.fetchSalarySchedule.mockResolvedValue(configuredSchedule);
    render(<ManageSalary onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Expected salary")).toBeTruthy());
    expect(screen.getByText("₹79,200")).toBeTruthy();
    expect(screen.getByText("Usually arrives 5th")).toBeTruthy();
    expect(screen.getByText("Arrival window 4th–8th")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change schedule" })).toBeTruthy();
  });

  it("prefills the salary receipt with expected amount, primary account, and delayed cycle", async () => {
    api.fetchAccounts.mockResolvedValue({ accounts: [hdfc] });
    api.fetchSalarySchedule.mockResolvedValue(configuredSchedule);
    render(
      <Add
        intent="income"
        onDone={() => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText("Expected ₹79,200 for September")).toBeTruthy());
    const amount = screen.getByLabelText("Received amount") as HTMLInputElement;
    expect(amount.value).toBe("79200");
    const account = screen.getByLabelText("Into") as HTMLSelectElement;
    expect(account.value).toBe("acc-hdfc");
    expect(screen.getByRole("option", { name: "August · not in yet" })).toBeTruthy();
    fireEvent.change(amount, { target: { value: "80200" } });
    expect(amount.value).toBe("80200");
  });

  it("keeps the ordinary salary form when no schedule exists", async () => {
    api.fetchAccounts.mockResolvedValue({ accounts: [hdfc] });
    api.fetchSalarySchedule.mockResolvedValue({
      primarySalaryAccount: { id: "acc-hdfc", displayName: "HDFC", kind: "bank" },
      policy: null,
      nextExpected: null,
      receivableCycles: [],
    });
    render(
      <Add
        intent="income"
        onDone={() => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Amount")).toBeTruthy());
    expect(screen.queryByText(/Expected ₹/)).toBeNull();
  });

  it("uses plain-language Home salary copy", async () => {
    api.fetchHome.mockResolvedValue(
      homeBody({
        incomePolicyConfigured: true,
        salaryStatus: "window_open_unreceived",
        salaryTypicalOn: "2026-09-05",
        expectedSalaryPaise: 7_920_000,
      }),
    );
    const noop = () => undefined;
    render(
      <Home
        onOpenExplanation={noop}
        onOpenAffordability={noop}
        onOpenMonth={noop}
        onOpenPeople={noop}
        onOpenCycle={noop}
        onOpenComingUp={noop}
        onOpenObligation={noop}
        onOpenSalary={noop}
        onOpenMoney={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText("Salary expected now")).toBeTruthy());
    cleanup();

    api.fetchHome.mockResolvedValue(
      homeBody({
        incomePolicyConfigured: true,
        salaryStatus: "salary_delayed",
        delayed: true,
        salaryTypicalOn: "2026-08-05",
        expectedSalaryPaise: 7_920_000,
        riskFlags: ["expected_income_delayed"],
      }),
    );
    render(
      <Home
        onOpenExplanation={noop}
        onOpenAffordability={noop}
        onOpenMonth={noop}
        onOpenPeople={noop}
        onOpenCycle={noop}
        onOpenComingUp={noop}
        onOpenObligation={noop}
        onOpenSalary={noop}
        onOpenMoney={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText("Salary hasn't arrived yet")).toBeTruthy());
    cleanup();

    api.fetchHome.mockResolvedValue(
      homeBody({
        incomePolicyConfigured: true,
        salaryStatus: "upcoming",
        salaryTypicalOn: "2026-09-05",
        expectedSalaryPaise: 7_920_000,
        riskFlags: [],
      }),
    );
    render(
      <Home
        onOpenExplanation={noop}
        onOpenAffordability={noop}
        onOpenMonth={noop}
        onOpenPeople={noop}
        onOpenCycle={noop}
        onOpenComingUp={noop}
        onOpenObligation={noop}
        onOpenSalary={noop}
        onOpenMoney={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText("Expected around 5 Sep")).toBeTruthy());
  });
});
