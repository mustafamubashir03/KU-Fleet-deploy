import express from "express";
import { protect, adminOnly } from "../middleware/AuthMiddleware";
import {
  createAlert,
  resolveAlert,
  getAlertStats,
  getBusAlerts,
} from "../controllers/alertController";

const router = express.Router();

// Public route (system-generated alerts)
router.post("/", protect, createAlert);

// Protected routes
router.get("/stats", protect, getAlertStats);
router.get("/bus/:busId", protect, getBusAlerts);

// Admin-only routes
router.put("/:id/resolve", protect, adminOnly, resolveAlert);

export default router;
