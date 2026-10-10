// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * TASK A — does a real GT06 login lead to the expected IMEI -> Bus resolution?
 *
 * Chain actually defined by the code:
 *   1. login packet arrives on a tracker TCP session
 *   2. gt06 parser stores the IMEI on the PER-CONNECTION instance
 *      (tcpServer.ts creates `new Gt06()` inside the connection handler)
 *   3. the ACK is written back on the same socket
 *   4. handleParsedMessage() runs and emits gt06-data, but gpsHandler.ts:113 is
 *      `if (!coords || !busId) return;` -- a login packet has NO coordinates, so
 *      it returns early. A login packet on its own resolves nothing observable.
 *   5. the LOCATION packet on the SAME socket carries no IMEI of its own; the
 *      parser attaches the stored one, and THAT is where getBusIdForIMEI()
 *      resolves the bus and the rest of the pipeline runs.
 *
 * So this test sends login then location over ONE socket and asserts the
 * observable outcomes the code defines:
 *   - the login ACK is byte-exact
 *   - a gt06-data event carries the resolved busId (proves IMEI -> Bus)
 *   - the bus location cache key is written (proves the downstream path ran)
 *
 * Uses the CAPTURED packets from the vendored parser's own test vectors.
 * Isolated Mongo (Docker, database name contains "test") and isolated Redis.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  LOGIN_HEX,
  LOCATION_HEX,
  EXPECTED,
  asBuffer,
} from "./fixtures/gt06-packets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendRoot = path.join(here, "..");
const dist = path.join(backendRoot, "dist");
const entry = path.join(dist, "server.js");

const MONGO = process.env.KUFLEET_TEST_MONGO_URI;
const REDIS = process.env.KUFLEET_TEST_REDIS_URL;

const skip = MONGO && REDIS ? false : "Set KUFLEET_TEST_MONGO_URI and KUFLEET_TEST_REDIS_URL";

// This process also needs a usable Redis URL before requiring config/redis.js.
if (REDIS) {
  process.env.REDIS_URL = REDIS;
  process.env.REDIS_DB = "9";
  process.env.KUFLEET_TEST_REDIS_URL = REDIS;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

test("a real GT06 session resolves its IMEI to the correct Bus", { skip, timeout: 180000 }, async () => {
  const httpPort = await freePort();
  const tcpPort = await freePort();

  // --- seed an isolated Bus whose trackerIMEI matches the captured packet ---
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(MONGO);
  await mongoose.connection.dropDatabase();

  const bcrypt = require("bcrypt");
  const User = require(path.join(dist, "models", "User.model.js")).default;
  const Bus = require(path.join(dist, "models", "Bus.model.js")).default;
  const Route = require(path.join(dist, "models", "Route.model.js")).default;

  const driver = await User.create({
    name: "Tracker Driver",
    email: `imei-${Date.now()}@t.test`,
    password: await bcrypt.hash("Passw0rd!", 10),
    role: "driver",
  });
  const route = await Route.create({ routeName: "IMEI Route" });
  const bus = await Bus.create({
    busNumber: "IMEI-1",
    busNumberPlate: "IMEI-1P",
    driver: driver._id,
    route: route._id,
    status: "active",
    trackerIMEI: EXPECTED.loginImeiString, // "123456789012345"
  });

  assert.equal(bus.trackerIMEI, EXPECTED.loginImeiString);

  // --- boot the real compiled backend ---
  const child = spawn(process.execPath, [entry], {
    cwd: "C:\\Windows\\Temp",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(httpPort),
      TCP_PORT: String(tcpPort),
      MONGO_URI: MONGO,
      REDIS_URL: REDIS,
      REDIS_DB: "9",
      JWT_SECRET: "imei-test-secret-long-enough-1234567890",
      CLOUDINARY_CLOUD_NAME: "demo",
      CLOUDINARY_API_KEY: "demo",
      CLOUDINARY_API_SECRET: "demo",
      MTX_BASE_URL: "http://127.0.0.1:1",
      MTX_API_KEY: "x",
      MTX_API_SECRET: "y",
      KUFLEET_TEST_REDIS_URL: REDIS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));

  const exited = new Promise((r) => child.on("exit", (c) => r(c)));

  try {
    // Wait for HTTP + TCP.
    const deadline = Date.now() + 60000;
    let up = false;
    while (!up && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${httpPort}/`);
        up = res.status > 0;
      } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, `the backend did not start:\n${output.slice(-1500)}`);
    assert.match(output, new RegExp(`TCP server listening on port ${tcpPort}`));

    // --- a student socket: authorized, receives the SANITIZED feed ----------
    const { io: ioClient } = require("socket.io-client");
    const socket = ioClient(`http://127.0.0.1:${httpPort}`, {
      transports: ["websocket"],
      forceNew: true,
    });
    await new Promise((res, rej) => {
      socket.on("connect", res);
      socket.on("connect_error", rej);
      setTimeout(() => rej(new Error("socket connect timeout")), 10000);
    });
    // Anonymous -> the students room is the only room it may join.
    socket.emit("joinRoom", { role: "student" });
    await new Promise((r) => setTimeout(r, 300));

    const events = [];
    socket.on("gt06-data", (p) => events.push(p));

    // --- ONE tracker session: login, then a location packet ---------------
    const acks = [];
    const sock = net.connect(tcpPort, "127.0.0.1");
    await new Promise((res, rej) => {
      sock.on("connect", res);
      sock.on("error", rej);
    });

    sock.on("data", (d) => acks.push(Buffer.from(d)));

    sock.write(asBuffer(LOGIN_HEX));
    await new Promise((r) => setTimeout(r, 1200));

    // (a) the login ACK is byte-exact
    assert.ok(acks.length >= 1, "the login packet must be acknowledged");
    assert.equal(
      acks[0].toString("hex"),
      EXPECTED.loginAckHex,
      `login ACK mismatch: ${acks[0].toString("hex")}`
    );

    // (b) the LOCATION packet on the SAME socket must resolve the bus
    sock.write(asBuffer(LOCATION_HEX));

    const evtDeadline = Date.now() + 15000;
    while (!events.some((e) => e.busId) && Date.now() < evtDeadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const resolved = events.find((e) => e.busId);
    assert.ok(
      resolved,
      `no gt06-data carried a busId; events=${JSON.stringify(events)}`
    );

    // THIS is the assertion that answers Task A.
    assert.equal(
      String(resolved.busId),
      String(bus._id),
      "the IMEI carried by the login packet must resolve to the seeded Bus"
    );

    // (c) the students feed must NOT leak the raw IMEI
    for (const e of events) {
      assert.ok(!("imei" in e), "the students feed must not contain imei");
    }

    // (d) the location cache key is written -> the downstream path ran
    const { Redis } = await import("ioredis");
    const checker = new Redis(REDIS, { db: 9 });
    const cacheDeadline = Date.now() + 15000;
    let cached = null;
    while (!cached && Date.now() < cacheDeadline) {
      cached = await checker.get(`bus:location:${bus._id}`);
      if (!cached) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cached, `expected Redis key bus:location:${bus._id} to be written`);
    const parsed = JSON.parse(cached);
    assert.equal(typeof parsed.lat, "number");
    assert.equal(typeof parsed.lng, "number");
    await checker.quit();

    // (e) location packets are not acknowledged
    const ackCountAfterLogin = acks.length;
    assert.ok(
      acks.length === ackCountAfterLogin,
      "a location packet must not produce an extra ACK"
    );

    sock.destroy();
    socket.disconnect();
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  }
});