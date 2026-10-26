"""Sealing a company's content with its own content key (decision D41, docs/phase4/10-content-under-company-key.md,
steps 2 and 4b). The toolbox; content_keys.py decides which key a company's content uses.

* key services that wrap and unwrap a data key: the local stand-in (tests and development; the same format as the
  API's LocalKeyService, so the AI service opens what the API wrapped) and Google Cloud KMS (the same two REST calls
  as the API's gcp-kms.ts, with this service's own service account). The AI service wraps only the data keys of
  companies without a key of their own, with the platform's content key; a company's own data key is made by the
  API. Nobody hands a key over in a request;
* key ids say which data key: "company:<version>" (company_data_keys, wrapped by the company's key) or
  "platform:<version>" (content_data_keys, wrapped by the platform's content key);
* the content key: HKDF-SHA256 from the data key, bound to the company and the key id, for one purpose ("content") -
  so it is never the same key that seals the API's secrets;
* sealing one field: AES-256-GCM, a format byte, a fresh 12-byte nonce, and associated data that names the field's
  exact place (company, table, column, row, key version). A sealed value copied to another row, column, company or
  version does not open;
* vectors (embeddings) are sealed as their float32 bytes;
* a keyed fingerprint of a value (HMAC-SHA256 with a key derived from the content key for that one column), for the
  few values that must stay unique although they are sealed (a topic's name, step 6 part 4b). Equal values give equal
  fingerprints under the same key version only; without the key nothing can be learned from it;
* unwrapped data keys are kept for at most 5 minutes (as in the API, D35): switched off at the key service, a
  company's content stops opening within that time.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import struct
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

FORMAT_V1 = b"\x01"
NONCE_BYTES = 12
TAG_BYTES = 16
KEY_CACHE_SECONDS = 300


class KeyUnavailable(Exception):
    """The company's key cannot be used right now: switched off, destroyed, unknown, or the service cannot be reached.
    The message never repeats what a key service said (it can name projects and keys)."""


class SealError(Exception):
    """A sealed value does not open with this key at this place: damaged, moved, or sealed with another key."""


class KeyService(Protocol):
    kind: str

    def valid_ref(self, ref: str) -> bool: ...

    def wrap(self, ref: str, data_key: bytes, aad: str) -> bytes: ...

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes: ...


# ------------------------------------------------------------------ key services

_LOCAL_REF = re.compile(r"^local:([a-z0-9-]{1,40})$")


class LocalKeyService:
    """The stand-in: keys from the configuration. Wrapped = nonce(12) | tag(16) | ciphertext, AES-256-GCM, as the
    API's LocalKeyService writes it."""

    kind = "local"

    def __init__(self, keys: dict[str, bytes]) -> None:
        self._keys = dict(keys)
        self._off: set[str] = set()

    def valid_ref(self, ref: str) -> bool:
        return _LOCAL_REF.match(ref) is not None

    def disable(self, name: str) -> None:
        self._off.add(name)

    def enable(self, name: str) -> None:
        self._off.discard(name)

    def _key(self, ref: str) -> bytes:
        m = _LOCAL_REF.match(ref)
        if m is None:
            raise KeyUnavailable("not a local key reference")
        key = self._keys.get(m.group(1))
        if key is None:
            raise KeyUnavailable("unknown key")
        if m.group(1) in self._off:
            raise KeyUnavailable("the key is switched off")
        return key

    def wrap(self, ref: str, data_key: bytes, aad: str) -> bytes:
        key = self._key(ref)
        nonce = _nonce()
        sealed = AESGCM(key).encrypt(nonce, data_key, aad.encode("utf-8"))
        return nonce + sealed[-TAG_BYTES:] + sealed[:-TAG_BYTES]

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes:
        key = self._key(ref)
        if len(wrapped) < NONCE_BYTES + TAG_BYTES + 1:
            raise KeyUnavailable("not a wrapped key")
        nonce, tag, body = wrapped[:NONCE_BYTES], wrapped[NONCE_BYTES:NONCE_BYTES + TAG_BYTES], wrapped[NONCE_BYTES + TAG_BYTES:]
        try:
            return AESGCM(key).decrypt(nonce, body + tag, aad.encode("utf-8"))
        except Exception as exc:  # cryptography raises InvalidTag
            raise KeyUnavailable("the wrapped key does not open with this key") from exc


