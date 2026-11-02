"""Pure-Python text extraction for formats without a maintained high-level library.

Covers legacy binary Office files (Word/Excel/PowerPoint 97-2003), Outlook .msg and
.eml e-mails, Apple iWork bundles (Pages, Keynote, Numbers), and macro/template
variants of Office Open XML. No LibreOffice or system packages are required.
"""
import email
import email.policy
import gzip
import html
import re
import struct
import zipfile
from io import BytesIO

import olefile
import xlrd

def office_preview_image(path):
    """Read an embedded Office cover image without launching the renderer."""
    if not zipfile.is_zipfile(path): return None
    with zipfile.ZipFile(path) as archive:
        for name in ("docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "docProps/thumbnail.png"):
            try: entry = archive.getinfo(name)
            except KeyError: continue
            if entry.file_size <= 10_000_000: return archive.read(entry)
    return None

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def sniff(path):
    """Return the real container type of a file regardless of its extension."""
    with open(path, "rb") as file:
        head = file.read(512)
    if head.startswith(OLE_MAGIC): return "ole"
    if head.startswith(b"PK\x03\x04"): return "zip"
    if head.lstrip().startswith(b"{\\rtf"): return "rtf"
    if re.search(rb"<(html|head|body|table)\b", head[:512], re.I): return "html"
    return "text"


def strip_markup(text):
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d|w:p|a:p|text:p|si)>", "\n", text)
    return html.unescape(re.sub(r"<[^>]+>", " ", text))


def rtf_text(raw):
    raw = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1252"), raw)
    raw = re.sub(r"\\par[d]?\b ?", "\n", raw)
    return re.sub(r"\\[a-z]+-?\d* ?|[{}]", "", raw)


def clean_word_text(text):
    # Drop field instructions (between 0x13 and 0x14), keep field results; map Word control characters.
    text = re.sub(r"\x13[^\x13\x14\x15]*\x14", "", text)
    text = re.sub(r"\x13[^\x13\x14\x15]*\x15", "", text)
    text = text.translate({0x07: "\t", 0x0B: "\n", 0x0C: "\n", 0x0D: "\n", 0x15: None, 0x01: None, 0x08: None, 0x1E: "-", 0x1F: None, 0xA0: " "})
    return re.sub(r"[\x00-\x08\x0e-\x1f]", "", text)


def doc_text(path):
    """Word 97-2003 text from the piece table; falls back to the contiguous text range for Word 6/95."""
    with olefile.OleFileIO(path) as ole:
        word = ole.openstream("WordDocument").read()
        ident, flags = struct.unpack_from("<HH", word, 0)[0], struct.unpack_from("<H", word, 0x0A)[0]
        if ident == 0xA5EC and len(word) > 0x01AA:
            table_name = "1Table" if flags & 0x0200 else "0Table"
            fc_clx, lcb_clx = struct.unpack_from("<II", word, 0x01A2)
            if ole.exists(table_name) and lcb_clx:
                clx = ole.openstream(table_name).read()[fc_clx:fc_clx + lcb_clx]
                pos = 0
                while pos < len(clx) and clx[pos] == 0x01:
                    pos += 3 + struct.unpack_from("<H", clx, pos + 1)[0]
                if pos < len(clx) and clx[pos] == 0x02:
                    lcb = struct.unpack_from("<I", clx, pos + 1)[0]; plc = clx[pos + 5:pos + 5 + lcb]
                    count = (lcb - 4) // 12
                    cps = struct.unpack_from(f"<{count + 1}I", plc, 0)
                    parts = []
                    for index in range(count):
                        fc = struct.unpack_from("<I", plc, (count + 1) * 4 + index * 8 + 2)[0]
                        chars = cps[index + 1] - cps[index]
                        if fc & 0x40000000:
                            start = (fc & ~0x40000000) // 2
                            parts.append(word[start:start + chars].decode("cp1252", errors="replace"))
                        else:
                            parts.append(word[fc:fc + chars * 2].decode("utf-16-le", errors="replace"))
                    return clean_word_text("".join(parts))
        fc_min, fc_mac = struct.unpack_from("<II", word, 0x18)
        return clean_word_text(word[fc_min:fc_mac].decode("cp1252", errors="replace"))


def ppt_text(path):
    """PowerPoint 97-2003 text atoms, in slide order."""
    with olefile.OleFileIO(path) as ole:
        stream = ole.openstream("PowerPoint Document").read()
    parts, pos = [], 0
    while pos + 8 <= len(stream):
        ver_instance, record_type, length = struct.unpack_from("<HHI", stream, pos)
        if ver_instance & 0x0F == 0x0F:
            pos += 8; continue
        body = stream[pos + 8:pos + 8 + length]
        if record_type == 0x0FA0: parts.append(body.decode("utf-16-le", errors="replace"))
        elif record_type == 0x0FA8: parts.append(body.decode("cp1252", errors="replace"))
        pos += 8 + length
    return "\n".join(part.replace("\r", "\n").replace("\x0b", "\n") for part in parts)


