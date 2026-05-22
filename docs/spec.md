# VPN Marketplace: Operator Setup Specification

**Status:** Draft v1
**Audience:** Implementing team / operators who want to run a node
**License:** CC0 (spec), MIT (reference code)

---

## 0. What This Covers

This document specifies what an operator needs to do to participate in the marketplace. It complements the main marketplace spec by detailing the server side: how to set up the VPN server, how to publish listings, how to accept payments, how to deliver configs, how to enforce time/data limits, and how to keep the operation running reliably.

Two VPN protocols are covered: WireGuard (recommended) and OpenVPN (legacy compatibility). Two payment paths are covered: Lightning (via LNURL-pay) and Cashu (via X-Cashu HTTP header).

The spec aims to be concrete enough that someone with basic Linux sysadmin skills can build a working operator node from this document plus the main marketplace spec.

---

## 1. System Architecture

An operator runs three components, typically on the same machine:

| Component              | Role                                                          | Reference implementation                                                                 |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| VPN server             | Accepts client connections, routes traffic                    | `wireguard-tools` or `openvpn` (standard packages)                                       |
| Operator daemon        | Publishes listings, handles purchases, manages peer lifecycle | Custom (this spec)                                                                       |
| Lightning/Cashu wallet | Receives payments                                             | `phoenixd`/`lnd`/`cln` for Lightning; `nutshell` or any Cashu mint integration for Cashu |

For small operators, all three components run on one VPS or home server. For larger operators, they may be separated.

```
                        Internet
                            |
                   [VPN server :51820/1194]
                            |
                       [Linux host]
                            |
                  [Operator daemon :443]
                       |        |
              [Lightning]    [Cashu wallet]
```

The operator daemon is the new piece. The VPN server and the wallet are existing software.

---

## 2. VPN Server Setup

### 2.1 WireGuard (recommended)

WireGuard is the modern default. Lower latency, simpler config, cross-platform clients are excellent.

**Install:**

On Debian/Ubuntu:

```bash
apt install wireguard wireguard-tools
```

On Alpine:

```bash
apk add wireguard-tools
```

**Generate server keys:**

```bash
umask 077
mkdir -p /etc/wireguard
wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub
```

**Create base configuration** at `/etc/wireguard/wg0.conf`:

```ini
[Interface]
PrivateKey = <contents of /etc/wireguard/server.key>
Address = 10.66.42.1/24
ListenPort = 51820

# IP forwarding and NAT
PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Peers are added dynamically by the operator daemon
```

Replace `eth0` with the host's actual external interface (`ip route show default` to find it).

The `10.66.42.0/24` choice is deliberate: it avoids the most common collision, K3s' Flannel CNI defaults to `10.42.0.0/24` for the pod network and the older recipe of `Address = 10.42.0.1/24` here silently breaks return routing (the kernel has both `wg0` and `cni0` claiming the same /24, and client reply packets get matched to `cni0`). Pick any private CIDR you like that's free on your host; just check `ip route show` first.

**Enable IP forwarding:**

```bash
echo 'net.ipv4.ip_forward = 1' >> /etc/sysctl.d/99-wg.conf
echo 'net.ipv6.conf.all.forwarding = 1' >> /etc/sysctl.d/99-wg.conf
sysctl -p /etc/sysctl.d/99-wg.conf
```

**Start the interface:**

```bash
systemctl enable --now wg-quick@wg0
```

**Firewall:** open UDP 51820 to the world.

```bash
# example with ufw
ufw allow 51820/udp
ufw allow 443/tcp   # for the operator daemon's HTTPS endpoint
```

### 2.2 OpenVPN (optional)

OpenVPN is older and slower but has compatibility with corporate VPN clients and odd platforms.

**Install:**

```bash
apt install openvpn easy-rsa
```

**Initialize PKI:**

```bash
make-cadir /etc/openvpn/server/easy-rsa
cd /etc/openvpn/server/easy-rsa
./easyrsa init-pki
./easyrsa build-ca nopass
./easyrsa gen-req server nopass
./easyrsa sign-req server server
./easyrsa gen-dh
openvpn --genkey --secret /etc/openvpn/server/ta.key
```

**Server config** at `/etc/openvpn/server/server.conf`:

```
port 1194
proto udp
dev tun

ca   /etc/openvpn/server/easy-rsa/pki/ca.crt
cert /etc/openvpn/server/easy-rsa/pki/issued/server.crt
key  /etc/openvpn/server/easy-rsa/pki/private/server.key
dh   /etc/openvpn/server/easy-rsa/pki/dh.pem
tls-auth /etc/openvpn/server/ta.key 0

server 10.43.0.0 255.255.255.0
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 1.1.1.1"
push "dhcp-option DNS 9.9.9.9"

# Use script to handle client connections
script-security 2
client-connect /etc/openvpn/server/client-connect.sh
client-disconnect /etc/openvpn/server/client-disconnect.sh

# We use CRL to revoke clients when their time/data expires
crl-verify /etc/openvpn/server/easy-rsa/pki/crl.pem

keepalive 10 120
cipher AES-256-GCM
auth SHA256
user nobody
group nogroup
persist-key
persist-tun
verb 3
```

Generate an initial empty CRL:

```bash
cd /etc/openvpn/server/easy-rsa
./easyrsa gen-crl
cp pki/crl.pem /etc/openvpn/server/
chmod 644 /etc/openvpn/server/crl.pem
```

