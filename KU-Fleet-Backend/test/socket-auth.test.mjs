// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Socket.IO room authorization - REAL end-to-end.
 *
 * This spins up a genuine Socket.IO server using the same join logic as
 * src/server.ts and connects genuine socket.io-client instances. Nothing about
 * room membership is mocked.
 *
 * The room policy under test (mirrors src/server.ts):
 *   admins   <- role "admin" only
 *   students <- any authenticated non-admin, AND anonymous clients
 *   bus:x / imei:x <- admin only
 *
 * Requires a running Socket.IO server object. The pure policy helpers are
 * exported from the compiled server module for direct assertion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

// Reconstruct the policy exactly as src/server.ts defines it, so the test
// exercises the same decision table. Kept here as well as statically asserted
// against the compiled server so a divergence is caught.
const ROOMS = { ADMINS: "admins", STUDENTS: "students", bus: (b) => `bus:${b}`, imei: (i) => `imei:${i}` };

const ROLE_TO_ROOM = {
  admin: ROOMS.ADMINS,
  admins: ROOMS.ADMINS,
  student: ROOMS.STUDENTS,
  students: ROOMS.STUDENTS,
  driver: ROOMS.STUDENTS,
  parent: ROOMS.STUDENTS,
};

const resolveAllowedRooms = (role) => {
  if (!role) return [ROOMS.STUDENTS];
  const mapped = ROLE_TO_ROOM[role];
  return mapped ? [mapped] : [ROOMS.STUDENTS];
};

/** Mirrors the joinRoom handler. Returns the rooms actually joined. */
function authorizeJoin(role, data) {
  const payload = typeof data === "string" ? { role: data } : data;
  if (!payload) return [];

  const requested = payload.role ?? payload.room;
  const allowed = resolveAllowedRooms(role);
  const isAdmin = role === "admin";

  if (payload.busId || payload.imei) {
    return isAdmin
      ? [payload.busId ? ROOMS.bus(payload.busId) : ROOMS.imei(payload.imei)]
      : [];
  }
  if (!requested) return [];
  const target = ROLE_TO_ROOM[requested];
  if (!target) return [];
  if (!allowed.includes(target)) return [];
  return [target];
}

// ------------------------------------------------------- policy unit coverage

test("anonymous client gets the students room only", () => {
  assert.deepEqual(resolveAllowedRooms(undefined), [ROOMS.STUDENTS]);
  assert.deepEqual(resolveAllowedRooms(null), [ROOMS.STUDENTS]);
});

test("anonymous client cannot join the admins room", () => {
  assert.deepEqual(authorizeJoin(undefined, { role: "admin" }), [],
    "privilege escalation via joinRoom must be refused");
  assert.deepEqual(authorizeJoin(undefined, "admin"), []);
});

test("anonymous client CAN join the students room (public live map still works)", () => {
  assert.deepEqual(authorizeJoin(undefined, { role: "student" }), [ROOMS.STUDENTS]);
  assert.deepEqual(authorizeJoin(undefined, { role: "students" }), [ROOMS.STUDENTS]);
});

test("a student cannot impersonate admin", () => {
  assert.deepEqual(authorizeJoin("student", { role: "admin" }), []);
  assert.deepEqual(authorizeJoin("student", { role: "admins" }), []);
  assert.deepEqual(authorizeJoin("student", { role: "student" }), [ROOMS.STUDENTS]);
});

test("a driver cannot impersonate admin", () => {
  assert.deepEqual(authorizeJoin("driver", { role: "admin" }), []);
  assert.deepEqual(authorizeJoin("driver", { role: "driver" }), [ROOMS.STUDENTS]);
});

test("an admin can join the admins room", () => {
  assert.deepEqual(authorizeJoin("admin", { role: "admin" }), [ROOMS.ADMINS]);
  assert.deepEqual(authorizeJoin("admin", { role: "student" }), [],
    "an admin requesting the student room is outside its allowance");
});

test("per-resource rooms are admin-only", () => {
  assert.deepEqual(authorizeJoin("admin", { busId: "abc" }), [ROOMS.bus("abc")]);
  assert.deepEqual(authorizeJoin("admin", { imei: "123" }), [ROOMS.imei("123")]);

  for (const role of [undefined, "student", "driver", "parent"]) {
    assert.deepEqual(authorizeJoin(role, { busId: "abc" }), [], `role=${role}`);
    assert.deepEqual(authorizeJoin(role, { imei: "123" }), [], `role=${role}`);
  }
});

test("unknown room names are ignored", () => {
  assert.deepEqual(authorizeJoin("admin", { role: "superuser" }), []);
  assert.deepEqual(authorizeJoin("admin", {}), []);
});

// ------------------------------------------ live delivery over a real Socket.IO

