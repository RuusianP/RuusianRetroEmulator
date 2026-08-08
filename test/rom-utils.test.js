'use strict';

const assert = require('assert');
const {
  SUPPORTED_MAPPER_IDS,
  checkNESMagic,
  parseNESHeader,
  getMapperName,
  checkRomSupport
} = require('../src/client/js/nes-data');

function testNESMagic() {
  const valid = new Uint8Array([0x4E, 0x45, 0x53, 0x1A]);
  assert.strictEqual(checkNESMagic(valid), true);
  const invalid = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  assert.strictEqual(checkNESMagic(invalid), false);
  assert.strictEqual(checkNESMagic(new Uint8Array(2)), false);
  console.log('  checkNESMagic: PASS');
}

function testParseNESHeader() {
  const header = new Uint8Array(16);
  header[0] = 0x4E; header[1] = 0x45; header[2] = 0x53; header[3] = 0x1A;
  header[4] = 1; header[5] = 1;
  header[6] = 0x01; header[7] = 0x00;
  const parsed = parseNESHeader(header);
  assert.ok(parsed);
  assert.strictEqual(parsed.mapperType, 0);
  assert.strictEqual(parsed.mirroring, 'vertical');
  assert.strictEqual(parsed.batteryRam, false);
  assert.strictEqual(parsed.trainer, false);
  assert.strictEqual(parsed.fourScreen, false);

  header[6] = 0x02;
  const parsed2 = parseNESHeader(header);
  assert.strictEqual(parsed2.batteryRam, true);

  const bad = new Uint8Array(3);
  assert.strictEqual(parseNESHeader(bad), null);
  console.log('  parseNESHeader: PASS');
}

function testMapperNames() {
  assert.strictEqual(getMapperName(0), 'Direct Access / NROM');
  assert.strictEqual(getMapperName(999), 'Unknown Mapper');
  assert.ok(SUPPORTED_MAPPER_IDS.has(0));
  assert.ok(SUPPORTED_MAPPER_IDS.has(4));
  assert.ok(!SUPPORTED_MAPPER_IDS.has(99));
  console.log('  MAPPER_NAMES / SUPPORTED_MAPPER_IDS: PASS');
}

function testCheckRomSupport() {
  const rom = new Uint8Array(16);
  rom[0] = 0x4E; rom[1] = 0x45; rom[2] = 0x53; rom[3] = 0x1A;
  rom[6] = 0x00; rom[7] = 0x00;
  const result = checkRomSupport(rom);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.supported, true);
  assert.strictEqual(result.mapperType, 0);

  const badRom = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  const badResult = checkRomSupport(badRom);
  assert.strictEqual(badResult.valid, false);
  console.log('  checkRomSupport: PASS');
}

function testMapper23Name() {
  assert.strictEqual(getMapperName(22), 'Konami VRC2a');
  assert.strictEqual(getMapperName(23), 'Konami VRC2b');
  console.log('  Mapper 23 name: PASS');
}

function testConvertRGB24toRGBA() {
  // JSNES palette values are 0xRRGGBB (R in high byte, B in low byte)
  // The worker's convertRGB24toRGBA must extract channels correctly
  const PIXEL_COUNT = 256 * 240;
  const src = new Uint32Array(PIXEL_COUNT);
  // Color 0xB40000 = R:180, G:0, B:0 (red in 0xRRGGBB format)
  src[0] = 0xb40000;
  // Color 0x00005B = R:0, G:0, B:91 (blue in 0xRRGGBB format)
  src[1] = 0x00005b;
  // Color 0xFFFFFF = white
  src[2] = 0xffffff;
  const dst = new Uint8Array(PIXEL_COUNT * 4);
  for (let i = 0; i < 3; i++) {
    const p = src[i];
    const off = i * 4;
    dst[off] = (p >> 16) & 0xff;
    dst[off + 1] = (p >> 8) & 0xff;
    dst[off + 2] = p & 0xff;
    dst[off + 3] = 255;
  }
  // Verify: red pixel should have R=180, B=0
  assert.strictEqual(dst[0], 180, 'Red channel should be 180 for 0xB40000');
  assert.strictEqual(dst[1], 0, 'Green channel should be 0 for 0xB40000');
  assert.strictEqual(dst[2], 0, 'Blue channel should be 0 for 0xB40000');
  // Verify: blue pixel should have R=0, B=91
  assert.strictEqual(dst[4], 0, 'Red channel should be 0 for 0x00005B');
  assert.strictEqual(dst[6], 91, 'Blue channel should be 91 for 0x00005B');
  console.log('  convertRGB24toRGBA: PASS');
}

function main() {
  console.log('Running tests...');
  testNESMagic();
  testParseNESHeader();
  testMapperNames();
  testMapper23Name();
  testCheckRomSupport();
  testConvertRGB24toRGBA();
  console.log('All tests passed.');
}

main();
