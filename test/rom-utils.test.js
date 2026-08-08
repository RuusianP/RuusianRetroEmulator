'use strict';

const assert = require('assert');
const {
  SUPPORTED_MAPPER_IDS,
  MAPPER_NAMES,
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

function main() {
  console.log('Running tests...');
  testNESMagic();
  testParseNESHeader();
  testMapperNames();
  testCheckRomSupport();
  console.log('All tests passed.');
}

main();
