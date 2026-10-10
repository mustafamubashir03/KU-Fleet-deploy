/**
 * GT06 frame boundary handling.
 *
 * Tests src/tcp/gt06Framing.ts, the reassembly buffer introduced because
 * `Gt06.prototype.parse` resets its internal buffer on every call and only
 * inspects the first two bytes of whatever it is given.
 *
 * Pure logic - no database, Redis or socket required.
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
const dist = path.join(here, "..", "dist", "tcp", "gt06Framing.js");

if (!(await import("node:fs")).existsSync(dist)) {
  throw new Error(`Build output missing: ${dist}. Run "npm run build" first.`);
}

const { extractCompleteFrames, MAX_BUFFERED_BYTES, FRAME_START, FRAME_END } = require(dist);

// Real captured packets from the parser's published test vectors.
// See ./fixtures/gt06-packets.mjs - these are NOT synthetic frames.
import { LOGIN_HEX, LOCATION_HEX, STATUS_HEX, asBuffer } from "./fixtures/gt06-packets.mjs";

const LOGIN = asBuffer(LOGIN_HEX);
const LOCATION = asBuffer(LOCATION_HEX);
const STATUS = asBuffer(STATUS_HEX);

test("markers match the vendored parser constants", () => {
  assert.equal(FRAME_START.toString("hex"), "7878", "start marker must be 7878");
  assert.equal(FRAME_END.toString("hex"), "0d0a", "terminator must be 0d0a");
});

test("a single complete frame in one chunk yields exactly one frame and no residue", () => {
  const { frames, rest } = extractCompleteFrames(LOGIN);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].toString("hex"), LOGIN.toString("hex"));
  assert.equal(rest.length, 0);
});

test("two frames arriving in one TCP chunk are split into two", () => {
  const both = Buffer.concat([LOGIN, LOCATION]);
  const { frames, rest } = extractCompleteFrames(both);
  assert.equal(frames.length, 2, "multiple frames in one chunk must both be extracted");
  assert.equal(frames[0].toString("hex"), LOGIN.toString("hex"));
  assert.equal(frames[1].toString("hex"), LOCATION.toString("hex"));
  assert.equal(rest.length, 0);
});

test("a frame split across chunks is reassembled, not emitted twice or dropped", () => {
  const splitAt = 3; // inside the header - the worst case
  const first = LOGIN.subarray(0, splitAt);
  const second = LOGIN.subarray(splitAt);

  const r1 = extractCompleteFrames(first);
  assert.equal(r1.frames.length, 0, "a partial frame must NOT be parsed");
  assert.equal(r1.rest.length, splitAt, "partial bytes must be retained");

  const r2 = extractCompleteFrames(Buffer.concat([r1.rest, second]));
  assert.equal(r2.frames.length, 1, "the completed frame must be emitted once");
  assert.equal(r2.frames[0].toString("hex"), LOGIN.toString("hex"));
  assert.equal(r2.rest.length, 0);
});

test("byte-at-a-time delivery still yields exactly one frame", () => {
  let pending = Buffer.alloc(0);
  const emitted = [];
  for (const byte of LOGIN) {
    pending = Buffer.concat([pending, Buffer.from([byte])]);
    const r = extractCompleteFrames(pending);
    pending = r.rest;
    emitted.push(...r.frames);
  }
  assert.equal(emitted.length, 1, "must emit exactly one frame");
  assert.equal(emitted[0].toString("hex"), LOGIN.toString("hex"));
  assert.equal(pending.length, 0);
});

test("leading garbage before a header is discarded, not treated as a frame", () => {
  const noisy = Buffer.concat([Buffer.from("deadbeef", "hex"), LOGIN]);
  const { frames, rest } = extractCompleteFrames(noisy);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].toString("hex"), LOGIN.toString("hex"));
  assert.equal(rest.length, 0);
});

test("a frame with no terminator is retained until the terminator arrives", () => {
  const noEnd = LOGIN.subarray(0, LOGIN.length - 2);
  const { frames, rest } = extractCompleteFrames(noEnd);
  assert.equal(frames.length, 0);
  assert.equal(rest.length, noEnd.length);

  const r2 = extractCompleteFrames(Buffer.concat([rest, Buffer.from([0x0d, 0x0a])]));
  assert.equal(r2.frames.length, 1);
  assert.equal(r2.frames[0].toString("hex"), LOGIN.toString("hex"));
});

test("buffer with no header at all is dropped so the parser can resynchronise", () => {
  const junk = Buffer.alloc(4096, 0x41);
  const { frames, rest } = extractCompleteFrames(junk);
  assert.equal(frames.length, 0);
  assert.equal(rest.length, 0);
});

test("frames delivered in order but split at arbitrary boundaries all survive", () => {
  // A TCP stream is ordered, so frame1's tail ALWAYS precedes frame2. Splitting
  // the concatenated stream at every byte offset must still yield both frames.
  const stream = Buffer.concat([LOGIN, LOCATION]);
  for (let cut = 1; cut < stream.length; cut++) {
    let pending = Buffer.alloc(0);
    const emitted = [];
    for (const chunk of [stream.subarray(0, cut), stream.subarray(cut)]) {
      pending = Buffer.concat([pending, chunk]);
      const r = extractCompleteFrames(pending);
      pending = r.rest;
      emitted.push(...r.frames);
    }
    assert.equal(
      emitted.length,
      2,
      `split at ${cut}: expected 2 frames, got ${emitted.length}`
    );
    assert.equal(emitted[0].toString("hex"), LOGIN.toString("hex"));
    assert.equal(emitted[1].toString("hex"), LOCATION.toString("hex"));
    assert.equal(pending.length, 0, `split at ${cut}: residue must be empty`);
  }
});

test("MAX_BUFFERED_BYTES is a sane, bounded guard", () => {
  assert.ok(MAX_BUFFERED_BYTES > 1024, "limit must allow a real tracker packet");
  assert.ok(MAX_BUFFERED_BYTES <= 1024 * 1024, "limit must stay small");
});