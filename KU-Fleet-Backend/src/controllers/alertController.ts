import { Request, Response } from "express";
import { wrapAsync, AppError } from "../middleware/errorHandler";
import { AlertService } from "../workers/alert.service";
import { routeParam } from "../utils/validation";


// Example: Create alert
export const createAlert = wrapAsync(async (req: Request, res: Response) => {
  const alert = await AlertService.createAlert(req.body);
  res.status(201).json({ success: true, message: "Alert created successfully", alert });
});

// Example: Resolve alert
export const resolveAlert = wrapAsync(async (req: Request, res: Response) => {
  const alert = await AlertService.resolveAlert(routeParam(req.params.id));
  res.status(200).json({ success: true, message: "Alert resolved successfully", alert });
});

// Example: Alert stats
export const getAlertStats = wrapAsync(async (req: Request, res: Response) => {
  const stats = await AlertService.getAlertStats(Number(req.query.days) || 7);
  res.status(200).json({ success: true, stats });
});

// Example: Get bus alerts
export const getBusAlerts = wrapAsync(async (req: Request, res: Response) => {
  const alerts = await AlertService.getBusAlerts(routeParam(req.params.busId), req.query.resolved === "true", Number(req.query.limit) || 50);
  res.status(200).json({ success: true, count: alerts.length, alerts });
});
