#!/bin/bash
# Generate self-signed TLS certificates for local development
# These are used for https://localhost:8020

set -e

SUBJ="/C=US/ST=Local/L=Local/O=Development/CN=localhost"

echo "Generating private key..."
openssl genrsa -out key.pem 4096

echo "Generating certificate signing request..."
openssl req -new -sha256 -key key.pem -out csr.csr -subj "$SUBJ"

echo "Generating self-signed certificate (valid for 365 days)..."
openssl x509 -req -sha256 -days 365 -in csr.csr -signkey key.pem -out certificate.pem

# Verify
openssl req -in csr.csr -text -noout | grep -i "Signature.*SHA256" > /dev/null && echo "✓ TLS certificates created successfully"
