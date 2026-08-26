# Always-on observability for the presentation stand: one Prometheus and one
# anonymous read-only Grafana.
#
# Both observers are CPU-only, so they take nothing from the single-GPU budget
# the prover owns. They start BEFORE the blocking bootstrap on purpose: the
# 45-minute acceptance run is exactly the window an operator wants to watch
# live - L1 slots ticking, the prover warming, the queue draining - instead of
# staring at a silent `kurtosis run` for three quarters of an hour.
#
# The scrape interval is 5 s, deliberately slower than anything it observes:
# the repository's fastest emission cadence is the 0.5 s batching floor (SSE
# coalescing is 500 ms and the prover's GPU probe caches for 2 s), so no target
# is ever polled more often than it can produce new data. Targets that do not
# exist yet - the coordinator appears only after the bootstrap - simply show as
# down until they come up; that, too, is information during startup.

# The observers are part of what an operator sees and screenshots during a
# recorded acceptance run, so their bytes must not drift when an upstream tag
# moves between image build and enclave launch - the same reasoning as the
# Blockscout pins in main.star. The digest is what the runtime resolves; the
# tag stays alongside it purely as human-readable provenance.
PROMETHEUS_IMAGE = "prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996"
GRAFANA_IMAGE = "grafana/grafana:12.1.0@sha256:6ac590e7cabc2fbe8d7b8fc1ce9c9f0582177b334e0df9c927ebd9670469440f"

PROMETHEUS_PORT = 9090
# Fixed, not Kurtosis-assigned: the runner scripts and docs/OBSERVABILITY.md
# name these host ports before the enclave exists, so they cannot be discovered
# after the fact - the same reasoning as TLS_PUBLIC_PORT in tls.star.
PROMETHEUS_PUBLIC_PORT = 9090
GRAFANA_PORT = 3000
# 3300, not Grafana's native 3000: the host's 3000 is already held by the
# upstream blockscout-frontend the ethereum-package publishes, with the demo on
# 3100 and this package's own explorer on 3200.
GRAFANA_PUBLIC_PORT = 3300
# Where the rendered scrape config is mounted; --config.file below points here.
PROMETHEUS_CONFIG_MOUNT = "/etc/zkdeal-prometheus"

# In-enclave scrape targets as (job, target, metrics_path) - an empty path
# means Prometheus's default /metrics. The zkdeal ports mirror DEMO_PORT,
# PROVER_PORT and QUEUE_PORT in main.star; importing main.star from here would
# be circular (it imports this module), so the two files must move together.
# The L1 names and ports are the ethereum-package's single-participant
# geth/Lighthouse services.
_SCRAPE_JOBS = [
    ("l1-geth", "el-1-geth-lighthouse:9001", "/debug/metrics/prometheus"),
    ("l1-lighthouse", "cl-1-lighthouse-geth:5054", ""),
    ("l1-validator", "vc-1-geth-lighthouse:8080", ""),
    ("zkdeal-demo", "zkdeal-demo:3000", "/metrics"),
    ("prover", "risc0-cuda-prover:8080", "/metrics"),
]
_QUEUE_SCRAPE_JOB = ("prove-queue", "prove-queue:3005", "/metrics")


def _prometheus_config(prove_queue):
    """Assemble prometheus.yml as a plain Starlark string.

    Assembled here rather than in a Go template: the queue job is conditional,
    and a Starlark `if` costs nothing while a `{{if}}` in a YAML template costs
    escaping pain. render_templates then treats the result as a template with
    no substitutions.
    """
    lines = [
        "# Rendered by kurtosis/observability.star. Edit that file, not this one.",
        "global:",
        "  scrape_interval: 5s",
        "  scrape_timeout: 4s",
        "",
        "scrape_configs:",
    ]
    jobs = list(_SCRAPE_JOBS)
    if prove_queue:
        jobs.append(_QUEUE_SCRAPE_JOB)
    for job in jobs:
        lines.append("  - job_name: %s" % job[0])
        if job[2] != "":
            lines.append("    metrics_path: %s" % job[2])
        lines.append("    static_configs:")
        lines.append('      - targets: ["%s"]' % job[1])
    return "\n".join(lines) + "\n"


def start_observability(plan, public_host, prove_queue):
    """Start Prometheus and Grafana; return their operator-facing URLs."""
    config = plan.render_templates(
        name="zkdeal-prometheus-config",
        config={
            "prometheus.yml": struct(
                template=_prometheus_config(prove_queue),
                data={},
            ),
        },
    )
    plan.add_service(
        name="prometheus",
        config=ServiceConfig(
            image=PROMETHEUS_IMAGE,
            cmd=[
                "--config.file=%s/prometheus.yml" % PROMETHEUS_CONFIG_MOUNT,
                "--storage.tsdb.path=/prometheus",
                # A presentation stand's history is a working session, not an
                # archive; three days outlives any recording weekend without
                # letting the TSDB grow unbounded on a long-lived enclave.
                "--storage.tsdb.retention.time=3d",
            ],
            files={PROMETHEUS_CONFIG_MOUNT: config},
            ports={
                "http": PortSpec(
                    number=PROMETHEUS_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                    wait="3m",
                )
            },
            public_ports={
                "http": PortSpec(
                    number=PROMETHEUS_PUBLIC_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                )
            },
        ),
    )
    plan.wait(
        service_name="prometheus",
        recipe=GetHttpRequestRecipe(port_id="http", endpoint="/-/ready"),
        field="code",
        assertion="==",
        target_value=200,
        timeout="3m",
    )
    plan.add_service(
        name="grafana",
        config=ServiceConfig(
            image=GRAFANA_IMAGE,
            env_vars={
                # Anonymous and read-only: a visitor on the LAN can watch every
                # dashboard but can neither log in nor edit, so the stand needs
                # no Grafana credential of any standing.
                "GF_AUTH_ANONYMOUS_ENABLED": "true",
                "GF_AUTH_ANONYMOUS_ORG_ROLE": "Viewer",
                "GF_AUTH_DISABLE_LOGIN_FORM": "true",
                "GF_USERS_ALLOW_SIGN_UP": "false",
                "GF_ANALYTICS_REPORTING_ENABLED": "false",
            },
            files={
                "/etc/grafana/provisioning/datasources": plan.upload_files(
                    "./observability/grafana/datasources",
                    name="zkdeal-grafana-datasources",
                ),
                "/etc/grafana/provisioning/dashboards": plan.upload_files(
                    "./observability/grafana/providers",
                    name="zkdeal-grafana-providers",
                ),
                "/var/lib/grafana/dashboards": plan.upload_files(
                    "./observability/grafana/dashboards",
                    name="zkdeal-grafana-dashboards",
                ),
            },
            ports={
                "http": PortSpec(
                    number=GRAFANA_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                    wait="3m",
                )
            },
            public_ports={
                "http": PortSpec(
                    number=GRAFANA_PUBLIC_PORT,
                    transport_protocol="TCP",
                    application_protocol="http",
                )
            },
        ),
    )
    plan.wait(
        service_name="grafana",
        recipe=GetHttpRequestRecipe(port_id="http", endpoint="/api/health"),
        field="code",
        assertion="==",
        target_value=200,
        timeout="3m",
    )
    return struct(
        prometheus_url="http://%s:%d" % (public_host, PROMETHEUS_PUBLIC_PORT),
        grafana_url="http://%s:%d" % (public_host, GRAFANA_PUBLIC_PORT),
    )
