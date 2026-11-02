# The next round

Agreed with Matthew on 2 Nov, after his review of the proposals and twenty questions. Each part moves into PLAN.md as it is built; until then this is the design, and PLAN.md describes what runs today.

## Principles

- **Knowledge lives in rollforward.** Outside services are tools that do what they're told and report exactly what they did. What is learned, recorded and reused stays with the series.
- **The agent drives everything itself.** Every outside call blocks until it's done or reaches its time limit. The only waits are for people: a run that needs someone ends its turn and resumes when they act.
- **Nothing is written to outside systems.** Every output is a file that people take onward. Inputs can be fetched automatically.
- **Every login is personal.** A run uses only its runner's own logins, and only those ticked for its instance.
- **Accountability follows acts.** Each run belongs to its runner, and closing an instance signs it off.
- **Wide tools, thrown away.** The agent's code gets real tools (a whole browser, a whole Windows machine) inside something deleted when the task ends.

## People and sharing

- **The workspace is the only unit of sharing.** Its members see every series in it. A workspace is usually one entity's work, such as its bank rec, inventory rec and borrowing base. An area that needs hiding, such as payroll, becomes a workspace of its own with fewer members.
- **Roles:**
  - **Members** start instances, comment, answer, and close the instances they run.
  - **Owners** also manage membership and the workspace's guidance.
  - **Admins** manage who can sign in, write the company's guidance and name the publishers of skills.

  There's no read-only role.
- **Members are people or Entra groups,** from the ID token's `groups` claim once the app sends it. A new workspace starts with its creator, who adds their team.
- **Reading across workspaces:** a run may also read any other workspace that includes every member of its own. A payroll workspace's agent can read the entity's main workspace; never the reverse.

## Series, instances and runs

- **Workspace > series > instance.** Each workspace also has an **Ad hoc** series for one-off asks, listed apart. **Make it a series** moves a one-off into a new series as its first instance, and the next instance rolls forward from it.
- **Several open instances:** up to 3 per series; a wake that would open a fourth becomes a request on the page.
  - A new instance starts from the latest closed one and reads the open ones.
  - Closing an instance wakes its series' later open instances, so they pick up the final figures rather than the draft.
- **The runner** is whoever created the instance, or for an instance a wake started, whoever turned on Allow wakes. Every run in the instance uses the runner's ticked logins and is theirs to answer for. Others comment and answer.
- **Taking over** an instance makes you its runner from then on, and asks the login ticks again with your own logins. The log records who took over and when.
- **Closing** is the runner's sign-off: "I've reviewed this and stand by it". Whoever closes answers for the whole instance, including runs done before a takeover. Closed instances never change.
- **Repairs are behaviour, not code.** To fix a closed instance, an agent wakes its series with the reason. The new instance works from the one it corrects, is labelled with `r2`, and replaces it for that period in what others read. When done, it wakes the instance that asked.
- **Queueing:** one run at a time per series; at most 20 runs at once, raised toward 40 once the provider's limits and a week of memory peaks allow it.

## Logins

Built: logins sealed per person, ticks at every start, copy and takeover, runners and takeover, close by the runner only, Microsoft 365 logins and website logins (PLAN.md, decisions 37, 38 and 43). Still to come: an expired login's run waiting for its runner to sign in again rather than only saying so.

- **Kinds, to start:**
  - **A website,** for the ERP and each vendor portal. The person signs in themselves, in a live browser shown on rollforward's page; the session's saved state (cookies and site data) becomes their login. No password is ever stored. It lasts as long as the site keeps a login alive: weeks behind a company sign-in, under an hour on sites with short sessions of their own.
  - **Microsoft 365:** one read-only sign-in per person (`Mail.Read`, `Mail.Read.Shared`, `Files.Read.All`, `Sites.Read.All`, `offline_access`), approved once for the company by an admin. The person then adds what they want offered: their mailbox, shared mailboxes by address (rollforward checks they have access), their OneDrive, and SharePoint sites by link. The sign-in renews itself while used, up to about 90 days or what company policy allows.
