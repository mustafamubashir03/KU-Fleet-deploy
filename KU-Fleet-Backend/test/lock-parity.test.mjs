// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Parity guards.
 *
 * redis-integration.test.mjs re-implements acquireLock() and the Socket.IO room
 * policy inline so the behavioural assertions stay independent of the database.
 * That only works while the copies match the real implementations, so these
 * checks fail loudly if production code drifts away from what is being tested.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");

const read = (p) => fs.readFileSync(path.join(dist, p), "utf8");

test("acquireLock in gpsHandler is unchanged from the version under integration test", () => {
  const src = read(path.join("services", "gpsHandler.js"));
  assert.match(src, /setnx\(key, "1"\)/, "the lock must still use SETNX");
  assert.match(src, /\.expire\(key, ttlSeconds\)/, "the lock must still set a TTL");
  assert.match(src, /res\?\.\[0\]\?\.\[1\] === 1/, "the return contract must be unchanged");
});

test("trip start is guarded by the Redis lock and re-checked", () => {
  const src = read(path.join("services", "gpsHandler.js"));
  assert.match(src, /trip:start:/, "trip creation must take a lock keyed on the bus");
  assert.match(
    src,
    /stillNoActiveTrip/,
    "the active-trip query must be repeated while holding the lock"
  );
});

test("the students feed is emitted without an imei field", () => {
  const src = read(path.join("services", "gpsHandler.js"));
  const studentsLine = src
    .split("\n")
    .find((l) => l.includes("ROOMS.STUDENTS") && l.includes("GPS_DATA"));
  assert.ok(studentsLine, "students emit must exist");
  assert.doesNotMatch(studentsLine, /imei/i, "the students emit must not reference imei");
  // Same nested shape as the admin emit so frontend handlers keep working.
  assert.match(studentsLine, /gps: coords/, "students payload must keep the nested gps field");
});

test("the admin feed still carries the IMEI", () => {
  const src = read(path.join("services", "gpsHandler.js"));
  const adminLine = src
    .split("\n")
    .find((l) => l.includes("ROOMS.ADMINS") && l.includes("GPS_DATA"));
  assert.ok(adminLine);
  assert.match(adminLine, /imei/, "admins must keep receiving the raw IMEI");
});

test("room authorization is role-derived in the server", () => {
  const src = read("server.js");
  assert.match(src, /resolveAllowedRooms/, "rooms must be derived from the authenticated role");
  // TypeScript emits namespace calls: socketHelper_1.ROOMS.ADMINS
  assert.match(
    src,
    /admin:\s*socketHelper_1\.ROOMS\.ADMINS/,
    "admin must map to the admins room"
  );
  assert.match(
    src,
    /student:\s*socketHelper_1\.ROOMS\.STUDENTS/,
    "student must map to the students room"
  );
  assert.match(
    src,
    /if \(!role\)\s*return \[socketHelper_1\.ROOMS\.STUDENTS\]/,
    "anonymous connections must be confined to the students room"
  );
  assert.doesNotMatch(
    src,
    /socket\.join\(role\)/,
    "a raw client-supplied string must never be joined as a room"
  );
});

test("User is imported by the server so roles can be resolved", () => {
  const src = read("server.js");
  assert.match(src, /models\/User\.model/, "the server needs the User model to read the role");
});

test("the frontend no longer requests the admin room from student hooks", () => {
  const frontend = path.join(here, "..", "..", "KU-Fleet-Frontend", "src");
  if (!fs.existsSync(frontend)) return; // frontend not present; nothing to check

  for (const f of ["hooks/useStudentSocket.ts", "hooks/usePassengerStoreInit.ts"]) {
    const p = path.join(frontend, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    assert.doesNotMatch(
      src,
      /joinRoom',\s*\{\s*role:\s*'admin'/,
      `${f} must not request the privileged admin room`
    );
    assert.match(src, /joinRoom',\s*\{\s*role:\s*'student'/, `${f} must request the student room`);
    assert.match(src, /auth_token/, `${f} must send the JWT in the socket handshake`);
  }
});

test("the admin socket still sends its token", () => {
  const p = path.join(here, "..", "..", "KU-Fleet-Frontend", "src", "hooks", "useSocket.ts");
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, "utf8");
  assert.match(src, /auth_token/, "useSocket must send the JWT or it loses the admins room");
});