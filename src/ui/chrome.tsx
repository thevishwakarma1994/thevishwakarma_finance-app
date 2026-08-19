import type { ReactNode } from "react";
import { BackIcon, ChevronIcon, CloseIcon } from "./icons.js";

type PageHeaderProps = {
  title: string;
  onBack?: () => void;
  trailing?: ReactNode;
};

export function PageHeader({ title, onBack, trailing }: PageHeaderProps) {
  return (
    <header className="header">
      {onBack ? (
        <button className="header-icon-btn start" type="button" aria-label="Back" onClick={onBack}>
          <BackIcon />
        </button>
      ) : (
        <span className="header-slot" />
      )}
      <h1>{title}</h1>
      {trailing ? trailing : <span className="header-slot" />}
    </header>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        d="M12 5v14M5 12h14"
      />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3.5v2.1M12 18.4v2.1M20.5 12h-2.1M5.6 12H3.5M17.9 6.1l-1.5 1.5M7.6 16.4l-1.5 1.5M17.9 17.9l-1.5-1.5M7.6 7.6 6.1 6.1"
      />
    </svg>
  );
}

export function EmptyState({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <p className="muted">{title}</p>
      {actionLabel && onAction ? (
        <button className="text-action" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state">
      <p className="danger">{message}</p>
      {onRetry ? (
        <button className="secondary compact" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index} />
      ))}
    </div>
  );
}

type SheetProps = {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  tall?: boolean;
};

export function Sheet({ title, onClose, onBack, children, footer, tall = false }: SheetProps) {
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className={tall ? "sheet sheet-tall" : "sheet"}
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-header">
          {onBack ? (
            <button className="sheet-header-btn" type="button" aria-label="Back" onClick={onBack}>
              <BackIcon />
            </button>
          ) : null}
          <h2 className="sheet-title">{title}</h2>
          <button className="sheet-header-btn sheet-close" type="button" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function RowChevron() {
  return (
    <span className="list-row-chevron" aria-hidden="true">
      <ChevronIcon />
    </span>
  );
}
