# rollforward: recurring tasks, files in and files out

`src/` holds the server, the store, the runner, the agent's `rf` and people's (`rf-people.ts`), `web/` the page, and `demo/` a made-up weekly series to test them with. [docs/design.md](docs/design.md) holds the design notes for the page.

- **What this is:** a small web platform for recurring tasks. People drop in input files, and an agent produces the output files, having learned how from earlier instances. People move files; they don't type prompts.

## Concepts

- **People:** everyone signs in with a Microsoft account, by pressing Sign in with Microsoft. A person is a **user** or an **admin**.
- **Workspace:** a top-level folder of series, usually one entity's work, such as its bank rec, inventory rec and borrowing base. It is the only unit of sharing: its **members** see and work in every series in it, and its **owners** also manage who is in it. Each is a person by email or an Entra group by id. An area that needs hiding, such as payroll, is a workspace of its own with fewer people. A workspace with no one in it, such as the demo's, is the admins'.
- **Series:** a recurring transform, such as "Weekly borrowing base": each instance's input files become its output files. What an instance should contain comes from earlier instances, not from a declaration.
- **Skill:** what the agent knows how to fetch or do, and how, whole in a folder: such as the day's AR aging from OneDrive, or a customer's payments from its vendor portal. Admins set each up once with rf: its links or, for a website, its address.
- **Skill use:** the skills a series' agent may use. Skills only read: nothing writes to a system outside rollforward.
- **Login:** a person's own sign-in to a system, such as Microsoft 365 or a website, offering runs what it reaches, such as a mailbox or a site. Every login is personal: a run uses only its **runner**'s logins, and only those ticked for its instance. The runner is whoever made the instance, copied it, or last took it over; for an instance a wake started, whoever turned on Allow wakes, with the logins they ticked then.
- **Reach:** a series' agent reads the other series of its workspace, and those of any workspace that has everyone its own has (by the same email or group), so nothing it reads reaches someone who couldn't see it already: a payroll workspace's agent reads the entity's main workspace, never the reverse. It never writes there, and copies into its own `working/` what it relies on. A workspace with no one in it reaches only itself.
- **Archive:** a workspace or a series that's no longer in use can be archived. It leaves the sidebar, except under "Show archived", until it's restored, and nothing in it changes. It isn't transitive, but what a reader copies can flow on.
- **Instance:** one pass through a series, under a label people choose, such as "2026-08-24" or "Larkfield refinancing". Instances needn't be periods. They sort alphabetically by label, and only open ones show by default.
- **Item:** one tile on an instance's screen. It has a stable id, a display name and a kind: input, step or output. A **step** is an intermediate result a reviewer would check, such as "Eligible AR", in a file the agent writes. An item also has the file it currently shows, the items it's made from (`from`), and its notes. Replacing a file means pointing the item at a new file.
- **Graph:** the items, joined by what each is made from. It's a picture for people: nothing runs it, and the agent's scripts needn't follow it.
- **Example:** a closed instance. Its input items and output items are one example pair. The agent learns the transform from these pairs, and writes it down as scripts and notes in `working/`.
- **Run:** one stretch of agent work on an instance, started by an upload, an answer, a comment or a wake. Runs are internal; the ops log and Advanced show them.
- **Note:** an agent comment on an item, pinned to a place in the file, such as a cell, where that matters. A **question** is a note with options and a default.
- **Key and additional inputs:**
  - An input item is a **key input**: the output is made from it, and the series expects it every time.
  - Anything else a note relies on, such as an email or a document, is an **additional input**. The note lists it in `files`, and the page shows it under the inputs as "Also used".
  - Where a file came from is a separate question. It is **evidence** if it was taken from outside as it is (an upload, or a file the agent fetched), and **working** if the agent made it.

## Screens

- **Sidebar:** a cascade of workspaces, series and instances. The open workspace lists its series, and the open series its open instances in label order, then "Show closed (18)". The open workspace and series carry their actions in their row's corner: ⋯ opens settings, and + makes a series or an instance. + by "Workspaces" makes a workspace. A red dot on a collapsed workspace or series marks an open question in it; a black dot on an instance marks changes since this browser last opened it.
- **Instance:** the graph. Inputs come first, then the steps, column by column, and lines join each tile to what it's made from. Outputs have their own column on the right, so they're always in view. The rest and the outputs scroll on their own, with scrollbars always shown, and each keeps its heading and + Add files in view while its tiles scroll under them. Hovering a tile highlights what feeds it and what it feeds. Outputs and the rest are the two drop zones.
  - A tile shows the item's name, its current file and version, and who made it, by colour: blue for a person and black for the agent. Hover shows who, when, and what it replaced. Earlier files are in the ops log.
  - Dashed tiles are items with no file yet: inputs that earlier instances had and this one lacks, and steps and outputs not built yet. The agent's note says why.
  - The agent can add inputs of its own, such as a table it extracted from an emailed PDF. Their files live in `working/`, so they show as agent-made.
  - An output's tile shows the agent's one-line headline. An input the agent fetched shows its source. Under the input tiles, "Also used" lists the files that notes cite and no tile shows.
  - A corner marks a tile with agent notes: gray for a note, which is for information, and red for a question waiting for a person. Hover shows them, with where in the file they apply. A question shows its options as buttons, and says which applies if it's still unanswered at close; clicking one answers it.
  - A drop is a hint. The server adds each dropped file as a new item at once, even mid-run: an output if it was dropped on Outputs, otherwise an input, and the log records the tile it was dropped on, if any. The agent then decides what it is, such as a replacement for an input's file, and says so in a note.
  - There is no text box. People drop files, click answers and close the instance.
- **State hints:** a spinner marks the running instance in the sidebar and the top bar, with a stripe along Outputs; ⧗ marks one waiting to run. A tile flashes when it changes and keeps a black dot until opened. An unanswered question's corner pulses, and an answer shows a spinner until the agent has read it. Uploads show progress, a finished run and an error each show a toast, the tab title counts open questions, Esc closes the top layer, and abandoned instances are struck through.
- **Not shown:** `process.md`, the agent's own account of the process, which points at its scripts. The graph is the process for people.
- **Waiting on you,** at the top of the sidebar when anything does: questions in instances you run, requests to start a series you can see, series whose wakes you allowed that have nothing open and no wake set, and your logins that have expired. There are no notifications.
- **Process:** a side panel with the instance's `working/process.md`, redlined against the instance it was made from (else the series' latest closed before it), so a reviewer sees what changed in the method, not only in the figures.
- **Conversation:** a side panel with what waits on people, open questions first and then open threads, the agent's latest report, and every thread. People talk to the agent only in comments: a comment starts a thread, on an item (Comment on its card; a `ref`, such as a cell, may say where) or on the instance, or replies in one. The agent replies in the thread with `rf say`, and a person resolves it. A comment starts a run, like an upload or an answer; the bar's Conversation button counts what is open.
- **Ops log:** a side panel listing who did what, when: uploads, runs, every change the screen showed, answers, comments and the agent's replies, reports and the close. Earlier files open from here.
- **Preview** shows a spreadsheet with its noted cells marked. If the file replaced an earlier one, "Compare with previous" highlights the cells that changed, and a click shows the old value.
- **Advanced:** a bar along the bottom that expands over the graph, like VS Code's terminal panel.
  - It shows what the agent does, like Claude Code: each run starts with what triggered it, plus its time and cost. The agent's messages read as text, and each tool call is one line with a short result. Consecutive calls fold into a summary such as "Read 3 files, ran 2 commands". Each call expands to its full output, and failures are red. During a run it is live. Past runs are read from the instance's Pi session file.
  - Nothing is typed here: people talk in the Conversation. **Interrupt** stops the run.
