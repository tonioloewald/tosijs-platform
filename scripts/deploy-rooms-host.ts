#!/usr/bin/env bun
/**
 * Deploy the rooms host (functions/src/adapters/bun/rooms-host.ts) to the
 * preview box, the one `tosijs-tunnel` uses (D26: rooms v1 does not use Firebase).
 *
 *   bun scripts/deploy-rooms-host.ts         # DRY RUN: builds, shows the plan, changes nothing
 *   bun scripts/deploy-rooms-host.ts --go    # deploy
 *
 * The box is `PREVIEW_HOST` (source ~/local-secrets/tosijs-preview.env; never
 * print or commit it). What it touches there, and nothing else:
 *
 *   /opt/tosijs-rooms/tosijs-rooms-host        the executable (Bun inside); the last one kept as .prev
 *   /var/lib/tosijs-rooms/                     host.db and guest-secret, owned by the service user
 *   /etc/systemd/system/tosijs-rooms.service   runs it as `tosijs-rooms`, on 127.0.0.1:5101
 *   /srv/preview/_sites/tosijs-rooms.caddy     routes https://rooms.dev.tosijs.net to it
 *
 * Other projects share that Caddy, so the fragment is validated before the
 * reload and removed again (the previous one restored) if the config does not
 * parse: one bad fragment would fail every project's reload. A new binary
 * that does not answer /health is rolled back to .prev.
 */
import { $ } from 'bun'

const HOSTNAME = 'rooms.dev.tosijs.net'
const PORT = 5101
const BINARY = 'build/rooms-host/tosijs-rooms-host'
const go = process.argv.includes('--go')
const target = process.env.PREVIEW_HOST
if (!target) {
  console.error('PREVIEW_HOST is not set: . ~/local-secrets/tosijs-preview.env first')
  process.exit(2)
}

const UNIT = `[Unit]
Description=tosijs-platform rooms host (D26)
After=network-online.target
Wants=network-online.target

[Service]
User=tosijs-rooms
Group=tosijs-rooms
ExecStart=/opt/tosijs-rooms/tosijs-rooms-host --data /var/lib/tosijs-rooms --port ${PORT} --host 127.0.0.1
Restart=always
RestartSec=2
MemoryMax=256M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/tosijs-rooms
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=true

[Install]
WantedBy=multi-user.target
`

// No preview_site import: that gates on the invite cookie, and rooms are
// called by games and agents. The host itself requires a guest token.
const FRAGMENT = `# Written by tosijs-platform scripts/deploy-rooms-host.ts. Do not hand-edit.
${HOSTNAME} {
	reverse_proxy 127.0.0.1:${PORT}
	log {
		output file /var/log/caddy/rooms.log {
			roll_size 10MiB
			roll_keep 3
		}
	}
}
`

const REMOTE = `set -eu
id tosijs-rooms >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tosijs-rooms
install -d -m 755 -o root -g root /opt/tosijs-rooms
install -d -m 700 -o tosijs-rooms -g tosijs-rooms /var/lib/tosijs-rooms
chmod 755 /tmp/tosijs-rooms-host.upload
[ -f /opt/tosijs-rooms/tosijs-rooms-host ] && cp -p /opt/tosijs-rooms/tosijs-rooms-host /opt/tosijs-rooms/tosijs-rooms-host.prev
mv /tmp/tosijs-rooms-host.upload /opt/tosijs-rooms/tosijs-rooms-host
cat > /etc/systemd/system/tosijs-rooms.service <<'UNIT'
${UNIT}UNIT
systemctl daemon-reload
systemctl enable --quiet tosijs-rooms
systemctl restart tosijs-rooms
ok=
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:${PORT}/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "the new host did not answer /health" >&2
  journalctl -u tosijs-rooms -n 20 --no-pager >&2 || true
  if [ -f /opt/tosijs-rooms/tosijs-rooms-host.prev ]; then
    mv /opt/tosijs-rooms/tosijs-rooms-host.prev /opt/tosijs-rooms/tosijs-rooms-host
    systemctl restart tosijs-rooms
    echo "rolled back to the previous executable" >&2
  fi
  exit 1
fi
FRAG=/srv/preview/_sites/tosijs-rooms.caddy
[ -f "$FRAG" ] && cp -p "$FRAG" /tmp/tosijs-rooms.caddy.prev || rm -f /tmp/tosijs-rooms.caddy.prev
cat > "$FRAG" <<'CADDY'
${FRAGMENT}CADDY
if ! (set -a; . /etc/caddy/preview.env 2>/dev/null; set +a; caddy validate --config /etc/caddy/Caddyfile >/tmp/tosijs-rooms.validate 2>&1); then
  tail -4 /tmp/tosijs-rooms.validate >&2
  if [ -f /tmp/tosijs-rooms.caddy.prev ]; then mv /tmp/tosijs-rooms.caddy.prev "$FRAG"; else rm -f "$FRAG"; fi
  echo "Caddy config invalid with the fragment: removed it, NOT reloading" >&2
  exit 1
fi
systemctl reload caddy
echo "deployed: $(systemctl is-active tosijs-rooms)"
`

console.log('building the executable…')
await $`bun run build:rooms-host`.quiet()
const size = (Bun.file(BINARY).size / 1e6).toFixed(0)

console.log(`\nplan (${go ? 'GO' : 'DRY RUN'}):
  upload   ${BINARY} (${size} MB) → /opt/tosijs-rooms/tosijs-rooms-host (previous kept as .prev)
  service  tosijs-rooms.service as user tosijs-rooms, 127.0.0.1:${PORT}, data /var/lib/tosijs-rooms
  route    https://${HOSTNAME} → 127.0.0.1:${PORT} (/srv/preview/_sites/tosijs-rooms.caddy, validated before reload)`)
if (!go) {
  console.log('\nDRY RUN: nothing changed. Run again with --go to deploy.')
  process.exit(0)
}

await $`scp -q ${BINARY} ${`${target}:/tmp/tosijs-rooms-host.upload`}`
const result = await $`ssh ${target} bash -s < ${new Response(REMOTE)}`.nothrow()
if (result.exitCode !== 0) process.exit(result.exitCode)

let healthy = false
for (let i = 0; i < 20 && !healthy; i++) {
  healthy = await fetch(`https://${HOSTNAME}/health`).then((r) => r.ok, () => false)
  if (!healthy) await Bun.sleep(1500)
}
console.log(healthy ? `live: https://${HOSTNAME}` : `the service runs, but https://${HOSTNAME}/health does not answer yet (certificate?)`)
process.exit(healthy ? 0 : 1)
