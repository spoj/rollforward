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
   - `OPENROUTER_API_KEY`, and, optionally, `OPENROUTER_FALLBACK_KEY`, a second OpenRouter key calls go with while the first has under `RF_KEY_SWITCH_USD` (50) left (docs/system.md, Keys), `EXA_API_KEY` for runs' and website checks' web search (without it, website checks run without search), and `RF_LOW_CREDIT_USD` only to change the $50 low-credit warning threshold (or 10% of the key's limit) shown to admins;
   - the `RF_OIDC_*` lines and `RF_PUBLIC_URL` ([system.md](system.md), Access);
   - `RF_ADMINS`, the first admins;
   - `RF_BROWSER_URL` and this server's `RF_BROWSER_KEY`, matching the browser service's `BROWSER_KEY` or one entry in its `BROWSER_KEYS`;
   - `RF_TUNNEL_URL`, `RF_TUNNEL_KEY` and `RF_TUNNEL_PROXY`, only for the optional tunnel service above;
   - `RF_SIGNIN_S` only to change the 600-second website and VPN sign-in window; the page shows its countdown;
   - `RF_MAX_UPLOAD_MB` only to change the 2048 MB an upload holds at most;
   - `RF_SANDBOX_RO`, only if runs should read folders besides their data, such as a read-only mount of a file share.
   - `RF_RUN_TASKS` (2048), `RF_RUN_FILE_GB` (16) and `RF_RUN_CPUS` (2), only to change each run's cap on processes and threads, on one file's size in GB, and on the cores it uses; the host needs Linux 5.14 or later, which counts a run's processes apart from the server's.

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

- Node 26 beside the system's, such as in `/opt/node-v26`, bubblewrap, GNU tar and util-linux's `flock`; no zstd, Python or LibreOffice.
- `npm ci --omit=dev`, then `/opt/node-v26/bin/node scripts/agent.ts`, which unpacks the agent image the checkout runs, CI's `agent-<id>` prerelease, into `.agent/<id>` (about 720 MB to fetch, 2.5 GB unpacked).
- The unit `~/.config/systemd/user/rollforward.service` has `WorkingDirectory=%h/rollforward`, `ExecStart=/opt/node-v26/bin/node --env-file=%h/.config/rollforward.env src/server.ts %h/rollforward-data 8780` and `Restart=always`; `systemctl --user set-property rollforward-runs.slice MemoryMax=24G CPUQuota=600%` caps all runs together, here leaving two of eight cores to the server and the host. Runs' CPU and disk limits need the user manager to have those controllers: `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers` lists `cpu` and `io`, or a root drop-in, `/etc/systemd/system/user@.service.d/delegate.conf` with `[Service]` and `Delegate=cpu cpuset io memory pids`, adds them.

## Keys, backups and updates

- **People's rf,** `@rfany/rf`, is published by CI from a tag whose `cli/package.json` version npm doesn't have yet, to `next` for a `Manual:` release or `latest` otherwise. npm's trusted publisher is this repository's `ci.yml`, so no npm token is kept.
- **Keys:** `.rf/session.key` signs sessions, and `.rf/seal.key` encrypts everyone's logins. Back up the data folder nightly without them, and keep a copy of both elsewhere. Without seal.key, people sign in to their logins again.
- **Ordinary compatible production releases deploy by themselves:** `scripts/update.ts` runs every 15 minutes as a per-user systemd timer (below). For v0.7.0, follow Updating to v0.7.0 below.
- **Updates:** `podman kill --signal=SIGUSR2 rollforward` drains the container first; for the native service, use `systemctl --user kill --kill-whom=main --signal=SIGUSR2 rollforward` instead (the container unit's MainPID is its monitor, not Node). In either case, `GET /drained` answering 200 once the runs going end; then check out the next tag, rebuild, and `systemctl --user restart rollforward`. A restart without the drain cuts the runs going, whose cost so far is recorded. They carry on only with captured and current autonomous consent, unless an Interrupt or authority change holds them.
- **Updates without the image** come by themselves: `scripts/update.ts` moves the checkout to the newest GitHub Release `vX.Y.Z`, which CI makes from a tag, once every check on its commit has passed, and only while the checkout sits exactly on a release tag: a push to main alone deploys nothing. It first fetches what the release installs, its packages into npm's cache and its agent image, unpacked beside the one running if its id is new, while the server runs on, so a failure there, as without the network, changes nothing and the next tick tries again; then it drains the server (`SIGUSR2`, polling `GET /drained` up to `RF_DRAIN_MIN`, 15 minutes by default, 0 skipping it, each probe bounded to 2 seconds or the remaining wait; if the updater dies before the stop, the server's own `RF_DRAIN_MIN` deadline ends the drain so runs aren't left waiting, and an older server without `/drained` isn't signalled), stops the server, cutting whatever runs still go, moves the checkout, installs what changed from that cache (`npm ci`), starts the server, keeping only the agent image it runs and the one before (one it can't remove, as one a stray mount holds, it leaves and says so), and goes back by itself if the server doesn't answer within 5 minutes, never trying that release again; if going back fails too, it starts the server as the checkout is, so it never stays stopped. What waited during the drain starts after the restart, and runs the stop cut carry on only with captured and current autonomous consent, unless an Interrupt or authority change holds them. A checkout on no release tag, as after a person's fix by hand, stops updates until one is checked out again. A tag whose message has a line starting `Manual:` (which makes a prerelease) stops automatic updates for a person to deploy by hand; one with `Urgent:` skips the drain and cuts the runs going at once. A release's number says how it goes back: a patch, `0.5.1` after `0.5.0`, drops in, an older server reading all it writes, so going back needs nothing; a minor, `0.6.0`, writes what an older server misreads or needs something of whoever runs the host, an environment variable, a key changed or a newer browser service, which its tag's message and Rolling back say; 1.0 waits. It asks GitHub without a token, so every 15 minutes, as a timer of the same user:

       # ~/.config/systemd/user/rollforward-update.service
       [Service]
       Type=oneshot
       WorkingDirectory=%h/rollforward
       Environment=PATH=/opt/node-v26/bin:/usr/local/bin:/usr/bin
       ExecStart=/opt/node-v26/bin/node --env-file=%h/.config/rollforward.env scripts/update.ts http://127.0.0.1:8780/
       TimeoutStartSec=3h

       # ~/.config/systemd/user/rollforward-update.timer
       [Timer]
       OnBootSec=5min
       OnUnitActiveSec=15min

       [Install]
       WantedBy=timers.target

  The updater loads the same `rollforward.env` as the server so `RF_DRAIN_MIN` agrees. Existing updater units, including production's, need the `--env-file` argument above and `systemctl --user daemon-reload` before changing that limit; a checkout update alone does not change a unit. With neither configured, both default to 15 minutes.

  Then `systemctl --user enable --now rollforward-update.timer`; `journalctl --user -u rollforward-update` shows what it did. It restarts the server as above; `OnCalendar=*-*-* 02:00` in place of the two lines above updates at night only.

## Updating to v0.8.0

This is a `Manual:` release: the message store changes on disk. Do not point v0.8.0 at the old data, or v0.7.x at converted data. Keep the old checkout and a recoverable backup of the complete original data root and both keys, including keys supplied by systemd. From the reviewed release, run `node scripts/migrate-skills.ts --check "$ORIGINAL"` as the service user to check the live skill versions without writing. The native preflight does this too. Review any reported skill and line before starting the outage. The converter rewrites supported run commands in Markdown examples and shell scripts as new versions of live skills by `rf v0.8.0 migration`. Fix unresolved usages through the normal skill publication process before cutover; it cannot resolve dynamically assembled commands. Historical versions and instance `working/process.md` are not rewritten. Agents update their process files using the old commands' replacement hints.

For the native service under UID 8004 at `/u01/rollforward/rollforward`, use the reviewed [cutover script](../scripts/cutover-v0.8.0.sh). After staging the approved tag, run `--preflight PIN COPY_PARENT AUTH_JSON PULL_PATH` as root. It checks the old unit, CLI and sample download, and verifies a real reflink to `COPY_PARENT` with enough disk blocks and inodes for the copy metadata, converter and startup backup. It does not drain, stop, change the checkout or pause the updater. `--execute` repeats these checks, then checks the stopped tree for escaping links, nested mounts and external Git metadata immediately before reflink-copying it, without a full-copy fallback. The stopped original is the rollback backup. An existing admin CLI credential works; normal old/live reads may check provider credit and leave bearer-use records, unlike verification.

The native proxy can stay up. Warn users and choose a quiet window: v0.7.9 still accepts writes during drain. In verification, requests reaching the server can only read with their existing access; writes, sign-in and upgrades receive 503. There is downtime during stops and starts. The 20-minute approval window is a maximum, not a delay; activate immediately after review or abort. Do not have other processes write the data or manage the unit during cutover. The steps below are the equivalent manual procedure for other deployments.

1. Stop the update timer; check that no update job is running. Check that the checkout is clean and the tag includes the deployed commit. Use the native or container drain above. Stop the server only after `/drained` returns 200. Keep writers stopped, including clients and admin scripts, until verification is complete.
2. Copy the stopped data root to a **separate directory** on the production host, preserving owner, permissions and any keys. Do not use hard links to the original. Keep `.rf`, the instance repositories and series directories. Check free space first. As the service user, run against the copy from the new checkout (using its Node 26):

       node scripts/migrate-messages.ts --stopped-copy "$COPY" --source "$ORIGINAL" --dry-run
       node scripts/migrate-messages.ts --stopped-copy "$COPY" --source "$ORIGINAL" --apply
       node scripts/migrate-messages.ts --stopped-copy "$COPY" --source "$ORIGINAL" --dry-run

   Progress and the skill version plan go to standard error; standard output is one JSON count report. Review the counts and planned skill versions against the old root. Stop on any refusal; do not hand-fill a gap or restart on an incomplete conversion. The final dry run must say `already converted`. A failed partial conversion is discarded and started again on a fresh stopped copy.
3. Point the service at the converted copy, with the same keys and environment, and append `--verify-only` after the port in the new `src/server.ts` command. This startup binds only to loopback, does not recover runs, start scheduled work, or contact the browser, tunnelling, index or model services. It refuses sign-in exchanges and all HTTP writes. Use an existing authenticated token from the copied data to check `GET /me` (`version: "v0.8.0"`, `verifyOnly: true`), `/api/status`, conversation links, Notes, Waiting, and `rf pull` with `@rfany/rf@0.20.0`. Verify the converter's projection counts. Use `@rfany/rf@0.19.2` with v0.7.9 and pin `@rfany/rf@0.20.0` after cutover.
4. On a verification failure, stop the verification service, keep the converted copy for inspection, and restart the old checkout on the untouched original. Verify authenticated `/me` again. If verification passes, stop the verification service, remove only the `--verify-only` argument and restart on the converted copy to activate it. Verify `/me` again and restore the updater timer to its previous state. Activation can run due work and make outward changes. If anything fails after activation, keep the updater paused, preserve both roots, and agree on how to reconcile new work before rolling back. Never copy converted logs over old ones.
5. Only after v0.8.0 is active and authenticated `/me` reports `v0.8.0` without `verifyOnly`, promote the CLI from an authenticated npm operator workstation:

       npm view @rfany/rf dist-tags --json   # record the previous latest first
       npm dist-tag add @rfany/rf@0.20.0 latest

   The controller does not publish or use npm credentials. Before activation, tell clients to stay on 0.19.2; 0.20.0's write routes require the new server. If returning to v0.7.9 after promotion, pin clients to 0.19.2 and restore the previous `latest` as needed.

## Updating to v0.7.0

Release v0.7.0 with a `Manual:` line in the tag message so the updater stops for a person to deploy it.

1. Stop the updater timer and any running update job: `systemctl --user disable --now rollforward-update.timer` and `systemctl --user stop rollforward-update.service`. Keep all writers stopped during conversion.
2. Drain the server as above, wait for `/drained` to return 200, then stop it: `systemctl --user stop rollforward`.
3. Back up the complete data folder and both keys, `session.key` and `seal.key`, including their recoverable credential sources if supplied by systemd. Retain the old checkout, environment and agent image.
4. Convert a **copy** of the data with a one-off hand conversion outside this repository. Write the `.rf/tree.json` envelope and every series' `series.json` exactly as [Stored data in system.md](system.md#storage) specifies. Decide each series' owner by hand: by default whoever shared it, else whoever runs its latest open instance, else whoever ran its latest instance, with the logins they last ticked there and autonomous on, as wakes ran before. A person decides series with mixed or departed runners; leave the rest without an owner for a workspace manager to choose. Review pending wakes, requests and continuations against that authority. Leave the original data untouched.
5. Start v0.7.0 on the converted copy, with its matching clients, and verify it works. Startup refuses legacy or incomplete authority before writing or recovering runs.
6. Re-enable the updater timer: `systemctl --user enable --now rollforward-update.timer`.

To roll back, stop the updater and server, preserve the converted copy and any new work, and start the old checkout on the **untouched original** with its matching keys and environment. Never start old code on converted data.

The admin skill shell also requires explicit selection: `node --env-file=.env src/cli.ts DATA_ROOT try --as EMAIL --logins '["OFFER"]' -- COMMAND`, or `--logins '[]'` for none. EMAIL must be an enabled admin; its immutable synthetic run identity and selected offers are not inferred from instance history.

## After updating past v0.3.19

- **Rotate** `OPENROUTER_API_KEY`, `OPENROUTER_FALLBACK_KEY`, `RF_BROWSER_KEY`, with the browser service's matching `BROWSER_KEY` or `BROWSER_KEYS` entry, and `RF_OIDC_CLIENT_SECRET`: before it, a run could read them in the server's environment, at `/proc/1/environ` in its sandbox.
- **`EXA_API_KEY` is optional:** without it, website checks run without search.

## Rolling back

Going back to a version from before service connections, deleting instances, and rejecting and withdrawing asks:

- **Stop the updater's timer** while you go back, so it doesn't bring the release back meanwhile.
- **Remove every `service` connection first,** with `rf connection remove NAME`. An older server doesn't know the type, exits as it starts, and restarts into the same exit.
- **Don't delete an instance, or add a service connection, until this release has settled.** An older server answers `GET /api` with 500 once one instance is deleted, as its tombstone has no `create` entry, so the page, `rf ls`, `rf waiting`, `rf show` and `rf wakes` fail for admins and that workspace's people.
- **Going back past assign, list first what it changed,** from `~/rollforward-data`: the instances with an `assign` entry, `grep -l '"op":"assign"' instances/*/log.jsonl`, and the requests to wake an instance, `jq '.requests | map_values(select(.target))' .rf/wakes.json`. An older server ignores `assign` entries, so each such instance's runner reverts to whoever had it before, whose logins its runs then use, and misreads a request with a `target` as one to start an instance of that label, whose Start fails as the instance exists: drop those with `rf request drop ID` first, and after going back have each assigned person take their instance over again.
- **Going back past `v0.6.0` (failed/aborted run holds), review open candidate instances whose last run failed or stopped,** from `~/rollforward-data`: `for d in instances/*; do if [ -f "$d/screen.json" ] && jq -e '.status=="open"' "$d/screen.json" >/dev/null && jq -se 'map(select(.op=="run" or .op=="done")) | last | select(.op=="run" or .error or .aborted)' "$d/log.jsonl" >/dev/null; then echo "$d"; fi; done`. In `v0.6.0`, a failed or aborted run leaves unread work held until a person acts; `v0.5.0` and earlier treat unread work past the last `done.seen` boundary as cut work to resume on startup, and can start a fresh run on downgrade unless those candidates are reviewed and closed or abandoned first (or kept on `v0.6.0+`).
- **Expect on an older version:** proposals rejected, and questions and proposals withdrawn, show as waiting again, and Close lists them as asks to accept; its `rf site set` drops a website's profile and its VPN, `via`.

## Check

1. `podman logs rollforward` says `rollforward on`. Without the `RF_OIDC_*` lines and `RF_PUBLIC_URL` it doesn't start, and says which are missing.
2. From the rollforward host, `curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" "$RF_BROWSER_URL/sessions"` answers `[]`, and `curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" "$RF_BROWSER_URL/blocked?host=example.com"` answers a host-to-boolean map, not 503.
3. Sign in at `RF_PUBLIC_URL` as one of `RF_ADMINS`, and make a workspace. With its +, start a task with an explicit credential selection and comment "Reply OK". This makes a paid model call.
4. Under Logins, Connect Microsoft 365.
5. Under Logins, Websites, add a website by its name and address, sign in before the countdown ends, and save the login. The server checks the website and its hosts; no one is asked to approve hosts during sign-in. A directly reached internal primary host must first be allowed by an admin ([system.md](system.md), Hosts).
6. Ask to use that account in the workspace: as yours, it's approved at once. Have someone who doesn't own it ask there too, and under Waiting on you check whose account it is, its purpose, flags and any client-VPN disclosure, then approve its use, not its hosts. General-purpose or high-risk websites need an admin. A failed website check is shown as an error and retried when the person asks to use it or a run encounters hosts to check; it never opens unchecked hosts.
7. For the VPN trial, explicitly grant yourself `vpn`, add a definition with `rf vpn add NAME fortinet HOST:PORT`, with `--servercert pin-sha256:HASH` where the gateway's certificate isn't publicly trusted, as a refused Connect's error names it, connect under Logins, VPN · Trial, and set your website with `rf site set SITE --via NAME`. Without a live tunnel its browser must ask you to connect first, not go direct. Confirm a person without the capability, even an admin, has no VPN controls and gets 404 from `/vpns`.
