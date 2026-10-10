// src/services/gpsHandler.ts
import Bus from "../models/Bus.model";
import TripLog from "../models/TripLog.model";
import Alert from "../models/Alert.model";
import { IRoute } from "../interfaces/Route";
import { tripQueue } from "../workers/queue";
import { redisClient, cacheHelpers } from "../config/redis";
import { getBusIdForIMEI } from "../utils/imeiCache";
import { getSocketIO, ROOMS, EVENTS } from "../utils/socketHelper";
import { bufferCoordinate, forceFlushBus } from "./gpsBuffer";

const STATION_PROXIMITY_METERS = Number(process.env.STATION_PROXIMITY_METERS ?? 60);
const MIN_SPEED_KMH = Number(process.env.MIN_SPEED_KMH ?? 5);
const REDIS_LOCATION_THROTTLE_SEC = Number(process.env.REDIS_LOCATION_THROTTLE_SEC ?? 10);
const ALERT_DEDUPE_SECONDS = Number(process.env.ALERT_DEDUPE_SECONDS ?? 120);
const INACTIVITY_END_MIN = Number(process.env.INACTIVITY_MINUTES ?? 30);
const SPEED_LIMIT_KMH = Number(process.env.SPEED_LIMIT_KMH ?? 80);

// In-memory helpers
const lastRedisWriteAt = new Map<string, number>();
const lastMovementAt = new Map<string, number>();
const lastLocationCache = new Map<string, BusCoordinates>();

interface TerminalInfo {
  alarmType?: string;
}

export interface GPSData {
  lat: number;
  lng: number;
  speed?: number;
  timestamp?: Date | string;
}

export interface ParsedMessage {
  imei: string | number;
  terminalInfo?: TerminalInfo;
  gps?: GPSData;
  lat?: number;
  lon?: number;
  speed?: number;
  fixTime?: string | Date;
}

export interface BusCoordinates {
  lat: number;
  lng: number;
  speed: number;
  timestamp: Date;
}

function hasValidCoords(msg: ParsedMessage): boolean {
  return Boolean(
    (msg.gps?.lat != null && msg.gps?.lng != null) ||
    (msg.lat != null && msg.lon != null)
  );
}

/**
 * Atomic Redis NX + EX using MULTI
 */
async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const res = await redisClient
    .multi()
    .setnx(key, "1")
    .expire(key, ttlSeconds)
    .exec();

  return res?.[0]?.[1] === 1;
}