**Enable IP forwarding** as above.

**Start:**

```bash
systemctl enable --now openvpn-server@server
```

**Firewall:** UDP 1194.

### 2.3 What the operator daemon will manage

The daemon controls the VPN server through standard interfaces:

- **WireGuard:** `wg set wg0 peer <pubkey> allowed-ips <ip>/32` to add peers, `wg set wg0 peer <pubkey> remove` to remove them.
- **OpenVPN:** generate client certificates by running `easyrsa build-client-full <name> nopass`, revoke by running `easyrsa revoke <name>` and regenerating the CRL.

Operator daemon never directly edits VPN server config files. It uses the management commands so the running server doesn't need restarts.

---

## 3. Operator Daemon

The daemon is a small HTTP server that exposes one or more payment endpoints, watches for incoming payments, manages VPN peer lifecycle, and publishes/refreshes the Nostr listing.

### 3.1 Endpoints

All endpoints served over HTTPS on a domain the operator controls (e.g. `vpn.operator.example`). TLS termination via Caddy, Nginx, or Traefik in front; the daemon itself can be plain HTTP on localhost.

| Endpoint           | Method | Purpose                                    |
| ------------------ | ------ | ------------------------------------------ |
| `/lnurlp`          | GET    | LNURL-pay metadata (BOLT-LNURL standard)   |
| `/lnurlp/callback` | GET    | LNURL-pay invoice generation               |
| `/purchase`        | POST   | Cashu purchase endpoint (X-Cashu + BUD-11) |
| `/info`            | GET    | Daemon self-description as JSON (software, version, mints, listing snapshot) |
| `/health`          | GET    | Health check for monitoring                |

#### `/info` response shape <a id="info-endpoint"></a>

`/info` is the daemon's introspection JSON. Buyers and directory sites hit it to (a) verify the operator pubkey matches the listing they're looking at, (b) discover the concrete mint + endpoint URLs without parsing NIP-99 `payment` tags, and (c) tell which operator-daemon implementation and spec revision they're talking to (relevant once there's more than one).

Required fields:

```json
{
  "software": "europa-node",
  "version": "0.2.0",
  "spec_version": "vpn-marketplace/1",

  "pubkey": "<hex 32-byte operator pubkey>",
  "endpoint": "vpn.operator.example",

  "title": "...",
  "summary": "...",
  "protocols": ["wireguard"],
  "region": { "country": "US", "sub": "US-FL", "geohash": "dhvr5" },
  "prices": [ { "amount": 100, "currency": "sat", "unit": "hour" } ],
  "policies": ["no-logs"],

  "payment_methods": ["lightning", "cashu"],
  "mints": ["https://mint.example.com"],
  "cashu_purchase_endpoints": ["https://vpn.operator.example/purchase"],
  "lightning_endpoints": ["https://vpn.operator.example/lnurlp"]
}
```

Optional fields: `content` (the long-form Markdown body the listing also carries), `policy_url`.

Notes:

- `software` lets clients differentiate europa-node from alternative implementations as they appear. The string is a free-form identifier — no enum, no central registry.
- `version` is the daemon's own version (`package.json` version for europa-node). Bump on every release tag; useful for bug reports.
- `spec_version` is the VPN-marketplace protocol revision. Today there's exactly one: `vpn-marketplace/1`. Future protocol breaks bump this, and clients can branch on it.
- `pubkey` is the operator's 32-byte hex Nostr pubkey (not bech32 npub). A directory site that's about to send a buyer to this daemon should match it against the listing event's `pubkey`. A mismatch usually means the operator's listing has been impersonated or the operator rotated keys without republishing.
- `endpoint` is the public hostname the daemon thinks it lives at. A common misconfig is moving the daemon to a new host and forgetting to update the listing's `payment` tags — `endpoint` here vs the hostnames in the listing's `payment` tags reveals that drift.
- `mints`, `cashu_purchase_endpoints`, `lightning_endpoints` are deduped projections of the configured `payment_methods`. Whenever a buyer-side flow needs "which mint do I top up at to buy from this operator", these arrays answer without re-parsing payment tags. Most operators have one entry per array.
- `payment_methods` (the string array `["lightning", "cashu"]`) is kept for backwards-compat with tooling written against earlier `/info` versions. New consumers should prefer `mints` / `cashu_purchase_endpoints` / `lightning_endpoints`.

Responses are always JSON — no content negotiation, no HTML view. The europa-website operator-detail page is the canonical human-friendly view; `/info` is the wire surface.

#### CORS requirement <a id="cors-requirement"></a>

The marketplace is intentionally cross-origin. A buyer's browser fetches your `/info` and POSTs to your `/purchase` from whatever directory site or client they happen to be using — `europa.westernbtc.com`, a fork, a CLI in a web-served notebook, a third-party Nostr client. **Your daemon (or the reverse proxy in front of it) MUST send CORS headers** or browsers will refuse to read the response, even when the daemon answered correctly.

