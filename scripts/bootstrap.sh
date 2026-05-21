#!/bin/bash
# services/europa-node/scripts/bootstrap.sh
#
# One-shot operator bootstrap. Generates everything you need to spin
# up a new Europa Node:
#
#   - Operator Nostr nsec (long-lived; signs your listing)
#   - WireGuard server keypair (long-lived; in /etc/wireguard/)
#   - Cashu P2PK keypair (long-lived; for Cashu-locked tokens)
#   - A starting config.toml seeded with all of the above
#
# Idempotent in the sense that it refuses to overwrite an existing
# secret. If you re-run it after a partial failure, delete the file
# the script complains about and try again.
#
# Requires: wg, openssl, awk, sed. Optional but recommended: node (used
# to auto-derive the Cashu P2PK pubkey from the generated privkey).
#   Debian/Ubuntu:  sudo apt install wireguard-tools openssl nodejs
#   macOS (Homebrew): brew install wireguard-tools openssl node
#
# Usage:
#   ./scripts/bootstrap.sh           # interactive — prompts for hostname etc.
#
#   # Non-interactive — all six prompts must be supplied as env vars or
#   # `read` will block waiting on stdin:
#   PUBLIC_HOST=vpn.example.com \
#   D_TAG=my-node TITLE="My Europa Node" \
#   COUNTRY=US REGION=US-East GEOHASH=dr5regw \
#     ./scripts/bootstrap.sh
set -euo pipefail

# ── Paths ───────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${TARGET_DIR:-$HERE}"
CONFIG_DIR="$TARGET_DIR/config"
SECRETS_DIR="$TARGET_DIR/secrets"
DATA_DIR="$TARGET_DIR/data"

mkdir -p "$CONFIG_DIR" "$SECRETS_DIR" "$DATA_DIR"
chmod 700 "$SECRETS_DIR"

# ── Required tools ─────────────────────────────────────────────────
for cmd in wg openssl awk sed; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: $cmd not installed." >&2; exit 1; }
done

# ── Inputs (env-or-prompt) ──────────────────────────────────────────
prompt() {
  local var="$1" default="$2" desc="$3"
  if [ -z "${!var:-}" ]; then
    read -rp "$desc [$default]: " val
    printf -v "$var" "%s" "${val:-$default}"
  fi
}

prompt PUBLIC_HOST  "vpn.example.com"      "Public hostname clients will dial"
prompt D_TAG        "vpn-$(date +%Y)"      "NIP-99 listing identifier (d-tag)"
prompt TITLE        "My Europa Node"       "Listing title shown to clients"
prompt COUNTRY      "US"                   "ISO country code"
prompt REGION       ""                     "Sub-region (e.g. US-East). Blank = omit"
prompt GEOHASH      ""                     "Geohash for the map view (blank = omit)"

# ── Generate nsec ──────────────────────────────────────────────────
NSEC_FILE="$SECRETS_DIR/nsec"
if [ -f "$NSEC_FILE" ]; then
  echo "✓ nsec already at $NSEC_FILE — leaving it alone."
else
  # 32 random bytes hex; signing libs accept this directly.
  openssl rand -hex 32 > "$NSEC_FILE"
  chmod 600 "$NSEC_FILE"
  echo "✓ wrote nsec to $NSEC_FILE (mode 600)"
fi

# ── Generate WireGuard server keypair ──────────────────────────────
WG_KEY="$SECRETS_DIR/wg-server.key"
WG_PUB="$SECRETS_DIR/wg-server.pub"
if [ -f "$WG_KEY" ]; then
  echo "✓ WireGuard server key already at $WG_KEY"
else
  umask 077
  wg genkey | tee "$WG_KEY" | wg pubkey > "$WG_PUB"
  chmod 600 "$WG_KEY"
  chmod 644 "$WG_PUB"
  echo "✓ generated WireGuard server keypair"
