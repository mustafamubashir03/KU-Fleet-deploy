/**
 * Access-control regressions.
 *
 * These cover confirmed defects found in the audit:
 *  - POST /api/auth/register accepted a client-supplied `role`, letting an
 *    anonymous caller self-register as admin.
 *  - joinRoom accepted any string starting with "bus:"/"imei:" and any
 *    busId/imei without authentication.
 *  - jwt.verify() in AuthMiddleware was called without pinning the algorithm.
 */
import test from "node:test";
// Hard-set test mode BEFORE requiring any compiled module, so the Redis/Mongo
// guards in src/config refuse to touch production services.
process.env.NODE_ENV = "test"; // eslint-disable-line
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const { validateRequestedRole } = require(path.join(dist, "controllers", "authController.js"));
const { adminOnly } = require(path.join(dist, "middleware", "AuthMiddleware.js"));
const { generateToken, verifyToken } = require(path.join(dist, "utils", "generateToken.js"));

// ---------------------------------------------------------------- role escalation

test("anonymous registration cannot create an admin by default", () => {
  const result = validateRequestedRole("admin", false);
  assert.equal(result.ok, false, "admin must be refused without explicit opt-in");
  assert.equal(result.status, 403);
  assert.match(result.message, /ALLOW_ADMIN_BOOTSTRAP/);
});

test("admin registration IS allowed when an operator explicitly opts in", () => {
  const result = validateRequestedRole("admin", true);
  assert.equal(result.ok, true);
  assert.equal(result.role, "admin");
});

test("non-privileged self-registration keeps working (no business behaviour change)", () => {
  for (const role of ["driver", "parent", "student"]) {
    const result = validateRequestedRole(role, false);
    assert.equal(result.ok, true, `${role} must remain registrable`);
    assert.equal(result.role, role);
  }
});

test("omitted role defaults to student, matching the User schema default", () => {
  for (const input of [undefined, null]) {
    const result = validateRequestedRole(input, false);
    assert.equal(result.ok, true);
    assert.equal(result.role, "student");
  }
});

test("unknown or non-string roles are rejected with 400 instead of reaching Mongoose", () => {
  for (const bad of ["superuser", "", "Admin", 42, {}, [], true]) {
    const result = validateRequestedRole(bad, false);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(result.status, 400);
  }
});

test("role comparison is case-sensitive so 'Admin' cannot slip through", () => {
  const result = validateRequestedRole("Admin", false);
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------------- adminOnly

test("adminOnly rejects a non-admin user", () => {
  let called = false;
  const res = {
    status(code) {
      assert.equal(code, 403);
      return this;
    },
    json() {
      return this;
    },
  };
  adminOnly({ user: { role: "student" } }, res, () => {
    called = true;
  });
  assert.equal(called, false, "next() must NOT run for a non-admin");
});

test("adminOnly allows an admin user", () => {
  let called = false;
  adminOnly({ user: { role: "admin" } }, {}, () => {
    called = true;
  });
  assert.equal(called, true, "next() must run for an admin");
});

test("adminOnly rejects a request with no authenticated user", () => {
  let called = false;
  const res = {
    status() {
      return this;
    },
    json() {
      return this;
    },
  };
  adminOnly({}, res, () => {
    called = true;
  });
  assert.equal(called, false);
});

// ------------------------------------------------------------------- JWT pinning

test("JWT is signed and verified with HS256", () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "a".repeat(48);
  try {
    const token = generateToken("507f1f77bcf86cd799439011");
    const decoded = verifyToken(token);
    assert.equal(decoded.id, "507f1f77bcf86cd799439011");

    const header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString("utf8")
    );
    assert.equal(header.alg, "HS256", "token must be signed HS256");
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test("generateToken refuses to sign without a secret", () => {
  const previous = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => generateToken("someid"), /JWT_SECRET is not configured/);
  } finally {
    if (previous !== undefined) process.env.JWT_SECRET = previous;
  }
});

test("AuthMiddleware pins the verify algorithm", () => {
  const src = fs.readFileSync(path.join(dist, "middleware", "AuthMiddleware.js"), "utf8");
  assert.match(
    src,
    /algorithms:\s*\[\s*["']HS256["']\s*\]/,
    "jwt.verify must pin algorithms:['HS256'] to avoid algorithm confusion"
  );
});

// ------------------------------------------------------- socket room static guard

test("joinRoom no longer joins arbitrary 'bus:'/'imei:' strings", () => {
  const src = fs.readFileSync(path.join(dist, "server.js"), "utf8");
  assert.doesNotMatch(
    src,
    /socket\.join\(role\)/,
    "joining a raw client-supplied room string must be gone"
  );
  assert.match(src, /ROLE_TO_ROOM/, "room requests must be mapped through an allowlist");
  assert.match(
    src,
    /allowed\.includes\(target\)/,
    "a join must be intersected with the rooms this connection may enter"
  );
});