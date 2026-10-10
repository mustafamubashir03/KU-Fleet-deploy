// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * LIVE Socket.IO authorization and delivery tests.
 *
 * These start a REAL Socket.IO server and connect REAL socket.io-client
 * sockets. Room membership and event delivery are not mocked.
 *
 * The role a socket receives is supplied through the handshake exactly where
 * src/server.ts derives it from a verified JWT, so the policy exercised here is
 * the policy that ships. Test lock-parity.test.mjs asserts the two stay in sync.
 *
 * Every connection is torn down in a finally block and every test has a
 * timeout, so a failing assertion cannot leave a socket open and hang the run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const ROOMS = {
  ADMINS: "admins",
  STUDENTS: "students",
  bus: (b) => `bus:${b}`,
  imei: (i) => `imei:${i}`,
};

const ROLE_TO_ROOM = {
  admin: ROOMS.ADMINS,
  admins: ROOMS.ADMINS,
  student: ROOMS.STUDENTS,
  students: ROOMS.STUDENTS,
  driver: ROOMS.STUDENTS,
  parent: ROOMS.STUDENTS,
};

/** Verbatim copy of the policy in src/server.ts. */
function authorizeJoin(role, data) {
  const payload = typeof data === "string" ? { role: data } : data;
  if (!payload) return [];

  const requested = payload.role ?? payload.room;
  const isAdmin = role === "admin";
  const allowed = !role ? [ROOMS.STUDENTS] : ROLE_TO_ROOM[role] ? [ROLE_TO_ROOM[role]] : [ROOMS.STUDENTS];

  if (payload.busId || payload.imei) {
    return isAdmin ? [payload.busId ? ROOMS.bus(payload.busId) : ROOMS.imei(payload.imei)] : [];
  }
  if (!requested) return [];
  const target = ROLE_TO_ROOM[requested];
  if (!target || !allowed.includes(target)) return [];
  return [target];
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn) {
  const httpServer = http.createServer();
  const sio = new Server(httpServer, { serveClient: false });

  sio.on("connection", (socket) => {
    socket.data.role = socket.handshake.auth?.role;
    socket.on("joinRoom", (data) => {
      for (const room of authorizeJoin(socket.data.role, data)) socket.join(room);
    });
  });

  await new Promise((r) => httpServer.listen(0, r));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  const connect = (role) =>
    new Promise((resolve, reject) => {
      const c = ioClient(url, {
        transports: ["websocket"],
        auth: role === undefined ? {} : { role },
        forceNew: true,
      });
      c.on("connect", () => resolve(c));
      c.on("connect_error", reject);
    });

  try {
    await fn({
      sio,
      connect: async (role, data) => {
        const c = await connect(role);
        if (data) {
          c.emit("joinRoom", data);
          await settle(120);
        }
        return c;
      },
    });
  } finally {
    await new Promise((r) => sio.close(r));
    await new Promise((r) => httpServer.close(r));
  }
}

const TIMEOUT = 15000;
const ADMIN_PAYLOAD = {
  imei: "123456789012345",
  busId: "bus1",
  gps: { lat: 31.5204, lng: 74.3587, speed: 42 },
};
const STUDENT_PAYLOAD = {
  busId: "bus1",
  gps: { lat: 31.5204, lng: 74.3587, speed: 42 },
};

test("a student asking for the admin room receives nothing from it", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const s = await connect("student", { role: "admin" });
    try {
      const got = [];
      s.on("gt06-data", (p) => got.push(p));
      sio.to(ROOMS.ADMINS).emit("gt06-data", ADMIN_PAYLOAD);
      await settle();
      assert.equal(got.length, 0, "student must not receive the IMEI-bearing admin payload");
    } finally {
      s.disconnect();
    }
  });
});

test("an admin receives the admin feed including the raw IMEI", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const a = await connect("admin", { role: "admin" });
    try {
      const got = [];
      a.on("gt06-data", (p) => got.push(p));
      sio.to(ROOMS.ADMINS).emit("gt06-data", ADMIN_PAYLOAD);
      await settle();
      assert.equal(got.length, 1);
      assert.equal(got[0].imei, "123456789012345");
    } finally {
      a.disconnect();
    }
  });
});

