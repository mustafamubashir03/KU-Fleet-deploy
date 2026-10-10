// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Background-job topology regressions.
 *
 * Confirmed defect: two BullMQ Workers were registered against the SAME
 * "cleanupQueue" with different, incompatible semantics.
 *
 *   src/workers/workers.ts      ignored job.name entirely and ALWAYS ran
 *                               TripLog.deleteMany({ endTime: { $lt: now-30d } })
 *   src/workers/cleanupWorker.ts switched on job.name correctly
 *
 * BullMQ distributes each job to exactly one worker, so a job enqueued as
 * "clearExpiredCache" or "archiveOldData" landing on the first worker would have
 * deleted trip logs. Retention was also nondeterministic: 30 days vs
 * TRIP_RETENTION_DAYS (default 7).
 *
 * These assertions are static (they read the compiled output) because starting
 * real BullMQ workers requires Redis, which is deliberately not available in the
 * unit test run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "workers");

/** Strip comments so prose describing a bug cannot trip a code assertion. */
function code(file) {
  return fs
    .readFileSync(path.join(dist, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const workersSrc = code("workers.js");
const cleanupSrc = code("cleanupWorker.js");
const queueSrc = code("queue.js");

/**
 * TypeScript compiles `new Worker(...)` / `new Queue(...)` to namespace calls
 * such as `new bullmq_1.Worker(...)`, so match the class name, not the literal.
 */
function countConstructions(src, className, queueName) {
  const re = new RegExp(`new\\s+[\\w.$]*\\.${className}\\s*\\(\\s*["'\`]${queueName}["'\`]`, "g");
  return (src.match(re) || []).length;
}

test("exactly one Worker is registered for cleanupQueue (was two)", () => {
  const inWorkers = countConstructions(workersSrc, "Worker", "cleanupQueue");
  const inCleanup = countConstructions(cleanupSrc, "Worker", "cleanupQueue");

  assert.equal(
    inWorkers + inCleanup,
    1,
    `expected a single cleanupQueue consumer, found ${inWorkers} in workers.js and ${inCleanup} in cleanupWorker.js`
  );
});

test("the surviving cleanup worker switches on job.name", () => {
  for (const jobName of [
    "cleanupOldTripLogs",
    "cleanupOldAlerts",
    "cleanupOldFeedback",
    "clearExpiredCache",
    "archiveOldData",
  ]) {
    assert.ok(cleanupSrc.includes(jobName), `cleanupWorker must still handle "${jobName}"`);
  }
});

test("no name-agnostic TripLog delete remains in the workers module", () => {
  assert.doesNotMatch(
    workersSrc,
    /TripLog\.deleteMany\(\{\s*endTime:\s*\{\s*\$lt/,
    "the hardcoded 30-day delete must be gone"
  );
});

test("trip and analytics workers are still registered", () => {
  assert.equal(countConstructions(workersSrc, "Worker", "tripQueue"), 1);
  assert.equal(countConstructions(workersSrc, "Worker", "analyticsQueue"), 1);
});

test("all three queues are created exactly once", () => {
  for (const q of ["tripQueue", "analyticsQueue", "cleanupQueue"]) {
    assert.equal(
      countConstructions(queueSrc, "Queue", q),
      1,
      `${q} must be instantiated exactly once`
    );
  }
});

test("workers and queues agree on queue names", () => {
  const workerQueues = [...workersSrc.matchAll(/new\s+[\w.$]*\.Worker\s*\(\s*["'`]([^"'`]+)/g)].map(
    (m) => m[1]
  );
  const cleanupQueues = [...cleanupSrc.matchAll(/new\s+[\w.$]*\.Worker\s*\(\s*["'`]([^"'`]+)/g)].map(
    (m) => m[1]
  );
  const createdQueues = [...queueSrc.matchAll(/new\s+[\w.$]*\.Queue\s*\(\s*["'`]([^"'`]+)/g)].map(
    (m) => m[1]
  );

  for (const q of [...workerQueues, ...cleanupQueues]) {
    assert.ok(
      createdQueues.includes(q),
      `queue "${q}" is consumed but never created by src/workers/queue.ts`
    );
  }
});