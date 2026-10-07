/**
 * Backup script safety tests (Phase 15): command construction only —
 * never spawns pg_dump, never touches a database.
 */
import { describe, expect, it } from "vitest";
import {
  backupFilename,
  pgDumpArgs,
  pgEnvFromDatabaseUrl,
} from "../scripts/backup.mjs";

describe("backup filename", () => {
  it("is deterministic, timestamped, and filesystem-safe", () => {
    const name = backupFilename(new Date("2026-03-01T12:34:56.789Z"));
    expect(name).toBe("bond-db-20260301-123456.dump");
    expect(name).not.toMatch(/[:\s]/);
  });
});

describe("pgEnvFromDatabaseUrl", () => {
  it("translates a URL into libpq variables without leaking", () => {
    const env = pgEnvFromDatabaseUrl(
      "postgresql://bond:s3cret@db.internal:5433/bond_prod",
    );
    expect(env).toEqual({
      PGHOST: "db.internal",
      PGPORT: "5433",
      PGUSER: "bond",
      PGPASSWORD: "s3cret",
      PGDATABASE: "bond_prod",
    });
    expect(JSON.stringify(env)).not.toContain("postgresql://");
  });

  it("decodes percent-encoded credentials", () => {
    const env = pgEnvFromDatabaseUrl(
      "postgresql://bond:p%40ss%3Aw%2Frd@localhost/bond_dev",
    );
    expect(env.PGPASSWORD).toBe("p@ss:w/rd");
  });

  it("rejects missing, malformed, and non-postgres URLs", () => {
    expect(() => pgEnvFromDatabaseUrl(undefined)).toThrowError(/not set/);
    expect(() => pgEnvFromDatabaseUrl("not-a-url")).toThrowError(
      /not a valid URL/,
    );
    expect(() => pgEnvFromDatabaseUrl("mysql://x/y")).toThrowError(
      /postgresql:/,
    );
  });
});

describe("pgDumpArgs", () => {
  it("passes no connection string on argv", () => {
    const args = pgDumpArgs("/tmp/backups/bond-db-x.dump");
    expect(args).toContain("--format=custom");
    expect(args).toContain("--no-owner");
    expect(args).toContain("--no-privileges");
    expect(args.join(" ")).not.toContain("postgresql://");
    expect(args.join(" ")).not.toContain("s3cret");
  });
});
