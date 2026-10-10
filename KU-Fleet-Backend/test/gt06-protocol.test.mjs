// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * GT06 protocol behaviour against the REAL vendored parser (gt06@1.0.12).
 *
 * Every fixture is a captured packet taken from the parser's own published test
 * vectors (see ./fixtures/gt06-packets.mjs), together with the expected results
 * that file asserts. Nothing here is invented.
 *
 * This proves the parser and the ACK contract. It does NOT prove a physical
 * tracker is reachable or configured correctly - that needs real hardware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  LOGIN_HEX,
  STATUS_HEX,
  LOCATION_HEX,
  TIME_HEX,
  TIME2_HEX,
  UNKNOWN_HEADER_HEX,
  EXPECTED,
  asBuffer,
} from "./fixtures/gt06-packets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "..", "dist");

const Gt06 = require("gt06");
const { extractCompleteFrames } = require(path.join(dist, "tcp", "gt06Framing.js"));

const LOGIN = asBuffer(LOGIN_HEX);
const STATUS = asBuffer(STATUS_HEX);
const LOCATION = asBuffer(LOCATION_HEX);

// --------------------------------------------------------------- wire format

test("IMEI is hex-packed on the wire, not ASCII and not BCD", () => {
  const imeiBytes = LOGIN.subarray(4, 12);
  assert.equal(imeiBytes.toString("hex"), "0123456789012345");

  // ASCII would be 0x30-0x39 for the digit characters.
  assert.ok(
    !/^[\x30-\x39]+$/.test(imeiBytes.toString("latin1")),
    "must not be ASCII digits"
  );
  // BCD would put each digit in its own nibble (0x00-0x09 per digit).
  assert.ok(
    [...imeiBytes].some((b) => b > 0x09),
    "must not be BCD nibbles"
  );
  // Two decimal digits per byte is the actual encoding.
  assert.equal(imeiBytes.toString("hex").length, 16, "16 hex chars = 8 bytes");
  assert.equal(parseInt(imeiBytes.toString("hex"), 10), EXPECTED.loginImei);
});

test("the published login expectation is reproduced exactly", () => {
  const gt06 = new Gt06();
  gt06.parse(LOGIN);

  assert.equal(gt06.event.number, 1);
  assert.equal(gt06.event.string, "login");
  assert.equal(gt06.imei, EXPECTED.loginImei);
  assert.ok(gt06.msgBuffer.length >= 1);
  assert.equal(String(gt06.msgBuffer[0].imei), EXPECTED.loginImeiString);
});

test("String(imei) matches the 15-digit identifier used for Bus.trackerIMEI", () => {
  // getBusIdForIMEI() does String(msg.imei) and then queries
  // Bus.findOne({ trackerIMEI: <that string> }), so this is the exact value the
  // database is compared against.
  const gt06 = new Gt06();
  gt06.parse(LOGIN);
  assert.equal(String(gt06.imei), EXPECTED.loginImeiString);
  assert.equal(String(gt06.imei).length, 15);
});

// ----------------------------------------------------------------------- ACKs

test("login ACK bytes match the published expectation", () => {
  const gt06 = new Gt06();
  gt06.parse(LOGIN);

  assert.equal(gt06.expectsResponse, true, "login must be acknowledged");
  assert.ok(Buffer.isBuffer(gt06.responseMsg), "ACK must be binary");
  assert.equal(gt06.responseMsg.toString("hex"), EXPECTED.loginAckHex);
});

test("status ACK bytes match the published expectation", () => {
  const gt06 = new Gt06();
  gt06.parse(STATUS);

  assert.equal(gt06.expectsResponse, true, "status must be acknowledged");
  assert.equal(gt06.responseMsg.toString("hex"), EXPECTED.statusAckHex);
  assert.equal(gt06.terminalInfo.alarmType, EXPECTED.statusAlarmType);
  assert.equal(gt06.gsmSigStrength, EXPECTED.statusGsmSigStrength);
});