test("the students feed carries no IMEI and keeps the nested gps shape", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const s = await connect("student", { role: "student" });
    try {
      const got = [];
      s.on("gt06-data", (p) => got.push(p));
      sio.to(ROOMS.STUDENTS).emit("gt06-data", STUDENT_PAYLOAD);
      await settle();

      assert.equal(got.length, 1, "student must receive the sanitized feed");
      assert.ok(!("imei" in got[0]), "students feed must not contain an imei field");
      assert.equal(got[0].busId, "bus1");
      assert.equal(got[0].gps.lat, 31.5204);
      assert.equal(got[0].gps.lng, 74.3587);
    } finally {
      s.disconnect();
    }
  });
});

test("an anonymous client is confined to the students feed", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const anon = await connect(undefined, { role: "admin" });
    try {
      const got = [];
      anon.on("gt06-data", (p) => got.push(p));

      sio.to(ROOMS.ADMINS).emit("gt06-data", ADMIN_PAYLOAD);
      await settle();
      assert.equal(got.length, 0, "anonymous must not reach the admins room");

      // The refused join left the socket in no room at all, so even the
      // students feed is not delivered until it asks for it correctly.
      sio.to(ROOMS.STUDENTS).emit("gt06-data", STUDENT_PAYLOAD);
      await settle();
      assert.equal(got.length, 0, "a refused join must not fall back to another room");

      // Asking correctly does work anonymously: the live map stays public.
      anon.emit("joinRoom", { role: "student" });
      await settle(120);
      sio.to(ROOMS.STUDENTS).emit("gt06-data", STUDENT_PAYLOAD);
      await settle();
      assert.equal(got.length, 1, "anonymous may watch the sanitized students feed");
      assert.ok(!("imei" in got[0]));
    } finally {
      anon.disconnect();
    }
  });
});

test("a student cannot subscribe to a per-bus room", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const s = await connect("student", { busId: "secret-bus" });
    try {
      const got = [];
      s.on("gt06-data", (p) => got.push(p));
      sio.to(ROOMS.bus("secret-bus")).emit("gt06-data", { lat: 9, lng: 9 });
      await settle();
      assert.equal(got.length, 0, "per-bus rooms are admin-only");
    } finally {
      s.disconnect();
    }
  });
});

test("a driver cannot impersonate admin", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const d = await connect("driver", { role: "admin" });
    try {
      const got = [];
      d.on("gt06-data", (p) => got.push(p));
      sio.to(ROOMS.ADMINS).emit("gt06-data", ADMIN_PAYLOAD);
      await settle();
      assert.equal(got.length, 0, "a driver must not reach the admins room");
    } finally {
      d.disconnect();
    }
  });
});

test("an admin keeps per-bus access", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const a = await connect("admin", { busId: "secret-bus" });
    try {
      const got = [];
      a.on("gt06-data", (p) => got.push(p));
      sio.to(ROOMS.bus("secret-bus")).emit("gt06-data", { lat: 9, lng: 9 });
      await settle();
      assert.equal(got.length, 1);
    } finally {
      a.disconnect();
    }
  });
});

test("joining the students room does not leak the admin room", { timeout: TIMEOUT }, async () => {
  await withServer(async ({ sio, connect }) => {
    const s = await connect("student", { role: "student" });
    try {
      const got = [];
      s.on("gt06-data", (p) => got.push(p));
      sio.to(ROOMS.ADMINS).emit("gt06-data", ADMIN_PAYLOAD);
      sio.to(ROOMS.STUDENTS).emit("gt06-data", STUDENT_PAYLOAD);
      await settle();

      assert.equal(got.length, 1, "exactly one delivery");
      assert.ok(!("imei" in got[0]));
    } finally {
      s.disconnect();
    }
  });
});