fi
WG_SERVER_PUBKEY="$(cat "$WG_PUB")"

# ── Generate Cashu P2PK keypair ────────────────────────────────────
# secp256k1 private key + compressed-form public key with 02/03 prefix.
P2PK_PRIV="$SECRETS_DIR/cashu-p2pk.key"
P2PK_PUB_FILE="$SECRETS_DIR/cashu-p2pk.pub"
if [ -f "$P2PK_PRIV" ]; then
  echo "✓ Cashu P2PK key already at $P2PK_PRIV"
else
  # Generate a secp256k1 private key. The 32-byte privkey scalar
  # lives inside the DER SEC1 encoding at a known offset (after the
  # 7-byte header `30 LL 02 01 01 04 20`). Extract it precisely with
  # `dd skip=7 count=32` — earlier versions of this script used
  # `head -c 64 | tail -c 32` which picks bytes 32..63 and lands in
  # the OID block, producing a "privkey" that wasn't the key openssl
  # actually generated. Worked by accident (32 random bytes is a valid
  # scalar with overwhelming probability) but was confusing if anyone
  # ever tried to import the key into another tool.
  openssl ecparam -name secp256k1 -genkey -noout 2>/dev/null \
    | openssl ec -outform DER 2>/dev/null \
    | dd bs=1 skip=7 count=32 2>/dev/null \
    | xxd -p -c 32 > "$P2PK_PRIV"
  chmod 600 "$P2PK_PRIV"
  echo "✓ generated Cashu P2PK private key (hex) at $P2PK_PRIV"
fi

# Derive the compressed-form (33-byte) public key whenever the .pub
# file is missing — covers both fresh runs and an old workspace where
# the previous bootstrap left only the privkey behind.
if [ ! -f "$P2PK_PUB_FILE" ]; then
  if command -v node >/dev/null 2>&1; then
    P2PK_DERIVE_DIR="${TMPDIR:-/tmp}/europa-node-p2pk-derive.$$"
    mkdir -p "$P2PK_DERIVE_DIR"
    (
      cd "$P2PK_DERIVE_DIR"
      npm init -y >/dev/null 2>&1
      npm install --silent @noble/secp256k1@2 >/dev/null 2>&1
    )
    P2PK_PUB="$(cd "$P2PK_DERIVE_DIR" && node -e "
      const secp = require('@noble/secp256k1');
      const fs = require('fs');
      const priv = fs.readFileSync('$P2PK_PRIV', 'utf8').trim();
      // getPublicKey(_, true) returns the full 33-byte compressed
      // form (02/03 prefix + 32-byte X). Don't slice and don't
      // hardcode '02' — the prefix encodes Y parity and is part of
      // the pubkey.
      process.stdout.write(Buffer.from(secp.getPublicKey(priv, true)).toString('hex'));
    ")"
    rm -rf "$P2PK_DERIVE_DIR"
    echo "$P2PK_PUB" > "$P2PK_PUB_FILE"
    chmod 644 "$P2PK_PUB_FILE"
    echo "✓ derived Cashu P2PK pubkey to $P2PK_PUB_FILE"
  else
    echo "⚠ node not installed — can't auto-derive the P2PK pubkey."
    echo "  Install node (Debian/Ubuntu: 'sudo apt install nodejs') and re-run,"
    echo "  or derive manually with any secp256k1 library and write the 66-char"
    echo "  compressed-form hex (02/03 prefix + 32-byte X) to:"
    echo "    $P2PK_PUB_FILE"
    P2PK_PUB="REPLACE_WITH_P2PK_PUBKEY"
  fi
else
  P2PK_PUB="$(cat "$P2PK_PUB_FILE")"
fi

# ── Write config.toml ──────────────────────────────────────────────
CONFIG_FILE="$CONFIG_DIR/config.toml"
if [ -f "$CONFIG_FILE" ]; then
  echo "ℹ $CONFIG_FILE already exists — not overwriting."
  echo "  Re-run with TARGET_DIR pointing somewhere else, or delete and retry."
