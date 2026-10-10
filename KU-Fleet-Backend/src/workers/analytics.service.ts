// src/services/analytics.service.ts
import TripLog from "../models/TripLog.model";
import Bus from "../models/Bus.model";
import Alert from "../models/Alert.model";
import { cacheHelpers } from "../config/redis";
import { AlertService } from "./alert.service";

/* -------------------- TYPES -------------------- */
interface DailyAnalytics {
  date: string;
  totalTrips: number;
  completedTrips: number;
  alertsToday: number;
  activeBuses: number;
  totalBuses: number;
  completionRate: number;
  utilizationRate: number;
}

interface BusAnalytics {
  busId: string;
  date: string;
  tripsCount: number;
  totalDistance: number;
  averageSpeed: number;
  alertsCount: number;
}

interface RouteAnalytics {
  routeId: string;
  date: string;
  tripsCount: number;
  totalPassengers: number;
  totalDistance: number;
  averagePassengers: number;
}

/* -------------------- HELPERS -------------------- */
function formatDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

function getTodayRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start, end };
}

/* -------------------- DAILY ANALYTICS -------------------- */
export async function generateDailyAnalytics(): Promise<void> {
  const { start, end } = getTodayRange();
  const dateKey = formatDate(start);

  const [totalTrips, completedTrips, activeBuses, totalBuses, alertsToday] =
    await Promise.all([
      TripLog.countDocuments({ startTime: { $gte: start, $lte: end } }),
      TripLog.countDocuments({ startTime: { $gte: start, $lte: end }, endTime: { $ne: null } }),
      Bus.countDocuments({ status: "active" }),
      Bus.countDocuments(),
      Alert.countDocuments({ timestamp: { $gte: start, $lte: end } }),
    ]);

  const analytics: DailyAnalytics = {
    date: dateKey,
    totalTrips,
    completedTrips,
    alertsToday,
    activeBuses,
    totalBuses,
    completionRate: totalTrips > 0 ? (completedTrips / totalTrips) * 100 : 0,
    utilizationRate: totalBuses > 0 ? (activeBuses / totalBuses) * 100 : 0,
  };

  await cacheHelpers.setAnalyticsData(`daily:${dateKey}`, analytics, 86400); // 24h
}

/* -------------------- BUS ANALYTICS -------------------- */
export async function generateBusAnalytics(busId: string): Promise<void> {
  const { start, end } = getTodayRange();
  const dateKey = formatDate(start);

  const trips = await TripLog.find({ bus: busId, startTime: { $gte: start, $lte: end } });

  const totalDistance = trips.reduce((acc, t) => acc + (t.distance ?? 0), 0);
  const averageSpeed = trips.length ? trips.reduce((acc, t) => acc + (t.avgSpeed ?? 0), 0) / trips.length : 0;

  const alertsCount = await Alert.countDocuments({ bus: busId, timestamp: { $gte: start, $lte: end } });

  const analytics: BusAnalytics = {
    busId,
    date: dateKey,
    tripsCount: trips.length,
    totalDistance,
    averageSpeed,
    alertsCount,
  };

  await cacheHelpers.setAnalyticsData(`bus:${busId}:${dateKey}`, analytics, 86400);
}

/* -------------------- ROUTE ANALYTICS -------------------- */
export async function generateRouteAnalytics(routeId: string): Promise<void> {
  const { start, end } = getTodayRange();
  const dateKey = formatDate(start);

  const trips = await TripLog.find({ route: routeId, startTime: { $gte: start, $lte: end } });

  const totalPassengers = trips.reduce((acc, t) => acc + (t.passengerCount ?? 0), 0);
  const totalDistance = trips.reduce((acc, t) => acc + (t.distance ?? 0), 0);
  const averagePassengers = trips.length ? totalPassengers / trips.length : 0;

  const analytics: RouteAnalytics = {
    routeId,
    date: dateKey,
    tripsCount: trips.length,
    totalPassengers,
    totalDistance,
    averagePassengers,
  };

  await cacheHelpers.setAnalyticsData(`route:${routeId}:${dateKey}`, analytics, 86400);
}

/* -------------------- ALERT TRENDS ANALYTICS -------------------- */
export async function generateAlertAnalytics(): Promise<void> {
  const cacheKey = "analytics:alerts";

  // Check if cached
  const cached = await cacheHelpers.getAnalyticsData(cacheKey);
  if (cached) return; // already cached, nothing to do

  // Aggregate alert trends from DB
  const alertTrends = await Alert.aggregate([
    { $group: { _id: "$type", total: { $sum: 1 } } },
  ]);

  // Cache for 10 minutes
  await cacheHelpers.setAnalyticsData(cacheKey, alertTrends, 600);
}

