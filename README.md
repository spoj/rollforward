# rollforward

Recurring tasks, files in and files out. People drop this period's input files into an instance of a series. An agent learns the transform from the closed instances, produces the output files, and pins notes and questions to the cells they're about. The screen shows the work as a graph, from the inputs through the agent's steps to the outputs. People answer by clicking an option, drop in a corrected file when one was wrong, and close the instance when it's done. There is no prompt box on the main screen.

![An instance: inputs, steps and outputs, joined by what each is made from](docs/screenshots/instance.png)

- **The agent** is [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), run over RPC with read, bash, edit and write tools, in its series' folder. It copies and adapts the previous instance's scripts, so each instance's `working/` is a complete record of how its outputs were made.
- **Skills** reach systems outside the series, for the series that choose them. They are each deployment's own, pushed by publishers with `rf skill push`; none ship with this repo.
- **Inputs** are uploads, or sources a person points the agent to, such as a database, a mailbox folder or a web API. The agent keeps a frozen copy of what it read, and the tile shows where it came from.
- **Workspaces hold series,** such as one client's, and its owners and members see them. A workspace or a series can be archived, which hides it until it's restored.
- **People sign in with Microsoft,** with one button.
- **Logins are each person's own:** a run reads Microsoft 365 and websites only through its runner's logins, and only those ticked for its instance.
- **Talking is in comments,** on an item or the instance; the agent replies in the thread and ends each run with a report.
- **Wakes:** an agent sets when its instance, or its series' next period, runs again; nothing is scheduled.
- **Reach:** a series reads its own workspace, and any workspace whose people all belong to its own; every run also reads the company's and its workspace's guidance.
- **rf** is people's command line, with a personal token: what the page does, plus pulling everything you can see, for your own desktop agent. Admin is rf, not the page.
- **Everything is files on disk.** Each instance has `upload/` (people's files), `working/` (the agent's), `workspace.json` (what the screen shows) and `log.jsonl` (every event).

| A tile's notes | Preview, compared with the file it replaced |
|---|---|
| ![Notes](docs/screenshots/notes.png) | ![Preview](docs/screenshots/preview.png) |
| **Advanced: the agent's work** | **Phone** |
| ![Advanced](docs/screenshots/advanced.png) | ![Phone](docs/screenshots/phone.png) |

## Try it

    cp .env.example .env          # set OPENROUTER_API_KEY
    docker compose up --build     # then open http://127.0.0.1:8780

The image comes with a demo series that is already populated: a weekly borrowing base for a made-up housewares company, nine weeks the agent has done.
- **Week 08-16:** the agent starts fetching the inventory from a warehouse database, the lender's figures from a mailbox and the EUR rate from the ECB.
- **Week 08-30:** it handles a stale snapshot and a one-week waiver from the lender.
- **Week 09-06:** open it and drop the two files from `demo/try/2026-09-06/`. The agent fetches the inventory from the warehouse database, the loan activity from the mailbox and the EUR rate from the ECB.
- **Things to open:** a tile, Preview, the ops log and Advanced.
- **Running the agent:** create an instance and drop files. A normal week costs about $0.20–0.60 with Claude Opus 5.5 through OpenRouter.

## Access

People sign in with one button, **Sign in with Microsoft**, and type nothing.

