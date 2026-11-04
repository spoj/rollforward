"""Print a JSON preview of one file, read from stdin and named by the argument: spreadsheet values, or an email's plain text. It
holds 2 GB at most, so a workbook that unpacks to more, as a zip bomb does, fails here."""
import csv, email, io, json, resource, sys
from email import policy
from pathlib import Path

resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))

ROWS, COLS = 2000, 100
name = sys.argv[1]
ext = Path(name).suffix.lower()
data = sys.stdin.buffer.read()


def sheet(name, rows):
    out = []
    for r in rows:
        if len(out) == ROWS:
            return {'name': name, 'rows': out, 'truncated': True}
        out.append(list(r)[:COLS])
    return {'name': name, 'rows': out, 'truncated': False}


if ext in ('.xlsx', '.xlsm'):
    from openpyxl import load_workbook
    values = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    formulas = load_workbook(io.BytesIO(data), read_only=True)

    def cells(vs, fs):
        for vrow, frow in zip(vs.iter_rows(values_only=True), fs.iter_rows(values_only=True)):
            yield [v if v is not None or not str(f).startswith('=') else {'f': f} for v, f in zip(vrow, frow)]

    out = {'sheets': [sheet(vs.title, cells(vs, fs)) for vs, fs in zip(values.worksheets, formulas.worksheets)]}
elif ext == '.xls':
    import xlrd
    book = xlrd.open_workbook(file_contents=data)
    out = {'sheets': [sheet(s.name, (s.row_values(i) for i in range(s.nrows))) for s in book.sheets()]}
elif ext == '.csv':
    out = {'sheets': [sheet(name, csv.reader(io.StringIO(data.decode('utf-8-sig', errors='replace'), newline='')))]}
elif ext == '.eml':
    m = email.message_from_bytes(data, policy=policy.default)
    body = m.get_body(preferencelist=('plain',))
    out = {'email': {
        'headers': {k: str(m[k]) for k in ('From', 'To', 'Cc', 'Date', 'Subject') if m[k]},
        'text': body.get_content() if body else '',
        'attachments': [a.get_filename() for a in m.iter_attachments()]}}
else:
    out = {}
print(json.dumps(out, default=str))
