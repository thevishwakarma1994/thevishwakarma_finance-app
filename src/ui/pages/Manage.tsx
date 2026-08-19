import { useState, type ReactNode } from "react";
import { PageHeader, RowChevron, Sheet } from "../chrome.js";
import { AccountIcon, BillsIcon, CardIcon, CategoryIcon, CheckIcon, SalaryIcon } from "../icons.js";
import type { Appearance } from "../appearance.js";

type Props = {
  appearance: Appearance;
  onSelectAppearance: (val: Appearance) => void;
  onBack: () => void;
  onOpenAccounts: () => void;
  onOpenCards: () => void;
  onOpenCategories: () => void;
  onOpenSalary: () => void;
  onOpenBills: () => void;
  onSignOut: () => void;
};

function ManageRow({
  title,
  description,
  onClick,
  icon,
}: {
  title: string;
  description: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button className="list-row" type="button" onClick={onClick}>
      <span className="list-row-main">
        <span className="list-row-leading">{icon}</span>
        <span className="list-row-copy">
          <span className="list-row-title">{title}</span>
          <span className="muted">{description}</span>
        </span>
      </span>
      <RowChevron />
    </button>
  );
}

export function Manage({
  appearance,
  onSelectAppearance,
  onBack,
  onOpenAccounts,
  onOpenCards,
  onOpenCategories,
  onOpenSalary,
  onOpenBills,
  onSignOut,
}: Props) {
  const [showAppearanceSheet, setShowAppearanceSheet] = useState(false);

  const appearanceLabel =
    appearance === "system" ? "System" : appearance === "light" ? "Light" : "Dark";

  return (
    <>
      <PageHeader title="Manage money" onBack={onBack} />
      <main className="page" data-screen="manage">
        <p className="section-label">Manage money</p>
        <ManageRow
          title="Accounts"
          description="Banks and cash"
          icon={<AccountIcon />}
          onClick={onOpenAccounts}
        />
        <ManageRow
          title="Cards"
          description="Statements, due dates and owners"
          icon={<CardIcon />}
          onClick={onOpenCards}
        />
        <ManageRow
          title="Categories"
          description="Spending labels"
          icon={<CategoryIcon />}
          onClick={onOpenCategories}
        />
        <ManageRow
          title="Salary"
          description="Salary account and schedule status"
          icon={<SalaryIcon />}
          onClick={onOpenSalary}
        />
        <ManageRow
          title="Bills"
          description="Recurring and one-off payments"
          icon={<BillsIcon />}
          onClick={onOpenBills}
        />
        <p className="section-label">App</p>
        <button className="list-row" type="button" onClick={() => setShowAppearanceSheet(true)}>
          <span className="list-row-main">
            <span className="list-row-copy">
              <span className="list-row-title">Appearance</span>
              <span className="muted">{appearanceLabel}</span>
            </span>
          </span>
          <RowChevron />
        </button>
        <button className="list-row" type="button" onClick={onSignOut}>
          <span className="list-row-title">Sign out</span>
        </button>
      </main>

      {showAppearanceSheet ? (
        <Sheet title="Appearance" onClose={() => setShowAppearanceSheet(false)}>
          <div className="choice">
            {(["system", "light", "dark"] as const).map((option) => {
              const isSelected = appearance === option;
              const label = option === "system" ? "System" : option === "light" ? "Light" : "Dark";
              return (
                <button
                  key={option}
                  className="list-row"
                  type="button"
                  onClick={() => {
                    onSelectAppearance(option);
                    setShowAppearanceSheet(false);
                  }}
                >
                  <span className="list-row-main">
                    <span className="list-row-leading">
                      {isSelected ? <CheckIcon /> : null}
                    </span>
                    <span className="list-row-title">{label}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
