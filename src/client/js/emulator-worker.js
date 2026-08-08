const PIXEL_COUNT = 256 * 240;
const FRAME_INTERVAL = 1000 / 60;
const AUDIO_BUFFER_SIZE = 4096;

const SCANLINES_LUT = new Uint8Array(256);
(() => {
  for (let i = 0; i < 256; i++) SCANLINES_LUT[i] = (i * 0.6) | 0;
})();

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
let prevInputStates = null;

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
  0x00a0, 0x00b0, 0x00c0, 0x00d0, 0x00e0, 0x00f0, 0x00f5, 0x0100, 0x01a0, 0x01f5, 0x04a0, 0x04f5,
  0x05a0, 0x05f5, 0x0640, 0x06a0, 0x06f5, 0x075a, 0x07a0, 0x07f5,
];
const GOD_HEALTH_ADDRESSES = [
  0x00a1, 0x00a2, 0x00b1, 0x00c1, 0x00d1, 0x00e1, 0x00f1, 0x00f2, 0x0101, 0x04a1, 0x04f1, 0x05a1,
  0x05f1, 0x0641, 0x06a1, 0x06f1, 0x0700, 0x0701, 0x057c, 0x067c, 0x077c,
];
const CURRENCY_ADDRESSES = [
  0x00b5, 0x00c5, 0x00d5, 0x00e5, 0x03e0, 0x03e1, 0x04b0, 0x04b1, 0x05b0, 0x05b1, 0x06b0, 0x06b1,
  0x07b0, 0x07b1, 0x075e, 0x075f, 0x066b, 0x066c, 0x0505, 0x0605, 0x0705, 0x04f0, 0x05f0, 0x06f0,
];
const GOD_LIVES_VALUE = 0x09;
const GOD_HEALTH_VALUE = 0xff;
const CURRENCY_VALUE = 0x99;

function applyUniversalMods() {
  if ((!godMode && !currencyMode) || !nes || !nes.cpu || !nes.cpu.mem) return;
  const mem = nes.cpu.mem;
  if (godMode) {
    for (let i = 0; i < GOD_LIVES_ADDRESSES.length; i++)
      mem[GOD_LIVES_ADDRESSES[i]] = GOD_LIVES_VALUE;
    for (let i = 0; i < GOD_HEALTH_ADDRESSES.length; i++)
      mem[GOD_HEALTH_ADDRESSES[i]] = GOD_HEALTH_VALUE;
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
let jsnesLoaded = false;

function loadJSNES() {
  try {
    importScripts('jsnes.min.js');
    if (typeof self.jsnes !== 'undefined' || typeof self.JSNES !== 'undefined') {
      jsnesLoaded = true;
    } else {
      self.postMessage({ type: 'error', message: 'JSNES loaded but not exposed correctly.' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Failed to load JSNES: ' + err.message });
  }
}

loadJSNES();

function cancelScheduledFrame() {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = null;
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

self.onmessage = function (e) {
  if (!e || !e.data) return;
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      if (data && data.inputBuffer) {
        inputBuffer = data.inputBuffer;
        inputView = new Uint8Array(inputBuffer);
        try {
          prevInputStates = new Uint8Array(inputView.length);
        } catch (e) {
          prevInputStates = null;
        }
      }
      if (data && data.offscreen) {
        offscreenCtx = data.offscreen.getContext('2d');
        if (offscreenCtx) {
          offscreenCtx.imageSmoothingEnabled = false;
        }
      }
      stopFrameLoop();
      initNES();
      if (!nes) {
        break;
      }
      if (offscreenCtx) {
        self.postMessage({
          type: 'hwReady',
          message: 'Offscreen canvas rendering enabled' + (inputBuffer ? ' + SharedInput' : ''),
        });
      } else {
        self.postMessage({
          type: 'hwReady',
          message: 'Standard rendering mode active' + (inputBuffer ? ' + SharedInput' : ''),
        });
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
          if (
            romData.charCodeAt(0) !== 0x4e ||
            romData.charCodeAt(1) !== 0x45 ||
            romData.charCodeAt(2) !== 0x53 ||
            romData.charCodeAt(3) !== 0x1a
          ) {
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
              message: `Unsupported mapper ${mapperType}: ${unsupportedMatch[1].trim()}`,
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
        self.postMessage({
          type: 'error',
          message: 'Emulator does not support state serialization',
        });
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
        try {
          nes.keyboard.setKey(data.keyCode, data.state);
          // Acknowledge input for debugging; main thread can use this to verify delivery
          try {
            self.postMessage({ type: 'inputAck', keyCode: data.keyCode, state: data.state });
          } catch (e) {}
        } catch (e) {
          // ignore keyboard set errors
        }
      }
      break;

    case 'setTurbo':
      turboMultiplier =
        data && Number.isInteger(data.multiplier) && data.multiplier >= 1 && data.multiplier <= 4
          ? data.multiplier
          : 1;
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
        if (isNaN(addr) || isNaN(value) || addr < 0 || addr > 0xffff) {
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
          cheatList.push({
            address: addr.toString(16).toUpperCase().padStart(4, '0'),
            value: value.toString(16).toUpperCase().padStart(2, '0'),
          });
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
    dst[off] = (p >> 16) & 0xff;
    dst[off + 1] = (p >> 8) & 0xff;
    dst[off + 2] = p & 0xff;
    dst[off + 3] = 255;
  }
}

function applyScanlines(buf) {
  for (let y = 1; y < 240; y += 2) {
    const row = y << 10;
    for (let x = 0; x < 1024; x += 4) {
      buf[row + x] = SCANLINES_LUT[buf[row + x]];
      buf[row + x + 1] = SCANLINES_LUT[buf[row + x + 1]];
      buf[row + x + 2] = SCANLINES_LUT[buf[row + x + 2]];
    }
  }
}

function initNES() {
  if (!jsnesLoaded) {
    self.postMessage({
      type: 'error',
      message: 'JSNES library not loaded. Check the console for import errors.',
    });
    return;
  }
  const JSNES = self.jsnes?.NES || self.JSNES;
  if (!JSNES) {
    self.postMessage({ type: 'error', message: 'JSNES not found' });
    return;
  }

  rgbaBuffer = new Uint8Array(PIXEL_COUNT << 2);
  offscreenImageData = new ImageData(256, 240);

  try {
    nes = new JSNES({
      onFrame: function (frameBuffer) {
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
      onAudioSample: function (left, right) {
        if (!audioEnabled) return;
        audioBuffer.push(left, right);
        if (audioBuffer.length >= AUDIO_BUFFER_SIZE) {
          const samples = audioBuffer;
          audioBuffer = [];
          self.postMessage({ type: 'audio', data: { samples, sampleRate: 44100 } });
        }
      },
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
  // Only call setKey when state changes to reduce work
  for (let i = 0; i < keys.length; i++) {
    const raw = inputView[i];
    const state = raw ? 1 : 0;
    const prev = prevInputStates ? (prevInputStates[i] ? 1 : 0) : null;
    if (prev === null || prev !== state) {
      try {
        nes.keyboard.setKey(keys[i], state);
      } catch (e) {}
      if (prevInputStates) prevInputStates[i] = state ? 1 : 0;
    }
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
