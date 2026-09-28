/** Connection URL of the unit-test database (`hearth_unit`). */
export function unitDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_UNIT;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL_UNIT is not set. Copy .env.example to .env and run `pnpm infra:up`.');
  }
  // The global setup drops schemas: refuse to run against anything but the dedicated unit DB.
  if (new URL(url).pathname !== '/hearth_unit') {
    throw new Error(
      `DATABASE_URL_UNIT must point at the "hearth_unit" database (got path "${new URL(url).pathname}").`,
    );
  }
  return url;
}