Minimum:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Cashu
Access-Control-Max-Age: 86400
```

The endpoints are payment-and-signature gated (BUD-11 auth on `/purchase`, the LNURL preimage on `/lnurlp/callback`), so origin gating buys you nothing — drop it open.

`europa-node` does this out of the box via `@fastify/cors`. If you front it with nginx, add:

```
add_header 'Access-Control-Allow-Origin' '*' always;
add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, X-Cashu' always;
if ($request_method = OPTIONS) { return 204; }
```

With Caddy:

```
header {
  Access-Control-Allow-Origin "*"
  Access-Control-Allow-Methods "GET, POST, OPTIONS"
  Access-Control-Allow-Headers "Content-Type, Authorization, X-Cashu"
}
@options method OPTIONS
respond @options 204
```

A daemon without CORS appears to work fine for `curl` and the operator's own probing tooling, but every browser-based buy attempt fails with the cryptic `CORS header 'Access-Control-Allow-Origin' missing` error and zero indication that the daemon itself answered correctly. `/operators/diagnose` on europa-website flags this as the most likely cause when `/info` is unreachable from a browser.

### 3.2 LNURL-pay endpoint

**Initial metadata request** (`GET /lnurlp?p=<price_tag_hash>`):

The optional `p` query parameter selects which price tier the client is purchasing. If omitted, the daemon returns metadata for the default tier (typically the cheapest).

Response (standard LNURL-pay format):

```json
{
  "tag": "payRequest",
  "callback": "https://vpn.operator.example/lnurlp/callback",
  "minSendable": 1000000,
  "maxSendable": 1000000,
  "commentAllowed": 1024,
  "metadata": "[[\"text/plain\",\"VPN access: 1 day\"],[\"text/identifier\",\"<operator-pubkey>:vpn-us-east-2025\"]]"
}
```

`minSendable` and `maxSendable` are in millisatoshis (1 sat = 1000 msat). For fixed-price tiers, both are equal. The `metadata` array follows LNURL conventions.

`commentAllowed` must be at least 1024 to accommodate the purchase parameters JSON.

**Callback request** (`GET /lnurlp/callback?amount=<msat>&comment=<json>`):

The `comment` is a JSON object containing purchase parameters (URL-encoded):

```json
{
  "version": "vpn-marketplace/1",
  "listing": "30402:<operator-pubkey>:<d-tag>",
  "price": ["price", "1000", "sat", "day"],
  "protocol": "wireguard",
  "client_pubkey": "<base64 wg public key>"
}
```

The daemon:

1. Parses the comment, validates fields against the listing.
2. Generates the WireGuard config text (or OpenVPN .ovpn).
3. Generates a fresh random preimage and computes its hash.
4. Encrypts the config with the preimage using AES-256 in GCM mode. Encoded result is the `ciphertext` and `iv` for the successAction.
5. Creates a Lightning invoice with the payment hash matching the preimage hash.
6. Returns the LNURL-pay callback response:

```json
{
  "pr": "lnbc...",
  "successAction": {
    "tag": "aes",
    "description": "Your VPN configuration",
    "ciphertext": "<base64 encrypted config>",
    "iv": "<base64 initialization vector>"
  },
  "routes": []
}
```

When the invoice is paid, Lightning reveals the preimage to the client. The client decrypts the successAction with the preimage and gets the config. Atomic — no payment, no config.

The daemon stores the assigned client peer (WireGuard pubkey or OpenVPN identity) as "pending" until payment confirms, then activates it.

### 3.3 Cashu purchase endpoint

**Request:** `POST /purchase`

Headers:

- `Authorization: Nostr <base64-encoded auth event>`
- `X-Cashu: <cashuB...>`
- `Content-Type: application/json`

Body:

```json
{
  "protocol": "wireguard",
  "client_pubkey": "<base64 wg public key>"
}
```

For OpenVPN purchases, `client_pubkey` is replaced with `client_id` (an arbitrary string the operator uses to name the client cert).

**Validation steps:**

1. **Parse the Authorization header.** Base64-decode the Nostr event, verify signature, verify `kind` is 24242.
2. **Validate auth event tags:**
   - `t` tag must be `vpn-purchase`
   - `expiration` tag must be in the future
   - `server` tag must match the operator's domain
   - `a` tag must reference one of the operator's active listings
   - `price` tag must match a price tier from that listing
3. **Parse and validate the Cashu token from the X-Cashu header:**
   - The token's mint must be one of the mints the listing advertises.
     A listing may carry **multiple** `cashu` payment methods, each
     with its own `mint` — the daemon accepts a token issued by *any*
     of them. The buyer chooses which mint to pay with (typically a
     mint they already hold ecash at); the daemon dispatches on the
     token's own mint field. A token from a mint not in the listing
     is rejected with `wrong-mint`.
   - P2PK lock must match the operator's P2PK pubkey. The operator
     uses **one** P2PK keypair regardless of how many mints it
     accepts — NUT-11 locks are mint-agnostic, so the same key
     unlocks tokens from every accepted mint. All `cashu` payment
     methods in a listing therefore carry the same `p2pk` value.
   - Total amount must equal or exceed the price tier amount
4. **Swap the token at the mint.** This validates the token isn't already spent and converts it to fresh tokens the operator owns. The mint will reject double-spends.
5. **Generate the config** (WireGuard or OpenVPN).
6. **Add the peer to the VPN server.**
7. **Return success response.**

**Success response:**

```json
{
  "status": "ok",
  "config": "<config text>",
  "expires_at": 1730086400
}
```

**Error response:**

```json
{
  "status": "error",
  "reason": "invalid-token|wrong-mint|wrong-p2pk|amount-mismatch|double-spent|expired-auth|bad-request|policy",
  "message": "<human-readable>"
}
```

HTTP status codes: 200 for success, 402 for payment failure, 400 for malformed request, 401 for auth failure.

#### Operator wallet

A Cashu token arrives P2PK-locked to the operator. After step 4
swaps it, the operator holds fresh, plain (unlocked) proofs — but
proofs are just strings. If the daemon doesn't persist them the
moment the request handler returns, that sale's revenue is gone:
the mint considers the proofs valid and unspent, but nobody has
recorded the secrets.

The reference daemon keeps received ecash in a **NIP-60 wallet**
under the operator's own Nostr identity — the same nsec that signs
the kind-30402 listing:

- **Storage.** The proofs become encrypted `kind:7375` token events
  (plus a `kind:17375` wallet event and `kind:10019` nutzap-info),
  published to the operator's relays. This is an off-box backup —
  losing the daemon's disk doesn't lose the money.
- **Auto-provisioning.** On first start, if the nsec has no
  `kind:17375` wallet event, the daemon creates one seeded with the
  mints from the listing's `cashu` payment methods. If a wallet
  already exists it's loaded as-is.
- **Fail-closed.** If Cashu is enabled but the wallet cannot be
  loaded or created (relays unreachable, malformed wallet event),
  the daemon **refuses to start**. A daemon that accepts Cashu with
  nowhere to keep the proceeds is worse than one that's down.
- **Withdrawal.** Because the wallet is a standard NIP-60 wallet,
  the operator spends or withdraws by opening it in *any* NIP-60
  client — including the directory site's own wallet page — and
  signing in with the node's nsec. The daemon itself has no payout
  endpoint; it only ever receives.

A non-europa-node implementation is free to persist proofs however
it likes (a local database, a different wallet). The constraint the
spec sets is only that received proofs **must be durably stored
before the success response is returned** — anything less loses
operator funds.

### 3.4 Config generation

**WireGuard config template:**

```ini
[Interface]
PrivateKey = <CLIENT_PRIVATE_KEY_LEFT_BLANK_OR_OMITTED>
Address = 10.42.0.<assigned_octet>/32
DNS = 1.1.1.1, 9.9.9.9

