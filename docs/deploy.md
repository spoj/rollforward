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

- Node 26 beside the system's, such as in `/opt/node-v26`, bubblewrap, GNU tar and util-linux's `flock`; no zstd, Python or LibreOffice.
- `npm ci --omit=dev`, then `/opt/node-v26/bin/node scripts/agent.ts`, which unpacks the agent image the checkout runs, CI's `agent-<id>` prerelease, into `.agent/<id>` (about 720 MB to fetch, 2.5 GB unpacked).
- The unit `~/.config/systemd/user/rollforward.service` has `WorkingDirectory=%h/rollforward`, `ExecStart=/opt/node-v26/bin/node --env-file=%h/.config/rollforward.env src/server.ts %h/rollforward-data 8780` and `Restart=always`; `systemctl --user set-property rollforward-runs.slice MemoryMax=24G` caps all runs together.

## Keys, backups and updates

- **Keys:** `.rf/session.key` signs sessions, and `.rf/seal.key` encrypts everyone's logins. Back up the data folder nightly without them, and keep a copy of both elsewhere. Without seal.key, people sign in to their logins again.
- **Ordinary compatible production releases deploy by themselves:** `scripts/update.ts` runs every 15 minutes as a per-user systemd timer (below). **Not the sole-owner format:** disable the updater and follow the manual 0.7 cutover below. The updater now refuses every automatic major/minor transition, even without `Manual:` metadata, so rollback stays inside one compatible reader line. Pre-cutover updaters lack this barrier: stop them too.
- **Updates:** `podman kill --signal=SIGUSR2 rollforward` drains the container first; for the native service, use `systemctl --user kill --kill-whom=main --signal=SIGUSR2 rollforward` instead (the container unit's MainPID is its monitor, not Node). In either case, `GET /drained` answering 200 once the runs going end; then check out the next tag, rebuild, and `systemctl --user restart rollforward`. A restart without the drain cuts the runs going, which carry on by themselves, their cost so far recorded, unless a person's Interrupt or assign holds them.
- **Updates without the image** come by themselves: `scripts/update.ts` moves the checkout to the newest GitHub Release `vX.Y.Z`, which CI makes from a tag, once every check on its commit has passed, and only while the checkout sits exactly on a release tag: a push to main alone deploys nothing. It first fetches what the release installs, its packages into npm's cache and its agent image, unpacked beside the one running if its id is new, while the server runs on, so a failure there, as without the network, changes nothing and the next tick tries again; then it drains the server (`SIGUSR2`, polling `GET /drained` up to `RF_DRAIN_MIN`, 15 minutes by default, 0 skipping it, each probe bounded to 2 seconds or the remaining wait; if the updater dies before the stop, the server's own `RF_DRAIN_MIN` deadline ends the drain so runs aren't left waiting, and an older server without `/drained` isn't signalled), stops the server, cutting whatever runs still go, moves the checkout, installs what changed from that cache (`npm ci`), starts the server, keeping only the agent image it runs and the one before, and goes back by itself if the server doesn't answer within 5 minutes, never trying that release again; if going back fails too, it starts the server as the checkout is, so it never stays stopped. What waited during the drain starts after the restart, and runs the stop cut are woken and carry on unless a person's Interrupt or assign holds them. A checkout on no release tag, as after a person's fix by hand, stops updates until one is checked out again. Any next major/minor boundary, or a tag whose message has a line starting `Manual:` (which makes a prerelease), stops automatic updates for a person to deploy by hand; one with `Urgent:` skips the drain and cuts the runs going at once. A release's number says how it goes back: a patch, `0.5.1` after `0.5.0`, drops in, an older server reading all it writes, so going back needs nothing; a minor, `0.6.0`, writes what an older server misreads or needs something of whoever runs the host, an environment variable, a key changed or a newer browser service, which its tag's message and Rolling back say; 1.0 waits. It asks GitHub without a token, so every 15 minutes, as a timer of the same user:

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

## Sole series owner: manual minor cutover

This is an incompatible stored-authority change, **not an automatic patch or a release authorization**. Rehearse only on synthetic local data for now; no live migration or deployment has been validated. Any eventual release must be **v0.7.0**, with a `Manual:` tag instruction, coordinated server/web/agent/people's CLI cutover, independent review and an approved maintenance window. Do not tag or publish this work as part of the rehearsal.

