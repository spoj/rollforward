# Larkfield weekly borrowing base (Granite Point Credit)

One output per week ending (instance label = week-ending date, a Sunday):
`Borrowing base Larkfield MM.DD.YYYY.xlsx`, sheet `Base`, labels in B5:B25, values in C5:C25
(values only, format `#,##0.00;(#,##0.00)`, rates `0.00%`). Header B1:B3: company, "Week ending MM/DD/YYYY", lender.

## Inputs (item ids)
- `ar-aging` – AR aging xlsx (Customer, Currency, Current, 1-30, 31-60, 61-90, 91-120, 120+, Total), as of week end.
- `card-receipts` – card processor CSV (Date, Processor, Batch, Gross, Fees, Net), batches not yet settled (07.02–07.04 for wk 07/05).
- `inventory` – inventory at cost xlsx by SKU (Location DC/Store/In-transit, Ext cost, Last sale), dated the day before week end.
- `loan-activity` – Granite Point loan activity xlsx (Opening, Advances, Repayments, Interest, Closing).

## Rules
- Gross AR = sum of Total. Over 90 = 91-120 + 120+ for all customers.
- Cross-aged: customer whose over-90 > 50% of its Total; deduct the rest of its balance (Total − over 90).
- Concentration: cap = 25% of (Gross − over 90 − cross-aged); for each non-cross-aged customer, deduct (Total − over 90) − cap if positive.
- AR advance 80%.
- Card receipts in transit = sum of **Net** (after fees); advance 90%.
- Inventory: total Ext cost; less In-transit locations; less slow-moving = non-in-transit SKUs with Last sale more than 270 days before the inventory file date (no double count with in-transit). Advance 50%.
- Gross availability = sum of three availabilities; less fixed availability block 500,000.00 = borrowing base.
- Revolver balance = loan activity Closing balance (check Opening + Advances + Repayments + Interest = Closing). Excess = borrowing base − revolver.
- Each line rounded to cents; subtotals sum the rounded lines.
- Fixed terms (advance rates, 25%, 50%, 270 days, 500k block) are constants in `build_bb.py`, taken from the 2026-07-05 example; note them as carried each week.

## Scripts
- `build_bb.py INSTANCE [OUT_NAME]` – builds the workbook in working/, prints lines + detail (cross-aged and concentrated customers).
- `check_bb.py INSTANCE MINE REF` – cell compare + subtotal arithmetic. Run against own output each week (MINE=REF ok) and against any person-supplied version.
- Headline: excess availability and change vs previous instance's output.