_KMS_REF = re.compile(
    r"^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/[a-z0-9-]{1,63}/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63}$")
_METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"  # noqa: S105 - an address, not a secret


def _crc32c_table() -> list[int]:
    table = []
    for n in range(256):
        c = n
        for _ in range(8):
            c = (0x82F63B78 ^ (c >> 1)) if c & 1 else (c >> 1)
        table.append(c)
    return table


_CRC_TABLE = _crc32c_table()


def crc32c(data: bytes) -> int:
    """CRC32C (Castagnoli), the checksum Cloud KMS uses."""
    c = 0xFFFFFFFF
    for byte in data:
        c = _CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >> 8)
    return c ^ 0xFFFFFFFF


TokenSource = Callable[[], tuple[str, float]]
"""Returns (access token, expiry as time.time())."""

Transport = Callable[[str, dict[str, str], bytes, float], tuple[int, bytes]]
"""POST url, headers, body, timeout -> (status, body). Tests pass a stand-in."""


def metadata_token() -> tuple[str, float]:
    """The service account's access token from the Cloud Run metadata server (never a key file)."""
    req = urllib.request.Request(_METADATA_TOKEN, headers={"Metadata-Flavor": "Google"})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:  # noqa: S310 - fixed http URL of the metadata server
            body = json.loads(res.read())
    except Exception as exc:
        raise KeyUnavailable("no access token from the metadata server") from exc
    token, expires = body.get("access_token"), body.get("expires_in")
    if not isinstance(token, str) or not token or not isinstance(expires, (int, float)):
        raise KeyUnavailable("no access token from the metadata server")
    return token, time.time() + float(expires)


def _https_post(url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes]:
    if not url.startswith("https://"):
        raise KeyUnavailable("the key service must be reached over https")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")  # noqa: S310 - https only, checked above
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - https only, checked above
            return res.status, res.read(65_536)
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except Exception as exc:
        raise KeyUnavailable("the key service did not answer") from exc