- **New series:** give it a name. Then import past instances one at a time, in label order: create the instance, drop its inputs on the left and what was actually sent on the right, let the agent rebuild each output and note what it can't derive, and close it.
- **New instance:** give it a label, and tick which of your logins it may use (asked every time, as when copying an instance or starting one a wake asked for). It starts with the graph of the most recently closed instance, as dashed tiles. Up to three instances of a series are open at once; a fourth waits for one to close.
- **Ad hoc:** each workspace has an Ad hoc series, listed last, for one-off asks. Its instances start empty rather than from each other, and it keeps its name. **Make it a series** moves an Ad hoc instance into a new series as its first instance, which later instances roll forward from.
- **Wakes on the page:** a series shows its next wake, which its Series settings move or cancel, and an instance its own. **Allow wakes**, in Series settings, lets wakes start new instances of the series, run as whoever turned it on; without it, an agent's wake shows as a request, "Inventory rec asks to start 2026-09-20", to start or dismiss. A series that allows wakes but has nothing open, no wake set and no request is marked "no wake set", a broken chain.
- **Close instance:** the runner's sign-off, "I've reviewed this and stand by it", for the whole instance, runs before a takeover included; only the runner can, so others see **Take over**, which makes them the runner from then on, asks for their own logins to tick, and is logged with whom it was taken from. Closing freezes the instance as an example. Unanswered questions take their defaults, and the dialog lists which. It is disabled while a run is going.
- **Abandon:** the other way an instance ends. It stays as it is, but it isn't an example, never becomes a new instance's starting point, and applies no defaults. It is also disabled while a run is going. Closed and abandoned instances both show under "Show closed".
- **Duplicate:** a closed or abandoned instance can be copied, under a new label, into an open instance. The copy has its files, screen and log, but not its agent session, and its log records the copy as `duplicate`.
- **Rename:** an open instance's label changes from the pencil by its title, between runs. The log records `rename`.
- **Series settings:** the series' name, its Skill use (the skills its agent may use, each saying if it is not set up yet), what its agent can read, and Archive. Renaming a series or a workspace edits one small file, so it may happen mid-run; a run sees the new names from its next start. **Workspace settings** hold its people, owners and members, which owners and admins change, and Archive, also theirs. An archived workspace or series is restored from its settings, under "Show archived".
- **Logins** (everyone): your logins, each with what it offers, and Sign out, which deletes it. **Connect Microsoft 365** signs you in to Microsoft for read-only mail and files; then add the shared mailboxes you read, by address, and SharePoint sites, by a link. Under **Websites**, each skill with a website has Sign in (or Sign in again): a browser on the site's address opens in the page, live, where you take control and sign in as you always do, then Save login; Cancel throws it away. An expired login says so, with Sign in again.
- **Costs** show per instance (Advanced) and per series (Series settings), with no caps.
- **Tokens** (everyone): personal tokens for **rf**, people's command line ([src/rf-people.ts](src/rf-people.ts), served at `/rf.ts`), each named, lasting 7, 30 or 90 days, shown once and revocable. rf does what the page does, as its person: `ls`, `pull DIR` (a read-only mirror of what they can see, in the layout agents see, with each instance's screen, log and trace), `comment` (`--wait` prints the agent's replies and report), `answer`, `upload`, `wake` and `guidance`. A token stops at its expiry, when revoked, or when its person is disabled, signed out everywhere or removed; `.rf/tokens.json` keeps only hashes, and `.rf/token-uses.jsonl` logs every use.
- **Admin is rf, not the page.** Admins see every workspace on the page, and everyone who can sign in under People, but manage people (`rf users`, `rf user add|role|disable|enable|signout|remove`), skills' settings and tests (`rf skill set|test`) and the company's guidance (`rf guidance --set`) with rf. Publishers, a role admins give, push skills (`rf skill push DIR`, `versions`, `rollback`). The first admins come from `RF_ADMINS`, or `node src/auth.ts DATA_ROOT add EMAIL admin` on the server.
- **Skills** (everyone, read-only): every skill, what it reads, its live version with who pushed it and when, and whether it is set up.
- **Names:** the log records each person by the email they signed in with. The sidebar's foot shows who is signed in, with Sign out.

## Storage

Everything is files on the host's disk, in folders named by random ids. There is no database. Names live in two small files, so a
rename or a move never moves a folder.

    .rf/                      the server's own: users.json, tree.json, people/<sha256(email)[:16]>/ (each person's logins),
                              skills.json (skills' settings), wakes.json (pending wakes and requests),
                              egress.json (hosts runs may reach), tokens.json and token-uses.jsonl, and the keys session.key
                              and seal.key
    guidance/                 company.md, the admins', and <workspace id>.md, each workspace's owners'
    derived/                  <sha256>.txt, the text of a workbook, mail, PDF or Word file, for rf search
    skills/                   versions/<id>/<n>/, each pushed version with its .pushed.json, and live/<id>, a link to the one runs use
      tree.json               {"workspaces": {id: {name, owners, members, archived?}}, "series": {id: {name, workspace, archived?}}}
    series/<id>/              a series
      series.json             {"skills": [skill ids], "wakes": {by, since, logins}}, set by people through the server, read-only
      .pylib/                 Python packages the series' scripts installed
    instances/<id>/           an instance, flat, made by New instance
      instance.json           {"label", "series": id}, read-only
      upload/                 people's files, as uploaded, read-only
      working/                the agent's area: scripts, process.md, drafts, outputs and its own inputs
      workspace.json          the instance's screen, saved by the server, read-only
      log.jsonl               everything that happened in the instance, written by the server
      session/                the instance's Pi session, shown in Advanced
      browser/                each run's browser requests, run <n> <site>.jsonl, one line per request, by the server, read-only
      calls/                  in instances from before decision 32 only: writes the agent proposed and their outcomes

- **Logins are sealed:** `.rf/people/<id>/logins.json` lists a person's logins and what each offers; each login's secret (Microsoft's refresh token, a website's browser state: its cookies and local storage) is `<login id>.sealed`, AES-256-GCM with the person and the login's id as authenticated data, so a record copied to another person's folder won't open. Signing out deletes it, and removing a person deletes all of theirs. The key, `seal.key`, like the cookie-signing `session.key`, is a systemd credential where systemd runs the server (`LoadCredentialEncrypted=`, sealed to the machine's TPM), so a copy of the data holds only ciphertext; in the container image it is made once in `.rf/`.
- **The index:** at start the server reads every `instance.json`, and lists a series' instances from that; an instance's screen and log load when it's first listed or opened. The site and its API address workspaces, series and instances by id (`/api/workspaces/<id>`, `/api/series/<id>`, `/api/instances/<id>`, `/files/<id>/…`), and the page's address is `#/<id>`, so links survive renames.
- **A run sees the data by name** (see Runs in sandboxes): `/work/<workspace>/<series>/<label>/` for every instance in its reach, built when it starts. A note's cited file, `../<label>/…`, is found by label in the instance's series when it's put, so an open instance waits for its series' run to end before it's renamed.
- **[scripts/migrate-ids.ts](scripts/migrate-ids.ts)** moved the trial's data, and the demo's, from folders by name to folders by id, once.

