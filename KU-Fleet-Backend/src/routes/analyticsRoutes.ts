import express from "express";

import { protect, adminOnly } from "../middleware/AuthMiddleware";
import { getAlertTrends, getBusAnalytics, getDriverAnalytics, getFeedbackAnalytics, getFleetOverview, getFleetTimeseries, getRouteAnalytics } from "../controllers/analyticsController";


const router = express.Router();

router.get("/overview", protect, getFleetOverview);
router.get("/bus/:id", protect, getBusAnalytics);
router.get("/driver/:id", protect, getDriverAnalytics);
router.get("/routes", protect, getRouteAnalytics);
router.get("/alerts", protect, getAlertTrends);
router.get("/feedback", protect, getFeedbackAnalytics);
router.get("/timeseries", protect, getFleetTimeseries);

export default router;
