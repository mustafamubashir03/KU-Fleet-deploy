import { Redis } from "ioredis";
import { validateRequiredEnv } from "./env";

// ---------------------------------------------------------------------------
// Connection configuration
//
// Intended deployment is a Redis running on the same EC2 host, reached over the
// loopback interface:  REDIS_URL=redis://127.0.0.1:6379
// A remote provider (e.g. rediss:// for a TLS endpoint such as Upstash) is
// still supported by setting the URL to that scheme; nothing is hardcoded here.
//
// TLS is applied ONLY when the URL actually requests it. Previously
// `tls: { rejectUnauthorized: false }` was passed unconditionally, which is
// wrong for a plaintext local Redis and silently disabled certificate checking
// for remote ones.
// ---------------------------------------------------------------------------

export const REDIS_URL = process.env.REDIS_URL as string;

/** Logical database index. Useful for isolating non-production environments. */
export const REDIS_DB = process.env.REDIS_DB ? Number(process.env.REDIS_DB) : undefined;

/** True when the URL asks for TLS (rediss://). */
export const REDIS_USES_TLS = /^rediss:/i.test(REDIS_URL);

/**
 * Test safety guard.
 *
 * Automated tests must never open a connection to the production Redis: the
 * cleanup/analytics workers delete and rewrite data. Requiring an explicit,
 * clearly-named test URL makes accidental production access impossible.
 */
const IS_TEST = process.env.NODE_ENV === "test";
const TEST_REDIS_URL = process.env.KUFLEET_TEST_REDIS_URL;

if (IS_TEST && !TEST_REDIS_URL) {
  console.error(
    "❌ Refusing to create a Redis client under NODE_ENV=test. " +
      "Set KUFLEET_TEST_REDIS_URL to a disposable local Redis to run integration tests."
  );
  process.exit(1);
}

// Fail through the central validator so there is exactly ONE error message
// naming every missing variable, instead of whichever module happens to be
// imported first.
validateRequiredEnv();

export const redisClient = new Redis(REDIS_URL, {
  ...(REDIS_USES_TLS ? { tls: { rejectUnauthorized: false } } : {}),
  ...(REDIS_DB !== undefined ? { db: REDIS_DB } : {}),

  // Required by BullMQ: blocking commands must not time out.
  maxRetriesPerRequest: null,

  // Bound the reconnect storm. Upstream was returning request-limit errors,
  // and an unbounded immediate-retry loop turned one outage into a tight loop
  // that kept the instance saturated. Exponential backoff with a ceiling.
  retryStrategy: (times: number) => Math.min(times * 200, 5000),

  // Fail fast if the socket is established but no PING is answered.
  enableReadyCheck: true,
  connectTimeout: 10_000,

  // Detect a dead peer instead of hanging forever on a half-open socket.
  // Without this, "Redis outage" can present as the process simply stalling.
  enableOfflineQueue: true,
});

redisClient.on("connect", () =>
  console.log(
    `✅ Redis connected (${REDIS_USES_TLS ? "TLS" : "plaintext"}${
      REDIS_DB !== undefined ? `, db ${REDIS_DB}` : ""
    })`
  )
);
redisClient.on("ready", () => console.log("✅ Redis ready"));
redisClient.on("reconnecting", (delay: unknown) =>
  console.warn(`⚠️ Redis reconnecting in ${String(delay)}ms`)
);
redisClient.on("error", (err) => {
  // Never log the URL: it can embed credentials.
  console.error(`❌ Redis Error: ${err.message}`);
});
redisClient.on("end", () => console.warn("⚠️ Redis connection closed"));

// A dead Redis must not be mistaken for healthy operation. There is no
// in-memory fallback by design: silently degrading GPS cache, distributed
// locks or the job queue would corrupt trips rather than fail loudly.