def xls_text(path):
    book = xlrd.open_workbook(path, on_demand=True)
    try:
        sheets = []
        for sheet in book.sheets():
            rows = (" | ".join(str(value) for value in sheet.row_values(index) if value not in ("", None)) for index in range(sheet.nrows))
            sheets.append(f"[{sheet.name}]\n" + "\n".join(row for row in rows if row))
        return "\n".join(sheets)
    finally:
        book.release_resources()


def msg_text(path):
    """Outlook .msg: sender, subject, and plain-text body."""
    with olefile.OleFileIO(path) as ole:
        def prop(code):
            for suffix, encoding in (("001F", "utf-16-le"), ("001E", "cp1252")):
                name = f"__substg1.0_{code}{suffix}"
                if ole.exists(name): return ole.openstream(name).read().decode(encoding, errors="replace").rstrip("\x00")
            return ""
        body = prop("1000")
        if not body and ole.exists("__substg1.0_10130102"):
            body = strip_markup(ole.openstream("__substg1.0_10130102").read().decode("utf-8", errors="replace"))
        header = [f"From: {prop('0C1A')} {prop('0C1F')}".strip(), f"To: {prop('0E04')}", f"Subject: {prop('0037')}"]
        return "\n".join(line for line in header if not line.endswith(": ")) + "\n\n" + body


def eml_text(path):
    with open(path, "rb") as file:
        message = email.message_from_binary_file(file, policy=email.policy.default)
    header = "\n".join(f"{key}: {message[key]}" for key in ("From", "To", "Date", "Subject") if message[key])
    part = message.get_body(preferencelist=("plain", "html"))
    body = ""
    if part is not None:
        body = part.get_content()
        if part.get_content_type() == "text/html": body = strip_markup(body)
    return header + "\n\n" + body


OOXML_PARTS = (r"word/(document|header\d*|footer\d*)\.xml", r"xl/sharedStrings\.xml", r"ppt/slides/slide\d+\.xml")


def ooxml_text(path):
    """Text of any Office Open XML package, including macro-enabled and template variants."""
    natural = lambda name: [int(token) if token.isdigit() else token for token in re.split(r"(\d+)", name)]
    with zipfile.ZipFile(path) as archive:
        names = sorted((name for name in archive.namelist() if any(re.fullmatch(pattern, name) for pattern in OOXML_PARTS)), key=natural)
        names.sort(key=lambda name: 0 if name.startswith(("word/document", "ppt/", "xl/")) else 1)
        return "\n".join(strip_markup(archive.read(name).decode("utf-8", errors="replace")) for name in names)


def snappy_decompress(data):
    """Raw Snappy block decompression (iWork .iwa chunks carry no framing CRCs)."""
    length, shift, pos = 0, 0, 0
    while True:
        byte = data[pos]; pos += 1
        length |= (byte & 0x7F) << shift; shift += 7
        if not byte & 0x80: break
    out = bytearray()
    while pos < len(data):
        tag = data[pos]; pos += 1; kind = tag & 3
        if kind == 0:
            size = tag >> 2
            if size >= 60:
                extra = size - 59; size = int.from_bytes(data[pos:pos + extra], "little"); pos += extra
            size += 1; out += data[pos:pos + size]; pos += size; continue
        if kind == 1:
            size = ((tag >> 2) & 7) + 4; offset = ((tag >> 5) << 8) | data[pos]; pos += 1
        elif kind == 2:
            size = (tag >> 2) + 1; offset = int.from_bytes(data[pos:pos + 2], "little"); pos += 2
        else:
            size = (tag >> 2) + 1; offset = int.from_bytes(data[pos:pos + 4], "little"); pos += 4
        if not offset or offset > len(out): raise ValueError("Corrupt snappy stream")
        for _ in range(size): out.append(out[-offset])
    return bytes(out[:length])


def iwa_payload(data):
    chunks, pos = [], 0
    while pos + 4 <= len(data):
        size = int.from_bytes(data[pos + 1:pos + 4], "little")
        chunks.append(snappy_decompress(data[pos + 4:pos + 4 + size])); pos += 4 + size
    return b"".join(chunks)


def read_varint(data, pos):
    value, shift = 0, 0
    while True:
        if pos >= len(data) or shift > 63: raise ValueError("Bad varint")
        byte = data[pos]; pos += 1
        value |= (byte & 0x7F) << shift; shift += 7
        if not byte & 0x80: return value, pos