- **The server holds each instance's screen and log.** They needn't be files, but who owns what stays the same. The server saves the screen to `workspace.json` (a temporary file renamed into place, read-only) and appends each event to `log.jsonl`. Closed instances therefore stay plain folders.
- **Who writes what:**
  - People upload, answer, comment, interrupt and close, all through the server.
  - The server adds each upload as an item at once, creates and closes instances, and is the only writer of the log.
  - The agent decides the items and the notes. It changes them only through `rf`, and reads `log.jsonl` directly.
- **`upload/` belongs to people.** Nobody moves, renames or changes these files. Each streams, as it arrives, to a temporary file in the data root's `.tmp/`, which the server empties when it starts; it is then renamed into place and made read-only. An upload may take up to an hour, and is refused if its instance closed or moved meanwhile. A repeated name becomes `<stem>_<n><ext>`, with the lowest free n. Names and labels have `/`, `\` and control characters replaced, and may not start with `.`.
- **`working/` belongs to the agent,** which may do anything there with one limit. A file the screen has shown never changes again: the server makes it read-only and logs its hash, so a new version gets a new name.
- **`rf`** is a small command on the agent's `PATH`:
  - `rf show` prints the screen, `workspace.json`, including its `rev`, which the server bumps on every change.
  - `rf say THREAD TEXT` replies in a comment thread; the server logs it as `say`.
  - `rf search PATTERN [FOLDER …]` finds a regular expression, in any case, in every file of every instance in the run's reach: text files by their lines, and workbooks, mail, PDFs and Word files by the text [src/extract.py](src/extract.py) reads of them (a workbook a line per row, `Sheet!row: A1=… | B1=…`), kept in the data root's `derived/` by the file's sha256 so each is read once ([src/search.ts](src/search.ts)).
  - `rf put FILE` replaces the screen with FILE. The server rejects it if its `rev` isn't current, because someone changed the screen since the agent read it; the agent then re-reads and merges. It also rejects an invalid document, listing the reasons.
  - **Valid** means:
    - every item has a unique id, a name, and a kind of input, step or output;
    - `from`, if present, lists ids of the instance's items, and never leads round to the item itself;
    - `file` is null, or the path of an existing file under `upload/` or `working/`, relative to the instance folder;
    - `headline` and `source`, if present, are strings;
    - a note's `files` are paths of existing files under `upload/` or `working/` of this instance or another (`../<label>/working/...`);
    - `status` is unchanged;
    - each question has a unique id, two or more options, and a valid default.
  - On accept, the server logs each change: `point`, `item`, `note`, `unnote` and `remove`. It also freezes each newly shown file.
- **The agent makes the decisions.** It decides what each upload is (a new input, a replacement or a revised output), what the outputs are, and the notes. If an item points at a person's upload, the agent repoints it to its own file only by asking first.
- **A closed instance's `workspace.json` is its example pair:** the items and the files that were actually used or sent.
- **Red dot:** in v0, each browser remembers when it last opened an instance. There are no read events in the log.

## Protocol

The schemas are loose, and unknown fields are ignored, so the agent and the UI can extend them independently. The examples are made up. The `//` comments are annotations for this plan, not part of the data.

**The screen** (`workspace.json`), after Sam's revision and the agent's run 3:

    {
      "rev": 31,
      "status": "open",                         // the server sets "closed" or "abandoned"
      "items": [
        {"id": "ar-aging", "name": "AR aging", "kind": "input",
         "file": "upload/Larkfield AR aging 082426_2.xlsx",
         "notes": [{"ref": "", "text": "Replaces the 10:41 upload: two customers corrected."}]},
        {"id": "inventory", "name": "Inventory at cost", "kind": "input",
         "file": "working/Inventory at cost 08.23.2026.xlsx",   // fetched by the agent
         "source": "Warehouse DB, snapshot 08-23, read 08-24 09:12"},
        {"id": "loan-activity", "name": "Granite Point loan activity", "kind": "input", "file": null,
         "notes": [{"ref": "", "text": "Not in the mailbox yet; every closed instance had it."}]},
        {"id": "eligible-ar", "name": "Eligible AR", "kind": "step",
         "file": "working/Eligible AR 08.24.2026 v2.csv", "from": ["ar-aging"]},
        {"id": "borrowing-base", "name": "Borrowing base", "kind": "output",
         "file": "upload/Borrowing base Larkfield 08.24.2026 reviewed.xlsx", "from": ["eligible-ar", "inventory", "loan-activity"],
         "notes": [{"id": "q3", "ref": "Base!C22", "text": "Sam changed the availability block from 500,000 to 750,000.",
                    "options": ["One-off for this week", "Standing rule from now on"], "default": 0}]},
        {"id": "funding", "name": "Funding request", "kind": "output",
         "file": "working/Funding request 08.24.2026 v2.xlsx", "from": ["borrowing-base"],
         "headline": "Requests $1.2M, $0.3M less than last week.",
         "notes": [{"ref": "", "text": "Uses the lender's waiver for this week.", "files": ["upload/Granite Point waiver.eml"]}]}
      ]
    }

**`log.jsonl`** has one line per event. `seq` orders the lines, and `by` is a person's name, "server" or "agent". The ops are `create`, `upload`, `point`, `item`, `note`, `unnote`, `remove`, `run`, `done`, `answer`, `comment`, `say`, `resolve`, `report`, `interrupt`, `close`, `abandon`, `duplicate`, `rename`, `takeover`, `promote`, `wake`, `egress` (a host a run reached or was refused), and for skills `files` and `mail` (a read through Microsoft 365) and `browser` (a run's browser on a website closed: its login, its request and blocked counts, and its log under `browser/`). Instances from before decision 43 may also hold `flow`, a skill's flow in its website. Instances from before decision 32 may also hold Tool use's `browse`, `request`, `approve`, `reject` and `call`, which the page still shows. `done` carries the run's model cost in USD. Here `point` means an item now shows a file:

    {"seq": 40, "at": "2026-08-24T15:02:00Z", "by": "alex", "op": "upload", "file": "upload/Larkfield AR aging 082426_2.xlsx", "pane": "in", "onto": null, "sha256": "9f2c…"}
    {"seq": 41, "at": "2026-08-24T15:02:00Z", "by": "server", "op": "point", "item": "u40", "file": "upload/Larkfield AR aging 082426_2.xlsx"}
    {"seq": 42, "at": "2026-08-24T15:02:02Z", "by": "server", "op": "run", "run": 4, "upto": 41}
    {"seq": 47, "at": "2026-08-24T15:09:30Z", "by": "agent", "op": "point", "item": "ar-aging", "file": "upload/Larkfield AR aging 082426_2.xlsx", "was": "upload/Larkfield AR aging 082426.xlsx"}
    {"seq": 48, "at": "2026-08-24T15:09:30Z", "by": "agent", "op": "remove", "item": "u40"}
    {"seq": 50, "at": "2026-08-24T15:14:12Z", "by": "server", "op": "done", "run": 4, "aborted": false, "seen": 41, "cost": 0.21, "summary": "AR aging replaced; borrowing base v3."}
    {"seq": 52, "at": "2026-08-24T15:20:00Z", "by": "sam", "op": "answer", "note": "q3", "choice": 1, "text": "Standing rule from now on"}
    {"seq": 60, "at": "2026-08-24T16:02:00Z", "by": "server", "op": "answer", "note": "q4", "choice": 0, "text": "Yes", "default": true}
    {"seq": 61, "at": "2026-08-24T16:02:00Z", "by": "alex", "op": "close"}

