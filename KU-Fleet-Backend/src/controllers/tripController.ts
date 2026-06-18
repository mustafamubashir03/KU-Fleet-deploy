// src/controllers/tripController.ts
import { Request, Response } from "express";
import TripLog from "../models/TripLog.model";
import Bus from "../models/Bus.model";
import { wrapAsync } from "../middleware/errorHandler";

/**
 * ✅ Log bus position periodically (e.g., every 10–15 minutes)
 * This API is called automatically from ESP32 / GSM module
 */
export const logBusPosition = wrapAsync(async (req: Request, res: Response) => {
  const { busId, lat, lng, speed } = req.body;

  if (!busId || !lat || !lng)
    return res.status(400).json({ message: "Bus ID, lat, and lng are required" });

  const bus = await Bus.findById(busId);
  if (!bus) return res.status(404).json({ message: "Bus not found" });

  // Find today's ongoing trip (within 24 hours)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let trip = await TripLog.findOne({
    bus: busId,
    startTime: { $gte: todayStart },
  });

  // Create new daily trip if not exists
  if (!trip) {
    trip = new TripLog({
      bus: busId,
      startTime: new Date(),
      coordinates: [],
      status: "active",
    });
  }

  trip.coordinates.push({ lat, lng, speed, timestamp: new Date() });

  // Update last known bus location for quick lookup
  bus.lastKnownLocation = { lat, lng, speed, timestamp: new Date() };
  await bus.save();
  await trip.save();

  res.status(200).json({
    success: true,
    message: "Bus position logged successfully",
    tripId: trip._id,
    totalPoints: trip.coordinates.length,
  });
});

/**
 * ✅ Get trip logs for a specific bus (for analytics)
 */
export const getTripLogsByBus = wrapAsync(async (req: Request, res: Response) => {
  const { busId } = req.params;
  const logs = await TripLog.find({ bus: busId })
    .sort({ startTime: -1 })
    .limit(10); // recent trips

  res.status(200).json({ success: true, count: logs.length, logs });
});

/**
 * ✅ Get daily summary of trips
 */
export const getDailyTripSummary = wrapAsync(async (_req: Request, res: Response) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const trips = await TripLog.find({ startTime: { $gte: todayStart } })
    .populate("bus", "busNumber route")
    .select("bus startTime endTime coordinates");

  res.status(200).json({
    success: true,
    date: todayStart.toDateString(),
    totalTrips: trips.length,
    trips,
  });
});

/**
 * ✅ Admin cleanup for older logs (auto or manual)
 */
export const cleanupOldTrips = wrapAsync(async (_req: Request, res: Response) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 2); // keep last 2 days only

  const deleted = await TripLog.deleteMany({ startTime: { $lt: cutoffDate } });
  res.status(200).json({
    success: true,
    message: `Old trip logs deleted`,
    deletedCount: deleted.deletedCount,
  });
});
