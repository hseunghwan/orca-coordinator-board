// Paseo's idempotency rule for a card's sends: a retry of the same payload reuses its request key, so
// the worker can recognise a duplicate, and any change to the payload gets a fresh key.
export type RetryKey = { payload: string; key: string };

export const noRetry: RetryKey = { payload: "", key: "" };

export function retryKey(previous: RetryKey, payload: string, prefix: string, random = Math.random, now = Date.now()): RetryKey {
  if (previous.payload === payload && previous.key) return previous;
  return { payload, key: `${prefix}-${now.toString(36)}-${random().toString(36).slice(2)}` };
}
