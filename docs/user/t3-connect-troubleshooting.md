# Parity Connect troubleshooting

A Parity Connect connection passes through four stages:

1. **This device** reaches Parity Connect over the internet.
2. **Parity Connect** verifies your sign-in and host link.
3. **The host's tunnel** (`cloudflared`) forwards the request to the host.
4. **Par3 on the host** answers.

When a connection fails, open **Settings → Environments**, select the environment, and choose **Details**—the first failed stage identifies the cause below. On the host itself, run `par3 connect status` or check **Settings → Sharing & access**.

## The host's tunnel is offline

Parity Connect could not reach the host's tunnel (host is asleep/offline, Par3 isn't running, or outbound port 7844 is blocked).

1. Confirm the host is awake and running Par3.
2. Run `par3 connect status` on the host.
3. If the host was offline for 7+ days on an older version, start and update Par3 on the host to recreate its tunnel.

## Port 7844 is blocked on the host

`cloudflared` connects outbound to Cloudflare on **TCP and UDP port 7844** (normal web traffic still works when 7844 is blocked).

- **HTTP proxy**: Par3 uses `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` for sign-in and relay HTTP requests, and honors `NO_PROXY`. The tunnel does not go through that proxy: `cloudflared` still needs direct outbound access to port 7844.
- **Tailscale exit node**: Run `tailscale set --exit-node=` on the host or allow outbound 7844 on the exit node.
- **Work VPN / firewall**: Allow outbound TCP/UDP 7844, or bypass Parity Connect by adding a direct Tailscale route ([Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways)).

## The tunnel works, but Par3 does not answer

The tunnel is up, but Par3 didn't respond on `127.0.0.1` (crashed, starting up, port changed, or `T3CODE_HOST` bound only a non-loopback IP).

Restart Par3 on the host (`par3 service restart` for a background service) and run `par3 connect status`.

## The Parity Connect address does not resolve or answer

The host's Parity Connect address failed DNS, TLS, connection, or timed out.

1. Confirm the host is online and run `par3 connect status`.
2. If only the host fails, check DNS/VPN/proxy (stale DNS caches clear in ~30 minutes).
3. If the address no longer points to this host, re-link it: toggle **Parity Connect** off and on in **Settings → Sharing & access**, or run `par3 connect link` and restart the server.

## This device can't reach Parity Connect

The issue is on the client device's network:

1. Check for captive portals or dead Wi-Fi.
2. Temporarily disable VPNs, firewalls, ad blockers, or DNS filters (on iPhone, test turning off Wi-Fi **Connectivity Assist**).
3. Try another network or add a direct Tailscale route ([Reach one machine several ways](./remote-access.md#reach-one-machine-several-ways)).

## Sign-in, account, or link problems

- **Different account**: Sign in to the same Parity Connect account on both sides (on host: `par3 connect logout && t3 connect`).
- **Parity Connect disabled on host**: Turn on **Settings → Sharing & access → Parity Connect** or run `par3 connect`.
- **Link not yet applied**: Restart Par3 on the host (`par3 service restart` or restart desktop app).
- **Expired session**: Sign out of Parity Connect and sign back in.
- **Waiting for device approval**: Approve the displayed code from an existing device or run `par3 auth connect-device approve <code>` on the host ([Approve new devices](./remote-access.md#approve-new-devices)).
- **Machine limit reached**: Deregister an unused host or connect it another way (see [Machine limit](./remote-access.md#machine-limit)), then restart the host.

## The clock is off

Parity Connect uses short-lived signed proofs. Enable automatic date and time on both the host and client device, then retry.

## The host runs an older Par3

Update Par3 on the host machine ([Updating Par3](./updating.md)).

## Parity Connect returned an error

| Error                                            | Fix                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` / tunnel limit | Deregister an unused host, then restart the host.                                                                             |
| `auth_invalid` / `invalid_bearer`                | Run `par3 connect login` (or `par3 connect logout && t3 connect`), then restart the server.                                   |
| Expired or invalid link proof                    | Sync system clock, update Par3, and restart.                                                                                  |
| HTTP 403 (unrecognized)                          | If device approval is on, update the client and approve it; otherwise check proxies/firewalls and save any Cloudflare Ray ID. |
| HTTP 408, 429, or 5xx                            | Temporary—wait a few minutes for automatic retry.                                                                             |

After fixing a permanent error, restart the host (`par3 service restart` or restart `par3 serve`). If Par3 stops when SSH disconnects, see [background-service troubleshooting](./background-service.md#troubleshooting).

## Report a problem

Open an issue on [GitHub](https://github.com/Pho3niX90/par3/issues) with:

- **Copy diagnostics** from the environment's **Details**
- Output of `par3 connect status` on the host
- Trace ID (if shown)
- `~/.t3/userdata/logs/relay-client.ndjson` (tunnel tokens are already stripped)
