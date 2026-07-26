// Centralized so docs, tests, and the runtime share one source of truth.
export const ExitCode = {
  Ok: 0,
  AssertionFailed: 1,
  RequestFailed: 2,
  UsageOrParseError: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