[Peer]
PublicKey = <operator_server_pubkey>
Endpoint = vpn.operator.example:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
```

The client's WireGuard private key is _not_ in the config — the client generated it locally and the operator never sees it. The client adds their own private key after importing the config. Convention: leave the `PrivateKey` line absent, or set it to a placeholder the client replaces.

(Some implementations include the private key for convenience by generating it server-side. This is faster but means the operator briefly sees the key. For maximum user privacy, leave the client to generate their own keypair and only send the public key in the purchase request.)

**Assigned IP allocation:** the operator daemon maintains a pool of available IPs in the VPN subnet (10.42.0.2 through 10.42.0.254 for a /24). On purchase, it assigns the next free IP. On expiry, the IP returns to the pool after a grace period.

**OpenVPN config (.ovpn) template:**

```
client
dev tun
proto udp
remote vpn.operator.example 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA256
verb 3

<ca>
<contents of ca.crt>
</ca>

<cert>
<contents of client cert>
</cert>

<key>
<contents of client key>
</key>

<tls-auth>
<contents of ta.key>
</tls-auth>
key-direction 1
```

For OpenVPN, the operator does generate the client key server-side (this is standard OpenVPN practice; the alternative requires the client to send a CSR, which adds complexity). The operator's CA signs a client certificate per purchase.

### 3.5 Peer lifecycle

The daemon maintains a small database tracking active sessions. Recommended schema:

| Field              | Type        | Notes                                               |
| ------------------ | ----------- | --------------------------------------------------- |
| `session_id`       | UUID        | Internal identifier                                 |
| `protocol`         | enum        | `wireguard` or `openvpn`                            |
| `client_identity`  | string      | WG pubkey (base64) or OpenVPN cert CN               |
| `assigned_ip`      | string      | The VPN-internal IP assigned to this peer           |
| `purchased_at`     | timestamp   | When payment confirmed                              |
| `expires_at`       | timestamp   | When access ends (time-bound)                       |
| `data_quota_bytes` | int or null | Total bytes allowed (data-bound), null if time-only |
| `data_used_bytes`  | int         | Running counter                                     |
| `price_tag`        | string      | Which price tier they bought                        |
| `payment_method`   | enum        | `lightning` or `cashu`                              |
| `status`           | enum        | `active`, `expired`, `revoked`                      |

SQLite is sufficient for small operators (thousands of sessions). PostgreSQL for larger.

**Activation:** When payment confirms (Lightning invoice paid, or Cashu token swap successful):

For WireGuard:

```bash
wg set wg0 peer <client_pubkey> allowed-ips <assigned_ip>/32
```

For OpenVPN: ensure the client cert is signed and present in PKI, ensure CRL doesn't include it.

**Expiry checking:** The daemon runs a periodic job (every 60 seconds is fine):

```python
for session in db.query("SELECT * FROM sessions WHERE status='active'"):
    if session.expires_at and now() >= session.expires_at:
        revoke(session)
    elif session.data_quota_bytes and session.data_used_bytes >= session.data_quota_bytes:
        revoke(session)
