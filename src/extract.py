# The text of a workbook, mail, PDF or Word file, for rf search: one line per sheet row, header or paragraph.
import sys
from pathlib import Path


def col(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


p = Path(sys.argv[1])
ext = p.suffix.lower()
if ext in ('.xlsx', '.xlsm', '.xls', '.xlsb', '.ods'):
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(p))
    for name in wb.sheet_names:
        for r, row in enumerate(wb.get_sheet_by_name(name).to_python(skip_empty_area=False), 1):
            cells = [f'{col(c)}{r}={v}' for c, v in enumerate(row) if v not in ('', None)]
            if cells:
                print(f'{name}!{r}: ' + ' | '.join(cells))
elif ext == '.eml':
    from email import policy
    from email.parser import BytesParser
    m = BytesParser(policy=policy.default).parse(p.open('rb'))
    for h in ('From', 'To', 'Cc', 'Date', 'Subject'):
        if m[h]:
            print(f'{h}: {m[h]}')
    body = m.get_body(('plain', 'html'))
    if body:
        print(body.get_content())
    for a in m.iter_attachments():
        print(f'Attachment: {a.get_filename()}')
elif ext == '.pdf':
    import pdfplumber
    with pdfplumber.open(p) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            print(f'Page {i}:')
            print(page.extract_text() or '')
elif ext == '.docx':
    import docx
    for para in docx.Document(p).paragraphs:
        print(para.text)
