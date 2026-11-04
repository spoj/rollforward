"""Print a JSON preview of one file, read from stdin and named by the argument: spreadsheet values, as a workbook shows them, or an
email's plain text. It holds 2 GB at most, so a workbook that unpacks to more, as a zip bomb does, fails here."""
import colorsys, csv, datetime, email, io, json, re, resource, sys
from decimal import ROUND_HALF_UP, Decimal
from email import policy
from pathlib import Path

resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))

ROWS, COLS = 2000, 100
name, part = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ''
ext = Path(name).suffix.lower()
data = sys.stdin.buffer.read()


def sheet(name, rows):
    out = []
    for r in rows:
        if len(out) == ROWS:
            return {'name': name, 'rows': out, 'truncated': True}
        out.append(list(r)[:COLS])
    return {'name': name, 'rows': out, 'truncated': False}


# Excel's number formats, as far as a preview needs them: a section each for positive, negative and zero numbers, with digits,
# thousands, decimals, percent, scaling by trailing commas and literals; and dates and times.
PART = re.compile(r'"[^"]*"|\\.|_.|\*.|\[[^\]]*\]|;|[Ee][+-]|yyyy|yy|m{1,5}|d{1,4}|h{1,2}|s{1,2}|am/pm|a/p|\.0+|.', re.I | re.S)
DAY0 = datetime.datetime(1899, 12, 30)


def literal(t):
    if t[0] == '"':
        return t[1:-1]
    if t[0] == '\\':
        return t[1]
    if t[0] == '_' and len(t) == 2:
        return ' '
    if t[0] == '*' and len(t) == 2:
        return ''
    if t[0] == '[':
        currency = re.match(r'\[\$([^\]-]*)', t)
        return currency.group(1) if currency else ''
    return t


def shown(v, code):
    if code == 'General' or v is None or isinstance(v, (bool, str, dict)):
        return None
    sections = [[]]
    for t in PART.findall(code):
        if t == ';':
            sections.append([])
        else:
            sections[-1].append(t)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time, datetime.timedelta)):
        return when(v, sections[0])
    if len(sections) > 1 and v < 0:
        return number(-v, sections[1])
    return number(v, sections[2] if len(sections) > 2 and v == 0 else sections[0])


def number(v, part):
    sign, v = '-' if v < 0 else '', abs(v)
    before, digits, after = [], '', []
    for t in part:
        if re.fullmatch(r'[0#?]|\.0*', t) or (t == ',' and digits) or (t.upper() in ('E+', 'E-') and digits):
            digits += t
            continue
        if t == '%':
            v *= 100
        (after if digits else before).append(literal(t))
    if not digits:
        return sign + ''.join(before + after)
    scale = len(digits) - len(digits.rstrip(','))
    digits = digits.rstrip(',')
    v /= 1000 ** scale
    if 'E' in digits.upper():
        text = f'{v:.{len(re.split("[Ee]", digits)[0].partition(".")[2])}E}'
    else:
        whole, point, frac = digits.partition('.')
        i, _, f = f'{Decimal(repr(v)).quantize(Decimal(1).scaleb(-len(frac)), ROUND_HALF_UP):f}'.partition('.')
        i = ('' if i == '0' and '0' not in whole else i).zfill(whole.count('0'))
        if ',' in whole and i:
            i = f'{int(i):,}'
        f = list(f)
        for k in reversed(range(len(f))):
            if f[k] != '0' or frac[k] == '0':
                break
            f[k] = ' ' if frac[k] == '?' else ''
        text = i + point + ''.join(f)
    return sign + ''.join(before) + text + ''.join(after)


