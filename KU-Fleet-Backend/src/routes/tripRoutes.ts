// src/routes/tripRoutes.ts
import express from "express";

import { protect, adminOnly } from "../middleware/AuthMiddleware";
import {

  logBusPosition,
  getTripLogsByBus,
  getDailyTripSummary,
  cleanupOldTrips,
} from "../controllers/tripController";

const router = express.Router();

router.post("/log", protect, logBusPosition);                // called by hardware every 10–15 mins
router.get("/bus/:busId", protect, getTripLogsByBus);        // analytics per bus
router.get("/summary/daily", protect, adminOnly, getDailyTripSummary);  // admin summary
router.delete("/cleanup", protect, adminOnly, cleanupOldTrips);         // remove old data

export default router;
