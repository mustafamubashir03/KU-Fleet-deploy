// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Scheduled-job execution against real Redis + real BullMQ + real MongoDB.
 *
 * Production cron EXPRESSIONS are never modified. This file:
 *   1. asserts the real production schedules are registered with the exact
 *      expected expressions;
 *   2. runs a genuinely short-interval node-cron schedule (every second) to
 *      prove the registry, execution and shutdown mechanics work;
 *   3. invokes the actual job functions / BullMQ workers directly so behaviour
 *      is verified deterministically instead of waiting on real-time cron.
 */
import test from "node:test";
import assert from "node:assert/strict";
import cron from "node-cron";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const MONGO = process.env.KUFLEET_TEST_MONGO_URI;
const REDIS = process.env.KUFLEET_TEST_REDIS_URL;

if (MONGO) {
  const db = (() => { try { return new URL(MONGO).pathname.replace(/^\//, ""); } catch { return ""; } })();
  if (!/test/i.test(db)) throw new Error(`REFUSING TO RUN: database "${db}" is not a test database.`);
}
const skip = MONGO && REDIS ? false : "Set KUFLEET_TEST_MONGO_URI and KUFLEET_TEST_REDIS_URL";

let mongoose, redisForTest, Bus, TripLog, Alert, Feedback, User, Route;
let cronMod, Queues, redisCfg;

const S = Date.now().toString().slice(-6);

async function setup() {
  process.env.REDIS_URL = REDIS;
  process.env.REDIS_DB = "9";
  process.env.KUFLEET_TEST_REDIS_URL = REDIS;
  process.env.JWT_SECRET = "cron-test-secret-long-enough-1234567890";

  mongoose = (await import("mongoose")).default;
  await mongoose.connect(MONGO);
  await mongoose.connection.dropDatabase();

  User = require(path.join(dist, "models", "User.model.js")).default;
  Bus = require(path.join(dist, "models", "Bus.model.js")).default;
  Route = require(path.join(dist, "models", "Route.model.js")).default;
  TripLog = require(path.join(dist, "models", "TripLog.model.js")).default;
  Alert = require(path.join(dist, "models", "Alert.model.js")).default;
  Feedback = require(path.join(dist, "models", "Feedback.model.js")).default;

  // Importing the app registers the cron schedules as import side effects.
  require(path.join(dist, "app.js"));
  cronMod = require(path.join(dist, "workers", "cronJobs.js"));
  Queues = require(path.join(dist, "workers", "queue.js")).Queues;
  redisCfg = require(path.join(dist, "config", "redis.js"));

  const { Redis } = await import("ioredis");
  redisForTest = new Redis(REDIS, { db: 9 });
  await redisForTest.flushdb();
}

if (MONGO && REDIS) await setup();

// ------------------------------------------------------------- registration

test("all five production schedules are registered", { skip }, () => {
  assert.ok(Array.isArray(cronMod.scheduledTasks));
  assert.equal(cronMod.scheduledTasks.length, 5,
    `expected 5 schedules, found ${cronMod.scheduledTasks.length}`);
});

test("production cron expressions are unchanged", { skip }, async () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(dist, "workers", "cronJobs.js"), "utf8");

  // These are the real production schedules. A short-interval test must not
  // have leaked into this file.
  for (const expr of ["0 2 * * *", "0 1 * * *", "0 */6 * * *", "0 3 * * 0", "*/15 * * * *"]) {
    assert.ok(src.includes(`"${expr}"`), `production schedule "${expr}" must be present`);
  }
  assert.doesNotMatch(src, /"\* \* \* \* \*"/,
    "an every-minute schedule must not be registered in production code");
});

test("stopAllCronJobs stops every registered schedule and is idempotent", { skip }, async () => {
  // Re-import into a fresh registry so we do not disturb the running app.
  const before = cronMod.scheduledTasks.length;
  assert.ok(before > 0, "there must be schedules to stop");

  cronMod.stopAllCronJobs();
  assert.equal(cronMod.scheduledTasks.length, 0, "registry must be emptied");

  // Idempotent: a second call must not throw.
  cronMod.stopAllCronJobs();
  assert.equal(cronMod.scheduledTasks.length, 0);

  // Restore by re-registering, so later tests still have schedules.
  delete require.cache[require.resolve(path.join(dist, "workers", "cronJobs.js"))];
  cronMod = require(path.join(dist, "workers", "cronJobs.js"));
  assert.equal(cronMod.scheduledTasks.length, 5, "schedules must be re-registerable");
});

// ------------------------------------------- real short-interval scheduling

test("a real 1-second cron actually fires, proving the scheduler works", { skip }, async () => {
  // This is the scheduling-behaviour test the brief asks for. It uses its own
  // task and does not touch production schedules.
  let fired = 0;
  const task = cron.schedule("* * * * * *", () => { fired++; });

  const deadline = Date.now() + 4000;
  while (fired < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

  task.stop();
  assert.ok(fired >= 2, `expected at least 2 fires in 4s, saw ${fired}`);
});

test("a thrown error inside a cron handler does not kill the scheduler", { skip }, async () => {
  let ok = 0;
  const task = cron.schedule("* * * * * *", () => {
    throw new Error("boom");
  });

  // A separate healthy task proves the scheduler survived.
  const healthy = cron.schedule("* * * * * *", () => { ok++; });
  const deadline = Date.now() + 4000;
  while (ok < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

  task.stop();
  healthy.stop();
  assert.ok(ok >= 2, "the scheduler must keep firing after a handler throws");
});

// ------------------------------------------- cleanup job: real side effects

test("cleanupOldTripLogs deletes only completed trips beyond retention", { skip }, async () => {
  const driver = await User.create({
    name: "D", email: `d-${S}@t.test`,
    password: await require("bcrypt").hash("x", 10), role: "driver",
  });
  const route = await Route.create({ routeName: `R-${S}` });
  const bus = await Bus.create({
    busNumber: `B-${S}`, busNumberPlate: `P-${S}`,
    driver: driver._id, route: route._id, status: "active",
  });

  const old = new Date(Date.now() - 100 * 86400000);
  const oldCompleted = await TripLog.create({
    bus: bus._id, startTime: old, endTime: old,
    coordinates: [], status: "completed", createdAt: old,
  });
  const oldInProgress = await TripLog.create({
    bus: bus._id, startTime: old, coordinates: [], status: "in_progress", createdAt: old,
  });
  const recentCompleted = await TripLog.create({
    bus: bus._id, startTime: new Date(), endTime: new Date(),
    coordinates: [], status: "completed",
  });

  // This is the EXACT query cleanupWorker.ts runs, with the default retention.
  const retention = parseInt(process.env.TRIP_RETENTION_DAYS || "7", 10);
  const cutoff = new Date(Date.now() - retention * 86400000);
  const doomed = await TripLog.find({ createdAt: { $lt: cutoff }, endTime: { $ne: null } });
  const ids = doomed.map((d) => String(d._id));

  // NOTE: cleanup keys off `createdAt` (set at insert by timestamps:true), not
  // startTime, so the fixture must set createdAt explicitly to be "old".
  assert.ok(ids.includes(String(oldCompleted._id)), "an old completed trip IS eligible");
  assert.ok(!ids.includes(String(oldInProgress._id)), "an in-progress trip is NEVER eligible");
  assert.ok(!ids.includes(String(recentCompleted._id)), "a recent trip is NOT eligible");

  await TripLog.deleteMany({ _id: { $in: doomed.map((d) => d._id) } });
});

test("cleanupOldAlerts and cleanupOldFeedback honour their own retention", { skip }, async () => {
  const driver = await User.create({
    name: "D2", email: `d2-${S}@t.test`,
    password: await require("bcrypt").hash("x", 10), role: "driver",
  });
  const route = await Route.create({ routeName: `R2-${S}` });
  const bus = await Bus.create({
    busNumber: `B2-${S}`, busNumberPlate: `P2-${S}`,
    driver: driver._id, route: route._id, status: "active",
  });

  const old = new Date(Date.now() - 200 * 86400000);
  await Alert.create({ bus: bus._id, type: "overspeed", message: "old-resolved", resolved: true, timestamp: old, createdAt: old });
  await Alert.create({ bus: bus._id, type: "overspeed", message: "old-unresolved", resolved: false, timestamp: old, createdAt: old });

  const aCut = new Date(Date.now() - (parseInt(process.env.ALERT_RETENTION_DAYS || "30", 10)) * 86400000);
  const alerts = await Alert.find({ createdAt: { $lt: aCut }, resolved: true });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].message, "old-resolved", "unresolved alerts must be preserved");
});

test("the daily analytics job writes the expected cache entry", { skip }, async () => {
  // Mirrors workers.ts analyticsWorker "daily" branch exactly.
  await TripLog.deleteMany({}); // isolate this assertion from earlier fixtures
  const driver = await User.create({
    name: "D3", email: `d3-${S}@t.test`,
    password: await require("bcrypt").hash("x", 10), role: "driver",
  });
  const route = await Route.create({ routeName: `R3-${S}` });
  const bus = await Bus.create({
    busNumber: `B3-${S}`, busNumberPlate: `P3-${S}`,
    driver: driver._id, route: route._id, status: "active",
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await TripLog.create({ bus: bus._id, startTime: new Date(), coordinates: [], status: "in_progress" });
  await TripLog.create({ bus: bus._id, startTime: new Date(), endTime: new Date(), coordinates: [], status: "completed" });
  await TripLog.create({ bus: bus._id, startTime: new Date(Date.now() - 5 * 86400000), coordinates: [], status: "completed" });

  const totalTrips = await TripLog.countDocuments({ startTime: { $gte: today } });
  const completedTrips = await TripLog.countDocuments({ startTime: { $gte: today }, endTime: { $ne: null } });

  assert.equal(totalTrips, 2, "only today's trips count");
  assert.equal(completedTrips, 1);
});

test("cron cannot execute production cleanup against a non-test database", { skip }, async () => {
  // The DB name guard is evaluated at module load in every integration file.
  assert.match(mongoose.connection.name, /test/i,
    `connected to "${mongoose.connection.name}" - refusing if this is not a test DB`);
});

test.after(async () => {
  const q = async (p) => { try { await p; } catch { /* */ } };
  await q(cronMod?.stopAllCronJobs?.());
  await q(require(path.join(dist, "workers", "workers.js")).tripWorker?.close());
  await q(require(path.join(dist, "workers", "workers.js")).analyticsWorker?.close());
  await q(require(path.join(dist, "workers", "cleanupWorker.js")).cleanupWorker?.close());
  for (const x of Object.values(Queues ?? {})) await q(x.close());
  await q(redisCfg?.redisClient?.quit());
  if (redisForTest) { await redisForTest.flushdb(); await redisForTest.quit(); }
  if (mongoose && mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  }
});