def when(v, part):
    if isinstance(v, datetime.timedelta):
        d = DAY0 + v
    elif isinstance(v, datetime.datetime):
        d = v
    elif isinstance(v, datetime.date):
        d = datetime.datetime.combine(v, datetime.time())
    else:
        d = datetime.datetime.combine(DAY0, v)
    total = (d - DAY0).total_seconds()
    codes = [k for k, t in enumerate(part) if re.fullmatch(r'y+|m+|d+|h+|s+|\[[hms]+\]', t, re.I)]
    ampm = any(t.lower() in ('am/pm', 'a/p') for t in part)
    out = []
    for k, t in enumerate(part):
        low = t.lower()
        if low in ('m', 'mm'):
            before = next((part[j].lower().lstrip('[') for j in reversed(codes) if j < k), '')
            after = next((part[j].lower().lstrip('[') for j in codes if j > k), '')
            out.append(f'{d.minute if before[:1] == "h" or after[:1] == "s" else d.month:0{len(low)}}')
        elif low in ('mmm', 'mmmm', 'mmmmm'):
            out.append(d.strftime('%b' if low == 'mmm' else '%B')[:1 if low == 'mmmmm' else None])
        elif low in ('yy', 'yyyy'):
            out.append(f'{d.year:04}' if low == 'yyyy' else f'{d.year % 100:02}')
        elif low in ('d', 'dd'):
            out.append(f'{d.day:0{len(low)}}')
        elif low in ('ddd', 'dddd'):
            out.append(d.strftime('%a' if low == 'ddd' else '%A'))
        elif low in ('h', 'hh'):
            out.append(f'{(d.hour % 12 or 12) if ampm else d.hour:0{len(low)}}')
        elif low in ('s', 'ss'):
            out.append(f'{d.second:0{len(low)}}')
        elif re.fullmatch(r'\[(h+|m+|s+)\]', low):
            out.append(str(int(total // {'h': 3600, 'm': 60, 's': 1}[low[1]])))
        elif low in ('am/pm', 'a/p'):
            out.append(t.split('/')[d.hour >= 12])
        elif low.startswith('.0'):
            out.append(f'{d.microsecond / 1e6:.{len(low) - 1}f}'[1:])
        else:
            out.append(literal(t))
    return ''.join(out)


def workbook():
    from openpyxl import load_workbook
    from openpyxl.styles.colors import COLOR_INDEX
    from openpyxl.styles.numbers import BUILTIN_FORMATS
    from openpyxl.utils.cell import range_boundaries
    from openpyxl.worksheet._reader import WorkSheetParser
    from openpyxl.xml.functions import iterparse
    wb = load_workbook(io.BytesIO(data), read_only=True)
    xml = (wb.loaded_theme or b'').decode('utf-8', 'replace')
    theme = [m.group(1) if (m := re.search(rf'<a:{n}>.*?(?:lastClr|val)="([0-9A-Fa-f]{{6}})"', xml, re.S)) else None
             for n in ('lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink')]

    def colour(c):
        base = (c.rgb[-6:] if c.type == 'rgb' and isinstance(c.rgb, str) else theme[c.theme] if c.type == 'theme' and c.theme < len(theme)
                else COLOR_INDEX[c.indexed][-6:] if c.type == 'indexed' and c.indexed < 64 else None)
        if base and c.tint:
            h, light, s = colorsys.rgb_to_hls(*(int(base[k:k + 2], 16) / 255 for k in (0, 2, 4)))
            light = light * (1 + c.tint) if c.tint < 0 else light * (1 - c.tint) + c.tint
            base = ''.join(f'{round(x * 255):02X}' for x in colorsys.hls_to_rgb(h, light, s))
        return base and f'#{base}'

    styles = {}

    def style(sid):
        if sid not in styles:
            st = wb._cell_styles[sid]
            font, fill = wb._fonts[st.fontId], wb._fills[st.fillId]
            styles[sid] = (BUILTIN_FORMATS.get(st.numFmtId, 'General') if st.numFmtId < 164 else wb._number_formats[st.numFmtId - 164],
                           font.b, font.color is not None and colour(font.color) not in (None, '#000000') and colour(font.color),
                           getattr(fill, 'patternType', None) == 'solid' and colour(fill.fgColor))
        return styles[sid]

    # A sheet's cells as they show, its formulas where they hold no value, and its merged cells, column widths and hidden rows and
    # columns.
    def read(ws):
        p = WorkSheetParser(None, ws._shared_strings, epoch=wb.epoch, date_formats=wb._date_formats, timedelta_formats=wb._timedelta_formats)
        out = {'name': ws.title, 'rows': [], 'truncated': False, 'look': {}, 'merged': [], 'widths': {}, 'hidden': {'rows': [], 'cols': []}}
        with wb._archive.open(ws._worksheet_path) as src:
            for _, el in iterparse(src):
                tag = el.tag.rpartition('}')[2]
                if tag == 'col':
                    for c in range(int(el.get('min')) - 1, min(int(el.get('max')), COLS)):
                        if el.get('width'):
                            out['widths'][c] = float(el.get('width'))
                        if el.get('hidden') in ('1', 'true'):
                            out['hidden']['cols'].append(c)
                elif tag == 'row':
                    r = int(el.get('r', len(out['rows']) + 1)) - 1
                    if r >= ROWS:
                        out['truncated'] = True
                        break
                    else:
                        if el.get('hidden') in ('1', 'true'):
                            out['hidden']['rows'].append(r)
                        out['rows'].extend([] for _ in range(r - len(out['rows'])))
                        p.row_counter, p.col_counter, row = r + 1, 0, []
                        for cell in el:
                            at, p.data_only = p.col_counter, False
                            f = p.parse_cell(cell)
                            p.col_counter, p.data_only = at, True
                            c = p.parse_cell(cell)
                            v, col = c['value'], c['column'] - 1
                            if col >= COLS:
                                continue
                            if v is None and f['data_type'] == 'f':
                                v = {'f': getattr(f['value'], 'text', str(f['value']))}
                            row.extend([None] * (col - len(row)))
                            row.append(v)
                            code, bold, fg, bg = style(c['style_id'])
                            look = {k: x for k, x in (('t', shown(v, code)), ('r', isinstance(v, (datetime.date, datetime.time, datetime.timedelta)) or None),
                                                      ('b', bold or None), ('fg', fg or None), ('bg', bg or None)) if x is not None}
                            if look:
                                out['look'][f'{r},{col}'] = look
                        out['rows'].append(row)
                    el.clear()
        # Merged cells are listed after all the rows, which a long sheet's preview stops short of parsing, so they're found by a
        # plain search, a chunk of the sheet at a time, each with the end of the one before, where a tag may begin.
        refs, tail = set(), b''
        with wb._archive.open(ws._worksheet_path) as src:
            while chunk := src.read(1 << 22):
                refs.update(re.findall(rb'<(?:\w+:)?mergeCell ref="([A-Z]+[0-9]+:[A-Z]+[0-9]+)"', tail + chunk))
                tail = chunk[-100:]
        for c1, r1, c2, r2 in sorted(range_boundaries(ref.decode()) for ref in refs):
            if r1 <= ROWS and c1 <= COLS:
                out['merged'].append([r1 - 1, c1 - 1, r2 - 1, c2 - 1])
        return out

    # The sheets' names, the hidden ones after the others, and the sheet the workbook opens on, read; or, asked for by its place, one
    # other sheet.
    if part:
        return read(wb.worksheets[int(part)])
    sheets = wb.worksheets
    active = sheets.index(wb.active) if wb.active in sheets else 0
    return {'sheets': [{'name': sheets[k].title, 'at': k, **({'state': sheets[k].sheet_state} if sheets[k].sheet_state != 'visible' else {}), **(read(sheets[k]) if k == active else {})}
                       for k in sorted(range(len(sheets)), key=lambda k: sheets[k].sheet_state != 'visible')]}


if ext in ('.xlsx', '.xlsm'):
    out = workbook()
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
