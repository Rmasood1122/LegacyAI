"""Builds small synthetic PDFs for tests (no files are stored in the repository)."""

from __future__ import annotations

import zlib


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(pages: list[str], *, extra_objects: list[bytes] | None = None, compress: bool = False) -> bytes:
    """A valid PDF with one line of Helvetica text per page (several lines if the text has newlines)."""
    objects: list[bytes] = []
    n_pages = len(pages)
    # 1 catalog, 2 pages, 3 font, then (page, content) pairs
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(n_pages))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, text in enumerate(pages):
        lines = text.split("\n")
        ops = "BT /F1 11 Tf 50 750 Td 14 TL " + " ".join(f"({_escape(line)}) Tj T*" for line in lines) + " ET"
        stream = ops.encode("latin-1")
        content_obj = 5 + 2 * i
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
                       f"/Contents {content_obj} 0 R >>".encode())
        if compress:
            data = zlib.compress(stream)
            objects.append(f"<< /Length {len(data)} /Filter /FlateDecode >>\nstream\n".encode() + data + b"\nendstream")
        else:
            objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects.extend(extra_objects or [])
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for num, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def bomb_pdf(megabytes: int = 60) -> bytes:
    """A one-page PDF whose content stream inflates to `megabytes` of zeros (a decompression bomb)."""
    payload = zlib.compress(b"0" * (megabytes * 1024 * 1024), 9)
    body = make_pdf(["placeholder"])
    head = body.split(b"5 0 obj\n")[0]
    content = f"<< /Length {len(payload)} /Filter /FlateDecode >>\nstream\n".encode() + payload + b"\nendstream"
    # rebuild with object 5 replaced
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>", content]
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for num, b in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + b + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    del head
    return bytes(out)


def make_scanned_pdf(pages: list[str | int], *, size: tuple[int, int] = (595, 842)) -> bytes:
    """A PDF whose pages are either text (a str) or a "scanned" page: no text at all, only `n` black bars drawn on it
    (an int) - what a picture of a page looks like to a PDF reader. A test reader counts the bars in the picture."""
    width, height = size
    objects: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(len(pages)))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, page in enumerate(pages):
        if isinstance(page, str):
            stream = f"BT /F1 11 Tf 50 {height - 92} Td ({_escape(page)}) Tj ET".encode("latin-1")
        else:  # bars 20 points high with 20 points between them, from the top, across the middle of the page
            stream = " ".join(f"0 g {width // 4} {height - 100 - 40 * b} {width // 2} 20 re f" for b in range(page)).encode()
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << /Font << /F1 3 0 R >> >> "
                       f"/Contents {5 + 2 * i} 0 R >>".encode())
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for num, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def read_png_gray(data: bytes) -> tuple[int, int, list[bytes]]:
    """Decodes an 8-bit grey PNG with filter 0 rows (what scans.png_gray writes): (width, height, rows). Checks every CRC."""
    import struct
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    at, idat, width, height = 8, b"", 0, 0
    while at < len(data):
        (length,) = struct.unpack(">I", data[at:at + 4])
        kind, body = data[at + 4:at + 8], data[at + 8:at + 8 + length]
        assert struct.unpack(">I", data[at + 8 + length:at + 12 + length])[0] == zlib.crc32(kind + body) & 0xFFFFFFFF
        if kind == b"IHDR":
            width, height, depth, colour = struct.unpack(">IIBB", body[:10])
            assert (depth, colour) == (8, 0)
        elif kind == b"IDAT":
            idat += body
        at += 12 + length
    raw = zlib.decompress(idat)
    rows = [raw[y * (width + 1):(y + 1) * (width + 1)] for y in range(height)]
    assert all(r[0] == 0 for r in rows)
    return width, height, [r[1:] for r in rows]


def count_bars(png: bytes) -> int:
    """How many separate dark bars cross the middle column of the picture."""
    width, _, rows = read_png_gray(png)
    column = [row[width // 2] < 128 for row in rows]
    return sum(1 for y, dark in enumerate(column) if dark and (y == 0 or not column[y - 1]))
