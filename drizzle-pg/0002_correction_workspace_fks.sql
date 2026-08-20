CREATE UNIQUE INDEX financial_events_workspace_id ON financial_events (workspace_id, id);

ALTER TABLE transaction_corrections
  DROP CONSTRAINT IF EXISTS transaction_corrections_root_event_id_fkey,
  DROP CONSTRAINT IF EXISTS transaction_corrections_target_event_id_fkey,
  DROP CONSTRAINT IF EXISTS transaction_corrections_reversal_event_id_fkey,
  DROP CONSTRAINT IF EXISTS transaction_corrections_replacement_event_id_fkey;

ALTER TABLE transaction_corrections
  ADD CONSTRAINT transaction_corrections_root_event_workspace_fk
    FOREIGN KEY (workspace_id, root_event_id) REFERENCES financial_events (workspace_id, id),
  ADD CONSTRAINT transaction_corrections_target_event_workspace_fk
    FOREIGN KEY (workspace_id, target_event_id) REFERENCES financial_events (workspace_id, id),
  ADD CONSTRAINT transaction_corrections_reversal_event_workspace_fk
    FOREIGN KEY (workspace_id, reversal_event_id) REFERENCES financial_events (workspace_id, id),
  ADD CONSTRAINT transaction_corrections_replacement_event_workspace_fk
    FOREIGN KEY (workspace_id, replacement_event_id) REFERENCES financial_events (workspace_id, id);

ALTER TABLE transaction_corrections
  ADD CONSTRAINT transaction_corrections_root_not_reversal
    CHECK (root_event_id <> reversal_event_id),
  ADD CONSTRAINT transaction_corrections_root_not_replacement
    CHECK (root_event_id <> replacement_event_id);
