/**
 * The live-resource URLs the process was started with, read before any test file runs
 * (bunfig.toml preloads this module). Unit tests set SURREALDB_URL to a dead port for
 * their own config, so a gate reading process.env would turn on mid-run and point
 * integration tests at nothing.
 */
export const integrationEnv = Object.freeze({
  surrealdb: process.env.SURREALDB_URL,
  activityApi: process.env.ACTIVITY_API_URL,
  testApi: process.env.TEST_API_URL,
  jwt: process.env.TEST_JWT_TOKEN,
});