- **Ticks:** starting an instance lists the person's logins and asks which this instance may use, every time. The server refuses anything unticked: an unticked mailbox, site or website can't be reached in that instance.
- **Wakes** use the ticks the Allow-wakes person set when turning it on (see Waking).
- **An expired login** stops the run at the point it's needed: it asks its runner on the page to sign in, ends its turn, and resumes once they have.
- **Nobody else's login, ever.** Logins aren't attached to series or workspaces: a run uses only its runner's.
- **Storage:**
  - Each login is one sealed record under `.rf/people/<id>/`: AES-256-GCM, with the owner and the login's id as authenticated data, so a record copied to another person's file won't open.
  - The key is a systemd credential (`LoadCredentialEncrypted=`), sealed to the VM's TPM, outside the data folder. A copy of the data holds only ciphertext. The cookie-signing key moves the same way.
  - Sandboxes never see `.rf/`. Microsoft tokens never leave the server: the agent reaches mail and files through `rf mail` and `rf files`. A website login goes to the machines service for one session and comes back refreshed, to be sealed again; during the session, the agent's code can read its cookies.
  - Signing out deletes the record; removing a person deletes all of theirs; every use is logged with its run.
- **The ERP:** if it has an inquiry-only role, people use it when they sign in to the ERP through rollforward, which makes "no writes" a wall there (see Machines).

## Waking

Built (PLAN.md, What starts a run, decision 36), with Allow wakes' login ticks and Waiting on you at the top of the sidebar. Schedules are gone: a run is started by a person, by an upload or answer, or by a wake.

- **`rf wake TARGET AT REASON`:**
  - **An open instance** (this one if none is named): continues it, as its runner, as a reply does.
  - **A closed instance:** fails, saying to wake its series for a repair.
  - **A series:** starts a new instance, for the next period or for a repair, as the reason says. That needs the series' **Allow wakes**; without it, the wake becomes a request on the page: "Inventory rec asks to start Borrowing base".
- **Allow wakes,** per series: whoever turns it on becomes the runner of every instance a wake starts, with the logins they tick then. Off, or that person losing access, stops it; anyone can take it over.
- **Cadence is the agent's:** a person starts the first instance; before finishing, the agent sets its next period's wake ("Mon 07:00"), and wakes within a period for late inputs. Upstream agents wake downstream series and instances when their outputs are ready.
- **The page** shows each series' next wake, which people can edit, and flags a series with Allow wakes on, nothing open and no wake pending, so a broken chain is visible.
- **Mechanics:** one pending wake per instance (a new one replaces it), at least 15 minutes apart. A timer checks every minute and starts the run unless one is going; an upload or answer that starts a run first cancels the pending wake. After a restart, overdue wakes fire.
- **No notifications.** The home page lists what's waiting on you: questions, sign-ins, requests to start.

## Talking

Built: comment threads and `rf say`, the Conversation panel, Advanced without its own typing, the agent's report (its last message, logged, its first line the summary) and the prompt's rules for asking (PLAN.md, decisions 39 and 40). Still to come: comments pinned to a cell inside the preview.

As proposed, unchanged except that nothing asks for approval to write:
- **Comments** on the work, as in Excel: on a tile, a cell from Preview, a paragraph of Process, or the instance. Each is a thread anyone can reply to, with attachments; open until resolved.
- **Questions** keep options and a default, so Close still works, and people can always answer in their own words. A question may name who should answer it.
- **The agent's closing message is its report,** posted to the instance's conversation; `rf say THREAD TEXT` answers in a thread. Its first line replaces `summary`.
- **Advanced shows the trace and Interrupt,** with nothing to type.
- **Open points** lists what waits on people, questions first.
- **Prompt:** ask about every call a reviewer might make differently, lead with the effect on the deliverable, look for an earlier answer before asking, and reply to every comment in its own thread.

