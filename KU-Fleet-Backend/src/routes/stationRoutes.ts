import express from "express";
import { createStation, getAllStations } from "../controllers/stationController";
import { adminOnly, protect } from "../middleware/AuthMiddleware";


const router = express.Router();

// Admin only can create stations
router.post("/", protect, adminOnly, createStation);

// Everyone (student, driver, admin) can view
router.get("/", protect, getAllStations);

export default router;
