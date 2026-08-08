# Ruusian Retro Web Emulator

A browser-based NES emulator with a polished glass-morphism dashboard, built with [JSNES](https://github.com/bfirsh/jsnes) and powered by a Node.js/Express backend.

## Overview

The emulator runs the entire NES (CPU + PPU) inside a **Web Worker**, so gameplay never blocks the UI thread. Rendering uses `OffscreenCanvas` when available, and controller input is passed to the worker through a **`SharedArrayBuffer`** for low-latency polling.

- High-performance emulation with JSNES running in a Web Worker
- Local ROM browsing, upload, drag-and-drop, and file management
- Keyboard, touch, and gamepad controls
- Save states with export/import support
- Optional CRT scanlines, turbo mode, cheats, and QoL cheats
- Modern responsive glass-morphism dashboard UI

## One-Line Installation

Install the emulator and get a CLI dashboard (auto-detects the OS, installs Node.js and git if missing):

| Platform | One-liner |
|----------|-----------|
| **Windows** (PowerShell) | `iwr -useb https://raw.githubusercontent.com/RuusianP/RuusianRetroEmulator/main/install.ps1 \| iex` |
| **Linux / Android Termux / macOS** | `bash -c "$(curl -fsSL https://raw.githubusercontent.com/RuusianP/RuusianRetroEmulator/main/install.sh)"` |
| **Any shell** (Node 18+ already installed) | `node -e "fetch('https://raw.githubusercontent.com/RuusianP/RuusianRetroEmulator/main/install.js').then(r=>r.text()).then(eval)"` |

The installer detects the platform (Termux / Debian / RHEL / Arch / Alpine / macOS / Windows), provisions Node.js and git, clones the repository, runs `npm install`, and adds a `ruusian` launcher to your PATH. Afterward, just run **`ruusian`** to open the CLI dashboard (or `node dashboard.js`).

> **Note:** Files must be committed and pushed to GitHub before the one-liners resolve. The installer targets `main` on `RuusianP/RuusianRetroEmulator` — update the URLs if you fork the repo.

## Getting Started (manual)

Requirements: **Node.js 18+**

```bash
cd emulator
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

In GitHub Codespaces / VS Code, open the server port through the **Ports** view. Stop the server with `CTRL+C`.

For a friendlier management interface, run **`npm run dashboard`** instead of `npm start` (see below).

> **Note:** The emulator needs **cross-origin isolation** (COOP/COEP headers, set automatically by the server) for the `SharedArrayBuffer` input path. If those headers are stripped by a proxy, the emulator automatically falls back to regular `postMessage` key events — input still works, just at slightly higher latency.

## Features

- **Fast browser emulation** — NES CPU and PPU run in a worker thread
- **ROM browser** — Discover `.nes` files from the ROMs folder
- **Drag-and-drop support** — Drop ROMs directly onto the viewport
- **Keyboard controls** — Arrow keys / WASD, I/K = A/B, J = Select, L/Enter = Start
- **Touch support** — On-screen buttons for mobile and touch devices
- **Gamepad support** — Web Gamepad API compatible controllers
- **Save states** — Save/load named state slots stored in the browser (`localStorage`) with export/import as JSON
- **Server-side saves API** — Backup and restore save files through the backend
- **Turbo mode** — Speed up gameplay up to 4×
- **CRT scanlines** — Optional retro visual effect
- **Cheat codes** — Runtime RAM patching via `ADDR:VALUE`
- **QoL cheats** — God Mode and Currency Mode toggles that patch common NES RAM locations for lives, health, and currency
- **Debug panel** — `?debug=1` overlays a live readout of emulator state (running, paused, shared-input, held keys)
- **Performance** — Uses `OffscreenCanvas` if available and pre-allocated pixel buffers

## CLI Dashboard

`dashboard.js` is a terminal dashboard that replaces bare `npm start` for day-to-day management. Run it interactively:

```bash
npm run dashboard        # or:  node dashboard.js        (interactive menu)
ruusian                  # if you ran the one-line installer
```

The interactive menu lets you start/stop/restart the server, check health, manage ROMs (list/upload/delete), list server-side saves, tail the live server log, open the emulator in your browser, and change the port.

It also works as a one-shot command runner for automation:

```bash
node dashboard.js start        # start the server (managed, logs to logs/server.log)
node dashboard.js stop         # stop a dashboard-managed server
node dashboard.js restart      # restart it
node dashboard.js status       # health + uptime + ROM count
node dashboard.js roms         # list ROMs with mapper/support info
node dashboard.js upload ./rom.nes
node dashboard.js delete "Game.nes"
node dashboard.js saves
node dashboard.js logs 50      # last 50 log lines
node dashboard.js logsfollow   # live tail (q / Ctrl+C to stop)
node dashboard.js open         # open http://localhost:PORT in your browser
node dashboard.js port 8080    # show or change the port
```

The dashboard persists its state (port, managed PID) in `.dashboard-state.json` and server output in `logs/server.log` (both git-ignored). A server started outside the dashboard (e.g. `npm start`) is detected as running but is not killed by `dashboard stop`.

## Controls

| Action | Keys |
|--------|------|
| D-pad | `Arrow` keys or `WASD` |
| A | `I`, `Z`, or `Space` |
| B | `K` or `X` |
| Select | `J` |
| Start | `L` or `Enter` |
| Pause | `Esc` |
| Fullscreen | `F` |
| Save state | `Ctrl+S` |
| Load state | `Ctrl+L` |

## Architecture

The app is split into two threads connected by a worker message protocol.

**Main thread (`index.html`)**
- Renders the dashboard, ROM list, and on-screen controls
- Captures keyboard / touch / gamepad input and forwards it to the worker
- Receives frame buffers (or transfers the canvas to the worker for OffscreenCanvas rendering)

**Worker (`emulator-worker.js`)**
- Owns the JSNES instance and runs the frame loop
- Handles `init`, `loadROM`, `pause`/`resume`, `reset`, `stop`, `saveState`/`loadState`, `keyInput`, `setTurbo`, `setAudio`, `setScanlines`, `setGodMode`/`setCurrencyMode`, and `addCheat`/`removeCheat`/`clearCheats`/`getCheats`
- Replies with `hwReady`, `ready`, `romLoaded`, `savedState`, `stateLoaded`, `cheatAdded`, `cheatRemoved`, `cheatsCleared`, `cheatsList`, `inputAck`, `modSet`, `turboSet`, `scanlinesSet`, `audioReady`, `alive`, `fps`, `paused`, `resumed`, `stopped`, `reset`, and `error` messages

**Shared input buffer**

When cross-origin isolation is active, input is written into a `SharedArrayBuffer` (8 bytes) that the worker polls each frame. The byte offsets correspond to JSNES keycodes:

```text
[Left, Up, Right, Down, A, B, Select, Start]
```

When the buffer is unavailable, the frontend falls back to `{type:'keyInput', data:{keyCode, state}}` postMessages.

## Project Structure

```text
emulator/
├── package.json               Node.js package information
├── README.md                  Project documentation
├── .gitignore                 Files and directories excluded from git
├── node_modules/              Installed dependencies (ignored)
├── dashboard.js               CLI dashboard (interactive menu + command mode)
├── install.js                 Cross-platform installer (OS detection, clone, launcher setup)
├── install.sh                 One-line installer bootstrap for Linux / Termux / macOS
├── install.ps1                One-line installer bootstrap for Windows (PowerShell)
├── bin/
│   ├── ruusian                `ruusian` launcher for POSIX shells
│   └── ruusian.cmd            `ruusian` launcher for Windows
├── src/
│   ├── server.js              Express server, API routes, and static file serving
│   └── client/
│       ├── index.html         Frontend UI, input handling, and emulator wiring
│       ├── js/
│       │   ├── emulator-worker.js  Worker-side emulation runtime (frame loop, cheats, state)
│       │   ├── jsnes.min.js        Minified JSNES library
│       │   └── nes-data.js         NES constants, mapper table, and ROM header helpers
│       └── favicon.svg
├── Roms/                      NES ROM files for loading (git-ignored)
└── saves/                     Server-side save files and state exports (git-ignored)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/health` | Server health, uptime, ROM count, memory, Node version |
| GET    | `/api/config` | Server configuration values (`maxRomSize`, `allowedExtensions`, `version`) |
| GET    | `/roms/list` | List available ROM filenames |
| GET    | `/roms/info` | Detailed ROM metadata (mapper, mirroring, support status) |
| GET    | `/roms/file?name=` | Download a ROM file |
| POST   | `/roms/upload` | Upload a `.nes` ROM file (multipart, field `rom`) |
| DELETE | `/roms/delete?name=` | Delete a ROM file |
| GET    | `/api/saves` | List server-side saves |
| GET    | `/api/saves/file?name=` | Download a save file |
| POST   | `/api/saves/save` | Create or overwrite a save (`{name, data}`) |
| DELETE | `/api/saves/delete?name=` | Delete a save file |

Uploads are validated against the iNES magic number (`NES\x1A`) and limited to 4 MB; paths are sanitized to prevent traversal.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `ROMS_DIR` | `../../Roms` (repo root) | ROM storage directory path |
| `NODE_ENV` | *(not set)* | Set to `production` for longer static-asset caching |

## Security

- [helmet](https://helmetjs.github.io/) sets security headers, including `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which enable `SharedArrayBuffer`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a strict `Referrer-Policy`
- Per-route rate limiting (`/roms/`, `/api/saves`)
- ROM upload/delete/save paths are validated to prevent path traversal
- Trusts proxy headers for correct client IPs in reverse-proxy environments (e.g. Codespaces)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Blank screen / emulator never starts | Open the browser devtools console; check the worker initialized with a `hwReady` message. |
| `SharedArrayBuffer` is undefined | Cross-origin isolation is disabled (COOP/COEP headers missing). The emulator falls back to `postMessage` input, so gameplay still works. |
| ROM shows "unsupported mapper" | JSNES supports a fixed mapper set (`nes-data.js`). Uploaded ROMs are validated on upload; unsupported ones are rejected. |
| Keyboard controls feel unresponsive | Verify `?debug=1` shows `shared:true` and `running:true`. Focus the page/canvas — input is only captured while the emulator is running. |
| Port already in use | `npm run stop`, or set a different `PORT`. |

## Development

Run the app locally and iterate on UI or emulator behavior:

```bash
npm install
npm run dev
```

The server serves static files live from `src/client/` (no build step), so frontend changes take effect on refresh. For day-to-day management use `npm run dashboard` or `node dashboard.js` instead of `npm start`.

### Releasing the one-line installer

The installer files (`install.sh`, `install.ps1`, `install.js`) are fetched from the `main` branch on GitHub via raw URLs. After making changes, commit and push them so the one-liners pick up the new version.

## Notes

- Do not commit ROM files to GitHub. The `Roms/` folder is ignored in version control.
- Save data is stored in the browser and can be exported as JSON, or backed up via the `/api/saves` endpoints.

## License

This repository is provided under the MIT License.
