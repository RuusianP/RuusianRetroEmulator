const PIXEL_COUNT = 256 * 240;
const FRAME_INTERVAL = 1000 / 60;
const AUDIO_BUFFER_SIZE = 4096;

const SCANLINES_LUT = new Uint8Array(256);
(() => { for (let i = 0; i < 256; i++) SCANLINES_LUT[i] = (i * 0.6) | 0; })();

let nes = null;
let isRunning = false;
let isPaused = false;
let frameLooping = false;
let lastFrameTime = 0;
let offscreenCtx = null;
let turboMultiplier = 1;
let godMode = false;
let currencyMode = false;
let scanlinesEnabled = false;

// SharedArrayBuffer for zero-latency input (main thread writes, worker reads)
let inputBuffer = null;
let inputView = null;

const cheats = new Map();

function applyCheats() {
  if (!nes || !nes.cpu || !nes.cpu.mem) return;
  const mem = nes.cpu.mem;
  cheats.forEach((value, addr) => {
    if (addr < 0x0800) {
      mem[addr] = value;
    }
  });
}

const GOD_LIVES_ADDRESSES = [
  0x00A0, 0x00B0, 0x00C0, 0x00D0, 0x00E0, 0x00F0, 0x00F5, 0x0100,
  0x01A0, 0x01F5, 0x04A0, 0x04F5, 0x05A0, 0x05F5, 0x0640, 0x06A0,
  0x06F5, 0x075A, 0x07A0, 0x07F5
];
const GOD_HEALTH_ADDRESSES = [
  0x00A1, 0x00A2, 0x00B1, 0x00C1, 0x00D1, 0x00E1, 0x00F1, 0x00F2,
  0x0101, 0x04A1, 0x04F1, 0x05A1, 0x05F1, 0x0641, 0x06A1, 0x06F1,
  0x0700, 0x0701, 0x057C, 0x067C, 0x077C
];
const CURRENCY_ADDRESSES = [
  0x00B5, 0x00C5, 0x00D5, 0x00E5, 0x03E0, 0x03E1, 0x04B0, 0x04B1,
  0x05B0, 0x05B1, 0x06B0, 0x06B1, 0x07B0, 0x07B1, 0x075E, 0x075F,
  0x066B, 0x066C, 0x0505, 0x0605, 0x0705, 0x04F0, 0x05F0, 0x06F0
];
const GOD_LIVES_VALUE = 0x09;
const GOD_HEALTH_VALUE = 0xFF;
const CURRENCY_VALUE = 0x99;

function applyUniversalMods() {
  if ((!godMode && !currencyMode) || !nes || !nes.cpu || !nes.cpu.mem) return;
  const mem = nes.cpu.mem;
  if (godMode) {
    for (let i = 0; i < GOD_LIVES_ADDRESSES.length; i++) mem[GOD_LIVES_ADDRESSES[i]] = GOD_LIVES_VALUE;
    for (let i = 0; i < GOD_HEALTH_ADDRESSES.length; i++) mem[GOD_HEALTH_ADDRESSES[i]] = GOD_HEALTH_VALUE;
  }
  if (currencyMode) {
    for (let i = 0; i < CURRENCY_ADDRESSES.length; i++) mem[CURRENCY_ADDRESSES[i]] = CURRENCY_VALUE;
  }
}

let audioEnabled = false;
let audioBuffer = [];
let frameCount = 0;
let fpsStartTime = 0;
let frameTimer = null;

let rgbaBuffer = null;
let offscreenImageData = null;

function cancelScheduledFrame() {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = null;
}

try {
  importScripts('jsnes.min.js');
} catch (err) {
  self.postMessage({ type: 'error', message: 'Failed to load JSNES: ' + err.message });
}

function startFrameLoop() {
  if (!nes || !isRunning || isPaused || frameLooping) return;
  frameLooping = true;
  lastFrameTime = performance.now();
  frameLoop();
}