class GoogleKmsKeyService:
    """Cloud KMS `cryptoKeys.encrypt` and `decrypt` (REST v1, read 2026-10-24), with CRC32C checks both ways, as in
    the API."""

    kind = "google-kms"

    def __init__(self, tokens: TokenSource = metadata_token, transport: Transport = _https_post,
                 api: str = "https://cloudkms.googleapis.com") -> None:
        self._tokens = tokens
        self._transport = transport
        self._api = api
        self._cached: tuple[str, float] | None = None
        self._lock = threading.Lock()

    def valid_ref(self, ref: str) -> bool:
        return _KMS_REF.match(ref) is not None

    def _token(self) -> str:
        with self._lock:
            if self._cached is not None and self._cached[1] - 60 > time.time():
                return self._cached[0]
            try:
                self._cached = self._tokens()
            except KeyUnavailable:
                raise
            except Exception as exc:
                raise KeyUnavailable("no access token for the key service") from exc
            return self._cached[0]

    def _call(self, ref: str, verb: str, fields: dict[str, str]) -> dict[str, object]:
        if not self.valid_ref(ref):
            raise KeyUnavailable("not a Cloud KMS key reference")
        status, raw = self._transport(f"{self._api}/v1/{ref}:{verb}", {
            "authorization": f"Bearer {self._token()}", "content-type": "application/json", "accept": "application/json",
        }, json.dumps(fields).encode(), 5.0)
        if status == 401:
            with self._lock:
                self._cached = None
        if status != 200:
            # only the status: Google's message can name projects and keys
            raise KeyUnavailable(f"the key service refused (HTTP {status})")
        try:
            out = json.loads(raw)
        except Exception as exc:
            raise KeyUnavailable("the key service gave an unreadable answer") from exc
        if not isinstance(out, dict):
            raise KeyUnavailable("the key service gave an unreadable answer")
        return out

    def wrap(self, ref: str, data_key: bytes, aad: str) -> bytes:
        aad_bytes = aad.encode("utf-8")
        out = self._call(ref, "encrypt", {
            "plaintext": base64.b64encode(data_key).decode(), "plaintextCrc32c": str(crc32c(data_key)),
            "additionalAuthenticatedData": base64.b64encode(aad_bytes).decode(), "additionalAuthenticatedDataCrc32c": str(crc32c(aad_bytes)),
        })
        if out.get("verifiedPlaintextCrc32c") is not True or out.get("verifiedAdditionalAuthenticatedDataCrc32c") is not True:
            raise KeyUnavailable("the key service did not verify the request")
        try:
            ciphertext = base64.b64decode(str(out["ciphertext"]), validate=True)
        except Exception as exc:
            raise KeyUnavailable("the key service gave an unreadable answer") from exc
        if out.get("ciphertextCrc32c") != str(crc32c(ciphertext)):
            raise KeyUnavailable("the answer of the key service was damaged on the way")
        return ciphertext

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes:
        aad_bytes = aad.encode("utf-8")
        out = self._call(ref, "decrypt", {
            "ciphertext": base64.b64encode(wrapped).decode(), "ciphertextCrc32c": str(crc32c(wrapped)),
            "additionalAuthenticatedData": base64.b64encode(aad_bytes).decode(), "additionalAuthenticatedDataCrc32c": str(crc32c(aad_bytes)),
        })
        try:
            plaintext = base64.b64decode(str(out["plaintext"]), validate=True)
        except Exception as exc:
            raise KeyUnavailable("the key service gave an unreadable answer") from exc
        if out.get("plaintextCrc32c") != str(crc32c(plaintext)):
            raise KeyUnavailable("the answer of the key service was damaged on the way")
        return plaintext


class NoKeyService:
    kind = "none"

    def valid_ref(self, ref: str) -> bool:
        return False

    def wrap(self, ref: str, data_key: bytes, aad: str) -> bytes:
        raise KeyUnavailable("no key service is configured (KEY_SERVICE=none)")

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes:
        raise KeyUnavailable("no key service is configured (KEY_SERVICE=none)")


# ------------------------------------------------------------------ the content key and one sealed field

def wrap_aad(tenant_id: str, version: int) -> str:
    """What binds a company's own wrapped data key to its company and version - the same text the API uses."""
    return f"company-data-key:{tenant_id}:{version}"


def platform_wrap_aad(tenant_id: str, version: int) -> str:
    """What binds a data key wrapped by the platform's content key to its company and version."""
    return f"content-data-key:{tenant_id}:{version}"


_KEY_ID = re.compile(r"^(company|platform):([1-9][0-9]{0,5})$")


def parse_key_id(key_id: str) -> tuple[str, int]:
    """'company:3' -> ('company', 3). Anything else is refused."""
    m = _KEY_ID.match(key_id)
    if m is None:
        raise SealError("not a key id")
    return m.group(1), int(m.group(2))


def key_id_aad(tenant_id: str, key_id: str) -> str:
    """The text a key id's wrapped data key is bound to."""
    kind, version = parse_key_id(key_id)
    return wrap_aad(tenant_id, version) if kind == "company" else platform_wrap_aad(tenant_id, version)


def content_key(data_key: bytes, tenant_id: str, key_id: str) -> bytes:
    """The key that seals a company's content: derived for this purpose only, never the data key itself."""
    if len(data_key) != 32:
        raise SealError("a data key is 32 bytes")
    parse_key_id(key_id)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=f"legacyai-content-v1|{tenant_id}|{key_id}".encode()).derive(data_key)