- **Demo (the default):** the button leads to a picker of two demo accounts: `admin@demo.test`, an admin, and `bob@demo.test`, a user. Anyone who reaches the site can be the demo admin, so keep it on localhost.
- **Your organisation's Microsoft accounts:** with an app registered in Microsoft Entra ID, set in `.env` (see `.env.example`) `RF_OIDC_ISSUER` (`https://login.microsoftonline.com/<tenant id>/v2.0`), `RF_OIDC_CLIENT_ID` and `RF_PUBLIC_URL`, then match the app's registration:
  - its redirect: `RF_OIDC_REDIRECT_URI`, exactly as registered (by default `RF_PUBLIC_URL/auth/callback`; the site's root works too);
  - a **Web** app: its client secret in `RF_OIDC_CLIENT_SECRET`. A public client (Mobile and desktop) needs none;
  - a **Single-page application**: `RF_OIDC_SPA=1`, and no secret. The browser then redeems the sign-in, as Microsoft requires, and the server checks the token's signature.

  The same button then goes to Microsoft, and the same app gives each person's **Microsoft 365 login** (Logins, Connect Microsoft 365): grant it the delegated Microsoft Graph permissions `Mail.Read`, `Mail.Read.Shared`, `Files.Read.All`, `Sites.Read.All` and `offline_access`, with admin consent once for the organisation. That needs a Web app or a public client; a Single-page application can't keep the login. `RF_ADMINS` names the admins; `RF_ALLOWED_DOMAINS` and `RF_AUTO_PROVISION=0` narrow who may come in. Start with `node --env-file=.env src/server.ts DATA_ROOT` without Docker. Microsoft takes http redirects only on localhost, so open the site as `http://localhost:8780`, not `127.0.0.1`; for others to reach it, register an https address.
- **What people see:** a workspace's owners and members, people by email or Entra groups by id, see all of it; owners manage who is in it. Admins see every workspace, and manage people with rf (Tokens, at the sidebar's foot): `rf users`, `rf user add|role|disable|enable|signout|remove EMAIL`, roles being admin, publisher (who pushes skills) and user. On the server, before there is an admin:

      docker compose exec rollforward node src/auth.ts /data list
      docker compose exec rollforward node src/auth.ts /data add alice@example.com [admin|publisher]
      docker compose exec rollforward node src/auth.ts /data disable alice@example.com   # her sessions end at once

Sessions last 12 hours (`RF_SESSION_HOURS`). The people, the workspaces' people and everyone's logins are in `.rf/` in the data root, the logins sealed with `seal.key`. Where systemd runs the server, give it `session.key` and `seal.key` as credentials (`systemd-creds encrypt --with-key=tpm2 …`, then `LoadCredentialEncrypted=`), so a copy of the data holds only ciphertext; otherwise they are made in `.rf/`.

## Skill use

A series picks, in its settings, the **skills** its agent may use; choosing none is fine. A skill is what to fetch or do, and how, whole in a folder that a publisher pushes with `rf skill push DIR`, live at once; each push is a version, and `rf skill rollback ID N` brings an earlier one back. It holds a `SKILL.md` for the agent, a `skill.json` naming what of the runner's Microsoft 365 login it reads, its website's hosts if it has one, and its settings, and the scripts it runs.

| Kind of skill | Reads through | Fetches, for example |
| --- | --- | --- |
| A OneDrive file | the runner's Microsoft 365 files | the day's AR aging file from its folder |
| A mail attachment | the runner's Microsoft 365 mail | the Excel attachment of the day's report mail |
| A vendor portal | the runner's login to its website | the portal's payments and unpaid items, as csv |

Admins set each skill up once for every series, with `rf skill set ID KEY VALUE`, such as a folder's link or a website's address (`url`); none is a secret. Until a skill is set up a series can choose it, but the agent can't use it. Skills, at the sidebar's foot, lists them with their versions.

Microsoft 365 is nobody's but each person's: a run reads mail and files only through its runner's own login, and only the mailboxes, OneDrive and SharePoint sites ticked for its instance.

Websites are each person's too: under Logins, Websites, they sign in themselves in a live browser on the page, and that browser's state is their login, sealed in `.rf/`; no password is stored. A run's scripts open a browser on a skill's website with `rf browser open SITE`, from the runner's login if ticked, and drive it with Playwright over CDP. The browsers come from the machines service, a repo of its own (`RF_MACHINES_URL`, `RF_MACHINES_KEY`): each stays on its site's hosts, makes no write but while a person drives it, and logs every request, which the instance keeps under `browser/`.

