# VPS Deployment Guide

Complete guide to deploy the Initiation of Coverage app on a VPS with a custom domain.

---

## Part 1: Get Your Accounts

### 1.1 Create DigitalOcean Account
1. Go to https://digitalocean.com
2. Sign up (they often have $200 free credit for new users)
3. Add a payment method

### 1.2 Buy a Domain
1. Go to https://namecheap.com (or Cloudflare, Porkbun)
2. Search for your desired domain
3. Purchase it (~$10-15/year for .com)
4. Note: Don't change any DNS settings yet

---

## Part 2: Create the Server

### 2.1 Create a Droplet (DigitalOcean's term for VPS)
1. Log into DigitalOcean
2. Click **Create** → **Droplets**
3. Choose:
   - **Region**: Pick closest to your users (e.g., New York, San Francisco)
   - **Image**: Ubuntu 22.04 LTS
   - **Size**: Basic → Regular → $6/mo (1GB RAM, 25GB SSD)
   - **Authentication**: Choose **SSH Key** (recommended) or **Password**

#### If using SSH Key (recommended):
On your Mac terminal, run:
```bash
# Check if you already have a key
cat ~/.ssh/id_rsa.pub

# If not, create one:
ssh-keygen -t rsa -b 4096
# Press Enter for all prompts

# Copy your public key:
cat ~/.ssh/id_rsa.pub
```
Paste the output into DigitalOcean's SSH key field.

4. **Hostname**: Enter something like `retailbbg-server`
5. Click **Create Droplet**
6. Wait ~60 seconds, then copy the **IP address** (e.g., `143.198.123.45`)

---

## Part 3: Configure the Server

### 3.1 Connect to Your Server
```bash
ssh root@YOUR_IP_ADDRESS
# Example: ssh root@143.198.123.45
```

If prompted about fingerprint, type `yes`.

### 3.2 Initial Server Setup
Run these commands one by one:

```bash
# Update system packages
apt update && apt upgrade -y

# Create a non-root user (replace 'jack' with your name)
adduser jack
# Enter a password when prompted, press Enter for other questions

# Give user sudo privileges
usermod -aG sudo jack

# Allow SSH for new user
cp -r ~/.ssh /home/jack/
chown -R jack:jack /home/jack/.ssh

# Set up firewall
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
# Type 'y' when prompted
```

### 3.3 Switch to Your User
```bash
# Log out
exit

# Log back in as your user
ssh jack@YOUR_IP_ADDRESS
```

---

## Part 4: Install Node.js

```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
npm --version   # Should show 10.x.x

# Install PM2 (process manager - keeps your app running)
sudo npm install -g pm2
```

---

## Part 5: Deploy Your App

### 5.1 Clone Your Repository
```bash
# Go to home directory
cd ~

# Clone your repo
git clone https://github.com/Cahnja/retailbbg.git

# Enter the directory
cd retailbbg

# Install dependencies
npm install
```

### 5.2 Create Environment File
```bash
nano .env
```

Paste your API keys:
```
OPENAI_API_KEY=your_openai_key_here
SEC_API_KEY=your_sec_api_key_here
EARNINGSCALL_API_KEY=your_earningscall_key_here
PORT=3000
```

Save: Press `Ctrl+X`, then `Y`, then `Enter`

### 5.3 Create Cache Directory
```bash
mkdir -p cache/sec cache/earnings
```

### 5.4 Start the App with PM2
```bash
# Start the app
pm2 start server.js --name retailbbg

# Make PM2 start on server reboot
pm2 startup
# Run the command it outputs

pm2 save

# Check it's running
pm2 status
```

### 5.5 Test It
```bash
curl http://localhost:3000
```
Should return your HTML.

---

## Part 6: Set Up Nginx (Web Server)

Nginx handles incoming web traffic and forwards it to your Node app.

### 6.1 Install Nginx
```bash
sudo apt install nginx -y
```

### 6.2 Create Nginx Config
```bash
sudo nano /etc/nginx/sites-available/retailbbg
```

Paste this (replace `yourdomain.com` with your actual domain):
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }
}
```

Save: `Ctrl+X`, `Y`, `Enter`

### 6.3 Enable the Site
```bash
# Create symlink
sudo ln -s /etc/nginx/sites-available/retailbbg /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test config
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx
```

---

## Part 7: Point Your Domain to the Server

### 7.1 Get Your Server IP
```bash
# On your server, or check DigitalOcean dashboard
curl ifconfig.me
```

### 7.2 Update DNS at Namecheap
1. Log into Namecheap
2. Go to **Domain List** → Click **Manage** on your domain
3. Go to **Advanced DNS** tab
4. Delete any existing A records or CNAME records for @ and www
5. Add these records:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A | @ | YOUR_IP_ADDRESS | Automatic |
| A | www | YOUR_IP_ADDRESS | Automatic |

6. Save changes
7. **Wait 5-30 minutes** for DNS to propagate

### 7.3 Test Your Domain
```bash
# From your local machine
curl http://yourdomain.com
```

---

## Part 8: Set Up SSL (HTTPS)

### 8.1 Install Certbot
```bash
sudo apt install certbot python3-certbot-nginx -y
```

### 8.2 Get SSL Certificate
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

- Enter your email when prompted
- Agree to terms
- Choose whether to share email (optional)
- Select option 2 to redirect HTTP to HTTPS

### 8.3 Verify Auto-Renewal
```bash
sudo certbot renew --dry-run
```

---

## Part 9: You're Done!

Your app is now live at `https://yourdomain.com`

### Useful Commands

```bash
# Check app status
pm2 status

# View app logs
pm2 logs retailbbg

# Restart app
pm2 restart retailbbg

# Check nginx status
sudo systemctl status nginx

# View nginx error logs
sudo tail -f /var/log/nginx/error.log
```

---

## Part 10: Updating Your App

When you push changes to GitHub:

```bash
# SSH into server
ssh jack@YOUR_IP_ADDRESS

# Go to app directory
cd ~/retailbbg

# Pull latest changes
git pull

# Install any new dependencies
npm install

# Restart app
pm2 restart retailbbg
```

### Optional: Auto-Deploy with GitHub Webhook
(Ask if you want this set up - it auto-deploys when you push to GitHub)

---

## Troubleshooting

### App won't start
```bash
pm2 logs retailbbg --lines 50
```

### Nginx errors
```bash
sudo nginx -t
sudo tail -f /var/log/nginx/error.log
```

### Domain not working
```bash
# Check DNS propagation
dig yourdomain.com

# Should show your server IP
```

### SSL certificate issues
```bash
sudo certbot certificates
sudo certbot renew
```

---

## Monthly Cost Summary

| Item | Cost |
|------|------|
| DigitalOcean Droplet (1GB) | $6/mo |
| Domain (.com) | ~$12/year (~$1/mo) |
| SSL Certificate | Free |
| **Total** | **~$7/month** |

---

## Your Credentials Checklist

Fill this in as you go:

- [ ] DigitalOcean account created
- [ ] Domain purchased: _______________
- [ ] Server IP: _______________
- [ ] SSH user: _______________
- [ ] SSL certificate installed
