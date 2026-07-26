export type AssertionOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'exists';

export type AssertionLeft =
  | { kind: 'status' }
  | { kind: 'responseTime' }
  | { kind: 'header'; name: string }
  | { kind: 'jsonpath'; path: string };

export type AssertionValue = string | number | boolean | null;

export interface Assertion {
  raw: string;
  left: AssertionLeft;
  op: AssertionOp;
  right?: AssertionValue;
}

export interface AssertionEvalContext {
  status: number;
  responseTime: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface AssertionResult {
  raw: string;
  ok: boolean;
  /** Present when the assertion failed or had a structural problem. */
  error?: string;
  /** Actual value pulled from the response (for diagnostics). */
  actual?: AssertionValue;
}
