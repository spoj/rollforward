# rollforward: recurring tasks, files in and files out

`src/` holds the server, the store, the runner and `rf`, `web/` the page, `skills/` the skills series choose from, and `demo/` a made-up weekly series to test them with. [docs/design.md](docs/design.md) holds the design notes for the page.

- **What this is:** a small web platform for recurring tasks. People drop in input files, and an agent produces the output files, having learned how from earlier instances. People move files; they don't type prompts.

## Concepts

- **People:** everyone signs in with a Microsoft account, by pressing Sign in with Microsoft. A person is a **user** or an **admin**.
- **Workspace:** a top-level folder of series, such as one client's or one team's. It has one **owner**: only the owner and admins see it, its series and their files. A workspace with no owner is the admins'. No run sees another workspace's files (its sandbox holds only its series and the series it may read).
- **Series:** a recurring transform, such as "Weekly borrowing base": each instance's input files become its output files. The folder name is the series' name. What an instance should contain comes from earlier instances, not from a declaration.
- **Skill:** what the agent knows how to fetch or do, and how, whole in a folder: such as the day's AR aging from OneDrive, or a customer's payments from its vendor portal. Admins set each up once, under Skills, with its links and, for a website, its account.
- **Skill use:** the skills a series' agent may use. A skill writes to a system only what a person approves on the screen.
- **Connection:** a Microsoft 365 app (M365 Mail, M365 OneDrive) that skills read through, kept by admins under Systems. Series don't choose these; their skills say what they use.
- **Visibility:** a series can make itself visible to other series of the workspace, or to all of them. Their agents may then read it, never write it, and copy into their own `working/` what they rely on. Visibility is one way, and only the publishing series grants it.
- **Archive:** a workspace or a series that's no longer in use can be archived. It leaves the sidebar, except under "Show archived", until it's restored, and nothing in it changes. It isn't transitive, but what a reader copies can flow on.
- **Instance:** one pass through a series, under a label people choose, such as "2026-08-24" or "Larkfield refinancing". Instances needn't be periods. They sort alphabetically by label, and only open ones show by default.
- **Item:** one tile on an instance's screen. It has a stable id, a display name and a kind: input, step or output. A **step** is an intermediate result a reviewer would check, such as "Eligible AR", in a file the agent writes. An item also has the file it currently shows, the items it's made from (`from`), and its notes. Replacing a file means pointing the item at a new file.
- **Graph:** the items, joined by what each is made from. It's a picture for people: nothing runs it, and the agent's scripts needn't follow it.
- **Example:** a closed instance. Its input items and output items are one example pair. The agent learns the transform from these pairs, and writes it down as scripts and notes in `working/`.
- **Run:** one stretch of agent work on an instance, started by an upload, an answer or a Steer. Runs are internal; the ops log and Advanced show them.
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
- **Ops log:** a side panel listing who did what, when: uploads, runs, every change the screen showed, answers, steers, the agent's replies and the close. Earlier files open from here.
- **Preview** shows a spreadsheet with its noted cells marked. If the file replaced an earlier one, "Compare with previous" highlights the cells that changed, and a click shows the old value.
- **Advanced:** a bar along the bottom that expands over the graph, like VS Code's terminal panel.
  - It shows what the agent does, like Claude Code: each run starts with what triggered it, plus its time and cost. The agent's messages read as text, and each tool call is one line with a short result. Consecutive calls fold into a summary such as "Read 3 files, ran 2 commands". Each call expands to its full output, and failures are red. During a run it is live. Past runs are read from the instance's Pi session file.
  - It is the only place to type. **Steer** sends the agent a message, and starts a run if none is going. **Interrupt** stops the run. The agent answers a question with `rf reply`, which shows in the ops log and here, never as a note.