function arrayBufferToBinaryString(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let result = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return result;
}

function stopFrameLoop() {
  frameLooping = false;
  cancelScheduledFrame();
}

self.onmessage = function(e) {
  if (!e || !e.data) return;
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      if (data && data.inputBuffer) {
        inputBuffer = data.inputBuffer;
        inputView = new Uint8Array(inputBuffer);
      }
      if (data && data.offscreen) {
        offscreenCtx = data.offscreen.getContext('2d');
        if (offscreenCtx) {
          offscreenCtx.imageSmoothingEnabled = false;
        }
      }
      stopFrameLoop();
      initNES();
      if (offscreenCtx) {
        self.postMessage({ type: 'hwReady', message: 'Offscreen canvas rendering enabled' + (inputBuffer ? ' + SharedInput' : '') });
      } else {
        self.postMessage({ type: 'hwReady', message: 'Standard rendering mode active' + (inputBuffer ? ' + SharedInput' : '') });
      }
      break;

    case 'loadROM':
      if (nes) {
        try {
          if (!data || !data.romData) {
            throw new Error('No ROM data provided');
          }
          let romData = data.romData;
          if (romData instanceof ArrayBuffer || ArrayBuffer.isView(romData)) {
            romData = arrayBufferToBinaryString(romData);
          }
          if (typeof romData !== 'string' || romData.length < 16) {
            throw new Error('Invalid ROM data format or size');
          }
          if (romData.charCodeAt(0) !== 0x4E ||
              romData.charCodeAt(1) !== 0x45 ||
              romData.charCodeAt(2) !== 0x53 ||
              romData.charCodeAt(3) !== 0x1A) {
            throw new Error('Invalid NES ROM header');
          }
          cheats.clear();
          audioBuffer = [];
          frameCount = 0;
          fpsStartTime = performance.now();
          nes.loadROM(romData);
          isRunning = true;
          isPaused = false;
          startFrameLoop();
          self.postMessage({ type: 'romLoaded' });
        } catch (err) {
          const message = err?.message || 'Unknown ROM load error';
          const unsupportedMatch = /not supported by JSNES:\s*([^()]+)\((\d+)\)/i.exec(message);
          if (unsupportedMatch) {
            const mapperType = Number(unsupportedMatch[2]);
            self.postMessage({
              type: 'unsupportedMapper',
              mapperType,
              mapperName: unsupportedMatch[1].trim(),
              message: `Unsupported mapper ${mapperType}: ${unsupportedMatch[1].trim()}`
            });
          } else {
            self.postMessage({ type: 'error', message: 'ROM load failed: ' + message });
          }
          isRunning = false;
        }
      } else {
        self.postMessage({ type: 'error', message: 'Emulator not initialized' });
      }
      break;

    case 'saveState':
      if (!nes) {
        self.postMessage({ type: 'error', message: 'Emulator not initialized' });
      } else if (typeof nes.toJSON !== 'function') {
        self.postMessage({ type: 'error', message: 'Emulator does not support state serialization' });
      } else {
        try {
          const nesState = nes.toJSON();
          if (!nesState) throw new Error('toJSON returned null/undefined');
          const state = JSON.stringify(nesState);
          if (!state || state.length < 10) throw new Error('Serialized state is empty or invalid');
          self.postMessage({ type: 'savedState', state });
        } catch (err) {
          self.postMessage({ type: 'error', message: 'Save state failed: ' + err.message });
        }
      }
      break;

    case 'loadState':
      if (!nes) {
        self.postMessage({ type: 'error', message: 'Emulator not initialized' });
      } else if (!isRunning) {
        self.postMessage({ type: 'error', message: 'Load a ROM before restoring a save state' });
      } else if (!data || !data.state) {
        self.postMessage({ type: 'error', message: 'No state data provided' });
      } else if (typeof nes.fromJSON !== 'function') {
        self.postMessage({ type: 'error', message: 'Emulator does not support state restoration' });
      } else {
        try {
          const state = typeof data.state === 'string' ? JSON.parse(data.state) : data.state;
          if (typeof state !== 'object' || !state.cpu || !state.ppu) {
            throw new Error('Invalid state structure');
          }
          nes.fromJSON(state);
          isRunning = true;
          isPaused = false;
          startFrameLoop();
          self.postMessage({ type: 'stateLoaded', message: 'State loaded successfully' });
        } catch (err) {
          self.postMessage({ type: 'error', message: 'Load state failed: ' + err.message });
        }
      }
      break;

    case 'pause':
      isPaused = true;
      audioBuffer = [];
      stopFrameLoop();
      self.postMessage({ type: 'paused' });
      break;

    case 'resume':
      if (!isRunning) return;
      isPaused = false;
      startFrameLoop();
      self.postMessage({ type: 'resumed' });
      break;

    case 'stop':
      isRunning = false;
      isPaused = false;
      audioBuffer = [];
      stopFrameLoop();
      self.postMessage({ type: 'stopped' });
      break;

    case 'reset':
      if (nes) {
        audioBuffer = [];
        cheats.clear();
        nes.reset();
        isPaused = false;
        if (isRunning) startFrameLoop();
        self.postMessage({ type: 'reset' });
      }
      break;

    case 'keyInput':
      if (data && nes && nes.keyboard) {
        nes.keyboard.setKey(data.keyCode, data.state);
      }
      break;

    case 'setTurbo':
      turboMultiplier = (data && Number.isInteger(data.multiplier) && data.multiplier >= 1 && data.multiplier <= 4) ? data.multiplier : 1;
      self.postMessage({ type: 'turboSet', multiplier: turboMultiplier });
      break;

    case 'setAudio':
      audioEnabled = !!(data && data.enabled);
      if (audioEnabled) {
        self.postMessage({ type: 'audioReady' });
      } else {
        audioBuffer = [];
      }
      break;

    case 'setGodMode':
      godMode = !!(data && data.enabled);
      self.postMessage({ type: 'modSet', mod: 'god', enabled: godMode });
      break;

    case 'setCurrencyMode':
      currencyMode = !!(data && data.enabled);
      self.postMessage({ type: 'modSet', mod: 'currency', enabled: currencyMode });
      break;

    case 'setScanlines':
      scanlinesEnabled = !!(data && data.enabled);
      self.postMessage({ type: 'scanlinesSet', enabled: scanlinesEnabled });
      break;

    case 'addCheat':
      {
        if (!data || !data.address || !data.value) break;
        const addr = parseInt(data.address, 16);
        const value = parseInt(data.value, 16);
        if (isNaN(addr) || isNaN(value) || addr < 0 || addr > 0xFFFF) {
          self.postMessage({ type: 'error', message: 'Invalid cheat address or value' });
          break;
        }
        cheats.set(addr, value);
        self.postMessage({ type: 'cheatAdded', address: data.address, value: data.value });
      }
      break;

    case 'removeCheat':
      {
        if (!data || !data.address) break;
        const addr = parseInt(data.address, 16);
        if (cheats.has(addr)) {
          cheats.delete(addr);
          self.postMessage({ type: 'cheatRemoved', address: data.address });
        }
      }
      break;

    case 'clearCheats':
      cheats.clear();
      self.postMessage({ type: 'cheatsCleared' });
      break;

    case 'getCheats':
      {
        const cheatList = [];
        cheats.forEach((value, addr) => {
          cheatList.push({ address: addr.toString(16).toUpperCase().padStart(4, '0'), value: value.toString(16).toUpperCase().padStart(2, '0') });
        });
        self.postMessage({ type: 'cheatsList', cheats: cheatList });
      }
      break;

    default:
      self.postMessage({ type: 'error', message: 'Unknown message type: ' + type });
      break;
  }
};

