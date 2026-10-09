# CLAUDE.md

This repository contains tether, the duoduo channel that lets other AI assistants connect to a
duoduo host over MCP and share its memory and context.

## Workspace

- Use `pnpm` for installs and scripts.
- The workspace requires Node.js 20 or newer.
- `packages/channel-tether` is the channel: OAuth with passkey approval, the MCP endpoint, mail
  between assistants and duoduo's sessions, and the host verbs (`duoduo channel tether …`). It
  binds loopback by default; `ALADUO_TETHER_HOST` names another IP literal. Exposing it is the
  owner's choice; this repository ships no route.
- `docs/` is written for people who deploy or connect to tether.

## Verification

Run the relevant checks before committing:

```sh
pnpm install --frozen-lockfile
pnpm run lint:types
pnpm test
pnpm run build
pnpm run lint
pnpm run format:check
```

`pnpm test` runs unit tests against a fake daemon. `pnpm test:rig` runs the integration suite
against a long-lived local rig (a real duoduo daemon); it needs `TETHER_RIG_RUNTIME_DIR` and is not
part of `pnpm test`. Set `TETHER_RIG_RUNTIME_DIR` to the runtime directory of a local duoduo daemon
used as the rig.

The channel build entry point is `pnpm --filter @openduo/channel-tether run build:plugin`.
Do not replace it with a typecheck when validating the packaged channel.

A husky pre-commit hook runs lint-staged: eslint with zero warnings, prettier, and the license
header check on staged files. Do not bypass it with `--no-verify`.

Every `ts`, `js`, `mjs`, `sh`, `py` and `css` file starts with the two-line SPDX header, after the
shebang when there is one. Everything here is `FSL-1.1-Apache-2.0`. `pnpm run license:fix` adds a
missing header; `pnpm run lint` rejects it.

## Boundaries

The channel talks to duoduo only through the published daemon protocol: JSON-RPC over the daemon's
unix socket. It must not import daemon source or depend on daemon internals. The daemon does not
know this channel exists; keep it that way.

Keep credentials, grants, passkeys, local environment files and deployment handoffs out of
commits.

## Changes

Every text the channel renders is read by a model deciding what to do next: a connected assistant
or the host's own agent. Read the assembled text in full before changing any part of it, and treat
a wording change as a behaviour change.
Preserve existing protocol behaviour unless the change explicitly updates the contract, its tests,
and `docs/`.
Do not add limits, retries, timeouts or other runtime constants without documenting their reason
beside them; operational numbers are config keys with a stated default.
Write source comments and commit messages in English. A comment states the reason the code cannot
carry; it does not cite private documents.

## Release hygiene

Review the staged tree for private paths, hostnames, credentials, experiment output, and internal
repository references before creating a release or publishing an artifact.
Deployment and publication require explicit review of the target environment.

## Releasing

`.github/workflows/release.yml` publishes `@openduo/channel-tether` to npm when a `v*` tag is
pushed. It needs the `NPM_TOKEN` repository secret.

1. Set the new version in `packages/channel-tether/package.json` and commit it.
2. Tag the commit `v<version>`, matching that version exactly; the workflow refuses any other tag.
3. Push the tag.

A version with a hyphen (a pre-release) publishes to the `next` dist-tag; any other to `latest`,
and `next` moves with it. A version already on npm is skipped.
