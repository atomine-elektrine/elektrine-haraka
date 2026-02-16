#!/bin/bash

# Firewall Setup for elektrine-haraka
# Run this script on your host server (not in Docker)

set -e

echo "🔥 Setting up UFW firewall rules for elektrine-haraka..."

# Reset UFW to defaults
sudo ufw --force reset

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (adjust port if needed)
sudo ufw allow ssh
echo "✅ SSH access allowed"

# HTTP/HTTPS (port 80 needed for Let's Encrypt challenges)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
echo "✅ HTTP/HTTPS traffic allowed (port 80 required for SSL certificates)"

# SMTP ports
sudo ufw allow 25/tcp
sudo ufw allow 587/tcp
echo "✅ SMTP traffic allowed"

# Rate limiting for SMTP (prevent abuse)
sudo ufw limit 25/tcp
sudo ufw limit 587/tcp
echo "✅ SMTP rate limiting enabled"

# Allow localhost connections (for API)
sudo ufw allow from 127.0.0.1
sudo ufw allow from ::1
echo "✅ Localhost traffic allowed"

# Optional: Allow specific IP ranges for management
# sudo ufw allow from 192.168.1.0/24
# sudo ufw allow from 10.0.0.0/8

# Enable UFW
sudo ufw --force enable

# Show status
sudo ufw status verbose

echo ""
echo "🎉 Firewall setup complete!"
echo ""
echo "Open ports:"
echo "  22/tcp  - SSH"  
echo "  25/tcp  - SMTP (rate limited)"
echo "  80/tcp  - HTTP (required for Let's Encrypt SSL certificates)"
echo "  443/tcp - HTTPS" 
echo "  587/tcp - SMTP Submission (rate limited)"
echo ""
echo "All other ports are blocked by default."
echo ""
echo "To allow additional IPs for management:"
echo "  sudo ufw allow from YOUR.IP.ADDRESS.HERE"
