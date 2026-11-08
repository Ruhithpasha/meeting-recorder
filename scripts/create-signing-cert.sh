#!/usr/bin/env bash
# Creates a self-signed code-signing identity in the login keychain, valid 10 years.
# macOS ties Screen Recording / Microphone permission to the app's signing identity: with a stable
# identity, permissions survive every local rebuild (update). Nothing leaves this Mac.
# macOS asks for your password twice: to trust the certificate, and (here, in the terminal) to let
# codesign use the key without prompting on every build.
set -euo pipefail

name="Meeting Recorder Local Signing"
keychain="$HOME/Library/Keychains/login.keychain-db"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if security find-identity -v -p codesigning | grep -q "$name"; then
  echo "Signing identity already exists."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$name" \
  -keyout "$work/key.pem" -out "$work/cert.pem" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

# macOS's importer needs the older PKCS#12 algorithms.
pass="$(openssl rand -hex 16)"
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/id.p12" -passout "pass:$pass" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

security import "$work/id.p12" -k "$keychain" -P "$pass" -T /usr/bin/codesign >/dev/null
echo "Trusting the certificate for code signing (macOS will ask for your password)…"
security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$work/cert.pem"

printf 'Your Mac login password (lets codesign use the key without asking each time): '
read -rs login_password </dev/tty
echo
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$login_password" "$keychain" >/dev/null
unset login_password

security find-identity -v -p codesigning | grep -q "$name" && echo "Created signing identity: $name"
