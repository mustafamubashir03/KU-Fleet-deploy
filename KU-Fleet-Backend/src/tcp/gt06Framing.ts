// src/tcp/gt06Framing.ts
/**
 * GT06 frame boundary detection.
 *
 * Extracted from tcpServer.ts so the reassembly logic can be unit-tested without
 * importing Redis, MongoDB or opening a socket.
 */

/**
 * GT06 frame markers, verified against the vendored parser
 * (node_modules/gt06/gt06.js):
 *   - checkHeader()   requires the first two bytes to be 0x78 0x78 ("7878")
 *   - createResponse() appends 0x0d 0x0a as the frame terminator
 */
export const FRAME_START = Buffer.from([0x78, 0x78]);
export const FRAME_END = Buffer.from([0x0d, 0x0a]);

/** Guard against a peer that never sends a terminator. */
export const MAX_BUFFERED_BYTES = 64 * 1024;

/**
 * Returns every complete frame currently buffered and retains any trailing
 * partial frame for the next chunk.
 *
 * This reassembly is REQUIRED, not an optimisation. `Gt06.prototype.parse`
 * resets its internal `msgBufferRaw` on every call (gt06.js line 12) and
 * `checkHeader` only inspects `data.slice(0, 2)`, so parse() must be handed
 * exactly one COMPLETE frame. TCP is a byte stream with no message boundaries,
 * so a frame can arrive split across chunks, or several frames can arrive in
 * one chunk. Feeding raw chunks straight to parse() corrupts split frames and
 * the tracker never receives its ACK, so it retransmits indefinitely.
 */
export function extractCompleteFrames(buffer: Buffer): {
  frames: Buffer[];
  rest: Buffer;
} {
  const frames: Buffer[] = [];
  let rest = buffer;

  while (rest.length >= FRAME_START.length + FRAME_END.length) {
    const start = rest.indexOf(FRAME_START);
    if (start === -1) {
      // No frame start anywhere in what we hold: drop it and resynchronise.
      rest = Buffer.alloc(0);
      break;
    }

    // Discard leading noise before a valid header.
    if (start > 0) {
      rest = rest.subarray(start);
    }

    const end = rest.indexOf(FRAME_END, FRAME_START.length);
    if (end === -1) {
      // Incomplete frame: keep it until the remainder arrives.
      break;
    }

    const frameEnd = end + FRAME_END.length;
    frames.push(Buffer.from(rest.subarray(0, frameEnd)));
    rest = rest.subarray(frameEnd);
  }

  return { frames, rest };
}