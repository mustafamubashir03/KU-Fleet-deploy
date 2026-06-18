// src/workers/worker.ts
import { Worker, Job, WorkerOptions } from "bullmq";
import { redisClient, cacheHelpers } from "../config/redis";
import TripLog from "../models/TripLog.model";
import RFIDLog from "../models/RFIDLog.model";
import Alert from "../models/Alert.model";
import { haversineMeters } from "../utils/geo";

/* -------------------------- JOB TYPES -------------------------- */
export interface TripJobPayload {
  busId: string;
  coords?: { lat: number; lng: number };
  speed?: number;
  timestamp?: string | number | Date;
  endCoords?: { lat: number; lng: number };
}

export interface AnalyticsJobPayload {
  type: "daily" | "bus" | "route" | "tripEnded";
  data?: any;
}

export interface CleanupJobPayload {
  force?: boolean;
}

export type TripJobName = "saveTripSegment" | "endTrip";
export type AnalyticsJobName = "generateDailyAnalytics";
export type CleanupJobName =
  | "cleanupOldTripLogs"
  | "cleanupOldAlerts"
  | "cleanupOldFeedback"
  | "clearExpiredCache"
  | "archiveOldData";

/* -------------------------- WORKER OPTIONS -------------------------- */
const baseWorkerOpts: WorkerOptions = {
  connection: redisClient,
  drainDelay: 5000,
  stalledInterval: 60000,
  removeOnComplete: { age: 3600_000, count: 10 },
  removeOnFail: { age: 3600_000, count: 5 },
};

/* -------------------------- TRIP WORKER -------------------------- */
export const tripWorker = new Worker<TripJobPayload>(
  "tripQueue",
  async (job: Job<TripJobPayload>) => {
    const { busId, coords, speed, timestamp, endCoords } = job.data;
    const ts = timestamp ? new Date(timestamp) : new Date();

    // ─────────── SAVE TRIP SEGMENT ───────────
    if (job.name === "saveTripSegment") {
      if (!coords) return;

      await TripLog.updateOne(
        { bus: busId, endTime: null },
        {
          $push: { coordinates: { ...coords, timestamp: ts } },
          $set: { lastUpdate: ts, currentSpeed: speed ?? 0 },
        }
      );

      // Cache latest location
      await cacheHelpers.setBusLocation(busId, {
        lat: coords.lat,
        lng: coords.lng,
        speed: speed ?? 0,
        timestamp: ts,
      });
    }

    // ─────────── END TRIP ───────────
    if (job.name === "endTrip") {
      if (!busId || !endCoords) return;

      const trip = await TripLog.findOne({ bus: busId, endTime: null });
      if (!trip) return;

      // ---- Push final coordinate ----
      trip.coordinates.push({
        lat: endCoords.lat,
        lng: endCoords.lng,
        timestamp: new Date(),
      });

      // ---- Passenger reconciliation ----
      const boarded = await RFIDLog.countDocuments({ trip: trip._id, eventType: "BOARD" });
      const exited = await RFIDLog.countDocuments({ trip: trip._id, eventType: "EXIT" });
      const netPassengers = Math.max(0, boarded - exited);

      // ---- Distance calculation ----
      let totalDistanceMeters = 0;
      for (let i = 1; i < trip.coordinates.length; i++) {
        const prev = trip.coordinates[i - 1];
        const curr = trip.coordinates[i];
        if (!prev || !curr) continue;
        totalDistanceMeters += haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
      }
      const totalDistanceKm = totalDistanceMeters / 1000;

      // ---- Duration & Average Speed ----
      const endTime = new Date();
      const durationSec = (endTime.getTime() - trip.startTime.getTime()) / 1000;
      const avgSpeedKmh = durationSec > 0 ? totalDistanceKm / (durationSec / 3600) : 0;

      // ---- Final save ----
      trip.endTime = endTime;
      trip.status = "completed";
      trip.distance = totalDistanceKm;
      trip.avgSpeed = avgSpeedKmh;
      trip.duration = durationSec;
      trip.passengerCount = netPassengers;

      await trip.save();
    }
  },
  baseWorkerOpts
);

/* -------------------------- ANALYTICS WORKER -------------------------- */
export const analyticsWorker = new Worker<AnalyticsJobPayload>(
  "analyticsQueue",
  async (job: Job<AnalyticsJobPayload>) => {
    const { type, data } = job.data;

    if (type === "tripEnded") {
      const trip = await TripLog.findById(data.tripId);
      if (!trip) return;

      if ((trip.passengerCount ?? 0) === 0) {
        await Alert.create({
          bus: trip.bus,
          type: "info",
          message: "Trip completed with zero passengers",
          priority: "low",
          timestamp: new Date(),
        });
      }
    }

    if (type === "daily") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const totalTrips = await TripLog.countDocuments({ startTime: { $gte: today } });
      const completedTrips = await TripLog.countDocuments({ startTime: { $gte: today }, endTime: { $ne: null } });

      await cacheHelpers.setAnalyticsData(
        `daily:${today.toISOString().slice(0, 10)}`,
        { totalTrips, completedTrips, completionRate: totalTrips ? (completedTrips / totalTrips) * 100 : 0 },
        86400
      );
    }
  },
  baseWorkerOpts
);

/* -------------------------- LOGGING -------------------------- */
[tripWorker, analyticsWorker].forEach(worker => {
  worker.on("completed", job => console.log(`✅ ${worker.name} completed ${job.name}`));
  worker.on("failed", (job, err) => console.error(`❌ ${worker.name} failed ${job?.name}`, err));
});
