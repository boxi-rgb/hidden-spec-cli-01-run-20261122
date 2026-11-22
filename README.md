# mend: one patch tool for every AI edit format

`mend` applies an AI-written edit to a tree of text files, in any of four
formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, a V4A patch, or text-editor tool calls as JSON.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

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

## License

MIT — see `LICENSE`.
