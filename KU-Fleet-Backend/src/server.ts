// src/core/server.ts
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import "./config/env";
import { validateRequiredEnv } from "./config/env";
import { connectDB } from "./config/db";
// Workers are imported in app.ts - no need to import here
import { app } from "./app";
import { startTcpServer } from "./tcp/tcpServer";
import { setSocketIO, ROOMS, EVENTS } from "./utils/socketHelper";
import { verifyToken } from "./utils/generateToken";
import { getValidMtxToken } from "./utils/getValidMtxToken";
import { gpsBuffer } from "./services/gpsBuffer";
import { Queues } from "./workers/queue";
import { tripWorker, analyticsWorker } from "./workers/workers";
import { cleanupWorker } from "./workers/cleanupWorker";
import { stopAllCronJobs } from "./workers/cronJobs";
import { redisClient } from "./config/redis";
import mongoose from "mongoose";
import User from "./models/User.model";



const HTTP_PORT = Number(process.env.PORT) || 3000;
const TCP_PORT = Number(process.env.TCP_PORT || 5050);

const SHUTDOWN_TIMEOUT_MS = 15_000;

// Resources captured during startup so shutdown can close what we own.
let httpServer: http.Server | null = null;
let tcpServer: import("net").Server | null = null;
let io: SocketIOServer | null = null;
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n${signal} received — graceful shutdown starting`);

  // Never hang forever: force-exit if any resource refuses to close.
  const forceTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    // 1. Stop scheduled jobs FIRST so nothing new is enqueued during shutdown.
    //    Without this, a restart briefly runs two copies of every cron.
    stopAllCronJobs();

    // 2. Stop accepting new TCP tracker sessions and drop existing ones.
    const tcp = tcpServer as (import("net").Server & { closeAllTrackerSockets?: () => void }) | null;
    if (tcp) {
      tcp.closeAllTrackerSockets?.();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
      console.log("TCP listener closed");
    }

    // 3. Flush buffered GPS coordinates BEFORE Redis goes away, so points
    //    already accepted from trackers are not lost.
    await gpsBuffer.shutdown();

    // 4. Stop queue workers before closing Redis, so in-flight jobs finish.
    await Promise.all([
      tripWorker.close(),
      analyticsWorker.close(),
      cleanupWorker.close(),
      ...Object.values(Queues).map((q) => q.close()),
    ]);

    // 5. Disconnect Socket.IO clients, then close the HTTP listener.
    if (io) {
      await new Promise<void>((resolve) => io!.close(() => resolve()));
      console.log("Socket.IO closed");
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      console.log("HTTP listener closed");
    }

    // 6. Close Redis and Mongo last.
    await redisClient.quit().catch(() => undefined);
    await mongoose.connection.close().catch(() => undefined);

    clearTimeout(forceTimer);
    console.log("Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("Error during graceful shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

// A rejected promise or uncaught throw must not leave a half-dead process that
// still accepts trackers while workers and DB are gone.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  void gracefulShutdown("uncaughtException");
});

async function start() {
  // Fail fast, before Mongo/Redis/TCP/Socket.IO are touched, so a configuration
  // mistake produces one clear message instead of a partial boot.
  validateRequiredEnv();

  await connectDB();
  
  // Initialize MTX token on startup
  try {
    await getValidMtxToken();
    console.log("MTX token initialized");
  } catch (e) {
    console.error("MTX token init failed", e);
  }

  // Refresh MTX token every hour
  setInterval(async () => {
    try {
      await getValidMtxToken();
    } catch (e) {
      console.error("MTX token refresh failed", e);
    }
  }, 60 * 60 * 1000);

  // Create HTTP server from Express app
  httpServer = http.createServer(app);

  // Initialize Socket.IO
  io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }, // restrict in production
  });

  // Set Socket.IO in centralized helper
  setSocketIO(io);

  // Also expose via app for backward compatibility
  (app as any).set("io", io);

  // Room join authorization.
  //
  // Threat model that prompted this rewrite:
  //   The handler used to accept ANY string starting with "bus:"/"imei:" and
  //   join it verbatim, and honoured a client-supplied role with no proof. Any
  //   anonymous browser could therefore subscribe to the admin GPS feed, which
  //   carries raw tracker IMEIs (emitted by services/gpsHandler.ts), or to an
  //   arbitrary bus/IMEI room.
  //
  // Rooms are now derived from the AUTHENTICATED role, never from the request.
  //
  //   admins   <- role === "admin" only
  //   students <- everyone else who is authenticated, and also anonymous
  //               clients (the students feed is the sanitized one: it carries
  //               busId + coordinates and never the IMEI)
  //   bus:x / imei:x <- admin only
  //
  // Anonymous clients are deliberately allowed the students room so that an
  // unauthenticated browser can still watch live positions, but they can never
  // obtain the admin feed or a per-resource room.
  const ROLE_TO_ROOM: Record<string, string> = {
    admin: ROOMS.ADMINS,
    admins: ROOMS.ADMINS,
    student: ROOMS.STUDENTS,
    students: ROOMS.STUDENTS,
    driver: ROOMS.STUDENTS,
    parent: ROOMS.STUDENTS,
  };

  const resolveAllowedRooms = (role?: string): string[] => {
    if (!role) return [ROOMS.STUDENTS]; // anonymous: sanitized feed only
    const mapped = ROLE_TO_ROOM[role];
    return mapped ? [mapped] : [ROOMS.STUDENTS];
  };

  io.on("connection", (socket) => {
    const handshakeToken =
      (socket.handshake.auth as { token?: string } | undefined)?.token ||
      (socket.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "");

    socket.data.role = undefined;

    if (handshakeToken) {
      void (async () => {
        try {
          const { id } = verifyToken(handshakeToken);
          const user = await User.findById(id).select("role").lean();
          socket.data.role = user?.role;
          socket.data.userId = id;
        } catch {
          // Bad token: stay anonymous, which grants the students feed only.
          socket.data.role = undefined;
        }
      })();
    }

    socket.on("joinRoom", (data: string | { role?: string; room?: string; busId?: string; imei?: string }) => {
      const payload = typeof data === "string" ? { role: data } : data;
      if (!payload) return;

      const requested = payload.role ?? payload.room;
      const allowed = resolveAllowedRooms(socket.data.role);
      const isAdmin = socket.data.role === "admin";

      // Per-resource rooms carry one bus's or one tracker's live data.
      if (payload.busId || payload.imei) {
        if (!isAdmin) return; // ignore, do not leak
        socket.join(payload.busId ? ROOMS.bus(payload.busId) : ROOMS.imei(payload.imei!));
        return;
      }

      if (!requested) return;

      // Never trust the requested role. Map it, then intersect with what this
      // connection is actually allowed to join.
      const target = ROLE_TO_ROOM[requested];
      if (!target) return;
      if (!allowed.includes(target)) {
        console.warn(
          `[socket] rejected joinRoom "${requested}" for role=${socket.data.role ?? "anonymous"}`
        );
        return;
      }

      socket.join(target);
    });

    socket.on("disconnect", () => {
      // socket cleanup handled by socket.io
    });
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP + Socket.IO running on port ${HTTP_PORT}`);
  });

  try {
    tcpServer = await startTcpServer(TCP_PORT);
    console.log(`TCP server started on port ${TCP_PORT}`);
  } catch (err: any) {
    console.error(`Failed to start TCP server on port ${TCP_PORT}:`, err.message || err);
    if (process.env.RENDER === "true") {
      console.warn("Continuing boot despite TCP server failure (RENDER=true).");
    } else {
      throw err;
    }
  }
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
