# zkdeal evidence-runner image. It writes machine evidence to the file named
# by OUT_PATH and emits only a short human decision to the terminal.
#
# This is NOT the image the Kurtosis acceptance run uses:
# scripts/build-docker-images.* tags the coordinator image as `runner`, and
# package/main.star invokes `tsx src/kurtosis-runner.ts` inside that image.
# Build this one only to reproduce the runner outside an enclave.
#
# Precondition: `web3-protocol/contracts/out` is a build product and is not
# tracked, so compile the contracts first. From the UMBRELLA root (the
# directory holding the seven component folders):
#   docker build -f kurtosis-testing/packages/bench/Dockerfile -t zkdeal-bench:acceptance .

FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY kurtosis-testing/package.json kurtosis-testing/pnpm-workspace.yaml kurtosis-testing/pnpm-lock.yaml kurtosis-testing/tsconfig.base.json ./kurtosis-testing/
COPY kurtosis-testing/packages ./kurtosis-testing/packages
COPY kurtosis-testing/scripts ./kurtosis-testing/scripts
COPY web3-protocol/contracts/out ./web3-protocol/contracts/out
COPY web3-protocol/circuits/package.json ./web3-protocol/circuits/package.json
COPY web3-protocol/circuits/card-artifacts.lock.json ./web3-protocol/circuits/card-artifacts.lock.json
COPY web3-protocol/circuits/card-vkeys ./web3-protocol/circuits/card-vkeys
COPY prover-node/zkvm/fixtures ./prover-node/zkvm/fixtures
COPY prover-node/zkvm/artifacts.lock.json ./prover-node/zkvm/artifacts.lock.json
RUN cd kurtosis-testing && pnpm install --frozen-lockfile

FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY --from=deps /app /app

# The runner reads OUT_PATH, never OUT_DIR, so the mounted volume is named by
# the variable the code actually consumes.
ENV OUT_PATH=/out/v5-kurtosis-evidence.json
VOLUME /out
WORKDIR /app/kurtosis-testing/packages/bench
CMD ["pnpm", "exec", "tsx", "src/kurtosis-runner.ts"]
