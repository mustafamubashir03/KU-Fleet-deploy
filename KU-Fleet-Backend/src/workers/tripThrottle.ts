// src/services/setBusLocationThrottled.ts
import { cacheHelpers } from "../config/redis";
import { IBusStatusLocation } from "./trip.service";

/**
 * How frequently a bus location can be written to Redis (ms)
 * Default: 5000ms = 1 write per 5 seconds per bus
 */
const THROTTLE_INTERVAL_MS = 5000;

// Track last write timestamp per bus
const lastUpdateMap: Map<string, number> = new Map();

/**
 * Throttled Redis write for bus location
 * Ensures we don't write too frequently for the same bus
 */
export async function setBusLocationThrottled(
  busId: string,
  location: IBusStatusLocation
): Promise<void> {
  if (!busId) return;

  const now = Date.now();
  const last = lastUpdateMap.get(busId) || 0;

  if (now - last < THROTTLE_INTERVAL_MS) {
    // Skip write if within throttle interval
    return;
  }

  // Update last write timestamp
  lastUpdateMap.set(busId, now);

  // Write to Redis using existing helper
  try {
    await cacheHelpers.setBusLocation(busId, {
      lat: location.lat,
      lng: location.lng,
      speed: location.speed ?? 0,
      timestamp: new Date(),
    });
  } catch (err) {
    console.warn(`Throttled cache write failed for bus ${busId}:`, err);
  }
}
