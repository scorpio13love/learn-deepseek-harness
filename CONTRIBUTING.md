# Contributing

Thanks for improving Learn DeepSeek Harness. This is a source-reading course:
clarity, runnable examples, and verifiable claims matter more than feature
count.

## Requirements

- Node.js ≥ 24 (native TypeScript type stripping, `node:test`)
- No runtime dependencies in lessons
- A DeepSeek API key is optional; only live tests need it

## Local setup

```sh
git clone <this-repo>
cd learn-deepseek-harness

# Optional: local upstream checkout for source reading.
# It is git-ignored and not part of this repository.
git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
```

Each lesson is self-contained:

```sh
cd course/lessons/s01-agent-loop
cp env.example .env         # optional, never commit
node --test tests/s01.test.ts
node src/demo.ts            # needs DEEPSEEK_API_KEY
```

Run a lesson's live test without copying a key:

```sh
node --env-file=../s01-agent-loop/.env --test tests/live.test.ts
```

## What not to commit

- `.env`, `.env.*`, API keys, tokens, private keys, credentials
- `deepseek-harness/` (local upstream checkout)
- `course/practice/` (private workspace)
- `node_modules/`, build output, caches, `.DS_Store`

Use the matching `env.example` when adding configuration. If you suspect a
secret leaked, follow [SECURITY.md](SECURITY.md).

## Lesson changes

- Keep each lesson self-contained: `README.md`, `src/`, `tests/`,
  `env.example`, `package.json`, `tsconfig.json`.
- Do not introduce a fake model in lesson code. Test doubles are allowed only
  for transport/timing/failure injection and must be documented as such.
- Update module-level comments for the lesson you are editing; do not carry
  stale comments from the previous lesson.
- Keep the README contract: source-reading table, run instructions, acceptance
  tests, deliberate simplifications, exercises, and answered thinking
  questions.
- Run the lesson's offline tests and, when possible, its live test.

## Website

The site lives in `site/` and reads the source Markdown directly from
`course/lessons/*/README.md`, `docs/*.md`, and `course/README.md`. There is no
generated content bundle to commit.

```sh
node site/serve.mjs
# http://127.0.0.1:4173/site/
```

Edit the source Markdown and reload. Do not add generated `site/content/`,
`site/docs/`, `site/content.js`, `site/docs.js`, or screenshot copies; they are
ignored by `.gitignore`.

## Pull requests

Please include:

- what changed and why;
- which lesson/site paths are affected;
- tests run (offline/live) and their results;
- any intentional simplification or follow-up.

By contributing, you agree that your contribution is licensed under the
repository's MIT license.
