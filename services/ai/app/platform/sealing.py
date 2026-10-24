"""Sealing a company's content with its own content key (decision D41, docs/phase4/10-content-under-company-key.md, step 2).

NOTHING USES THIS YET. It is the toolbox the next steps build on, tested on its own:

* key services that UNWRAP a company's data key: the local stand-in (tests and development; the same format as the
  API's LocalKeyService, so the AI service opens what the API wrapped) and Google Cloud KMS (the same two REST calls
  as the API's gcp-kms.ts, with this service's own service account). The AI service never wraps: the API makes data
  keys; nobody hands a key over in a request;
* the content key: HKDF-SHA256 from the company's data key, bound to the company and the key version, for one purpose
  ("content") - so it is never the same key that seals the API's secrets;
* sealing one field: AES-256-GCM, a format byte, a fresh 12-byte nonce, and associated data that names the field's
  exact place (company, table, column, row, key version). A sealed value copied to another row, column, company or
  version does not open;
* vectors (embeddings) are sealed as their float32 bytes;
* unwrapped data keys are kept for at most 5 minutes (as in the API, D35): switched off at the key service, a
  company's content stops opening within that time.
"""

from __future__ import annotations

import base64
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

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes: ...


# ------------------------------------------------------------------ key services (unwrap only)

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

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes:
        m = _LOCAL_REF.match(ref)
        if m is None:
            raise KeyUnavailable("not a local key reference")
        key = self._keys.get(m.group(1))
        if key is None:
            raise KeyUnavailable("unknown key")
        if m.group(1) in self._off:
            raise KeyUnavailable("the key is switched off")
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
    """Cloud KMS `cryptoKeys.decrypt` (REST v1, read 2026-10-24), with CRC32C checks both ways, as in the API."""

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

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes:
        if not self.valid_ref(ref):
            raise KeyUnavailable("not a Cloud KMS key reference")
        aad_bytes = aad.encode("utf-8")
        body = json.dumps({
            "ciphertext": base64.b64encode(wrapped).decode(), "ciphertextCrc32c": str(crc32c(wrapped)),
            "additionalAuthenticatedData": base64.b64encode(aad_bytes).decode(), "additionalAuthenticatedDataCrc32c": str(crc32c(aad_bytes)),
        }).encode()
        status, raw = self._transport(f"{self._api}/v1/{ref}:decrypt", {
            "authorization": f"Bearer {self._token()}", "content-type": "application/json", "accept": "application/json",
        }, body, 5.0)
        if status == 401:
            with self._lock:
                self._cached = None
        if status != 200:
            # only the status: Google's message can name projects and keys
            raise KeyUnavailable(f"the key service refused (HTTP {status})")
        try:
            out = json.loads(raw)
            plaintext = base64.b64decode(out["plaintext"], validate=True)
        except Exception as exc:
            raise KeyUnavailable("the key service gave an unreadable answer") from exc
        if out.get("plaintextCrc32c") != str(crc32c(plaintext)):
            raise KeyUnavailable("the answer of the key service was damaged on the way")
        return plaintext


class NoKeyService:
    kind = "none"

    def valid_ref(self, ref: str) -> bool:
        return False

    def unwrap(self, ref: str, wrapped: bytes, aad: str) -> bytes:
        raise KeyUnavailable("no key service is configured (KEY_SERVICE=none)")


# ------------------------------------------------------------------ the content key and one sealed field

def wrap_aad(tenant_id: str, version: int) -> str:
    """What binds a wrapped data key to its company and version - the same text the API uses."""
    return f"company-data-key:{tenant_id}:{version}"


def content_key(data_key: bytes, tenant_id: str, version: int) -> bytes:
    """The key that seals a company's content: derived for this purpose only, never the data key itself."""
    if len(data_key) != 32:
        raise SealError("a data key is 32 bytes")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=f"legacyai-content-v1|{tenant_id}|{version}".encode()).derive(data_key)


@dataclass(frozen=True)
class FieldRef:
    """Where a sealed value lives. Part of what is sealed: a value moved anywhere else does not open."""

    tenant_id: str
    table: str
    column: str
    row_id: str
    key_version: int

    def aad(self) -> bytes:
        for part in (self.tenant_id, self.table, self.column, self.row_id):
            if not part or "|" in part:
                raise SealError("a field reference part is empty or contains |")
        return f"legacyai-field-v1|{self.tenant_id}|{self.table}|{self.column}|{self.row_id}|{self.key_version}".encode()


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
        self._entries: dict[tuple[str, int], tuple[bytes, float]] = {}
        self._lock = threading.Lock()

    def content_key(self, tenant_id: str, version: int, ref: str, wrapped: bytes) -> bytes:
        now = self._clock()
        with self._lock:
            hit = self._entries.get((tenant_id, version))
            if hit is not None and hit[1] > now:
                return hit[0]
        data_key = self._keys.unwrap(ref, wrapped, wrap_aad(tenant_id, version))
        derived = content_key(data_key, tenant_id, version)
        with self._lock:
            self._entries[(tenant_id, version)] = (derived, now + self._seconds)
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
