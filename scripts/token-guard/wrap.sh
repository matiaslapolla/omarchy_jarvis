#!/usr/bin/env bash
# wrap.sh: token-frugal runner with auto-rotate. usage: ./wrap.sh -m <model> -- <opencode run args>
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"; STATE="$DIR/state"; mkdir -p "$STATE"
ULOG="$STATE/usage.log"; ACTIVE="$STATE/active-model.json"
PAT='rate limit|429|quota|usage.*exceed|limit.*exceed|provider.*overload|402|payment|credit'
MODEL=""
while [ $# -gt 0 ]; do case "$1" in
  -m) MODEL="${2:-}"; shift 2 ;;
  --) shift; break ;;
  -h|--help) echo "usage: $0 -m <model> -- <opencode run args>"; exit 0 ;;
  *) break ;;
esac; done
if [ -z "${MODEL:-}" ]; then
  MODEL="$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$ACTIVE" 2>/dev/null | head -n1 | cut -d'"' -f4 || true)"
  [ -n "${MODEL:-}" ] || { echo "usage: $0 -m <model> -- <args>" >&2; exit 1; }
fi
snap() { # echo "in out cache"
  S="$(opencode stats --models 2>/dev/null || true)"
  for k in input output cache; do
    printf '%s' "$S" | grep -oiE "$k[^0-9]*[0-9][0-9,]*" 2>/dev/null \
      | grep -oE '[0-9][0-9,]*' | tr -d ',' | awk '{s+=$1} END{print s+0}';
  done | tr '\n' ' '
}
run_once() { opencode run -m "$1" "$@"; }
read -r PI PO PC <<< "$(snap)"; PI=${PI:-0}; PO=${PO:-0}; PC=${PC:-0}
OUT=""; RC=0
OUT="$(run_once "$MODEL" "$@" 2>&1)" || RC=$?
printf '%s\n' "$OUT"
LOW="$(printf '%s' "$OUT" | tr '[:upper:]' '[:lower:]')"
if [ "$RC" -ne 0 ] && printf '%s' "$LOW" | grep -Eq "$PAT"; then
  echo "wrap: limit hit on $MODEL, probing fallback..." >&2
  NEW="$("$DIR/probe-fallback.sh" 2>/dev/null | sed -n 's/^ACTIVE_MODEL=//p' | tail -n1)"
  if [ -n "${NEW:-}" ]; then
    echo "wrap: retrying with $NEW" >&2
    OUT=""; RC=0; OUT="$(run_once "$NEW" "$@" 2>&1)" || RC=$?
    printf '%s\n' "$OUT"; MODEL="$NEW"
  fi
fi
read -r FI FO FC <<< "$(snap)"; FI=${FI:-0}; FO=${FO:-0}; FC=${FC:-0}
DI=$((FI-PI)); DO=$((FO-PO)); DC=$((FC-PC))
[ "$DI" -lt 0 ] && DI=0; [ "$DO" -lt 0 ] && DO=0; [ "$DC" -lt 0 ] && DC=0
TS="$(date -u +%FT%TZ)"
echo "{\"ts\":\"$TS\",\"wrap_model\":\"$MODEL\",\"input_delta\":$DI,\"output_delta\":$DO,\"cache_delta\":$DC,\"rc\":$RC}" >> "$ULOG"
exit "$RC"
