# TLS termination for the presentation stand.
#
# WHY THIS SERVICE EXISTS AT ALL -- do not "simplify" it away:
#
# `crypto.subtle` (SubtleCrypto) is only exposed in a SECURE CONTEXT. A browser
# treats https origins and `localhost` as secure and everything else -- notably
# a plain-http LAN address such as http://192.168.0.11:3100 -- as insecure, so
# on that origin `window.crypto.subtle` is simply `undefined`. `getRandomValues`
# is NOT gated this way, which is why the stand looks healthy right up to the
# point where something actually needs SubtleCrypto.
#
# Two visible features of the hidden-card duel depend on it:
#   * artifact verification -- the card client SHA-256s the ~25.6 MB of circom
#     wasm and Groth16 zkey against `circuits/card-artifacts.lock.json` before
#     it will prove with them. Without SubtleCrypto it reports "crypto.subtle is
#     unavailable, so card artifacts cannot be verified in this runtime".
#   * the encrypted witness export -- AES-256-GCM under a PBKDF2-derived key,
#     both of which are SubtleCrypto primitives and have no fallback.
#
# The coordinator also sends Cross-Origin-Opener-Policy: same-origin and
# Cross-Origin-Embedder-Policy: require-corp on every response (server/src/app.ts).
# Those headers are ignored on an insecure origin, which is the source of the
# COOP warning the browser logs on the plain-http stand.
#
# So: this reverse proxy terminates TLS with a self-signed certificate in front
# of the coordinator and publishes https on a fixed port. Serving the console
# from that origin is what makes the two features above work. It is additive --
# the coordinator's own plain-http port keeps working untouched.

# A stock upstream image with no zkdeal build step or repository-side key
# material. Pin the linux/amd64 manifest: the gateway is part of the recording
# trust boundary, so a moving Alpine/nginx tag must not alter it mid-release.
TLS_GATEWAY_IMAGE = (
    "nginx@sha256:1d40e3eb3bf4f138de1d67193f2aa5309fcaf343eb5ffadbf5e9439de1eb1ebb"
)
# Fixed, not Kurtosis-assigned: the certificate's subjectAltName and the
# DEMO_API_URL handed to the coordinator both have to name this port before the
# gateway exists, so it cannot be discovered after the fact.
TLS_PUBLIC_PORT = 8443
TLS_SERVICE_NAME = "tls-gateway"
# Where the rendered nginx server block is mounted; the start command copies it
# into conf.d so the image's own default.conf (plain http on :80) is replaced.
TLS_CONFIG_MOUNT = "/etc/zkdeal-tls"
TLS_MATERIAL_DIR = "/etc/nginx/tls"

# HTTP/2 is deliberately not enabled: the directive that turns it on moved from
# `listen ... http2` to a standalone `http2 on;` in nginx 1.25.1, so pinning
# either form couples this file to the image's minor version for no benefit --
# a secure context needs TLS, not HTTP/2.
_GATEWAY_CONF = """# Rendered by kurtosis/tls.star. Edit that file, not this one.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen {{.TlsPort}} ssl;
    server_name _;

    ssl_certificate     {{.CertificatePath}};
    ssl_certificate_key {{.PrivateKeyPath}};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:zkdeal:4m;
    ssl_session_timeout 1h;

    # /artifacts/circuits/** serves ~25.6 MB of circom wasm and Groth16 zkey in
    # single responses, and the witness upload path is unbounded by design. Any
    # cap here would truncate a proving artifact and the browser would fail the
    # SHA-256 check against circuits/card-artifacts.lock.json with a message
    # that points at the artifact rather than at this proxy.
    client_max_body_size 0;

    location / {
        proxy_pass http://{{.Upstream}};
        proxy_http_version 1.1;

        # Preserve the client's Host verbatim -- $host drops the :port, and the
        # coordinator's own links and CORS decisions are origin-sensitive.
        proxy_set_header Host              $http_host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  $http_host;

        # WebSocket upgrade for the coordinator's live room bus.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Belt and braces. The coordinator issues no redirects today -- its
        # static plugin runs with the default redirect:false and the SPA
        # fallback answers exported pages in place -- but an absolute Location
        # naming either the upstream or the preserved Host would carry the http
        # scheme and drop the browser back out of the secure context. Only
        # those three shapes are rewritten; naming any proxy_redirect disables
        # the default rule, so every other Location passes through untouched
        # rather than having an unrelated external http link forced to https.
        proxy_redirect http://{{.Upstream}}/  https://$http_host/;
        proxy_redirect https://{{.Upstream}}/ https://$http_host/;
        proxy_redirect http://$http_host/     https://$http_host/;

        # Stream large bodies straight through instead of spooling them to a
        # temp file; proxy_max_temp_file_size 0 also disables the 1 GB default
        # cap that silently truncates a buffered response.
        proxy_buffering          off;
        proxy_request_buffering  off;
        proxy_max_temp_file_size 0;

        proxy_connect_timeout 30s;
        proxy_send_timeout    1h;
        proxy_read_timeout    1h;
    }
}
"""


