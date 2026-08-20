import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import {
  assertNewCorrectionLink,
  correctionCount,
  correctionHistory,
  currentEffectiveLeafId,
  firstCorrectionMapping,
  nextCorrectionMapping,
} from "../../src/domain/corrections/chain.js";
import { replayCorrectionOrConflict } from "../../src/domain/corrections/idempotency.js";
import type { TransactionCorrectionRecord } from "../../src/domain/corrections/types.js";

function correction(
  overrides: Partial<TransactionCorrectionRecord> & Pick<TransactionCorrectionRecord, "targetEventId" | "reversalEventId" | "replacementEventId">,
): TransactionCorrectionRecord {
  return {
    id: overrides.id ?? "corr-1",
    workspaceId: overrides.workspaceId ?? "ws-1",
    commandId: overrides.commandId ?? "cmd-1",
    rootEventId: overrides.rootEventId ?? "orig",
    targetEventId: overrides.targetEventId,
    reversalEventId: overrides.reversalEventId,
    replacementEventId: overrides.replacementEventId,
    correctedOn: overrides.correctedOn ?? isoDate("2026-08-20"),
    capturedAt: overrides.capturedAt ?? "2026-08-20T10:00:00.000Z",
    reason: overrides.reason ?? null,
  };
}

describe("correction chain", () => {
  it("maps the first correction onto the original", () => {
    expect(firstCorrectionMapping("orig")).toEqual({ rootEventId: "orig", targetEventId: "orig" });
    expect(nextCorrectionMapping([], "orig")).toEqual({ rootEventId: "orig", targetEventId: "orig" });
  });

  it("maps a second sequential correction onto the previous replacement", () => {
    const first = correction({
      targetEventId: "orig",
      reversalEventId: "rev-1",
      replacementEventId: "rep-1",
    });
    expect(nextCorrectionMapping([first], "orig")).toEqual({ rootEventId: "orig", targetEventId: "rep-1" });
    expect(currentEffectiveLeafId([first], "orig")).toBe("rep-1");
    expect(correctionCount([first], "orig")).toBe(1);
    const second = correction({
      id: "corr-2",
      commandId: "cmd-2",
      targetEventId: "rep-1",
      reversalEventId: "rev-2",
      replacementEventId: "rep-2",
      capturedAt: "2026-08-21T10:00:00.000Z",
    });
    expect(currentEffectiveLeafId([first, second], "orig")).toBe("rep-2");
    expect(correctionHistory([first, second], "orig").map((item) => item.id)).toEqual(["corr-1", "corr-2"]);
  });

  it("rejects a second correction of the same target", () => {
    const first = correction({
      targetEventId: "orig",
      reversalEventId: "rev-1",
      replacementEventId: "rep-1",
    });
    expect(() =>
      assertNewCorrectionLink([first], {
        rootEventId: "orig",
        targetEventId: "orig",
        reversalEventId: "rev-2",
        replacementEventId: "rep-2",
      }),
    ).toThrow(DomainError);
  });

  it("rejects a reversal that already exists in the chain", () => {
    const first = correction({
      targetEventId: "orig",
      reversalEventId: "rev-1",
      replacementEventId: "rep-1",
    });
    expect(() =>
      assertNewCorrectionLink([first], {
        rootEventId: "orig",
        targetEventId: "rep-1",
        reversalEventId: "rev-1",
        replacementEventId: "rep-2",
      }),
    ).toThrow(DomainError);
  });

  it("rejects a root/replacement collision", () => {
    expect(() =>
      assertNewCorrectionLink([], {
        rootEventId: "orig",
        targetEventId: "orig",
        reversalEventId: "rev-1",
        replacementEventId: "orig",
      }),
    ).toThrow(DomainError);
  });

  it("rejects a cycle attempt that reuses the original as replacement", () => {
    const first = correction({
      targetEventId: "orig",
      reversalEventId: "rev-1",
      replacementEventId: "rep-1",
    });
    expect(() =>
      assertNewCorrectionLink([first], {
        rootEventId: "orig",
        targetEventId: "rep-1",
        reversalEventId: "rev-2",
        replacementEventId: "orig",
      }),
    ).toThrow(DomainError);
  });

  it("fails a broken persisted chain with a domain error", () => {
    const broken = [
      correction({
        targetEventId: "orig",
        reversalEventId: "rev-1",
        replacementEventId: "rep-1",
      }),
      correction({
        id: "corr-2",
        commandId: "cmd-2",
        targetEventId: "not-the-leaf",
        reversalEventId: "rev-2",
        replacementEventId: "rep-2",
        capturedAt: "2026-08-21T10:00:00.000Z",
      }),
    ];
    expect(() => correctionHistory(broken, "orig")).toThrow(DomainError);
    try {
      correctionHistory(broken, "orig");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("stale_correction_target");
    }
  });
});

describe("correction commandId idempotency", () => {
  const existing = correction({
    workspaceId: "ws-1",
    commandId: "raw-cmd",
    targetEventId: "orig",
    reversalEventId: "rev-1",
    replacementEventId: "rep-1",
  });

  it("replays an exact retry", () => {
    expect(
      replayCorrectionOrConflict(existing, {
        commandId: "raw-cmd",
        workspaceId: "ws-1",
        rootEventId: "orig",
        targetEventId: "orig",
        reversalEventId: "rev-1",
        replacementEventId: "rep-1",
        reason: null,
      }),
    ).toBe("replay");
  });

  it("conflicts when the target changes", () => {
    expect(() =>
      replayCorrectionOrConflict(existing, {
        commandId: "raw-cmd",
        workspaceId: "ws-1",
        rootEventId: "orig",
        targetEventId: "other",
        reversalEventId: "rev-1",
        replacementEventId: "rep-1",
        reason: null,
      }),
    ).toThrowError(/Command ID conflict/);
  });

  it("conflicts when the payload changes", () => {
    expect(() =>
      replayCorrectionOrConflict(existing, {
        commandId: "raw-cmd",
        workspaceId: "ws-1",
        rootEventId: "orig",
        targetEventId: "orig",
        reversalEventId: "rev-1",
        replacementEventId: "rep-other",
        reason: null,
      }),
    ).toThrow(DomainError);
  });

  it("conflicts when the same raw commandId is used in another workspace", () => {
    expect(() =>
      replayCorrectionOrConflict(existing, {
        commandId: "raw-cmd",
        workspaceId: "ws-2",
        rootEventId: "orig",
        targetEventId: "orig",
        reversalEventId: "rev-1",
        replacementEventId: "rep-1",
        reason: null,
      }),
    ).toThrowError(/Command ID conflict/);
  });
});
