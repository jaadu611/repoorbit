#!/usr/bin/env bash
set -e

# Repoorbit Full Stack Orchestrator
C_BLUE='\033[0;34m'
C_GREEN='\033[0;32m'
C_BOLD='\033[1m'
C_NC='\033[0m'

LOG_DIR="$(cd "$(dirname "$0")" && pwd)/.opencode_logs"
mkdir -p "$LOG_DIR"

# Mode: Core Engine (Gemma + Flash)
if [ "$1" == "--cores" ]; then
  GEMMA_LOG="$LOG_DIR/gemma_3001.log"
  FLASH_LOG="$LOG_DIR/flash_3002.log"
  PID_FILE="$LOG_DIR/pids"
  > "$PID_FILE"

  stop_cores() {
    if [ -f "$PID_FILE" ]; then
      while IFS= read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PID_FILE"
    fi
    exit 0
  }
  trap stop_cores EXIT INT TERM

  opencode serve --port 3001 --hostname 127.0.0.1 > "$GEMMA_LOG" 2>&1 &
  echo "$!" >> "$PID_FILE"
  opencode serve --port 3002 --hostname 127.0.0.1 > "$FLASH_LOG" 2>&1 &
  echo "$!" >> "$PID_FILE"

  wait_for_port() {
    until curl --silent --max-time 1 -o /dev/null "http://localhost:$1/session" 2>/dev/null; do sleep 1; done
  }

  printf "    ____  __________  ____  ____  ____  ____  __________\n"
  printf "   / __ \/ ____/ __ \/ __ \/ __ \/ __ \/ __ )/  _/_  __/\n"
  printf "  / /_/ / __/ / /_/ / / / / / / / /_/ / __  |/ /  / /   \n"
  printf " / _, _/ /___/ ____/ /_/ / /_/ / _, _/ /_/ // /  / /    \n"
  printf "/_/ |_/_____/_/    \____/\____/_/ |_/____/___/  /_/     \n"

  wait_for_port 3001
  printf " ${C_BLUE}┌───────────────────────────────────────────┐${C_NC}\n"
  printf " ${C_BLUE}│${C_NC}  GEMMA 4-31B (3001)    •  [ ${C_GREEN}ACTIVE${C_NC} ]      ${C_BLUE}│${C_NC}\n"

  wait_for_port 3002
  printf " ${C_BLUE}│${C_NC}  GEMINI FLASH (3002)   •  [ ${C_GREEN}ACTIVE${C_NC} ]      ${C_BLUE}│${C_NC}\n"
  printf " ${C_BLUE}└───────────────────────────────────────────┘${C_NC}\n"

  printf "  ${C_BOLD}URL:${C_NC}      ${C_GREEN}http://localhost:3000${C_NC}\n\n"
  wait
  exit 0
fi

# Main Entry Point: Orchestrator
npx concurrently --kill-others-on-fail --names "opencode,next" --prefix-colors "cyan,green" \
  "bash $0 --cores" \
  "bash -c \"next dev | grep -vE 'Next.js|Local:|Network:|Environments:|Starting|Ready in|^[[:space:]]*$' --line-buffered; exit 0\""
