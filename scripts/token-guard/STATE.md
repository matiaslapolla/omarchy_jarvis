# token-guard STATE
1. Observe side terminal: `cd scripts/token-guard && ./observe.sh --interval 30 &`
2. One-shot check: `./observe.sh --once` (exit 2 = LIMIT hit).
3. Find healthy model: `./probe-fallback.sh` → writes `state/active-model.json`.
4. Frugal run w/ auto-rotate: `./wrap.sh -m <model> -- "prompt"` (on limit: probes + retries once).
5. Chain order lives in `providers.json` (cheapest-first, big-pickle last).
6. State: `state/usage.log` (JSONL), `state/limit-detected.json`, `state/active-model.json`.
7. Git: state/ is gitignored (only `.gitkeep` tracked). No npm deps, bash+awk/grep only.
