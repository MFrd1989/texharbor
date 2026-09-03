export type Config = {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  publicOrigin: string;
  isProduction: boolean;
  migrationsDirectory: string;
  webDirectory: string;
};

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production';
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return {
    port: Number(process.env.PORT || 3000),
    databaseUrl,
    sessionSecret,
    publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:3000',
    isProduction,
    migrationsDirectory: process.env.MIGRATIONS_DIR || 'packages/database/migrations',
    webDirectory: process.env.WEB_DIR || 'apps/web/dist',
  };
}

