export function backupFilename(now?: Date): string;
export function pgEnvFromDatabaseUrl(
  databaseUrl: string | undefined,
): Record<string, string>;
export function pgDumpArgs(outputPath: string): string[];
