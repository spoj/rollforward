#!/usr/bin/env python3
"""Compare two borrowing base workbooks (Base!B5:C25) cell by cell.
Usage: check_bb.py INSTANCE_DIR MINE.xlsx REFERENCE.xlsx  (paths relative to instance)
Also checks the arithmetic of the subtotals in MINE."""
import os, sys
import openpyxl

inst, a, b = sys.argv[1:4]
A = openpyxl.load_workbook(os.path.join(inst, a), data_only=True)["Base"]
B = openpyxl.load_workbook(os.path.join(inst, b), data_only=True)["Base"]
bad = 0
for r in range(1, 26):
    for c in (2, 3):
        x, y = A.cell(r, c).value, B.cell(r, c).value
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            same = abs(x - y) < 0.005
        else:
            same = x == y
        if not same:
            bad += 1
            print(f"DIFF {A.cell(r, c).coordinate}: mine={x!r} ref={y!r}")
v = {r: A.cell(r, 3).value for r in range(5, 26)}
checks = [(9, v[5] + v[6] + v[7] + v[8]), (11, v[9] * v[10]), (14, v[12] * v[13]),
          (18, v[15] + v[16] + v[17]), (20, v[18] * v[19]), (21, v[11] + v[14] + v[20]),
          (23, v[21] + v[22]), (25, v[23] + v[24])]
for r, exp in checks:
    if abs(v[r] - exp) > 0.011:
        bad += 1
        print(f"ARITH C{r}: {v[r]} vs {exp}")
print("OK" if not bad else f"{bad} problems")
sys.exit(1 if bad else 0)
