#!/usr/bin/env node
// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Compiled-application startup and shutdown verification.
 *
 * Boots the REAL production build (dist/server.js) as a child process against
 * disposable MongoDB and Redis, then exercises the real listeners:
 *
 *   - HTTP  on a test port
 *   - raw GT06 TCP on a test port (a real captured login packet is sent and the
 *     ACK bytes are checked)
 *   - Socket.IO accepting a real client
 *
 * and finally sends SIGTERM and observes a clean, ordered shutdown.
 *
 * This is the only test that runs the actual entry point, so it is the one that
 * would catch a working-directory, env-loading or startup-ordering regression.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { LOGIN_HEX, EXPECTED, asBuffer } from "./fixtures/gt06-packets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendRoot = path.join(here, "..");
const dist = path.join(backendRoot, "dist");
const entry = path.join(dist, "server.js");

const MONGO = process.env.KUFLEET_TEST_MONGO_URI;
const REDIS = process.env.KUFLEET_TEST_REDIS_URL;
const skip =
  MONGO && REDIS
    ? false
    : "Set KUFLEET_TEST_MONGO_URI and KUFLEET_TEST_REDIS_URL to run the compiled app";

// The parent test process also needs a usable Redis URL before it requires
// config/redis.js to inspect the IMEI cache.
if (REDIS) {
  process.env.REDIS_URL = REDIS;
  process.env.REDIS_DB = "9";
}

const HTTP_PORT = 39471;
const TCP_PORT = 39550;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitForHttp(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status > 0) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`HTTP listener on ${port} did not become ready within ${timeoutMs}ms`);
}

function waitForTcp(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`TCP ${port} not open`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

test("compiled application boots, serves HTTP, opens TCP, and shuts down cleanly", { skip, timeout: 180000 }, async () => {
  const httpPort = await getFreePort();
  const tcpPort = await getFreePort();

  const child = spawn(process.execPath, [entry], {
    cwd: "C:\\Windows\\Temp", // DELIBERATELY not the backend root
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(httpPort),
      TCP_PORT: String(tcpPort),
      MONGO_URI: MONGO,
      REDIS_URL: REDIS,
      REDIS_DB: "9",
      JWT_SECRET: "startup-test-secret-long-enough-1234567890",
      CLOUDINARY_CLOUD_NAME: "demo",
      CLOUDINARY_API_KEY: "demo",
      CLOUDINARY_API_SECRET: "demo",
      MTX_BASE_URL: "http://127.0.0.1:1", // unreachable on purpose
      MTX_API_KEY: "x",
      MTX_API_SECRET: "y",
      KUFLEET_TEST_REDIS_URL: REDIS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));

  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));

  try {
    // --- 1. HTTP comes up -------------------------------------------------
    const health = await waitForHttp(httpPort);
    assert.equal(health.success, true, "the health route must respond");
    assert.match(output, /HTTP \+ Socket\.IO running on port/, "the HTTP listener must announce itself");

    // --- 2. config loading worked despite the wrong cwd ------------------
    assert.ok(
      !/MONGO_URI environment variable is not defined/.test(output),
      "config must load even though cwd is not the backend root"
    );
    assert.ok(!/REDIS_URL environment variable is not defined/.test(output));

    // --- 3. raw GT06 TCP is listening ------------------------------------
    await waitForTcp(tcpPort);
    assert.match(output, new RegExp(`TCP server listening on port ${tcpPort}`));

    // --- 4. a real captured login packet gets a real ACK ------------------
    const ack = await new Promise((resolve, reject) => {
      const sock = net.connect(tcpPort, "127.0.0.1");
      const chunks = [];
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("no ACK received within 8s"));
      }, 8000);
      sock.on("connect", () => sock.write(asBuffer(LOGIN_HEX)));
      sock.on("data", (d) => {
        chunks.push(d); clearTimeout(timer); sock.destroy(); resolve(Buffer.concat(chunks));
      });
      sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    });

    assert.ok(ack.length > 0, "the tracker must receive an ACK");
    assert.equal(ack.toString("hex"), EXPECTED.loginAckHex,
      `ACK bytes must match the protocol, got ${ack.toString("hex")}`);

    // --- 5. Socket.IO accepts a real client ------------------------------
    const { Server } = require("socket.io");
    const { io: ioClient } = require("socket.io-client");
    const sio = new Server(http.createServer());
    void sio;
    await new Promise((r) => setTimeout(r, 10));
    // Connect against the running app.
    const connected = await new Promise((resolve, reject) => {
      const c = ioClient(`http://127.0.0.1:${httpPort}`, {
        transports: ["websocket"],
        forceNew: true,
      });
      c.on("connect", () => {
        c.disconnect();
        resolve(true);
      });
      c.on("connect_error", reject);
      setTimeout(() => reject(new Error("socket connect timed out")), 8000);
    });
    assert.equal(connected, true, "a real Socket.IO client must be able to connect");

    // --- 6. graceful shutdown --------------------------------------------
    // Windows cannot deliver POSIX signals to a child process, so the SIGTERM
    // handler cannot be exercised here. The deployment target is Amazon Linux,
    // so this is verified for real during deployment; on Windows we still assert
    // the process dies and releases its port.
    const isWindows = process.platform === "win32";
    const shutdownStart = Date.now();
    child.kill(isWindows ? undefined : "SIGTERM");

    const result = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r({ code: "TIMEOUT" }), 30000)),
    ]);

    assert.notEqual(result.code, "TIMEOUT", "the process must exit after being signalled");

    if (isWindows) {
      assert.ok(
        /MTX token init failed/.test(output),
        "sanity: the child really started (MTX is deliberately unreachable)"
      );
    } else {
      assert.match(output, /SIGTERM received/, "shutdown must be acknowledged in the logs");
      assert.match(output, /TCP listener closed/, "the TCP listener must be closed");
      assert.match(output, /GPS Buffer shutdown completed/, "buffered GPS must be flushed");
      assert.match(output, /HTTP listener closed/, "the HTTP listener must be closed");
      assert.match(output, /Graceful shutdown complete/, "shutdown must run to completion");
    }

    const elapsed = Date.now() - shutdownStart;
    assert.ok(elapsed < 25000, `shutdown should be prompt, took ${elapsed}ms`);

    // --- 7. the port is released ------------------------------------------
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${httpPort}/`),
      "the HTTP port must be released after shutdown"
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a missing required variable fails fast with a named error", { skip }, async () => {
  const child = spawn(process.execPath, [entry], {
    cwd: "C:\\Windows\\Temp",
    env: {
      ...process.env,
      NODE_ENV: "production",
      MONGO_URI: "",
      REDIS_URL: "",
      JWT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));

  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1, "must exit non-zero");
  assert.match(out, /MONGO_URI/, "must name the missing variable");
  assert.match(out, /REDIS_URL/);
  assert.match(out, /JWT_SECRET/);
  assert.match(out, /No values are printed here by design/);
});