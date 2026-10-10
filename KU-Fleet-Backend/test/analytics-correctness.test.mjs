// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Analytics correctness against a KNOWN dataset.
 * Real MongoDB, real Redis, real controllers over real HTTP.
 *
 * Every expected number is computed by hand from the fixtures, so an assertion
 * fails if an aggregation is wrong - not merely if it returns 200.
 *
 * Guards three schema/query mismatches confirmed by reading the models:
 *   Bus.status       vs the old query on Bus.busStatus  (matched nothing)
 *   Bus.driver (Oid) vs the old query on "driver._id"   (matched nothing)
 *   Bus.distinct("driver.name")                          (not a real path)
 * plus the cache-hit vs cache-miss response-shape divergence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const MONGO = process.env.KUFLEET_TEST_MONGO_URI;
const REDIS = process.env.KUFLEET_TEST_REDIS_URL;
const S = Date.now().toString().slice(-6);

if (MONGO) {
  const db = (() => {
    try {
      return new URL(MONGO).pathname.replace(/^\//, "");
    } catch {
      return "";
    }
  })();
  if (!/test/i.test(db)) throw new Error(`REFUSING TO RUN: database "${db}" is not a test database.`);
}

const skip = MONGO && REDIS ? false : "Set KUFLEET_TEST_MONGO_URI and KUFLEET_TEST_REDIS_URL";

let mongoose, app, server, baseUrl, adminToken, redisForTest;
let User, Bus, TripLog, Alert, Feedback, Route;
let ids;

// Hand-computed expectations:
// Bus A -> 3 trips, 10+20+30 = 60 km, avgSpeed (20+40+60)/3 = 40, 2 alerts
// Bus B -> 1 trip,  5 km, avgSpeed 10,                    1 alert
// Bus C -> 0 trips (driver D1, but no trips)
// D1 drives A and C -> 3 trips / 60 km / 2 alerts
// Feedback ratings 5,4,4 -> avg 13/3 ; two unresolved
async function seed() {
  const bcrypt = require("bcrypt");
  const pw = await bcrypt.hash("Passw0rd!", 10);

  const d1 = await User.create({ name: "Driver One", email: `d1-${S}@t.test`, password: pw, role: "driver" });
  const d2 = await User.create({ name: "Driver Two", email: `d2-${S}@t.test`, password: pw, role: "driver" });
  const admin = await User.create({ name: "Admin", email: `ad-${S}@t.test`, password: pw, role: "admin" });

  const r1 = await Route.create({ routeName: `Route R1 ${S}` });
  const r2 = await Route.create({ routeName: `Route R2 ${S}` });

  const busA = await Bus.create({
    busNumber: `BA-${S}`, busNumberPlate: `BAP-${S}`,
    driver: d1._id, route: r1._id, status: "active", trackerIMEI: "111111111111111",
  });
  const busB = await Bus.create({
    busNumber: `BB-${S}`, busNumberPlate: `BBP-${S}`,
    driver: d2._id, route: r2._id, status: "inactive", trackerIMEI: "222222222222222",
  });
  const busC = await Bus.create({
    busNumber: `BC-${S}`, busNumberPlate: `BCP-${S}`,
    driver: d1._id, route: r1._id, status: "active", trackerIMEI: "333333333333333",
  });

  const now = Date.now();
  const mk = (bus, distance, avgSpeed, daysAgo) =>
    TripLog.create({
      bus: bus._id,
      startTime: new Date(now - daysAgo * 86400000),
      endTime: new Date(now - daysAgo * 86400000 + 3600000),
      coordinates: [], distance, avgSpeed, status: "completed", passengerCount: 0,
    });

  await mk(busA, 10, 20, 1);
  await mk(busA, 20, 40, 2);
  await mk(busA, 30, 60, 3);
  await mk(busB, 5, 10, 1);

  await Alert.create({ bus: busA._id, type: "overspeed", message: "o1", resolved: false });
  await Alert.create({ bus: busA._id, type: "overspeed", message: "o2", resolved: true });
  await Alert.create({ bus: busB._id, type: "panic", message: "p1", resolved: false });

  await Feedback.create({ bus: busA._id, user: admin._id, rating: 5, resolved: true, comment: "great" });
  await Feedback.create({ bus: busA._id, user: admin._id, rating: 4, resolved: false, comment: "ok" });
  await Feedback.create({ bus: busB._id, user: admin._id, rating: 4, resolved: false, comment: "ok2" });

  return { admin, busA, busB, busC, d1, d2, r1, r2 };
}

async function api(urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: { authorization: `Bearer ${adminToken}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}

// --- setup runs to completion BEFORE any test is registered ------------------
if (MONGO && REDIS) {
  process.env.REDIS_URL = REDIS;
  process.env.REDIS_DB = "9";
  process.env.KUFLEET_TEST_REDIS_URL = REDIS;
  process.env.JWT_SECRET = "analytics-test-secret-long-enough-12345678";

  mongoose = (await import("mongoose")).default;
  await mongoose.connect(MONGO);

  // A previous aborted run can leave fixtures behind; start from a clean slate.
  await mongoose.connection.dropDatabase();

  User = require(path.join(dist, "models", "User.model.js")).default;
  Bus = require(path.join(dist, "models", "Bus.model.js")).default;
  Route = require(path.join(dist, "models", "Route.model.js")).default;
  TripLog = require(path.join(dist, "models", "TripLog.model.js")).default;
  Alert = require(path.join(dist, "models", "Alert.model.js")).default;
  Feedback = require(path.join(dist, "models", "Feedback.model.js")).default;

  app = require(path.join(dist, "app.js")).app;
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { Redis } = await import("ioredis");
  redisForTest = new Redis(REDIS, { db: 9 });

  ids = await seed();

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `ad-${S}@t.test`, password: "Passw0rd!" }),
  });
  adminToken = (await login.json()).token;
}

test("analytics stack is live", { skip }, async () => {
  assert.equal(mongoose.connection.readyState, 1);
  assert.equal(await redisForTest.ping(), "PONG");
  assert.equal((await api("/api/analytics/overview")).status, 200);
});

test("fleet overview counts match the seeded dataset", { skip }, async () => {
  const { json } = await api("/api/analytics/overview");

  // Regression guard: the schema field is `status`, not `busStatus`.
  assert.equal(json.overview.totalBuses, 3);
  assert.equal(json.overview.activeBuses, 2, "2 of 3 buses are active");
  assert.equal(json.overview.totalDrivers, 2, "distinct Bus.driver references");
  assert.equal(json.overview.totalTrips, 4);
  assert.equal(json.overview.totalAlerts, 3);

  const expectedAvg = (5 + 4 + 4) / 3;
  assert.ok(Math.abs(json.overview.avgRating - expectedAvg) < 1e-9,
    `avgRating should be ${expectedAvg}, got ${json.overview.avgRating}`);
});

test("overview has the SAME shape on a cache hit as on a cache miss", { skip }, async () => {
  const first = await api("/api/analytics/overview");
  const second = await api("/api/analytics/overview"); // now served from Redis

  assert.ok(first.json.overview, "cold response must expose overview");
  assert.ok(second.json.overview, "warm response must expose overview too");
  assert.deepEqual(Object.keys(first.json).sort(), Object.keys(second.json).sort(),
    "cache hit and miss must be indistinguishable to the client");
  assert.deepEqual(first.json.overview, second.json.overview);
});

test("bus analytics aggregates only that bus's trips", { skip }, async () => {
  const a = await api(`/api/analytics/bus/${ids.busA._id}`);
  assert.equal(a.status, 200);
  assert.ok(a.json.data, "the frontend contract is { success, data }");
  assert.equal(a.json.data.busId, String(ids.busA._id));
  assert.equal(a.json.data.stats.totalTrips, 3);
  assert.equal(a.json.data.stats.totalDistance, 60);
  assert.ok(Math.abs(a.json.data.stats.avgSpeed - 40) < 1e-6);
  assert.equal(a.json.data.alerts.length, 2);

  const b = await api(`/api/analytics/bus/${ids.busB._id}`);
  assert.equal(b.json.data.stats.totalTrips, 1);
  assert.equal(b.json.data.stats.totalDistance, 5);
  assert.equal(b.json.data.alerts.length, 1);
});

test("driver analytics resolves buses by the ObjectId driver ref", { skip }, async () => {
  const res = await api(`/api/analytics/driver/${ids.d1._id}`);
  assert.equal(res.status, 200);
  assert.ok(res.json.data, "driver analytics must return `data`");

  // Regression guard: the old query used "driver._id" and matched nothing.
  assert.equal(res.json.data.trips.totalTrips, 3);
  assert.equal(res.json.data.trips.totalDistance, 60);
  assert.equal(res.json.data.totalAlerts, 2);
});

test("a driver with no buses returns zeros, not an error", { skip }, async () => {
  const stranger = await User.create({
    name: "No Buses", email: `nb-${S}@t.test`,
    password: await require("bcrypt").hash("Passw0rd!", 10), role: "driver",
  });
  const res = await api(`/api/analytics/driver/${stranger._id}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.trips.totalTrips, 0);
  assert.equal(res.json.data.totalAlerts, 0);
});

