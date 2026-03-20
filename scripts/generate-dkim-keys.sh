#!/bin/bash

set -euo pipefail

if [ "$#" -gt 0 ]; then
  domains=("$@")
else
  domains=(
    example.com
  )
fi

echo "Generating DKIM keys for: ${domains[*]}"

mkdir -p config/dkim

for domain in "${domains[@]}"; do
  echo "Generating keys for ${domain}..."
  openssl genrsa -out "config/dkim/${domain}.key" 2048
  openssl rsa -in "config/dkim/${domain}.key" -pubout -out "config/dkim/${domain}.pub"
done

echo "Keys generated successfully!"
echo ""
echo "DNS Records to add:"
echo "==================="

for domain in "${domains[@]}"; do
  pubkey=$(openssl rsa -in "config/dkim/${domain}.key" -pubout -outform DER 2>/dev/null | openssl base64 -A | tr -d '\n')
  echo ""
  echo "For ${domain}:"
  echo "default._domainkey.${domain}. TXT \"v=DKIM1; k=rsa; p=${pubkey}\""
done

echo ""
echo "SPF Records:"
for domain in "${domains[@]}"; do
  echo "${domain}. TXT \"v=spf1 ip4:YOUR_VPS_IP ~all\""
done

echo ""
echo "DMARC Records:"
for domain in "${domains[@]}"; do
  echo "_dmarc.${domain}. TXT \"v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}\""
done

chmod 600 config/dkim/*.key
chmod 644 config/dkim/*.pub

echo ""
echo "Key permissions set. Private keys are now readable only by owner."
