// src/workers/cleanupWorker.ts
import { Worker, Job, type ConnectionOptions } from "bullmq";
import type { CleanupJobName } from "./workers";
import { redisClient } from "../config/redis";
import TripLog from "../models/TripLog.model";
import Alert from "../models/Alert.model";
import Feedback from "../models/Feedback.model";
import dotenv from "dotenv";
dotenv.config();

/* --------------------- Safety Controls ---------------------- */
let redisHealthy = true;
let lastRedisError = 0;
const REDIS_COOLDOWN = 1000 * 60 * 10; // 10 minutes cooldown

function handleRedisError(err: unknown, jobName: string) {
  const message = err instanceof Error ? err.message : JSON.stringify(err);
  console.error(`❌ Redis error in cleanup worker (${jobName}):`, message);
  redisHealthy = false;
  lastRedisError = Date.now();
} 

function isRedisInCooldown() {
  if (!redisHealthy) {
    if (Date.now() - lastRedisError < REDIS_COOLDOWN) return true;
    redisHealthy = true; // Try again after cooldown
  }
  return false;
}

/* --------------------- Helper: Safe SCAN ---------------------- */
async function scanKeys(pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";

  try {
    do {
      const reply = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = reply[0];
      found.push(...reply[1]);
    } while (cursor !== "0");
  } catch (err) {
    console.error("❌ Error scanning Redis keys:", err);
    throw err;
  }

  return found;
}

/* --------------------- Worker Definition ---------------------- */
export const cleanupWorker = new Worker<Record<string, never>, void, CleanupJobName>(
  "cleanupQueue",
  async (job: Job<Record<string, never>, void, CleanupJobName>) => {
    console.log(`🧽 Processing cleanup job: ${job.name}`);

    if (isRedisInCooldown()) {
      console.warn(`⏳ Skipping ${job.name} — Redis in cooldown mode`);
      return;
    }

    try {
      /* ---------------- Cleanup 1: Old Trip Logs ---------------- */
      if (job.name === "cleanupOldTripLogs") {
        const retention = parseInt(process.env.TRIP_RETENTION_DAYS || "7", 10);
        const cutoff = new Date(Date.now() - retention * 86400000);

        const deleted = await TripLog.deleteMany({
          createdAt: { $lt: cutoff },
          endTime: { $ne: null },
        });

        console.log(`🗑️ Deleted ${deleted.deletedCount} old trip logs`);
      }

      /* ---------------- Cleanup 2: Old Alerts ---------------- */
      if (job.name === "cleanupOldAlerts") {
        const retention = parseInt(process.env.ALERT_RETENTION_DAYS || "30", 10);
        const cutoff = new Date(Date.now() - retention * 86400000);

        const deleted = await Alert.deleteMany({
          createdAt: { $lt: cutoff },
          resolved: true,
        });

        console.log(`🗑️ Deleted ${deleted.deletedCount} resolved alerts`);
      }

      /* ---------------- Cleanup 3: Old Feedback ---------------- */
      if (job.name === "cleanupOldFeedback") {
        const retention = parseInt(process.env.FEEDBACK_RETENTION_DAYS || "90", 10);
        const cutoff = new Date(Date.now() - retention * 86400000);

        const deleted = await Feedback.deleteMany({
          createdAt: { $lt: cutoff },
        });

        console.log(`🗑️ Deleted ${deleted.deletedCount} old feedback`);
      }

      /* ---------------- Cleanup 4: Cache Keys ---------------- */
      if (job.name === "clearExpiredCache") {
        const keys = await scanKeys("analytics:*");
        let cleared = 0;

        if (keys.length > 0) {
          const pipeline = redisClient.pipeline();
          keys.forEach((key) => pipeline.ttl(key));
          const results = await pipeline.exec();
          const keysToDelete: string[] = [];

          results?.forEach((result, index) => {
            const [err, ttl] = result ?? [null, null];
            if (!err && ttl === -1 && keys[index]) keysToDelete.push(keys[index]);
          });

          const chunkSize = 100;
          for (let i = 0; i < keysToDelete.length; i += chunkSize) {
            const chunk = keysToDelete.slice(i, i + chunkSize);
            if (chunk.length > 0) {
              await redisClient.del(...chunk);
              cleared += chunk.length;
            }
          }
        }

        console.log(`🧹 Cleared ${cleared} expired cache keys`);
      }

      /* ---------------- Cleanup 5: Data Archiving ---------------- */
      if (job.name === "archiveOldData") {
        const days = parseInt(process.env.ARCHIVE_DAYS || "30", 10);
        const cutoff = new Date(Date.now() - days * 86400000);

        const archived = await TripLog.updateMany(
          {
            createdAt: { $lt: cutoff },
            endTime: { $ne: null },
          },
          { $set: { archived: true } }
        );

        console.log(`📦 Archived ${archived.modifiedCount} trip logs`);
      }
    } catch (err: unknown) {
      handleRedisError(err, job.name);
      throw err; // allow BullMQ to retry
    }
  },
  {
    connection: redisClient as unknown as ConnectionOptions,
    concurrency: 2,
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 10 },
  }
);

/* --------------------- Worker Monitoring ---------------------- */
cleanupWorker.on("completed", (job) => {
  console.log(`✔️ Cleanup job completed: ${job.name}`);
});

cleanupWorker.on("failed", (job, err: unknown) => {
  const message = err instanceof Error ? err.message : JSON.stringify(err);
  console.error(`❌ Cleanup job failed: ${job?.name}`, message);
});

cleanupWorker.on("error", (err: unknown) => {
  const message = err instanceof Error ? err.message : JSON.stringify(err);
  console.error("💥 Worker-level error:", message);
  redisHealthy = false;
  lastRedisError = Date.now();
});
