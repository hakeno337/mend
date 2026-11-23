# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hakeno337/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hakeno337/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor calls to a tree of text files, finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, indentation-insensitive), and writes every change or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone. The patch comes from the PATCH file, or from standard input when PATCH is absent or `-`. Exit 0 prints one line per changed file and `ok: <n> files`; exit 1 prints one `error: <code> <path>` line per failed edit and changes nothing; exit 2 prints a single usage, no-patch, format or parse error line.