```

**Revocation:**

For WireGuard:

```bash
wg set wg0 peer <client_pubkey> remove
```

The peer is dropped immediately; existing connections terminate.

For OpenVPN:

```bash
cd /etc/openvpn/server/easy-rsa
./easyrsa revoke <client_id>
./easyrsa gen-crl
cp pki/crl.pem /etc/openvpn/server/
# Signal OpenVPN to reload the CRL — depends on version
killall -HUP openvpn  # most setups; check your distro
```

After revocation, mark the session as `expired` in the database. Return the assigned IP to the available pool after a brief delay (5 minutes) to avoid race conditions with traffic still in flight.

### 3.6 Data accounting

For data-quota sessions, the daemon needs to track bytes per peer. Approaches:

**WireGuard:** read `wg show wg0 transfer` periodically. Format is `<pubkey>\t<received>\t<sent>` for each peer. Sum and update the database.

```bash
wg show wg0 transfer
```

Sample output:

```
abc123...	1024	2048
def456...	5000	10000
```

Read this every 30 seconds, update `data_used_bytes` accordingly. The daemon stores the previous totals and computes deltas (the kernel counters reset only when the peer is removed).

**OpenVPN:** use the `--status` directive and parse `/var/run/openvpn/status.log` periodically, or run iptables byte accounting per client cert (more accurate but more setup).

In `server.conf`:

```
status /var/run/openvpn/status.log 10
```

Status log includes bytes-in / bytes-out per common name. The daemon reads this and updates the database.

### 3.7 Nostr listing publication

The daemon publishes and refreshes the operator's `kind: 30402` listing on configured Nostr relays.

**Initial publication:** When the daemon starts (or operator manually triggers), it constructs the listing event from a local TOML config file:

```toml
# /etc/europa-node/config.toml

[nostr]
relays = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
]
nsec_file = "/etc/europa-node/secret/nsec"

[listing]
d_tag = "vpn-us-east-2025"
title = "Fast US-East VPN"
summary = "1Gbps shared, no logs, US-East datacenter"
protocols = ["wireguard"]
policies = ["no-logs", "no-torrents"]
policy_url = "https://vpn.operator.example/policy"
content = """
US-East VPN service. WireGuard only, no logs, no torrents.
Operated since 2025. Pay in Lightning or Cashu.
"""

[listing.region]
country = "US"
geohash = "dr5regw"

[listing.capacity]
amount = 1000
unit = "Mbps"

[[listing.prices]]
amount = 100
currency = "sat"
unit = "hour"

[[listing.prices]]
amount = 1000
currency = "sat"
unit = "day"

[[listing.prices]]
amount = 5000
currency = "sat"
unit = "week"

[[listing.payment_methods]]
type = "lightning"
endpoint = "https://vpn.operator.example/lnurlp"
mechanism = "lnurl-pay"

[[listing.payment_methods]]
type = "cashu"
mint = "https://mint-a.example.com"
p2pk = "02abc..."
endpoint = "https://vpn.operator.example/purchase"

[listing.min_purchase]
amount = 1
unit = "hour"

[listing.max_purchase]
amount = 30
unit = "day"
```

The daemon constructs the event from this config and signs it with the operator's Nostr secret key (stored separately, file mode 600). A heavily-commented reference config lives at
[`../config.example.toml`](../config.example.toml) in this workspace.

**Refresh:** Republish every hour. NIP-99 listings are replaceable; clients fetch the latest. Refreshing serves as a heartbeat — listings older than 30 days are considered stale.

**Status changes:** When the operator wants to temporarily pause (going offline for maintenance), publish with `["status", "sold"]`. When resuming, publish with `["status", "active"]`.

**Retirement:** Publish a NIP-09 deletion event for the listing.

### 3.8 Daemon configuration

Config layout — one TOML file plus a secret directory:

```
/etc/europa-node/
├── config.toml            # everything operator-tunable (see §3.7 example)
└── secret/
    └── nsec               # operator Nostr secret key, file mode 600
```

The daemon should refuse to start with informative errors if any config is missing or malformed. The reference implementation reads `EUROPA_NODE_CONFIG` to pick the config path (default `/etc/europa-node/config.toml`).

The single-file TOML layout makes operator onboarding tractable: one file to edit, one secret to handle separately. A bootstrap script (`scripts/bootstrap.sh` in the reference workspace) generates the nsec, WireGuard server keypair, Cashu P2PK keypair, and a seeded `config.toml` from a handful of prompts.

---

## 4. Lightning Wallet Integration

The operator needs a Lightning node or service that can:

1. Generate invoices on demand
2. Watch for invoice payments
3. Provide preimages for the LNURL successAction encryption

Options, ordered by ease:

### 4.1 Phoenixd (recommended for small operators)

[phoenixd](https://phoenix.acinq.co/server) is a self-hosted Lightning node by ACINQ that handles channel management automatically. Single binary, very low operational burden.

Install, run, hit its HTTP API from the daemon:

```bash
# Generate an invoice
curl -X POST http://localhost:9740/createinvoice \
  -u :<api-token> \
  -d "amountSat=1000&description=VPN access"
