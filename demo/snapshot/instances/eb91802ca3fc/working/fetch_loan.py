#!/usr/bin/env python3
"""Fetch the Granite Point loan activity from the mailbox folder (read-only).

Usage: fetch_loan.py INSTANCE_DIR [MAILBOX]
Finds the .eml whose xlsx attachment is named for the week end
("... loan activity MM.DD.YYYY.xlsx") and saves the attachment to working/.
Fails if none or more than one matches."""
import datetime as dt, email, glob, os, sys
from email import policy

MAILBOX = "/data-sources/mailbox"
inst = sys.argv[1].rstrip("/")
mbox = sys.argv[2] if len(sys.argv) > 2 else MAILBOX
we = dt.date.fromisoformat(os.path.basename(os.path.abspath(inst)))
want = f"loan activity {we:%m.%d.%Y}.xlsx".lower()
hits = []
for f in sorted(glob.glob(os.path.join(mbox, "*.eml"))):
    msg = email.message_from_binary_file(open(f, "rb"), policy=policy.default)
    for part in msg.iter_attachments():
        name = part.get_filename() or ""
        if name.lower().endswith(want):
            hits.append((f, msg, name, part.get_payload(decode=True)))
if len(hits) != 1:
    sys.exit(f"{len(hits)} emails with an attachment ending '{want}' in {mbox}")
f, msg, name, data = hits[0]
out = os.path.join(inst, "working", name)
if os.path.exists(out):
    sys.exit(f"{out} exists (frozen?)")
open(out, "wb").write(data)
print(dict(out=out, eml=f, subject=msg["Subject"], date=msg["Date"], sender=msg["From"], bytes=len(data)))
