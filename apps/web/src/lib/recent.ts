/**
 * Client-side recent-item history (localStorage). The API has no
 * list endpoints for bonds/attestations/transactions, so the UI remembers
 * ids the operator created in THIS browser, clearly labeled as local
 * history — never presented as server state.
 */
export interface RecentItem {
  kind: "bond" | "attestation" | "transaction" | "agent" | "proof";
  id: string;
  agentId: string | null;
  label: string;
  at: string;
}

const KEY = "bond.recent.items";
const MAX = 60;

function load(): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as RecentItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function remember(item: Omit<RecentItem, "at">): void {
  try {
    const at = new Date().toISOString();
    const rest = load().filter(
      (i) => !(i.kind === item.kind && i.id === item.id),
    );
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ ...item, at }, ...rest].slice(0, MAX)),
    );
  } catch {
    // ignore persistence failure
  }
}

export function recents(
  kind?: RecentItem["kind"],
  agentId?: string,
): RecentItem[] {
  return load().filter(
    (i) =>
      (kind === undefined || i.kind === kind) &&
      (agentId === undefined || i.agentId === agentId),
  );
}