function convertRGB24toRGBA(src, dst) {
  for (let i = 0; i < PIXEL_COUNT; i++) {
    const p = src[i];
    const off = i << 2;
    dst[off]     = p & 0xFF;
    dst[off + 1] = (p >> 8) & 0xFF;
    dst[off + 2] = (p >> 16) & 0xFF;
    dst[off + 3] = 255;
  }
}

function applyScanlines(buf) {
  for (let y = 1; y < 240; y += 2) {
    const row = y << 10;
    for (let x = 0; x < 1024; x += 4) {
      buf[row + x]     = SCANLINES_LUT[buf[row + x]];
      buf[row + x + 1] = SCANLINES_LUT[buf[row + x + 1]];
      buf[row + x + 2] = SCANLINES_LUT[buf[row + x + 2]];
    }
  }
}

function initNES() {
  const JSNES = self.jsnes?.NES || self.JSNES;
  if (!JSNES) {
    self.postMessage({ type: 'error', message: 'JSNES not found' });
    return;
  }

  rgbaBuffer = new Uint8Array(PIXEL_COUNT << 2);
  offscreenImageData = new ImageData(256, 240);

  try {
    nes = new JSNES({
      onFrame: function(frameBuffer) {
        if (!frameBuffer || frameBuffer.length !== PIXEL_COUNT) {
          return;
        }

        if (offscreenCtx) {
          convertRGB24toRGBA(frameBuffer, rgbaBuffer);
          if (scanlinesEnabled) applyScanlines(rgbaBuffer);
          offscreenImageData.data.set(rgbaBuffer);
          offscreenCtx.putImageData(offscreenImageData, 0, 0);
        } else {
          convertRGB24toRGBA(frameBuffer, rgbaBuffer);
          if (scanlinesEnabled) applyScanlines(rgbaBuffer);
          const out = rgbaBuffer;
          rgbaBuffer = new Uint8Array(PIXEL_COUNT << 2);
          self.postMessage({ type: 'frame', frameBuffer: out }, [out.buffer]);
        }
      },
      onAudioSample: function(left, right) {
        if (!audioEnabled) return;
        audioBuffer.push(left, right);
        if (audioBuffer.length >= AUDIO_BUFFER_SIZE) {
          const samples = audioBuffer;
          audioBuffer = [];
          self.postMessage({ type: 'audio', data: { samples, sampleRate: 44100 } });
        }
      }
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Failed to initialize JSNES: ' + err.message });
    return;
  }

  fpsStartTime = performance.now();
  self.postMessage({ type: 'ready' });
}

function pollSharedInput() {
  if (!inputView || !nes || !nes.keyboard) return;
  const keys = [37, 38, 39, 40, 88, 90, 17, 13];
  for (let i = 0; i < keys.length; i++) {
    const state = inputView[i] ? 1 : 0;
    nes.keyboard.setKey(keys[i], state);
  }
}

function frameLoop() {
  if (!frameLooping || !nes || !isRunning || isPaused) return;
  const now = performance.now();
  const interval = FRAME_INTERVAL / turboMultiplier;

  if (lastFrameTime + interval <= now) {
    try {
      pollSharedInput();
      nes.frame();
      applyUniversalMods();
      applyCheats();
      frameCount++;
      if (frameCount % 6 === 0) {
        self.postMessage({ type: 'alive' });
      }
      lastFrameTime += interval;
      if (lastFrameTime + interval < now) {
        lastFrameTime = now;
      }
    } catch (e) {
      self.postMessage({ type: 'error', message: 'Frame error: ' + e.message });
      stopFrameLoop();
      return;
    }
  }

  const elapsed = now - fpsStartTime;
  if (elapsed >= 1000) {
    const fps = Math.round((frameCount * 1000) / elapsed);
    self.postMessage({ type: 'fps', value: fps });
    frameCount = 0;
    fpsStartTime += 1000;
  }

  const nextFrameTime = lastFrameTime + interval;
  const delay = Math.max(0, nextFrameTime - performance.now());
  frameTimer = setTimeout(frameLoop, delay);
}
