// src/workers/queue.ts
import { Queue } from "bullmq";
import { redisClient } from "../config/redis";
import {
  TripJobPayload,
  AnalyticsJobPayload,
  CleanupJobPayload,
  TripJobName,
  AnalyticsJobName,
  CleanupJobName,
} from "./workers";

/* ----------------------------------------
 *  QUEUES WITH STRONG TYPES
 * ---------------------------------------- */

// Trip queue: GPS / trip segment / end trip jobs
export const tripQueue = new Queue<TripJobPayload, void, TripJobName>("tripQueue", {
  connection: redisClient,
});

// Analytics queue: daily / bus / route / trip-ended metrics
export const analyticsQueue = new Queue<AnalyticsJobPayload, void, AnalyticsJobName>("analyticsQueue", {
  connection: redisClient,
});

// Cleanup queue: delete old trips, clear cache, etc.
export const cleanupQueue = new Queue<CleanupJobPayload, void, CleanupJobName>("cleanupQueue", {
  connection: redisClient,
});

// Optional: export all queues together
export const Queues = {
  tripQueue,
  analyticsQueue,
  cleanupQueue,
};
