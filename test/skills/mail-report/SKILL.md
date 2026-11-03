---
name: mail-report
description: Save the spreadsheets of a day's Open AP report mail. Use when the open AP report is needed.
---

Find the day's mail with `rf graph '/me/messages?$search="Open AP report"&$expand=attachments($select=id,name)'`, then save each spreadsheet with `rf graph /me/messages/<id>/attachments/<attachment id>/$value --out <name>`.
