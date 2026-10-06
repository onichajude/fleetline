# ADR-0007: Production hosting

- **Status:** **Proposed (decision pending)**
- **Owner:** onichajude
- **Due:** before gate G6

## Requirements
- **Process:** one long-running Node 22.13+ process with WebSockets.
- **Storage:** a persistent encrypted disk for `data/`.
- **Network:** HTTPS with automatic certificates.
- **Backups and logs:** daily backup copy to separate storage; log retention.
- **Cost:** ≤ USD 30/month; in or near the operating country (data residency, area 18).

## Options
| Option | Fit | Notes |
|---|---|---|
| Railway (Hobby) | Good | Deploys from GitHub; volumes; about USD 5/month plus usage |
| Render (Starter + disk) | Good | About USD 7/month plus disk; free tier unsuitable (sleeps, no disk) |
| Small VPS (Hetzner, DigitalOcean) + Caddy | Good | Most control; you patch the OS yourself |
| Vercel / serverless | **Poor** | No long-lived WebSocket process or local disk; would need a redesign |

## Decision
Pending. When decided, record:
- The region
- Who has server access
- Disk encryption
- Where backups go
- Monitoring and alerting
- The rollback procedure

Then update areas 14–16 and the vendor register.