## The agent

- **One session per instance.** The server runs Pi in the series' folder in the run's view, `/work/<workspace>/<series>`, with the instructions in [prompt.md](prompt.md). Each run is one prompt into the instance's session, so within an instance the agent remembers its earlier runs. A new instance starts a new session, so whatever the next instance needs must be in the files.
- **Messages:** every prompt and steer reads `Instance <label> (folder <label>/), run <n>. New log entries:`, followed by the log lines, as JSON, that the agent hasn't been sent. The agent's own lines are left out.
- **What every run reads first:** the company's guidance (`/work/GUIDANCE.md`, the admins', set with `rf guidance --set` and shown under Guidance at the sidebar's foot) and its workspace's (`/work/<workspace>/GUIDANCE.md`, the owners', in Workspace settings), files in `guidance/` of the data root: conventions, and changes that cut across many series, such as a renamed entity, which each series adapts to at its next run. And the catalogue, `/work/CATALOGUE.md`, which the server writes when the run starts: a line per series in its reach, from its latest closed instance, with what it delivers (its `process.md`'s first line), its inputs and their sources, who brings files and who answers, and its open instances.
- **The report:** the agent's last message of a run is its report to the instance's people, logged as `report`; its first line is the run's summary in the ops log. The screen has no `summary` of its own.
- **Process and the review sheet** (prompt.md): `working/process.md` is the people's document, for a colleague who knows the business but not the scripts, whose first line says what the series delivers; and every instance has a review sheet, an output `review`, for whoever closes it: key figures against the previous instance with the reasons, the checks and where each looks, what was carried or assumed, the open points and each input's source. The agent asks about every call a reviewer might make differently, leading with its effect on the deliverable, after looking for an earlier answer.
- **What starts a run:** an upload, an answer or a comment from a person, or a new instance whose parent had inputs the agent made (files in `working/`), so the fetched inputs arrive at once; its `create` entry carries `fetch`; or a `wake` entry. Runs start 1.5 s after the last of a burst of uploads, so a multi-file drop starts one run. One run goes at a time per series, and at most `RF_MAX_RUNS` (20) at once, and none starts while less than `RF_MIN_FREE_GB` (6) of memory is free; the rest queue, and start as runs end or at the next minute's tick. [src/waker.ts](src/waker.ts) decides what runs when; [src/runner.ts](src/runner.ts) runs one.
  - **Wakes:** `rf wake TARGET AT REASON [--label LABEL]` sets one, TARGET being a folder as the run sees it, within its reach: an open instance, which the wake continues, as a reply does; or a series, which it starts a new instance of, labelled LABEL, run by whoever turned on Allow wakes, or else asks for on the page, as it does when 3 are open. A closed instance can't be woken: the answer says to wake its series with `--label <label>-r2` for a repair. Each target has one wake pending, in `.rf/wakes.json` (a new one replaces it), at least 15 minutes after its last; a clock checks them every minute, and overdue ones fire after a restart. A person's upload, answer or comment starts the run at once and cancels the instance's pending wake. Closing an instance wakes its series' later open instances, which may have used its draft.
  - **A restart doesn't wait for quiet:** at start, a run a restart cut is logged as ended with that error, and its instance is woken with "A restart cut your last run; carry on", so `just deploy` restarts at once.
  - **Cadence is the agent's:** a person starts a series' first instance; the agent sets its next period's wake before finishing, wakes its own instance for a late input, and wakes downstream series when its outputs are ready.
  - **During a run,** the same events reach the agent as a steer. Pi delivers it after the current turn's tool calls, and with steering mode `all`, everything queued by then arrives together.
  - **Events for another instance of the series** wait for the current run to end.
- **The cursor:** the runner records the highest log seq the agent has actually received, which it knows when Pi starts the user message that carried it. When a run settles and people's events lie above the cursor, another run starts at once. They can get there through a steer sent as the run ended, or one cleared by Interrupt. After an Interrupt, the next run waits for the next event.
- **What a run does:**
  - It places new uploads. Each becomes a new item, a replacement for an item's file, or a person's revision of an output. It records a replacement by repointing the item, and says so in a note.
  - It starts from the instance in its `create` entry's `from`, and checks the other open instances for answers and rules that apply to its own. The system gives an arrow of direction, and the agent needn't follow it strictly. A file it needs from another open instance it copies into its own `working/`, noting where it came from, so its copy is the stable reference.
  - It can add inputs of its own, such as a table extracted from an emailed PDF, as files in `working/`.
  - In an instance whose outputs people supplied, such as an example being imported, it rebuilds each output from the inputs with scripts in `working/`. It then notes, item by item, how much it reproduced and what it couldn't derive.
  - In a new instance, it builds the outputs the examples have, from this instance's inputs and, where the work rolls forward, the previous instance's outputs. It starts from the scripts of the most recently closed instance, and notes what's missing, what it assumed, and each value it carried rather than computed, with where it came from.
  - After an input changes, it rebuilds the outputs that used it, as new files, and notes what changed.
  - After a person revises an output, it compares their version with its own and rebuilds the outputs that depend on it. It asks whether the change is a one-off or a standing rule.
  - It draws the graph: a handful of steps, each in a small file it writes, even where earlier instances had none, and each item's `from`, as its scripts actually read them.
  - It puts each step and output on the screen when it's ready, and ends every run with `rf put` and a one-line summary.
- **The agent makes the call.** Nothing in the system checks or scores outputs. The agent decides whether its work is right, and writes checks as scripts in `working/` when it judges it needs them.
- **Answers carry over.** Close logs the default of every unanswered question as an answer. The next instance's agent applies the answers given after the previous instance's last run, and folds standing rules into `process.md`. Approvals to write don't carry over: one the previous instance never acted on is reported and asked again (decision 29).
- **Reads sources, never writes them.** People usually bring the files. When a person points the agent to a source instead, such as a database or a mailbox folder, the agent reads it, saves what it read in `working/` as the input's file with a `source`, and keeps the fetch as a script that later instances rerun. It reads the series folder, and writes only to its instance's `working/` and, through `rf`, its workspace.
  - People remain the executor: they post the entries and send the certificates. Nothing writes to outside systems (decision 42): a write the work needs, such as vouchers to enter in the ERP, is an output people take onward.
  - The run's sandbox enforces them (M3): it can't write elsewhere or reach any system but through the server.
