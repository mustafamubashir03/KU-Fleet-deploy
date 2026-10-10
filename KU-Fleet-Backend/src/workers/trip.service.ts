// src/services/trip.service.ts
import { cacheHelpers } from "../config/redis";
import TripLog from "../models/TripLog.model";
import Bus from "../models/Bus.model";
import Alert from "../models/Alert.model";
import dotenv from "dotenv";
import { ITripCoordinate } from "../interfaces/TripLog";
dotenv.config();

/* ----------------------------------------------
 * TYPES
 * ---------------------------------------------- */
export interface ICoords {
  lat: number;
  lng: number;
  speed?: number;
}

export interface ISaveTripSegmentPayload {
  busId: string;
  coords: ICoords;
  timestamp?: string | number | Date;
}

export interface IEndTripPayload {
  busId: string;
  endCoords?: ICoords | null;
}

export interface IBusStatusLocation {
  lat: number;
  lng: number;
  speed?: number;
}

export interface IUpdateBusStatusPayload {
  busId: string;
  status?: string;
  location?: IBusStatusLocation | null;
}

/* ----------------------------------------------
 * LOCAL CACHE THROTTLE
 * ---------------------------------------------- */
const REDIS_LOCATION_THROTTLE_SEC = Number(process.env.REDIS_LOCATION_THROTTLE_SEC ?? 10);
const BUS_CACHE_TTL = Number(process.env.BUS_CACHE_TTL_SEC ?? 180);

const lastCacheWriteAt: Map<string, number> = new Map();
const lastCacheValue: Map<string, ICoords> = new Map();

function shouldWriteCache(busId: string, coords: ICoords) {
  const now = Date.now();
  const lastAt = lastCacheWriteAt.get(busId) ?? 0;
  if (now - lastAt < REDIS_LOCATION_THROTTLE_SEC * 1000) return false;

  const lastVal = lastCacheValue.get(busId);
  if (!lastVal) return true;

  return (
    Math.abs(lastVal.lat - coords.lat) > 0.0001 ||
    Math.abs(lastVal.lng - coords.lng) > 0.0001 ||
    Math.abs((lastVal.speed ?? 0) - (coords.speed ?? 0)) > 5
  );
}

/* ----------------------------------------------
 * SERVICE
 * ---------------------------------------------- */
export const TripService = {
  /**
   * SAVE TRIP SEGMENT
   */
  async saveTripSegment({ busId, coords, timestamp }: ISaveTripSegmentPayload): Promise<void> {
    if (!busId || !coords) return;

    const ts = timestamp ? new Date(timestamp) : new Date();
    const coord: ITripCoordinate = {
      lat: coords.lat,
      lng: coords.lng,
      speed: coords.speed ?? 0,
      timestamp: ts,
    };

    try {
      await TripLog.updateOne(
        { bus: busId, endTime: null },
        {
          $push: { coordinates: coord },
          $set: { lastUpdate: ts, currentSpeed: coord.speed },
        }
      );
    } catch (err) {
      console.error("TripLog updateOne failed:", err);
    }

    try {
      if (shouldWriteCache(busId, coord)) {
        await cacheHelpers.setBusLocation(busId, coord, BUS_CACHE_TTL);
        lastCacheWriteAt.set(busId, Date.now());
        lastCacheValue.set(busId, coord);
      }
    } catch (err) {
      console.warn("Cache write failed:", err);
    }

    // Overspeed alert
    if (coord.speed > 80) {
      try {
        await Alert.create({
          bus: busId,
          type: "overspeed",
          message: `Bus exceeded speed limit: ${coord.speed} km/h`,
          priority: "high",
          timestamp: ts,
        });
      } catch (err) {
        console.error("Alert.create failed:", err);
      }
    }
  },

  /**
   * END TRIP
   */
  async endTrip({ busId, endCoords }: IEndTripPayload): Promise<void> {
    if (!busId) return;

    try {
      const trip = await TripLog.findOne({ bus: busId, endTime: null });
      if (!trip) return;

      // Push final coordinate if provided
      if (endCoords) {
        const finalCoord: ITripCoordinate = {
          lat: endCoords.lat,
          lng: endCoords.lng,
          speed: endCoords.speed ?? 0,
          timestamp: new Date(),
        };
        trip.coordinates.push(finalCoord);
      }

      trip.endTime = new Date();
      trip.status = "completed";

      await trip.save();
    } catch (err) {
      console.error("TripLog endTrip failed:", err);
    }

    // Clear cache
    try {
      await cacheHelpers.clearBusLocation(busId);
      lastCacheWriteAt.delete(busId);
      lastCacheValue.delete(busId);
    } catch (err) {
      console.warn("Cache clearing failed:", err);
    }
  },

  /**
   * DAILY CLEANUP
   */
  async dailyCleanup(): Promise<void> {
    const retentionDays = Number(process.env.TRIP_RETENTION_DAYS ?? 7);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    try {
      const deleted = await TripLog.deleteMany({ createdAt: { $lt: cutoff }, endTime: { $ne: null } });
      console.log(`Deleted ${deleted.deletedCount} old trip logs`);
    } catch (err) {
      console.error("dailyCleanup failed:", err);
    }
  },

  /**
   * UPDATE BUS STATUS
   */
  async updateBusStatus({ busId, status, location }: IUpdateBusStatusPayload): Promise<void> {
    if (!busId) return;

    try {
      await Bus.findByIdAndUpdate(busId, {
        status: status ?? "inactive",
        lastLocation: location ?? null,
        lastUpdate: new Date(),
      });
    } catch (err) {
      console.error("Bus.findByIdAndUpdate failed:", err);
    }

    if (location && shouldWriteCache(busId, location)) {
      try {
        await cacheHelpers.setBusLocation(busId, { ...location, timestamp: new Date() }, BUS_CACHE_TTL);
        lastCacheWriteAt.set(busId, Date.now());
        lastCacheValue.set(busId, location);
      } catch (err) {
        console.warn("Cache update failed:", err);
      }
    }
  },
};
