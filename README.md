# Ruusian Retro Web Emulator

A browser-based NES emulator with a polished glass-morphism dashboard, built with JSNES and powered by a Node.js/Express backend.

## Overview

This project delivers a full NES emulation experience inside the browser:

- High-performance emulation with `JSNES` running in a Web Worker
- Local ROM browsing, upload, and file management
- Keyboard, touch, and gamepad controls
- Save states with export/import support
- Optional CRT scanlines and turbo mode
- Modern responsive dashboard UI

## Getting Started

```bash
cd emulator
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

Stop the server with `CTRL+C`.

## Features

- **Fast browser emulation** — NES CPU and PPU run in a worker thread
- **ROM browser** — Discover `.nes` files from the `Roms/` folder
- **Drag-and-drop support** — Drop ROMs directly onto the viewport
- **Keyboard controls** — Arrow keys, WASD, I/K = A/B, J = Select, L/Enter = Start
- **Touch support** — On-screen buttons for mobile and touch devices
- **Gamepad support** — Web Gamepad API compatible controllers
- **Save states** — Save/load state slots stored in browser storage
- **Save export/import** — Download and restore save files
- **Turbo mode** — Speed up gameplay by up to 4×
- **CRT scanlines** — Optional retro visual effect
- **Cheat codes** — Runtime RAM patching via `ADDR:VALUE`
- **Performance** — Uses `OffscreenCanvas` if available and pre-allocated pixel buffers

## Project Structure

```text
emulator/
├── package.json              Node.js package information
├── server.js                 Express server and API routes
├── README.md                 Project documentation
├── .gitignore                Files and directories excluded from git
├── public/
│   ├── index.html            Frontend UI and emulator wiring
│   ├── js/
│   │   ├── emulator-worker.js  Worker-side emulation runtime
│   │   ├── jsnes.min.js        Minified JSNES library
│   │   └── nes-data.js         NES constants and ROM helper data
│   └── favicon.svg
├── Roms/                     NES ROM files for loading
└── saves/                    Optional save files and state exports
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/health` | Server health details |
| GET    | `/api/config` | Server configuration values |
| GET    | `/roms/list` | List available ROM filenames |
| GET    | `/roms/info` | Detailed ROM metadata |
| GET    | `/roms/file?name=` | Download a ROM file |
| POST   | `/roms/upload` | Upload a `.nes` ROM file |
| DELETE | `/roms/delete?name=` | Delete a ROM file |
| GET    | `/api/saves` | List server-side saves |
| GET    | `/api/saves/file?name=` | Download a save file |
| POST   | `/api/saves/save` | Create or overwrite a save |
| DELETE | `/api/saves/delete?name=` | Delete a save file |

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `ROMS_DIR` | `../Roms` | ROM storage directory path |
| `NODE_ENV` | *(not set)* | Set to `production` for caching behavior |

## Controls

- D-pad: `Arrow` keys or `WASD`
- A: `I`, `Z`, or `Space`
- B: `K` or `X`
- Select: `J`
- Start: `L` or `Enter`
- Pause: `Esc`
- Fullscreen: `F`
- Save state: `Ctrl+S`
- Load state: `Ctrl+L`

## Notes

- Do not commit ROM files to GitHub. The `Roms/` folder is ignored in version control.
- Save data is stored locally and can be exported as JSON.

## Development

Run the app locally and iterate on UI or emulator behavior:

```bash
npm install
npm run dev
```

## License

This repository is provided under the MIT License.
