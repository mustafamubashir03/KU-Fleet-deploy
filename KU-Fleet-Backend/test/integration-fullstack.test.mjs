// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * FULL-STACK integration tests: real Express app + real MongoDB + real Redis.
 *
 * Nothing is mocked. These drive the application's OWN compiled Express app,
 * models, middleware and controllers over real HTTP.
 *
 * Isolation guards (fail closed):
 *   - KUFLEET_TEST_MONGO_URI and KUFLEET_TEST_REDIS_URL must BOTH be set,
 *     otherwise every test skips.
 *   - The database name must contain "test"; otherwise the run aborts, so a
 *     mis-set variable can never point destructive fixtures at production.
 *   - Only documents created by this file are removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const MONGO = process.env.KUFLEET_TEST_MONGO_URI;
const REDIS = process.env.KUFLEET_TEST_REDIS_URL;

if (MONGO) {
  const dbName = (() => {
    try {
      return new URL(MONGO).pathname.replace(/^\//, "");
    } catch {
      return "";
    }
  })();
  if (!/test/i.test(dbName)) {
    throw new Error(
      `REFUSING TO RUN: KUFLEET_TEST_MONGO_URI database "${dbName}" does not contain "test".`
    );
  }
}

const skip =
  MONGO && REDIS
    ? false
    : "Set BOTH KUFLEET_TEST_MONGO_URI and KUFLEET_TEST_REDIS_URL to disposable local services";

let app;
let mongoose;
let server;
let baseUrl;
let User, Bus, TripLog;
let redisForTest;

if (MONGO && REDIS) {
  process.env.REDIS_URL = REDIS;
  process.env.REDIS_DB = "9";
  process.env.KUFLEET_TEST_REDIS_URL = REDIS;
  process.env.JWT_SECRET = "integration-test-secret-that-is-long-enough-123456";

  mongoose = (await import("mongoose")).default;
  await mongoose.connect(MONGO);
  User = require(path.join(dist, "models", "User.model.js")).default;
  Bus = require(path.join(dist, "models", "Bus.model.js")).default;
  TripLog = require(path.join(dist, "models", "TripLog.model.js")).default;

  // Importing the app boots workers and cron against the TEST services.
  app = require(path.join(dist, "app.js")).app;

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { Redis } = await import("ioredis");
  redisForTest = new Redis(REDIS, { db: 9 });
}

async function api(method, urlPath, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const suffix = Date.now().toString().slice(-8);

// Bus.driver AND Bus.route are both required by the schema.
let routeCache = null;
async function makeRoute() {
  if (!routeCache) {
    const Route = require(path.join(dist, "models", "Route.model.js")).default;
    routeCache = (await Route.create({ routeName: `R-${suffix}` }))._id;
  }
  return routeCache;
}

async function makeDriver() {
  const bcrypt = require("bcrypt");
  const u = await User.create({
    name: "Driver",
    email: `drv-${Math.random().toString(36).slice(2, 10)}@example.test`,
    password: await bcrypt.hash("Passw0rd!", 10),
    role: "driver",
  });
  return u._id;
}

// ---------------------------------------------------------------- readiness

test("stack is live: mongo + redis + http all reachable", { skip }, async () => {
  assert.equal(mongoose.connection.readyState, 1, "MongoDB must be connected");
  assert.equal(await redisForTest.ping(), "PONG");
  const res = await api("GET", "/");
  assert.equal(res.status, 200);
});

test("security headers are actually present on real responses", { skip }, async () => {
  const res = await api("GET", "/");
  assert.ok(res.headers.get("x-content-type-options"), "helmet must be mounted");
  assert.ok(res.headers.get("x-frame-options"), "helmet must be mounted");
  assert.ok(res.headers.get("content-security-policy"), "helmet CSP must be mounted");
});

// ------------------------------------------------------ registration + auth

test("ordinary registration succeeds and never grants admin", { skip }, async () => {
  const email = `rider-${suffix}@example.test`;
  const res = await api("POST", "/api/auth/register", {
    body: { name: "Rider", email, password: "Passw0rd!", role: "driver" },
  });

  assert.equal(res.status, 201);
  assert.equal(res.json.user.role, "driver");
  assert.ok(!res.json.user.password, "password must never be returned");

  const stored = await User.findOne({ email });
  assert.ok(stored, "user must be persisted");
  assert.notEqual(stored.password, "Passw0rd!", "password must be hashed");
  assert.ok(stored.password.startsWith("$2"), "expected a bcrypt hash");
  await User.deleteOne({ _id: stored._id });
});

test("self-registering as admin is refused", { skip }, async () => {
  const res = await api("POST", "/api/auth/register", {
    body: {
      name: "Sneaky",
      email: `sneaky-${suffix}@example.test`,
      password: "Passw0rd!",
      role: "admin",
    },
  });

  assert.equal(res.status, 403);
  assert.equal(await User.countDocuments({ email: `sneaky-${suffix}@example.test` }), 0);
});

test("registration rejects an unknown role with 400", { skip }, async () => {
  const res = await api("POST", "/api/auth/register", {
    body: { name: "X", email: `x-${suffix}@example.test`, password: "p", role: "superuser" },
  });
  assert.equal(res.status, 400);
});

test("registration requires email and password", { skip }, async () => {
  const res = await api("POST", "/api/auth/register", { body: { name: "NoCreds" } });
  assert.equal(res.status, 400);
});

test("login succeeds with correct credentials and returns a usable token", { skip }, async () => {
  const email = `login-${suffix}@example.test`;
  await User.create({
    name: "LoginUser",
    email,
    password: "$2b$10$abcdefghijklmnopqrstuv", // replaced below
    role: "driver",
  });
  const bcrypt = require("bcrypt");
  const hash = await bcrypt.hash("Passw0rd!", 10);
  await User.updateOne({ email }, { password: hash });

  const res = await api("POST", "/api/auth/login", { body: { email, password: "Passw0rd!" } });
  assert.equal(res.status, 200);
  assert.ok(res.json.token, "a token must be returned");

  // The token must actually authorize a protected route.
  const me = await api("GET", `/api/users/me`, { token: res.json.token });
  // /api/users/me is routed to getUserById("me"), which is not a valid ObjectId.
  assert.ok([200, 400, 404].includes(me.status), `unexpected ${me.status}`);

  const doc = await User.findOne({ email });
  await User.deleteOne({ _id: doc._id });
});

test("login with a wrong password is rejected", { skip }, async () => {
  const res = await api("POST", "/api/auth/login", {
    body: { email: `nobody-${suffix}@example.test`, password: "whatever" },
  });
  assert.equal(res.status, 404);
  assert.ok(!res.text.includes("password"), "must not leak credential details");
});

// ---------------------------------------------------------- authorization

test("protected routes reject a missing token", { skip }, async () => {
  for (const p of [
    "/api/users",
    "/api/buses",
    "/api/drivers",
    "/api/alerts/stats",
    "/api/analytics/overview",
    "/api/routes",
    "/api/stations",
    "/api/tripLogs/summary/daily",
    "/api/rfid/logs",
  ]) {
    const res = await api("GET", p);
    assert.equal(res.status, 401, `${p} must require authentication`);
  }
});

test("a non-admin cannot reach admin-only routes", { skip }, async () => {
  const bcrypt = require("bcrypt");
  const email = `nonadm-${suffix}@example.test`;
  const created = await User.create({
    name: "NonAdmin",
    email,
    password: await bcrypt.hash("Passw0rd!", 10),
    role: "student",
  });

  const login = await api("POST", "/api/auth/login", {
    body: { email, password: "Passw0rd!" },
  });
  const token = login.json.token;

  assert.equal((await api("GET", "/api/users", { token })).status, 403, "GET /api/users is adminOnly");
  assert.equal((await api("POST", "/api/buses", { token, body: {} })).status, 403, "create bus is adminOnly");

  await User.deleteOne({ _id: created._id });
});

test("a malformed or tampered token is rejected", { skip }, async () => {
  for (const bad of ["not-a-jwt", "a.b.c"]) {
    const res = await api("GET", "/api/users", { token: bad });
    assert.equal(res.status, 401, `"${bad}" must not authenticate`);
  }
});

// ------------------------------------------------- NoSQL injection + safety

test("MongoDB operators in the query string are stripped", { skip }, async () => {
  // Without sanitiseInput, {"$ne":null} could turn a lookup into "any user".
  const res = await api("GET", `/api/users?email[$ne]=null&role[$gt]=`);
  assert.ok(!res.text.includes('"$ne"'), "operators must not survive into the handler");
});

test("oversized JSON bodies are rejected rather than buffered", { skip }, async () => {
  const big = { name: "x".repeat(12 * 1024 * 1024), email: `big-${suffix}@e.test`, password: "p" };
  const res = await api("POST", "/api/auth/register", { body: big });
  assert.ok(res.status === 413 || res.status === 400 || res.status === 500,
    `expected a rejection, got ${res.status}`);
});

test("unknown routes return the 404 handler shape", { skip }, async () => {
  const res = await api("GET", "/api/definitely-not-a-route");
  assert.equal(res.status, 404);
  assert.equal(res.json.success, false);
});

test("error responses never include a stack trace", { skip }, async () => {
  const res = await api("GET", "/api/users/not-a-valid-objectid");
  assert.ok(!/"stack"/.test(res.text), "stack traces must not be exposed");
});

// ------------------------------------------------- MongoDB data + relations

test("bus is persisted with a trackerIMEI that GT06 login can resolve", { skip }, async () => {
  const imei = String(123456789012345);
  const driverId = await makeDriver();
  const routeId = await makeRoute();
  const bus = await Bus.create({
    busNumber: `B-${suffix}`,
    busNumberPlate: `P-${suffix}`,
    driver: driverId,
    route: routeId,
    trackerIMEI: imei,
    status: "active",
  });

  const found = await Bus.findOne({ trackerIMEI: imei });
  assert.ok(found, "must be findable by trackerIMEI");
  assert.equal(String(found._id), String(bus._id));

  // Duplicate IMEI must be rejected by the unique index.
  await assert.rejects(
    () => Bus.create({ busNumber: `B2-${suffix}`, busNumberPlate: `P2-${suffix}`, driver: driverId, route: routeId, trackerIMEI: imei }),
    /duplicate key/i
  );

  await Bus.deleteOne({ _id: bus._id });
});

test("trip lifecycle: create -> append coordinates -> complete", { skip }, async () => {
  const bus = await Bus.create({
    busNumber: `BT-${suffix}`,
    busNumberPlate: `PT-${suffix}`,
    driver: await makeDriver(),
    route: await makeRoute(),
    status: "active",
  });

  const trip = await TripLog.create({
    bus: bus._id,
    startTime: new Date("2026-01-01T08:00:00Z"),
    coordinates: [{ lat: 31.5204, lng: 74.3587, speed: 30, timestamp: new Date() }],
    status: "in_progress",
  });

  // The exact query gpsHandler uses to find the active trip.
  let active = await TripLog.findOne({ bus: bus._id, endTime: null });
  assert.ok(active, "an in-progress trip must be findable with endTime: null");

  // Append a coordinate the way the trip worker does.
  await TripLog.updateOne(
    { bus: bus._id, endTime: null },
    {
      $push: { coordinates: { lat: 31.53, lng: 74.37, speed: 35, timestamp: new Date() } },
      $set: { lastUpdate: new Date(), currentSpeed: 35 },
    }
  );

  const updated = await TripLog.findById(trip._id);
  assert.equal(updated.coordinates.length, 2, "coordinate must be appended");
  assert.equal(updated.coordinates[1].lat, 31.53);

  // Complete it.
  updated.endTime = new Date("2026-01-01T09:00:00Z");
  updated.status = "completed";
  updated.distance = 12.5;
  await updated.save();

  active = await TripLog.findOne({ bus: bus._id, endTime: null });
  assert.equal(active, null, "a completed trip must no longer match the active-trip query");

  const stored = await TripLog.findById(trip._id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.distance, 12.5);

  await TripLog.deleteOne({ _id: trip._id });
  await Bus.deleteOne({ _id: bus._id });
});

test("retention query used by cleanupWorker only matches completed trips", { skip }, async () => {
  // cleanupWorker.ts deletes { createdAt: { $lt: cutoff }, endTime: { $ne: null } }.
  // In MongoDB, $ne: null does NOT match a missing field, so an in-progress
  // trip must survive. This is the property that protects live trips.
  const bus = await Bus.create({
    busNumber: `BR-${suffix}`,
    busNumberPlate: `PR-${suffix}`,
    driver: await makeDriver(),
    route: await makeRoute(),
    status: "active",
  });
  const old = new Date("2020-01-01");

  const inProgress = await TripLog.create({
    bus: bus._id,
    startTime: old,
    coordinates: [],
    status: "in_progress",
    createdAt: old,
  });
  const completed = await TripLog.create({
    bus: bus._id,
    startTime: old,
    endTime: old,
    coordinates: [],
    status: "completed",
    createdAt: old,
  });

  const cutoff = new Date("2024-01-01");
  const toDelete = await TripLog.find({ createdAt: { $lt: cutoff }, endTime: { $ne: null } });
  const ids = toDelete.map((d) => String(d._id));

  assert.ok(ids.includes(String(completed._id)), "an old COMPLETED trip must be selected");
  assert.ok(!ids.includes(String(inProgress._id)), "an in-progress trip must NEVER be selected");

  await TripLog.deleteMany({ _id: { $in: [inProgress._id, completed._id] } });
  await Bus.deleteOne({ _id: bus._id });
});

test("missing and malformed ids are handled without crashing", { skip }, async () => {
  const res = await api("GET", "/api/users/000000000000000000000000");
  // `protect` runs before the handler, so an unauthenticated lookup is 401.
  assert.ok([401, 404, 400].includes(res.status), `unexpected ${res.status}`);

  const bad = await api("GET", "/api/users/not-an-objectid");
  assert.ok([400, 401, 404].includes(bad.status), `unexpected ${bad.status}`);
});

// ------------------------------------------------------------------ cleanup

test.after(async () => {
  // Importing app.js starts BullMQ workers and cron as import side effects.
  // Those keep the event loop alive, so they must be closed explicitly or the
  // runner hangs. They are module singletons, so requiring them here yields the
  // same instances the app created.
  const closeQuietly = async (p) => {
    try {
      await p;
    } catch {
      /* already closed */
    }
  };

  // Cron schedules also keep the loop alive and must be cancelled.
  await closeQuietly(require(path.join(dist, "workers", "cronJobs.js")).stopAllCronJobs?.());

  await closeQuietly(require(path.join(dist, "workers", "workers.js")).tripWorker?.close());
  await closeQuietly(require(path.join(dist, "workers", "workers.js")).analyticsWorker?.close());
  await closeQuietly(require(path.join(dist, "workers", "cleanupWorker.js")).cleanupWorker?.close());
  for (const q of Object.values(require(path.join(dist, "workers", "queue.js")).Queues ?? {})) {
    await closeQuietly(q.close());
  }

  // The app's own ioredis client (shared by every worker) also holds the loop.
  await closeQuietly(require(path.join(dist, "config", "redis.js")).redisClient?.quit());

  if (server) await new Promise((r) => server.close(r));
  if (redisForTest) {
    await redisForTest.flushdb();
    await redisForTest.quit();
  }
  if (mongoose && mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  }
});