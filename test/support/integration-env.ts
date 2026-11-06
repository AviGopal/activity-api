/**
 * The live-resource URLs the process was started with, read before any test file runs
 * (bunfig.toml preloads this module). Unit tests set SURREALDB_URL to a dead port for
 * their own config, so a gate reading process.env would turn on mid-run and point
 * integration tests at nothing.
 *
 * A URL counts only if something answers it: a sandbox that sets every endpoint to a
 * closed port (the pull-sync gate does) has no resource to integrate with, so its
 * integration files skip rather than fail.
 */
async function answering(name: string): Promise<string | undefined> {
  const url = process.env[name];
  if (!url) return undefined;
  try {
    await fetch(url.replace(/^ws/, 'http'), { signal: AbortSignal.timeout(1500) });
    return url;
  } catch {
    // A wrong URL would otherwise read the same as no URL: say why the cases skip.
    console.error(`integration-env: ${name} set but not answering; integration cases skip`);
    return undefined;
  }
}

const [surrealdb, activityApi, testApi] = await Promise.all(
  ['SURREALDB_URL', 'ACTIVITY_API_URL', 'TEST_API_URL'].map(answering),
);

export const integrationEnv = Object.freeze({
  surrealdb,
  activityApi,
  testApi,
  jwt: process.env.TEST_JWT_TOKEN,
});
