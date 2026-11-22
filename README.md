# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/boxi-rgb/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/boxi-rgb/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

`mend` applies an AI-written edit to a tree of text files, in any of four
formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, a V4A patch, or text-editor tool calls as JSON.

PATCH is the patch file, or standard input when it is absent or `-`.
`--format` picks one format (`unified`, `search-replace`, `v4a`, `json`) or
`auto` (the default), which detects it. `--check` reports what would change
without writing anything. `--strict` matches lines exactly.

An edit's lines are found with three tiers of matching: exact, trailing
whitespace ignored, then leading and trailing whitespace ignored with
re-indentation. Every edit applies, or nothing is written at all.

Node 22 and its standard library only; nothing is installed. `SPEC.md` in
the kit is the whole specification. `runner.ts` is the kit's trial harness
hand-over; `check.ts` runs the 100 public practice checks.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cwqsp23g&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
