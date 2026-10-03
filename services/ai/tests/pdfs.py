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
