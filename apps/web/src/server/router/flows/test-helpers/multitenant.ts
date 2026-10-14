/**
 * Temporarily point `MULTI_TENANT_BRANDS` at `value` for the duration of an
 * (async) callback, then restore the previous value.
 *
 * `authorizeScan` reads the env at request time, so tests toggle it per case.
 * The callback is awaited so the env var stays set for the entire async body —
 * a synchronous `try/finally` would restore it before the promise resolves.
 * Passing `undefined` deletes the var (never assigns the string "undefined").
 */
export async function withMultitenantEnv<T>(
  value: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = process.env.MULTI_TENANT_BRANDS;
  if (value === undefined) delete process.env.MULTI_TENANT_BRANDS;
  else process.env.MULTI_TENANT_BRANDS = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MULTI_TENANT_BRANDS;
    else process.env.MULTI_TENANT_BRANDS = prev;
  }
}
