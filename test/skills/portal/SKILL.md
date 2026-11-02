---
name: Portal
description: Look up invoices on a vendor portal and save them as csv. Use when an instance needs what the portal holds for given invoices.
---

`rf browser open portal` prints a CDP address; connect Playwright to it and use `browser.contexts()[0]`, where the runner is signed in. The invoices page exports a csv.
