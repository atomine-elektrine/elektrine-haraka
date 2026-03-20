# DKIM Keys Directory

This directory should contain DKIM private keys for email signing.

Default domain key files:
- `example.com.key` - DKIM private key for your primary mail domain

Custom domains are also supported. You can either:
- place `<domain>.key` files directly in this directory, or
- create `config/dkim/<domain>/private` and `config/dkim/<domain>/selector`

At container start, `scripts/start-haraka.sh` automatically converts any
top-level `<domain>.key` files into the per-domain layout Haraka's DKIM plugin
expects, using `default` as the selector when no selector file is present.

## Generate DKIM Keys

To generate DKIM keys for the default domain:

```bash
./scripts/generate-dkim-keys.sh
```

To generate keys for custom domains:

```bash
./scripts/generate-dkim-keys.sh example.com mail.example.net
```

## DNS Records

Add TXT records to your DNS:

```
default._domainkey.example.com TXT "v=DKIM1; k=rsa; p=<public_key_from_example.com.pub>"
```

Note: Remove `-----BEGIN PUBLIC KEY-----`, `-----END PUBLIC KEY-----`, and newlines from the public key when creating DNS records.
