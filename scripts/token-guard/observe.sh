#!/usr/bin/env bash
# observe.sh: side-terminal observer for opencode free-provider usage/limits.
# usage: ./observe.sh [--once] [--interval 60] [--warn-kb 800]
set -u
ONCE=0; INTERVAL=60; WARN_KB=5000
while [ $# -gt 0 ]; do case "$1" in
  --once) ONCE=1; shift ;;
  --interval) INTERVAL="${2:-60}"; shift 2 ;;
  --warn-kb) WARN_KB="${2:-800}"; shift 2 ;;
  -h|--help) echo "usage: $0 [--once] [--interval 60] [--warn-kb 800]"; exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
esac; done
DIR="$(cd "$(dirname "$0")" && pwd)"; STATE="$DIR/state"
ULOG="$STATE/usage.log"; LDET="$STATE/limit-detected.json"; ACTIVE="$STATE/active-model.json"
LOG="$HOME/.local/share/opencode/log/opencode.log"
PAT='rate limit|429|quota|usage.*exceed|limit.*exceed|provider.*overload|402|payment|credit'
mkdir -p "$STATE"
num() { # $1=text $2=keyword -> summed ints, handles 300.6K / 2.2M suffixes, 0 if none
  printf '%s' "$1" | grep -oiE "$2[^0-9]*[0-9][0-9,.]*[KkMm]?" 2>/dev/null \
    | grep -oiE '[0-9][0-9,.]*[KkMm]?' \
    | awk '{v=$1; m=1; if (v ~ /[Kk]$/) {m=1000; sub(/[Kk]$/,"",v)} else if (v ~ /[Mm]$/) {m=1000000; sub(/[Mm]$/,"",v)}; gsub(/,/,"",v); s+=v*m} END{printf "%.0f", s+0}' || echo 0
}
cur_model() {
  if command -v jq >/dev/null 2>&1 && [ -f "$ACTIVE" ]; then
    jq -r '.model // "?"' "$ACTIVE" 2>/dev/null || echo "?"
  elif [ -f "$ACTIVE" ]; then
    m="$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$ACTIVE" 2>/dev/null | head -n1 | cut -d'"' -f4)"; [ -n "${m:-}" ] && echo "$m" || echo "?"
  else echo "?"; fi
}
pass() {
  S="$(opencode stats 2>/dev/null || true)" # no --models: avoids double-counting per-model rows
  IN="$(num "$S" input)"; OUT="$(num "$S" output)"; CACHE="$(num "$S" cache)"
  [ -n "${IN:-}" ] || IN=0; [ -n "${OUT:-}" ] || OUT=0; [ -n "${CACHE:-}" ] || CACHE=0
  TS="$(date -u +%FT%TZ)"; echo "{\"ts\":\"$TS\",\"session\":\"$$\",\"input\":$IN,\"output\":$OUT,\"cache\":$CACHE}" >> "$ULOG"
  HIT=""; [ -f "$LOG" ] && HIT="$(tail -n 200 "$LOG" 2>/dev/null | grep -oiE "$PAT" | head -n1 || true)"
  ST="ok"; RC=0
  if [ -n "${HIT:-}" ]; then
    CLEAN="$(printf '%s' "$HIT" | tr -d '"' | head -c 200)"
    printf '{"ts":"%s","matched":"%s"}\n' "$TS" "$CLEAN" > "$LDET"; ST="LIMIT"; RC=2
  fi
  M="$(cur_model)"; TOTAL=$((IN + OUT)); WARN="" # cache-read excluded: cheap, noisy
  [ $((TOTAL / 1000)) -gt "$WARN_KB" ] && WARN=" | WARN tokens>${WARN_KB}k"
  echo "TOKENS in=$IN out=$OUT cache=$CACHE | MODEL $M | STATUS $ST$WARN"
  return $RC
}
if [ "$ONCE" -eq 1 ]; then pass; exit $?; fi
while true; do pass || true; sleep "$INTERVAL"; done