test("location packets are NOT acknowledged", () => {
  const gt06 = new Gt06();
  gt06.parse(LOCATION);

  assert.equal(gt06.expectsResponse, false);
  assert.ok(!gt06.responseMsg, "no ACK for location packets");
  assert.equal(gt06.lat, EXPECTED.locationLat);
  assert.equal(gt06.lon, EXPECTED.locationLon);
  assert.equal(gt06.speed, EXPECTED.locationSpeed);
});

// -------------------------------------------------------------- login -> IMEI

test("IMEI from login carries over to subsequent location packets", () => {
  // This is the sequence a real tracker produces, and the reason a bus can be
  // resolved on a location message that carries no IMEI of its own.
  const gt06 = new Gt06();
  gt06.parse(LOGIN);
  gt06.clearMsgBuffer();
  gt06.parse(LOCATION);

  assert.equal(String(gt06.imei), EXPECTED.loginImeiString, "IMEI persists on the instance");
  const withImei = gt06.msgBuffer.find((m) => m.imei !== undefined && m.imei !== null);
  assert.ok(withImei, "location message must carry the stored IMEI");
  assert.equal(String(withImei.imei), EXPECTED.loginImeiString);
});

// ------------------------------------------------------------- framing / flow

test("two real location frames in one TCP chunk are both delivered", () => {
  const { frames } = extractCompleteFrames(asBuffer(LOCATION_HEX + LOCATION_HEX));
  assert.equal(frames.length, 2);

  const gt06 = new Gt06();
  let count = 0;
  for (const f of frames) {
    gt06.parse(f);
    count += gt06.msgBuffer.length;
    gt06.clearMsgBuffer();
  }
  assert.equal(count, 2, "both frames must reach the handler");
});

test("a login, a location and a status in one stream parse in order", () => {
  const stream = asBuffer(LOGIN_HEX + LOCATION_HEX + STATUS_HEX);
  const { frames, rest } = extractCompleteFrames(stream);
  assert.equal(frames.length, 3);
  assert.equal(rest.length, 0);

  const seen = [];
  for (const f of frames) {
    const gt06 = new Gt06();
    gt06.parse(f);
    seen.push(gt06.event.string);
  }
  assert.deepEqual(seen, ["login", "location", "status"]);
});

test("a real packet split at every byte boundary is reassembled intact", () => {
  const packet = asBuffer(LOCATION_HEX);
  for (let cut = 1; cut < packet.length; cut++) {
    let pending = Buffer.alloc(0);
    const emitted = [];
    for (const chunk of [packet.subarray(0, cut), packet.subarray(cut)]) {
      pending = Buffer.concat([pending, chunk]);
      const r = extractCompleteFrames(pending);
      pending = r.rest;
      emitted.push(...r.frames);
    }
    assert.equal(emitted.length, 1, `split at ${cut}`);
    assert.equal(emitted[0].toString("hex"), LOCATION_HEX, `split at ${cut} payload`);
  }
});

// ----------------------------------------------------------------- error paths

test("an unknown header is rejected with the parser's own error object", () => {
  const gt06 = new Gt06();
  assert.throws(
    () => gt06.parse(asBuffer(UNKNOWN_HEADER_HEX)),
    (thrown) => thrown && thrown.error === "unknown message header"
  );
});

test("a malformed frame does not stop the next valid frame", () => {
  // Mirrors the loop in src/tcp/tcpServer.ts.
  const inputs = [asBuffer("7878"), LOGIN];
  let errors = 0;
  let oks = 0;
  for (const buf of inputs) {
    const gt06 = new Gt06();
    try {
      gt06.parse(buf);
      oks++;
    } catch {
      errors++;
    } finally {
      gt06.clearMsgBuffer();
    }
  }
  assert.equal(errors, 1, "the truncated frame must fail");
  assert.equal(oks, 1, "the valid frame must still parse");
});

test("timestamps parse to the expected instants", () => {
  const a = new Gt06();
  a.parse(asBuffer(TIME_HEX));
  assert.equal(new Date(a.fixTimestamp * 1000).toISOString(), "2019-05-29T13:37:06.000Z");

  const b = new Gt06();
  b.parse(asBuffer(TIME2_HEX));
  assert.equal(new Date(b.fixTimestamp * 1000).toISOString(), "2019-12-20T08:07:35.000Z");
});