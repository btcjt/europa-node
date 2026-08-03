#!/usr/bin/env bash
#
# Peer-isolation firewall for a europa-node WireGuard interface.
#
# WHY THIS EXISTS
# ---------------
# europa-node hands every paying customer a config with
# `AllowedIPs = 0.0.0.0/0, ::/0` (see src/configGen.ts) — a full
# tunnel, which is the point of selling VPN access. That means the
# client routes *everything* to you, including RFC1918 destinations.
#
# The obvious server-side recipe —
#
#     PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; \
#              iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
#
# — forwards those packets too. A customer who sets
# `10.0.0.0/8` as a destination reaches your LAN: your router, your
# NAS, your hypervisor, your Kubernetes API, your Lightning node.
# They pay you for internet egress and get your intranet for free.
#
# This script replaces that recipe. Peers get the public internet and
# nothing else.
#
# USAGE (from /etc/wireguard/wg0.conf)
# ------------------------------------
#     PostUp   = /etc/wireguard/wg-firewall.sh up %i
#     PostDown = /etc/wireguard/wg-firewall.sh down %i
#
# The egress interface is auto-detected from the default route; pass
# it as a third argument to override. The peer subnet is read from the
# interface's own address, so it follows `subnet_cidr` automatically.
#
set -euo pipefail

ACTION="${1:-}"
WGIF="${2:-}"

if [[ -z "$ACTION" || -z "$WGIF" ]]; then
  echo "usage: $(basename "$0") up|down <wg-interface> [egress-interface]" >&2
  exit 64
fi

EGRESS="${3:-$(ip route show default | awk '{print $5; exit}')}"
if [[ -z "$EGRESS" ]]; then
  echo "$(basename "$0"): no default route — pass the egress interface explicitly" >&2
  exit 69
fi

# Destinations a paying peer must never reach through the operator's
# host. This is the whole point of the script; do not trim it to "just
# my LAN" — an operator's blast radius includes every private range
# their host can route to, and hosts move.
PRIVATE4=(
  10.0.0.0/8        # RFC1918
  172.16.0.0/12     # RFC1918
  192.168.0.0/16    # RFC1918
  169.254.0.0/16    # link-local (incl. cloud metadata at 169.254.169.254)
  100.64.0.0/10     # RFC6598 CGNAT
  127.0.0.0/8       # loopback
  224.0.0.0/4       # multicast
  240.0.0.0/4       # reserved
)
PRIVATE6=(
  fc00::/7          # unique-local
  fe80::/10         # link-local
  ::1/128           # loopback
)

FWD_CHAIN="EUROPA-${WGIF}-FWD"
IN_CHAIN="EUROPA-${WGIF}-IN"
# Survives across PostUp/PostDown; /run is tmpfs, so a reboot clears it
# along with the iptables rules it describes.
STATE_FILE="/run/wg-firewall-${WGIF}.subnet"

# Network address of the wg interface, e.g. 10.66.42.1/24 -> 10.66.42.0/24.
# Used to scope MASQUERADE to peer traffic instead of blanket-NATing
# everything that leaves the egress interface.
wg_subnet() {
  local cidr addr pfx a b c d v m n
  cidr=$(ip -4 -o addr show dev "$WGIF" 2>/dev/null | awk '{print $4; exit}')
  if [[ -z "$cidr" ]]; then return 1; fi
  addr=${cidr%/*}; pfx=${cidr#*/}
  IFS=. read -r a b c d <<<"$addr"
  v=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  m=$(( 0xFFFFFFFF ^ ((1 << (32 - pfx)) - 1) ))
  n=$(( v & m ))
  echo "$(( (n >> 24) & 255 )).$(( (n >> 16) & 255 )).$(( (n >> 8) & 255 )).$(( n & 255 ))/$pfx"
}

# Hosts differ on whether `iptables` is the nft or the legacy backend, and
# the rules must land in the SAME table wg-quick/your CNI already uses.
# Override when they diverge, e.g. IPTABLES=iptables-legacy.
IPTABLES="${IPTABLES:-iptables}"
IP6TABLES="${IP6TABLES:-ip6tables}"

ipt()  { "$IPTABLES" "$@"; }
ipt6() { "$IP6TABLES" "$@"; }

have_ip6() { command -v "$IP6TABLES" >/dev/null 2>&1; }

