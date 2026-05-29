# europa-node

Reference operator daemon for the **Europa Protocol** — an open Nostr
protocol (CC0) for selling WireGuard tunnels in exchange for Lightning
or Cashu payments. Publishes a NIP-99 (`kind: 30402`) listing, runs
LNURL-pay + Cashu purchase endpoints, generates WireGuard configs
after payment, and manages peer lifecycle on a host-network WireGuard
interface.

(The protocol was previously named "VPN Marketplace"; the rename
landed in europa-node 0.7.0. Operators running older builds — which
still publish under the legacy `t: vpn-marketplace` tag — remain
visible to conformant directories during a transition window. See
[§11.1 of `docs/spec.md`](docs/spec.md#111-legacy-tag-back-compat)
for the migration detail.)

Spec: [`docs/spec.md`](docs/spec.md) (CC0). Implementation code: MIT.

This repo is **a template**. Fork it, edit `config.toml`, deploy
however suits you (Docker Compose, systemd, Kubernetes). The
in-repo manifests + Dockerfile are working starting points, not a
managed product.

---

## System requirements

- **Linux host** with a public IPv4. WireGuard kernel module (default
  on Linux ≥ 5.6).
- **1 vCPU, 1 GB RAM, 10 GB disk** — minimum, runs the daemon +
  phoenixd up to ~100 Mbps sustained.
- **2 vCPU, 2 GB RAM, 25 GB disk** — comfortable for 1 Gbps + several
  hundred active peers + Lightning and ecash side-by-side.
- **Bandwidth**: VPN traffic is sustained. 100 Mbps = ~32 TB/month, 1
  Gbps = ~324 TB/month. Pick a VPS plan with enough quota or an
  unmetered provider.
- **Concurrent peers**: capped by the WireGuard subnet —
  `10.66.42.0/24` (default) holds 253; widen to `/22` for ~1,000 or
  `/16` for ~65k. Kernel WireGuard handles thousands of peers per
  interface; bandwidth is what runs out first.

Full sizing + tradeoffs: [`docs/spec.md` §7](docs/spec.md#7-hosting-considerations).

---

## Quick start (Docker Compose)

Easiest path. On any Linux host with Docker, a public DNS name,
and ~30 minutes:

```bash
# 1. Clone.
git clone https://github.com/btcjt/europa-node
cd europa-node

# 2. Install WireGuard + key-gen tools. `node` is optional but lets
#    bootstrap.sh auto-derive the Cashu P2PK pubkey; without it
#    you'll have to derive that one value manually.
sudo apt install -y wireguard-tools openssl nodejs   # Debian/Ubuntu
# brew install wireguard-tools openssl node          # macOS

# 3. Bootstrap. Generates your Nostr nsec, WireGuard server keypair,
#    Cashu P2PK keypair, and writes a starting ./config/config.toml
#    from a few prompts (public hostname, listing name, etc.).
./scripts/bootstrap.sh

# 4. Bring up the host's WireGuard interface (one-time):
#    Detect the egress interface from the default route — it's `eth0`
#    on most cloud VMs but `enp0s31f6` / `wlp3s0` / etc. on bare metal
#    and `ens5` on AWS Nitro. Hardcoding `eth0` breaks MASQUERADE on
#    every other host.
DEFIFACE=$(ip route show default | awk '{print $5; exit}')
sudo install -m 600 ./secrets/wg-server.key /etc/wireguard/server.key
sudo tee /etc/wireguard/wg0.conf <<CONF
[Interface]
PrivateKey = $(sudo cat /etc/wireguard/server.key)
Address    = 10.66.42.1/24
ListenPort = 51820
PostUp     = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $DEFIFACE -j MASQUERADE
PostDown   = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $DEFIFACE -j MASQUERADE
CONF
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-wg.conf
sudo sysctl -p /etc/sysctl.d/99-wg.conf
sudo systemctl enable --now wg-quick@wg0

# 5. Start the daemon + Caddy (auto-renewing TLS).
docker compose up -d --build

# 6. Watch the logs.
docker compose logs -f europa-node
```

Within ~30 seconds you'll see `event: listing-published` in the
log and your operator shows up in any directory that subscribes to
the protocol.

**Firewall checklist**:

- UDP 51820 (or whatever you set in `[wireguard].endpoint_port`)
  open to the public internet — that's how clients reach the tunnel.
- TCP 80 + 443 open — Caddy needs them for Let's Encrypt + serving
  the operator HTTP API.
- DNS A record for your `public_host` pointing at this machine's
  public IP.

---

## How it works

```
                ┌──────────────────────────┐
                │  Operator (you)          │
                │  ----------------------  │
                │  1. Publishes kind-30402 │
                │     listing to Nostr     │
                │     relays.              │
                │  2. Receives BUD-11      │
                │     auth + Cashu token   │
                │     / Lightning payment. │
                │  3. Adds the buyer as a  │
                │     wg0 peer, returns a  │
                │     wg0.conf.            │
                │  4. Expiry watcher       │
                │     removes the peer     │
                │     when their bundle    │
                │     runs out.            │
                └──────────────────────────┘
                            ▲
                            │  HTTPS (caddy / Gateway)
                            │  /lnurlp, /purchase, /info, /health
                            │
              ┌─────────────┴─────────────┐
              │  Buyer's Nostr client     │
              │  - browses listings via   │
              │    `kind: 30402` events   │
              │  - signs BUD-11 auth      │
              │    event (kind 24242)     │
              │  - locks Cashu token to   │
              │    operator's P2PK or     │
              │    pays the LNURL invoice │
              │  - imports wg0.conf into  │
              │    WireGuard              │
              └───────────────────────────┘

                            ▲
                            │  UDP 51820 (WireGuard tunnel)
                            ▼
                ┌──────────────────────────┐
                │  Buyer's device → Internet
                │  via operator's NAT
                └──────────────────────────┘
```

Wire shape, event kinds, payload formats, and operator semantics:
[`docs/spec.md`](docs/spec.md).

---

## Configuration

All operator-tunable knobs live in one TOML file. `bootstrap.sh`
writes a customized copy to `./config/config.toml` based on your
prompts. The full reference (every field, every option,
comment-documented) is [`config.example.toml`](config.example.toml).

Key fields:

| Field | Purpose |
| ----- | ------- |
| `server.public_host` | Your hostname (must resolve publicly + match TLS cert) |
| `wireguard.endpoint_host` / `endpoint_port` | What clients dial |
| `wireguard.subnet_cidr` | Tunnel subnet (default `10.66.42.0/24`, /24 = 253 peers). Must not collide with `cni0` (K3s' Flannel defaults to `10.42.0.0/24` — silently breaks return routing if you reuse it), `docker0` (`172.17.0.0/16`), Tailscale (`100.64.0.0/10`), or your home LAN. |
| `lightning.backend` + `base_url` + `api_token` | phoenixd / LND / stub |
| `cashu.enabled` + `p2pk_privkey_hex` | Turn Cashu on + the one lock key (covers every mint you accept) |
| `nostr.relays` | Where the listing **and the operator wallet's token events** publish |
| `nostr.nsec_file` | Path to your operator nsec (also the key for the operator wallet) |
| `notifications.enabled` + `pubkey` + `heartbeat_hours` | Optional NIP-17 DMs to you on every sale + a balance heartbeat. `pubkey` is the recipient — your personal npub/hex, not the node's. Off by default. |
| `listing.title` + `summary` + `prices` + `payment_methods` | What appears in directories. Multiple `cashu` payment-method blocks = multiple accepted mints; buyers pick one. |
| `listing.region.country/sub/geohash` | For map-style directories |
| `listing.policies` + `policy_url` | Operator-declared policy |

### Where your Cashu earnings go

When Cashu is enabled the daemon keeps received ecash in a **NIP-60
wallet** under the same nsec that signs your listing — auto-created
on first start. The earnings are encrypted token events on your
relays (off-box backup). To withdraw, open the wallet in any NIP-60
client (e.g. a directory site's wallet page) by signing in with this
node's nsec. The daemon has no payout endpoint; it only receives.
The daemon refuses to start if Cashu is enabled but the wallet can't
be established. Lightning purchases settle straight to your Lightning
backend and don't touch the NIP-60 wallet.

---

## Other deploy paths

### systemd (no Docker)

The daemon is a single Node 20 process. If you'd rather skip
Docker entirely:

```bash
pnpm install
pnpm build          # produces dist/index.cjs
EUROPA_NODE_CONFIG=./config/config.toml node dist/index.cjs
```

A simple unit file:

```ini
[Unit]
Description=europa-node
After=network.target wg-quick@wg0.service
Requires=wg-quick@wg0.service

[Service]
ExecStart=/usr/bin/node /opt/europa-node/dist/index.cjs
Environment=EUROPA_NODE_CONFIG=/opt/europa-node/config/config.toml
Restart=on-failure
User=root  # NET_ADMIN required for wg set; constrain via systemd CapabilityBoundingSet if you prefer

[Install]
WantedBy=multi-user.target
```

### Kubernetes

The K8s path has real extra constraints vs Docker Compose. Read
through [`k8/`](k8/) before applying — there are placeholders to
replace.

#### Pre-reqs (NOT just `kubectl apply`)

1. **`wireguard-tools` installed on the pinned node** and
   `systemctl enable --now wg-quick@wg0` already done. The pod
   can `wg set peer …` against an existing `wg0` (NET_ADMIN) but
   doesn't create the interface itself.
2. **`wireguard` kernel module** present (mainline since Linux 5.6 —
   `modinfo wireguard` resolves on Ubuntu 22.04+, Debian 12+).
3. **A namespace with `pod-security.kubernetes.io/enforce: privileged`**.
   The daemon needs `hostNetwork` + `NET_ADMIN` + `hostPath` +
   `hostPort 51820`, all of which violate `baseline` PSA.
   [`k8/namespace.yml`](k8/namespace.yml) creates this.
4. **A `Gateway` (Gateway API)** for HTTPS termination — the
   manifests use Gateway API HTTPRoute, not legacy Ingress. The
   HTTPRoute lives in your Gateway's namespace because most
   Gateways enforce same-namespace allowedRoutes; the
   [`k8/referencegrant.yml`](k8/referencegrant.yml) lets it
   cross-namespace-reference the Service.
5. **(Optional) RBAC for your CI/build ServiceAccount** in `europa-node`
   namespace — [`k8/rbac.yml`](k8/rbac.yml) is the template. Only
   needed if a CI Job applies these manifests on your behalf from a
   *different* namespace. If you `kubectl apply` from your laptop
   with cluster-admin, skip this file entirely.
6. **Firewall forwards UDP 51820** to the pinned worker.

#### Placeholders to replace before applying

| File | Placeholder | Replace with |
| ---- | ----------- | ------------ |
| [`k8/deployment-template.yml`](k8/deployment-template.yml) | `REPLACE_WITH_YOUR_WG_HOST` | Hostname of the worker running `wg-quick@wg0` (matches `kubernetes.io/hostname` label, often the node's hostname). |
| [`k8/deployment-template.yml`](k8/deployment-template.yml) | `IMAGE_PLACEHOLDER` | Either `<your-registry>/europa-node:<tag>` (multi-node clusters) or `docker.io/library/europa-node:test` (single-node K3s with a local-built image — see below). |
| [`k8/deployment-template.yml`](k8/deployment-template.yml) | `imagePullSecrets: - name: registry-credentials` | Delete the whole stanza if you're using a public image or a locally-imported one. |
| [`k8/httproute.yml`](k8/httproute.yml) | `REPLACE_WITH_YOUR_GATEWAY_NAMESPACE` | Namespace your Gateway resource lives in (e.g. `default`, `envoy-gateway-system`). |
| [`k8/httproute.yml`](k8/httproute.yml) | `REPLACE_WITH_YOUR_GATEWAY_NAME` | `.metadata.name` of your Gateway. |
| [`k8/httproute.yml`](k8/httproute.yml) + [`k8/referencegrant.yml`](k8/referencegrant.yml) | `REPLACE_WITH_YOUR_PUBLIC_HOSTNAME` (httproute) / `REPLACE_WITH_YOUR_GATEWAY_NAMESPACE` (refgrant) | Your operator's public hostname (matches `config.server.public_host`) / your Gateway's namespace. |
| [`k8/rbac.yml`](k8/rbac.yml) | `REPLACE_WITH_BUILDER_SA_NAME` / `..._NAMESPACE` | Only if you're using a CI builder; otherwise skip the whole file. |

#### Image: where it comes from

The Deployment's `image:` field has to resolve from inside the
cluster. Two common paths:

- **Multi-node cluster with a registry**: `docker build`, `docker push`
  to a registry the cluster can pull from, then point `IMAGE_PLACEHOLDER`
  at the resulting `<registry>/europa-node:<tag>`. Add a
  `kubernetes.io/dockerconfigjson` Secret named `registry-credentials`
  in `europa-node` namespace if the registry is private (otherwise
  delete the `imagePullSecrets` stanza).
- **Single-node K3s with no registry** (fastest local-test path):

  ```bash
  # On the K3s node itself (which is also where the daemon will run).
  cd europa-node
  sudo docker build -t europa-node:test .
  sudo docker save europa-node:test -o /tmp/europa-node-test.tar
  sudo k3s ctr images import /tmp/europa-node-test.tar
  # Then in deployment-template.yml use:
  #   image: docker.io/library/europa-node:test
  # and DELETE the `imagePullSecrets` stanza.
  ```

  `k3s ctr` is the K3s-bundled containerd CLI. Importing here makes
  the image visible to K3s' pull-by-name without an actual registry
  round-trip.

#### Concrete sequence

```bash
# 1. Apply the namespace + the cross-namespace ReferenceGrant + Service.
kubectl apply -f k8/namespace.yml
kubectl apply -f k8/referencegrant.yml
kubectl apply -f k8/service.yml
# (rbac.yml — only if you have an out-of-namespace CI builder)

# 2. Create secrets from your bootstrap output. Paths match what
#    ./scripts/bootstrap.sh wrote.
kubectl create secret generic europa-node-nsec \
  --from-file=nsec=./secrets/nsec --namespace europa-node
kubectl create secret generic europa-node-config \
  --from-file=config.toml=./config/config.toml --namespace europa-node

# 3. Replace placeholders in deployment-template.yml + httproute.yml
#    using the table above. Then:
kubectl apply -f k8/deployment-template.yml
kubectl apply -f k8/httproute.yml

# 4. Watch the daemon come up.
kubectl logs -f -n europa-node deployment/europa-node
```

You'll see `event: 'listing-published'` within ~10 seconds of the
pod becoming Ready. After that, your operator should appear in any
directory site that subscribes to your published relays (e.g.
[europa.westernbtc.com/operators](https://europa.westernbtc.com/operators)).

#### Verifying the deploy

```bash
# /info reachable over HTTPS through the Gateway:
curl -s https://your-hostname.example/info | jq .

# CORS allows browser-based directories (a non-zero
# Access-Control-Allow-Origin must echo your Origin):
curl -sI -H "Origin: https://europa.westernbtc.com" \
  https://your-hostname.example/info | grep -i access-control

# Open the self-diagnose page on any directory site (replace npub +
# d-tag with yours; npub comes from your nsec):
#   https://europa.westernbtc.com/operators/diagnose?npub=npub1…&d=<your-d-tag>
```

The diagnose page runs 8 checks (listing-present, listing-shape,
cashu-method, endpoint-url, p2pk-format, /info reachable, /info-vs-listing
match, mint reachable) and tells the operator-side hint for any
that fail.

---

## What this implements (vs the spec)

- ✅ NIP-99 listing publish (kind 30402)
- ✅ BUD-11 authorization (kind 24242)
- ✅ Cashu purchase + P2PK token swap, **multiple mints per operator**
- ✅ Received ecash kept in a **NIP-60 wallet** under the operator nsec
- ✅ LNURL-pay endpoint (phoenixd or LND-as-stub)
- ✅ `/info` self-description (software, version, mints, listing snapshot)
- ✅ Permissive CORS (cross-origin buyers / directories / clients)
- ✅ WireGuard peer lifecycle (`wg set peer`)
- ✅ Session expiry + automatic peer removal
- ✅ Bandwidth accounting (per-peer wg counters)
- ⏳ OpenVPN — protocol allows it, this implementation is WireGuard-only
- ⏳ Multi-region / multi-listing — one daemon = one listing today

Operator-side OpenVPN + multi-region are documented in the spec but
not implemented here. Pull requests welcome.

---

## Common gotchas

- **NDK + Node needs `websocket-polyfill` as the first import** —
  already wired in [`src/index.ts`](src/index.ts). Don't re-order
  the imports; without it `ndk.connect()` silently fails to
  connect any relay and the listing-publish reports `0 published`.
- **If your home relay has a write-policy** (whitelisted authors,
  paid relays, etc.), make sure your operator pubkey is allowed
  before launching, or kind-30402 publishes will be rejected.
- **From a hostNetwork pod, your own public hostname may not loop
  back cleanly** (hairpin NAT). If your home relay runs in the
  same cluster, publish via the cluster-internal service URL
  (`ws://relay.<ns>.svc.cluster.local:7777`) instead of the public
  `wss://relay.example.com`.
- **Cashu mint and operator's P2PK lock must match the published
  listing**. Mismatches give the buyer `wrong-mint` / `wrong-p2pk`
  errors and look like operator misconfiguration to anyone
  troubleshooting.
- **Cashu enabled ⇒ the daemon needs a reachable relay at startup.**
  The operator's NIP-60 wallet (where received ecash is stored) is
  loaded-or-created from your `nostr.relays` when the process boots;
  if Cashu is on and no relay answers, the daemon **fails closed and
  exits** rather than take payments it can't keep. If startup logs
  show the wallet couldn't be established, fix relay reachability
  before retrying — don't disable the check.
- **CORS must be open** — the marketplace is intentionally cross-origin
  and every browser-based directory will fetch your `/info` and
  `/purchase` from a different origin. europa-node already sends
  `Access-Control-Allow-Origin: *` via `@fastify/cors`; if you front
  it with a reverse proxy that strips headers, re-add them. See
  [`docs/spec.md` §3.1 CORS requirement](docs/spec.md#cors-requirement)
  for nginx/Caddy snippets.
- **`PostUp ... -o eth0 -j MASQUERADE` will silently no-op on most
  hosts**. `eth0` is the right interface only on certain cloud VMs;
  bare-metal and AWS Nitro use `enp0s31f6` / `wlp3s0` / `ens5` etc.
  Detect with `ip route show default | awk '{print $5; exit}'` and
  use that. The Quick start above does it dynamically.
- **Don't reuse a CIDR that's already on the host.** The default
  `subnet_cidr` is `10.66.42.0/24` for a reason — the obvious-looking
  `10.42.0.0/24` collides with K3s' Flannel pod network and silently
  breaks return routing (handshake succeeds, client sends KiB, only
  the keepalive comes back). If you change the subnet, verify with
  `ip route show` that nothing else on the host already claims it.
- **K8s `kubectl apply` Warning about PodSecurity** — you'll see
  *"would violate PodSecurity 'baseline:latest'"* when applying the
  Deployment. That's the namespace's *warn* setting talking; the
  *enforce* setting is `privileged`, which the Deployment satisfies.
  The pod runs fine. To silence: drop the `audit: baseline` /
  `warn: baseline` labels in [`k8/namespace.yml`](k8/namespace.yml).

---

## Development

```bash
pnpm install
pnpm dev          # hot-reload via tsx
pnpm test         # vitest (ipPool, wireguard, configGen)
pnpm check-types  # tsc --noEmit
pnpm build        # esbuild bundle → dist/index.cjs
```

The protocol primitives (NIP-99 parser, BUD-11 helpers, NIP-51/56
aggregation, geohash decode) are inlined under
[`src/protocol/`](src/protocol/). The wire spec is canonical; this
folder is a faithful TypeScript implementation of it.

---

## License

Code: **MIT** ([`LICENSE`](LICENSE)).
Spec ([`docs/spec.md`](docs/spec.md)): **CC0** (public domain).
Other operators may implement the protocol in any language without
inheriting the MIT terms.