def https_origin(public_host):
    """The browser-facing origin this gateway publishes.

    Anything the coordinator hands to a page served from here -- DEMO_API_URL
    above all -- must use this scheme and port. A page loaded over https that
    fetches an http API is blocked as mixed content, and the console would fail
    with a network error rather than anything that names the cause.
    """
    return "https://%s:%d" % (public_host, TLS_PUBLIC_PORT)


def start_tls_gateway(plan, public_host, upstream_service, upstream_port):
    """Front `upstream_service` with nginx terminating TLS on TLS_PUBLIC_PORT."""
    config = plan.render_templates(
        name="zkdeal-tls-gateway-config",
        config={
            "gateway.conf": struct(
                template=_GATEWAY_CONF,
                data={
                    "TlsPort": TLS_PUBLIC_PORT,
                    "Upstream": "%s:%d" % (upstream_service, upstream_port),
                    "CertificatePath": "%s/stand.crt" % TLS_MATERIAL_DIR,
                    "PrivateKeyPath": "%s/stand.key" % TLS_MATERIAL_DIR,
                },
            ),
        },
    )
    gateway = plan.add_service(
        name=TLS_SERVICE_NAME,
        config=ServiceConfig(
            image=TLS_GATEWAY_IMAGE,
            entrypoint=["/bin/sh", "-c"],
            cmd=[_start_command(public_host)],
            files={TLS_CONFIG_MOUNT: config},
            ports={
                "https": PortSpec(
                    number=TLS_PUBLIC_PORT,
                    transport_protocol="TCP",
                    application_protocol="https",
                    wait="3m",
                ),
            },
            public_ports={
                "https": PortSpec(
                    number=TLS_PUBLIC_PORT,
                    transport_protocol="TCP",
                    application_protocol="https",
                ),
            },
        ),
    )
    return struct(
        name=gateway.name,
        url=https_origin(public_host),
    )


def _start_command(public_host):
    # The key pair is minted inside the container on every start and never
    # leaves it: no certificate, key or CSR is committed to this repository, and
    # a restarted enclave gets fresh material.
    return "\n".join(
        [
            "set -eu",
            # nginx:alpine links against libssl but does not ship the openssl
            # CLI, so the usual case is that this apk actually runs. It is the
            # one moment this service needs a package mirror; say so plainly
            # instead of failing later with an nginx file-not-found.
            "if ! command -v openssl >/dev/null 2>&1; then",
            "  apk add --no-cache openssl >/dev/null 2>&1 || {",
            "    echo 'Decision: the TLS gateway cannot mint its self-signed certificate.'",
            "    echo 'Blocker: nginx:alpine ships no openssl CLI and the package mirror was unreachable.'",
            "    echo 'Effect: https is unavailable, so crypto.subtle stays undefined and the card duel cannot verify artifacts; the plain-http coordinator port is unaffected.'",
            "    echo 'Next action: give the enclave outbound access to the Alpine mirror, or pin an image that already carries openssl.'",
            "    exit 1",
            "  }",
            "fi",
            "mkdir -p %s" % TLS_MATERIAL_DIR,
            # -addext subjectAltName is the load-bearing flag: browsers stopped
            # reading the certificate's Common Name years ago, and an IP address
            # is rejected outright unless it appears as an IP SAN -- a DNS SAN
            # holding the same digits does not count.
            "openssl req -x509 -nodes -newkey rsa:2048 -days 3650"
            + " -subj '/CN=%s'" % public_host
            + " -addext 'subjectAltName=%s'" % _subject_alt_names(public_host)
            + " -addext 'extendedKeyUsage=serverAuth'"
            + " -keyout %s/stand.key" % TLS_MATERIAL_DIR
            + " -out %s/stand.crt" % TLS_MATERIAL_DIR
            + " >/dev/null 2>&1",
            "chmod 600 %s/stand.key" % TLS_MATERIAL_DIR,
            "cp %s/gateway.conf /etc/nginx/conf.d/default.conf" % TLS_CONFIG_MOUNT,
            "echo 'Decision: serving the stand over https so crypto.subtle is available to the card duel.'",
            "exec nginx -g 'daemon off;'",
        ]
    )


def _subject_alt_names(public_host):
    # Derived from public_host rather than hard-coded, so moving the stand to
    # another LAN address is the same one-line params change it already is.
    names = ["DNS:localhost", "IP:127.0.0.1"]
    entry = ("IP:%s" if _is_ipv4(public_host) else "DNS:%s") % public_host
    if entry not in names:
        names.append(entry)
    return ",".join(names)


def _is_ipv4(value):
    parts = value.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        # lstrip over the digit set empties any all-digit part; anything left
        # over means a non-digit character, which openssl would reject as an IP.
        if len(part) == 0 or len(part) > 3 or part.lstrip("0123456789") != "":
            return False
        if int(part) > 255:
            return False
    return True
