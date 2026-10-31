# Releasing agent-7702

How a new version of this package gets from a change in the source tree to a
published npm release. The flow is deliberately gated: nothing is published
from an untested tree, and the GitHub repository and the npm registry always
carry the same version.

## Source of truth

- The canonical source tree is the maintainer's working copy; this GitHub
  repository (`dayuwidayadi57/agent-7702`) mirrors it.
- The CLI version is single-sourced in the `version` field of
  `package.json` and reported by `agent7702 --version`.

## Steps

1. **Change and test.** Make the change, then run the full test battery
   before anything else:
   - guardrail refusals (drainer target at sign and submit layers, EOA
     target, zero-address target in `sign-auth`, forged authorization file,
     empty-relayer preflight, `topup` to a delegated wallet, journal
     mismatch, bad claim allocation, expired intent);
   - live Sepolia end-to-end runs for any flow that moves funds or changes
     delegation state;
   - read-only diagnosis against known addresses on all 7 chains.
2. **Bump the version and write the changelog.** Semantic versioning:
   - `patch` (0.4.0 → 0.4.1): bug fixes, no behavior change;
   - `minor` (0.4.0 → 0.5.0): new features, backward compatible;
   - `major` (0.4.0 → 1.0.0): breaking changes.
   Run `npm version <patch|minor|major>` and add the matching section to
   `CHANGELOG.md`.
3. **Push to GitHub.** Push the changed files to `main` so the repository
   shows exactly what is about to be published.
4. **Publish.** On the release machine (a private server where the
   maintainer's npm credential lives in `~/.npmrc` as a Granular Access
   Token with bypass-2FA and read/write access to all packages):
   ```bash
   git pull
   npm ci
   npm publish
   ```
   The token means no interactive OTP is needed. Never commit `~/.npmrc`
   or the token anywhere; the token is created and renewed only by the
   maintainer personally.
5. **Verify from the registry.** Do not trust the publish output alone:
   - check the installer metadata (`npm view agent-7702 version` or the
     `application/vnd.npm.install-v1+json` packument) — the full packument
     can lag behind it;
   - from a clean directory, run `npx agent-7702 --version` and a read-only
     smoke test such as `npx agent-7702 check <a known address>`.

## Things that bite

- **Published versions are immutable.** A mistake in x.y.z can only be
  fixed by publishing x.y.(z+1). This is why step 1 is a hard gate.
- **New-publisher staging.** npm may show a placeholder version
  (`0.0.0-stage`, README only) right after a publish by a new account.
  Installers (`npm`/`npx`) resolve the real version through the installer
  metadata; the placeholder is not the release.
- **`npx` inside a source clone runs the local tree.** In a raw git clone
  with no `node_modules`, the CLI fails with `ERR_MODULE_NOT_FOUND` for its
  dependencies. Run `npm ci` in the clone first, or run `npx` from outside
  the directory. End users installing from npm never see this, because npm
  installs the dependencies with the package.
- **The bypass-token route has a sunset.** npm is retiring direct
  publishing via bypass-2FA tokens (announced for January 2027). Before the
  current publishing token expires, migrate the release flow to npm
  Trusted Publishing (OIDC from GitHub Actions) or to an account protected
  by a security-key 2FA that the maintainer holds personally.
