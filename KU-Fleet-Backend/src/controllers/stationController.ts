import { Request, Response } from "express";
import Station from "../models/Station.model";
import { wrapAsync } from "../middleware/errorHandler";

/** POST /api/stations */
export const createStation = wrapAsync(async (req: Request, res: Response) => {
  const { stationName, coordinates } = req.body;

  if (!stationName || !coordinates || coordinates.length !== 2) {
    return res.status(400).json({ message: "Station name and valid coordinates required" });
  }

  const exists = await Station.findOne({ stationName });
  if (exists) return res.status(400).json({ message: "Station already exists" });

  const station = await Station.create({
    stationName,
    position: {
      type: "Point",
      coordinates,
    },
  });
  res.status(201).json({ success: true, station });
});

/** GET /api/stations */
export const getAllStations = wrapAsync(async (_req: Request, res: Response) => {
  const stations = await Station.find().select("stationName position");
  res.status(200).json({ success: true, stations });
});
