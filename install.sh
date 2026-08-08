#!/usr/bin/env bash
# =============================================================================
# Ruusian Retro Emulator — one-line installer for Linux / macOS / Android Termux
#
# Usage:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/RuusianP/RuusianRetroEmulator/main/install.sh)"
#   bash -c "$(curl -fsSL .../install.sh)" -- --start   # also launch the dashboard
#
# Detects the environment (Termux / Debian / RHEL / Arch / Alpine / macOS),
# installs Node.js + git when missing, then runs the cross-platform installer.
# =============================================================================
set -euo pipefail

APP_NAME="Ruusian Retro Emulator"

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'; c_bold='\033[1m'; c_dim='\033[2m'; c_reset='\033[0m'
info() { echo -e "${c_green}✔${c_reset} $*"; }
warn() { echo -e "${c_yellow}⚠${c_reset} $*"; }
fail() { echo -e "${c_red}✖${c_reset} $*" >&2; exit 1; }

is_termux() { [ -n "${PREFIX:-}" ] && [ -d /data/data/com.termux ]; }
is_root()   { [ "$(id -u)" = "0" ]; }

run_root() {
  if is_root; then "$@"; else sudo "$@"; fi
}
pipe_root() {
  if is_root; then cat | bash; else cat | sudo -E bash; fi
}

detect_pm() {
  if is_termux; then echo pkg
  elif command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v pacman >/dev/null 2>&1; then echo pacman
  elif command -v apk >/dev/null 2>&1; then echo apk
  elif command -v brew >/dev/null 2>&1; then echo brew
  else echo unknown; fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)" 2>/dev/null
}

ensure_node() {
  if node_ok; then
    info "Node.js $(node -v) detected."
    return
  fi
  warn "Node.js 18+ is required — installing it via $PM …"
  case "$PM" in
    pkg)
      pkg update -y
      pkg install -y nodejs git
      ;;
    apt)
      run_root apt-get update -y
      run_root apt-get install -y ca-certificates curl gnupg git
      if ! node_ok; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | pipe_root
        run_root apt-get install -y nodejs
      fi
      ;;
    dnf)
      run_root dnf install -y nodejs npm git
      ;;
    pacman)
      run_root pacman -S --noconfirm nodejs npm git
      ;;
    apk)
      run_root apk add nodejs npm git
      ;;
    brew)
      brew install node git
      ;;
    *)
      fail "Could not detect a package manager. Install Node.js 18+ and git, then re-run."
      ;;
  esac
  node_ok || fail "Node.js was not installed successfully."
  info "Node.js $(node -v) installed."
}

ensure_git() {
  command -v git >/dev/null 2>&1 && return 0
  warn "git is missing — installing it via $PM …"
  case "$PM" in
    pkg)  pkg install -y git ;;
    apt)  run_root apt-get install -y git ;;
    dnf)  run_root dnf install -y git ;;
    pacman) run_root pacman -S --noconfirm git ;;
    apk)  run_root apk add git ;;
    brew) brew install git ;;
  esac
  command -v git >/dev/null 2>&1 || fail "git could not be installed."
}

main() {
  echo -e "${c_bold}${APP_NAME}${c_reset} ${c_dim}— installer${c_reset}"
  echo

  if is_termux; then
    PM=pkg; PLATFORM="Android Termux"
  elif [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    PLATFORM="Linux (WSL)"
  elif command -v brew >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then
    PLATFORM="macOS"
  elif [ "$(uname)" = "Darwin" ]; then
    PLATFORM="macOS"
  else
    PLATFORM="Linux"
  fi

  if [ -z "${PM:-}" ]; then PM="$(detect_pm)"; fi
  info "Detected environment: $PLATFORM (package manager: $PM)"

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    warn "curl or wget is required."
    case "$PM" in
      pkg) pkg install -y curl ;;
      apt) run_root apt-get install -y curl ;;
      dnf) run_root dnf install -y curl ;;
      pacman) run_root pacman -S --noconfirm curl ;;
      apk) run_root apk add curl ;;
      brew) brew install curl ;;
      *) fail "Could not detect a package manager. Install curl or wget manually, then re-run." ;;
    esac
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || fail "Failed to install curl or wget."
  fi

  ensure_node
  ensure_git

  local url="https://raw.githubusercontent.com/RuusianP/RuusianRetroEmulator/main/install.js"
  local tmp
  if command -v mktemp >/dev/null 2>&1; then tmp="$(mktemp -d)"; else tmp="/tmp/ruusian-install"; mkdir -p "$tmp"; fi

  info "Downloading the installer …"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$tmp/install.js" || fail "Failed to download installer."
  else
    wget -qO "$tmp/install.js" "$url" || fail "Failed to download installer."
  fi

  node "$tmp/install.js" "$@"
}

main "$@"
