// Populate process.env from a local .env file for manual/dev runs (e.g. a bare
// `node src/server.js`), using Node's built-in parser - no dependency required.
//
// This must be imported FIRST in the app entrypoint so the variables exist
// before any other module reads process.env at import time.
//
// In Docker/UnRaid there is no .env in the image (it's in .dockerignore); the
// real environment is injected via compose `env_file` instead, so loadEnvFile()
// simply throws here and we fall back to those real variables.
try {
  process.loadEnvFile();
} catch {
  /* no .env beside the app - rely on the real environment variables */
}
