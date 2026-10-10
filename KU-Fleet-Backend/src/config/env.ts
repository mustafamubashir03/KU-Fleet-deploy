/**
 * Centralised environment loading.
 *
 * WHY THIS EXISTS
 * ---------------
 * Eight modules previously called `dotenv.config()` independently. With no
 * `path` option, dotenv resolves `.env` against `process.cwd()`, NOT against the
 * application root. That was reproduced:
 *
 *   cwd = G:\KU-Fleet            -> injected 0 variables  (.env ENOENT)
 *   cwd = G:\KU-Fleet\KU-Fleet-Backend -> injected 25 variables
 *
 * So the moment the process was started from anywhere other than the backend
 * directory - a PM2 `cwd` mismatch, `node /path/to/dist/server.js` from a
 * service unit, a systemd WorkingDirectory, or a CI step - MongoDB and Redis
 * configuration silently went missing and src/config/redis.ts called
 * process.exit(1). The failure looked like a credentials problem, not a
 * working-directory problem.
 *
 * This module resolves the backend root from its own compiled location, so it
 * works identically under ts-node (src/config) and compiled (dist/config).
 */

import fs from "fs";
import path from "path";

/**
 * Backend application root.
 *   compiled: <root>/dist/config/env.js -> <root>
 *   ts-node : <root>/src/config/env.ts  -> <root>
 */
export const APP_ROOT = path.resolve(__dirname, "..", "..");

export const ENV_FILE = path.join(APP_ROOT, ".env");

export const IS_TEST = process.env.NODE_ENV === "test";

let loaded = false;

/**
 * Load .env once, before any configuration module reads process.env.
 *
 * Precedence: a variable already present in process.env always wins, so an
 * externally injected value (systemd EnvironmentFile, PM2 ecosystem env,
 * GitHub Actions secret, `node --env-file`) is never clobbered by the file.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  // Under test we deliberately do not read the real .env: it holds production
  // credentials and the test suites must never inherit them.
  if (IS_TEST) return;

  if (!fs.existsSync(ENV_FILE)) {
    // Not fatal on its own. validateRequiredEnv() reports precisely what is
    // missing, which is a far better error than process.exit(1) from deep
    // inside a config module.
    console.warn(
      `[env] no .env found at ${ENV_FILE}. Relying on externally provided environment variables.`
    );
    return;
  }

  const dotenv = require("dotenv");
  const result = dotenv.config({ path: ENV_FILE });

  if (result.error) {
    console.warn(`[env] failed to load ${ENV_FILE}: ${result.error.message}`);
  }
}

/**
 * Names of variables that are required but absent. Never returns values.
 *
 * Under NODE_ENV=test the real .env is deliberately not loaded, so the
 * equivalent KUFLEET_TEST_* variables satisfy the requirement. This keeps the
 * production path strict while letting the integration suites run.
 */
export function missingRequiredEnv(): string[] {
  const satisfied = (primary: string, testFallback?: string) =>
    Boolean(process.env[primary] && String(process.env[primary]).trim()) ||
    Boolean(IS_TEST && testFallback && process.env[testFallback] && String(process.env[testFallback]).trim());

  const missing: string[] = [];
  if (!satisfied("MONGO_URI", "KUFLEET_TEST_MONGO_URI")) missing.push("MONGO_URI");
  if (!satisfied("REDIS_URL", "KUFLEET_TEST_REDIS_URL")) missing.push("REDIS_URL");
  if (!satisfied("JWT_SECRET")) missing.push("JWT_SECRET");
  return missing;
}

/**
 * Fail fast with an actionable message naming the missing variables.
 * Values are never printed.
 */
export function validateRequiredEnv(): void {
  const missing = missingRequiredEnv();
  if (missing.length === 0) return;

  const lines = [
    "",
    "==================================================================",
    " FATAL: required environment variables are not configured",
    "==================================================================",
    ` Missing: ${missing.join(", ")}`,
    "",
    ` Looked for a .env file at:`,
    `   ${ENV_FILE}`,
    `   (exists: ${fs.existsSync(ENV_FILE) ? "yes" : "no"})`,
    "",
    " Application root resolved to:",
    `   ${APP_ROOT}`,
    "",
    " If this file exists, the process is almost certainly running from the",
    " wrong working directory. Start it from the backend root, or set the",
    " variables explicitly (systemd EnvironmentFile / PM2 ecosystem env).",
    "",
    " No values are printed here by design.",
    "==================================================================",
    "",
  ];
  console.error(lines.join("\n"));
  process.exit(1);
}

loadEnv();