test("route analytics groups by the bus's route", { skip }, async () => {
  const res = await api("/api/analytics/routes");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.routeStats));

  const r1 = res.json.routeStats.find((r) => String(r._id) === String(ids.r1._id));
  assert.ok(r1, "bus A's route must appear");
  assert.equal(r1.totalTrips, 3, "r1 carries all of bus A's trips");
  assert.equal(r1.totalDistance, 60);

  const r2 = res.json.routeStats.find((r) => String(r._id) === String(ids.r2._id));
  assert.equal(r2.totalTrips, 1);
  assert.equal(r2.totalDistance, 5);
});

test("alert trends group by alert type", { skip }, async () => {
  const res = await api("/api/analytics/alerts");
  assert.equal(res.status, 200);
  assert.equal(res.json.alertTrends.find((t) => t._id === "overspeed").total, 2);
  assert.equal(res.json.alertTrends.find((t) => t._id === "panic").total, 1);
});

test("feedback analytics averages and counts unresolved", { skip }, async () => {
  const res = await api("/api/analytics/feedback");
  assert.equal(res.status, 200);
  assert.equal(res.json.ratings.reduce((a, r) => a + r.count, 0), 3);
  assert.ok(res.json.ratings.find((r) => r._id === 5));
  assert.equal(res.json.unresolvedComplaints, 2);
});