A run can also lease a Windows machine from the same service, with `rf windows`, for what needs Windows itself: scripts in Python with pywin32 or PowerShell, files passed through `working/`, no network, and a clean state again when the run ends. Office isn't on it yet. The machines service builds it from the Windows 11 evaluation, which can't activate offline and may shut down hourly once unactivated; real use needs a licence from IT.

`rf skill test ID` checks one that reads Microsoft 365 for real, as you.

From a shell, without the model: `node --env-file=.env src/cli.ts DATA_ROOT test SKILL --as EMAIL`, and `… DATA_ROOT try aging --as EMAIL -- python "$RF_SKILLS/aging/scripts/fetch.py"` (or `try portal --as EMAIL -- rf browser open portal`) runs a skill as a run with it would, with EMAIL's logins. Set `RF_TODAY` in `.env` to test against a day that has data.

To reach it from the internet, run `tailscale funnel --bg 8780`, with Microsoft sign-in configured.

For a demo run in podman behind Tailscale Funnel, the justfile has `just invite EMAIL [admin]`, `just revoke EMAIL`, `just people`, `just logs`, and `just deploy`, which rebuilds it from the committed main branch.

**Security:** each run is a sandbox. It sees its own series and the series it may read, holds no key, and reaches the internet only through the server, to package registries, GitHub and documentation sites. Anyone signed in can talk to the agents of their own workspaces within that.

## Without Docker

You need Node 26, uv, bubblewrap, socat, ripgrep and fd, and a systemd user session for each run's memory limits (or `RF_SANDBOX_SCOPE=` without). LibreOffice is optional, for recalculating formula workbooks.

    npm install
    uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
    node src/server.ts DATA_ROOT [PORT]

The [justfile](justfile) has these and more as recipes; `just` lists them.

- **Model key:** `OPENROUTER_API_KEY`. It stays with the server, which adds it to the runs' model requests.
- **On a VM:** run the server as a systemd user service with lingering on, and cap all runs together with `systemctl --user set-property rollforward-runs.slice MemoryMax=50G`.
- **Environment variables:**
  - `RF_MODEL` (default `openrouter/anthropic/claude-opus-5.5`)
  - `RF_THINKING` (`high`)
  - `RF_LIMIT_MIN` (120)
  - `RF_PI_ARGS` (a JSON array of extra Pi arguments)
  - `RF_HOST` (`127.0.0.1`)
  - `RF_SCRATCH` (the system's temp folder`/rollforward`), for each run's HOME and /tmp and the server's socket for runs
  - `RF_SANDBOX_SCOPE`, the command that gives each run its cgroup (a `systemd-run --user --scope` line; empty for none)
  - `RF_SANDBOX_RO`, more folders runs may read, separated by `:`
  - `RF_MACHINES_URL` (`http://127.0.0.1:8797`) and `RF_MACHINES_KEY`, the machines service, for websites' browsers and Windows machines; their tests run only with these set
  - `RF_MODEL_URL` (`https://openrouter.ai/api`)
  - `RF_MAX_RUNS` (20), runs at once across all series, and `RF_MIN_FREE_GB` (6), the free memory below which none starts
  - `RF_OIDC_SCOPES` (`openid profile email`), sign-in's scopes
- **Hosts runs may reach,** beyond package registries, GitHub and documentation sites: a JSON list in `.rf/egress.json`, such as `["api.example.com", "*.example.org"]`.

To build the demo from scratch (about $4 of model use; the generator needs the internet for the ECB rates):

    .venv/bin/python demo/make_demo.py demo/out
    .venv/bin/python demo/run_demo.py demo/out http://127.0.0.1:8780 DATA_ROOT

## More

- [PLAN.md](PLAN.md): the design and the decisions.
- [prompt.md](prompt.md): the agent's instructions.
- [docs/design.md](docs/design.md): the look.
