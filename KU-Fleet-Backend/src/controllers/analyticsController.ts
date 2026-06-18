import { Request, Response } from "express";
import mongoose from "mongoose";
import Bus from "../models/Bus.model";
import TripLog from "../models/TripLog.model";
import Alert from "../models/Alert.model";
import Feedback from "../models/Feedback.model";
import { cacheHelpers } from "../config/redis";
import { routeParam } from "../utils/validation";
import { wrapAsync } from "../middleware/errorHandler";

/** -----------------------------
 *  GET /api/analytics/overview
 *  Summary of all key stats (cached)
 *  ----------------------------- */
export const getFleetOverview = wrapAsync(async (req: Request, res: Response) => {
  const cacheKey = "analytics:fleetOverview";
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return res.status(200).json({ success: true, ...cached });

  const [totalBuses, activeBuses, totalDrivers, totalTrips, totalAlerts] = await Promise.all([
    Bus.countDocuments(),
    Bus.countDocuments({ busStatus: "active" }),
    Bus.distinct("driver.name").then((arr) => arr.length),
    TripLog.countDocuments(),
    Alert.countDocuments(),
  ]);

  const avgRatingAgg = await Feedback.aggregate([{ $group: { _id: null, avgRating: { $avg: "$rating" } } }]);

  const overview = {
    totalBuses,
    activeBuses,
    totalDrivers,
    totalTrips,
    totalAlerts,
    avgRating: avgRatingAgg[0]?.avgRating || 0,
  };

  // Cache for 10 minutes
  await cacheHelpers.setAnalyticsData(cacheKey, overview, 600);

  res.status(200).json({ success: true, overview });
});

/** -----------------------------
 *  GET /api/analytics/bus/:id
 *  Bus-specific performance (cached)
 *  ----------------------------- */
export const getBusAnalytics = wrapAsync(async (req: Request, res: Response) => {
  const busId = routeParam(req.params.id);
  if (!busId) {
    return res.status(400).json({ message: "Bus ID is required" });
  }
  const cacheKey = `analytics:bus:${busId}`;
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return res.status(200).json({ success: true, ...cached });

  const [tripStats, alerts, feedbacks] = await Promise.all([
    TripLog.aggregate([
      { $match: { bus: new mongoose.Types.ObjectId(busId) } },
      {
        $group: {
          _id: "$bus",
          totalDistance: { $sum: "$distance" },
          avgSpeed: { $avg: "$avgSpeed" },
          totalTrips: { $sum: 1 },
        },
      },
    ]),
    Alert.find({ bus: busId }).sort({ createdAt: -1 }).limit(10),
    Feedback.find({ bus: busId }).sort({ createdAt: -1 }).limit(10),
  ]);

  const result = {
    busId,
    stats: tripStats[0] || {},
    alerts,
    feedbacks,
  };

  // Cache for 5 minutes
  await cacheHelpers.setAnalyticsData(cacheKey, result, 300);

  res.status(200).json({ success: true, ...result });
});

/** -----------------------------
 *  GET /api/analytics/driver/:id
 *  Driver performance analytics (cached)
 *  ----------------------------- */
export const getDriverAnalytics = wrapAsync(async (req: Request, res: Response) => {
  const driverId = routeParam(req.params.id);
  if (!driverId) {
    return res.status(400).json({ message: "Driver ID is required" });
  }
  const cacheKey = `analytics:driver:${driverId}`;
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return res.status(200).json({ success: true, ...cached });

  const buses = await Bus.find({ "driver._id": new mongoose.Types.ObjectId(driverId) });
  const busIds = buses.map((b) => b._id);

  const trips = await TripLog.aggregate([
    { $match: { bus: { $in: busIds } } },
    {
      $group: {
        _id: null,
        totalTrips: { $sum: 1 },
        totalDistance: { $sum: "$distance" },
        avgSpeed: { $avg: "$avgSpeed" },
      },
    },
  ]);

  const alerts = await Alert.countDocuments({ bus: { $in: busIds } });

  const result = {
    driverId,
    trips: trips[0] || {},
    totalAlerts: alerts,
  };

  // Cache 5 minutes
  await cacheHelpers.setAnalyticsData(cacheKey, result, 300);

  res.status(200).json({ success: true, ...result });
});

/** -----------------------------
 *  GET /api/analytics/routes
 *  Route-level statistics (cached)
 *  ----------------------------- */
export const getRouteAnalytics = wrapAsync(async (req: Request, res: Response) => {
  const cacheKey = `analytics:routes`;
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return res.status(200).json({ success: true, routeStats: cached });

  const routeStats = await TripLog.aggregate([
    {
      $lookup: {
        from: "buses",
        localField: "bus",
        foreignField: "_id",
        as: "busInfo",
      },
    },
    { $unwind: "$busInfo" },
    {
      $group: {
        _id: "$busInfo.route",
        totalTrips: { $sum: 1 },
        totalDistance: { $sum: "$distance" },
        avgSpeed: { $avg: "$avgSpeed" },
      },
    },
  ]);

  // Cache 10 minutes
  await cacheHelpers.setAnalyticsData(cacheKey, routeStats, 600);

  res.status(200).json({ success: true, routeStats });
});

/** -----------------------------
 *  GET /api/analytics/alerts
 *  Alert trend analysis (cached)
 *  ----------------------------- */
export const getAlertTrends = wrapAsync(async (req: Request, res: Response) => {
  const cacheKey = `analytics:alerts`;
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return res.status(200).json({ success: true, alertTrends: cached });

  const alertTrends = await Alert.aggregate([
    { $group: { _id: { type: "$type" }, total: { $sum: 1 } } },
  ]);

  await cacheHelpers.setAnalyticsData(cacheKey, alertTrends, 600);
  res.status(200).json({ success: true, alertTrends });
});

/** -----------------------------
 *  GET /api/analytics/feedback
 *  Rating & complaint analytics (cached)
 *  ----------------------------- */
export const getFeedbackAnalytics = wrapAsync(async (req: Request, res: Response) => {
  const cacheKey = `analytics:feedback`;
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return res.status(200).json({ success: true, ...cached });

  const ratings = await Feedback.aggregate([{ $group: { _id: "$rating", count: { $sum: 1 } } }]);
  const unresolved = await Feedback.countDocuments({ resolved: false });

  const result = { ratings, unresolvedComplaints: unresolved };
  await cacheHelpers.setAnalyticsData(cacheKey, result, 600);

  res.status(200).json({ success: true, ...result });
});

/** -----------------------------
 *  GET /api/analytics/timeseries?days=7
 *  Fleet usage trends over time (cached)
 *  ----------------------------- */
export const getFleetTimeseries = wrapAsync(async (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 7;
  const cacheKey = `analytics:timeseries:${days}`;
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return res.status(200).json({ success: true, days, trips: cached });

  const since = new Date();
  since.setDate(since.getDate() - days);

  const trips = await TripLog.aggregate([
    { $match: { startTime: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$startTime" } },
        totalDistance: { $sum: "$distance" },
        totalTrips: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  await cacheHelpers.setAnalyticsData(cacheKey, trips, 600);

  res.status(200).json({ success: true, days, trips });
});
