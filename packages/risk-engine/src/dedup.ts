/**
 * Deterministic duplicate detection (no distributed systems).
 *
 * Identity is content-derived: identical normalized activity yields the
 * identical key, so repeats are caught without clocks, randomness, or
 * storage. Callers pass `seenKeys` (previously analyzed activity keys);
 * the engine reports what it skipped. Persistence of `seenKeys` is a
 * Phase 7 (backend) concern, not engine state.
 */
import { activityKey } from "./evidence.js";
import type { NormalizedActivity } from "./input.js";
import type { RuleFinding } from "./rules.js";

export interface DedupedFindings {
  readonly findings: readonly RuleFinding[];
  /** Activity keys already seen (skipped, counted for observability). */
  readonly skippedDuplicateKeys: readonly string[];
}

/**
 * Drops findings whose activity key was already seen. Pure function.
 * Distinct activity always passes; identical repeats never double-flag.
 */
export function dedupeByActivityKey(
  activity: NormalizedActivity,
  findings: readonly RuleFinding[],
  seenKeys: ReadonlySet<string>,
): DedupedFindings {
  const key = activityKey(activity);
  if (seenKeys.has(key)) {
    return { findings: [], skippedDuplicateKeys: [key] };
  }
  return { findings, skippedDuplicateKeys: [] };
}