```

The response includes the invoice and the payment hash. The daemon polls or subscribes to be notified when paid.

### 4.2 LND or CLN (full self-hosted)

For operators running their own Lightning node, use the standard gRPC/REST APIs. Tools:

- `gozaibo` or other LNURL implementations that wrap LND/CLN
- Direct API integration with the operator daemon

This requires more channel management work but gives full control.

### 4.3 LNbits

[LNbits](https://lnbits.com) provides a layer on top of LND/CLN/phoenixd with built-in LNURL-pay support. Easiest path if running multiple Lightning-paid services. Operator points the daemon at LNbits which talks to the underlying node.

### 4.4 LNURL-pay specifics

Whatever Lightning backend is used, the daemon must:

- Generate invoices with payment hashes whose preimages it controls (or knows ahead of time)
- AES-encrypt the config with the preimage as the key (per LNURL spec)
- Return the standard successAction structure

Most Lightning libraries provide preimage generation. The standard flow:

1. Daemon generates random 32-byte preimage
2. Daemon computes payment_hash = SHA256(preimage)
3. Daemon requests Lightning node to create invoice with that specific payment_hash
4. Daemon encrypts config: ciphertext = AES-256-GCM(key=preimage, plaintext=config)
5. Daemon returns invoice and successAction

When client pays, Lightning network reveals preimage to client. Client decrypts successAction. Done.

---

## 5. Cashu Wallet Integration

The operator needs:

1. A P2PK (pay-to-public-key) keypair for locking incoming tokens
2. Access to one or more Cashu mints (the ones declared in the listing)
3. Ability to swap received tokens for fresh tokens (validates them and prevents reuse)

### 5.1 Cashu library options

Several mature libraries:

- **[cashu-ts](https://github.com/cashubtc/cashu-ts)** — TypeScript/JavaScript
- **[cashu-py](https://github.com/cashubtc/nutshell)** — Python (Nutshell mint includes wallet)
- **[cdk](https://github.com/cashubtc/cdk)** — Rust (Cashu Development Kit)

Pick whichever matches the daemon's language.

### 5.2 Receiving a token

When a `POST /purchase` arrives:

```typescript
import { CashuWallet, CashuMint } from '@cashu/cashu-ts';

const mint = new CashuMint(mintUrl);
const wallet = new CashuWallet(mint);

// Parse the X-Cashu token
const token = parseCashuToken(req.headers['x-cashu']);

// Verify the token is locked to the operator's P2PK
if (!isP2PKLockedTo(token, operatorP2PKPubkey)) {
  return res.status(402).json({ status: 'error', reason: 'wrong-p2pk' });
}

// Swap the token (validates + replaces with fresh tokens owned by operator)
const { proofs } = await wallet.receive(token, { p2pk: { privateKey: operatorP2PKPrivkey } });

// Now the operator owns `proofs` worth of ecash from this mint
storeProofs(proofs);

// Deliver config
return res.json({ status: 'ok', config: generateConfig(...), expires_at: ... });
```

### 5.3 Converting Cashu to Lightning (optional)

The operator can hold Cashu indefinitely or melt to Lightning when convenient:

```typescript
const meltQuote = await wallet.createMeltQuote(lightningInvoice);
const { isPaid } = await wallet.meltProofs(meltQuote, proofs);
```

This pays a Lightning invoice from the operator's Cashu balance. Useful for operators who prefer Lightning settlement.

### 5.4 P2PK key management

The operator's P2PK pubkey is published in their listing. Keep the corresponding private key secure (file mode 600, not in version control).

Generate once:

```typescript
import { schnorr } from '@noble/curves/secp256k1';

const privkey = schnorr.utils.randomPrivateKey();
const pubkey = '02' + Buffer.from(schnorr.getPublicKey(privkey)).toString('hex');

