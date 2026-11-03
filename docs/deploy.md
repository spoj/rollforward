# Deploying on two hosts

rollforward runs on one host and the browser service ([spoj/rollforward-browser](https://github.com/spoj/rollforward-browser)) on another. Both sit on the company's private network: people reach rollforward over HTTPS, and nothing needs to reach either host from the internet. This page goes in the order you work in, and links the READMEs rather than repeating them.

## What to ask for

- **Two Linux VMs** with systemd and rootless podman, such as Ubuntu 24.04 LTS or RHEL 9:
  - **rollforward:** about 2 GB for each run at once, plus the 6 GB kept free (`RF_MIN_FREE_GB`), so 32 GB and 8 vCPUs for about ten at once; 200 GB of disk.
  - **browser:** 4 vCPUs, 8 GB and 50 GB: a browser is capped at 2 GB, and idles at about 0.2 GB.
- **A DNS name and a TLS certificate** for rollforward, or a place behind the company's reverse proxy.
- **Routes out of the rollforward host:**
  - the model's API (`openrouter.ai`);
  - Microsoft (`login.microsoftonline.com` and `graph.microsoft.com`);
  - the package registries and GitHub that runs install from (`.rf/egress.json` adds hosts);
  - the browser host's port.

  If traffic out must go through a proxy, say so before you start: runs' own connections don't use one yet.
- **Routes out of the browser host** to the websites people sign in to, such as the ERP and the portals.
- **An app registered in Entra ID** (README, Access), with an admin's consent to its delegated Graph permissions.
- **A model API key.**

## The browser host

1. Give the service a user of its own, with lingering on (`loginctl enable-linger USER`), and install Node 26 and rootless podman. Then follow its README's Run, as a systemd user service.
2. Follow its README's "On a host of its own":
   - `BROWSER_HOST` is the host's private address;
   - a firewall lets only the rollforward host reach `BROWSER_PORT`;
   - TLS, or a private link such as WireGuard.

## The rollforward host

Run the image under podman, as a systemd service. The image pins Node, Python, bubblewrap and LibreOffice together, and an update is a rebuild and a restart. Running without Docker (README) would instead give each run a memory cap of its own and seal the keys to the TPM, at the cost of more to install and keep current.

1. Give the service a user of its own, with lingering on, and install rootless podman. Check out a tagged commit of this repo, and build it with `podman build -t rollforward .`.
2. Make an empty data folder, `~/rollforward-data`.
3. Write `~/.config/rollforward.env` with:
   - `OPENROUTER_API_KEY`;
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

**Where the image can't be built,** such as on a host whose filter blocks Debian's mirrors, run the server as README's Without Docker says, as a systemd user service of the same user:

- Node 26 beside the system's, such as in `/opt/node-v26`: a run binds node's own folder.
- socat, ripgrep and fd from the distribution (on EL9, ripgrep and fd-find come from EPEL): a run sees `/usr`, with `/usr/bin` on its PATH, but not `/usr/local/bin` or `/opt`.
- `npm ci --omit=dev`, then `uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements.txt`, as EL9's python3 is too old. Under `sudo -i`, `/usr/local/bin` isn't on PATH, so give uv's whole path.
- The unit `~/.config/systemd/user/rollforward.service` has `WorkingDirectory=%h/rollforward`, `ExecStart=/opt/node-v26/bin/node --env-file=%h/.config/rollforward.env src/server.ts %h/rollforward-data 8780` and `Restart=always`; `systemctl --user set-property rollforward-runs.slice MemoryMax=24G` caps all runs together.

## Moving from the team's fork

A data root of the team's fork (its main at a1fa8db, with folders `<workspace>/<series>/<label>/`) moves with `node scripts/migrate-fork.ts OLD NEW`. It reads OLD only and writes NEW, which mustn't exist yet. Ids come from the old paths, so a rerun into a fresh NEW gives the same links: try it on a copy while the fork runs, then again with the fork stopped, and point the proxy at the new server.

- **It carries** people with their roles, workspaces with their owners and an Ad hoc series each, series with their `.pylib`, and instances with `upload/`, `working/` and the agent's session. Notes become the agent's comments and questions its asks, with their options in the text; steers and answers become people's replies, and a question closing defaulted is one the close accepted.
- **It leaves** the fork's skills, its Microsoft 365 connections and vendor passwords, and its keys: people sign in again, series start with no skills, and publishers push them again. It prints anything else it left.
- **The new server starts no run** for the old logs: a run cut short gets its `done`.
- **Some of the fork's people are names, not emails,** in its logs, so their instances have a runner no one signs in as. With the server stopped, `node scripts/rename-person.ts DATA NAME EMAIL` renames one, and prints the instances it changed.

## Keys, backups and updates

- **Keys:** `.rf/session.key` signs sessions, and `.rf/seal.key` encrypts everyone's logins. Back up the data folder nightly without them, and keep a copy of both elsewhere. Without seal.key, people sign in to their logins again.
- **Updates:** check out the next tag, rebuild, then `systemctl --user restart rollforward`. A run the restart cuts carries on by itself.
- **Updates without the image** come by themselves: `scripts/update.ts` moves the checkout to the newest GitHub Release once every check on its commit has passed, installs what changed (`npm ci`, `uv pip install`), restarts the server, and goes back if it doesn't answer, never trying that release again. CI makes a Release from each tag whose tests pass; a tag with a `Manual:` line in its message makes a prerelease, which the updater stops before, for a person to deploy by hand. It asks GitHub without a token, so every 15 minutes, as a timer of the same user:

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

  then `systemctl --user enable --now rollforward-update.timer`; `journalctl --user -u rollforward-update` shows what it did. A restart cuts the runs going on, which carry on by themselves; `OnCalendar=*-*-* 02:00` in place of the two lines above updates at night only.

## Check

1. `podman logs rollforward` says `sign-in microsoft`. If it says `demo`, anyone who reaches the site can sign in as an admin: stop it and set the `RF_OIDC_*` lines.
2. From the rollforward host, `curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" $RF_BROWSER_URL/sessions` answers `[]`.
3. Sign in at `RF_PUBLIC_URL` as one of `RF_ADMINS` and make a workspace. In its Ad hoc series, start an instance and comment "Reply OK". The run ends within a few minutes, for about $0.05.
4. Under Logins, Connect Microsoft 365.
5. Add a website with `rf website set` (rf and a token come from Tokens), sign in to it from Logins, and save the login.