- **History is the memory.** Rather than keep a standing script library, the agent copies and adapts the most recently closed instance's scripts. Each instance's `working/` is then a complete record of how its outputs were made. Nothing else is carried between instances.
- **One run at a time per series,** with a time limit (2 hours; `RF_LIMIT_MIN`).
- **Model:** one, set in the runner (`RF_MODEL`, default `openrouter/anthropic/claude-opus-5.5`, thinking `high`). Choosing a model per series comes later.

## Microsoft 365 logins

Each person connects their own Microsoft 365 from the Logins page ([src/auth.ts](src/auth.ts), [src/m365.ts](src/m365.ts), [src/graph.ts](src/graph.ts)): the sign-in app asks for delegated, read-only access (`Mail.Read`, `Mail.Read.Shared`, `Files.Read.All`, `Sites.Read.All`, `offline_access`), which an admin approves once for the company, and the server keeps the refresh token as the person's sealed login. It offers their own mailbox and OneDrive at first; they add shared mailboxes by address and SharePoint sites by a link, each checked by reading it as them. The app must be registered as a Web or public client: a Single-page application can't give the server a refresh token, so there it can't be connected.

- **The agent's reads** go through the instance's runner's login, as far as its ticks offer: `rf files list LINK|REF` (an item by its sharing link or a ref, with its parent's ref and, for a folder, its items), `rf files get LINK|REF FILE` (the runner's own OneDrive, or a ticked SharePoint site; never another person's OneDrive), `rf mail find [--mailbox ADDRESS] [--date] [--subject] [--from] [--attachments]` and `rf mail save ID [--mailbox ADDRESS] [--name REGEX] [--prefix TEXT]` (a ticked mailbox, the runner's own unless named). The agent never sees a message's body, and Microsoft's tokens never leave the server. Graph only ever gets GETs, so nothing here can change or delete a file or a message. Each call is logged as `files` or `mail`; a saved file never overwrites one in `working/` (the new one gets ` (2)`).
- **Renewal:** each use takes a fresh access token from the refresh token, which turns over and is sealed again; it lasts while it's used, up to about 90 days or what company policy allows. One Microsoft no longer renews marks the login expired, and the agent is told that its runner must sign in again.

## Skill use: skills

A skill says what to fetch or do, and how. Each is whole in a folder, which a publisher pushes with `rf skill push DIR` ([src/skills.ts](src/skills.ts)): every push is a version, `skills/versions/<id>/<n>/` in the data root, live at once through the link `skills/live/<id>`, and an earlier one comes back by pushing it again (`rf skill rollback ID N`). Each run's `run` entry names the versions it loaded. None ship with this repo, and a new one is a push, not a change to the server:

- `SKILL.md`, in Pi's format: front matter with `name` and `description`, which Pi puts in the agent's system prompt, then instructions the agent reads when it needs them;
- `skill.json`, rollforward's: `{"uses": [what of the runner's Microsoft 365 login it reads: "m365-mail", "m365-files"], "settings": [{"key", "label", "hint", "optional"}], "site": {"hosts": [...], "reads_that_post": [...]}}`, the last for a skill with a website, whose address is its `url` setting;
- what it runs: scripts the agent runs in its sandbox, which reach the server through the agent API (`RF_URL`, `RF_TOKEN`) and save into `RF_WORKING`, the instance's `working/`, and drive a skill's website through `rf browser`.

- **Settings are the admins',** set once with `rf skill set ID KEY VALUE` for every series (`.rf/skills.json`). None is a secret: every login is a person's own. The agent reads them with `rf settings ID`. `rf skill test ID` reads something real: one that reads Microsoft 365 reads, as the admin testing it, each link in its settings, and today's mail with its subject in their own mailbox.
- **A series chooses** its skills under Skill use (`series.json` `skills: [ids]`), possibly none, and possibly one not set up yet. A run loads only those (`--skill /skills/live/<id>` each, the data root's `skills/` being read-only at `/skills` in its sandbox, and `RF_SKILLS` `/skills/live`); its message lists them, how each is used and what each still needs (`rf skills` says the same). 
- **A skill's website** is a browser from the machines service ([src/machines.ts](src/machines.ts); a repo of its own, reached at `RF_MACHINES_URL` with `RF_MACHINES_KEY`): a throwaway container whose only way out is the service's proxy, which keeps to the site's hosts (its address's and `site.hosts`; a private address only through a host listed exactly), blocks every write (any request but GET, HEAD and OPTIONS) but the site's `reads_that_post` and while a person drives the live view, and logs each request.
  - **People sign in themselves** (Logins, Websites): a browser on the site's address with nothing saved, shown in the page through the server, which passes its live view's websockets on with the service's key and only to whoever started it; Save login seals its state as their login `web:<skill id>`, offering `web:<skill id>`. No password is stored.
  - **In a run,** `rf browser open SITE` opens a browser on a chosen skill's website from the runner's login to it, if ticked for the instance, and prints its CDP address, `ws://127.0.0.1:7000/browser/<token>/<id>`, which the sandbox's socket passes on to the service (see Runs in sandboxes); scripts connect with Playwright (`connect_over_cdp`, then `contexts[0]`). One per site, open until the run ends. A download's path is inside the browser's machine: `rf browser get SITE PATH FILE` saves it in `working/`. When the run ends each browser closes: its state, refreshed, is sealed again as the login (unless its person signed out meanwhile), and its request log goes to `browser/` and the log, as `browser`.
- **"Today"** for a skill's script is `--date`, else `RF_TODAY`, else today on the server; a test sets `RF_TODAY` to a day with data, and the server's start says so. A website shows what it holds now.
- **The skills** are each deployment's own, kept outside this repo: for example, a file from a OneDrive folder dated the day, the attachments of the day's mail with a given subject, or a vendor portal's payments as csv through its website.
- **Without the model:** `node --env-file=.env src/cli.ts DATA_ROOT try SKILL[,SKILL…] --as EMAIL -- COMMAND` runs a skill's script or `rf` command as a run with those skills would, as EMAIL with all their logins ticked, on a port of its own, with `working/` under `./try-output`; `… DATA_ROOT test SKILL --as EMAIL` is `rf skill test`.

## Harness: Pi over RPC

The runner, [src/runner.ts](src/runner.ts), drives Pi through Pi's `RpcClient`, which runs Pi as a child process and exchanges JSON lines with it:

    pi --mode rpc --provider openrouter --model anthropic/claude-opus-5.5 --thinking high \
      --no-extensions --no-skills --no-mcp --no-context-files --no-prompt-templates --skill /skills/live/<id> … \
      --tools read,bash,edit,write --append-system-prompt <app>/prompt.md \
      --session-dir "/work/<workspace>/<series>/<label>/session" --session-id main