up() {
  local subnet
  subnet=$(wg_subnet) || {
    echo "$(basename "$0"): could not read an IPv4 address on $WGIF" >&2
    exit 69
  }

  # ---- IPv4 ----------------------------------------------------------
  ipt -N "$FWD_CHAIN" 2>/dev/null || true
  ipt -F "$FWD_CHAIN"
  for cidr in "${PRIVATE4[@]}"; do
    ipt -A "$FWD_CHAIN" -d "$cidr" -j REJECT --reject-with icmp-net-prohibited
  done
  ipt -A "$FWD_CHAIN" -j ACCEPT

  ipt -N "$IN_CHAIN" 2>/dev/null || true
  ipt -F "$IN_CHAIN"
  ipt -A "$IN_CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  ipt -A "$IN_CHAIN" -j DROP

  # Insert at the top of the built-in chains, in reverse of the order we
  # want them evaluated. The host's FORWARD chain is usually owned by a
  # CNI (Calico/Flannel) or Docker, which append ACCEPT rules — appending
  # ours after theirs would let peer traffic through before we see it.
  # Our rules only match this interface, so cluster traffic is unaffected.
  ipt -D FORWARD -o "$WGIF" -j DROP 2>/dev/null || true
  ipt -I FORWARD 1 -o "$WGIF" -j DROP
  ipt -D FORWARD -o "$WGIF" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  ipt -I FORWARD 1 -o "$WGIF" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  ipt -D FORWARD -i "$WGIF" -j "$FWD_CHAIN" 2>/dev/null || true
  ipt -I FORWARD 1 -i "$WGIF" -j "$FWD_CHAIN"

  ipt -D INPUT -i "$WGIF" -j "$IN_CHAIN" 2>/dev/null || true
  ipt -I INPUT 1 -i "$WGIF" -j "$IN_CHAIN"

  # Scoped NAT: only peer-sourced traffic, not everything on the egress.
  ipt -t nat -D POSTROUTING -s "$subnet" -o "$EGRESS" -j MASQUERADE 2>/dev/null || true
  ipt -t nat -A POSTROUTING -s "$subnet" -o "$EGRESS" -j MASQUERADE
  printf '%s' "$subnet" > "$STATE_FILE"

  # ---- IPv6 ----------------------------------------------------------
  # wg0 usually has no IPv6 address, but clients are handed `::/0`. If
  # the host ever gains v6 on this interface, the rules are already here.
  if have_ip6; then
    ipt6 -N "$FWD_CHAIN" 2>/dev/null || true
    ipt6 -F "$FWD_CHAIN"
    for cidr in "${PRIVATE6[@]}"; do
      ipt6 -A "$FWD_CHAIN" -d "$cidr" -j REJECT --reject-with adm-prohibited
    done
    ipt6 -A "$FWD_CHAIN" -j ACCEPT

    ipt6 -D FORWARD -i "$WGIF" -j "$FWD_CHAIN" 2>/dev/null || true
    ipt6 -I FORWARD 1 -i "$WGIF" -j "$FWD_CHAIN"
  fi

  echo "wg-firewall: $WGIF peers restricted to public internet via $EGRESS (subnet $subnet)"
}

down() {
  ipt -D FORWARD -i "$WGIF" -j "$FWD_CHAIN" 2>/dev/null || true
  ipt -D FORWARD -o "$WGIF" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  ipt -D FORWARD -o "$WGIF" -j DROP 2>/dev/null || true
  ipt -D INPUT -i "$WGIF" -j "$IN_CHAIN" 2>/dev/null || true
  ipt -F "$FWD_CHAIN" 2>/dev/null || true
  ipt -X "$FWD_CHAIN" 2>/dev/null || true
  ipt -F "$IN_CHAIN" 2>/dev/null || true
  ipt -X "$IN_CHAIN" 2>/dev/null || true

  # wg-quick removes the interface before running PostDown, so the
  # subnet can't be re-derived here — `up` stashed it. Only ever delete
  # the exact rule we added; a blind sweep for `-o <egress> -j MASQUERADE`
  # would take Docker's or the CNI's NAT rule with it.
  # NOTE: plain `[[ test ]] && cmd` here would abort the whole script under
  # `set -e` whenever the test is false — and this runs in PostDown, where a
  # premature exit silently strands the MASQUERADE rule. Keep the if-blocks.
  local subnet=""
  if [[ -r "$STATE_FILE" ]]; then subnet=$(cat "$STATE_FILE"); fi
  if [[ -z "$subnet" ]]; then subnet=$(wg_subnet 2>/dev/null || true); fi
  if [[ -n "$subnet" ]]; then
    ipt -t nat -D POSTROUTING -s "$subnet" -o "$EGRESS" -j MASQUERADE 2>/dev/null || true
  else
    echo "wg-firewall: WARNING — no stored subnet for $WGIF; leaving the" >&2
    echo "  MASQUERADE rule in place rather than guessing which one is ours." >&2
    echo "  Remove it by hand: iptables -t nat -S POSTROUTING" >&2
  fi
  rm -f "$STATE_FILE"

  if have_ip6; then
    ipt6 -D FORWARD -i "$WGIF" -j "$FWD_CHAIN" 2>/dev/null || true
    ipt6 -F "$FWD_CHAIN" 2>/dev/null || true
    ipt6 -X "$FWD_CHAIN" 2>/dev/null || true
  fi

  echo "wg-firewall: $WGIF rules removed"
}

case "$ACTION" in
  up)   up ;;
  down) down ;;
  *)    echo "usage: $(basename "$0") up|down <wg-interface> [egress-interface]" >&2; exit 64 ;;
esac
