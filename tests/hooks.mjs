// Redirects @netlify/* packages to local test doubles. Only the platform pieces are faked
// (identity, blob storage, and a psql-backed database client); the API code and SQL are real.
const map = {
  "@netlify/database": "./stubs/database.mjs",
  "@netlify/blobs": "./stubs/blobs.mjs",
  "@netlify/identity": "./stubs/identity.mjs",
};
export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: new URL(map[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
