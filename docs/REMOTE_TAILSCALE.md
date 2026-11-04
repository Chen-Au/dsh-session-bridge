# Remote access without a public IP: Tailscale

This guide exposes the DSH Web GUI to **your own devices only** through a Tailscale tailnet. It does not require a public IP, port forwarding, or a cloud server. Do **not** use Tailscale Funnel for this GUI: the DSH page can run tools and read local files.

## Why Tailscale

- Works behind NAT and CGNAT; no public IP needed.
- WireGuard-encrypted private mesh; only devices in your tailnet can connect.
- `tailscale serve` terminates HTTPS and proxies to the local DSH server at `127.0.0.1:43129`.
- No change to DSH or this plugin is required.

## Host machine (where DSH runs)

1. Install Tailscale:

   ```powershell
   winget install -e --id Tailscale.Tailscale
   ```

2. Sign in and confirm the host is online:

   ```powershell
   tailscale up
   tailscale status
   ```

3. Start Serve for the DSH Web GUI:

   ```powershell
   tailscale serve --bg 43129
   tailscale serve status
   ```

   The status output shows a private HTTPS URL such as:

   ```text
   https://<machine>.<tailnet>.ts.net/
   ```

4. Keep the DSH desktop app running. Do not close it while using remote access.

## Remote device (phone, laptop, tablet)

1. Install Tailscale from <https://tailscale.com/download> and sign in with the **same account**.
2. Confirm the device is connected to the same tailnet.
3. Open the HTTPS URL from `tailscale serve status`.
4. Verify:
   - the DSH page loads;
   - the left-bottom **星桥** button opens the standalone window;
   - `http://<machine>.<tailnet>.ts.net/api/session-bridge/state` returns JSON.

## Security checklist

- Use **tailnet-only Serve**, not Funnel.
- Restrict the tailnet with ACLs; only your own devices should be members.
- Enable device approval or MFA on the Tailscale account.
- Remove lost devices from the admin console immediately.
- Do not share the Serve URL in public screenshots or chats.
- Treat the DSH GUI as a local shell: anyone who can open it may be able to run tools.

## Troubleshooting

- `tailscale serve status` shows nothing: run `tailscale serve --bg 43129` again and check `tailscale status`.
- Page loads but API calls fail: confirm DSH is still running on `127.0.0.1:43129` and that Serve targets port `43129`.
- Login loop or WebSocket errors: try a different browser; some corporate proxies block WebSockets.
- Certificate warning: use the exact `*.ts.net` HTTPS URL printed by `tailscale serve status`; do not use the raw Tailscale IP over HTTP.

## Alternatives

- **Cloudflare Tunnel + Access**: public HTTPS URL with email/OTP login; requires a Cloudflare account and a domain for a stable named tunnel. Never use a bare quick tunnel for this GUI.
- **ngrok**: useful for a short demo only; URLs rotate and the free plan is not a permanent remote-access solution.
- **VPS reverse tunnel**: if you already own a VPS, use SSH remote forwarding or frp with authentication and a firewall allowlist.

## Suggested helper

Run the read-only check first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\remote-tailscale.ps1
```

To start Serve after reviewing the output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\remote-tailscale.ps1 -Apply
```