- **Advanced's controls are Pi's own commands.** `prompt` starts a run, and `steer` delivers mid-run events. Interrupt is `clear_queue`, then `abort`.
- **Each run has its own Pi home,** in its sandbox's scratch: `settings.json` with `steeringMode` `all`, and `models.json`, which points the provider at the server's socket (see Runs in sandboxes). `PI_OFFLINE` keeps Pi from checking for updates.
- **One process per run.** The runner stops Pi at `agent_settled`, since RPC mode runs until its stdin closes. At the time limit, it aborts the run and stops Pi.
- **Sessions are found by working folder.** Pi reopens `main` only if the folder recorded in the session's first line is its working folder, so a run whose names changed since the last rewrites that line first.
- **Credentials:** the OpenRouter key, `OPENROUTER_API_KEY`, stays with the server, which adds it to each model request a run sends through its socket. A run whose server has none ends at once with that error. A Claude subscription won't do: it needs its auth extension loaded with `-e`.
- **Skills are the app's own:** `--skill` loads each skill the series chose under Skill use, and `--no-skills` keeps out the Pi skills of whoever runs the server. The agent's scripts reach a skill's files through `RF_SKILLS`. Nothing of the server's environment reaches a run.
- **Harness-specific code stays in one module,** the runner. `RpcClient` always starts `node`, found on the `PATH` it's given, so the runner puts [bin/sandbox](bin/sandbox) first, whose `node` starts Pi in the run's sandbox.
- **Not the AI SDK's `HarnessAgent`,** whose steering is experimental (`experimental_steerTurn`) and not supported by every adapter. **Not Docker Agent,** whose delegation isn't needed when agents talk through files. **Not Docker Sandboxes:** a microVM per run is more than one VM's 20–40 runs need, where bubblewrap does it in a process.

## Build order

The risk is whether an agent can learn a real deliverable from examples, so the agent comes first.

1. **M1, server and runner (built).** One Node process holds the store, the `rf` endpoint, the run queue and a JSON API for people's actions.
   - **Made-up series** ([demo/](demo/)): a generator makes a weekly borrowing base for a made-up housewares company: four example weeks, then five forward weeks with traps.
     - **08-09:** a wrong inventory file, replaced mid-run under a new name; the card receipts arriving late; a reviewer raising the availability block, answered as a standing rule that later weeks must apply.
     - **08-16:** people stop uploading the inventory and the lender's loan activity. A comment points the agent to a warehouse database and a mailbox folder. A new customer is billed in EUR, converted at the ECB reference rate, which the agent fetches from the ECB's data API.
     - **08-23:** created while 08-16 is still open, so only 08-16 shows where the sources are. The lender's email arrives late, and a comment asks for a refetch.
     - **A stray instance** is abandoned, so 08-30 must start from 08-23.
     - **08-30:** the warehouse snapshot is stale, and a lender email raises one customer's concentration limit for that week only.
     - **09-06:** open and empty in the image, for a person to drop the AR aging and card receipts into. The sources are the same; the loan email is dated Tuesday, as Monday 09-07 is Labor Day.

     A driver imports the examples one at a time, then stages each forward week only when the agent may see it. To test the build, it compares the agent's outputs with the generator's, and prints checks (ids, headlines, sources, citations, `process.md` size); that is test tooling, not part of the system.
   - **Environment:**
     - Node 26, which runs TypeScript directly, and `npm install`;
     - `uv venv .venv && uv pip install -r requirements.txt` (openpyxl, pandas, xlrd, extract-msg, defusedxml, requests, beautifulsoup4, lxml, matplotlib, pdfplumber, python-docx, python-calamine), with `.venv/bin` first on the agent's `PATH`;
     - LibreOffice, to recalculate scratch copies of formula workbooks.
     - Each series has its own `.pylib` on the agent's `PYTHONPATH`: Python packages the agent installs there with `pip install --target` stay with the series, in the data volume, and survive a new image.
     - The Docker image adds poppler, sqlite3, curl, git, jq, zip, CJK fonts, bubblewrap and socat.
2. **M2, the page (built):** [web/index.html](web/index.html), over the same server:
   - the graph, tiles, notes, ops log and Advanced, which reads the agent's work from the instance's Pi session file;
   - phone layout: Outputs come first, then the other tiles, each saying what it's made from instead of lines; notes open as a bottom sheet;
   - it polls every 4 seconds rather than streaming events;
   - uploads, answers, comments, Interrupt and Close as POSTs, refused when the browser marks them cross-site, so another web page can't talk to an agent;
   - file downloads: attachments with a sandboxing CSP (images inline), and only files whose real path stays inside the instance, so an agent's link can't expose the server's files;
   - who is who, from the sign-in (see M3).

   The demo can run behind `tailscale serve`, to try it from a phone.

   Then add a second series, such as a monthly rec whose day-2 GL listing arrives later.