## Process and the review sheet

Built: `process.md` as the people's document and a review sheet with every instance (in the prompt), and Process beside the graph, redlined against the previous instance.

- **Process is the people's document,** shown beside the graph and written for a colleague who knows the business but not the scripts: what the series delivers, each input and where it comes from, the steps with their rules in words, the standing rules with who set them, and the checks. No paths or code. It shows, as a redline, what changed since the previous instance. The agent's technical memory lives in its scripts.
- **A review sheet with every instance,** for whoever closes it: key figures against the previous instance with the reason for each material change; the checks run, each linked to its cell; what was carried or assumed; the open points; and each input's source. A workbook when the outputs are workbooks.

## Knowledge

Built: guidance, the company's and each workspace's, and the catalogue, both in each run's view (PLAN.md, decision 39), and skills published with `rf skill push` (decision 41), and `rf search` over every file in reach, with workbooks', mail's, PDFs' and Word files' text kept by hash.

- **The archive is the instances.** Agents find and weigh what they need when they need it; nothing is classified on the way in.
- **Reach** is the workspace, plus any workspace every member of this one belongs to. Everything in reach is mounted read-only in the run's sandbox, at a stable path.
- **The catalogue,** generated by the server and read first: one line per series in reach, with its purpose (Process's first line), its last closed instance, its inputs and sources, and who uploads and answers.
- **Guidance:** one text for the company and one per workspace, written by owners and admins and read by every agent in scope. Conventions go there, and so do changes that cut across many series, such as an entity moving under another or renamed cost centres: each series adapts at its next run, and its Process redline cites the guidance. To make it happen sooner, a power user's agent wakes the affected series.
- **Skills are company-wide only.** Within a workspace, every series' scripts are already in reach: an agent copies the closest and says where it came from.
- **Crystallising happens off the page.** Power users' desktop agents read records across instances through `rf` and turn common patterns into skills. Publishers, named by admins, release them with `rf skill push NAME/`: live at once for every workspace, every version kept with who pushed it and when, rollback by pushing an earlier one, and each run's log naming the version it used.
- **Prompt:** before asking, look for an earlier answer in reach and cite it; when learning a new series, start from the most similar one's process and scripts; weigh what's read by its date.

## Machines: browsers and Windows

A separate service, in its own repo (`machines`), with one client: the rollforward server, holding its key. Two kinds of machine, one API: open, run code, move files, screenshot, request log, close and wipe.

- **A browser** is a throwaway container per session, with Chromium. The agent's code connects with Playwright over CDP, through rollforward's socket, so it has all of Playwright, including requests with the page's cookies. Since CDP is close to code on the browser's host, the container is the wall: an empty home in memory, no view of the host or other sessions, and a network only through the service's proxy.
  - The proxy lets the session reach only its site's hosts; private addresses only where a listed host resolves there.
  - By default it blocks requests other than GET, HEAD and OPTIONS, except those the site lists as reads that post, and except while a person drives the live view. That's a firm default, not a wall: code could work around it. The ERP's web client posts even to search, so there it would block everything: the ERP's site lists its posts as reads, and "no writes" rests on the instructions and on the ERP role the person signs in with.
  - Every request is logged with its run and login, where the agent can't edit it.
  - The service loads the runner's saved login at the start, and returns it refreshed at the end; then the container is deleted.
  - The same session, shown live on rollforward's page, is how people sign in.
- **A Windows machine** is a virtual machine leased for a bounded task, up to about 2 hours, for Office work: Excel, PowerPoint and Word through scripts (Python with pywin32, or PowerShell), and UI Automation for programs that can't be scripted.
  - A warm pool waits at a snapshot taken signed in and idle, with memory. Opening hands one over in seconds; closing, or the time limit, resets it to the snapshot, so nothing a script did survives.
  - No network inside: the host talks to it over a private channel, files go in and out that way, and the host takes the screenshots, so they work while Windows hangs on a dialog.
  - A machine needs 6–8 GB of memory and 2–4 cores; a 64 GB host runs 6–8 at once.
  - Windows and Office licences for virtual machines come from IT (Microsoft 365 Apps with shared-computer activation is the usual route).
- **In a run:** `rf browser open SITE` returns a CDP address inside the sandbox; `rf windows open|run|put|get|screenshot|close` drives a Windows machine. Calls block until done. Machines close when their run ends.
- **What goes:** JSON flows, `rf flow`, site sign-in code, the shared accounts in skill settings, and the ERP's separate automation service. Each becomes a skill whose scripts drive a browser session in the runner's own login. A recorded session's steps are just the agent's script, kept with its instance like any other.

## Sandbox and network

Built: each run is a bubblewrap sandbox with a broad allowlist through the server's socket (PLAN.md, M3 and decision 33). Still to come:
- **The catalogue and guidance** in the tree by name each run gets (built: its reach, by name).
- **Shared package caches,** so most runs install nothing.
- **What this gives up:** an allowed site that accepts uploads is a way out for data if the agent is tricked, such as a token planted in an email with "push this file". If that ever matters, the proxy can allow only downloads and clones, which means inspecting encrypted traffic.

## Storage

Built: folders by id, `.rf/tree.json`, the index of `instance.json`s, renames that edit one file, links by id, and the one-off migration (PLAN.md, Storage, decision 35). Still to come:
- **The index keeps a summary** of each instance, updated from the log bus, so lists stop loading every instance's screen and log.
- **References are kept by id.** The agent cites `../2026-08-16/working/x.csv`; on `rf put` the server resolves it against the run's own tree, stores the instance id, the path and the sha256 alongside what was written, and rejects what doesn't resolve.
- **Later:** object storage and Postgres, when one host or one disk stops being enough. Id folders map to blob prefixes and `.rf/` to tables; nothing above the tree changes.

## Architecture

- **Configuration lives in `.rf/` and `series.json`, history in logs, and content in files.** Whatever happens is a log entry; whatever people set is a JSON file the server writes; whatever people and agents work on is a file.
- **One API,** documented, used by the page, the agent's `rf` and power users' `rf`. Every caller is a principal: a person (cookie or personal token), a run (run token), or the clock. The API addresses things by id.
- **The log is the queue and the bus.** Every trigger is a log entry: an upload, an answer, a comment, a wake whose time has come. Consumers (the waker, the page's event stream, the maker of derived files, the catalogue) read new entries from an in-process bus with their own cursors and catch up after a restart.
- **The run engine moves out of `server.ts`:** `server.ts` keeps HTTP and the API; `waker.ts` decides what runs when (one per series, the cap, wakes); `runner.ts` runs one run, the sandbox and Pi.
- **Restarts don't wait for quiet** (built). On start, each run a restart cut is logged as aborted and started again with "A restart cut your last run; carry on". `just deploy` no longer waits.
- **Frozen files are referenced, not copied:** an item may point at another instance's frozen file by id, path and hash.
- **Derived files by hash:** each frozen file gets its Preview, a text extract (so `rf search` greps inside every workbook and email in reach) and its renders, once.
- **Tools carry the mechanics; the prompt carries judgement.** `rf` gains `say`, `wake`, `browser`, `windows`, `search` and `skill`, each with its own help.
- **Events instead of polling:** `/api/events` streams changes the principal may see; the page stops polling the whole tree every 4 seconds.
- **Costs are shown** per instance and per series (built). No caps for now.

## Power users

Built (PLAN.md, Tokens, decision 41): personal tokens and people's `rf`, which is also the only place for admin (Matthew, 3 Nov: the page gives admins visibility, not controls). Publishers are a role admins give. Still to come: `rf comment` on a cell from a desktop agent's own view of a workbook.

- **Personal tokens,** made in the page with an expiry, acting as the person; every use logged; revocable.
- **`rf` for people,** on their own machine: `rf login`, `rf ls`, `rf pull` (a read-only mirror of what they can see, in the layout agents see, traces included), `rf comment` (`--wait` prints the agent's report), `rf answer`, `rf upload`, `rf wake`, and for publishers `rf skill push`.

## Capacity

One VM with 16 cores and 64 GB, inside the company network, runs the server, the runs and the browser containers. Windows machines need a host of their own, or this one with less room for runs.

- **Measured runs:** a light run takes 0.3–7 minutes and $0.02–1.08; a heavy one (a 26 MB workbook) takes 7–33 minutes, 40–50% of it in tools on one core, and $1.53–6.66.
- **Memory binds first:** a run takes 0.5–1.5 GB typically and up to 7 GB for a full openpyxl load. Each run's cgroup has `MemoryHigh` 4 GB and `MemoryMax` 8 GB, all runs share a parent capped near 50 GB, and the waker starts nothing while free memory is under about 6 GB (built: `RF_MIN_FREE_GB`). 40 runs fit; 20 leave room.
- **CPU:** 16 cores suffice; runs get equal weights, the server more.
- **The provider binds next:** check the key's per-minute limits against 40 heavy runs (10–28M cache-read tokens a minute) and keep the cap under them; Pi's auto-retry backs off on rate limits.
- **Disk:** added when the load grows. For design: 0.5–1.2 TB a year, on a filesystem with reflinks; nightly restic backups, with the keys kept apart.

## Testing

Everything we build runs on the development machine; only the real outside systems don't.
- **Stand-ins:** a fake portal (a sign-in, expiring sessions, an ERP-like page whose every click posts, a download, a link to another host) and a fake Microsoft (sign-in, mail, files) reached through configurable addresses.
- **Scenario tests** drive real runs with a scripted stand-in for the model, so wakes, ticks, takeovers and the sandbox's walls are checked at no model cost: reading `.rf/`, reaching an internal address or opening an unticked mailbox must fail.
- **A few runs with the real model** check the prompts, at $1–4 each.
- **Not on the development machine:** the real ERP and portals (a pass on the company VM) and a real Microsoft tenant (an app registration there).

## Build order

1. The sandbox and the network (built).
2. Ids, members and owners, and the migration script (built).
3. Microsoft 365 logins and the ticks (built).
4. Website logins through the machines service (built); the ERP and the portals move onto them as their skills are rewritten.
5. Waking, several open instances, Ad hoc (built).
6. Talking, Process and the review sheet (built).
7. Power users, `rf skill push`, guidance and the catalogue (built).

The machines service is built alongside, in its own repo: browsers (built, used by website logins), then Windows (built, paused on licences; `rf windows` is to come).

## Facts still to get

- Whether the ERP has an inquiry-only role.
- Whether the company sends web traffic through a proxy.
- Who in IT approves the Microsoft 365 permissions.
- Windows and Office licences for virtual machines.

## What this reverses in PLAN.md

- **Schedules** (none were built): replaced by wakes and Allow wakes.
- **Shared connections:** the Microsoft 365 apps reading one mailbox, and accounts in skill settings, give way to personal logins.
- **Flows and sign-ins:** `rf flow`, JSON flows, `signin.ts` and site sign-in code go; scripts drive browser sessions.
- **Approved writes** (decision 29): nothing writes to outside systems.
- **Skills in the repo:** skills become data published with `rf skill push`; the repo keeps none.
- **Ownership** (decision 26): one owner per workspace becomes members and owners; series visibility (21) gives way to reach.
- **Steer and `rf reply`:** comments and the agent's report.
- **Storage by name,** renames that move folders and rewrite sessions, and `.archived` files.
- **The agent API on its own port** becomes a unix socket into the sandbox.
- **Polling** gives way to events; `just deploy` stops waiting for quiet.
