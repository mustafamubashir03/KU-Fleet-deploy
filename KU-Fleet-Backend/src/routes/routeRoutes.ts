import express from "express";

import { protect, adminOnly } from "../middleware/AuthMiddleware";
import {

  createRoute,
  getRoutes,
  getRouteById,
  deleteRoute,
} from "../controllers/routeController";

const router = express.Router();

// Create new route
router.post("/", protect, adminOnly, createRoute);

// Get all routes
router.get("/", protect, getRoutes);

// Get single route
router.get("/:id", protect, getRouteById);

// Delete route
router.delete("/:id", protect, adminOnly, deleteRoute);

export default router;
