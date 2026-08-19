# 0009 — Local TLS termination via Caddy + mkcert, not a self-signed cert in Node

## Context

D1 (CLAUDE.md §11): every request, including `POST /auth/login`'s password
field, traveled plaintext `http://` — the server never terminated TLS itself,
and the mobile app connects by LAN IP (`serverUrl.ts`), so there is no public
domain a real CA (Let's Encrypt included) could ever issue a certificate
against. This was named as the top-priority gap before any production
posture, and — reordered ahead of finishing the adversarial-proof phase
(chaos/load/restore) at the owner's confirmation — is closed now rather than
later, since it's both higher-severity and a real dependency for the mobile
certificate-pinning work planned next.

## Decision

A `caddy` service (`docker-compose.yml`) reverse-proxies TLS on `:443` to the
host-run Fastify server (`host.docker.internal:3000`), terminating a
locally-issued [mkcert](https://github.com/FiloSottile/mkcert) certificate
(`caddy/certs/`, gitignored — generated per-machine, never shared) rather
than a self-signed cert generated inline in Node. The `Caddyfile` pins a
Mozilla "Intermediate" compatibility TLS profile (guidelines v6.0) explicitly
rather than trusting Caddy's own defaults to stay aligned with it over time.

**A real bug found and fixed during implementation, not assumed away**: the
Caddyfile's first draft used one site-address matcher per hostname
(`192.168.1.32:443, localhost:443, ...`), which requires Caddy to pick a
certificate via SNI. Direct reproduction — both `curl` and `openssl s_client
-noservername` — showed that a client connecting to an IP-literal host
commonly sends **no SNI at all** (RFC 6066 says SNI shouldn't carry IP
literals in the first place), and Caddy has no site to fall back to for a
no-SNI connection when multiple named site blocks share one listener: it
sends a raw TLS "internal error" alert before the request ever reaches the
HTTP layer, with nothing logged to explain why. Since this proxy only ever
serves one backend, there was never any real ambiguity for SNI to resolve —
the fix is a single bare `:443` address, applying the one certificate to
every connection regardless of what hostname (if any) the client asked for.
This would have silently broken the mobile app's HTTPS connection (it
connects by IP literal) had it not been caught here.

Verified end-to-end against the real running stack, not just `caddy
validate`: a real `POST /auth/login` through the proxy returns a real JWT: a
connection without the mkcert root CA is correctly rejected (`curl: (60)
... unable to get local issuer certificate`); and a genuinely fresh
container (no `caddy/certs/` yet) fails loudly at startup (`Error: loading
initial config: ... open /certs/server.pem: no such file or directory`)
rather than silently serving without TLS or crash-looping unexplained.

## Alternatives considered

- **Self-signed certificate generated in Node, TLS terminated by Fastify
  itself.** Rejected: reinvents cert lifecycle management (expiry, SAN
  updates when the LAN IP changes) that Caddy already solves, and couples
  the app process to certificate concerns it shouldn't need to know about —
  the reverse-proxy seam is exactly where TLS termination belongs, matching
  how a real deployment would front this server anyway (a load balancer or
  ingress, not the app process).
- **`mkcert -install` (system/browser trust store installation).** Not run:
  it needs root and only matters for a desktop browser trusting the cert
  automatically. Nothing here is browser-driven — `curl --cacert` and the
  eventual Android device trust (mobile/DEVICE_TEST_MATRIX.md, Phase 6) both
  reference the root CA file directly instead.
- **Let's Encrypt via a real domain.** Not available: this is a LAN-only dev
  server with no public DNS, so there is nothing for Let's Encrypt's HTTP-01/
  DNS-01 challenges to validate against.

## Consequences

`caddy/certs/` must exist (via the documented `mkcert` command, `Caddyfile`'s
own comment) before `docker compose up caddy` will start — this is
deliberate fail-fast behavior, not a rough edge to smooth over. The
certificate's Subject Alternative Names are pinned to specific IPs unlike a
plain HTTP proxy that doesn't care about the address at all — regenerate it
whenever the dev host's LAN IP changes, same as `serverUrl.ts`'s own
documented tradeoff already required updating for that case.

## Revisit trigger

If this server ever gets a real public domain (a staging/production
deployment, not local dev), replace the mkcert certificate with Caddy's
built-in automatic Let's Encrypt/ZeroSSL management (`auto_https` back on) —
the reverse-proxy architecture doesn't change, only where the certificate
comes from.
