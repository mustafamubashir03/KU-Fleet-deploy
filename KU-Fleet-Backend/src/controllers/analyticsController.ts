import { Request, Response } from "express";
import mongoose from "mongoose";
import Bus from "../models/Bus.model";
import TripLog from "../models/TripLog.model";
import Alert from "../models/Alert.model";
import Feedback from "../models/Feedback.model";
import { cacheHelpers } from "../config/redis";
import { routeParam } from "../utils/validation";

/** -----------------------------
 *  GET /api/analytics/overview
 *  Summary of all key stats (cached)
 *  ----------------------------- */
export const getFleetOverview = async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch fleet overview", error });
  }
};

/** -----------------------------
 *  GET /api/analytics/bus/:id
 *  Bus-specific performance (cached)
 *  ----------------------------- */
export const getBusAnalytics = async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch bus analytics", error });
  }
};

/** -----------------------------
 *  GET /api/analytics/driver/:id
 *  Driver performance analytics (cached)
 *  ----------------------------- */
export const getDriverAnalytics = async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch driver analytics", error });
  }
};

/** -----------------------------
 *  GET /api/analytics/routes
 *  Route-level statistics (cached)
 *  ----------------------------- */
export const getRouteAnalytics = async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch route analytics", error });
  }
};

/** -----------------------------
 *  GET /api/analytics/alerts
 *  Alert trend analysis (cached)
 *  ----------------------------- */
export const getAlertTrends = async (req: Request, res: Response) => {
  try {
    const cacheKey = `analytics:alerts`;
    const cached = await cacheHelpers.getAnalyticsData(cacheKey);
    if (cached) return res.status(200).json({ success: true, alertTrends: cached });

    const alertTrends = await Alert.aggregate([
      { $group: { _id: { type: "$type" }, total: { $sum: 1 } } },
    ]);

    await cacheHelpers.setAnalyticsData(cacheKey, alertTrends, 600);
    res.status(200).json({ success: true, alertTrends });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch alert analytics", error });
  }
};

/** -----------------------------
 *  GET /api/analytics/feedback
 *  Rating & complaint analytics (cached)
 *  ----------------------------- */
export const getFeedbackAnalytics = async (req: Request, res: Response) => {
  try {
    const cacheKey = `analytics:feedback`;
    const cached = await cacheHelpers.getAnalyticsData(cacheKey);
    if (cached) return res.status(200).json({ success: true, ...cached });

    const ratings = await Feedback.aggregate([{ $group: { _id: "$rating", count: { $sum: 1 } } }]);
    const unresolved = await Feedback.countDocuments({ resolved: false });

    const result = { ratings, unresolvedComplaints: unresolved };
    await cacheHelpers.setAnalyticsData(cacheKey, result, 600);

    res.status(200).json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch feedback analytics", error });
  }
};

/** -----------------------------
 *  GET /api/analytics/timeseries?days=7
 *  Fleet usage trends over time (cached)
 *  ----------------------------- */
export const getFleetTimeseries = async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch fleet timeseries", error });
  }
};
