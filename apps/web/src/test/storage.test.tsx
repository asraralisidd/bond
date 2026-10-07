/**
 * Browser storage privacy tests (Phase 26).
 *
 * Source-scan regression lock: browser persistence may only use the
 * documented key allowlist (session token, operator id, wallet
 * verifying key + network, expiry flag, recent-item ids). Any new
 * storage key — or any secret-shaped write — fails here first.
 * No attestor secrets, witnesses, private keys, or raw activity
 * may ever reach browser storage, URLs, or console output.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const ALLOWED_STORAGE_KEYS = [
  "bond.session.token",
  "bond.session.operator",
  "bond.session.wallet.vk",
  "bond.session.wallet.network",
  "bond.session.expired",
  "bond.recent.items",
];

function webSources(): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test") {
          walk(full);
        }
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push({
          file: full.slice(SRC.length + 1),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(SRC);
  return out;
}

function stripStrings(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/'([^'\\]|\\.)*'/g, "''")
    .replace(/`([^`\\]|\\.)*`/g, "``");
}

describe("browser storage privacy", () => {
  it("writes only allowlisted storage keys", () => {
    // Resolve module-level `const NAME = "literal"` so constant
    // indirection (TOKEN_KEY, KEY, ...) maps to the stored key.
    const constants = new Map<string, string>();
    for (const { content } of webSources()) {
      const noComments = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const match of noComments.matchAll(
        /(?:const|let)\s+([A-Z_][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g,
      )) {
        constants.set(match[1], match[2]);
      }
    }
    const writes: string[] = [];
    for (const { file, content } of webSources()) {
      const noComments = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const match of noComments.matchAll(
        /(localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*([^,]+?),/g,
      )) {
        const raw = match[2].trim();
        const literal = /^["'`]([^"'`]+)["'`]$/.exec(raw)?.[1];
        const resolved = literal ?? constants.get(raw.replace(/\s+/g, ""));
        writes.push(`${file}:${resolved ?? `UNRESOLVED(${raw})`}`);
      }
    }
    expect(writes.length).toBeGreaterThan(0);
    for (const entry of writes) {
      const key = entry.split(":").slice(1).join(":");
      expect(ALLOWED_STORAGE_KEYS, `storage key in ${entry}`).toContain(key);
    }
  });

  it("logs no variables and references no custodial wallet material", () => {
    for (const { file, content } of webSources()) {
      const code = stripStrings(content);
      // console.* with anything but a single literal argument.
      for (const match of code.matchAll(
        /console\s*\.\s*(log|error|warn|info|debug)\s*\(/g,
      )) {
        const rest = code.slice(match.index! + match[0].length);
        const singleLiteral = /^""\s*\)/.test(rest) || /^''\s*\)/.test(rest);
        expect(
          singleLiteral,
          `${file}: console call with non-literal argument`,
        ).toBe(true);
      }
      for (const token of [
        "privateKey",
        "private_key",
        "mnemonic",
        "seedPhrase",
        "seed_phrase",
      ]) {
        expect(
          code.includes(token),
          `${file} must not reference ${token}`,
        ).toBe(false);
      }
    }
  });
});
