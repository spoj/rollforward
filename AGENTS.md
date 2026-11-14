# Agents working on rollforward

docs/system.md describes the system: keep it true in the same commit as the code. README.md is the stark overview: purpose, deploy, how, limitations; keep it that brief. prompt.md holds the instance agent's instructions; treat it as code.

Give the instance agent transparent wide paths: the real interface (Graph, a browser over CDP, the shell) behind a boundary the server keeps and logs, not commands that wrap or pre-digest it. Narrow conveniences are skills people write. Don't babysit the model in prompt.md or rf help either.

A change does one thing: it changes what the system does, a fix, a feature, a rule or a removal, with the tests that say so, or it changes how the code says it, a refactor, with no test's expectation touched and the suite green before and after. A fix is for a bug reproduced by a failing test, and is no larger; where it needs a choice between two defensible behaviours it is a rule, which Matthew decides. Refactor when an invariant has shown itself, not while fixing.

New behaviour goes to a few named people first, behind a capability, and is fixed forward as they report; an adversarial review of each change, and whole-system bug hunts, run in the background on what has shipped. Review before shipping only what a patch can't undo: what leaves the system, secrets and access, the stored data's format, and what can stop the server starting. A tag deploys (docs/deploy.md).
