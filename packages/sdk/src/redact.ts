/**
 * Client-side metadata redaction (defense in depth only).
 *
 * Reproduces the risk-engine secret-like key policy
 * (@bond/risk-engine input normalization): matching keys are dropped
 * before sending, never logged, never stored. The backend remains
 * authoritative — client redaction never replaces server validation.
 */
const SECRET_KEY_PATTERN =
  /api[_-]?key|secret|passwd|password|token|private[_-]?key|seed|mnemonic|auth|credential|bearer/i;

const MAX_STRING_FIELD = 256;
const MAX_TEXT_SNIPPET = 500;

export interface RedactedMetadata {
  /** Safe metadata to send (sorted keys, primitives only, truncated). */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  /** Key names dropped as secret-like or non-primitive (names only). */
  readonly redactedFields: readonly string[];
}

/** Returns true when a metadata key looks secret-like. */
export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Drops secret-like and non-primitive metadata values. Pure and
 * deterministic. Never includes original secret values in output.
 */
export function redactMetadata(
  raw: Readonly<Record<string, unknown>> | undefined,
): RedactedMetadata {
  const metadata: Record<string, string | number | boolean | null> = {};
  const redactedFields: string[] = [];
  if (raw === undefined) {
    return { metadata, redactedFields };
  }
  for (const key of Object.keys(raw).sort()) {
    const value: unknown = (raw as Record<string, unknown>)[key];
    if (isSecretLikeKey(key)) {
      redactedFields.push(key);
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      metadata[key] =
        typeof value === "string" ? value.slice(0, MAX_STRING_FIELD) : value;
    } else {
      redactedFields.push(key);
    }
  }
  return { metadata, redactedFields: redactedFields.sort() };
}

/**
 * Truncates free text to the server-accepted snippet budget.
 * Defense in depth: the server truncates again authoritatively.
 */
export function truncateSnippet(text: string | undefined): string | null {
  if (text === undefined) {
    return null;
  }
  return text.slice(0, MAX_TEXT_SNIPPET);
}
