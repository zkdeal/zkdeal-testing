# zkdeal long-running presentation environment.
#
# The package starts a 12-second Ethereum devnet, Blockscout, one persistent
# CUDA prover and the web/API control plane. A blocking bootstrap first deploys
# the role-separated contracts and submits a fresh two-block Groth16 canary.
# Its evidence is mounted read-only into the long-running coordinator.
#
# The coordinator also hosts the hidden-card duel at /card-duel, where a browser
# proves deck initialization and every hand action locally so the coordinator
# never sees a deck order, a salt or a hand. That needs ~25.6 MB of circom wasm
# and Groth16 zkey which the image carries only when the card circuits were
# built before it: `_report_card_duel_readiness` says which of the two happened
# rather than leaving a visitor to find out from a 404.
#
# Always-on Prometheus + Grafana observers (observability.star) start before the
# bootstrap, so the 45-minute acceptance run can be watched live.

DEV_FUNDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEV_FUNDER_MNEMONIC = "test test test test test test test test test test test junk"

# Well-known local-devnet queue credentials; a real deployment must supply its
# own scoped values.
QUEUE_SUBMIT_TOKEN = "zkdeal-local-devnet-queue-submit-token"
QUEUE_NODE_TOKEN = "zkdeal-local-devnet-queue-node-token"
QUEUE_PORT = 3005
# keccak256("kurtosis-4090-node") - the node id the bootstrap registers in the
# room pool (packages/bench/src/pool-lifecycle.ts `nodeId`). The queue agent
# presents the same id at lease time so its heartbeats land on the registered
# node. The two must move together.
POOL_NODE_ID = "0x529edf13d89f65e2c86e86911db719ca7bf50338d408066d96eac658474dac7b"
# Which coordinator presets each example case checkpoints, in order. amm-mev
# runs the naive sandwich room first and the commit-reveal protected room
# second, so one enclave carries both sides of the ordering story.
#
# The hidden-card duel is deliberately absent: its moves are proved in the
# BROWSER (the deck and hand never leave the tab), so a headless scripted
# checkpoint would contradict the very property it demonstrates. Its enclave
# coverage is the report-card-duel-readiness step plus the /card-duel route.
EXAMPLE_CASE_PRESETS = {
    "amm-mev": ["amm-naive", "amm"],
    "auction": ["auction"],
    "shop": ["shop"],
}
# keccak256("zkdeal/kurtosis/role/node-service"). The bootstrap derives the same
# account with roleKey('node-service') in packages/bench/src/kurtosis-runner.ts
# and registers it as the room's admissionSigner. Renaming that role label
# without changing this literal leaves the coordinator signing admissions with a
# key the room does not recognise, so the two must move together.
ROLE_SERVICE_KEY = "0x23d3cf65b16676317faadd64502a92923ed0dcfdfe4531684db2bdfdaaa8fc4a"
PROVER_PORT = 8080
DEMO_PORT = 3000
DEMO_PUBLIC_PORT = 3100
EXPLORER_PORT = 3000
EXPLORER_PUBLIC_PORT = 3200
# Blockscout is part of the recording evidence, so its bytes must not drift when
# `latest` moves between image build and enclave launch. These are the linux/amd64
# manifests selected from the upstream multi-platform images.
BLOCKSCOUT_IMAGE = "ghcr.io/blockscout/blockscout@sha256:c17cbaa165ea5a71defc3b0bfe280e233d35a2e094d6ea2773b7fc70c516a972"
BLOCKSCOUT_VERIFIER_IMAGE = "ghcr.io/blockscout/smart-contract-verifier@sha256:be575b9d132772ae389bbd29fbe0997ba61a9acacc3d9beb152a1b621abbdc5f"
EXPLORER_IMAGE = "ghcr.io/blockscout/frontend@sha256:33e0011bd8406bfde753d031b4ae0b79ee344e650b1346f175659b39846fda69"

# TLS termination in front of the coordinator. `crypto.subtle` is exposed only
# in a secure context, so the hidden-card duel's artifact verification and its
# AES-256-GCM encrypted witness export work on the https origin this publishes
# and nowhere else on a LAN address. tls.star carries the full reasoning.
# Within-package imports must be relative: an absolute locator naming this very
# package is rejected by the interpreter.
tls = import_module("tls.star")

# The always-on Prometheus + Grafana observers. Same relative-import rule as
# tls.star above.
observability = import_module("observability.star")


