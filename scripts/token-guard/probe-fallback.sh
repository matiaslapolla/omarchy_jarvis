#!/usr/bin/env bash
# probe-fallback.sh: probe providers.json in order, activate first healthy model.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"; STATE="$DIR/state"; PROV="$DIR/providers.json"
mkdir -p "$STATE"
PAT='rate limit|429|quota|usage.*exceed|limit.*exceed|provider.*overload|402|payment|credit|overloaded|temporarily unavailable'
models() {
  if command -v jq >/dev/null 2>&1; then jq -r '.[].model // empty' "$PROV" 2>/dev/null || grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROV" | cut -d'"' -f4
  else grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROV" | cut -d'"' -f4; fi
}
models | { while IFS= read -r M; do
  [ -n "${M:-}" ] || continue
  echo "probing $M..." >&2
  OUT="$(timeout 60 opencode run -m "$M" --format json "reply with: ok" 2>&1 | head -c 2000 || true)"
  LOW="$(printf '%s' "$OUT" | tr '[:upper:]' '[:lower:]')"
  if printf '%s' "$LOW" | grep -Eq "$PAT"; then echo "limited: $M" >&2; continue; fi
  if [ -n "$OUT" ]; then
    TS="$(date -u +%FT%TZ)"
    printf '{"model":"%s","ts":"%s"}\n' "$M" "$TS" > "$STATE/active-model.json"
    echo "ACTIVE_MODEL=$M"; exit 0
  fi
  echo "failed: $M" >&2
done
echo "no healthy provider" >&2; exit 1; }
