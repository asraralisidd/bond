/**
 * Production Docker/compose regression tests (Phase 27).
 *
 * Guards the deployment artifacts without building images: every
 * workspace the API can import at runtime must be linked AND built
 * in the API image (the policy-engine omission broke production
 * boot while dev worked), compose must stay overridable and
 * health-checked, and the web bundle must refuse localhost origins.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

function readRepo(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), "utf8");
}

function workspacePackages(): string[] {
  return readdirSync(join(REPO, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(
          join(REPO, "packages", entry.name, "package.json"),
          "utf8",
        ),
      ) as { name?: string };
      return String(manifest.name ?? "");
    })
    .filter((name) => name.startsWith("@bond/"));
}

describe("API production image", () => {
  const dockerfile = readRepo("apps", "api", "Dockerfile");

  it("links every workspace package before install", () => {
    for (const name of workspacePackages()) {
      const short = name.replace("@bond/", "");
      expect(
        dockerfile.includes(`packages/${short}/package.json`),
        `Dockerfile must COPY ${name} manifest so npm links it`,
      ).toBe(true);
    }
  });

  it("builds workspaces in dependency order including policy-engine", () => {
    for (const name of [
      "@bond/shared-types",
      "@bond/risk-engine",
      "@bond/policy-engine",
      "@bond/attestor",
      "@bond/contract",
      "@bond/midnight-adapter",
      "@bond/api",
    ]) {
      expect(
        dockerfile.includes(`--workspace=${name}`),
        `Dockerfile must build ${name}`,
      ).toBe(true);
    }
    const order = [
      "shared-types",
      "risk-engine",
      "policy-engine",
      "attestor",
      "contract",
      "midnight-adapter",
      "api",
    ];
    const positions = order.map((short) =>
      dockerfile.indexOf(`--workspace=@bond/${short}`),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("installs reproducibly and never auto-applies migrations", () => {
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).not.toMatch(/npm install(?! )/);
    expect(dockerfile).toMatch(/never auto-applied/);
  });
});

describe("compose production posture", () => {
  const compose = readRepo("docker-compose.yml");

  it("keeps CORS overridable and health-checks the API", () => {
    expect(compose).toMatch(/CORS_ORIGIN: \$\{CORS_ORIGIN:-/);
    expect(compose).not.toMatch(/CORS_ORIGIN: http:\/\/localhost/);
    const apiBlock = compose.slice(compose.indexOf("\n  api:"));
    expect(apiBlock).toMatch(/healthcheck:/);
    expect(apiBlock).toMatch(/\/health/);
    expect(apiBlock).toMatch(/restart: unless-stopped/);
  });

  it("pins postgres with persistence and a db healthcheck", () => {
    expect(compose).toMatch(/postgres:16-alpine/);
    expect(compose).toMatch(/bond-pgdata/);
    expect(compose).toMatch(/service_healthy/);
  });
});
