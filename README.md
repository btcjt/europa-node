# europa-node

Reference operator daemon for the **VPN Marketplace** — a brand-neutral
Nostr protocol (CC0) for selling WireGuard tunnels in exchange for
Lightning or Cashu payments. Publishes a NIP-99 (`kind: 30402`)
listing, runs LNURL-pay + Cashu purchase endpoints, generates
WireGuard configs after payment, and manages peer lifecycle on a
host-network WireGuard interface.

Spec: [`docs/spec.md`](docs/spec.md) (CC0). Implementation code: MIT.

This repo is **a template**. Fork it, edit `config.toml`, deploy
however suits you (Docker Compose, systemd, Kubernetes). The
in-repo manifests + Dockerfile are working starting points, not a
managed product.

---

## Quick start (Docker Compose)

Easiest path. On any Linux host with Docker, a public DNS name,
and ~30 minutes:

```bash
# 1. Clone.
git clone https://github.com/btcjt/europa-node
cd europa-node

# 2. Install WireGuard + a tool to generate cryptographic keys.
sudo apt install -y wireguard-tools openssl

# 3. Bootstrap. Generates your Nostr nsec, WireGuard server keypair,
#    Cashu P2PK keypair, and writes a starting ./config/config.toml
#    from a few prompts (public hostname, listing name, etc.).
./scripts/bootstrap.sh

# 4. Bring up the host's WireGuard interface (one-time):
sudo install -m 600 ./secrets/wg-server.key /etc/wireguard/server.key
sudo tee /etc/wireguard/wg0.conf <<'CONF'
[Interface]
PrivateKey = $(cat /etc/wireguard/server.key)
Address    = 10.42.0.1/24
ListenPort = 51820
PostUp     = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown   = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
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
| `wireguard.subnet_cidr` | Tunnel subnet (default `10.42.0.0/24`, 253 peers) |
| `lightning.backend` + `base_url` + `api_token` | phoenixd / LND / stub |
| `cashu.mint_url` + `p2pk_privkey_hex` | Your accepted Cashu mint + lock key |
| `nostr.relays` | Where you publish the listing |
| `nostr.nsec_file` | Path to your operator nsec |
| `listing.title` + `summary` + `prices` + `payment_methods` | What appears in directories |
| `listing.region.country/sub/geohash` | For map-style directories |
| `listing.policies` + `policy_url` | Operator-declared policy |

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

Concrete pre-reqs (NOT just `kubectl apply`):

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
5. **RBAC for your CI/build SA** in `europa-node` namespace —
   [`k8/rbac.yml`](k8/rbac.yml) is the template (replace
   `BUILDER_SA_NAMESPACE` / `BUILDER_SA_NAME`).
6. **Firewall forwards UDP 51820** to the pinned worker.

Once those are in place:

```bash
# Replace placeholders in the manifests, then:
kubectl apply -f k8/namespace.yml
kubectl apply -f k8/rbac.yml
kubectl apply -f k8/referencegrant.yml

# Create secrets from your bootstrap output:
kubectl create secret generic europa-node-nsec \
  --from-file=nsec=./secrets/nsec --namespace europa-node
kubectl create secret generic europa-node-config \
  --from-file=config.toml=./config/config.toml --namespace europa-node

# Build + push your image, sed it into deployment-template.yml, then:
sed "s|IMAGE_PLACEHOLDER|<your-registry>/europa-node:<tag>|g" \
    k8/deployment-template.yml | kubectl apply -f -
kubectl apply -f k8/service.yml
kubectl apply -f k8/httproute.yml

kubectl logs -f -n europa-node deployment/europa-node
```

---

## What this implements (vs the spec)

- ✅ NIP-99 listing publish (kind 30402)
- ✅ BUD-11 authorization (kind 24242)
- ✅ Cashu purchase + P2PK token swap
- ✅ LNURL-pay endpoint (phoenixd or LND-as-stub)
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
