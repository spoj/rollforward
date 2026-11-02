#!/usr/bin/env python3
"""Fetch the ECB euro reference rate (USD per EUR) for the week end.

Usage: fetch_fx.py INSTANCE_DIR
Queries the ECB data API for the 10 days up to the week end, keeps the last
observation on or before it (the week end, or the last business day before), and
writes the raw API CSV to working/ECB USD per EUR <obs date>.csv."""
import csv, datetime as dt, io, os, sys, urllib.request

inst = sys.argv[1].rstrip("/")
we = dt.date.fromisoformat(os.path.basename(os.path.abspath(inst)))
url = ("https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A"
       f"?startPeriod={we - dt.timedelta(days=10)}&endPeriod={we}&format=csvdata")
raw = urllib.request.urlopen(url, timeout=30).read().decode()
rows = [r for r in csv.DictReader(io.StringIO(raw)) if r["TIME_PERIOD"] <= str(we) and r["OBS_VALUE"]]
if not rows:
    sys.exit("no ECB observation")
last = max(rows, key=lambda r: r["TIME_PERIOD"])
out = os.path.join(inst, "working", f"ECB USD per EUR {last['TIME_PERIOD']}.csv")
if os.path.exists(out):
    sys.exit(f"{out} exists (frozen?)")
open(out, "w").write(raw)
print(dict(out=out, url=url, date=last["TIME_PERIOD"], rate=float(last["OBS_VALUE"]),
           fetched=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")))
