# KU-Fleet — Deployment Runbook

Prepared locally. **Nothing in this document has been executed against AWS.**
Every AWS command below is for you to run, in order, after review.

---

## 0. Prerequisites and versions

| Component   | Version / value                          | Why                                       |
| ----------- | ---------------------------------------- | ----------------------------------------- |
| OS          | Amazon Linux 2023                        | The existing instance                     |
| Node.js     | **22.x**                                 | `package.json` `engines.node = 22.x`      |
| npm         | bundled with Node 22                     | `npm ci` needs the committed lockfile     |
| PM2         | latest                                   | Process supervision + reboot persistence  |
| Redis       | **7.x**, `bind 127.0.0.1`                | Replaces Upstash request-quota failures   |
| MongoDB     | existing provider, **unchanged**         | Source of truth for durable data          |

Ports:

| Port | Protocol        | Exposure                                |
| ---- | --------------- | --------------------------------------- |
| 3000 | HTTP + Socket.IO | Loopback only, published via Cloudflare |
| 5050 | Raw GT06 TCP    | **Public**, from tracker IPs            |
| 6379 | Redis           | **Loopback only. Never open the SG.**   |

---

## 1. Redis on EC2 (Amazon Linux 2023)

Local Redis removes the Upstash per-request quota that was causing the
failures. It binds to loopback and is **not** added to the security group.

```bash
# Install from Amazon Linux 2023 Extras
sudo dnf install -y redis6

# Create a config file
sudo tee /etc/redis.conf > /dev/null <<'EOF'
bind 127.0.0.1
port 6379
protected-mode yes

# Persistence. BullMQ job state and the distributed locks MUST survive a
# restart, so AOF is enabled. RDB is kept as a second safety net.
appendonly yes
appendfsync everysec
save 900 1
save 300 10
save 60 10000
dir /var/lib/redis

# Memory. t3.micro has 1 GiB total; leave headroom for Node and the OS.
# 200MB gives Redis room to work without inviting the OOM killer.
maxmemory 200mb

# CRITICAL: do NOT use allkeys-lru / volatile-lru.
# Evicting a BullMQ job key or a live lock key silently corrupts trips.
# With AOF + bounded maxmemory, prefer failing writes over evicting state.
maxmemory-policy noeviction

loglevel notice
EOF

sudo systemctl enable --now redis
sudo systemctl status redis --no-pager
redis-cli ping        # expect PONG
redis-cli config get maxmemory-policy   # expect noeviction
```

**Recovery procedure** (test it before you need it):

```bash
sudo systemctl restart redis
redis-cli ping
pm2 restart kufleet-backend --update-env
pm2 logs kufleet-backend --lines 50
```

Watch memory (the instance is small):

```bash
redis-cli info memory | grep -E 'used_memory_human|maxmemory_human'
redis-cli info stats  | grep rejected_connections
df -h /
```

---

## 2. Application on EC2

```bash
sudo dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs

sudo useradd --system --create-home --shell /sbin/nologin kuapp 2>/dev/null || true
sudo mkdir -p /opt/kufleet
sudo chown -R kuapp:kuapp /opt/kufleet

sudo npm install -g pm2
sudo -u kuapp pm2 startup systemd -u kuapp --hp /home/kuapp
# Run the printed command as root, then:
sudo -u kuapp pm2 save
```

Deploying a release (this is what GitHub Actions does too):

```bash
sudo -u kuapp bash -lc '
  set -euo pipefail
  RELEASE=/opt/kufleet/releases/$(date +%s)
  mkdir -p "$RELEASE"
  # ... copy the source tree here ...
  cd "$RELEASE"
  npm ci --omit=dev
  test -f dist/server.js || { echo "dist/server.js missing"; exit 1; }
  test -f dist/tcp/tcpServer.js || { echo "dist/tcp/tcpServer.js missing"; exit 1; }
  ln -sfn "$RELEASE" /opt/kufleet/current.new
  mv -Tf /opt/kufleet/current.new /opt/kufleet/current
'
sudo -u kuapp bash -lc 'cd /opt/kufleet/current && pm2 reload deploy/ecosystem.config.cjs --update-env && pm2 save'
```