def run(plan, args={}):
    _validate_args(args)
    images = args["images"]

    plan.print("zkdeal: persistent proof-backed room studio")
    case = args.get("case", "base")
    prove_queue = args.get("prove_queue", False)
    l1 = _start_l1(plan, images)
    prover = _start_prover(plan, images["prover"], args.get("segment_po2", "20"))
    # The queue exists before the demo coordinator so QUEUE_URL names a live
    # service; the BOOTSTRAP keeps the direct prover URL on purpose - GPU
    # calibration must measure the raw device, not queue latency.
    queue = _start_queue(plan, images["server"]) if prove_queue else None
    # The observers exist before the bootstrap on purpose: the 45-minute
    # acceptance run below is exactly the window an operator wants to watch
    # live, and both are CPU-only so they take nothing from the GPU budget.
    obs = observability.start_observability(
        plan, args.get("public_host", "127.0.0.1"), prove_queue
    )

    bootstrap = plan.run_sh(
        name="room-acceptance",
        description="Deploy the contracts, calibrate the current GPU and commit the startup room to Ethereum",
        image=images["runner"],
        env_vars={
            "L1_RPC_URL": l1.rpc,
            "PROVER_URL": prover.url,
            "DEPLOYER_KEY": DEV_FUNDER_KEY,
            "OUT_PATH": "/app/web2-api/server/data/v5-kurtosis-evidence.json",
            "GPU_NAME": args.get("gpu_name", "Current CUDA GPU"),
        },
        run="\n".join(
            [
                "set -eu",
                "mkdir -p /app/web2-api/server/data",
                "cd /app/kurtosis-testing/packages/bench",
                "pnpm exec tsx src/kurtosis-runner.ts",
                "test -s /app/web2-api/server/data/v5-kurtosis-evidence.json",
            ]
        ),
        store=[StoreSpec(src="/app/web2-api/server/data", name="zkdeal-v5-kurtosis-evidence")],
        wait=args.get("runner_timeout", "45m"),
    )
    evidence = bootstrap.files_artifacts[0]
    bootstrap_values = _read_bootstrap_values(plan, images["runner"], evidence)
    _wait_for_blockscout_transaction(
        plan,
        images["runner"],
        bootstrap_values["submit_tx"],
    )
    # The agent needs the pool address from the bootstrap for its on-chain
    # heartbeats, so it starts only now.
    if prove_queue:
        _start_agent(
            plan,
            images["server"],
            prover.url,
            queue.url,
            l1.rpc,
            bootstrap_values["pool"],
        )
    _report_card_duel_readiness(plan, images["runner"], evidence)
    public_host = args.get("public_host", "127.0.0.1")
    tls_enabled = args.get("tls_enabled", True)
    demo_http_url = "http://%s:%d" % (public_host, DEMO_PUBLIC_PORT)
    # DEMO_API_URL is the address the coordinator publishes for itself through
    # /demo/v1/system, so it has to name the origin a visitor is actually on.
    # When the gateway is up that origin is https: a page served over https may
    # not fetch an http API -- the browser blocks it as mixed content and the
    # console fails with a bare network error that names nothing.
    demo_api_url = tls.https_origin(public_host) if tls_enabled else demo_http_url
    # Derived, not supplied: this package now owns a browser-correct explorer, so
    # the demo no longer depends on a runner passing explorer_url back in. An
    # explicit arg still wins for anyone fronting the stand with their own proxy.
    explorer = _start_explorer(plan, l1.rpc, public_host)
    demo = _start_demo(
        plan,
        images["server"],
        l1.rpc,
        l1.rpc_urls,
        prover.url,
        evidence,
        bootstrap_values,
        args.get("gpu_name", "Current CUDA GPU"),
        demo_api_url,
        args.get("explorer_url", "") or explorer.url,
        queue.url if queue != None else "",
    )
    # After the demo, and only after: nginx resolves its upstream name when it
    # loads the config, so the coordinator has to exist first.
    gateway = (
        tls.start_tls_gateway(plan, public_host, demo.name, DEMO_PORT)
        if tls_enabled
        else None
    )

    example_evidence = None
    if case != "base":
        example_evidence = _run_example_case(
            plan,
            images["runner"],
            case,
            l1.rpc,
            queue.url if queue != None else "",
            bootstrap_values,
            args.get("example_timeout", "20m"),
            args.get("proof_samples", "3"),
        )

    return {
        "protocol_version": 6,
        "case": case,
        "l1": "geth+lighthouse-12s",
        "status": "READY",
        "evidence_artifact": evidence,
        "example_evidence_artifact": example_evidence,
        "prove_queue": "http://prove-queue:%d" % QUEUE_PORT if prove_queue else "",
        "demo_service": demo.name,
        "demo_url": demo_http_url,
        # The origin to hand a visitor. Empty when tls_enabled is false, in
        # which case the card duel cannot verify its proving artifacts or
        # encrypt a witness export -- see tls.star.
        "demo_https_url": gateway.url if gateway != None else "",
        "tls_gateway_service": gateway.name if gateway != None else "",
        "block_explorer_service": explorer.name,
        "block_explorer_url": explorer.url,
        "prometheus_url": obs.prometheus_url,
        "grafana_url": obs.grafana_url,
        "prover_access": "in-enclave-only",
        # Whether it can actually prove is decided per image; read the
        # report-card-duel-readiness step's output, not this route.
        "hidden_card_duel_route": "/card-duel",
    }


