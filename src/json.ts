/**
 * The one helper the modules that read untrusted JSON share.
 *
 * Two callers narrow raw JSON today: the vendor reading parsers, and the
 * credential-store reader. Neither is the helper's owner — a reading module
 * should not publish a generic object narrowing, and the credential code still
 * lives in the extension entry point — so it sits alone rather than in either.
 */

/**
 * `value` as a plain JSON object, or `undefined` when it is anything else.
 *
 * Antigravity's document arrives as parsed JSON, and every level of it is
 * untrusted: a summary endpoint that answers with a bare array, a `null` bucket
 * or a string where an object belongs must leave the parser with nothing rather
 * than reach a property read that throws.
 */
export function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