3. **M3, hosting.** Sign-in, one workspace per client, sandboxes and backups.
   - **Sign in with Microsoft (built, [src/auth.ts](src/auth.ts)):** everything needs a session. Someone without one sees a page with a single Sign in with Microsoft button; nobody types an address or a code.
     - **Demo** (the default): the button leads to a picker of two fixed demo accounts, `admin@demo.test` (admin) and `bob@demo.test` (user), one click each. Anyone who reaches the site can be the demo admin, so keep a demo on localhost; the server warns otherwise.
     - **Microsoft** (once `RF_OIDC_ISSUER`, `RF_OIDC_CLIENT_ID` and `RF_PUBLIC_URL` are set for an app registered in Microsoft Entra ID): the same button goes to Microsoft, by the authorization code flow with PKCE, and back to the app's registered redirect, `RF_OIDC_REDIRECT_URI` (by default `RF_PUBLIC_URL/auth/callback`; it may be the site's root). How the code becomes an ID token follows how the app is registered:
       - a **Web** app with a client secret (`RF_OIDC_CLIENT_SECRET`), or a **public client** (Mobile and desktop) without one: the server redeems the code itself, with the secret if there is one and the PKCE verifier. It takes the token straight from Microsoft's token endpoint over TLS, so it doesn't check the signature (OpenID Connect Core 3.1.3.7);
       - a **Single-page application** (`RF_OIDC_SPA=1`): Microsoft lets only a browser redeem its codes, by a cross-origin request (AADSTS9002327 otherwise). The server answers the return with a page that redeems the code and posts the ID token to `/auth/token`; as the token has passed through the browser, the server checks its RS256 signature against Microsoft's published keys (`jwks_uri`).

       Either way the server checks the token's issuer, audience, expiry and nonce. Each sign-in in flight keeps its state in a cookie of its own, so sign-ins started in several tabs don't undo each other. Except on localhost, Microsoft takes only https redirects, so a site others reach needs an https address registered with the app. The first sign-in adds a person as a user unless `RF_AUTO_PROVISION=0`; `RF_ALLOWED_DOMAINS` limits who may, `RF_ADMINS` names admins, and a person's Microsoft id is pinned at their first sign-in.
     - A session is a cookie for 12 hours (`RF_SESSION_HOURS`), signed with `.rf/session.key` and the person's epoch, so Disable (and the CLI's signout) end it at once. People are managed with rf or with `node src/auth.ts DATA_ROOT list | add | role | disable | enable | signout | remove`. A run's environment is built from nothing, so it holds none of the server's.
   - **Workspaces' people (built):** every API call, file and preview is checked against the workspace's owners and members, by email or by an Entra group the person's ID token named at their last sign-in (once the app is set to send `groups`), and a workspace someone isn't in answers 404. A new workspace starts with whoever makes it as its owner, and a name in use is taken. Admins see and manage every workspace.
   - **Runs in sandboxes (built, [src/sandbox.ts](src/sandbox.ts), [src/runner.ts](src/runner.ts)):** each run's Pi is a bubblewrap sandbox, in a systemd scope of its own (`MemoryHigh` 4 GB, `MemoryMax` 8 GB, in `rollforward-runs.slice`; `RF_SANDBOX_SCOPE`, empty in the container image, where there is no systemd).
     - **What it sees:** the system, the app's code and the skills, read-only; under `/work/<workspace>/<series>/`, every instance in its reach by label, read-only but for its own instance's `working/` and `session/` and its series' `.pylib`; `RF_SANDBOX_RO`, read-only; and a HOME and /tmp of its own on scratch (`RF_SCRATCH`), deleted when the run ends. Never `.rf/`, the data root, a series or workspace outside its reach, or the server's environment.
     - **No network of its own.** Its one way out is the server's socket, `RF_SCRATCH/socket/rf.sock`, which socat offers at 127.0.0.1:7000 inside:
       - `/agent/…`, the agent API, with the run's token (`RF_URL`, `RF_TOKEN`), bound to one instance and gone when the run ends. The site no longer serves it;
       - `/model/<token>/…`, the model, with the key added on the way (`RF_MODEL_URL`, default OpenRouter's), so no key is inside;
       - `/browser/<token>/<id>`, the CDP websocket of a browser the run opened, passed to the machines service with its key;
       - `CONNECT`, an HTTPS proxy (`HTTPS_PROXY`) to package registries, GitHub and documentation sites, and the hosts in `.rf/egress.json`; never to a private address. Each host a run asks for is logged once, as `egress`, allowed or not.
     - **In a container,** bubblewrap needs podman's `--security-opt unmask=/proc/*` (Docker: `seccomp=unconfined` and `systempaths=unconfined`).

## Stack

- **TypeScript on Node,** with `node:http` and no framework or build step. The page will be one HTML file with plain JS. Pi's `RpcClient` is TypeScript, so the runner lives in the server.
- **Python** for the agent's own scripts, from `.venv`.

## Later (not in v0)

- Sort people's revisions into four kinds: input correction, one-off judgement, standing rule or agent bug. Standing rules then need an owner's approval; v0 only asks the person who made the change.
- When an input changes, show a redline of what moved in each output.
- A review copy of an output with the agent's notes as Excel comments. The deliverable itself never carries them.
- Per-user read state, and notifications by email or Teams.
- One series' output as another series' input.
- Deleting a wrong upload, such as another client's file, for real. In v0 the agent can only take it off the screen.
- **A super agent** (an end state, not yet tested with users). Like a finance system's super user, it can read every series and instance of a workspace. It makes no deliverables; it can only:
  - send a note to a series' agent, now or for its next instance;
  - alert a person, such as "someone else is doing X; cross-check with them."

  Its notes reach an instance as an event in that instance's log, signed "super", which starts or steers a run like any other. So agents talk only through the folders, and there's no messaging layer to build or audit.

## Decisions

1. **Name:** rollforward.
2. **Storage location:** on the host's disk.
3. **Agent's reach:** its own series, with all of that series' instances. A workspace-wide super agent comes later. (Since 34, its workspace and the workspaces that have all its people.)
4. **Closing:** an explicit "Close instance".
5. **Stack:** TypeScript on Node.
6. **Model access:** through OpenRouter.
7. **Harness:** Pi over RPC.
8. **Mid-run drops** join the current run by steering, with the steering mode `all`.
9. **Files only:** the main screen has no typing or prompting, and doesn't show the agent at work. Inputs and outputs are file tiles that show whether a person or the agent made them. Notes are pinned to files, people can upload on both sides, and a new series is set up by dropping past inputs and outputs.
10. **Ops log and Advanced** are separate from the graph. Advanced shows the agent's work, can interrupt, and expands over the graph rather than replacing it.
11. **Storage:**
    - `upload/` holds people's files, which nobody ever moves or changes; a repeated name gets `_2`.
    - `working/` is the agent's.
    - The screen, `workspace.json`, maps items to files, with notes. The server and the agent both write it.
    - The log records every event, and only the server writes it. The agent reads it to see what changed.
    - A replacement is the agent repointing an item.
12. **Names:** unit becomes **series**, and cycle becomes **instance**. Instances have labels rather than periods. They sort alphabetically, and by default only open ones show.
13. **Agent-made inputs:** the agent can create inputs too, as files in `working/`.
14. **Not files:** the screen and the log needn't be files the agent edits; any sync method will do, as long as who owns what stays the same.
15. **Review, then build:** two Opus 5.5 agents review the plan, the second validating the first, and then M1 is built.
16. **No pass bars or automatic checks** (15 Oct): agents make the call, and build checks as scripts if they need them. The product isn't aimed at finance, and shouldn't be over-explained.
17. **Key and additional inputs; evidence and working** (15 Oct). See Concepts.
18. **Direction** (15 Oct): each instance records its parent (`from`). The agent starts there and checks the open instances; no stricter rules.
19. **Sources** (15 Oct): the agent may read the sources people point it to, and never writes to them. Skills (29) let it write, one approved write at a time.
20. **Two end states** (15 Oct): Close or Abandon.
21. **Series visibility** (15 Oct): one way, granted by the publishing series, read-only for the reader; one workspace for now. People's roles per series (owner, member, visitor) come later.
22. **Duplicate and series settings** (15 Oct): a closed or abandoned instance can be duplicated into an open one. Each series has settings, for now its name and its visibility to other series.
23. **A TOTP gate for an early public demo** (16 Oct; replaced by 26): codes from an authenticator app rather than a password, since codes expire and an enrolled phone is hard to pass on. One secret per person, set up from a one-time link, so one person can be revoked. Microsoft sign-in through oauth2-proxy was dropped then, since the tenant's admin would have to consent.
24. **Workspaces** (16 Oct): the top-level folder is a workspace, such as a client's. The sidebar cascades workspace, series and instance, with each row's actions in its corner rather than as rows of their own. A workspace or a series can be archived, which hides it until it's restored; nothing in it changes, and its runs carry on.

25. **The graph** (17 Oct): the screen shows the process as a graph of inputs, steps and outputs, with Outputs in their own column so they never scroll away. What each item is made from is a hint for people: nothing runs it, and the agent needn't follow it. Drops are hints too, and the page doesn't show `process.md`, which points at the agent's scripts.
26. **Sign in with Microsoft, and workspaces per person** (20 Oct): one button, and people type nothing. Until the organisation registers an app in Entra ID, the button leads to two fixed demo accounts; once it's configured, the same button goes to Microsoft. The server runs the sign-in itself rather than through a proxy, so it knows who is who for ownership and the log. Each workspace has one owner; others don't see it; admins see and manage everything.
27. **Tool use through a browser** (20 Oct; replaced by 32): a series picks company systems, such as the ERP and two internal systems, from a catalog the admins keep, and its agent uses them in a browser the server runs, as a shared service account whose password stays with the server. Reading is free; each write waits for a person, who sees its steps and a screenshot, and the server makes it. Those three are built in, so a series can choose them, or none, before they're set up.
28. **Sign in with the app as the organisation registered it** (21 Oct): the company's Entra app has no client secret and registers the site's root as a Single-page application redirect. Rather than ask for a different registration, the server takes the redirect as given and lets the browser redeem the code, checking the token's signature itself.
29. **Skills** (22 Oct; which skills a run loads changed by 31): every run loads the skills in `skills/`, for every series. The first reaches the ERP through a separate automation service with an HTTP API: it downloads attachments, exports ledgers and enters vouchers. For those the agent uses it rather than the browser of Tool use (27), which covers the rest of the ERP. What a skill fetches is handled like any fetched file. Each write needs its own approval on the screen: the agent dry-runs, shows what it would write, and asks a question whose default writes nothing; it writes only once a person, not the server, picks the option that writes in that instance, and an approval never becomes a standing rule. That rests on the instructions and on the service's own switch (writes allowed only in a test environment) until the server gates a skill's writes as it does Tool use's (27). Meanwhile the agent holds the service's API key, unlike Tool use's password, which stays with the server; the sandbox (M3) has to keep the key out of the agent's reach the same way.
30. **Tools for fixed fetches** (22 Oct; replaced by 31): inputs that come by the same steps every time (OneDrive files, a mail's attachment, vendor portals behind emailed codes) are named tools the server runs with credentials admins keep under Systems, rather than steps the agent clicks through. They only read, they cost no model time, and the same steps give the same file. Microsoft 365 is reached as an app with its own permissions, and the code only reads, whatever those permissions allow.
31. **Connections and skills apart** (23 Oct; replaced by 32): Tool use holds connections, how to reach a system and the credentials for it; Skill use holds skills, what to fetch or do and how, each with the series' own settings. Connections give the agent a few general reads (files, mail, a signed-in browser) and keep every secret in the server; skills are folders in Pi's format that use them, so a new fetch is a skill, not a change to the server, and a series loads only the skills it chose. A portal's steps are a flow in its skill, which the server runs in the connection's browser: as fixed and cheap as code in the server, but kept with the skill, and still unable to write, as its few reads that post are named in the file.
32. **Skills, set up once** (23 Oct): a series chooses only skills; admins set each skill up once, under Skills, for every series, as people saw a series' own copy of the same links as repetition. A skill with a website, such as a vendor portal, holds that site whole, as the ERP's skill holds its service: its account in its settings (the password sealed), its hosts, its flows and its own sign-in, so a new portal is a skill, not a change to the server. Only the Microsoft 365 apps stay shared connections, under Systems, used by the skills that say so. The agent's own browsing of those systems, with its writes held for approval (27), is gone for now: the ERP goes through its skill. One portal's skill reads the export people put on OneDrive each day, as its site stopped mailing sign-in codes.
33. **Runs in bubblewrap sandboxes** (2 Nov): rather than Docker Sandboxes' microVMs, each run is a bubblewrap sandbox in a cgroup of its own, with no network but the server's socket: the agent API, the model with its key added on the way, and a proxy to an allowlist broad enough to install packages and read documentation (pypi, npm, GitHub, docs sites, `.rf/egress.json`), never a private address. No key, no `.rf/` and no other workspace is inside. The site no longer serves the agent API. [docs/redesign.md](docs/redesign.md) holds the rest of the round agreed that day.
34. **Members and owners; reach** (2 Nov; replaces 21 and 26's one owner): the workspace is the only unit of sharing, with members, who see and work in all of it, and owners, who also manage who is in it, each a person or an Entra group. There's no read-only role. Series visibility goes: an agent reads its whole workspace, and any workspace that has everyone its own has, so reading never widens who sees what.
35. **Folders by id** (2 Nov): instances sit flat under `instances/<id>/` and series under `series/<id>/`, with names in `instance.json` and `.rf/tree.json`, so renames and moves edit one small file at any time and links use ids. Each run gets the data by name, as a tree of its own built when it starts. Notes' cited files stay label paths within the series for now.
36. **Wakes, not schedules** (2 Nov): runs start from people's acts and from wakes the agents set, `rf wake`, never from a schedule; a series' Allow wakes names who runs what a wake starts, and without it a wake becomes a request on the page. Up to three instances of a series are open at once, closing one wakes the later ones, and each workspace has an Ad hoc series for one-off asks, which Make it a series turns into a series. At most 20 runs go at once.
37. **Personal logins and runners** (2 Nov): each login is one person's, sealed, and ticked per instance by its runner; nobody's login serves another's run, and none is attached to a series or a workspace. Only the runner closes, which signs the instance off; taking over is logged. Microsoft 365 and websites become logins of this kind (docs/redesign.md, Logins).
38. **Microsoft 365 as personal logins** (2 Nov; replaces 30–32's shared M365 apps): each person connects their own read-only, delegated Microsoft 365 login, through the sign-in app, and offers runs their mailboxes, OneDrive and SharePoint sites; a run reads only its runner's, as ticked. Systems, the admins' M365 apps with client secrets reading one mailbox, is gone, and so are sign-in codes read from mail.
39. **Guidance, the catalogue and the report** (2 Nov): what a run knows beyond its series comes from the company's and its workspace's guidance and a catalogue of its reach, all files in its view, rather than from rules in the server; and the agent's last message is its report, which replaces the screen's `summary`.
40. **Talking is in threads** (2 Nov): people comment, on an item or the instance, and the agent replies in the thread with `rf say`; Advanced's Steer and `rf reply` are gone, so there is one place to talk and every exchange stays where it applies.
41. **Admin is rf; skills are pushed data** (3 Nov): people's rf, with personal tokens, does what the page does, and is the only place to manage people, skills' settings and the company's guidance, so the page stays simple and gives admins visibility, not controls. Skills are pushed by publishers as versions in the data root, live at once and rolled back by pushing again; `RF_SKILLS_DIR` is gone.
42. **Nothing writes outside** (3 Nov; reverses 29's approved writes): every output is a file people take onward, and skills, websites and mailboxes are only read, so no approval on the screen can make an agent change another system.
43. **Website logins through the machines service** (3 Nov; replaces 32's website accounts and flows): people sign in to a website themselves, in a live browser on the Logins page, and that browser's state is their login; a run's scripts drive a browser of their own, from the runner's login, with `rf browser open`, rather than the server signing in with a shared account and taking a flow's fixed steps. The browser runs in the machines service, whose proxy keeps to the site, blocks writes and logs every request, so the server holds no browser and no password.

## Proposed by the agent (open to change)

1. People answer questions by clicking an option. If none fits, they fix the file and drop it back.
2. A drop is a hint: the server adds each upload as a new item at once, and the agent decides what it is.
3. If an item points at a person's upload, the agent repoints it to its own file only by asking first.
4. A person's revision starts a run that rebuilds the outputs that depend on it.
5. Notes stay out of the deliverable.
6. The agent changes the screen through `rf`, which rejects a stale or invalid put (decision 14).
7. A file the screen has shown is read-only, and the log keeps its hash.
8. The ops log is a side panel.
9. There is one Pi session per instance.
10. A series' name is its folder name. (Since 35, folders are named by id.)
11. A new instance starts from the most recently closed instance, by close time rather than label order.
12. The colour code: blue for what a person put in, black for what the agent made, red for notes ([docs/design.md](docs/design.md)).
13. The runner's cursor: events the agent never received start another run when the current one settles, except after an Interrupt.
14. Close logs each unanswered question's default as an answer, and the next instance applies it.
15. Past instances are imported one at a time, in label order.
16. In v0, the red dot is per browser, and the log has no read events.
17. A step is an intermediate result in a file, rather than an operation, so every tile opens in Preview and a dashed tile always means not there yet.