def _validate_args(args):
    # Quarantined prospect cases under playgrounds/ carry `mode: playground`.
    # They have no run path here, so name the quarantine instead of letting the
    # generic checks below report what reads as an ordinary misconfiguration.
    if args.get("mode") == "playground":
        fail(
            "playground cases are quarantined draft material with no run path in this package; read kurtosis/playgrounds/<case>/QUARANTINE.md before requesting one"
        )
    if args.get("status") != "READY":
        fail(
            "status must be READY; checked-in templates are intentionally not executable"
        )
    if args.get("protocol_version") != 6:
        fail("protocol_version must be 6")
    images = args.get("images")
    if type(images) != "dict":
        fail("images must be supplied")
    for name in ["prover", "runner", "server", "geth", "lighthouse"]:
        image = images.get(name)
        if type(image) != "string" or len(image) == 0 or image == "NOT_BUILT":
            fail("a concrete %s image is required" % name)
    timeout = args.get("runner_timeout", "45m")
    if type(timeout) != "string" or not (
        timeout.endswith("m") or timeout.endswith("h")
    ):
        fail("runner_timeout must be expressed in minutes or hours")
    public_host = args.get("public_host", "127.0.0.1")
    if type(public_host) != "string" or len(public_host) == 0:
        fail("public_host must be a non-empty hostname or IP address")
    # Defaults on, and the default is the supported configuration: without the
    # https gateway `crypto.subtle` is undefined on any LAN address, so the card
    # duel cannot verify its proving artifacts or encrypt a witness export.
    # Turning it off is for a stand already behind someone else's TLS terminator.
    tls_enabled = args.get("tls_enabled", True)
    if type(tls_enabled) != "bool":
        fail("tls_enabled must be a boolean")
    # The template sentinel is as fatal as NOT_BUILT: it is written verbatim into
    # gpuCalibration.gpuName, the field the demo quotes to justify its proof
    # deadline, so an unsubstituted placeholder would publish an unmeasured GPU
    # identity as evidence.
    gpu_name = args.get("gpu_name", "Current CUDA GPU")
    if (
        type(gpu_name) != "string"
        or len(gpu_name) == 0
        or gpu_name == "CURRENT_GPU_NOT_MEASURED"
    ):
        fail("a measured gpu_name is required")
    # Optional override for an operator-owned explorer proxy. Normally this
    # package derives the public URL of its fixed-port `explorer` service.
    explorer_url = args.get("explorer_url", "")
    if type(explorer_url) != "string" or (
        len(explorer_url) > 0 and not explorer_url.startswith("http")
    ):
        fail("explorer_url must be an http(s) URL when supplied")
    # Example case selection. `base` is the bootstrap acceptance alone; every
    # other case additionally checkpoints its example rooms through the demo
    # plane and gates on that evidence.
    case = args.get("case", "base")
    if case != "base" and case not in EXAMPLE_CASE_PRESETS:
        fail(
            "case must be one of base, %s" % ", ".join(sorted(EXAMPLE_CASE_PRESETS))
        )
    segment_po2 = args.get("segment_po2", "20")
    if type(segment_po2) != "string" or segment_po2 not in ["18", "19", "20", "21"]:
        fail("segment_po2 must be one of \"18\", \"19\", \"20\", \"21\" (string)")
    prove_queue = args.get("prove_queue", False)
    if type(prove_queue) != "bool":
        fail("prove_queue must be a boolean")
    example_timeout = args.get("example_timeout", "20m")
    if type(example_timeout) != "string" or not (
        example_timeout.endswith("m") or example_timeout.endswith("h")
    ):
        fail("example_timeout must be expressed in minutes or hours")


