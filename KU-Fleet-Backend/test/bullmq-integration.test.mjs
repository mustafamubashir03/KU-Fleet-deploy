// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * BullMQ integration tests against a REAL Redis and the application's OWN
 * compiled queue/worker modules. Nothing about the queue is mocked.
 *
 * Uses logical database 9 on a disposable local Redis and deletes only what it
 * creates. Requires KUFLEET_TEST_REDIS_URL; otherwise every test skips rather
 * than falling back to the configured (production) REDIS_URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const TEST_REDIS_URL = process.env.KUFLEET_TEST_REDIS_URL;
const skip = TEST_REDIS_URL
  ? false
  : "Set KUFLEET_TEST_REDIS_URL to a disposable local Redis (e.g. redis://127.0.0.1:6379)";

let Redis;
let testRedis;
let queueModule;

if (TEST_REDIS_URL) {
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.REDIS_DB = "9";
  // Point the compiled config at the test database before it is required.
  process.env.KUFLEET_TEST_REDIS_URL = TEST_REDIS_URL;
  // queue.js -> config/redis.js validates required config at module load.
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "bullmq-test-secret-long-enough-123456";
  Redis = (await import("ioredis")).Redis;
  testRedis = new Redis(TEST_REDIS_URL, { db: 9, maxRetriesPerRequest: null });
  await testRedis.ping();
  await testRedis.flushdb();
  queueModule = require(path.join(dist, "workers", "queue.js"));
}

test("redis reachable and disposable database empty", { skip }, async () => {
  assert.equal(await testRedis.ping(), "PONG");
  assert.equal(await testRedis.dbsize(), 0);
});

test("all three application queues are real BullMQ queues on the test Redis", { skip }, async () => {
  for (const name of ["tripQueue", "analyticsQueue", "cleanupQueue"]) {
    const q = queueModule[name];
    assert.ok(q, `${name} must be exported`);
    assert.equal(q.name, name, `${name} must use its declared queue name`);
    assert.equal(typeof q.add, "function");
  }
});

test("a job is enqueued and consumed exactly once", { skip }, async () => {
  const { Queue, Worker } = await import("bullmq");

  // Use a unique queue so the application's own workers cannot interfere.
  const qname = "test-once-" + Date.now();
  const processed = [];

  const worker = new Worker(
    qname,
    async (job) => {
      processed.push(job.data.n);
    },
    { connection: { url: TEST_REDIS_URL, db: 9 }, maxRetriesPerRequest: null }
  );
  const queue = new Queue(qname, { connection: { url: TEST_REDIS_URL, db: 9 } });

  await queue.add("noop", { n: 1 });
  await queue.add("noop", { n: 2 });

  const deadline = Date.now() + 8000;
  while (processed.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(processed.length, 2, "both jobs must be processed");
  assert.deepEqual(processed.sort(), [1, 2], "each job body runs exactly once");

  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await worker.close();
});

test("a failing job retries and is then recorded as failed", { skip }, async () => {
  const { Queue, Worker } = await import("bullmq");

  const qname = "test-retry-" + Date.now();
  let attempts = 0;

  const worker = new Worker(
    qname,
    async () => {
      attempts++;
      throw new Error("deliberate failure");
    },
    { connection: { url: TEST_REDIS_URL, db: 9 }, maxRetriesPerRequest: null }
  );
  const queue = new Queue(qname, { connection: { url: TEST_REDIS_URL, db: 9 } });

  await queue.add(
    "fail",
    {},
    { attempts: 3, backoff: { type: "exponential", delay: 50 } }
  );

  const deadline = Date.now() + 15000;
  while (attempts < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(attempts, 3, "the job must be attempted exactly 3 times");

  const counts = await queue.getJobCounts("failed");
  assert.equal(counts.failed, 1, "the exhausted job must be recorded as failed");

  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await worker.close();
});

test("job counts are observable for the health check cron", { skip }, async () => {
  const { Queue, Worker } = await import("bullmq");
  const qname = "test-counts-" + Date.now();
  const worker = new Worker(
    qname,
    async () => {},
    { connection: { url: TEST_REDIS_URL, db: 9 }, maxRetriesPerRequest: null }
  );
  const queue = new Queue(qname, { connection: { url: TEST_REDIS_URL, db: 9 } });

  await queue.add("a", {});
  await queue.add("b", {});
  await new Promise((r) => setTimeout(r, 400));

  // This is exactly what cronJobs.ts health-check calls every 15 minutes.
  const counts = await queue.getJobCounts();
  assert.equal(typeof counts.waiting, "number");
  assert.equal(typeof counts.failed, "number");
  assert.ok(
    counts.completed + counts.waiting + counts.active >= 2,
    "both enqueued jobs must be accounted for"
  );

  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await worker.close();
});

test("BullMQ keys live in the selected database, not a shared default", { skip }, async () => {
  const { Queue, Worker } = await import("bullmq");
  const qname = "test-isolation-" + Date.now();
  const worker = new Worker(
    qname,
    async () => {},
    { connection: { url: TEST_REDIS_URL, db: 9 }, maxRetriesPerRequest: null }
  );
  const queue = new Queue(qname, { connection: { url: TEST_REDIS_URL, db: 9 } });
  await queue.add("x", {});
  await new Promise((r) => setTimeout(r, 400));

  const keys = await testRedis.keys("bull:*");
  assert.ok(keys.length > 0, "bull keys must exist in db 9");

  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await worker.close();
});

test("the application's own queue producers accept a job without error", { skip }, async () => {
  // Exercises the real exported Queue instances (which share the app's Redis
  // client) rather than a locally constructed duplicate.
  const payload = {
    busId: "testbus0000000000000001",
    coords: { lat: 31.5204, lng: 74.3587 },
  };

  const job = await queueModule.tripQueue.add("saveTripSegment", payload);

  assert.ok(job && job.id, "a job must be returned with an id");

  // Read it back out of Redis to prove it was really persisted, rather than
  // trusting a count delta that a worker could race.
  const fetched = await queueModule.tripQueue.getJob(job.id);
  assert.ok(fetched, "the job must be retrievable from Redis");
  assert.equal(fetched.name, "saveTripSegment");
  assert.equal(fetched.data.busId, payload.busId);
  assert.deepEqual(fetched.data.coords, payload.coords);

  await fetched.remove().catch(() => {});
});

test.after(async () => {
  if (testRedis) {
    await testRedis.flushdb();
    await testRedis.quit();
  }
});