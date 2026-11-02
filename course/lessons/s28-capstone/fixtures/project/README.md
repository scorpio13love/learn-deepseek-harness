# sample-project

A tiny task tracker used by the s28 capstone. It is intentionally small and
contains a handful of unresolved markers for the audit task.

## Development

```sh
node src/app.ts
```

## Known issues

- TODO: support deleting a task
- TODO: validate empty task titles
- TODO: persist tasks between runs

## Layout

- `src/app.ts` — task store and CLI
- `src/util.ts` — string helpers
- `tests/app.test.ts` — coarse unit tests
