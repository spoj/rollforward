# Deploying on two hosts

rollforward runs on one host and the browser service ([spoj/rollforward-browser](https://github.com/spoj/rollforward-browser)) on another. Both sit on the company's private network: people reach rollforward over HTTPS, and nothing needs to reach either host from the internet. This page goes in the order you work in, and links the READMEs rather than repeating them.

## What to ask for

- **Two Linux VMs** with systemd and rootless podman, such as Ubuntu 24.04 LTS or RHEL 9:
  - **rollforward:** about 2 GB for each run at once, plus the 6 GB kept free (`RF_MIN_FREE_GB`), so 32 GB and 8 vCPUs for about ten at once; 200 GB of disk.
  - **browser:** 4 vCPUs, 8 GB and 50 GB: a browser is capped at 2 GB, and idles at about 0.2 GB.
- **A DNS name and a TLS certificate** for rollforward, or a place behind the company's reverse proxy.
- **Routes out of the rollforward host:**
  - the model's API (`openrouter.ai`), and Exa's (`api.exa.ai`) for runs' web search;
  - Microsoft (`login.microsoftonline.com` and `graph.microsoft.com`);
  - the package registries and GitHub that runs install from (`.rf/egress.json` adds hosts);
  - the browser host's port.

  If traffic out must go through a proxy, say so before you start: runs' own connections don't use one yet.
- **Routes out of the browser host** to the websites people sign in to, such as the ERP and the portals.
- **An app registered in Entra ID** (README, Access), with an admin's consent to its delegated Graph permissions.
- **A model API key** for OpenRouter, and one for Exa if runs are to search the web.

## The browser host

1. Give the service a user of its own, with lingering on (`loginctl enable-linger USER`), and install Node 26 and rootless podman. Then follow its README's Run, as a systemd user service.
2. Follow its README's "On a host of its own":
   - `BROWSER_HOST` is the host's private address;
   - a firewall lets only the rollforward host reach `BROWSER_PORT`;
   - TLS, or a private link such as WireGuard.

## The rollforward host

Run the image under podman, as a systemd service. The image is the agent image, the runs' userland ([agent/](../agent)), with the server on it, and an update is a rebuild and a restart. Running without Docker (README) would instead give each run a memory cap of its own and seal the keys to the TPM, and updates come by themselves; its runs use the same agent image, which CI publishes.

1. Give the service a user of its own, with lingering on, and install rootless podman. Check out a tagged commit of this repo, and build the agent image, then the server's on it: `podman build -t rollforward-agent agent && podman build -t rollforward .`.
2. Make an empty data folder, `~/rollforward-data`.
3. Write `~/.config/rollforward.env` with:
   - `OPENROUTER_API_KEY`, and `EXA_API_KEY` for web search;
   - the `RF_OIDC_*` lines and `RF_PUBLIC_URL` (README, Access);
   - `RF_ADMINS`, the first admins;
   - `RF_BROWSER_URL` and `RF_BROWSER_KEY`;
   - `RF_SANDBOX_RO`, only if runs should read folders besides their data, such as a read-only mount of a file share.

4. Install the unit, then run `systemctl --user daemon-reload && systemctl --user start rollforward`:

       # ~/.config/containers/systemd/rollforward.container
       [Container]
       Image=localhost/rollforward
       ContainerName=rollforward
       PublishPort=127.0.0.1:8780:8780
       Volume=%h/rollforward-data:/data
       EnvironmentFile=%h/.config/rollforward.env
       PodmanArgs=--init --memory=48g --security-opt=unmask=/proc/*

       [Service]
       Restart=always

       [Install]
       WantedBy=default.target

   `--memory` caps all runs together, below the host's memory; `unmask=/proc/*` lets bubblewrap sandbox each run.
5. Put HTTPS in front, such as Caddy:

       rollforward.example.com {
           tls /etc/caddy/rollforward.crt /etc/caddy/rollforward.key
           reverse_proxy 127.0.0.1:8780
       }

   A proxy that buffers, such as nginx, needs `proxy_buffering off` for the page's live updates and `client_max_body_size 0` for uploads. nginx also passes websockets, which the live view of a website's sign-in uses, only when told: `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade` and `proxy_set_header Connection "upgrade"`.

**Where the image can't be built,** such as on a host whose filter blocks Debian's mirrors, run the server as README's Without Docker says, as a systemd user service of the same user. The host's own programs don't matter to runs, whose userland is the agent image, never the host's:

- Node 26 beside the system's, such as in `/opt/node-v26`, bubblewrap, and GNU tar; no zstd, Python or LibreOffice.
- `npm ci --omit=dev`, then `/opt/node-v26/bin/node scripts/agent.ts`, which unpacks the agent image the checkout runs, CI's `agent-<id>` prerelease, into `.agent/<id>` (about 500 MB to fetch, 1.6 GB unpacked).
- The unit `~/.config/systemd/user/rollforward.service` has `WorkingDirectory=%h/rollforward`, `ExecStart=/opt/node-v26/bin/node --env-file=%h/.config/rollforward.env src/server.ts %h/rollforward-data 8780` and `Restart=always`; `systemctl --user set-property rollforward-runs.slice MemoryMax=24G` caps all runs together.

## Moving from the team's fork

A data root of the team's fork (its main at a1fa8db, with folders `<workspace>/<series>/<label>/`) moves with `node scripts/migrate-fork.ts OLD NEW`. It reads OLD only and writes NEW, which mustn't exist yet. Ids come from the old paths, so a rerun into a fresh NEW gives the same links: try it on a copy while the fork runs, then again with the fork stopped, and point the proxy at the new server.

- **It carries** people with their roles, workspaces with their owners, series with their `.pylib`, and instances with `upload/`, `working/` and the agent's session. Notes become the agent's comments and questions its asks, with their options in the text; steers and answers become people's replies, and a question closing defaulted is one the close accepted.
- **It leaves** the fork's skills, its Microsoft 365 connections and vendor passwords, and its keys: people sign in again, series start with no skills, and those who may publish push them again. It prints anything else it left.
- **The new server starts no run** for the old logs, but carries on the runs the move cut: each gets its `done`, with every old entry seen, and the new server wakes its instance, as after a restart.
- **Some of the fork's people are names, not emails,** in its logs, so their instances have a runner no one signs in as. With the server stopped, `node scripts/rename-person.ts DATA NAME EMAIL` renames one, and prints the instances it changed.

## Keys, backups and updates

- **Keys:** `.rf/session.key` signs sessions, and `.rf/seal.key` encrypts everyone's logins. Back up the data folder nightly without them, and keep a copy of both elsewhere. Without seal.key, people sign in to their logins again.
- **Updates:** check out the next tag, rebuild, and `systemctl --user restart rollforward`, whatever runs are going: the restart cuts them, and they carry on by themselves, their cost so far recorded.
- **Updates without the image** come by themselves: `scripts/update.ts` moves the checkout to the newest GitHub Release once every check on its commit has passed. It first fetches what the release installs, its packages into npm's cache and its agent image, unpacked beside the one running if its id is new, while the server runs on, so a failure there, as without the network, changes nothing and the next tick tries again; then it stops the server, whatever runs are going, moves the checkout, installs what changed from that cache (`npm ci`), starts the server, keeping only the agent image it runs and the one before, and goes back if it doesn't answer, never trying that release again; if going back fails too, it starts the server as the checkout is, so it never stays stopped. The runs the stop cut carry on after the start. A checkout on no release tag, as after a person's fix by hand, stops updates until one is checked out again. CI makes a Release from each tag whose tests pass; a tag with a `Manual:` line in its message makes a prerelease, which the updater stops before, for a person to deploy by hand. It asks GitHub without a token, so every 15 minutes, as a timer of the same user:

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

## Check

1. `podman logs rollforward` says `sign-in microsoft`. If it says `demo`, anyone who reaches the site can sign in as an admin: stop it and set the `RF_OIDC_*` lines.
2. From the rollforward host, `curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" $RF_BROWSER_URL/sessions` answers `[]`.
3. Sign in at `RF_PUBLIC_URL` as one of `RF_ADMINS` and make a workspace. With its +, start a task and comment "Reply OK". The run ends within a few minutes, for about $0.05.
4. Under Logins, Connect Microsoft 365.
5. Add a website with `rf connection set NAME website --url URL` (rf and a token come from Tokens), sign in to it from Logins, and save the login.
