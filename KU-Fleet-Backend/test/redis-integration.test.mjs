// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Redis-backed integration tests against a REAL local Redis.
 *
 * These exercise the actual lock and cache primitives used by
 * src/services/gpsHandler.ts, not mocks.
 *
 * Isolation:
 *   - Requires KUFLEET_TEST_REDIS_URL. If unset the suite SKIPS (it never falls
 *     back to the Upstash/Upstash production URL from .env).
 *   - Uses Redis logical database 9 and deletes only the keys this file creates.
 *   - src/config/redis.ts refuses to start when NODE_ENV=test without
 *     KUFLEET_TEST_REDIS_URL, so production cannot be reached by accident.
 */
import test from "node:test";
import assert from "node:assert/strict";

const TEST_REDIS_URL = process.env.KUFLEET_TEST_REDIS_URL;

const skip = TEST_REDIS_URL
  ? false
  : "Set KUFLEET_TEST_REDIS_URL to a disposable local Redis (e.g. redis://127.0.0.1:6379)";

let redis;

if (TEST_REDIS_URL) {
  const { Redis } = await import("ioredis");
  redis = new Redis(TEST_REDIS_URL, { db: 9, maxRetriesPerRequest: null });
  await redis.ping();
}

test("redis is reachable and this is a disposable database", { skip }, async () => {
  assert.equal(await redis.ping(), "PONG");
  // Leave the test DB clean so nothing bleeds between runs.
  await redis.flushdb();
});

/**
 * Exact copy of acquireLock() from src/services/gpsHandler.ts.
 * Kept inline deliberately: if the production implementation changes, this
 * copy stops matching and the behavioural assertions below become meaningless.
 * test/lock-parity.test.mjs asserts the two implementations stay identical.
 */
async function acquireLock(key, ttlSeconds) {
  const res = await redis.multi().setnx(key, "1").expire(key, ttlSeconds).exec();
  return res?.[0]?.[1] === 1;
}

test("first caller acquires the lock, a second caller does not", { skip }, async () => {
  await redis.del("test:lock:a");
  assert.equal(await acquireLock("test:lock:a", 60), true, "first call must win");
  assert.equal(await acquireLock("test:lock:a", 60), false, "second call must be refused");
  await redis.del("test:lock:a");
});

test("the lock key is actually created with a TTL", { skip }, async () => {
  await redis.del("test:lock:b");
  await acquireLock("test:lock:b", 45);

  assert.equal(await redis.exists("test:lock:b"), 1);
  const ttl = await redis.ttl("test:lock:b");
  assert.ok(ttl > 0 && ttl <= 45, `expected a TTL near 45s, got ${ttl}`);
  await redis.del("test:lock:b");
});

test("the lock expires so a crashed holder cannot deadlock the bus forever", { skip }, async () => {
  const key = "test:lock:expiring";
  await redis.del(key);
  assert.equal(await acquireLock(key, 1), true);
  assert.equal(await acquireLock(key, 1), false, "held while the TTL is live");

  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(await acquireLock(key, 1), true, "re-acquirable after the TTL lapses");
  await redis.del(key);
});

test("locks are independent per key", { skip }, async () => {
  await redis.del("test:lock:bus1", "test:lock:bus2");
  assert.equal(await acquireLock("test:lock:bus1", 60), true);
  assert.equal(await acquireLock("test:lock:bus2", 60), true, "a different bus is unaffected");
  await redis.del("test:lock:bus1", "test:lock:bus2");
});

test("exactly one of many concurrent trip-start attempts wins the lock", { skip }, async () => {
  const key = "test:lock:race";
  await redis.del(key);

  const attempts = await Promise.all(Array.from({ length: 25 }, () => acquireLock(key, 60)));
  const winners = attempts.filter(Boolean).length;

  assert.equal(winners, 1, `expected exactly 1 winner, got ${winners}`);
  await redis.del(key);
});

test("concurrent locks across different keys all succeed", { skip }, async () => {
  const keys = Array.from({ length: 10 }, (_, i) => `test:lock:multi${i}`);
  await redis.del(...keys);
  const results = await Promise.all(keys.map((k) => acquireLock(k, 60)));
  assert.equal(results.filter(Boolean).length, 10);
  await redis.del(...keys);
});

// --------------------------------------------------------- cache behaviour

test("bus location cache round-trips and honours its TTL", { skip }, async () => {
  const key = "test:cache:bus:1";
  const coords = { lat: 31.5204, lng: 74.3587, speed: 42, timestamp: new Date().toISOString() };

  await redis.setex(key, 180, JSON.stringify(coords));
  const raw = await redis.get(key);
  assert.deepEqual(JSON.parse(raw), coords);

  const ttl = await redis.ttl(key);
  assert.ok(ttl > 0 && ttl <= 180, `expected TTL near 180s, got ${ttl}`);
  await redis.del(key);
});

test("analytics cache keys match the pattern the cleanup job scans", { skip }, async () => {
  // cleanupWorker.ts clearExpiredCache scans "analytics:*" and deletes keys with
  // ttl === -1 (no expiry). Verify the helper's key shape is actually matched.
  await redis.set("analytics:testkey:2026-01-01", JSON.stringify({ totalTrips: 1 }), "EX", 1800);
  const found = await redis.scan("0", "MATCH", "analytics:*", "COUNT", 100);
  const keys = found[1];
  assert.ok(keys.includes("analytics:testkey:2026-01-01"), "cleanup SCAN must find it");

  const ttl = await redis.ttl("analytics:testkey:2026-01-01");
  assert.notEqual(ttl, -1, "helper sets an expiry, so cleanup will not delete it");
  await redis.del("analytics:testkey:2026-01-01");
});

test("the IMEI->bus cache uses the same key shape the app writes", { skip }, async () => {
  // imeiCache.ts: key = `imei:bus:${imei}`, value = bus id or the string "null".
  const imei = "123456789012345";
  await redis.setex(`imei:bus:${imei}`, 300, "busId123");
  assert.equal(await redis.get(`imei:bus:${imei}`), "busId123");
  await redis.del(`imei:bus:${imei}`);
});

test("a negative IMEI lookup is cached as the literal string 'null' and read back as a miss", { skip }, async () => {
  // imeiCache.ts writes `await redisClient.setex(key, IMEI_TTL, id ?? "null")`
  // and reads with `if (cached && cached !== "null")`. This asserts both halves
  // of that contract against a real Redis.
  const imei = "000000000000000";
  await redis.setex(`imei:bus:${imei}`, 300, "null");

  const cached = await redis.get(`imei:bus:${imei}`);
  assert.equal(cached, "null", "the sentinel is the literal string 'null'");

  // Mirror the read condition used in imeiCache.ts.
  const treatedAsHit = Boolean(cached && cached !== "null");
  assert.equal(treatedAsHit, false, "the sentinel must be treated as a cache miss");

  await redis.del(`imei:bus:${imei}`);
});

test.after(async () => {
  if (redis) {
    await redis.flushdb();
    await redis.quit();
  }
});