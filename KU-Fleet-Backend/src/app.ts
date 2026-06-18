// src/core/app.ts
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// Error handlers
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

// Routes
import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import busRoutes from "./routes/busRoutes";
import driverRoutes from "./routes/driverRoutes";
import analyticRoutes from "./routes/analyticsRoutes";
import stationRoutes from "./routes/stationRoutes";
import routeRoutes from "./routes/routeRoutes";
import tripRoutes from "./routes/tripRoutes";
import feedbackRoutes from "./routes/feebackRoutes";
import alertRoutes from "./routes/alertRoutes";
import uploadRoutes from "./routes/uploadRoutes";
import rfidRoutes from "./routes/rfidRoutes";

// Workers/cron jobs
// Workers (single entry point)
import "./workers/workers";
import "./workers/cleanupWorker";
import "./workers/cronJobs";


dotenv.config();

export const app = express();

// ============================
// ESSENTIAL MIDDLEWARE ONLY
// ============================

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || "*",
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ============================
// ROUTES
// ============================

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/buses", busRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/analytics", analyticRoutes);
app.use("/api/stations", stationRoutes);
app.use("/api/routes", routeRoutes);
app.use("/api/tripLogs", tripRoutes);
app.use("/api/feedback", feedbackRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/rfid", rfidRoutes);

// Health check
app.get("/", (_, res) => {
  res.json({
    success: true,
    message: "KU Fleet Backend is up",
    timestamp: new Date().toISOString(),
  });
});
app.get("/students/test", (_req, res) => {
  res.json({
    success: true,
    message: "Student auth routes are LIVE",
    timestamp: new Date().toISOString(),
  });
});

// ============================
// ERROR HANDLING
// ============================

app.use(notFoundHandler);
app.use(errorHandler);
