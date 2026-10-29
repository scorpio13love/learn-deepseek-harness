# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting / Security Advisories for this
repository. Include:

- affected lesson or site path;
- a minimal reproduction;
- impact and any suggested fix;
- whether a secret may have been exposed.

We will acknowledge the report and coordinate a fix before public disclosure.

## Secrets and API keys

- Never commit `.env`, `.env.*`, credentials, tokens, private keys, or
  screenshots containing them.
- Every lesson ships `env.example` with a placeholder only.
- Live tests read `DEEPSEEK_API_KEY` from the environment or a local,
  git-ignored `.env`.
- If a key is committed or pushed by mistake:
  1. revoke/rotate it immediately at the provider;
  2. remove it from the working tree;
  3. scrub the Git history (for example with `git filter-repo`);
  4. force-push and tell collaborators to re-clone.

`deepseek-harness/` is a local upstream checkout and `course/practice/` is a
private workspace; both are ignored by this repository.

## Executing course code

The course runs real shell commands, file writes, and model calls in demos and
tests. Run them in a disposable workspace and review `s13-capability-seams`
before pointing tools at a real project. The mini harness is educational code,
not a hardened sandbox.

## Upstream

Security issues in the upstream `deepseek-harness` project should be reported
to that project, not here.
