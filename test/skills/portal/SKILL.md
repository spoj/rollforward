---
name: Portal
description: Look up invoices on a vendor portal and save them as csv. Use when an instance needs what the portal holds for given invoices.
---

Connect Playwright to `$RF_BROWSERS/portal` and use `browser.contexts()[0]`, where the runner is signed in. The invoices page exports a csv.
