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
2. Make an empty data folder, `~/rollforward-data`. A named volume would start full of the demo.
3. Write `~/.config/rollforward.env` with:
   - `OPENROUTER_API_KEY`;
   - the `RF_OIDC_*` lines and `RF_PUBLIC_URL` (README, Access);
   - `RF_ADMINS`, the first admins;
   - `RF_BROWSER_URL` and `RF_BROWSER_KEY`;
   - `RF_SANDBOX_RO=`, since the image's default is the demo's sources. Instead, it can name folders runs may read, such as a read-only mount of a file share.

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

   A proxy that buffers, such as nginx, needs `proxy_buffering off` for the page's live updates and `client_max_body_size 0` for uploads.

## Keys, backups and updates

- **Keys:** `.rf/session.key` signs sessions, and `.rf/seal.key` encrypts everyone's logins. Back up the data folder nightly without them, and keep a copy of both elsewhere. Without seal.key, people sign in to their logins again.
- **Updates:** check out the next tag, rebuild, then `systemctl --user restart rollforward`. A run the restart cuts carries on by itself.

## Check

1. `podman logs rollforward` says `sign-in microsoft`. If it says `demo`, anyone who reaches the site can sign in as an admin: stop it and set the `RF_OIDC_*` lines.
2. From the rollforward host, `curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" $RF_BROWSER_URL/sessions` answers `[]`.
3. Sign in at `RF_PUBLIC_URL` as one of `RF_ADMINS` and make a workspace. In its Ad hoc series, start an instance and comment "Reply OK". The run ends within a few minutes, for about $0.05.
4. Under Logins, Connect Microsoft 365.
5. Add a website with `rf website set` (rf and a token come from Tokens), sign in to it from Logins, and save the login.