else
  REGION_BLOCK="[listing.region]
country = \"$COUNTRY\""
  [ -n "$REGION" ] && REGION_BLOCK+="
sub = \"$REGION\""
  [ -n "$GEOHASH" ] && REGION_BLOCK+="
geohash = \"$GEOHASH\""

  cat > "$CONFIG_FILE" <<EOF
# Generated by bootstrap.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ").
# Edit freely; see ../config.example.toml for the field reference.

[server]
host = "0.0.0.0"
port = 8080
public_host = "$PUBLIC_HOST"

[db]
path = "/var/lib/europa-node/sessions.db"

[wireguard]
interface = "wg0"
endpoint_host = "$PUBLIC_HOST"
endpoint_port = 51820
server_pubkey = "$WG_SERVER_PUBKEY"
subnet_cidr = "10.66.42.0/24"
dns = ["1.1.1.1", "9.9.9.9"]

[lightning]
# Flip enabled = true after you've got a phoenixd / LND backend wired up.
enabled = false
backend = "stub"
# base_url = "http://localhost:9740"
# api_token = ""

[cashu]
# Flip enabled = true after you've set a mint URL + your P2PK privkey.
enabled = false
# mint_url = "https://mint.example.com"
# p2pk_privkey_hex = "<read $P2PK_PRIV>"

[nostr]
relays = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
]
nsec_file = "/etc/europa-node/secret/nsec"

[listing]
d_tag = "$D_TAG"
title = "$TITLE"
protocols = ["wireguard"]
policies = ["no-logs"]
content = """
Independent Europa Node. WireGuard.
"""

$REGION_BLOCK

[[listing.prices]]
amount = 100
currency = "sat"
unit = "hour"

[[listing.prices]]
amount = 1000
currency = "sat"
unit = "day"

[[listing.payment_methods]]
type = "lightning"
endpoint = "https://$PUBLIC_HOST/lnurlp"
mechanism = "lnurl-pay"

# Uncomment once you've enabled Cashu above:
# [[listing.payment_methods]]
# type = "cashu"
# mint = "https://mint.example.com"
# p2pk = "$P2PK_PUB"
# endpoint = "https://$PUBLIC_HOST/purchase"
EOF
  echo "✓ wrote config to $CONFIG_FILE"
fi

# ── Caddyfile substitution ─────────────────────────────────────────
CADDY_TEMPLATE="$TARGET_DIR/Caddyfile"
if [ -f "$CADDY_TEMPLATE" ] && grep -q "vpn.example.com" "$CADDY_TEMPLATE"; then
  sed -i.bak "s|vpn.example.com|$PUBLIC_HOST|g" "$CADDY_TEMPLATE"
  rm -f "$CADDY_TEMPLATE.bak"
  echo "✓ updated Caddyfile to reference $PUBLIC_HOST"
fi

echo
echo "Next steps:"
echo "  1. Configure your host's WireGuard interface (wg0) using"
echo "     $WG_KEY as PrivateKey. See docs/spec.md §2.1 for the wg-quick template."
echo "  2. Forward UDP 51820 from your router/firewall to this host."
echo
echo "  Then pick one of:"
echo "    A. docker compose up -d  (the default — see README.md 'Quick start')"
echo "    B. K8s — see README.md 'Kubernetes deploy'. The bootstrap"
echo "       outputs that the K8s path consumes:"
echo "         config/config.toml   →  Secret europa-node-config (key: config.toml)"
echo "         secrets/nsec         →  Secret europa-node-nsec   (key: nsec)"
echo "         secrets/wg-server.key →  /etc/wireguard/server.key on the pinned node"
echo
echo "  3. Once the daemon is up and your listing publishes, browse any"
echo "     directory site (e.g. europa.westernbtc.com) to confirm it appears."