def _start_l1(plan, images):
    ethereum_package = import_module(
        "github.com/ethpandaops/ethereum-package@39bdd0d78c3b094ddaa4f5c580062dfdf1e098c6/main.star"
    )
    output = ethereum_package.run(
        plan,
        {
            "participants": [
                {
                    "el_type": "geth",
                    "el_image": images["geth"],
                    "cl_type": "lighthouse",
                    "cl_image": images["lighthouse"],
                    "vc_image": images["lighthouse"],
                    "count": 2,
                }
            ],
            "network_params": {
                "network_id": "31337",
                "seconds_per_slot": 12,
                "preregistered_validator_keys_mnemonic": DEV_FUNDER_MNEMONIC,
            },
            "additional_services": ["blockscout"],
            "blockscout_params": {
                "image": BLOCKSCOUT_IMAGE,
                "verif_image": BLOCKSCOUT_VERIFIER_IMAGE,
                "frontend_image": EXPLORER_IMAGE,
                "env": {},
            },
        },
    )
    participant = output.all_participants[0]
    return struct(
        rpc=participant.el_context.rpc_http_url,
        rpc_urls=[p.el_context.rpc_http_url for p in output.all_participants],
    )


def _start_prover(plan, image, segment_po2):
    plan.add_service(
        name="risc0-cuda-prover",
        config=ServiceConfig(
            image=image,
            cmd=["serve", "--host", "0.0.0.0", "--port", str(PROVER_PORT)],
            ports={
                "http": PortSpec(
                    number=PROVER_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                    wait="15m",
                )
            },
            env_vars={
                "RISC0_DEV_MODE": "0",
                "RISC0_PROVER": "local",
                "RISC0_REQUIRE_CUDA": "1",
                "CUDA_VISIBLE_DEVICES": "0",
                # Every published architecture tag must contain native cubins
                # for the selected GPU. Disabling PTX JIT turns an accidental
                # cross-architecture pin into an immediate, honest failure
                # instead of a many-minute first-proof compilation stall.
                "CUDA_DISABLE_PTX_JIT": "1",
                # Tunable per stand: 20 fits a 24 GB card; an 8 GB card (the
                # RTX 3080 laptop stand) needs 18-19 to leave room for the
                # Groth16 wrap.
                "SEGMENT_PO2": segment_po2,
            },
            gpu=GpuConfig(
                count=1,
                shm_size=65536,
                ulimits={"memlock": -1, "nofile": 65536},
            ),
        ),
    )
    plan.wait(
        service_name="risc0-cuda-prover",
        recipe=GetHttpRequestRecipe(port_id="http", endpoint="/healthz"),
        field="code",
        assertion="==",
        target_value=200,
        timeout="15m",
    )
    return struct(
        url="http://risc0-cuda-prover:%d" % PROVER_PORT,
    )


def _timeout_seconds(value):
    """Convert a Kurtosis-style duration like "45m" or "1h" to whole seconds."""
    if value.endswith("h"):
        return int(value[:-1]) * 3600
    return int(value[:-1]) * 60


def _start_queue(plan, image):
    """The shared prove queue: a standalone slice of the coordinator image.

    Provers PULL work from it (the agent below), so the queue never needs
    ingress to a GPU box, and a busy prover leaves jobs observably waiting in
    the queue instead of silently burning a batch's L1 inclusion window inside
    the prover's own semaphore.
    """
    plan.add_service(
        name="prove-queue",
        config=ServiceConfig(
            image=image,
            cmd=["node", "dist/prove-queue/standalone.js"],
            ports={
                "http": PortSpec(
                    number=QUEUE_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                    wait="5m",
                )
            },
            env_vars={
                "QUEUE_PORT": str(QUEUE_PORT),
                # The coordinator image's baked-in Docker HEALTHCHECK probes
                # 127.0.0.1:${PORT:-3000}/health; without PORT the queue shows
                # a permanent (cosmetic) "unhealthy" in docker ps.
                "PORT": str(QUEUE_PORT),
                "QUEUE_HOST": "0.0.0.0",
                "DATA_DIR": "/app/web2-api/server/data",
                "ZKDEAL_QUEUE_SUBMIT_TOKEN": QUEUE_SUBMIT_TOKEN,
                "ZKDEAL_QUEUE_NODE_TOKEN": QUEUE_NODE_TOKEN,
            },
        ),
    )
    plan.wait(
        service_name="prove-queue",
        recipe=GetHttpRequestRecipe(port_id="http", endpoint="/health"),
        field="code",
        assertion="==",
        target_value=200,
        timeout="5m",
    )
    return struct(url="http://prove-queue:%d" % QUEUE_PORT)


