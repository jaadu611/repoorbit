#!/usr/bin/env bash
set -e

# Repoorbit Full Stack Orchestrator
C_BLUE='\033[0;34m'
C_GREEN='\033[0;32m'
C_BOLD='\033[1m'
C_NC='\033[0m'


# Mode: Core Engine (Gemma + Flash)
if [ "$1" == "--cores" ]; then
  PID_FILE="/tmp/opencode_pids"
  > "$PID_FILE"

  stop_cores() {
    if [ -f "$PID_FILE" ]; then
      while IFS= read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PID_FILE"
    fi
    exit 0
  }
  trap stop_cores EXIT INT TERM

  # Inject NVIDIA API key into OpenCode's auth store
  OPENCODE_AUTH_DIR="$HOME/.config/opencode"
  mkdir -p "$OPENCODE_AUTH_DIR"
  # Load NVIDIA_API_KEY from .env or .env.local if not already in environment
  if [ -z "$NVIDIA_API_KEY" ]; then
    for f in ".env" ".env.local"; do
      if [ -f "$(pwd)/$f" ]; then
        # Parse key, strip quotes, and handle potential carriage returns
        RAW_KEY=$(grep '^NVIDIA_API_KEY=' "$(pwd)/$f" | cut -d '=' -f2- | tr -d '\r')
        # Strip leading/trailing double or single quotes
        CLEAN_KEY=$(echo "$RAW_KEY" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        if [ -n "$CLEAN_KEY" ]; then
          export NVIDIA_API_KEY="$CLEAN_KEY"
          break
        fi
      fi
    done
  fi

  if [ -n "$NVIDIA_API_KEY" ]; then
    echo "{\"nvidia\": \"$NVIDIA_API_KEY\"}" > "$OPENCODE_AUTH_DIR/auth.json"
    printf " ${C_GREEN}[opencode]${C_NC} NVIDIA API key injected into auth.json\n"
  else
    printf " ${C_BLUE}[opencode]${C_NC} WARNING: NVIDIA_API_KEY not set — OpenCode surgery phase will fail\n"
  fi

  opencode serve --port 3001 --hostname 127.0.0.1 > /dev/null 2>&1 &
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
  printf " ${C_BLUE}│${C_NC}  UNIFIED CORE (3001)   •  [ ${C_GREEN}ACTIVE${C_NC} ]      ${C_BLUE}│${C_NC}\n"
  printf " ${C_BLUE}└───────────────────────────────────────────┘${C_NC}\n"

  printf "  ${C_BOLD}URL:${C_NC}      ${C_GREEN}http://localhost:3000${C_NC}\n"
  wait
  exit 0
fi

# Main Entry Point: Orchestrator
NEXT_CMD=${NEXT_CMD:-"next dev"}

npx concurrently --kill-others-on-fail --names "opencode,next" --prefix-colors "cyan,green" \
  "bash $0 --cores" \
  "bash -c \"$NEXT_CMD | grep -vE 'Next.js|Local:|Network:|Environments:|Starting|Ready in|GET /api/chat|/api/chat\\?taskId=|^[[:space:]]*$' --line-buffered; exit 0\""
