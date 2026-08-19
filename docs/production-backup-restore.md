# Production Backup, Restore Drill, & Data Integrity Guide (Stage 15D)

This document specifies the disaster recovery, backup creation, isolated restore drill, and data integrity verification procedures for the PostgreSQL database prior to live financial data entry.

---

## 1. Safety Rules & Architecture

- **Format**: Backups use PostgreSQL custom-format binary archives (`pg_dump --format=custom`). Backup artifacts in `backups/*.dump` and `backups/*.manifest.json` are strictly gitignored.
- **Consistent Snapshot**: `backup-pg.mjs` exports a consistent `REPEATABLE READ READ ONLY` snapshot (`SELECT pg_export_snapshot()`) to ensure the `.dump` archive and `.manifest.json` metrics represent the exact same state.
- **Paired Manifests**: Each dump produces a paired manifest (e.g. `pg_backup_20260819_163245.manifest.json`) recording timestamp, database host/name, schema migrations, table counts, deterministic table SHA-256 fingerprints, and the SHA-256 hash of the `.dump` file.
- **Isolated Target Database**: Restore drills **must** target an isolated, disposable PostgreSQL database (e.g., `finance_restore_drill`).
- **Destination Guards**: `restore-drill-pg.mjs` enforces `RESTORE_DRILL=1` and requires the target database name to contain `_restore_drill` or `restore_drill_`. Restoration is immediately aborted if the target matches the production database or host.

---

## 2. Command Reference

### Backup Source Database
```bash
# Backup local/staging database:
pnpm db:backup

# Backup production database (requires confirmation flag):
pnpm db:backup -- --database-url postgresql://... --confirm-production
```

### Run Restore Drill (Disposable DB)
```bash
RESTORE_DRILL=1 pnpm db:restore-drill -- --target-url postgresql://localhost:5432/finance_restore_drill --dump backups/pg_backup_TIMESTAMP.dump
```

### Verify Restored Database Integrity (Read-Only)
```bash
pnpm db:verify-restore -- --target-url postgresql://localhost:5432/finance_restore_drill --manifest backups/pg_backup_TIMESTAMP.manifest.json
```

---

## 3. Stage 15D Restore Drill Acceptance Checklist

Execute the following sequence before live financial data entry:

- [ ] **Step A — Source Snapshot & Manifest**: Run `pnpm db:backup` against source database to generate paired `.dump` and `.manifest.json`.
- [ ] **Step B — Dump Checksum**: Confirm `dumpChecksum` SHA-256 in manifest matches the `.dump` file.
- [ ] **Step C — Create Disposable Target DB**: Provision isolated local PostgreSQL database named `finance_restore_drill`.
- [ ] **Step D — Execute Restore Drill**: Run `RESTORE_DRILL=1 pnpm db:restore-drill -- --target-url postgresql://localhost:5432/finance_restore_drill --dump backups/pg_backup_TIMESTAMP.dump`.
- [ ] **Step E — Verify Schema & Checksums**: Run `pnpm db:verify-restore -- --target-url postgresql://localhost:5432/finance_restore_drill --manifest backups/pg_backup_TIMESTAMP.manifest.json`.
- [ ] **Step F — Compare Manifests**: Confirm 100% match across all 23 schema tables and deterministic fingerprints.
- [ ] **Step G — Optional Forward Migration Test**: Apply newer migrations on the disposable drill database and re-verify integrity.
- [ ] **Step H — Application Read Compatibility**: Confirm application can read restored database without errors.
- [ ] **Step I — Destroy Drill DB**: Clean up disposable drill database.