The actual reader floor is **v0.7.0**, authority format 1. `.rf/tree.json` is `{format:"rollforward-series-owner",version:1,minReader:"0.7.0",state:"complete",tree:{workspaces,series,groups?}}`. There are **no top-level workspaces or series**: the actual pre-owner server exits in synchronous recovery before starting runs, instead of deriving authority from historical instance runners. It can still make startup backups/cleanup before that refusal; never use an old start as a rollback procedure. The f03f581 sidecar-only shape is not accepted: old binaries ignore `.rf/authority-format.json` and can execute its old-readable tree. New code no longer writes that sidecar.

Before any initialization of an existing root, backup, cleanup, log repair or recovery, the new server validates the complete envelope, tree and every referenced series settings record. Only an absent/empty root initializes, publishing an incomplete envelope before complete. Missing, unsupported, malformed, legacy or incomplete data refuses without mutation. Do not hand-edit an envelope or add/remove a sidecar to bypass refusal.

1. **Disable automatic updates before touching the data.** Stop both the timer and any running update job, then mask both while the cutover/rollback window is open:

       systemctl --user stop rollforward-update.timer rollforward-update.service
       systemctl --user mask --runtime rollforward-update.timer rollforward-update.service

   Runtime masks disappear on reboot; disable the timer persistently as well (`systemctl --user disable rollforward-update.timer`), and do not reboot or run an updater manually in the window. Verify no updater process is still running; a timer mask does not stop a manually launched old script. The manual installation must land exactly on the v0.7 release, whose updater only moves/rolls back within v0.7. No running pre-cutover updater may survive the switch. Keep updates disabled during the rollback window; a prerelease alone does not make downgrade safe.
2. Drain the server as above; wait for `/drained` to return 200, then stop `rollforward`. Verify its runs, sandbox/background processes and browser sessions have actually retired; stop all other writers and keep the server and updater stopped through backup, conversion and validation. A decision file's acknowledgements are assertions, not process locks or backup verification.
3. **Back up the complete stopped data root**, including `.rf` (wakes, costs, users, grants, browser journals and authority metadata), `series/` settings/notes/`.pylib`, `instances/` logs/tombstones/working files/sessions/browser evidence/`.git`, `agents/` and `skills/`. The automatic `.rf-backups/` and `rf pull` are not complete backups. For example, with `DATA_ROOT` and an existing secure `BACKUP_DIR` outside it:

       umask 077
       tar --acls --xattrs --numeric-owner --exclude='./.rf/session.key' --exclude='./.rf/seal.key' --exclude='./.rf-backups/*/session.key' --exclude='./.rf-backups/*/seal.key' -cpf "$BACKUP_DIR/data-before-owner.tar" -C "$DATA_ROOT" .
       sha256sum "$BACKUP_DIR/data-before-owner.tar" > "$BACKUP_DIR/data-before-owner.sha256"

   These exclusions cover the live keys and copies made by startup backups. Keep both keys separately in protected storage; where systemd/TPM credentials supply them, retain their recoverable credential source and host recovery procedure, not just the data archive. Save the environment file, service units, previous exact code/image and matching CLI versions separately. Protect archives as secrets. Verify the checksum and rehearse complete restoration into a separate empty local directory before converting; do not start the restored legacy server against real credentials or network services during a rehearsal.
4. On a **synthetic offline rehearsal root only**, plan without changing anything:

       node scripts/series-owner-migrate.ts "$DATA_ROOT"
       # Explicitly equivalent: node scripts/series-owner-migrate.ts "$DATA_ROOT" plan

   Plan inventories the entire snapshot (including key file metadata, not key contents), all tree series/tasks including empty ones, orphan/incomplete records, candidates with source log/settings hashes and sequences, tombstone executors as history only, all pending wakes/requests and open instances needing continuation review. It neither selects owners nor unions legacy ticks. The supplied production aggregate, **424 series: 395 unique candidates, 24 mixed, 5 empty**, proves no owner or series-wide consent and is not a freshly inspected census. Silently disabling hundreds of series to meet a target is forbidden.
