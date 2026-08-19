import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { createPerson } from "../../src/app/people.js";
import { applyOpeningClaim } from "../../src/app/openingClaim.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

describe("workspace isolation", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("rejects cross-workspace commands with the same id via generic idempotency conflict", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);

    const ws1 = "ws1";
    const ws2 = "ws2";
    
    handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run(ws1, "Workspace 1");
    handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run(ws2, "Workspace 2");

    const rahul1 = await createPerson(handles, { workspaceId: ws1 }, { name: "Rahul" });
    const rahul2 = await createPerson(handles, { workspaceId: ws2 }, { name: "Rahul" });

    // Workspace A uses commandId X
    await applyOpeningClaim(handles, { workspaceId: ws1 }, {
      commandId: "cmd-duplicate",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: rahul1.id,
      direction: "they_owe_user",
      amountPaise: 500000,
    });

    // Workspace B attempts commandId X
    await expect(
      applyOpeningClaim(handles, { workspaceId: ws2 }, {
        commandId: "cmd-duplicate",
        occurredOn: "2026-08-05",
        capturedAt,
        personId: rahul2.id,
        direction: "they_owe_user",
        amountPaise: 500000,
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