def protobuf_strings(data, depth=0):
    """Collect human-readable strings from an untyped protobuf message; returns None if `data` is not a message."""
    found, pos = [], 0
    try:
        while pos < len(data):
            key, pos = read_varint(data, pos); wire = key & 7
            if key >> 3 == 0: return None
            if wire == 0: _, pos = read_varint(data, pos)
            elif wire == 1: pos += 8
            elif wire == 5: pos += 4
            elif wire == 2:
                size, pos = read_varint(data, pos); value = data[pos:pos + size]; pos += size
                if len(value) != size: return None
                nested = protobuf_strings(value, depth + 1) if depth < 12 and size else None
                if nested is not None: found += nested; continue
                try: text = value.decode("utf-8")
                except UnicodeDecodeError: continue
                if re.search(r"[A-Za-zÄÖÜäöüß0-9]{2}", text) and sum(ch.isprintable() or ch in "\n\t\u2028\u2029" for ch in text) >= len(text) * 0.95:
                    found.append(text)
            else: return None
        return found if pos == len(data) else None
    except (ValueError, IndexError):
        return None


def iwa_strings(data):
    payload, strings, pos = iwa_payload(data), [], 0
    while pos < len(payload):
        info_size, pos = read_varint(payload, pos); info = payload[pos:pos + info_size]; pos += info_size
        lengths, cursor = [], 0
        try:
            while cursor < len(info):
                key, cursor = read_varint(info, cursor)
                if key == 0x12:  # field 2: MessageInfo
                    size, cursor = read_varint(info, cursor); message = info[cursor:cursor + size]; cursor += size; inner = 0
                    while inner < len(message):
                        field, inner = read_varint(message, inner)
                        if field == 0x18: length, inner = read_varint(message, inner); lengths.append(length)
                        elif field & 7 == 0: _, inner = read_varint(message, inner)
                        elif field & 7 == 2: skip, inner = read_varint(message, inner); inner += skip
                        else: inner = len(message)
                elif key & 7 == 0: _, cursor = read_varint(info, cursor)
                elif key & 7 == 2: skip, cursor = read_varint(info, cursor); cursor += skip
                else: break
        except ValueError:
            break
        for length in lengths:
            strings += protobuf_strings(payload[pos:pos + length]) or []; pos += length
    return strings


IWORK_SKIP = re.compile(r"(Stylesheet|ViewState|CalculationEngine|Metadata|Annotation|ThemePreset|DocumentMetadata)", re.I)


# File names, UUIDs, locale codes, timestamps, paths and printer/paper settings stored alongside the content.
IWORK_NOISE = re.compile(r"[\w.-]+\.(jpe?g|png|tiff?|pdf|gif)|[0-9A-F-]{36}|[a-z]+(-[a-z0-9]+)+|[a-z]{2}(_[A-Z]{2})?|\d{4}-\d\d-\d\dT[\d:+-]+|[\w ]+/[\w ]+/[\w ]+"
                         r"|\w+_series\w*|.*\b\d+(\.\d+)?\s*x\s*\d+(\.\d+)?\s*mm\b.*|Blank|Randlos.*|Borderless.*|Transition|none", re.I)


def iwork_text(path):
    """Pages/Keynote/Numbers: iWork '09 XML, embedded QuickLook PDF, or strings from the 2013+ .iwa archives."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        for name in ("index.xml", "index.xml.gz", "index.apxl", "index.apxl.gz"):
            if name in names:
                raw = archive.read(name)
                if name.endswith(".gz"): raw = gzip.decompress(raw)
                return strip_markup(raw.decode("utf-8", errors="replace"))
        if "QuickLook/Preview.pdf" in names:
            import fitz
            with fitz.open(stream=archive.read("QuickLook/Preview.pdf"), filetype="pdf") as document:
                return "\n".join(page.get_text("text") for page in document)
        natural = lambda name: [int(token) if token.isdigit() else token for token in re.split(r"(\d+)", name)]
        iwa = sorted((name for name in names if name.endswith(".iwa") and not IWORK_SKIP.search(name)), key=natural)
        slides = [name for name in iwa if re.search(r"/Slide(-\d+)?\.iwa$", name)]
        if slides: iwa = slides  # Keynote: Document.iwa mostly holds master-slide placeholder text.
        iwa.sort(key=lambda name: 0 if name.endswith("/Document.iwa") else 1)
        seen, lines = set(), []
        for name in iwa:
            try: strings = iwa_strings(archive.read(name))
            except (ValueError, IndexError): continue
            for text in strings:
                text = text.replace("\u2028", "\n").replace("\u2029", "\n").replace("\ufffc", "").strip()
                if text and text not in seen and not IWORK_NOISE.fullmatch(text):
                    seen.add(text); lines.append(text)
        return "\n".join(lines)


IWORK_PREVIEWS = ("preview.jpg", "QuickLook/Thumbnail.jpg", "preview-web.jpg", "QuickLook/Preview.jpg")


def iwork_preview_image(path):
    """Bytes of the first-page preview image stored inside an iWork document, if any."""
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        for name in IWORK_PREVIEWS:
            if name in names: return archive.read(name)
        if "QuickLook/Preview.pdf" in names:
            import fitz
            with fitz.open(stream=archive.read("QuickLook/Preview.pdf"), filetype="pdf") as document:
                if len(document): return document.load_page(0).get_pixmap().tobytes("jpeg")
    return None
