---
name: mail-report
description: Save the spreadsheets of a day's Open AP report mail. Use when the open AP report is needed.
---

Find the day's mail with `rf mail find --date <day> --subject "Open AP report" --attachments`, then save each spreadsheet with `rf mail save <id> --name '\.xlsx$'`.
