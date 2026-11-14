# Deploying on two hosts

rollforward runs on one host and the browser service ([spoj/rollforward-browser](https://github.com/spoj/rollforward-browser)) on another. Both sit on the company's private network: people reach rollforward over HTTPS, and nothing needs to reach either host from the internet. The VPN trial adds an optional third service, each deployment's own [rollforward-tunnel](https://github.com/spoj/rollforward-tunnel), not part of the shared browser service. This page goes in the order you work in, and links the READMEs rather than repeating them.

## What to ask for

- **Two Linux VMs** with systemd and rootless podman, such as Ubuntu 24.04 LTS or RHEL 9:
  - **rollforward:** about 2 GB for each run at once, plus the 6 GB kept free (`RF_MIN_FREE_GB`), so 32 GB and 8 vCPUs for about ten at once; 200 GB of disk.
  - **browser:** 4 vCPUs, 8 GB and 50 GB: a browser is capped at 2 GB, and idles at about 0.2 GB.
- **A DNS name and a TLS certificate** for rollforward, or a place behind the company's reverse proxy.
- **Routes out of the rollforward host:**
  - the model's API (`openrouter.ai`), for runs and website checks, and Exa's (`api.exa.ai`), for runs' web search and the website check's web-search tool;
  - Microsoft (`login.microsoftonline.com` and `graph.microsoft.com`);
  - the package registries and GitHub that runs install from (`rf egress add HOST` adds hosts);
  - the browser host's port, and, for the VPN trial, this deployment's tunnel API.

  If traffic out must go through a proxy, say so before you start: runs' own connections don't use one yet.
- **Routes out of the browser host:**
  - the websites people sign in to, such as the ERP and the portals, and their sign-on and page dependencies; for the VPN trial, the public gateways' SAML sign-in pages and the tunnel service's proxy;
  - `raw.githubusercontent.com` over HTTPS for the default threat blocklist, or the hosts of the URLs set in `BROWSER_BLOCKLISTS`. This blocklist fetch is browser host → GitHub raw; it does not use rollforward's run egress permissions.
- **An app registered in Entra ID** ([system.md](system.md), Access), with an admin's consent to its delegated Graph permissions.
- **A model API key** for OpenRouter, also used to profile websites and check their hosts, and one for Exa if runs and the website check are to search the web.
- **Deployment services,** if needed: run each beside the server on a private, firewalled HTTP link, then `rf connection set NAME service --url http://HOST:PORT --paths 'AP/,GL/2026/' --key KEY`; its bearer key and streaming HTTP contract are in [system.md](system.md#connections).

## The browser host

1. Give the service a user of its own, with lingering on (`loginctl enable-linger USER`), and install Node 26 and rootless podman. Then follow its README's Run, as a systemd user service. Website sign-ins and checks need a release with open sign-in sessions, `except` and `GET /blocked`: update the browser service before rollforward.
2. Follow its README's "On a host of its own":
   - `BROWSER_HOST` is the host's private address;
   - a firewall lets only the rollforward host reach `BROWSER_PORT`;
   - TLS, or a private link such as WireGuard.
3. Leave `BROWSER_BLOCKLISTS` at its default, `https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt`, or set it in the browser service's environment to a whitespace-separated list of reachable text-file URLs, one domain per line. The service loads them at startup and every 24 hours; a domain covers its subdomains. With no successful load yet, open sign-ins and `GET /blocked?host=HOST` answer 503; a failed refresh keeps the previous list. Ordinary, host-bounded browsers are unaffected. Check `/blocked` from the rollforward host with its client key before trying a sign-in.

## The tunnel service, optional

Only deployments trialling VPNs need this piece. Deploy a browser-service release that supports `site.via` before enabling it. Give it a user of its own, on the rollforward host or a host of its own, never shared between deployments: rollforward deletes every tunnel on it at startup. Follow the tunnel service's README's Run: Node 26, rootless podman, its image and a systemd user service with lingering on. There is no updater or published image; build its image and restart to change it. Each tunnel is capped at 256 MB. The trial is Fortinet SAML only, and has not been tested against a real FortiGate ([system.md](system.md), VPNs).

Keep its API and CONNECT proxy separate:

- **rollforward host → tunnel API:** allow only the rollforward host to `TUNNEL_HOST:TUNNEL_PORT` (default port 8798). Set `RF_TUNNEL_URL` to that API's http(s) address and `RF_TUNNEL_KEY` to its `TUNNEL_KEY`; every API call carries that bearer key, including creation with the gateway cookie.
- **browser host → tunnel proxy:** allow only the browser host to `TUNNEL_PROXY_HOST:TUNNEL_PROXY_PORT` (default port 8799). Set `RF_TUNNEL_PROXY` on rollforward to the proxy's http(s) address as the browser host reaches it. Each CONNECT carries a per-tunnel bearer token, not the service key; the browser service receives it only as a generic upstream proxy's token and knows nothing of VPNs.
- **tunnel host → public VPN gateways:** allow TCP to the gateways' configured ports. Neither rollforward nor the browser service runs a VPN client or gains a VPN route; the browser host reaches the public gateway directly for SAML sign-in, then the website's own-domain traffic goes through the proxy.

Encrypt both inter-service links: use WireGuard or Tailscale, or keep the listeners on loopback behind TLS-ending reverse proxies. The proxy frontend must forward HTTP CONNECT, not just ordinary HTTP. Set `TUNNEL_HOST` and `TUNNEL_PROXY_HOST` to private interfaces only for the encrypted private-link case; use `NODE_EXTRA_CA_CERTS` on the rollforward and browser hosts for a private CA on those links. Neither port is for people or the public internet. From the rollforward host, `curl -fsS -H "authorization: Bearer $RF_TUNNEL_KEY" "$RF_TUNNEL_URL/tunnels"` answers `[]` on a fresh service.

Without `RF_TUNNEL_URL`, the feature stays absent. With it, start the tunnel API before rollforward, which deletes every tunnel on it as it starts; if it is down, rollforward logs that and starts anyway, with VPNs failing until it answers. Admins must explicitly opt each person in with `rf can vpn EMAIL|GROUP,...`, even themselves; configuration and admin role alone expose no VPN controls. Tunnels and their credentials are memory-only, lost on restart, with no VPN-specific scheduled sign-in, reconnect or keepalive. An ordinary website keepalive may use an already connected tunnel and keep it active, never reconnect it. People connect on demand before using a website set to that VPN.

## The rollforward host

Run the image under podman, as a systemd service. The image is the agent image, the runs' userland ([agent/](../agent)), with the server on it, and an update is a rebuild and a restart. Running without Docker (README) would instead give each run a memory cap of its own and seal the keys to the TPM, and updates come by themselves; its runs use the same agent image, which CI publishes.

1. Give the service a user of its own, with lingering on, and install rootless podman. Check out a tagged commit of this repo, and build the agent image, then the server's on it: `podman build -t rollforward-agent agent && podman build -t rollforward .`.
2. Make an empty data folder, `~/rollforward-data`.
3. Write `~/.config/rollforward.env` with:
   - `OPENROUTER_API_KEY`, and, optionally, `EXA_API_KEY` for runs' and website checks' web search: without it, website checks run without search;
   - the `RF_OIDC_*` lines and `RF_PUBLIC_URL` ([system.md](system.md), Access);
   - `RF_ADMINS`, the first admins;
   - `RF_BROWSER_URL` and this server's `RF_BROWSER_KEY`, matching the browser service's `BROWSER_KEY` or one entry in its `BROWSER_KEYS`;
   - `RF_TUNNEL_URL`, `RF_TUNNEL_KEY` and `RF_TUNNEL_PROXY`, only for the optional tunnel service above;
   - `RF_SIGNIN_S` only to change the 600-second website and VPN sign-in window; the page shows its countdown;
   - `RF_MAX_UPLOAD_MB` only to change the 2048 MB an upload holds at most;
   - `RF_SANDBOX_RO`, only if runs should read folders besides their data, such as a read-only mount of a file share.
   - `RF_RUN_TASKS` (2048) and `RF_RUN_FILE_GB` (16), only to change each run's cap on processes and threads, and on one file's size in GB; the host needs Linux 5.14 or later, which counts a run's processes apart from the server's.

4. Install the unit, then run `systemctl --user daemon-reload && systemctl --user start rollforward`:

       # ~/.config/containers/systemd/rollforward.container
       [Container]
       Image=localhost/rollforward
       ContainerName=rollforward
       PublishPort=127.0.0.1:8780:8780
       Volume=%h/rollforward-data:/data
       EnvironmentFile=%h/.config/rollforward.env
       PodmanArgs=--init --memory=48g --pids-limit=65536 --security-opt=unmask=/proc/*
       StopTimeout=20

       [Service]
       Restart=always

       [Install]
       WantedBy=default.target

   `--memory` caps all runs together, below the host's memory; `--pids-limit` is above `RF_MAX_RUNS` (20) runs of `RF_RUN_TASKS` (2048) each, so a run that forks all it may leaves the server room; `unmask=/proc/*` lets bubblewrap sandbox each run; `StopTimeout=20` lets a stop wait the 10 s it gives what runs had sent to be answered, where podman would kill it at 10 s.
5. Put HTTPS in front, such as Caddy:

       rollforward.example.com {
           tls /etc/caddy/rollforward.crt /etc/caddy/rollforward.key
           reverse_proxy 127.0.0.1:8780
       }

   A proxy that buffers, such as nginx, needs `proxy_buffering off` for the page's live updates and `client_max_body_size 0` for uploads. nginx also passes websockets, which the live view of a website's sign-in uses, only when told: `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade` and `proxy_set_header Connection "upgrade"`.

**Where the image can't be built,** such as on a host whose filter blocks Debian's mirrors, run the server as [system.md](system.md)'s Without Docker says, as a systemd user service of the same user. The host's own programs don't matter to runs, whose userland is the agent image, never the host's:

- Node 26 beside the system's, such as in `/opt/node-v26`, bubblewrap, and GNU tar; no zstd, Python or LibreOffice.
- `npm ci --omit=dev`, then `/opt/node-v26/bin/node scripts/agent.ts`, which unpacks the agent image the checkout runs, CI's `agent-<id>` prerelease, into `.agent/<id>` (about 720 MB to fetch, 2.5 GB unpacked).
- The unit `~/.config/systemd/user/rollforward.service` has `WorkingDirectory=%h/rollforward`, `ExecStart=/opt/node-v26/bin/node --env-file=%h/.config/rollforward.env src/server.ts %h/rollforward-data 8780` and `Restart=always`; `systemctl --user set-property rollforward-runs.slice MemoryMax=24G` caps all runs together.

## Keys, backups and updates

- **Keys:** `.rf/session.key` signs sessions, and `.rf/seal.key` encrypts everyone's logins. Back up the data folder nightly without them, and keep a copy of both elsewhere. Without seal.key, people sign in to their logins again.
- **Production deploys by itself:** its updater, `scripts/update.ts`, runs every 15 minutes, as a per-user systemd timer on its server (below).
- **Updates:** check out the next tag, rebuild, and `systemctl --user restart rollforward`, whatever runs are going: the restart cuts them, and they carry on by themselves, their cost so far recorded.
- **Updates without the image** come by themselves: `scripts/update.ts` moves the checkout to the newest GitHub Release `vX.Y.Z`, which CI makes from a tag, once every check on its commit has passed, and only while the checkout sits exactly on a release tag: a push to main alone deploys nothing. It first fetches what the release installs, its packages into npm's cache and its agent image, unpacked beside the one running if its id is new, while the server runs on, so a failure there, as without the network, changes nothing and the next tick tries again; then it stops the server without draining it, cutting whatever runs are going, moves the checkout, installs what changed from that cache (`npm ci`), starts the server, keeping only the agent image it runs and the one before, and goes back by itself if the server doesn't answer within 5 minutes, never trying that release again; if going back fails too, it starts the server as the checkout is, so it never stays stopped. The runs the stop cut are woken and carry on after the start. A checkout on no release tag, as after a person's fix by hand, stops updates until one is checked out again. A tag whose message has a line starting `Manual:` makes a prerelease, which the updater stops at, for a person to deploy by hand. A release's number says how it goes back: a patch, `0.5.1` after `0.5.0`, drops in, an older server reading all it writes, so going back needs nothing; a minor, `0.6.0`, writes what an older server misreads or needs something of whoever runs the host, an environment variable, a key changed or a newer browser service, which its tag's message and Rolling back say; 1.0 waits. It asks GitHub without a token, so every 15 minutes, as a timer of the same user:

       # ~/.config/systemd/user/rollforward-update.service
       [Service]
       Type=oneshot
       WorkingDirectory=%h/rollforward
       Environment=PATH=/opt/node-v26/bin:/usr/local/bin:/usr/bin
       ExecStart=/opt/node-v26/bin/node scripts/update.ts http://127.0.0.1:8780/
       TimeoutStartSec=3h

       # ~/.config/systemd/user/rollforward-update.timer
       [Timer]
       OnBootSec=5min
       OnUnitActiveSec=15min

       [Install]
       WantedBy=timers.target

  then `systemctl --user enable --now rollforward-update.timer`; `journalctl --user -u rollforward-update` shows what it did. It restarts the server as above; `OnCalendar=*-*-* 02:00` in place of the two lines above updates at night only.

## After updating past v0.3.19

- **Rotate** `OPENROUTER_API_KEY`, `RF_BROWSER_KEY`, with the browser service's matching `BROWSER_KEY` or `BROWSER_KEYS` entry, and `RF_OIDC_CLIENT_SECRET`: before it, a run could read them in the server's environment, at `/proc/1/environ` in its sandbox.
- **`EXA_API_KEY` is optional:** without it, website checks run without search.

## Rolling back

Going back to a version from before this release, which brought service connections, deleting instances, and rejecting and withdrawing asks:

- **Stop the updater's timer** while you go back, so it doesn't bring the release back meanwhile.
- **Remove every `service` connection first,** with `rf connection remove NAME`. An older server doesn't know the type, exits as it starts, and restarts into the same exit.
- **Don't delete an instance, or add a service connection, until this release has settled.** An older server answers `GET /api` with 500 once one instance is deleted, as its tombstone has no `create` entry, so the page, `rf ls`, `rf waiting`, `rf show` and `rf wakes` fail for admins and that workspace's people.
- **Going back past assign, list first what it changed,** from `~/rollforward-data`: the instances with an `assign` entry, `grep -l '"op":"assign"' instances/*/log.jsonl`, and the requests to wake an instance, `jq '.requests | map_values(select(.target))' .rf/wakes.json`. An older server ignores `assign` entries, so each such instance's runner reverts to whoever had it before, whose logins its runs then use, and misreads a request with a `target` as one to start an instance of that label, whose Start fails as the instance exists: drop those with `rf request drop ID` first, and after going back have each assigned person take their instance over again.
- **Expect on an older version:** proposals rejected, and questions and proposals withdrawn, show as waiting again, and Close lists them as asks to accept; its `rf site set` drops a website's profile and its VPN, `via`.

## Check

1. `podman logs rollforward` says `rollforward on`. Without the `RF_OIDC_*` lines and `RF_PUBLIC_URL` it doesn't start, and says which are missing.
2. From the rollforward host, `curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" "$RF_BROWSER_URL/sessions"` answers `[]`, and `curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" "$RF_BROWSER_URL/blocked?host=example.com"` answers a host-to-boolean map, not 503.
3. Sign in at `RF_PUBLIC_URL` as one of `RF_ADMINS` and make a workspace. With its +, start a task and comment "Reply OK". The run ends within a few minutes, for about $0.05.
4. Under Logins, Connect Microsoft 365.
5. Under Logins, Websites, add a website by its name and address, sign in before the countdown ends, and save the login. The server checks the website and its hosts; no one is asked to approve hosts during sign-in. A directly reached internal primary host must first be allowed by an admin ([system.md](system.md), Hosts).
6. Ask to use that account in the workspace: as yours, it's approved at once. Have someone who doesn't own it ask there too, and under Waiting on you check whose account it is, its purpose, flags and any client-VPN disclosure, then approve its use, not its hosts. General-purpose or high-risk websites need an admin. A failed website check is shown as an error and retried when the person asks to use it or a run encounters hosts to check; it never opens unchecked hosts.
7. For the VPN trial, explicitly grant yourself `vpn`, add a definition with `rf vpn add NAME fortinet HOST:PORT`, with `--servercert pin-sha256:HASH` where the gateway's certificate isn't publicly trusted, as a refused Connect's error names it, connect under Logins, VPN · Trial, and set your website with `rf site set SITE --via NAME`. Without a live tunnel its browser must ask you to connect first, not go direct. Confirm a person without the capability, even an admin, has no VPN controls and gets 404 from `/vpns`.
