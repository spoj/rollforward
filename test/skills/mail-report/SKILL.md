---
name: mail-report
description: Save the spreadsheets of a day's mail whose subject has the words the skill's setting names. Use when a report arrives by mail.
---

Find the day's mail with `rf mail find --date <day> --subject <words> --attachments`, then save each spreadsheet with `rf mail save <id> --name '\.xlsx$'`.
