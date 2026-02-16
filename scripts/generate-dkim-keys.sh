#!/bin/bash

# Generate DKIM keys for elektrine.com and z.org

echo "Generating DKIM keys for elektrine.com and z.org..."

# Create dkim directory if it doesn't exist
mkdir -p config/dkim

# Generate keys for elektrine.com
echo "Generating keys for elektrine.com..."
openssl genrsa -out config/dkim/elektrine.com.key 2048
openssl rsa -in config/dkim/elektrine.com.key -pubout -out config/dkim/elektrine.com.pub

# Generate keys for z.org
echo "Generating keys for z.org..."
openssl genrsa -out config/dkim/z.org.key 2048
openssl rsa -in config/dkim/z.org.key -pubout -out config/dkim/z.org.pub

echo "Keys generated successfully!"
echo ""
echo "DNS Records to add:"
echo "==================="

# Extract public keys for DNS records
echo ""
echo "For elektrine.com:"
echo "default._domainkey.elektrine.com. TXT \"v=DKIM1; k=rsa; p=$(openssl rsa -in config/dkim/elektrine.com.key -pubout -outform DER 2>/dev/null | openssl base64 -A | tr -d '\n')\""

echo ""
echo "For z.org:"
echo "default._domainkey.z.org. TXT \"v=DKIM1; k=rsa; p=$(openssl rsa -in config/dkim/z.org.key -pubout -outform DER 2>/dev/null | openssl base64 -A | tr -d '\n')\""

echo ""
echo "SPF Records:"
echo "elektrine.com. TXT \"v=spf1 ip4:YOUR_VPS_IP ~all\""
echo "z.org. TXT \"v=spf1 ip4:YOUR_VPS_IP ~all\""

echo ""
echo "DMARC Records:"
echo "_dmarc.elektrine.com. TXT \"v=DMARC1; p=quarantine; rua=mailto:dmarc@elektrine.com\""
echo "_dmarc.z.org. TXT \"v=DMARC1; p=quarantine; rua=mailto:dmarc@z.org\""

# Set proper permissions
chmod 600 config/dkim/*.key
chmod 644 config/dkim/*.pub

echo ""
echo "Key permissions set. Private keys are now readable only by owner."