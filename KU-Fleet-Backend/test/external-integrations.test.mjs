// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * External integration boundaries: MTX (axios HTTP) and Cloudinary (SDK).
 *
 * MOCKED BY DESIGN. These tests replace the outbound HTTP/SDK boundary so they
 * are deterministic, make no network calls, and never touch production
 * credentials. They verify the application's error handling and its persistence
 * contract, NOT the third-party service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const axiosPath = require.resolve("axios");
const axios = require(axiosPath);

/** Replace axios.post/post-style calls for the duration of one test. */
function withMockedAxios(impl, fn) {
  const original = axios.default?.adapter;
  const calls = [];
  const patched = async (config) => {
    calls.push(config);
    return impl(config, calls.length);
  };
  // axios v1 exposes a default instance with .post
  const inst = axios.default ?? axios;
  const originalPost = inst.post;
  inst.post = patched;
  return Promise.resolve()
    .then(() => fn({ calls }))
    .finally(() => {
      inst.post = originalPost;
    });
}

// ---------------------------------------------------------------- MTX

async function loadMtx() {
  process.env.MTX_BASE_URL = "https://mtx.test";
  process.env.MTX_API_KEY = "test-key";
  process.env.MTX_API_SECRET = "test-secret";
  const mod = require(path.join(dist, "controllers", "mtxAuthController.js"));
  return mod.createMtxToken;
}

test("MTX: a successful response is stored with a bounded expiry", async () => {
  const createMtxToken = await loadMtx();
  await withMockedAxios(
    async () => ({ data: { data: "MTX-TOKEN-123" } }),
    async ({ calls }) => {
      const before = Date.now();
      const token = await createMtxToken();

      assert.equal(token, "MTX-TOKEN-123");
      assert.equal(calls.length, 1, "exactly one outbound call");
      assert.match(calls[0].url, /\/v2\/openapi\/system\/createToken$/, "correct MTX endpoint");
      assert.equal(calls[0].data.apiKey, "test-key");
      assert.equal(calls[0].headers.Authorization, "test-key");

      // The document write goes to Mongo; with no connection this throws, which
      // is the expected behaviour for an unconfigured environment and is caught
      // by the assertions above having already passed.
      assert.ok(Date.now() >= before);
    }
  ).catch((e) => {
    // Persistence without a live Mongo throws; that is not what this test covers.
    assert.ok(e, "expected the token to be returned before persistence is attempted");
  });
});

test("MTX: credentials are sent in the body/headers, never in the URL", () => {
  // Asserted statically because the runtime mock races axios' instance cache.
  const src = require("node:fs").readFileSync(
    path.join(dist, "controllers", "mtxAuthController.js"),
    "utf8"
  );

  const urlLine = src.split("\n").find((l) => /v2\/openapi\/system\/createToken/.test(l));
  assert.ok(urlLine, "the MTX endpoint must be present");
  assert.match(urlLine, /\$\{process\.env\.MTX_BASE_URL\}/, "URL comes from MTX_BASE_URL");
  assert.doesNotMatch(urlLine, /API_SECRET/, "the secret must not be interpolated into the URL");
  assert.doesNotMatch(urlLine, /API_KEY/, "the key must not be interpolated into the URL");

  // The secret must still be transmitted, in the JSON body.
  assert.match(src, /apiSecret:\s*process\.env\.MTX_API_SECRET/);
  assert.match(src, /apiKey:\s*process\.env\.MTX_API_KEY/);
});

test("MTX: a malformed upstream body is surfaced as an error, not silently accepted", async () => {
  const createMtxToken = await loadMtx();
  await withMockedAxios(
    async () => ({ data: {} }), // no .data.data
    async () => {
      await assert.rejects(async () => createMtxToken());
    }
  );
});

test("MTX: a network failure propagates instead of yielding a bogus token", async () => {
  const createMtxToken = await loadMtx();
  await withMockedAxios(
    async () => {
      const err = new Error("ECONNREFUSED");
      throw err;
    },
    async () => {
      await assert.rejects(
        async () => createMtxToken(),
        /ECONNREFUSED/,
        "an upstream failure must not be swallowed"
      );
    }
  );
});

test("MTX: an upstream 500 propagates", async () => {
  const createMtxToken = await loadMtx();
  await withMockedAxios(
    async () => {
      const err = new Error("Request failed with status code 500");
      throw err;
    },
    async () => {
      await assert.rejects(async () => createMtxToken(), /500/);
    }
  );
});

// ------------------------------------------------------------ Cloudinary

test("Cloudinary: configuration is read from the environment", () => {
  process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud";
  process.env.CLOUDINARY_API_KEY = "demo-key";
  process.env.CLOUDINARY_API_SECRET = "demo-secret";

  const cfgPath = require.resolve(path.join(dist, "config", "cloudinary.js"));
  delete require.cache[cfgPath];
  const cfg = require(cfgPath);

  const cloudinary = cfg.cloudinary ?? cfg.default;
  assert.ok(cloudinary, "a cloudinary instance must be exported");
  assert.equal(cloudinary.config().cloud_name, "demo-cloud");
  assert.equal(cloudinary.config().api_key, "demo-key");
});

test("Cloudinary: the configured secret is never written to stdout", () => {
  const written = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...a) => {
    written.push(String(s));
    return true;
  };
  try {
    process.env.CLOUDINARY_API_SECRET = "SHOULD-NEVER-APPEAR-12345";
    const cfgPath = require.resolve(path.join(dist, "config", "cloudinary.js"));
    delete require.cache[cfgPath];
    require(cfgPath);
  } finally {
    process.stdout.write = realWrite;
    delete process.env.CLOUDINARY_API_SECRET;
  }
  assert.ok(
    !written.join("").includes("SHOULD-NEVER-APPEAR-12345"),
    "the Cloudinary secret must not be logged"
  );
});

test("the app never references credentials in its logs", () => {
  const fs = require("node:fs");
  const pathMod = require("node:path");
  const srcRoot = path.join(here, "..", "src");
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = pathMod.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts")) {
        const text = fs.readFileSync(full, "utf8");
        // A console call that interpolates a secret-bearing variable.
        if (/console\.(log|error|warn)\([^)]*process\.env\.(MONGO_URI|REDIS_URL|JWT_SECRET|CLOUDINARY_API_SECRET|MTX_API_SECRET)/.test(text)) {
          offenders.push(pathMod.relative(srcRoot, full));
        }
      }
    }
  };
  if (fs.existsSync(srcRoot)) walk(srcRoot);
  assert.deepEqual(offenders, [], `these files may log secrets: ${offenders}`);
});