#!/usr/bin/env bash
# Generates a self-signed TLS cert for https-dev-server.js, covering your
# Mac's current LAN IP (needed for a physical device; the iOS Simulator can
# also reach it directly). Re-run this if your LAN IP changes.
#
# Usage: ./generate-certs.sh
set -euo pipefail
cd "$(dirname "$0")"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"
echo "Generating a cert for LAN IP: $LAN_IP (and localhost/127.0.0.1)"

mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 3650 -nodes \
  -subj "/CN=$LAN_IP" \
  -addext "subjectAltName=IP:$LAN_IP,DNS:localhost,IP:127.0.0.1"

echo ""
echo "Done. Trust it in the iOS Simulator with:"
echo "  xcrun simctl keychain <device-udid> add-root-cert certs/cert.pem"
echo ""
echo "Then set PoTokenProvider's proxyScriptUrl to:"
echo "  https://$LAN_IP:4443/proxy-script"