- **New series:** give it a name. Then import past instances one at a time, in label order: create the instance, drop its inputs on the left and what was actually sent on the right, let the agent rebuild each output and note what it can't derive, and close it.
- **New instance:** give it a label. It starts with the graph of the most recently closed instance, as dashed tiles.
- **Close instance:** freezes the instance as an example. Unanswered questions take their defaults, and the dialog lists which. It is disabled while a run is going.
- **Abandon:** the other way an instance ends. It stays as it is, but it isn't an example, never becomes a new instance's starting point, and applies no defaults. It is also disabled while a run is going. Closed and abandoned instances both show under "Show closed".
- **Duplicate:** a closed or abandoned instance can be copied, under a new label, into an open instance. The copy has its files, screen and log, but not its agent session, and its log records the copy as `duplicate`.
- **Rename:** an open instance's label changes from the pencil by its title, between runs. The log records `rename`.
- **Series settings:** the series' name, its Skill use (the skills its agent may use, each saying if it is not set up yet), its visibility (the other series that can see it) and Archive. Visibility shows All series with the workspace's other series folded under it: ticking All series ticks them all and saves `*`, which takes in series made later too; ticking some saves those alone, and All series shows half-ticked. Renaming moves the series folder, and waits until no run is going. **Workspace settings** hold the owner (admins only) and Archive. An archived workspace or series is restored from its settings, under "Show archived".
- **Users** (admins): who can sign in, their role, their workspaces and when they last signed in; Add, Disable (which also signs them out everywhere; Enable lets them back) and Remove.
- **Systems** (admins): the two Microsoft 365 connections, each with whether it is ready: its tenant id, client id, client secret (write-only) and settings, such as the one mailbox it reads. It may be saved part done. Test reads its mailbox or a test folder; Clear takes it back to not set up.
- **Skills** (admins): every skill, with the connections it uses and whether it is ready; Set up or Edit shows its settings from its `skill.json`, a password as write-only. Test checks it for real: a website skill signs in, code and all; one that reads OneDrive or mail reads its links or today's mail.
- **Names:** the log records each person by the email they signed in with. The sidebar's foot shows who is signed in, with Sign out.

## Storage

Workspaces are folders on the host's disk. There is no database.

    .rf/                      the server's own: users.json, workspaces.json (each workspace's owner), systems.json
                              (service passwords sealed with AES-256-GCM), and the keys session.key and systems.key
    <workspace>/              e.g. "Larkfield"
      .archived               there while the workspace is archived, set by people through the server
      <series>/               e.g. "Weekly borrowing base"; moved only by a rename in Series settings
        series.json           {"visible_to": [series names, or "*"], "tools": [system ids]}, set by people through the server, read-only
        .archived             there while the series is archived
        <label>/              an instance: a folder holding workspace.json, made by New instance
          upload/             people's files, as uploaded, read-only
          working/            the agent's area: scripts, process.md, drafts, outputs and its own inputs
          workspace.json      the instance's screen, saved by the server, read-only
          log.jsonl           everything that happened in the instance, written by the server
          session/            the instance's Pi session, shown in Advanced
          calls/              writes the agent proposed: the page it started from (<id>.png) and the outcome (<id>.result.png), by the server

- **The server holds each instance's screen and log.** They needn't be files, but who owns what stays the same. The server saves the screen to `workspace.json` (a temporary file renamed into place, read-only) and appends each event to `log.jsonl`. Closed instances therefore stay plain folders.
- **Who writes what:**
  - People upload, answer, steer, interrupt and close, all through the server.
  - The server adds each upload as an item at once, creates and closes instances, and is the only writer of the log.
  - The agent decides the items and the notes. It changes them only through `rf`, and reads `log.jsonl` directly.
- **`upload/` belongs to people.** Nobody moves, renames or changes these files. Each streams, as it arrives, to a temporary file in the data root's `.tmp/`, which the server empties when it starts; it is then renamed into place and made read-only. An upload may take up to an hour, and is refused if its instance closed or moved meanwhile. A repeated name becomes `<stem>_<n><ext>`, with the lowest free n. Names and labels have `/`, `\` and control characters replaced, and may not start with `.`.
- **`working/` belongs to the agent,** which may do anything there with one limit. A file the screen has shown never changes again: the server makes it read-only and logs its hash, so a new version gets a new name.
- **`rf`** is a small command on the agent's `PATH`:
  - `rf show` prints the screen, `workspace.json`, including its `rev`, which the server bumps on every change.
  - `rf reply TEXT` answers a person's question; the server logs it as `reply`.
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
      "summary": "Rebuilt the borrowing base from Sam's review.",   // the agent's line for the ops log, each run
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