---

## 3. Environment variables

**Your existing `.env` values are preserved — do not recreate them.**

```bash
sudo install -o kuapp -g kuapp -m 600 /path/to/your/.env /opt/kufleet/.env
sudo chown kuapp:kuapp /opt/kufleet/.env
sudo chmod 600 /opt/kufleet/.env
```

`src/config/env.ts` resolves `.env` from the **backend root**, not the shell's
working directory, so the file must live at `<backend-root>/.env`.

Two changes to make in that file for the new setup:

```bash
# 1. Point at local Redis instead of Upstash (removes the request quota limit).
sudo sed -i 's|^REDIS_URL=.*|REDIS_URL=redis://127.0.0.1:6379|' /opt/kufleet/.env

# 2. The file currently contains JWT_EXPIRY, which the code never reads.
#    The code reads JWT_EXPIRES_IN. Add it alongside (do not delete your line).
echo 'JWT_EXPIRES_IN=7d' >> /opt/kufleet/.env
```

Verify without printing any secret:

```bash
sudo -u kuapp bash -lc 'cd /opt/kufleet/current && node -e "
  require(\"./dist/config/env\");
  const {missingRequiredEnv} = require(\"./dist/config/env\");
  const m = missingRequiredEnv();
  console.log(m.length ? \"MISSING: \"+m.join(\", \") : \"config OK\");
"'
```

Never `cat` the `.env`. Never paste it into a ticket or chat.

---

## 4. PM2

```bash
sudo -u kuapp bash -lc 'cd /opt/kufleet/current && pm2 start deploy/ecosystem.config.cjs'
sudo -u kuapp pm2 save
sudo -u kuapp pm2 status
sudo -u kuapp pm2 logs kufleet-backend --lines 50
sudo -u kuapp pm2 monit
```

A healthy startup log contains, in this order:

```
Redis connected (plaintext)
MongoDB Connected: ...
HTTP + Socket.IO running on port 3000
TCP server listening on port 5050
cron scheduled: daily-cleanup (0 2 * * *)
...
```

`MTX token init failed` is expected and non-fatal if MTX is unreachable.

---

## 5. Cloudflare Quick Tunnel (HTTP + Socket.IO only)

Quick Tunnels need no domain and no Cloudflare account, but the hostname is
**random on every restart** and carries **no uptime guarantee**. It is for
testing only.

```bash
# Install
sudo dnf install -y wget
wget -qO- https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  | sudo tee /usr/local/bin/cloudflared >/dev/null
sudo chmod +x /usr/local/bin/cloudflared

# Run
sudo -u kuapp /usr/local/bin/cloudflared tunnel --url http://127.0.0.1:3000
```

It prints a `https://<random>.trycloudflare.com` URL. Put that into the
frontend's API and Socket.IO base URL.

**Critical:** this publishes **HTTP and Socket.IO only**. The GT06 tracker
connects over raw TCP to the EC2 public IP on **5050** and is unaffected by the
tunnel. Do not route tracker traffic through the tunnel.

For a stable hostname you must own a domain and use a *named* tunnel.

---

## 6. GT06 tracker TCP

The tracker's host/port must be set to the **EC2 public IPv4** and port `5050`.

```bash
# Confirm the listener
ss -tlnp | grep 5050

# Confirm the security group allows 5050 from the internet
# (EC2 console -> Network -> Security groups -> launch-wizard-1 -> Inbound)
```

Reconnect test from any machine:

```bash
# Expect a 12-byte ACK: 7878 05 01 0001 d9dc 0d0a
printf '\x78\x78\x0d\x01\x01\x23\x45\x67\x89\x01\x23\x45\x00\x01\x8c\xdd\x0d\x0a' | nc <EC2_PUBLIC_IP> 5050 | xxd
```

Note: the public IPv4 is auto-assigned and **changes on stop/start**. If the
tracker is configured with a literal IP it will stop reporting after a reboot.
An Elastic IP fixes this but is a billable resource — request approval first.

---

## 7. GitHub Actions

The workflow at `.github/workflows/deploy-ec2.yml` is **`workflow_dispatch`
only** and cannot run until you enable it:

```bash
gh workflow enable "Deploy backend to EC2"
```

Repository secrets to configure:

| Secret          | Value                                        |
| --------------- | -------------------------------------------- |
| `EC2_SSH_KEY`   | Contents of the private key used for CI      |
| `EC2_USER`      | `kuapp`                                      |
| `EC2_HOST`      | EC2 public IP or a bastion address           |
| `EC2_REMOTE_DIR`| `/opt/kufleet`                               |
| `EC2_BASE_URL`  | `http://127.0.0.1:3000` for the health check |

The workflow builds and tests **before** uploading anything, syncs into a fresh
release directory, validates the artifacts, atomically swaps the `current`
symlink, reloads PM2, health-checks, and rolls back on failure.

**SSH exposure warning:** GitHub-hosted runners use wide-ranging IP addresses,
so allowing SSH from `0.0.0.0/0` is required for this to work — which is why
OIDC + SSM is preferable and needs infrastructure you do not have yet. Keep the
SSH key scoped, and rotate it if it is ever exposed.

---

## 8. Health checks and smoke tests

```bash
# HTTP
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/     # 200

# Redis
redis-cli ping                                                   # PONG

# Mongo (no credentials printed)
sudo -u kuapp bash -lc 'cd /opt/kufleet/current && node -e "
  const m=require(\"mongoose\");require(\"./dist/config/env\");
  m.connect(process.env.MONGO_URI).then(()=>{console.log(\"mongo OK\");return m.disconnect()})
   .catch(e=>{console.error(\"mongo FAIL\");process.exit(1)})"'

# TCP listener
ss -tlnp | grep 5050

# Public tunnel
curl -s -o /dev/null -w '%{http_code}\n' https://<tunnel-host>/
```

---

## 9. Rollback

Every release is preserved under `/opt/kufleet/releases/`.

```bash
PREV=$(readlink -f /opt/kufleet/current.previous)
sudo -u kuapp bash -lc "cd /opt/kufleet && \
  ln -sfn $PREV current.new && mv -Tf current.new current"
sudo -u kuapp bash -lc 'cd /opt/kufleet/current && pm2 reload deploy/ecosystem.config.cjs --update-env && pm2 save'
```

List releases and roll back to any of them:

```bash
ls -1t /opt/kufleet/releases
```

MongoDB is **not** rolled back by this procedure. Redis holds only cache,
locks and queue state, so a code rollback is sufficient. Take a Mongo backup
before any destructive change.

---

## 10. Troubleshooting

| Symptom                                   | Cause / fix                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `MONGO_URI environment variable is not defined` | Started from the wrong directory. `cd` into the backend root, or check `.env` exists there. |
| `Redis connection closed` loop            | Redis is down. `sudo systemctl status redis`.                                |
| `ETIMEDOUT` / TLS handshake errors        | `REDIS_URL` still points at a `rediss://` host. Local Redis must be `redis://127.0.0.1:6379`. |
| TCP 5050 unreachable from a tracker       | Security group inbound rule, or the EC2 IP changed after a stop/start.      |
| Trackers connect but no trips             | Check `Bus.trackerIMEI` matches the 15-digit IMEI the parser produces.       |
| Duplicate cleanup runs                    | More than one PM2 instance. Ensure `instances: 1`.                           |
| `Graceful shutdown timed out`             | Something is holding a socket. Check `pm2 logs` for the last step printed.  |
| Out of disk                               | `pm2 flush`, then `du -sh /root/.pm2/logs /var/lib/redis /opt/kufleet`.     |
| Out of memory on a 1 GiB instance         | `redis-cli info memory`. Lower `maxmemory` or move Mongo/Redis off-host.     |

---

## 11. Disk and memory monitoring

```bash
df -h /                                   # root volume
free -m                                   # RAM
ps -o pid,rss,comm -p $(pm2 pid kufleet-backend)   # Node RSS in KB
redis-cli info memory | grep used_memory_human
pm2 monit
```

Recommended CloudWatch-style alerts (set up after deployment): root disk > 80%,
memory > 85%, Redis `rejected_connections` > 0 (means `maxmemory` is too low),
PM2 restart count climbing.