import { Redis } from "ioredis";
import dotenv from "dotenv"
dotenv.config()

if (!process.env.REDIS_URL) {
  console.error("❌ Fatal Error: REDIS_URL environment variable is not defined!");
  process.exit(1);
}

export const redisClient = new Redis(process.env.REDIS_URL, {
  tls: { rejectUnauthorized: false }, // for Upstash SSL
  maxRetriesPerRequest: null,    
});

redisClient.on("connect", () => console.log("✅ Redis connected"));
redisClient.on("error", (err) => console.error("❌ Redis Error:", err));

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
// import dotenv from "dotenv";
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

