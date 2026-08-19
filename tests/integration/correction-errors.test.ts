import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { createPerson } from "../../src/app/people.js";
import { applyOpeningClaim, correctOpeningClaim } from "../../src/app/openingClaim.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected HDFC");

  const rahul = await createPerson(handles, { workspaceId }, { name: "Rahul" });

  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    rahulId: rahul.id,
  };
}

describe("correction errors", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("rejects correction for non-existent claim", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    await expect(
      correctOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-cor-nonexistent",
        occurredOn: "2026-08-05",
        capturedAt,
        claimId: "fake-claim-id",
        targetAmountPaise: 5000,
      })
    ).rejects.toMatchObject({ code: "claim_not_found" });
  });

  it("rejects correction after lifecycle events", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    await applyOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open-rec",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: ctx.rahulId,
      direction: "they_owe_user",
      amountPaise: 5_000_00,
    });
    
    await receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-rec-settle",
      occurredOn: "2026-08-25",
      capturedAt,
      personId: ctx.rahulId,
      accountId: ctx.hdfcId,
      amountPaise: 1_000_00,
      allocations: [{ claimId: `${ctx.workspaceId}_cmd-open-rec_claim`, amountPaise: 1_000_00 }],
      commit: true,
    });

    await expect(
      correctOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-cor-fail",
        occurredOn: "2026-08-26",
        capturedAt,
        claimId: `${ctx.workspaceId}_cmd-open-rec_claim`,
        targetAmountPaise: 6_000_00,
      })
    ).rejects.toMatchObject({ code: "invalid_opening" });
  });
});
