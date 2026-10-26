# 2026-10-26 P0 registry validate

Date: 2026-10-26. Result: PASS.

## Validator

```
$ npm run validate:registry

> ujwalam@0.0.0 validate:registry
> node tools/registry-validate.mjs registry

OK: registry valid

$ ls registry/functions | wc -l ; ls registry/presets | wc -l ; ls registry/pools | wc -l
51
63
1
```

## npm test

```
$ npm test

> ujwalam@0.0.0 test
> node --test "tests/*.test.mjs"

✔ real registry passes
✔ base fixture passes
✔ rejects: function-flash-over-limit
✔ rejects: function-bad-canvas
✔ rejects: preset-missing-function
✔ rejects: preset-version-unsatisfied
✔ rejects: preset-bad-tag
✔ rejects: preset-canvas-not-in-function
✔ rejects: preset-legacy-missing
✔ rejects: preset-parity-without-source
✔ rejects: pool-missing-preset
✔ rejects: pool-zero-weight
✔ rejects: duplicate-preset-id
✔ semver ranges
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 677.6852
```
