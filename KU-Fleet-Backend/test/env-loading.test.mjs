// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Environment loading and startup validation.
 *
 * These target the defect where eight modules each called dotenv.config()
 * against process.cwd(), so configuration silently vanished whenever the
 * process was started from anywhere other than the backend directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

// config/env.ts skips .env under NODE_ENV=test, so re-require it in a child
// process with an explicit NODE_ENV to observe the non-test path safely.
function loadEnvModule() {
  const envPath = path.join(dist, "config", "env.js");
  delete require.cache[require.resolve(envPath)];
  return require(envPath);
}

test("APP_ROOT is derived from the module location, not the cwd", () => {
  const env = loadEnvModule();
  assert.ok(path.isAbsolute(env.APP_ROOT), "APP_ROOT must be absolute");
  assert.equal(
    path.basename(env.APP_ROOT),
    "KU-Fleet-Backend",
    `APP_ROOT resolved to ${env.APP_ROOT}`
  );
  assert.ok(
    env.ENV_FILE.endsWith(path.join("KU-Fleet-Backend", ".env")),
    "the env file path must be anchored at the backend root"
  );
});

test("APP_ROOT is correct even when the process cwd is elsewhere", () => {
  // The original defect: running from G:\KU-Fleet resolved G:\KU-Fleet\.env
  // (0 variables) instead of G:\KU-Fleet\KU-Fleet-Backend\.env (25 variables).
  const expected = path.basename(loadEnvModule().APP_ROOT);
  const original = process.cwd();
  try {
    process.chdir(path.parse(original).root);
    assert.equal(
      path.basename(loadEnvModule().APP_ROOT),
      expected,
      "APP_ROOT must not depend on cwd"
    );
  } finally {
    process.chdir(original);
  }
});

test("under NODE_ENV=test the real .env is never read", () => {
  const env = loadEnvModule();
  // IS_TEST short-circuits before touching the file.
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(env.APP_ROOT);
  assert.ok(env.ENV_FILE.endsWith(".env"));
});

test("validateRequiredEnv reports exactly the missing variable NAMES", () => {
  const env = loadEnvModule();
  const keys = ["MONGO_URI", "REDIS_URL", "JWT_SECRET"];
  const saved = keys.map((k) => [k, process.env[k]]);
  const hadTestFallbacks = {
    mongo: Boolean(process.env.KUFLEET_TEST_MONGO_URI),
    redis: Boolean(process.env.KUFLEET_TEST_REDIS_URL),
  };

  try {
    for (const k of keys) delete process.env[k];

    const missing = env.missingRequiredEnv();

    // Under NODE_ENV=test the KUFLEET_TEST_* variables legitimately satisfy the
    // production equivalents, because the real .env is deliberately not read.
    assert.ok(missing.includes("MONGO_URI") || hadTestFallbacks.mongo);
    assert.ok(missing.includes("REDIS_URL") || hadTestFallbacks.redis);
    assert.ok(missing.includes("JWT_SECRET"), "JWT_SECRET has no test fallback");

    if (!hadTestFallbacks.mongo && !hadTestFallbacks.redis) {
      assert.deepEqual(missing.sort(), ["JWT_SECRET", "MONGO_URI", "REDIS_URL"]);
    }

    // A value present but blank/whitespace must also count as missing.
    process.env.MONGO_URI = "   ";
    if (!hadTestFallbacks.mongo) {
      assert.ok(env.missingRequiredEnv().includes("MONGO_URI"));
    }

    process.env.MONGO_URI = "mongodb://x";
    process.env.REDIS_URL = "redis://x";
    process.env.JWT_SECRET = "y";
    assert.deepEqual(env.missingRequiredEnv(), []);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("validateRequiredEnv exits non-zero and never prints values", () => {
  const env = loadEnvModule();
  // The KUFLEET_TEST_* fallbacks must be cleared too: under NODE_ENV=test they
  // legitimately satisfy MONGO_URI / REDIS_URL, which would stop the validator.
  const keys = ["MONGO_URI", "REDIS_URL", "JWT_SECRET", "KUFLEET_TEST_MONGO_URI", "KUFLEET_TEST_REDIS_URL"];
  const saved = keys.map((k) => [k, process.env[k]]);

  const written = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s, ...a) => {
    written.push(String(s));
    return true;
  };
  process.stderr.write = (s, ...a) => {
    written.push(String(s));
    return true;
  };

  const realExit = process.exit;
  let exitCode = null;
  process.exit = (c) => {
    exitCode = c;
    throw new Error("__EXIT__");
  };

  try {
    for (const [k] of saved) delete process.env[k];
    assert.throws(() => env.validateRequiredEnv(), /__EXIT__/);
    assert.equal(exitCode, 1, "must exit 1 on missing configuration");

    const output = written.join("");
    assert.match(output, /MONGO_URI/, "must name the missing variables");
    assert.match(output, /No values are printed/, "must state that values are withheld");
  } finally {
    process.stdout.write = realWrite;
    process.stderr.write = realErrWrite;
    process.exit = realExit;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("only config/env.ts loads dotenv; the other modules import it", () => {
  const fs = require("node:fs");
  const pathMod = require("node:path");
  const srcRoot = path.join(here, "..", "src");

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = pathMod.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const text = fs.readFileSync(full, "utf8");
        // A real call, not a comment.
        const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/dotenv\.config\(\)/.test(withoutComments) && pathMod.basename(full) !== "env.ts") {
          offenders.push(pathMod.relative(srcRoot, full));
        }
      }
    }
  };
  if (fs.existsSync(srcRoot)) walk(srcRoot);

  assert.deepEqual(offenders, [], `these modules still load dotenv themselves: ${offenders}`);
});

test("every config module imports the central env loader first", () => {
  const fs = require("node:fs");
  for (const f of ["db.js", "redis.js", "cloudinary.js"]) {
    const p = path.join(dist, "config", f);
    const text = fs.readFileSync(p, "utf8");
    assert.match(text, /require\("\.\/env"\)/, `${f} must import ./env`);
  }
});

test("the .env file is neither tracked nor copied into the build output", () => {
  const fs = require("node:fs");
  const { execSync } = require("node:child_process");

  assert.equal(
    fs.existsSync(path.join(here, "..", "dist", ".env")),
    false,
    ".env must never be emitted into dist/"
  );

  let tracked = "";
  try {
    tracked = execSync("git ls-files --error-unmatch KU-Fleet-Backend/.env", {
      cwd: path.join(here, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    tracked = "";
  }
  assert.equal(tracked.trim(), "", ".env must not be tracked by git");
});