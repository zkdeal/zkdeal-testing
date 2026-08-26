# Extracting `kurtosis-testing/` into its own repository

This is the hardest of the seven to extract, because its whole purpose is to
assemble the *other* folders into a running system. Extract it last, or keep
it as the repo that pins the others.

## 1. Carve out the history

```bash
git filter-repo --subdirectory-filter kurtosis-testing
# or: git subtree split -P kurtosis-testing -b kurtosis-testing-only
```

The folder already carries its own `package.json`, `pnpm-workspace.yaml`
(`packages/bench`), `pnpm-lock.yaml`, `tsconfig.base.json`,
`.gitattributes`, `.gitignore` and `AUDIT-EXCEPTIONS.md`.

## 2. Sibling references to resolve

There are **no `link:` dependencies** (`@zkdeal/bench` depends only on
`viem`). Every coupling is a path read or an image build against the
umbrella layout - enumerated, with the standalone strategy for each:

| Reference | Where | Standalone strategy |
| --- | --- | --- |
| `web3-protocol/contracts/out/` artifact prefix | `packages/bench/src/artifacts.ts` (single prefix constant), used by `deployment.ts` for every deployed contract | keep a side-by-side `web3-protocol` checkout, or repoint the constant at a fetched contracts artifact bundle |
| `web3-protocol/circuits` root | `packages/bench/src/card-readiness.ts` (overridable `circuitsRoot` parameter) | same |
| fixture write-back into `web3-protocol/contracts/test/fixtures/room-v5-real-proof.json` | `packages/bench/src/mint-real-proof-fixture.ts` | the minted fixture belongs to the `web3-protocol` repo; after extraction the minter emits to a handoff location and the fixture update becomes a PR against that repo |
| prover image build: `-f prover-node/zkvm/docker/risc0-cuda.Dockerfile`, context `prover-node/` | `scripts/build-docker-images.{sh,ps1}` | side-by-side checkout at a pinned commit, or consume published digest-pinned images and skip the local build |
| coordinator image build: `-f web2-api/server/Dockerfile`, context = umbrella root | `scripts/build-docker-images.{sh,ps1}` | same; note the umbrella-root context means the coordinator image bakes in several folders - a standalone build needs the full umbrella shape |
| `.github/workflows/gpu-ci.yml`, `.github/workflows/ci.yml` read from the umbrella root | `scripts/check-gpu-workflows.mjs` | after extraction the workflows this guard protects live in the new repo's own `.github/`; repoint the two umbrella reads and keep every other guarded path in-folder |

The coordinator's in-enclave path expectations (`DATA_DIR`, `WEB_ROOT`,
`CONTRACTS_ROOT`, `CIRCUITS_ROOT`, … set in `package/main.star`) are env
vars consumed by the coordinator image, so they follow whatever layout the
image is built with - they are a lockstep concern with the image build, not
an independent coupling.

## 3. Files that must ride along

- `.gitattributes` - LF policy; the guard and evidence tooling compare file
  bytes, and `kurtosis.sh`/`.ps1` are lockstep twins that must not diverge
  by line endings.
- `.gitignore` - **guard-asserted**: `check-gpu-workflows.mjs` reads it as
  the "evidence ignore policy" input; evidence directories must stay
  ignored.
- `docs/GPU-EVIDENCE-RUNBOOK.md` - also a guard input (the benchmark policy
  is asserted against it), not just documentation.
- `package/` in full - Kurtosis uploads the package via git; the runners
  refuse untracked files (`require_kurtosis_tracked`).
- `pnpm-lock.yaml`, `AUDIT-EXCEPTIONS.md`, and the `pnpm.overrides` block in
  `package.json`.

## 4. CI the standalone repo needs

| Job | Command | Runner |
| --- | --- | --- |
| guards (required) | `docker compose run --rm guards-test` | hosted, GPU-free; keeps the release-path shape honest |
| bench tests | `docker compose run --rm bench-test` | hosted, GPU-free |
| e2e acceptance | `docker compose run --rm e2e` | self-hosted GPU runner; per the runbook: clean checkout, immutable image digests, `RISC0_DEV_MODE=0`, no CPU fallback, enclave-preserving (never replacement mode), generous ceiling |
| audit | `pnpm audit --prod --audit-level=high` | hosted |

The e2e job also needs the Kurtosis CLI (`.tools/kurtosis/` or `PATH`),
Docker socket access, and - until the sibling images are published -
checkouts of `prover-node`, `web2-api`, `web3-protocol` and `app-node` laid
out side by side at pinned commits. That pinning is the real extraction
decision for this folder: a standalone acceptance repo is only meaningful if
it records exactly which commits of the other repos it verified.
