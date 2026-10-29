// This fixture deliberately deletes its own synthetic objects to prove restore.
// It must never run against Neon, Render or another remote data service.
export function assertIsolatedCloudTargets(databaseUrl, objectEndpoint) {
  let database, objects;
  try { database = new URL(databaseUrl); objects = new URL(objectEndpoint); }
  catch { throw new Error('Integration fixtures require valid isolated loopback targets'); }
  const loopback = (url) => ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
      !['http:', 'https:'].includes(objects.protocol) ||
      !loopback(database) || !loopback(objects) ||
      database.search || database.hash || objects.search || objects.hash ||
      objects.username || objects.password || objects.pathname !== '/') {
    throw new Error('Integration fixtures may only use isolated loopback PostgreSQL and S3 containers, without connection overrides');
  }
}
