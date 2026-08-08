(function() {
  var SUPPORTED_MAPPER_IDS = new Set([0,1,2,3,4,5,6,7,8,9,10,11,12,15,16,17,18,19,20,21,22,23,24,25,32,33,34,64,65,66,67,68,69,71,78,91]);
  var MAPPER_NAMES = {
    0: 'Direct Access / NROM',
    1: 'Nintendo MMC1',
    2: 'UNROM',
    3: 'CNROM',
    4: 'Nintendo MMC3',
    5: 'Nintendo MMC5',
    6: 'FFE F4xxx',
    7: 'AOROM',
    8: 'FFE F3xxx',
    9: 'Nintendo MMC2',
    10: 'Nintendo MMC4',
    11: 'Color Dreams Chip',
    12: 'FFE F6xxx',
    15: '100-in-1 switch',
    16: 'Bandai chip',
    17: 'FFE F8xxx',
    18: 'Jaleco SS8806 chip',
    19: 'Namcot 106 chip',
    20: 'Famicom Disk System',
    21: 'Konami VRC4a',
    22: 'Konami VRC2a',
    23: 'Konami VRC2b',
    24: 'Konami VRC6',
    25: 'Konami VRC4b',
    32: 'Irem G-101 chip',
    33: 'Taito TC0190/TC0350',
    34: '32kB ROM switch',
    64: 'Tengen RAMBO-1 chip',
    65: 'Irem H-3001 chip',
    66: 'GNROM switch',
    67: 'SunSoft3 chip',
    68: 'SunSoft4 chip',
    69: 'SunSoft5 FME-7 chip',
    71: 'Camerica chip',
    78: 'Irem 74HC161/32-based',
    91: 'Pirate HK-SF3 chip'
  };

  function checkNESMagic(bytes) {
     return bytes.length >= 4 && bytes[0] === 0x4E && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1A;
  }

  function parseNESHeader(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!checkNESMagic(bytes) || bytes.length < 16) return null;
    return {
      mapperType: (bytes[6] >> 4) | (bytes[7] & 0xF0),
      mirroring: bytes[6] & 0x01 ? 'vertical' : 'horizontal',
      batteryRam: !!(bytes[6] & 0x02),
      trainer: !!(bytes[6] & 0x04),
      fourScreen: !!(bytes[6] & 0x08)
    };
  }

  function getMapperName(mapperType) {
    return MAPPER_NAMES[mapperType] || 'Unknown Mapper';
  }

  function checkRomSupport(buffer) {
    var header = parseNESHeader(buffer);
    if (!header) return { valid: false };
    return {
      valid: true,
      supported: SUPPORTED_MAPPER_IDS.has(header.mapperType),
      mapperType: header.mapperType,
      mapperName: getMapperName(header.mapperType)
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SUPPORTED_MAPPER_IDS: SUPPORTED_MAPPER_IDS,
      MAPPER_NAMES: MAPPER_NAMES,
      checkNESMagic: checkNESMagic,
      parseNESHeader: parseNESHeader,
      getMapperName: getMapperName,
      checkRomSupport: checkRomSupport
    };
  } else {
    window.SUPPORTED_MAPPER_IDS = SUPPORTED_MAPPER_IDS;
    window.MAPPER_NAMES = MAPPER_NAMES;
    window.checkNESMagic = checkNESMagic;
    window.parseNESHeader = parseNESHeader;
    window.getMapperName = getMapperName;
    window.checkRomSupport = checkRomSupport;
  }
})();