test("timeseries buckets by day and respects the window", { skip }, async () => {
  const wide = await api("/api/analytics/timeseries?days=30");
  assert.equal(wide.json.days, 30);
  assert.equal(wide.json.trips.reduce((a, t) => a + t.totalTrips, 0), 4,
    "all four seeded trips fall inside 30 days");
  for (const b of wide.json.trips) assert.match(b._id, /^\d{4}-\d{2}-\d{2}$/);

  const narrow = await api("/api/analytics/timeseries?days=1");
  assert.equal(narrow.json.days, 1);
  assert.equal(narrow.json.trips.reduce((a, t) => a + t.totalTrips, 0), 0,
    "no seeded trip is within the last day");
});

test("analytics require authentication", { skip }, async () => {
  for (const p of [
    "/api/analytics/overview", "/api/analytics/routes",
    "/api/analytics/alerts", "/api/analytics/feedback",
    "/api/analytics/timeseries",
  ]) {
    assert.equal((await fetch(`${baseUrl}${p}`)).status, 401, `${p} must require auth`);
  }
});

test.after(async () => {
  const q = async (p) => { try { await p; } catch { /* */ } };
  await q(require(path.join(dist, "workers", "cronJobs.js")).stopAllCronJobs?.());
  await q(require(path.join(dist, "workers", "workers.js")).tripWorker?.close());
  await q(require(path.join(dist, "workers", "workers.js")).analyticsWorker?.close());
  await q(require(path.join(dist, "workers", "cleanupWorker.js")).cleanupWorker?.close());
  for (const x of Object.values(require(path.join(dist, "workers", "queue.js")).Queues ?? {})) await q(x.close());
  await q(require(path.join(dist, "config", "redis.js")).redisClient?.quit());

  if (server) await new Promise((r) => server.close(r));
  if (redisForTest) { await redisForTest.flushdb(); await redisForTest.quit(); }
  if (mongoose && mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  }
});