@dataclass(frozen=True)
class FieldRef:
    """Where a sealed value lives. Part of what is sealed: a value moved anywhere else does not open."""

    tenant_id: str
    table: str
    column: str
    row_id: str
    key_id: str

    def aad(self) -> bytes:
        for part in (self.tenant_id, self.table, self.column, self.row_id):
            if not part or "|" in part:
                raise SealError("a field reference part is empty or contains |")
        parse_key_id(self.key_id)
        return f"legacyai-field-v1|{self.tenant_id}|{self.table}|{self.column}|{self.row_id}|{self.key_id}".encode()


def seal_bytes(key: bytes, data: bytes, ref: FieldRef) -> bytes:
    nonce = _nonce()
    return FORMAT_V1 + nonce + AESGCM(key).encrypt(nonce, data, ref.aad())


def open_bytes(key: bytes, sealed: bytes, ref: FieldRef) -> bytes:
    if len(sealed) < 1 + NONCE_BYTES + TAG_BYTES or sealed[:1] != FORMAT_V1:
        raise SealError("not a sealed value")
    try:
        return AESGCM(key).decrypt(sealed[1:1 + NONCE_BYTES], sealed[1 + NONCE_BYTES:], ref.aad())
    except Exception as exc:
        raise SealError("the sealed value does not open here") from exc


def fingerprint(key: bytes, text: str, ref: FieldRef) -> bytes:
    """A keyed fingerprint of `text` for the column `ref` names (its row is not part of it: equal values in different
    rows of that column must give the same fingerprint). 32 bytes."""
    info = FieldRef(ref.tenant_id, ref.table, ref.column, "fingerprint", ref.key_id).aad().replace(b"legacyai-field-v1", b"legacyai-fingerprint-v1")
    index_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(key)
    return hmac.new(index_key, text.encode("utf-8"), hashlib.sha256).digest()


def seal_text(key: bytes, text: str, ref: FieldRef) -> bytes:
    return seal_bytes(key, text.encode("utf-8"), ref)


def open_text(key: bytes, sealed: bytes, ref: FieldRef) -> str:
    return open_bytes(key, sealed, ref).decode("utf-8")


def seal_vector(key: bytes, vector: Sequence[float], ref: FieldRef) -> bytes:
    return seal_bytes(key, struct.pack(f"<{len(vector)}f", *vector), ref)


def open_vector(key: bytes, sealed: bytes, ref: FieldRef) -> list[float]:
    raw = open_bytes(key, sealed, ref)
    if len(raw) % 4 != 0:
        raise SealError("not a sealed vector")
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def _nonce() -> bytes:
    return os.urandom(NONCE_BYTES)


# ------------------------------------------------------------------ unwrapped keys, kept for a short time

class KeyCache:
    """Unwrapped data keys for at most `seconds` (5 minutes by default, D35). A failure is never cached."""

    def __init__(self, keys: KeyService, seconds: int = KEY_CACHE_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        self._keys = keys
        self._seconds = seconds
        self._clock = clock
        self._entries: dict[tuple[str, str], tuple[bytes, float]] = {}
        self._lock = threading.Lock()

    def content_key(self, tenant_id: str, key_id: str, ref: str, wrapped: bytes) -> bytes:
        now = self._clock()
        with self._lock:
            hit = self._entries.get((tenant_id, key_id))
            if hit is not None and hit[1] > now:
                return hit[0]
        data_key = self._keys.unwrap(ref, wrapped, key_id_aad(tenant_id, key_id))
        derived = content_key(data_key, tenant_id, key_id)
        with self._lock:
            self._entries[(tenant_id, key_id)] = (derived, now + self._seconds)
        return derived

    def forget(self, tenant_id: str) -> None:
        with self._lock:
            for k in [k for k in self._entries if k[0] == tenant_id]:
                del self._entries[k]


def key_service_from(kind: str, local_keys: dict[str, bytes] | None = None) -> KeyService:
    if kind == "local":
        return LocalKeyService(local_keys or {})
    if kind == "google-kms":
        return GoogleKmsKeyService()
    return NoKeyService()
