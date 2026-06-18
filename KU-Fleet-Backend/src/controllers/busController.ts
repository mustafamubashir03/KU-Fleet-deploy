// src/controllers/busController.ts
// Bus CRUD operations with proper error handling and validation

import { Request, Response } from "express";
import { Types } from "mongoose";
import Bus from "../models/Bus.model";
import Route from "../models/Route.model";
import User from "../models/User.model";
import { cacheHelpers, redisClient } from "../config/redis";
import { bufferCoordinate } from "../services/gpsBuffer";
import { getSocketIO, ROOMS, EVENTS } from "../utils/socketHelper";
import { buildCameraStreamUrl } from "../utils/buildCameraURL";
import { IBus } from "../interfaces/Bus";
import { routeParam } from "../utils/validation";

// GET /api/buses — List all buses
/** ✅ Get all buses */
// GET /api/buses — List all buses
const generateCameraStreamUrls = async (bus: IBus): Promise<Record<number, string>> => {
  const urls: Record<number, string> = {};
  if (!bus.camera?.deviceId) return urls;
  const channels = bus.camera.channels ?? [1]; // default to [1] if undefined
  for (const ch of channels) {
    urls[ch] = await buildCameraStreamUrl(bus.camera.deviceId, ch);
  }
  return urls;
};

