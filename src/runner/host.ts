import type { RequestSpec, RunnerResult } from './types.js';
import { runOne, controllers } from './worker.js';

// V1 inline runner — calls runOne directly. Future: spawn a node:worker_threads
// Worker so concurrent requests don't share an event loop with main.
// The worker.ts module's parentPort handler is already set up; switching to
// real workers later is a host.ts-only change, not a worker.ts change.

let started = false;

export async function startRunner(): Promise<void> {
  started = true;
}

export async function stopRunner(): Promise<void> {
  // Cancel any in-flight requests so afterAll cleanup completes promptly.
  for (const ac of controllers.values()) ac.abort();
  controllers.clear();
  started = false;
}

export async function send(spec: RequestSpec): Promise<RunnerResult> {
  if (!started) throw new Error('RUNNER_NOT_STARTED');
  return runOne(spec);
}

export function cancel(id: string): void {
  controllers.get(id)?.abort();
}
