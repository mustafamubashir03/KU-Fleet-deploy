// src/workers/cronJobs.ts
import * as cron from "node-cron";
import { tripQueue, analyticsQueue, cleanupQueue } from "./queue";
import { AnalyticsJobPayload } from "./workers";

// --- Internal Health + Rate Limit ---
let redisHealthy = true;
let lastRedisErrorTime = 0;
const HEALTH_CHECK_COOLDOWN = 1000 * 60 * 15; // 15 minutes cooldown

async function safeJob(fn: () => Promise<void>, label: string) {
  if (!redisHealthy) {
    const now = Date.now();
    if (now - lastRedisErrorTime < HEALTH_CHECK_COOLDOWN) {
      return;
    }
    redisHealthy = true; // Retry after cooldown
  }

  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.includes("Redis") || (err as any).code === "ECONNRESET")) {
      redisHealthy = false;
      lastRedisErrorTime = Date.now();
      console.error(`Redis connection issue during ${label}:`, err.message);
    } else {
      console.error(`Error running ${label}:`, err);
    }
  }
}


// --------------------- CRON JOBS ----------------------
//
// Every task is registered so graceful shutdown can cancel it. They were
// previously anonymous cron.schedule() calls nothing could stop, so during a
// PM2 restart the outgoing and incoming processes briefly ran two copies of
// every schedule and could double-enqueue a cleanup batch.

export const scheduledTasks: cron.ScheduledTask[] = [];

function schedule(expr: string, handler: () => void | Promise<void>, label: string) {
  const task = cron.schedule(expr, handler);
  scheduledTasks.push(task);
  console.log(`  cron scheduled: ${label} (${expr})`);
  return task;
}

/** Stop every scheduled task. Safe to call more than once. */
export function stopAllCronJobs(): void {
  for (const t of scheduledTasks) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
  scheduledTasks.length = 0;
  console.log(`Cron jobs stopped (${"${scheduledTasks.length}"} remaining)`);
}

schedule(
  "0 2 * * *",
  async () =>
    safeJob(async () => {
      await cleanupQueue.addBulk([
        { name: "cleanupOldTripLogs", data: {}, opts: { attempts: 3, backoff: { type: "exponential", delay: 2000 } } },
        { name: "cleanupOldAlerts", data: {}, opts: { attempts: 3, backoff: { type: "exponential", delay: 2000 } } },
        { name: "cleanupOldFeedback", data: {}, opts: { attempts: 3, backoff: { type: "exponential", delay: 2000 } } },
      ]);
    }, "daily-cleanup"),
  "daily-cleanup"
);

schedule(
  "0 1 * * *",
  async () =>
    safeJob(async () => {
      const payload: AnalyticsJobPayload = { type: "daily" };
      await analyticsQueue.add("generateDailyAnalytics", payload, {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      });
    }, "daily-analytics"),
  "daily-analytics"
);

schedule(
  "0 */6 * * *",
  async () =>
    safeJob(async () => {
      await cleanupQueue.add("clearExpiredCache", {}, {
        attempts: 2,
        backoff: { type: "exponential", delay: 1000 },
      });
    }, "cache-cleanup"),
  "cache-cleanup"
);

schedule(
  "0 3 * * 0",
  async () =>
    safeJob(async () => {
      await cleanupQueue.add("archiveOldData", {}, {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      });
    }, "data-archiving"),
  "data-archiving"
);

schedule(
  "*/15 * * * *",
  async () =>
    safeJob(async () => {
      const [trip, analytics, cleanup] = await Promise.all([
        tripQueue.getJobCounts(),
        analyticsQueue.getJobCounts(),
        cleanupQueue.getJobCounts(),
      ]);

      const failed = {
        trip: trip.failed ?? 0,
        analytics: analytics.failed ?? 0,
        cleanup: cleanup.failed ?? 0,
      };

      if (failed.trip > 10 || failed.analytics > 5 || failed.cleanup > 5) {
        console.warn("Queue health warning:", { trip, analytics, cleanup });
      }
    }, "health-check"),
  "health-check"
);

console.log("Cron jobs initialized: daily-cleanup(2AM), daily-analytics(1AM), cache-cleanup(6h), data-archiving(Sun 3AM), health-check(15m)");