def _start_agent(plan, image, prover_url, queue_url, l1_rpc, pool):
    """The queue-pull sidecar for the enclave's one CUDA prover.

    It leases only when the local prover is healthy and idle, forwards the job,
    and reports the result. The package's chain-31337-only entrypoint gives the
    agent a loopback RPC relay for its development heartbeat; the relay verifies
    the upstream chain before the process holding the development key starts.
    """
    plan.add_service(
        name="prover-agent",
        config=ServiceConfig(
            image=image,
            cmd=[
                "sh",
                "-c",
                "cd /app/kurtosis-testing/packages/bench && pnpm exec tsx src/devnet-prover-agent.ts",
            ],
            env_vars={
                "PROVER_URL": prover_url,
                "QUEUE_URL": queue_url,
                "ZKDEAL_QUEUE_NODE_TOKEN": QUEUE_NODE_TOKEN,
                "NODE_ID": POOL_NODE_ID,
                "NODE_LIVENESS_DEV_MODE": "true",
                "NODE_LIVENESS_DEV_PRIVATE_KEY": ROLE_SERVICE_KEY,
                "ROOM_POOL": pool,
                "DEVNET_L1_RPC_UPSTREAM": l1_rpc,
            },
        ),
    )


def _run_example_case(
    plan,
    image,
    case,
    l1_rpc,
    queue_url,
    bootstrap_values,
    example_timeout,
    proof_samples,
):
    """Checkpoint the case's example rooms through the demo plane and gate on
    the evidence: decision VERIFIED, the 1% flow-fee skim observed on a real
    deposit, queue/heartbeat liveness when the queue runs, and every checkpoint
    transaction indexed by Blockscout."""
    presets = EXAMPLE_CASE_PRESETS[case]
    env_vars = {
        "DEMO_URL": "http://zkdeal-demo:%d" % DEMO_PORT,
        "EXAMPLE_CASE": case,
        "L1_RPC_URL": l1_rpc,
        "ROOM_MANAGER": bootstrap_values["manager"],
        "ROOM_POOL": bootstrap_values["pool"],
        # The evidence dir must be writable by the image's non-root user
        # (uid 10001); /home/zkdeal is the only guaranteed-owned prefix, and a
        # root-level /out cannot be created at run time.
        "OUT_PATH": "/home/zkdeal/out/example-evidence.json",
        "PROOF_SAMPLES": proof_samples,
        # The runner's own deadline must fire BEFORE Kurtosis reclaims the
        # container, otherwise a slow stand is SIGKILLed with no diagnosable
        # evidence. Give it the same budget as the enclave wait; the runner
        # spends only nine tenths of it and keeps the last tenth to write its
        # structured failure.
        "RUNNER_TIMEOUT_SECONDS": str(_timeout_seconds(example_timeout)),
    }
    if len(queue_url) > 0:
        env_vars["QUEUE_URL"] = queue_url
    step = plan.run_sh(
        name="example-%s-acceptance" % case,
        description="Checkpoint the %s example rooms and assert fee + queue evidence"
        % case,
        image=image,
        env_vars=env_vars,
        run="\n".join(
            [
                "set -u",
                # Fail the step immediately if the evidence dir cannot exist:
                # without this guard a denied mkdir lets the runner spend the
                # whole proving budget and then fail only on the final write.
                "mkdir -p /home/zkdeal/out || exit 90",
                "cd /app/kurtosis-testing/packages/bench",
                # The runner writes structured evidence on EITHER outcome
                # (VERIFIED or FAILED with a privateReason). Capture its exit,
                # then echo that evidence to stdout so a failure is readable in
                # the enclave dump's output.log -- run_sh does not retain a
                # failed step's stderr, and its store does not fire on failure.
                "pnpm exec tsx src/example-runner.ts; code=$?",
                "echo '--- example evidence ---'",
                "cat /home/zkdeal/out/example-evidence.json 2>/dev/null || echo 'no evidence file was written'",
                "test -s /home/zkdeal/out/example-evidence.json && [ \"$code\" -eq 0 ]",
            ]
        ),
        store=[
            StoreSpec(src="/home/zkdeal/out", name="zkdeal-example-%s-evidence" % case)
        ],
        wait=example_timeout,
    )
    example_evidence = step.files_artifacts[0]
    # One canary per preset checkpoint, pinned to exact hash width like the
    # bootstrap reads; the count per case is static so this unrolls cleanly.
    for index in range(len(presets)):
        read = plan.run_sh(
            name="read-example-%s-tx-%d" % (case, index),
            description="Read the %s example's checkpoint %d transaction"
            % (case, index),
            image=image,
            files={"/example": example_evidence},
            run="\n".join(
                [
                    "set -eu",
                    "node -e \"const f=require('/example/example-evidence.json'); if(f.decision!=='VERIFIED') process.exit(1); const v=f.presets[%d].checkpointTx; if(!/^0x[0-9a-fA-F]{64}$/.test(v)) process.exit(1); process.stdout.write(v)\""
                    % index,
                ]
            ),
        )
        _wait_for_blockscout_transaction(
            plan, image, read.output, "%s-%d" % (case, index)
        )
    return example_evidence