export async function handleParsedMessage(msg: ParsedMessage): Promise<void> {
  const imei = String(msg.imei);
  const busId = await getBusIdForIMEI(imei);
  const io = getSocketIO();

  let coords: BusCoordinates | null = null;

  if (hasValidCoords(msg)) {
    coords = {
      lat: msg.gps?.lat ?? msg.lat!,
      lng: msg.gps?.lng ?? msg.lon!,
      speed: msg.gps?.speed ?? msg.speed ?? 0,
      timestamp: msg.gps?.timestamp
        ? new Date(msg.gps.timestamp)
        : msg.fixTime
        ? new Date(msg.fixTime)
        : new Date(),
    };
  }

  // ───────── SOCKET EMITS ─────────
  //
  // Both rooms receive the SAME nested shape so a client handler written for
  // one works against the other. The difference is deliberate and is the
  // privacy boundary: only the admin feed carries the raw tracker IMEI.
  //   admins   -> { imei, busId, gps: coords | null }
  //   students -> {            busId, gps: coords | null }   (no IMEI)
  if (io) {
    io.to(ROOMS.ADMINS).emit(EVENTS.GPS_DATA, { imei, busId, gps: coords });
    io.to(ROOMS.STUDENTS).emit(EVENTS.GPS_DATA, { busId, gps: coords });

    // Per-bus rooms are admin-only (enforced in server.ts joinRoom). Only emit
    // when someone is actually subscribed, otherwise this is a wasted emit.
    if (busId) {
      const members = io.sockets.adapter.rooms.get(ROOMS.bus(busId));
      if (members && members.size > 0) {
        io.to(ROOMS.bus(busId)).emit(EVENTS.GPS_DATA, coords);
      }
    }
  }

  if (!coords || !busId) return;

  // ───────── REDIS LOCATION CACHE ─────────
  try {
    const now = Date.now();
    const lastWrite = lastRedisWriteAt.get(imei) ?? 0;

    if (now - lastWrite >= REDIS_LOCATION_THROTTLE_SEC * 1000) {
      const last = lastLocationCache.get(busId);

      const changed =
        !last ||
        Math.abs(last.lat - coords.lat) > 0.0001 ||
        Math.abs(last.lng - coords.lng) > 0.0001 ||
        Math.abs(last.speed - coords.speed) > 5;

      if (changed) {
        await cacheHelpers.setBusLocation(busId, coords, 180);
        lastLocationCache.set(busId, coords);
        lastRedisWriteAt.set(imei, now);
      }
    }
  } catch {
    // silent cache failure
  }

  // ───────── OVERSPEED ALERT ─────────
  if (coords.speed > SPEED_LIMIT_KMH) {
    const key = `alert:overspeed:${imei}`;
    const ok = await acquireLock(key, ALERT_DEDUPE_SECONDS);

    if (ok) {
      await Alert.create({
        bus: busId,
        type: "overspeed",
        message: `Overspeed ${coords.speed} km/h`,
        priority: "high",
        timestamp: new Date(),
      });
    }
  }

  // ───────── TRIP LOGIC ─────────
  try {
    const activeTrip = await TripLog.findOne({
      bus: busId,
      endTime: null,
    });

    const bus = await Bus.findById(busId)
      .populate<{ route: IRoute }>("route")
      .lean();

    const route = bus?.route ?? null;

    // START TRIP
    if (!activeTrip && coords.speed >= MIN_SPEED_KMH) {
      // Two GPS packets for the same bus can be in flight concurrently (multiple
      // frames in one chunk, or several tracker connections), so both could
      // observe "no active trip" and each create an in_progress TripLog.
      // Serialise with the same Redis NX lock already used for alerts, then
      // re-check the active trip under the lock.
      const startLock = await acquireLock(`trip:start:${busId}`, ALERT_DEDUPE_SECONDS);
      if (!startLock) return;

      const stillNoActiveTrip = await TripLog.findOne({ bus: busId, endTime: null })
        .select("_id")
        .lean();

      if (!stillNoActiveTrip) {
        const trip = await TripLog.create({
          bus: busId,
          driver: bus?.driver,
          route: route?._id,
          startTime: coords.timestamp,
          coordinates: [coords],
          status: "in_progress",
        });

        bufferCoordinate(busId, coords);
        lastMovementAt.set(imei, Date.now());

        io?.to(ROOMS.ADMINS).emit(EVENTS.TRIP_STARTED, {
          tripId: String(trip._id),
          busId,
        });
      }

      return;
    }

    if (!activeTrip) return;

    bufferCoordinate(busId, coords);

    // MOVEMENT TRACKING
    if (coords.speed >= MIN_SPEED_KMH) {
      lastMovementAt.set(imei, Date.now());
      return;
    }

    // END TRIP BY INACTIVITY
    const lastMove = lastMovementAt.get(imei) ?? Date.now();
    const inactiveMs = Date.now() - lastMove;

    if (inactiveMs >= INACTIVITY_END_MIN * 60 * 1000) {
      const lockKey = `trip:end:${busId}`;
      const acquired = await acquireLock(lockKey, ALERT_DEDUPE_SECONDS);
      if (!acquired) return;

      await forceFlushBus(busId);
      await tripQueue.add("endTrip", {
        busId,
        endCoords: coords,
      });
    }
  } catch (err) {
    console.error("Trip handling error:", err);
  }

  // ───────── TERMINAL ALERTS ─────────
  if (msg.terminalInfo?.alarmType && msg.terminalInfo.alarmType !== "normal") {
    const key = `alert:terminal:${imei}:${msg.terminalInfo.alarmType}`;
    const ok = await acquireLock(key, ALERT_DEDUPE_SECONDS);

    if (ok) {
      await Alert.create({
        bus: busId,
        type: "system",
        message: `Alarm ${msg.terminalInfo.alarmType}`,
        priority: "high",
        timestamp: new Date(),
      });
    }
  }
}
