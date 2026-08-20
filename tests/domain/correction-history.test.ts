import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import {
  correctionsEffectiveAsOf,
  excludeFutureCorrectionArtifacts,
} from "../../src/domain/corrections/history.js";
import type { TransactionCorrectionRecord } from "../../src/domain/corrections/types.js";

describe("16C1 historical limitation contract", () => {
  it("hides only future correction artifacts, not unrelated ordinary events", () => {
    const correction: TransactionCorrectionRecord = {
      id: "corr-1",
      workspaceId: "ws",
      commandId: "cmd",
      rootEventId: "orig",
      targetEventId: "orig",
      reversalEventId: "rev",
      replacementEventId: "rep",
      correctedOn: isoDate("2026-08-20"),
      capturedAt: "2026-08-20T10:00:00.000Z",
      reason: null,
    };
    expect(correctionsEffectiveAsOf([correction], "2026-08-10")).toEqual([]);
    const visible = excludeFutureCorrectionArtifacts(
      [
        { id: "orig" },
        { id: "rev" },
        { id: "rep" },
        { id: "unrelated-later" },
      ],
      [
        { eventId: "orig" },
        { eventId: "rev" },
        { eventId: "rep" },
        { eventId: "unrelated-later" },
      ],
      [correction],
      "2026-08-10",
    );
    expect(visible.events.map((event) => event.id)).toEqual(["orig", "unrelated-later"]);
    expect(visible.corrections).toEqual([]);
  });
});