def _read_bootstrap_values(plan, image, evidence):
    # One container per value because run_sh outputs are future references: they
    # only carry a real value at run time, so they cannot be split apart in
    # Starlark. Each field is pinned to its exact width - an address is 40
    # nibbles and a transaction hash 64 - so a malformed evidence file stops the
    # enclave here instead of configuring the coordinator against nonsense.
    fields = {
        "manager": ("f.contracts.manager", 40),
        "pool": ("f.contracts.pool", 40),
        "token": ("f.contracts.token", 40),
        "submit_tx": ("f.transactions.submit", 64),
    }
    values = {}
    for label in fields:
        expression = fields[label][0]
        nibbles = fields[label][1]
        result = plan.run_sh(
            name="read-%s-address" % label,
            description="Read the private %s bootstrap reference for the demo service"
            % label,
            image=image,
            files={"/bootstrap": evidence},
            run="\n".join(
                [
                    "set -eu",
                    "node -e \"const f=require('/bootstrap/v5-kurtosis-evidence.json'); if(f.decision!=='VERIFIED') process.exit(1); const v=%s; if(!/^0x[0-9a-fA-F]{%d}$/.test(v)) process.exit(1); process.stdout.write(v)\""
                    % (expression, nibbles),
                ]
            ),
        )
        values[label] = result.output
    return values


def _wait_for_blockscout_transaction(plan, image, transaction_hash, label="canary"):
    plan.run_sh(
        name="confirm-blockscout-%s" % label,
        description="Confirm that Blockscout indexed the accepted startup checkpoint",
        image=image,
        env_vars={
            "BLOCKSCOUT_URL": "http://blockscout:4000",
            "CANARY_TRANSACTION": transaction_hash,
        },
        run="\n".join(
            [
                "set -eu",
                'node -e \'const wait=(ms)=>new Promise(r=>setTimeout(r,ms)); (async()=>{ for(let i=0;i<120;i++){ try { const r=await fetch(process.env.BLOCKSCOUT_URL+"/api/v2/transactions/"+process.env.CANARY_TRANSACTION); if(r.status===200){ console.log("Decision: Blockscout indexed the accepted startup checkpoint."); return; } } catch {} await wait(2500); } console.error("Decision: Blockscout did not index the accepted checkpoint in time."); console.error("Effect: explorer links are not ready, but the verified L1 checkpoint remains valid."); console.error("Next action: restore the Blockscout indexer and retry startup."); process.exit(1); })()\'',
            ]
        ),
        wait="6m",
    )


