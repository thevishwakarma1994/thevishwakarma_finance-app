/**
 * Temporary production latency instrumentation (Stage 15 diagnosis).
 * Enable with env PERF_TIMING=1 or request header x-perf-timing: 1.
 * Logs and Server-Timing expose durations only — never tokens, emails, or money.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type PerfMarks = {
  requestId: string;
  route: string;
  authMs: number;
  provisionMs: number;
  obligationsMs: number;
  snapshotMs: number;
  snapshotCalls: number;
  dbQueryCount: number;
  engineMs: number;
  readMs: number;
  totalMs: number;
};

const store = new AsyncLocalStorage<PerfMarks>();

export function perfEnabledFromEnv(): boolean {
  return process.env.PERF_TIMING === "1";
}

export function perfEnabledFromHeader(header: string | undefined): boolean {
  return header === "1" || header?.toLowerCase() === "true";
}

export function createPerfMarks(route: string): PerfMarks {
  return {
    requestId: randomUUID().slice(0, 8),
    route,
    authMs: 0,
    provisionMs: 0,
    obligationsMs: 0,
    snapshotMs: 0,
    snapshotCalls: 0,
    dbQueryCount: 0,
    engineMs: 0,
    readMs: 0,
    totalMs: 0,
  };
}

export function getPerfMarks(): PerfMarks | undefined {
  return store.getStore();
}

export function runWithPerf<T>(marks: PerfMarks, fn: () => Promise<T>): Promise<T> {
  return store.run(marks, fn);
}

export async function timedPerf<T>(
  field: "authMs" | "provisionMs" | "obligationsMs" | "snapshotMs" | "engineMs" | "readMs",
  fn: () => Promise<T>,
): Promise<T> {
  const marks = store.getStore();
  if (!marks) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    marks[field] += performance.now() - started;
  }
}

export function timedPerfSync<T>(field: "engineMs" | "readMs", fn: () => T): T {
  const marks = store.getStore();
  if (!marks) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    marks[field] += performance.now() - started;
  }
}

export function recordSnapshotCall(queryCount: number): void {
  const marks = store.getStore();
  if (!marks) return;
  marks.snapshotCalls += 1;
  marks.dbQueryCount += queryCount;
}

export function addDbQueries(count: number): void {
  const marks = store.getStore();
  if (!marks) return;
  marks.dbQueryCount += count;
}

export function serverTimingValue(marks: PerfMarks): string {
  const parts = [
    `auth;dur=${marks.authMs.toFixed(1)}`,
    `prov;dur=${marks.provisionMs.toFixed(1)}`,
    `obl;dur=${marks.obligationsMs.toFixed(1)}`,
    `snap;dur=${marks.snapshotMs.toFixed(1)}`,
    `eng;dur=${marks.engineMs.toFixed(1)}`,
    `read;dur=${marks.readMs.toFixed(1)}`,
    `total;dur=${marks.totalMs.toFixed(1)}`,
  ];
  return parts.join(", ");
}

export function logPerf(marks: PerfMarks): void {
  console.log(
    JSON.stringify({
      perf: true,
      requestId: marks.requestId,
      route: marks.route,
      authMs: Math.round(marks.authMs),
      provisionMs: Math.round(marks.provisionMs),
      obligationsMs: Math.round(marks.obligationsMs),
      snapshotMs: Math.round(marks.snapshotMs),
      snapshotCalls: marks.snapshotCalls,
      dbQueryCount: marks.dbQueryCount,
      engineMs: Math.round(marks.engineMs),
      readMs: Math.round(marks.readMs),
      totalMs: Math.round(marks.totalMs),
    }),
  );
}
