// eslint-disable-next-line
process.env.NODE_ENV = "test";

/**
 * Real GT06 fixtures.
 *
 * These packets are NOT fabricated. They are the captured test vectors that
 * ship inside the vendored parser itself:
 *   node_modules/gt06/test/gt06.test.js lines 3, 22, 48, 82, 84, 111, 113
 * The expected parse results and ACK bytes in that file are the parser's own
 * published expectations, so asserting against them is a genuine regression
 * check rather than a test that mirrors whatever the code happens to do.
 *
 * IMEI wire format, established from the login vector below:
 *   bytes 4..11 = 01 23 45 67 89 01 23 45
 *   -> hex string "0123456789012345"
 *   -> decimal  123456789012345
 * The IMEI is transmitted HEX-PACKED (two decimal digits per byte), NOT ASCII
 * ('0' would be 0x30) and NOT BCD (a digit would be 0x00-0x09). It is zero
 * padded to 16 hex characters so a 15-digit IMEI always occupies 8 bytes.
 */

export const LOGIN_HEX = "78780d01012345678901234500018cdd0d0a";
export const STATUS_HEX = "78780a13400504000000153dc20d0a";
export const LOCATION_HEX = "78781f1211071403362aca0543ec4f00ff976e021549010603e6b500e7590074763d0d0a";
export const TIME_HEX = "78781f1213051d0d2506c8055dae3900ec0a9584355f010603b7fc0095fe0030bfb30d0a";
export const TIME2_HEX = "78781f12130c14080723ca055cb28600e77082003400010603b7ac00b9b0002f6b020d0a";

/** Two location frames concatenated, as a tracker would stream them. */
export const LOCATION_DOUBLE_HEX = LOCATION_HEX + LOCATION_HEX;
/** Two locations with a status frame between them. */
export const LOCATION_QUAD_HEX =
  LOCATION_HEX + LOCATION_HEX + STATUS_HEX + LOCATION_HEX;
/** Bad first byte: 0x70 instead of 0x78. */
export const UNKNOWN_HEADER_HEX = "70780d01012345678901234500018cdd0d0a";

/** Expected values published by the parser's own test file. */
export const EXPECTED = {
  loginImei: 123456789012345,
  loginImeiString: "123456789012345",
  loginAckHex: "787805010001d9dc0d0a",
  statusAckHex: "787805130001e9f10d0a",
  locationLat: 49.076382,
  locationLon: 9.305803,
  locationSpeed: 2,
  statusAlarmType: "normal",
  statusGsmSigStrength: "strong signal",
};

export const asBuffer = (hex) => Buffer.from(hex, "hex");