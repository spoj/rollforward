# Larkfield weekly borrowing base (Granite Point Credit)

One output per week ending (instance label = week-ending date, a Sunday):
`Borrowing base Larkfield MM.DD.YYYY.xlsx`, sheet `Base`, labels in B5:B25, values in C5:C25
(values only, format `#,##0.00;(#,##0.00)`, rates `0.00%`). Header B1:B3: company, "Week ending MM/DD/YYYY", lender.

## Inputs (item ids)
- `ar-aging` – uploaded AR aging xlsx (Customer, Currency, Current, 1-30, 31-60, 61-90, 91-120, 120+, Total), as of week end.
- `card-receipts` – uploaded card processor CSV (Date, Processor, Batch, Gross, Fees, Net), batches not yet settled (Thu–Sat before week end).
- `inventory` – **fetched** (from wk 08/16/2026; uploaded before): `fetch_inventory.py INSTANCE` reads
  /data-sources/warehouse.sqlite (read-only), table `inventory_snapshot`,
  latest `as_of` on or before the week end → `working/Inventory at cost MM.DD.YYYY.xlsx` (as_of date, same layout as the old uploads:
  SKU, Description, Category, Location DC/Store/In-transit, Qty, Unit cost, Ext cost, Last sale). Item gets a `source`.
- `loan-activity` – **fetched** (from wk 08/16/2026): Granite Point emails it each Monday after week end to
  /data-sources/mailbox (.eml, xlsx attached). `fetch_loan.py INSTANCE` saves the attachment
  named `... loan activity MM.DD.YYYY.xlsx` (week-end date) to working/. Granite Point is closed Mon 09/07/2026 (Labor Day);
  that week's report comes Tuesday. If no email yet, keep the item `"file": null` and say so, build with the revolver
  carried from the previous week's borrowing base (`build_bb.py ... --carry-revolver PREV_BB.xlsx`, Base!C24), flag it as
  provisional in the headline and notes, ask when the email lands, then refetch and rebuild under a new name.
- `fx-rate` – **fetched** (from wk 08/16/2026): `fetch_fx.py INSTANCE` pulls ECB EXR D.USD.EUR.SP00.A (USD per EUR) for the
  10 days to week end and saves the raw CSV as `working/ECB USD per EUR YYYY-MM-DD.csv` (date of last observation on or
  before week end, i.e. the week end or last business day before).
- Never write to the DB or mailbox. Never-shown fetched files may be refetched; once shown they're frozen (new name).

## Rules
- Non-USD AR lines (Currency column; Maison Verte SARL in EUR from wk 08/16/2026): convert every bucket and Total to USD
  at the `fx-rate` rate before any test; note the EUR amount, rate, date and USD value. A currency without a rate stops the build.
- Gross AR = sum of Total. Over 90 = 91-120 + 120+ for all customers.
- Cross-aged: customer whose over-90 > 50% of its Total; deduct the rest of its balance (Total − over 90).
- Concentration: cap = 25% of (Gross − over 90 − cross-aged); for each non-cross-aged customer, deduct (Total − over 90) − cap if positive.
- AR advance 80%.
- Card receipts in transit = sum of **Net** (after fees); advance 90%.
- Inventory: exact duplicate rows (same SKU and every field) are export repeats: keep the first, drop the rest and note rows/amount; same SKU with different data stops the build. Total Ext cost; less In-transit locations; less slow-moving = non-in-transit SKUs with Last sale more than 270 days before the inventory file date (no double count with in-transit). Advance 50%.
- Missing card receipts file: item kept with `"file": null`, card line built as 0 (conservative), and ask whether a file is coming; rebuild under a new name if it arrives.
- Gross availability = sum of three availabilities; less fixed availability block 750,000.00 (500,000.00 until wk 08/02/2026; raised by the reviewer from wk 08/09/2026 as a standing rule) = borrowing base.
- Revolver balance = loan activity Closing balance (check Opening + Advances + Repayments + Interest = Closing). Excess = borrowing base − revolver.
- Loan Opening balance should equal the previous instance's revolver balance (Base!C24); flag if not.
- Each line rounded to cents **half up** (0.005 → 0.01, as the supplied workbooks do); subtotals sum the rounded lines.
- Fixed terms are constants in `build_bb.py`: advance rates, 25%, 50%, 270 days from the 2026-07-05 example; 750k block from the 2026-08-09 reviewed output. Note them as carried each week.
- Foreign (EUR) account Maison Verte SARL is eligible after conversion (q-foreign closed on 'eligible' wk 08/16 and 08/23;
  standing, no longer asked).
- Lender waivers (Granite Point email, e.g. a higher concentration limit for one customer) apply only to the weeks they name:
  `build_bb.py ... --conc-limit "Customer=0.35"` (label on C8 names the waiver). The email is evidence: remove its item, cite it
  in the C8 note with the 25% figure and excess impact. Never fold a waiver into the constants.
  Glenrock Home Centers 35% for 08/30/2026 only.
- Inventory snapshot is normally Saturday (day before week end). If the latest on or before week end is older, build on it
  and ask whether to wait for a newer one.

## Scripts
- Run order: `fetch_inventory.py`, `fetch_loan.py`, `fetch_fx.py`, then build.
- `build_bb.py INSTANCE [OUT_NAME]` – builds the workbook in working/, prints lines + detail (cross-aged and concentrated customers).
- `check_bb.py INSTANCE MINE REF` – cell compare + subtotal arithmetic. Run against own output each week (MINE=REF ok) and against any person-supplied version.
- When a person supplies the week's output, keep the item on their upload, rebuild as `... rebuild.xlsx` in working/ and compare with check_bb.py.
- Headline: excess availability and change vs previous week's output (the latest earlier instance, even if still open).
