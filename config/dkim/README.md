# DKIM Keys Directory

This directory should contain DKIM private keys for email signing.

Built-in domain key files:
- `elektrine.com.key` - DKIM private key for elektrine.com domain
- `elektrine.net.key` - DKIM private key for elektrine.net domain
- `elektrine.org.key` - DKIM private key for elektrine.org domain
- `z.org.key` - DKIM private key for z.org domain

Custom domains are also supported. You can either:
- place `<domain>.key` files directly in this directory, or
- create `config/dkim/<domain>/private` and `config/dkim/<domain>/selector`

At container start, `scripts/start-haraka.sh` automatically converts any
top-level `<domain>.key` files into the per-domain layout Haraka's DKIM plugin
expects, using `default` as the selector when no selector file is present.

## Generate DKIM Keys

To generate DKIM keys for the built-in domains:

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
default._domainkey.elektrine.com TXT "v=DKIM1; k=rsa; p=<public_key_from_elektrine.com.pub>"
default._domainkey.elektrine.net TXT "v=DKIM1; k=rsa; p=<public_key_from_elektrine.net.pub>"
default._domainkey.elektrine.org TXT "v=DKIM1; k=rsa; p=<public_key_from_elektrine.org.pub>"
default._domainkey.z.org TXT "v=DKIM1; k=rsa; p=<public_key_from_z.org.pub>"
```

Note: Remove `-----BEGIN PUBLIC KEY-----`, `-----END PUBLIC KEY-----`, and newlines from the public key when creating DNS records.