def _report_card_duel_readiness(plan, image, evidence):
    # The hidden-card duel is the only demonstration of confidentiality on this
    # stand: the browser proves deck initialization and every hand action
    # locally, so the coordinator never sees a deck order, a salt or a hand.
    # That needs ~25.6 MB of circom wasm and Groth16 zkey which
    # `circuits/build/*` does not track and which `scripts/build-circuits.sh`
    # does not produce - it builds the settle circuit, not the card circuits.
    # `packages/bench/src/card-readiness.ts` therefore checks the image
    # against `circuits/card-artifacts.lock.json` and records the answer as
    # `cardDuel` in the evidence.
    #
    # This does NOT fail the enclave. The room, the CUDA proof and the L1
    # transition above stand on their own; only the card route is degraded, and
    # the browser already refuses to claim proving it cannot do. The point is
    # that the OPERATOR learns it at startup rather than a visitor learning it
    # from a 404 partway through a multi-megabyte download.
    plan.run_sh(
        name="report-card-duel-readiness",
        description="Report whether this stand can prove a hidden-card duel in the browser",
        image=image,
        files={"/bootstrap": evidence},
        run="\n".join(
            [
                "set -eu",
                "node -e \"const f=require('/bootstrap/v5-kurtosis-evidence.json'); const c=f.cardDuel; if(!c){ console.log('Decision: This runner published no hidden-card duel readiness verdict.'); console.log('Next action: Rebuild the runner image from a tree that includes packages/bench/src/card-readiness.ts.'); process.exit(0);} if(c.localProvingAvailable){ console.log('Decision: The hidden-card duel can be proved in the browser at /card-duel.'); console.log('Evidence: ' + (c.totalDownloadBytes/1e6).toFixed(1) + ' MB of ' + c.ceremony + ' proving artifacts are served by this coordinator.'); console.log('Next action: Open /card-duel and prepare a vault; the deck and hand never leave the tab.'); } else { console.log('Decision: The hidden-card duel cannot be proved in the browser on this stand.'); const bad=(c.artifacts||[]).filter(a=>!a.matchesPin).map(a=>a.path+' '+(a.problem||'is unusable')); console.log('Blocker: ' + (c.unavailable || bad.join('; ') || 'the card proving artifacts are unusable')); console.log('Next action: ' + (c.remedy || 'build the card circuits and rebuild the coordinator image')); console.log('Effect: every other room, proof and L1 transition in this enclave is unaffected.'); }\"",
            ]
        ),
    )


def _start_explorer(plan, l1_rpc, public_host):
    """A Blockscout frontend that works from a browser which is not on this host.

    The ethereum-package's own frontend hardcodes NEXT_PUBLIC_APP_HOST=127.0.0.1.
    That value is what the BROWSER uses to build the URL of the frontend's own
    API proxy, so any visitor who is not sitting on the Docker host asks their
    own loopback for the data and gets an explorer that renders its shell, shows
    green health dots, and lists no transactions. The indexer is fine; only the
    address handed to the browser is wrong.

    NEXT_PUBLIC_API_HOST deliberately stays the enclave-internal service name:
    NEXT_PUBLIC_USE_NEXT_JS_PROXY makes the Next server -- not the browser --
    call it, so every request the browser issues is same-origin. Pointing
    API_HOST at a published address instead would put the browser back on a
    cross-origin path and break the proxy, because the container cannot reach
    the host's LAN address.
    """
    explorer = plan.add_service(
        name="explorer",
        config=ServiceConfig(
            image=EXPLORER_IMAGE,
            ports={
                "http": PortSpec(
                    number=EXPLORER_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                    wait="5m",
                )
            },
            public_ports={
                "http": PortSpec(
                    number=EXPLORER_PUBLIC_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                )
            },
            env_vars={
                "PORT": str(EXPLORER_PORT),
                "NEXT_PUBLIC_API_HOST": "blockscout:4000",
                "NEXT_PUBLIC_API_PROTOCOL": "http",
                "NEXT_PUBLIC_API_WEBSOCKET_PROTOCOL": "ws",
                "NEXT_PUBLIC_USE_NEXT_JS_PROXY": "true",
                "NEXT_PUBLIC_APP_HOST": public_host,
                "NEXT_PUBLIC_APP_PORT": str(EXPLORER_PUBLIC_PORT),
                "NEXT_PUBLIC_APP_PROTOCOL": "http",
                "NEXT_PUBLIC_NETWORK_NAME": "Kurtosis",
                "NEXT_PUBLIC_NETWORK_ID": "31337",
                "NEXT_PUBLIC_NETWORK_RPC_URL": l1_rpc,
                "NEXT_PUBLIC_NETWORK_VERIFICATION_TYPE": "validation",
                "NEXT_PUBLIC_NETWORK_ICON": "https://ethpandaops.io/logo.png",
                "NEXT_PUBLIC_IS_TESTNET": "true",
                "NEXT_PUBLIC_HAS_BEACON_CHAIN": "true",
                "NEXT_PUBLIC_GAS_TRACKER_ENABLED": "true",
                "NEXT_PUBLIC_AD_BANNER_PROVIDER": "none",
                "NEXT_PUBLIC_AD_TEXT_PROVIDER": "none",
            },
        ),
    )
    return struct(
        name=explorer.name,
        url="http://%s:%d" % (public_host, EXPLORER_PUBLIC_PORT),
    )