console.log('P2PK pubkey (publish in listing):', pubkey);
console.log('P2PK privkey (keep secret):', Buffer.from(privkey).toString('hex'));
```

Store securely. If lost, future incoming tokens can't be swapped — they're effectively burned. Backup the privkey.

---

## 6. TLS and Reverse Proxy

The daemon's endpoints must be served over HTTPS. Recommended setup with Caddy (simplest):

```caddy
vpn.operator.example {
    reverse_proxy localhost:8080
}
```

Caddy automatically obtains and renews Let's Encrypt certificates. The daemon listens on localhost:8080 (HTTP). External requests come in on 443 (HTTPS), terminate at Caddy, forward to daemon.

For Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name vpn.operator.example;

    ssl_certificate     /etc/letsencrypt/live/vpn.operator.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vpn.operator.example/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Certbot for cert renewal:

```bash
certbot --nginx -d vpn.operator.example
```

The domain name appears in the operator's `kind: 11111` transport announcement and in BUD-11 auth events' `server` tag. Operators can use a subdomain of any domain they control, or a free DNS service like duckdns.org for small setups.

---

## 7. Hosting Considerations

### 7.1 Where to run

Three common setups:

**VPS:** Cheapest. Hetzner, OVH, Vultr, BuyVM, all have $5–10/month options with adequate bandwidth. Operators serve a region by picking a datacenter near it. Be aware of provider TOS — many cloud providers prohibit operating VPN services. Smaller providers and ones based in privacy-friendly jurisdictions are more permissive.

**Home server / homelab:** Best for residential-IP operators who want to monetize their home connection. Residential IPs are more valuable for circumvention use cases. Need to handle dynamic IPs (use a DynDNS service) and ensure your ISP's TOS allows it.

**Bare-metal colocation:** Highest control, highest cost. Suitable for serious operators running significant capacity.

### 7.2 Bandwidth

VPN traffic is sustained. Estimate based on capacity:

- 100 Mbps continuous = ~32 TB/month
- 1 Gbps continuous = ~324 TB/month

Most VPS plans include some bandwidth (1–10 TB), with overage charged. Pick a plan matching expected traffic. Operators that hit caps may want unmetered providers (BuyVM, FranTech, Cock.li-style).

### 7.3 Legal considerations

Running an exit VPN means traffic from anyone you serve appears to come from your IP. This carries legal exposure:

- DMCA notices for copyright-infringing traffic
- Abuse reports for spam, scanning, or attacks originating from your IP
- Possible law enforcement requests in your jurisdiction

The marketplace doesn't add protocol-level mitigation for this. Operators handle it through:

- **Jurisdiction choice:** Some jurisdictions have stronger protections for VPN operators (Iceland, Switzerland, Romania). Others actively cooperate with law enforcement. Pick deliberately.
- **Logging policy:** "No logs" is a marketing claim. To make it real, the daemon should not log connection metadata. The reference daemon defaults to logging only operational data (start/stop, errors) without per-connection traces.
- **Abuse response:** Have a plan. Template responses to DMCA, an abuse@ email that's monitored, willingness to terminate egregious abusers (which requires some logging contradictorily).
- **No KYC:** Operators provide pseudonymous service. Don't collect client identity. This is the marketplace's design.

Operators are advised to understand their local legal exposure before running an exit VPN.

### 7.4 Multi-region operators

A single operator may run servers in multiple regions. Recommended pattern: one listing per region, each with its own `d` tag, geohash, and `kind: 11111` transport endpoint. This lets clients filter by region and the operator track sessions per location.

The same Nostr pubkey (and reputation) covers all regions.

---

## 8. Reference Daemon Architecture

Suggested architecture for the reference operator daemon:

```
operator-daemon/
├── src/
│   ├── main.ts          # Entry point, config loading, service wiring
│   ├── nostr/
│   │   ├── listing.ts   # Publish and refresh kind:30402
│   │   ├── transport.ts # Publish and refresh kind:11111
│   │   └── relays.ts    # Relay connection management
│   ├── payments/
│   │   ├── lightning.ts # LNURL-pay implementation
│   │   ├── cashu.ts     # X-Cashu + BUD-11 implementation
│   │   └── encrypt.ts   # AES-GCM for successAction
│   ├── vpn/
│   │   ├── wireguard.ts # WG peer lifecycle (wg-quick wrappers)
│   │   ├── openvpn.ts   # OVPN cert lifecycle (easyrsa wrappers)
│   │   └── ips.ts       # IP pool allocation
│   ├── sessions/
│   │   ├── db.ts        # SQLite/Postgres adapter
│   │   ├── expiry.ts    # Periodic job for time/data expiry
│   │   └── stats.ts     # Bandwidth accounting
│   └── api/
│       ├── lnurlp.ts    # LNURL-pay endpoints
│       ├── purchase.ts  # Cashu purchase endpoint
│       └── health.ts    # Health check
├── config/
│   └── default.toml
└── tests/
```

Stack-agnostic. Could be TypeScript on Node, Rust, Go, Python, whatever. Reference implementation should target a popular language for maximum contributor accessibility — I'd suggest TypeScript or Go.

---

## 9. Deployment Recipes

### 9.1 Docker Compose (most common)

A ready-to-use Docker Compose layout ships in the reference workspace at [`../docker-compose.yml`](../docker-compose.yml). Shape:

```yaml
services:
  europa-node:
    image: harbor.westernbtc.com/europa-node/master:latest
    restart: unless-stopped
    network_mode: host
    cap_add: [NET_ADMIN]            # for `wg` shell calls
    volumes:
      - ./config:/etc/europa-node:ro
      - ./secrets:/etc/europa-node/secret:ro
      - /etc/wireguard:/etc/wireguard
      - ./data:/var/lib/europa-node
    environment:
      EUROPA_NODE_CONFIG: /etc/europa-node/config.toml

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
volumes:
  caddy_data:
```

The WireGuard server runs on the host (not in the container) for performance.

### 9.2 systemd

For operators preferring native systemd:

```ini
# /etc/systemd/system/europa-node.service
[Unit]
Description=Europa Node — VPN-marketplace operator daemon
After=network.target wg-quick@wg0.service
Requires=wg-quick@wg0.service

[Service]
Type=simple
ExecStart=/usr/local/bin/europa-node
Restart=on-failure
RestartSec=10
User=europa-node
Group=europa-node
AmbientCapabilities=CAP_NET_ADMIN
WorkingDirectory=/etc/europa-node