// ------------------------ GET ALL BUSES ------------------------
export const getBuses = async (_req: Request, res: Response) => {
  try {
    const buses = await Bus.find()
      .populate({
        path: "route",
        select: "routeName stations",
        populate: { path: "stations", select: "stationName" },
      })
      .populate("driver", "name email photo")
      .sort({ createdAt: -1 });

    const busesWithCamera = await Promise.all(
      buses.map(async (bus) => ({
        ...bus.toObject(),
        cameraStreamUrls: await generateCameraStreamUrls(bus),
      }))
    );

    res.status(200).json({
      success: true,
      count: busesWithCamera.length,
      buses: busesWithCamera,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch buses", error });
  }
};

// ------------------------ GET SINGLE BUS ------------------------
export const getBusById = async (req: Request, res: Response) => {
  try {
    const bus = await Bus.findById(req.params.id)
      .populate("route", "routeName stations")
      .populate("driver", "name email photo");

    if (!bus) return res.status(404).json({ message: "Bus not found" });

    const cameraStreamUrls = await generateCameraStreamUrls(bus);

    res.status(200).json({
      success: true,
      bus: {
        ...bus.toObject(),
        cameraStreamUrls,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch bus", error });
  }
};


// GET /api/buses/status/:status — Filter by status
/** ✅ Filter buses by status (active/inactive/maintenance) */
export const getBusesByStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.params;
    const buses = await Bus.find({status})
      .populate({
        path: "route",
        select: "routeName stations",
        populate: {
          path: "stations",
          select: "stationName", // You can add more fields if needed
        },
      })
      .populate("driver", "name email photo")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, count: buses.length, buses });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch buses by status", error });
  }
};


// POST /api/buses — Register new bus


export const createBus = async (req: Request, res: Response) => {
  try {
    const {
      busNumber,
      busNumberPlate,
      capacity,
      routeId,
      driverId,
      trackerIMEI,
      photo,
    } = req.body;

    if (!busNumber || !busNumberPlate || !routeId)
      return res.status(400).json({ message: "Bus number, number plate, and route are required" });

    const route = await Route.findById(routeId);
    if (!route)
      return res.status(404).json({ message: "Route not found" });

    let driver = null;
    if (driverId) {
      driver = await User.findById(driverId);
      if (!driver || driver.role !== "driver")
        return res.status(400).json({ message: "Invalid driver ID" });
    }

    const bus = await Bus.create({
      busNumber,
      busNumberPlate,
      capacity,
      route: routeId,
      driver: driverId || null,
      trackerIMEI,
      photo,
    });

    // Emit socket event for bus creation
    const io = getSocketIO();
    if (io) {
      io.to(ROOMS.ADMINS).emit(EVENTS.BUS_CREATED, {
        bus: {
          _id: bus._id,
          busNumber: bus.busNumber,
          busNumberPlate: bus.busNumberPlate,
          capacity: bus.capacity,
          route: routeId,
          driver: driverId || null,
          trackerIMEI: bus.trackerIMEI,
          status: bus.status
        }
      });
    }

    res.status(201).json({
      success: true,
      message: "Bus registered successfully",
      bus,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to create bus", error });
  }
};



/** ✅ Update bus details */
export const updateBus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const bus = await Bus.findByIdAndUpdate(id, updates, {
      new: true,
    })
      .populate("route", "routeName")
      .populate("driver", "name email");

    if (!bus) return res.status(404).json({ message: "Bus not found" });

    // Emit socket event for bus update
    const io = getSocketIO();
    if (io) {
      io.to(ROOMS.ADMINS).emit(EVENTS.BUS_UPDATED, {
        busId: String(bus._id),
        updates,
        bus: {
          _id: bus._id,
          busNumber: bus.busNumber,
          status: bus.status,
          route: bus.route,
          driver: bus.driver
        }
      });
      // Emit to bus-specific room if status changed
      if (updates.status) {
        io.to(ROOMS.bus(String(bus._id))).emit(EVENTS.BUS_STATUS_CHANGED, {
          busId: String(bus._id),
          status: bus.status
        });
      }
    }

    res.status(200).json({ success: true, message: "Bus updated", bus });
  } catch (error) {
    res.status(500).json({ message: "Failed to update bus", error });
  }
};


// DELETE /api/buses/:id — Deactivate bus
export const deleteBus = async (req: Request, res: Response) => {
  try {
    const deactivatedBus = await Bus.findByIdAndUpdate(
      req.params.id,
      { status: "inactive" }, // Fixed: use 'status' not 'busStatus'
      { new: true }
    );
    if (!deactivatedBus) return res.status(404).json({ message: "Bus not found" });

    // Emit socket events for bus deactivation
    const io = getSocketIO();
    if (io) {
      io.to(ROOMS.ADMINS).emit(EVENTS.BUS_DELETED, {
        busId: String(deactivatedBus._id),
        bus: {
          _id: deactivatedBus._id,
          busNumber: deactivatedBus.busNumber,
          status: deactivatedBus.status
        }
      });
      io.to(ROOMS.bus(String(deactivatedBus._id))).emit(EVENTS.BUS_STATUS_CHANGED, {
        busId: String(deactivatedBus._id),
        status: "inactive"
      });
    }

    res.status(200).json({ message: "Bus deactivated", bus: deactivatedBus });
  } catch (error) {
    res.status(400).json({ message: "Failed to deactivate bus", error });
  }
};

// POST /api/buses/assign-driver — Assign driver to bus
export const assignDriver = async (req: Request, res: Response) => {
  try {
    const { busId, driverId } = req.body;
    if (!busId || !driverId)
      return res.status(400).json({ message: "Bus ID and Driver ID are required" });

    const bus = await Bus.findById(busId);
    const driver = await User.findById(driverId);

    if (!bus) return res.status(404).json({ message: "Bus not found" });
    if (!driver) return res.status(404).json({ message: "Driver not found" });

    // Assign driver's ObjectId to the bus per schema
    bus.driver = driver._id as unknown as Types.ObjectId;
    await bus.save();

    // Emit socket event for driver assignment
    const io = getSocketIO();
    if (io) {
      io.to(ROOMS.ADMINS).emit(EVENTS.DRIVER_ASSIGNED, {
        busId: String(bus._id),
        driverId: String(driver._id),
        driver: {
          _id: driver._id,
          name: driver.name,
          email: driver.email
        },
        bus: {
          _id: bus._id,
          busNumber: bus.busNumber
        }
      });
    }

    res.status(200).json({ message: "Driver assigned successfully", bus });
  } catch (error) {
    res.status(500).json({ message: "Failed to assign driver", error });
  }
};

// POST /api/buses/unassign-driver — Remove driver from bus
export const unassignDriver = async (req: Request, res: Response) => {
  try {
    const { busId } = req.body;
    if (!busId) return res.status(400).json({ message: "Bus ID required" });

    const bus = await Bus.findById(busId);
    if (!bus) return res.status(404).json({ message: "Bus not found" });

    delete bus.driver;
    await bus.save();

    res.status(200).json({ message: "Driver unassigned successfully", bus });
  } catch (error) {
    res.status(500).json({ message: "Failed to unassign driver", error });
  }
};

// GET /api/buses/:id/location — Get bus current location
export const getBusLocation = async (req: Request, res: Response) => {
  try {
    const id = routeParam(req.params.id);
    
    if (!id) {
      return res.status(400).json({ message: "Bus ID is required" });
    }
    
    // Try to get from cache first
    let location = await cacheHelpers.getBusLocation(id);
    
    if (!location) {
      // If not in cache, get from database
      const bus = await Bus.findById(id).select("lastLocation lastUpdate status");
      if (!bus) {
        return res.status(404).json({ message: "Bus not found" });
      }
      
      location = {
        coordinates: bus.lastLocation,
        timestamp: bus.lastUpdate,
        status: bus.status
      };
      
      // Cache the location for 5 minutes
      if (location.coordinates) {
        await cacheHelpers.setBusLocation(id.toString(), location, 300);
      }
    }

    res.status(200).json({ 
      success: true, 
      busId: id,
      location 
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch bus location", error });
  }
};

// PUT /api/buses/:id/location — Update bus location
export const updateBusLocation = async (req: Request, res: Response) => {
  try {
    const id = routeParam(req.params.id);
    const { coordinates, speed, timestamp } = req.body;
    
    if (!id) {
      return res.status(400).json({ message: "Bus ID is required" });
    }
    
    if (!coordinates || !coordinates.lat || !coordinates.lng) {
      return res.status(400).json({ 
        message: "Valid coordinates (lat, lng) are required" 
      });
    }

    // Update bus location in database
    await Bus.findByIdAndUpdate(id, {
      lastLocation: coordinates,
      lastUpdate: timestamp || new Date()
    });

    // Cache the location
    const locationData = {
      coordinates,
      speed,
      timestamp: timestamp || new Date()
    };
    await cacheHelpers.setBusLocation(id.toString(), locationData, 300);

    // OPTIMIZATION: Use GPS buffer instead of queue job for manual location updates
    // This reduces BullMQ Redis operations significantly
    // Buffer will flush coordinates in batches (every 30s) instead of creating jobs per update
    bufferCoordinate(id, {
      lat: coordinates.lat,
      lng: coordinates.lng,
      speed: speed || 0,
      timestamp: timestamp || new Date()
    });

    // Emit socket event for location update
    const io = getSocketIO();
    if (io) {
      io.to(ROOMS.ADMINS).emit(EVENTS.BUS_LOCATION_UPDATE, {
        busId: id,
        location: locationData
      });
      io.to(ROOMS.STUDENTS).emit(EVENTS.BUS_LOCATION_UPDATE, {
        busId: id,
        location: {
          coordinates,
          speed,
          timestamp: timestamp || new Date()
        }
      });
      io.to(ROOMS.bus(id)).emit(EVENTS.BUS_LOCATION_UPDATE, {
        busId: id,
        location: locationData
      });
    }

    res.status(200).json({ 
      success: true, 
      message: "Bus location updated successfully",
      location: locationData
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update bus location", error });
  }
};

// GET /api/buses/locations/all — Get all bus locations
export const getAllBusLocations = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    
    const filter: any = {};
    if (status) filter.status = status;
    
    const buses = await Bus.find(filter)
      .select("busNumber busNumberPlate lastLocation lastUpdate status")
      .populate("route", "routeName")
      .populate("driver", "name");

    const locations = [];
    
    // OPTIMIZATION: Batch Redis reads using MGET instead of individual GET calls
    // This reduces Redis operations from N to 1 for N buses
    const busIds = buses.map(b => b._id?.toString()).filter(Boolean) as string[];
    const cacheKeys = busIds.map(id => `bus:location:${id}`);
    
    let cachedLocations: Map<string, any> = new Map();
    if (cacheKeys.length > 0) {
      try {
        // Batch read all locations in one Redis call (MGET)
        const values = await redisClient.mget(...cacheKeys);
        values.forEach((value, index) => {
          if (value && busIds[index]) {
            try {
              cachedLocations.set(busIds[index], JSON.parse(value));
            } catch (e) {
              // Invalid JSON, skip
            }
          }
        });
      } catch (err) {
        console.warn("⚠️ Batch cache read failed, falling back to individual reads:", err);
      }
    }
    
    for (const bus of buses) {
      const busId = bus._id?.toString() || "";
      // Use batch-read cache first
      let location = cachedLocations.get(busId);
      
      // Fallback to individual cache read if not in batch result
      if (!location) {
        location = await cacheHelpers.getBusLocation(busId);
      }
      
      // Final fallback to database
      if (!location && bus.lastLocation) {
        location = {
          coordinates: bus.lastLocation,
          timestamp: bus.lastUpdate,
          status: bus.status
        };
      }
      
      locations.push({
        busId: bus._id,
        busNumber: bus.busNumber,
        busNumberPlate: bus.busNumberPlate,
        route: bus.route,
        driver: bus.driver,
        location,
        status: bus.status
      });
    }

    res.status(200).json({ 
      success: true, 
      count: locations.length,
      locations 
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch bus locations", error });
  }
};
