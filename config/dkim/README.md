# DKIM Keys Directory

This directory should contain DKIM private keys for email signing.

Required files:
- `elektrine.com.key` - DKIM private key for elektrine.com domain
- `z.org.key` - DKIM private key for z.org domain

## Generate DKIM Keys

To generate DKIM keys for your domains:

```bash
# For elektrine.com
openssl genrsa -out elektrine.com.key 2048
openssl rsa -in elektrine.com.key -pubout > elektrine.com.pub

# For z.org  
openssl genrsa -out z.org.key 2048
openssl rsa -in z.org.key -pubout > z.org.pub
```

## DNS Records

Add TXT records to your DNS:

```
default._domainkey.elektrine.com TXT "v=DKIM1; k=rsa; p=<public_key_from_elektrine.com.pub>"
default._domainkey.z.org TXT "v=DKIM1; k=rsa; p=<public_key_from_z.org.pub>"
```

Note: Remove `-----BEGIN PUBLIC KEY-----`, `-----END PUBLIC KEY-----`, and newlines from the public key when creating DNS records.