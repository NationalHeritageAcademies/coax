import type { AssertionResult } from '@assertions/types.js';

export interface RunRecord {
  title: string;
  name?: string;
  method: string;
  url: string;
  result:
    | { ok: true; status: number; ms: number }
    | { ok: false; category: string; message: string; ms: number };
  assertions: AssertionResult[];
}

export interface RunSummary {
  totalRequests: number;
  passedRequests: number;
  failedRequests: number;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  elapsedMs: number;
}

export interface Reporter {
  start(filename: string): void;
  record(record: RunRecord): void;
  finish(summary: RunSummary): void;
}
