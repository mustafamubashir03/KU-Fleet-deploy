// src/utils/socketHelper.ts
// Centralized Socket.IO helper to avoid multiple initializations and provide type-safe access

import type { Server as SocketIOServer } from "socket.io";

let ioInstance: SocketIOServer | null = null;

/**
 * Initialize Socket.IO instance (called from server.ts)
 */
export function setSocketIO(io: SocketIOServer): void {
  ioInstance = io;
}

/**
 * Get Socket.IO instance safely
 * Returns null if not initialized (prevents crashes)
 *
 * NOTE: this module deliberately does NOT import ../app. It used to, which
 * created a circular import (app -> routes -> ... -> socketHelper -> app) and
 * meant that anything touching a Socket.IO helper — including the GT06 TCP path
 * via services/gpsHandler — transitively booted the whole Express app, all
 * workers and the Redis client. server.ts always calls setSocketIO() during
 * startup, so the stored instance is the single source of truth.
 */
export function getSocketIO(): SocketIOServer | null {
  return ioInstance;
}

/**
 * Emit event to specific rooms safely
 */
export function emitToRoom(room: string, event: string, data: any): void {
  const io = getSocketIO();
  if (io) {
    io.to(room).emit(event, data);
  }
}

/**
 * Emit event to all connected clients
 */
export function emitToAll(event: string, data: any): void {
  const io = getSocketIO();
  if (io) {
    io.emit(event, data);
  }
}

/**
 * Standard room names (consistent across app)
 */
export const ROOMS = {
  ADMINS: "admins",
  STUDENTS: "students",
  bus: (busId: string) => `bus:${busId}`,
  imei: (imei: string) => `imei:${imei}`,
} as const;

/**
 * Standard socket event names
 */
export const EVENTS = {
  // GPS/Location events
  GPS_DATA: "gt06-data",
  BUS_LOCATION_UPDATE: "bus-location-update",
  ALL_BUS_LOCATIONS: "all-bus-locations",
  
  // Trip events
  TRIP_STARTED: "trip-started",
  TRIP_ENDED: "trip-ended",
  
  // Alert events
  ALERT_CREATED: "alert-created",
  ALERT_UPDATED: "alert-updated",
  ALERT_RESOLVED: "alert-resolved",
  OVERSPEED_ALERT: "overspeed-alert",
  
  // Bus CRUD events
  BUS_CREATED: "bus-created",
  BUS_UPDATED: "bus-updated",
  BUS_DELETED: "bus-deleted",
  BUS_STATUS_CHANGED: "bus-status-changed",
  DRIVER_ASSIGNED: "driver-assigned",
  
  // General
  ERROR: "error",
  NOTIFICATION: "notification",
} as const;