// Cache helpers for bus location data
export const cacheHelpers = {
  // Cache bus location data
  async setBusLocation(busId: string, location: any, ttl: number = 300) {
    const key = `bus:location:${busId}`;
    await redisClient.setex(key, ttl, JSON.stringify(location));
  },

  // Get cached bus location
  async getBusLocation(busId: string) {
    const key = `bus:location:${busId}`;
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  },

  // Clear bus location cache
  async clearBusLocation(busId: string) {
    const key = `bus:location:${busId}`;
    await redisClient.del(key);
  },

  // Cache trip data
  async setTripData(tripId: string, data: any, ttl: number = 600) {
    const key = `trip:${tripId}`;
    await redisClient.setex(key, ttl, JSON.stringify(data));
  },

  // Get cached trip data
  async getTripData(tripId: string) {
    const key = `trip:${tripId}`;
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  },

  // Clear all bus location caches
// inside src/config/redis.ts (update the clearAllBusLocations implementation)
  // Clear all bus location caches (safe SCAN)
  async clearAllBusLocations() {
    const pattern = "bus:location:*";
    const toDelete: string[] = [];
    let cursor = "0";

    try {
      do {
        const reply = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 500);
        cursor = reply[0];
        const keys = reply[1] as string[];
        if (keys && keys.length > 0) {
          toDelete.push(...keys);
        }
      } while (cursor !== "0");

      // Batch delete in chunks to avoid too large single command
      const chunkSize = 200;
      for (let i = 0; i < toDelete.length; i += chunkSize) {
        const chunk = toDelete.slice(i, i + chunkSize);
        if (chunk.length > 0) {
          await redisClient.del(...chunk);
        }
      }
    } catch (err) {
      console.warn("⚠️ clearAllBusLocations scan/delete failed:", err);
    }
  },


  // Cache analytics data
  async setAnalyticsData(key: string, data: any, ttl: number = 1800) {
    const cacheKey = `analytics:${key}`;
    await redisClient.setex(cacheKey, ttl, JSON.stringify(data));
  },

  // Get cached analytics data
  async getAnalyticsData(key: string) {
    const cacheKey = `analytics:${key}`;
    const data = await redisClient.get(cacheKey);
    return data ? JSON.parse(data) : null;
  }
};










// import { Redis } from "@upstash/redis";
// import { validateRequiredEnv } from "./env";;
// dotenv.config();

// // Create Redis client using Upstash REST
// export const redisClient = new Redis({
//   url: process.env.UPSTASH_REDIS_REST_URL!,
//   token: process.env.UPSTASH_REDIS_REST_TOKEN!, // REQUIRED for REST API auth
// });

// // Cache helpers for bus, trip, and analytics data
// export const cacheHelpers = {
//   // ----------------------
//   // Bus location cache
//   // ----------------------
//   async setBusLocation(busId: string, location: any, ttl: number = 300) {
//     const key = `bus:location:${busId}`;
//     await redisClient.set(key, JSON.stringify(location), { ex: ttl });
//   },

//   async getBusLocation(busId: string) {
//     const key = `bus:location:${busId}`;
//     const data = await redisClient.get<string>(key);
//     return data ? JSON.parse(data) : null;
//   },

//   async clearBusLocation(busId: string) {
//     const key = `bus:location:${busId}`;
//     await redisClient.del(key);
//   },

//   async clearAllBusLocations() {
//     const pattern = "bus:location:*";
//     try {
//       let cursor: string = "0";           // cursor is a string
//       const keysToDelete: string[] = [];
  
//       // Upstash scan returns [cursor, keys]
//       do {
//         const res = await redisClient.scan(cursor, { match: pattern, count: 500 });
//         cursor = res[0];                   // new cursor
//         const batch = res[1] || [];
//         keysToDelete.push(...batch);
//       } while (cursor !== "0");
  
//       const chunkSize = 200;
//       for (let i = 0; i < keysToDelete.length; i += chunkSize) {
//         const chunk = keysToDelete.slice(i, i + chunkSize);
//         if (chunk.length > 0) {
//           await redisClient.del(...chunk);
//         }
//       }
//     } catch (err) {
//       console.warn("⚠️ clearAllBusLocations failed:", err);
//     }
//   },
  

//   // ----------------------
//   // Trip data cache
//   // ----------------------
//   async setTripData(tripId: string, data: any, ttl: number = 600) {
//     const key = `trip:${tripId}`;
//     await redisClient.set(key, JSON.stringify(data), { ex: ttl });
//   },

//   async getTripData(tripId: string) {
//     const key = `trip:${tripId}`;
//     const data = await redisClient.get<string>(key);
//     return data ? JSON.parse(data) : null;
//   },

//   // ----------------------
//   // Analytics cache
//   // ----------------------
//   async setAnalyticsData(key: string, data: any, ttl: number = 1800) {
//     const cacheKey = `analytics:${key}`;
//     await redisClient.set(cacheKey, JSON.stringify(data), { ex: ttl });
//   },

//   async getAnalyticsData(key: string) {
//     const cacheKey = `analytics:${key}`;
//     const data = await redisClient.get<string>(cacheKey);
//     return data ? JSON.parse(data) : null;
//   },
// };