5. **Apply is blocked, even on a complete submission.** `node scripts/series-owner-migrate.ts "$DATA_ROOT" apply DECISIONS.json` returns a precise coverage/policy refusal **before any writes**. A diagnostic submission has `series:{ID:{owner,consentEvidence,eligibilityEvidence}}`, `work:{ITEM_ID:decision}`, and `acknowledgements:{stopped:true,updaterIdle:true,fullBackupVerified:true}`. Missing/extra series and work decisions, missing consent/eligibility evidence and acknowledgements are reported. These fields are not a trusted consent-import protocol: management/role mapping alone cannot lend the incoming owner's credentials. Required owner-authenticated evidence must bind the series/workspace, exact selected ceiling (explicit `[]` is allowed), and autonomous scope, with current eligibility; every affected schedule, request and continuation needs explicit treatment, never automatic old-schedule inheritance or blanket cancellation. Parent must obtain approval for evidence verification and per-item transition policy before a converter is implemented. All original queues, settings and history bytes remain intact on plan, apply refusal or failure.

   No staged converter, live conversion or resume path ships here. A future authorized converter must validate complete mapping/evidence/work coverage and a rehearsed full backup **before** staging outside the untouched legacy root; validate the complete staged snapshot, publish its nonexecuting incomplete envelope first and complete envelope last, and activate only while all writers/updater remain stopped. A crash must leave intact old complete data or explicit nonexecuting incomplete new data, never a partially converted old-readable tree. Preserve old logs/tombstones and original work evidence exactly. Recovery restores a complete compatible snapshot, not deletion of a barrier or silent erasure of post-cutover work. This remains an operational/code blocker, not a claim of implemented migration.

   Before any eventual live start, review all clients together and grant `series-owner` explicitly to a few **named people**, including admins who will pilot (`rf can series-owner EMAIL,...`). Admin status does not grant it. Complete legacy mapping and valid new-owner consent/work decisions are prerequisites for cutover, not a plan to leave the deployment broadly unowned. Parent alone holds live cutover.

**Rollback is a data restore, never a code-only checkout.** Keep both services stopped/masked. First archive the entire post-cutover root and keys separately so new work, signoffs, costs and migration evidence cannot be silently lost. Restore `data-before-owner.tar` into an **empty** replacement root (not on top of converted files), restore its matching keys/credentials and previous environment/code/image/CLI, verify the archive checksum and restored inventory, then switch the service's data path to that complete snapshot. Review and reconcile post-cutover acts from the preserved archive manually; do not replay deliveries or merge converted authority records into a legacy root. Test this restore on synthetic data. There is no reverse converter. Do not restart an old binary on the converted root, and do not re-enable automatic updates until its forward and rollback reader compatibility has been established.

The admin skill shell also requires explicit selection: `node --env-file=.env src/cli.ts DATA_ROOT try --as EMAIL --logins '["OFFER"]' -- COMMAND`, or `--logins '[]'` for none. EMAIL must be an enabled admin explicitly granted `series-owner`; its immutable synthetic run identity and selected offers are not inferred from instance history.

## After updating past v0.3.19

- **Rotate** `OPENROUTER_API_KEY`, `OPENROUTER_FALLBACK_KEY`, `RF_BROWSER_KEY`, with the browser service's matching `BROWSER_KEY` or `BROWSER_KEYS` entry, and `RF_OIDC_CLIENT_SECRET`: before it, a run could read them in the server's environment, at `/proc/1/environ` in its sandbox.
- **`EXA_API_KEY` is optional:** without it, website checks run without search.

## Rolling back

**If the data has a sole-owner tree envelope (complete or incomplete), or the unsafe sidecar-only format, use the complete restore procedure above first.** The older compatibility notes below do not make converted data safe for old code.

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
3. For an approved live pilot only, explicitly grant your named account `series-owner` (admin role alone is insufficient), sign in at `RF_PUBLIC_URL` as one of `RF_ADMINS`, and make a workspace. With its +, start a task with an explicit credential selection and comment "Reply OK". This makes a paid model call; do not do it during an offline migration rehearsal.
4. Under Logins, Connect Microsoft 365.
5. Under Logins, Websites, add a website by its name and address, sign in before the countdown ends, and save the login. The server checks the website and its hosts; no one is asked to approve hosts during sign-in. A directly reached internal primary host must first be allowed by an admin ([system.md](system.md), Hosts).
6. Ask to use that account in the workspace: as yours, it's approved at once. Have someone who doesn't own it ask there too, and under Waiting on you check whose account it is, its purpose, flags and any client-VPN disclosure, then approve its use, not its hosts. General-purpose or high-risk websites need an admin. A failed website check is shown as an error and retried when the person asks to use it or a run encounters hosts to check; it never opens unchecked hosts.
7. For the VPN trial, explicitly grant yourself `vpn`, add a definition with `rf vpn add NAME fortinet HOST:PORT`, with `--servercert pin-sha256:HASH` where the gateway's certificate isn't publicly trusted, as a refused Connect's error names it, connect under Logins, VPN · Trial, and set your website with `rf site set SITE --via NAME`. Without a live tunnel its browser must ask you to connect first, not go direct. Confirm a person without the capability, even an admin, has no VPN controls and gets 404 from `/vpns`.
