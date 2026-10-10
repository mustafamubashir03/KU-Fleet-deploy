/**
 * Pure business logic: distance maths and startup safety.
 */
import test from "node:test";
// Hard-set test mode BEFORE requiring any compiled module, so the Redis/Mongo
// guards in src/config refuse to touch production services.
process.env.NODE_ENV = "test"; // eslint-disable-line
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const { haversineMeters } = require(path.join(dist, "utils", "geo.js"));

// ------------------------------------------------------------------- geo

test("identical points are zero metres apart", () => {
  assert.equal(haversineMeters(31.5204, 74.3587, 31.5204, 74.3587), 0);
});

test("haversine matches a known Lahore -> Islamabad great-circle distance", () => {
  // Lahore 31.5204,74.3587 to Islamabad 33.6844,73.0479 is ~275 km.
  const d = haversineMeters(31.5204, 74.3587, 33.6844, 73.0479) / 1000;
  assert.ok(d > 270 && d < 280, `expected ~275 km, got ${d.toFixed(1)} km`);
});

test("one degree of latitude is about 111 km", () => {
  const d = haversineMeters(0, 0, 1, 0) / 1000;
  assert.ok(d > 110 && d < 112, `expected ~111 km, got ${d.toFixed(2)} km`);
});

test("the result is symmetric", () => {
  const a = haversineMeters(31.5204, 74.3587, 33.6844, 73.0479);
  const b = haversineMeters(33.6844, 73.0479, 31.5204, 74.3587);
  assert.ok(Math.abs(a - b) < 1e-6);
});

test("moving across the equator works (no clamping artefacts)", () => {
  const d = haversineMeters(-1, 0, 1, 0) / 1000;
  assert.ok(d > 220 && d < 224, `expected ~222 km, got ${d.toFixed(2)} km`);
});

// ------------------------------------------------------ Socket.IO event contract

test("socket event names still match what the frontend subscribes to", async () => {
  const { EVENTS, ROOMS } = require(path.join(dist, "utils", "socketHelper.js"));

  // Verified against KU-Fleet-Frontend listeners:
  //   gt06-data, trip-started, trip-ended, overspeed-alert,
  //   alert-created, alert-updated, alert-resolved
  assert.equal(EVENTS.GPS_DATA, "gt06-data");
  assert.equal(EVENTS.TRIP_STARTED, "trip-started");
  assert.equal(EVENTS.TRIP_ENDED, "trip-ended");
  assert.equal(EVENTS.OVERSPEED_ALERT, "overspeed-alert");
  assert.equal(EVENTS.ALERT_CREATED, "alert-created");
  assert.equal(EVENTS.ALERT_UPDATED, "alert-updated");
  assert.equal(EVENTS.ALERT_RESOLVED, "alert-resolved");

  assert.equal(ROOMS.ADMINS, "admins");
  assert.equal(ROOMS.STUDENTS, "students");
  assert.equal(ROOMS.bus("abc"), "bus:abc");
  assert.equal(ROOMS.imei("123"), "imei:123");
});

// ------------------------------------------------------------ startup safety

test("server installs signal handlers for graceful shutdown", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(dist, "server.js"), "utf8");
  assert.match(src, /SIGTERM/, "SIGTERM handler required");
  assert.match(src, /SIGINT/, "SIGINT handler required");
  assert.match(src, /gracefulShutdown/, "a shutdown routine must exist");
});

test("graceful shutdown flushes the GPS buffer before closing Redis", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(dist, "server.js"), "utf8");
  const flush = src.indexOf("gpsBuffer.shutdown");
  const redis = src.indexOf("redisClient.quit");
  assert.ok(flush !== -1, "gpsBuffer.shutdown() must be called on shutdown");
  assert.ok(redis !== -1, "redisClient.quit() must be called on shutdown");
  assert.ok(flush < redis, "GPS points must be flushed BEFORE Redis is closed");
});

test("the startTcpServer result is retained so it can be closed", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(dist, "server.js"), "utf8");
  // TypeScript emits a namespace call such as:
  //   tcpServer = await (0, tcpServer_1.startTcpServer)(TCP_PORT);
  assert.match(src, /tcpServer\s*=\s*await/, "the TCP server handle must be assigned during startup");
  assert.match(src, /startTcpServer/, "startTcpServer must be called during startup");
});

test("TCP entry point resolves with the server handle and can drop tracker sockets", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(dist, "tcp", "tcpServer.js"), "utf8");
  assert.match(src, /resolve\(server\)/, "must resolve with the net.Server handle");
  assert.match(src, /closeAllTrackerSockets/, "must expose a way to drop tracker sockets");
});

test("TCP entry point reassembles frames before parsing", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(dist, "tcp", "tcpServer.js"), "utf8");
  assert.match(src, /extractCompleteFrames/, "must use the reassembly buffer");
});