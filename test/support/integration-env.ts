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
async function answering(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    await fetch(url.replace(/^ws/, 'http'), { signal: AbortSignal.timeout(1500) });
    return url;
  } catch {
    return undefined;
  }
}

const [surrealdb, activityApi, testApi] = await Promise.all(
  [process.env.SURREALDB_URL, process.env.ACTIVITY_API_URL, process.env.TEST_API_URL].map(answering),
);

export const integrationEnv = Object.freeze({
  surrealdb,
  activityApi,
  testApi,
  jwt: process.env.TEST_JWT_TOKEN,
});