**`log.jsonl`** has one line per event. `seq` orders the lines, and `by` is a person's name, "server" or "agent". The ops are `create`, `upload`, `point`, `item`, `note`, `unnote`, `remove`, `run`, `done`, `answer`, `steer`, `interrupt`, `close`, `abandon`, `duplicate`, `rename`, `reply`, and for skills `files` and `mail` (a read through Microsoft 365) and `flow` (a skill's flow in its website, with the files it saved). Instances from before decision 32 may also hold Tool use's `browse`, `request`, `approve`, `reject` and `call`, which the page still shows. `done` carries the run's model cost in USD. Here `point` means an item now shows a file:

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

- **One session per instance.** The server runs Pi in the series folder with the instructions in [prompt.md](prompt.md). Each run is one prompt into the instance's session, so within an instance the agent remembers its earlier runs. A new instance starts a new session, so whatever the next instance needs must be in the files.
- **Messages:** every prompt and steer reads `Instance <label> (folder <label>/), run <n>. New log entries:`, followed by the log lines, as JSON, that the agent hasn't been sent. The agent's own lines are left out.
- **What starts a run:** an upload, an answer, a Steer, or an approval or rejection of a proposed write from a person, or a new instance whose parent had inputs the agent made (files in `working/`), so the fetched inputs arrive at once; its `create` entry carries `fetch`. Runs start 1.5 s after the last of a burst of uploads, so a multi-file drop starts one run.
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
  - People remain the executor: they post the entries and send the certificates. Skills are the exception: a skill writes to a system only what a person approves on the screen (decision 29), and a skill's website takes no write at all (see Skill use).
  - The run's sandbox enforces them (M3): it can't write elsewhere or reach any system but through the server.
- **History is the memory.** Rather than keep a standing script library, the agent copies and adapts the most recently closed instance's scripts. Each instance's `working/` is then a complete record of how its outputs were made. Nothing else is carried between instances.
- **One run at a time per series,** with a time limit (2 hours; `RF_LIMIT_MIN`).
- **Model:** one, set in the runner (`RF_MODEL`, default `openrouter/anthropic/claude-opus-5.5`, thinking `high`). Choosing a model per series comes later.

## Connections: Microsoft 365

Two connections are shared by every skill that reads through them, kept by admins under Systems ([src/systems.ts](src/systems.ts)): **M365 Mail** and **M365 OneDrive**, each an app registered in Entra ID (tenant id, client id, client secret) that reads through Microsoft Graph as itself (client credentials), with its settings: M365 Mail the one mailbox it reads, M365 OneDrive a test link. Secrets are sealed in `.rf/systems.json`, and pages show only whether one is saved. Company values (ids, mailboxes) live there too, set from the Systems page, never in the code. Series don't choose connections: a series chooses skills, and the skills say which connections they use.