[Install]
WantedBy=multi-user.target
```

### 9.3 OpenWRT

For operators running on a home router with OpenWRT:

Package the daemon as an `.ipk`. Install:

```bash
opkg install europa-node
/etc/init.d/europa-node enable
/etc/init.d/europa-node start
```

OpenWRT operators typically run on residential IPs — high value for some use cases, limited bandwidth.

### 9.4 Kubernetes

For operators already running K8s. Deploy the daemon as a single-replica `Deployment` pinned to a specific node (the WireGuard server lives on that node's kernel) with `hostNetwork: true` and the `NET_ADMIN` capability; mount `/etc/wireguard` from the host so the daemon's `wg` shell calls reach the right interface.

A ready-to-use template ships in the reference workspace at [`../k8/`](../k8/) — a `deployment-template.yml`, `service.yml`, and `httproute.yml` (Gateway API). The manifests are *deployment-specific*, not protocol material: they name a particular registry, gateway, and host. Operators adopting this path fork the workspace and retarget those names. The full retarget list and a step-by-step walkthrough live in [`../README.md` § Kubernetes deploy](../README.md#kubernetes-deploy-for-operators-already-on-k8s).

Two K8s-specific notes worth stating in the spec:

1. The K8s path does **not** provision TLS for the daemon's HTTPS API. The reference Docker Compose uses Caddy for auto-renewing Let's Encrypt; the K8s path assumes the Gateway controller terminates TLS upstream of the pod.
2. The K8s path does **not** install WireGuard for you. The host's `wg0` interface and `/etc/wireguard/server.key` must be set up before the deploy — see §2.1.

---

## 10. Monitoring and Operations

### 10.1 What to monitor

- Listing freshness on Nostr (am I being discoverable?)
- VPN server health (is wireguard up?)
- Wallet balances (do I have inbound liquidity / cashu balance to swap?)
- Active session count
- Bandwidth utilization
- Failed purchases (am I rejecting too much?)

### 10.2 Logging

Recommended approach: structured JSON logs, log to stdout, let systemd/Docker handle persistence and rotation.

Log levels:

- **error:** payment failures, VPN setup errors
- **warn:** purchase rejections, unusual patterns
- **info:** successful purchases (without client-identifying info), peer additions/removals
- **debug:** detailed protocol traces (off by default)

**What not to log:**

- Client IPs (operator sees them via VPN connection, but don't write to disk)
- Destination addresses clients connect to
- Client Nostr pubkeys (even ephemeral ones)
- Anything that could deanonymize users

The daemon's log policy is part of the operator's effective privacy promise. The reference daemon should default to minimal logging.

### 10.3 Updates

Operators should plan for daemon updates without dropping active VPN connections. The VPN server (wireguard, openvpn) is independent of the daemon — restarting the daemon doesn't drop VPN connections, as long as it picks up existing state from the database on restart.

Recommended update flow:

1. Stop the daemon
2. Update the binary / container image
3. Start the daemon
4. Daemon reloads active sessions from the database, verifies VPN state matches, resumes

Total downtime: a few seconds, no VPN connection loss.

### 10.4 Sale notifications (optional)

An operator who doesn't want to watch logs can have the daemon push
a private message on every sale. The reference daemon implements this
over **NIP-17 private direct messages** (`[notifications]` in
`config.toml`):

- On every completed sale the daemon DMs the operator the amount,
  price tier, expiry, and current NIP-60 wallet balance.
- An optional balance-only heartbeat repeats on a fixed cadence even
  when there are no sales.
- The message is a NIP-17 gift wrap (kind-14 chat rumor → kind-13
  seal → kind-1059 wrap, NIP-44 encrypted). Relays only ever see the
  opaque wrap; the contents are visible only to the recipient.
- Sender is the node's own nsec; the recipient is a pubkey the
  operator configures — point it at a personal account, not the
  node's, and read the messages in any NIP-17 client.

This is a convenience surface, not part of the marketplace protocol —
a buyer never sees it. **It must be strictly best-effort:** a
notification that fails to send (recipient has no reachable relay,
NIP-44 hiccup) must never fail or delay the customer's purchase. The
reference daemon fires every notification fire-and-forget and swallows
its own errors.

---

## 11. Open Questions

1. **LNURL-pay comment size limits.** Some Lightning wallets cap comment length. The marketplace purchase comment may approach 1KB. Test with major wallets (Phoenix, Zeus, Mutiny) and document compatibility.
2. **WireGuard peer count limits.** Kernel WireGuard handles thousands of peers; ` wireguard-go` may have lower limits. Document tested capacity.
3. **OpenVPN CRL reload.** Different distros use different mechanisms. Document the canonical way per platform.
4. **IPv6 support.** This document covers IPv4. IPv6 should work the same way with dual-stack address pools. Worth a dedicated section once the IPv4 path is stable.
5. **Multi-instance operators.** Single operator running multiple physical servers behind the same Nostr identity. Probably one listing per server with shared reputation. Worth documenting.

---

## 12. Hand-Off Notes

For the implementing team:

1. **The VPN server side is mostly off-the-shelf.** wireguard-tools, openvpn, easyrsa, Caddy — all standard packages. Don't reinvent any of this.

2. **The daemon is the new piece.** It's a small HTTP server with a database, talking to Nostr relays and a Lightning/Cashu backend. Maybe 2000-3000 lines of code in a typical language.

3. **Reference daemon should be docker-compose-easy.** An operator should be able to clone a repo, edit a config file, run `docker compose up`, and have a working operator within an hour.

4. **Document the legal landscape carefully.** Operators getting in legal trouble because they didn't know what they were signing up for kills the project. The hand-off should include a real "running an exit VPN — what to expect" document, separate from this protocol spec.

5. **Make the listing config human-friendly.** YAML or TOML, not JSON. Lots of comments. An operator should be able to edit their listing without reading the spec.

6. **The Lightning preimage trick is load-bearing.** Get the AES-GCM encryption / preimage handling right. Test with multiple Lightning wallets to make sure successActions decode correctly.

7. **Cashu library choice matters.** Pick a maintained library. cashu-ts is the most active as of writing. Don't reimplement the protocol.

8. **The daemon owns the trust boundary.** It sees client WireGuard public keys, payment data, and the VPN server's control interface. Audit it carefully. Run it as a non-root user with `CAP_NET_ADMIN` only.

---

_End of operator setup specification._
