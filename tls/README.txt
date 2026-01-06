# TLS Certificates for Local Development

This project uses HTTPS for local development instead of Firebase's HTTP hosting emulator.
This allows seamless switching between emulated services and the production backend.

## If you used `npx create-tosijs-platform-app`

Certificates are generated automatically during setup. You're all set!

## Manual Setup

Run the provided script:

```
cd tls
./create-dev-certs.sh
cd ..
```

Or run the commands manually:

```
openssl genrsa -out key.pem 4096
openssl req -new -sha256 -key key.pem -out csr.csr
openssl req -x509 -sha256 -days 365 -key key.pem -in csr.csr -out certificate.pem
openssl req -in csr.csr -text -noout | grep -i "Signature.*SHA256" && echo "All is well"
```

## Browser Warning

When you first visit https://localhost:8020, your browser will warn about the
self-signed certificate. This is expected - click through to proceed.

## Certificate Files (gitignored)

- `key.pem` - Private key
- `certificate.pem` - Self-signed certificate
- `csr.csr` - Certificate signing request

These files are in .gitignore and should not be committed.

[Instructions adapted from here](https://msol.io/blog/tech/create-a-self-signed-ssl-certificate-with-openssl/)