- **The agent's reads** ([src/m365.ts](src/m365.ts), [src/graph.ts](src/graph.ts)), allowed only if one of the series' skills uses the connection: `rf files list LINK|REF` (an item by its sharing link or a ref, with its parent's ref and, for a folder, its items), `rf files get LINK|REF FILE`, `rf mail find [--date] [--subject] [--from] [--attachments]` and `rf mail save ID [--name REGEX] [--prefix TEXT]`. Mail is the connection's one mailbox, and the agent never sees a message's body. Graph only ever gets GETs, whatever the app's permissions allow, so nothing here can change or delete a file or a message. Each call is logged as `files` or `mail`; a saved file never overwrites one in `working/` (the new one gets ` (2)`).
- **Sign-in codes:** a site that mails a code at sign-in has it read from the mailbox of the m365 connection in the skill's `otp_mail` setting (M365 Mail if unset): the newest from the site's sender since the request, never one already used, waiting 25 seconds and then pressing the site's resend, three times at most ([src/signin.ts](src/signin.ts)).

## Skill use: skills

A skill says what to fetch or do, and how. Each is whole in a folder `<id>/` under the deployment's `RF_SKILLS_DIR` ([src/skills.ts](src/skills.ts)); none ship with this repo, and a new one is a folder, not a change to the server:

- `SKILL.md`, in Pi's format: front matter with `name` and `description`, which Pi puts in the agent's system prompt, then instructions the agent reads when it needs them;
- `skill.json`, rollforward's: `{"uses": [the connections it reads through], "settings": [{"key", "label", "hint", "optional", "secret"}], "site": {"hosts": [...]}}`, the last for a skill with a website of its own;
- what it runs: scripts the agent runs in its sandbox, which reach the server through the agent API (`RF_URL`, `RF_TOKEN`) and save into `RF_WORKING`, the instance's `working/`; flows (`*.flow.json`), fixed steps the server takes in the skill's website; and, for a site whose sign-in is more than a name and a password, `signin.ts`, the server's steps to sign in.

- **Settings are the admins',** set once under Skills for every series (`.rf/skills.json`). A `secret` setting, such as a website's password, is sealed and never shown again, only whether one is saved; left empty, it keeps the one saved. The agent reads the rest with `rf settings ID`. Test on each row reads something real: a website skill signs in, code and all; one that reads through Microsoft 365 reads each link in its settings, and today's mail with its subject.
- **A series chooses** its skills under Skill use (`series.json` `skills: [ids]`), possibly none, and possibly one not set up yet. A run loads only those (`--skill skills/<id>` each); its message lists them, how each is used and what each still needs (`rf skills` says the same). One saved with Tool use or its own skill settings keeps its choice of skills, the rest being the admins' now.
- **A skill's website** is a browser the server runs ([src/browser.ts](src/browser.ts)), one context per run and skill, closed when the run ends, with an ordinary Chrome user agent (some portals turn headless Chrome's away). The server signs in with the account in the skill's settings, by the skill's `signin.ts` or else by filling the sign-in form (the password field, the field before it and Enter), so the password never reaches the agent. The context reaches only the site's address and its `site.hosts`, and stops every request that is a write (any but GET, HEAD and OPTIONS) unless the flow running names it.
- **Flows** ([src/flow.ts](src/flow.ts)): `rf flow SKILL/FLOW [--var NAME=VALUE …]` runs one of a chosen skill's flows, so the same steps give the same file and the agent spends no model time clicking. Steps: `goto`, `reload`, `click`, `fill`, `press`, `pause`, `wait` (a target, any of several, or a selector gone), `stop_if`, `expect` and `download`; targets are text, a role and name, or CSS, visible ones only. `{name}` comes from `--var`, then the skill's settings but its secrets, and `{today}`. A site that reads with a POST (a sign-in's token exchange, single sign-on) has those named in the flow's `reads_that_post`, let through only while it runs. A site that asks for a sign-in code again is answered after each step. The agent can't write a flow of its own, nor click through a site itself. Each run is logged as `flow` with its files; a failure names the step and leaves a screenshot in `working/`.
- **"Today"** for a skill's script is `--date`, else `RF_TODAY`, else today on the server; a test sets `RF_TODAY` to a day with data, and the server's start says so. A website shows what it holds now, so flows ignore it.
- **The skills** are each deployment's own, kept outside this repo: for example, a file from a OneDrive folder dated the day, the attachments of the day's mail with a given subject, or a vendor portal's payments as csv through its flows.
- **Without the model:** `node --env-file=.env src/cli.ts DATA_ROOT try SKILL[,SKILL…] -- COMMAND` runs a skill's script or `rf` command as a run with those skills would, against the real connections, on a port of its own, with `working/` under `./try-output`; `… DATA_ROOT test SKILL|CONNECTION` is the Test of the Skills or Systems page.

## Harness: Pi over RPC

The runner, [src/runner.ts](src/runner.ts), drives Pi through Pi's `RpcClient`, which runs Pi as a child process and exchanges JSON lines with it:

    pi --mode rpc --provider openrouter --model anthropic/claude-opus-5.5 --thinking high \
      --no-extensions --no-skills --no-mcp --no-context-files --no-prompt-templates --skill <app>/skills/<id> … \
      --tools read,bash,edit,write --append-system-prompt <app>/prompt.md \
      --session-dir "<label>/session" --session-id main

- **Advanced's controls are Pi's own commands.** `prompt` starts a run, and `steer` delivers mid-run events and Advanced's Steer. Interrupt is `clear_queue`, then `abort`.
- **Each run has its own Pi home,** in its sandbox's scratch: `settings.json` with `steeringMode` `all`, and `models.json`, which points the provider at the server's socket (see Runs in sandboxes). `PI_OFFLINE` keeps Pi from checking for updates.
- **One process per run.** The runner stops Pi at `agent_settled`, since RPC mode runs until its stdin closes. At the time limit, it aborts the run and stops Pi.
- **Sessions are found by working folder.** Pi reopens `main` only if the folder recorded in the session's first line is the series folder, so a series rename rewrites that line in every session of the series.
- **Credentials:** the OpenRouter key, `OPENROUTER_API_KEY`, stays with the server, which adds it to each model request a run sends through its socket. A run whose server has none ends at once with that error. A Claude subscription won't do: it needs its auth extension loaded with `-e`.
- **Skills are the app's own:** `--skill` loads each skill the series chose under Skill use, and `--no-skills` keeps out the Pi skills of whoever runs the server. The agent's scripts reach a skill's files through `RF_SKILLS`. Nothing of the server's environment reaches a run.
- **Harness-specific code stays in one module,** the runner. `RpcClient` always starts `node`, found on the `PATH` it's given, so the runner puts [bin/sandbox](bin/sandbox) first, whose `node` starts Pi in the run's sandbox.
- **Not the AI SDK's `HarnessAgent`,** whose steering is experimental (`experimental_steerTurn`) and not supported by every adapter. **Not Docker Agent,** whose delegation isn't needed when agents talk through files. **Not Docker Sandboxes:** a microVM per run is more than one VM's 20–40 runs need, where bubblewrap does it in a process.

## Build order

The risk is whether an agent can learn a real deliverable from examples, so the agent comes first.

1. **M1, server and runner (built).** One Node process holds the store, the `rf` endpoint, the run queue and a JSON API for people's actions.
   - **Made-up series** ([demo/](demo/)): a generator makes a weekly borrowing base for a made-up housewares company: four example weeks, then five forward weeks with traps.
     - **08-09:** a wrong inventory file, replaced mid-run under a new name; the card receipts arriving late; a reviewer raising the availability block, answered as a standing rule that later weeks must apply.
     - **08-16:** people stop uploading the inventory and the lender's loan activity. A Steer points the agent to a warehouse database and a mailbox folder. A new customer is billed in EUR, converted at the ECB reference rate, which the agent fetches from the ECB's data API.
     - **08-23:** created while 08-16 is still open, so only 08-16 shows where the sources are. The lender's email arrives late, and a Steer asks for a refetch.
     - **A stray instance** is abandoned, so 08-30 must start from 08-23.
     - **08-30:** the warehouse snapshot is stale, and a lender email raises one customer's concentration limit for that week only.
     - **09-06:** open and empty in the image, for a person to drop the AR aging and card receipts into. The sources are the same; the loan email is dated Tuesday, as Monday 09-07 is Labor Day.

     A driver imports the examples one at a time, then stages each forward week only when the agent may see it. To test the build, it compares the agent's outputs with the generator's, and prints checks (ids, headlines, sources, citations, `process.md` size); that is test tooling, not part of the system.
   - **Environment:**
     - Node 26, which runs TypeScript directly, and `npm install`;
     - `uv venv .venv && uv pip install -r requirements.txt` (openpyxl, pandas, xlrd, extract-msg, defusedxml, requests, beautifulsoup4, lxml, matplotlib, pdfplumber, python-docx), with `.venv/bin` first on the agent's `PATH`;
     - LibreOffice, to recalculate scratch copies of formula workbooks.
     - Each series has its own `.pylib` on the agent's `PYTHONPATH`: Python packages the agent installs there with `pip install --target` stay with the series, in the data volume, and survive a new image.
     - The Docker image adds poppler, sqlite3, curl, git, jq, zip, CJK fonts, bubblewrap and socat.
2. **M2, the page (built):** [web/index.html](web/index.html), over the same server:
   - the graph, tiles, notes, ops log and Advanced, which reads the agent's work from the instance's Pi session file;
   - phone layout: Outputs come first, then the other tiles, each saying what it's made from instead of lines; notes open as a bottom sheet;
   - it polls every 4 seconds rather than streaming events;
   - uploads, answers, Steer, Interrupt and Close as POSTs, refused when the browser marks them cross-site, so another web page can't steer an agent;
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
     - A session is a cookie for 12 hours (`RF_SESSION_HOURS`), signed with `.rf/session.key` and the person's epoch, so Disable (and the CLI's signout) end it at once. People are managed on the Users page or with `node src/auth.ts DATA_ROOT list | add | role | disable | enable | signout | remove`. The agent's environment gets a blank `RF_OIDC_CLIENT_SECRET`.
   - **Workspaces per person (built):** every API call, file and preview is checked against the workspace's owner, and a workspace someone else owns answers 404. A new workspace belongs to whoever makes it, and a name another person uses is taken. Admins see every workspace and give one to someone from its settings.
   - **Runs in sandboxes (built, [src/sandbox.ts](src/sandbox.ts), [src/runner.ts](src/runner.ts)):** each run's Pi is a bubblewrap sandbox, in a systemd scope of its own (`MemoryHigh` 4 GB, `MemoryMax` 8 GB, in `rollforward-runs.slice`; `RF_SANDBOX_SCOPE`, empty in the container image, where there is no systemd).
     - **What it sees:** the system, the app and the skills, read-only; its series read-only but for the instance's `working/` and `session/` and the series' `.pylib`; the series it may read, and `RF_SANDBOX_RO`, read-only; and a HOME and /tmp of its own on scratch (`RF_SCRATCH`), deleted when the run ends. Never `.rf/`, another series or workspace, or the server's environment.
     - **No network of its own.** Its one way out is the server's socket, `RF_SCRATCH/socket/rf.sock`, which socat offers at 127.0.0.1:7000 inside:
       - `/agent/…`, the agent API, with the run's token (`RF_URL`, `RF_TOKEN`), bound to one instance and gone when the run ends. The site no longer serves it;
       - `/model/<token>/…`, the model, with the key added on the way (`RF_MODEL_URL`, default OpenRouter's), so no key is inside;
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
3. **Agent's reach:** its own series, with all of that series' instances. A workspace-wide super agent comes later.
4. **Closing:** an explicit "Close instance".
5. **Stack:** TypeScript on Node.
6. **Model access:** through OpenRouter.
7. **Harness:** Pi over RPC.
8. **Mid-run drops** join the current run by steering, with the steering mode `all`.
9. **Files only:** the main screen has no typing or prompting, and doesn't show the agent at work. Inputs and outputs are file tiles that show whether a person or the agent made them. Notes are pinned to files, people can upload on both sides, and a new series is set up by dropping past inputs and outputs.
10. **Ops log and Advanced** are separate from the graph. Advanced shows the agent's work, can steer and interrupt, and expands over the graph rather than replacing it.
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
10. A series' name is its folder name.
11. A new instance starts from the most recently closed instance, by close time rather than label order.
12. The colour code: blue for what a person put in, black for what the agent made, red for notes ([docs/design.md](docs/design.md)).
13. The runner's cursor: events the agent never received start another run when the current one settles, except after an Interrupt.
14. Close logs each unanswered question's default as an answer, and the next instance applies it.
15. Past instances are imported one at a time, in label order.
16. In v0, the red dot is per browser, and the log has no read events.
17. A step is an intermediate result in a file, rather than an operation, so every tile opens in Preview and a dashed tile always means not there yet.
