/**
 * Backend configuration: environment parsing with fail-fast validation.
 *
 * Secrets are never defaulted and never logged. DATABASE_URL is required;
 * everything else carries safe local defaults. Unknown MIDNIGHT_NETWORK
 * values throw (adapter validates); wallet material is never read here.
 */
export interface ApiConfig {
  readonly port: number;
  readonly host: string;
  readonly corsOrigin: string;
  readonly databaseUrl: string;
  readonly logLevel: string;
  readonly midnightNetwork: string;
  readonly devAuthToken: string | null;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const portRaw = env.API_PORT ?? "4000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid API_PORT: ${portRaw}`);
  }
  return {
    port,
    host: env.API_HOST ?? "0.0.0.0",
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5173",
    databaseUrl: required("DATABASE_URL", env),
    logLevel: env.LOG_LEVEL ?? "info",
    midnightNetwork: env.MIDNIGHT_NETWORK ?? "",
    devAuthToken: env.DEV_AUTH_TOKEN?.trim() || null,
  };
}