def _start_demo(
    plan,
    image,
    l1_rpc,
    l1_rpc_urls,
    prover_url,
    evidence,
    addresses,
    gpu_name,
    demo_api_url,
    explorer_url,
    queue_url,
):
    env_vars = {
        "PORT": str(DEMO_PORT),
        "HOST": "0.0.0.0",
        "CHAIN_ID": "31337",
        "L1_RPC_URL": l1_rpc,
        "L1_RPC_URLS": ",".join(l1_rpc_urls),
        "ROOM_MANAGER": addresses["manager"],
        "ROOM_POOL": addresses["pool"],
        "ACCESS_TOKEN": addresses["token"],
        "MANAGED_ROOM_NODE_ID": "0x529edf13d89f65e2c86e86911db719ca7bf50338d408066d96eac658474dac7b",
        "MANAGED_ROOM_SLOT_ID": "0x9005d7936b05e94bf881acdb1985b78190bb23372d915ac96c9a51d9938defa9",
        # keccak256("kurtosis-v6-preset"), registered by pool-lifecycle.ts.
        "MANAGED_ROOM_PRESET_ID": "0x5573b9e025aca61180407c84fb878ea7986ad7a0d1e77ff13f3ad49f888628dd",
        "MANAGED_ROOM_PARTICIPANT_CAPACITY": "128",
        "MANAGED_ROOM_NODE_LABEL": "%s proof node" % gpu_name,
        "MANAGED_ROOM_SLOT_LABEL": "Flexible deadline · one ready room",
        "MANAGED_ROOM_PRESET_LABEL": "Certified proof-backed room",
        "PROVER_URL": prover_url,
        "DEMO_ENABLED": "1",
        "DEMO_EVIDENCE_PATH": "/bootstrap/v5-kurtosis-evidence.json",
        # The demo URL names the https gateway whenever that gateway runs:
        # server/src/index.ts republishes it verbatim as `apiUrl` in
        # /demo/v1/system, and a visitor who is on the https origin must not be
        # pointed back at an http one.
        "DEMO_API_URL": demo_api_url,
        # The browser-facing coordinator never receives the node-service
        # private key. Demo room construction derives the same public service
        # account inside DemoLiveRuntime; any deployment that needs admission
        # receipts must add the remote signer boundary instead.
        "ALLOW_UNSIGNED_WRITES": "0",
        "DATA_DIR": "/app/web2-api/server/data",
        "WEB_ROOT": "/app/web2-api/web/out",
        "CONTRACTS_ROOT": "/app/web3-protocol/contracts",
        # Where the hidden-card duel's proving artifacts and their lock live.
        # The image already defaults this, but the roots the coordinator reads
        # are declared here rather than inherited, so a relocated layout is a
        # one-line change in the same place as WEB_ROOT and CONTRACTS_ROOT.
        # `/config` publishes a `cardCircuits` section only when the lock under
        # this root is readable, and `/artifacts/circuits/**` serves exactly the
        # files that lock names - nothing else under it is reachable.
        "CIRCUITS_ROOT": "/app/web3-protocol/circuits",
    }
    if len(explorer_url) > 0:
        env_vars["DEMO_EXPLORER_URL"] = explorer_url
    if len(queue_url) > 0:
        # Demo checkpoints route through the shared queue; the observable wait
        # semantics of ProvingSlot carry over on top of it.
        env_vars["QUEUE_URL"] = queue_url
        env_vars["ZKDEAL_QUEUE_SUBMIT_TOKEN"] = QUEUE_SUBMIT_TOKEN
    service = plan.add_service(
        name="zkdeal-demo",
        config=ServiceConfig(
            image=image,
            ports={
                "http": PortSpec(
                    number=DEMO_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                    wait="5m",
                ),
            },
            public_ports={
                "http": PortSpec(
                    number=DEMO_PUBLIC_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                ),
            },
            files={"/bootstrap": evidence},
            env_vars=env_vars,
        ),
    )
    plan.wait(
        service_name="zkdeal-demo",
        recipe=GetHttpRequestRecipe(port_id="http", endpoint="/demo/v1/system"),
        field="code",
        assertion="==",
        target_value=200,
        timeout="5m",
    )
    return service
