---
name: onedrive-report
description: Save a day's report from the reports folder in OneDrive. Use when a day's report is needed.
---

List the folder with `rf graph /shares/<the link, encoded as Graph says>/driveItem/children`, then save the file with `rf graph /drives/<drive id>/items/<id>/content --out <name>`.
