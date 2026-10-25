"""Sealing a company's content (decision D41, step 2): the key services that unwrap a company's data key, the content
key, one sealed field, and the short-lived key cache. Stand-ins only: no key service, no cloud account. The made-up
keys below exist only in this file."""

from __future__ import annotations

import base64
import json
import os

import pytest

from app.platform.sealing import (
    FieldRef,
    GoogleKmsKeyService,
    KeyCache,
    KeyUnavailable,
    LocalKeyService,
    NoKeyService,
    SealError,
    content_key,
    crc32c,
    key_service_from,
    open_bytes,
    open_text,
    open_vector,
    seal_bytes,
    seal_text,
    seal_vector,
    wrap_aad,
)

TENANT = "00000000-0000-4000-8000-0000000000aa"
FIXTURE_KEY = bytes([7]) * 32                          # the made-up key the API test used
FIXTURE_DATA_KEY = bytes(range(32))                    # 00 01 02 ... 1f
# Wrapped by the API's own LocalKeyService (services/api, TypeScript) with FIXTURE_KEY, for company TENANT, version 1.
FIXTURE_WRAPPED = base64.b64decode("tIipAy6tWei4nn0UyNNUF2chfe3LyiBUQ4ninDgJzEfNd6TXa7n3/In/B+9O1SZ5YcBG3fiKkSJ6RNxT")
KMS_KEY = "projects/acme-prod-1234/locations/europe-west3/keyRings/legacyai/cryptoKeys/company-data"


def ref(row: str = "row-1", column: str = "text", tenant: str = TENANT, version: int = 1) -> FieldRef:
    return FieldRef(tenant_id=tenant, table="chunks", column=column, row_id=row, key_id=f"company:{version}")


# ------------------------------------------------------------------ the API and the AI service agree

def test_the_ai_service_opens_what_the_api_wrapped() -> None:
    local = LocalKeyService({"fixture": FIXTURE_KEY})
    assert local.unwrap("local:fixture", FIXTURE_WRAPPED, wrap_aad(TENANT, 1)) == FIXTURE_DATA_KEY
    # bound to the company and the version, exactly as the API binds it
    with pytest.raises(KeyUnavailable):
        local.unwrap("local:fixture", FIXTURE_WRAPPED, wrap_aad(TENANT, 2))
    with pytest.raises(KeyUnavailable):
        local.unwrap("local:fixture", FIXTURE_WRAPPED, wrap_aad("00000000-0000-4000-8000-0000000000bb", 1))


def test_the_local_stand_in_refuses_what_a_real_service_would() -> None:
    local = LocalKeyService({"fixture": FIXTURE_KEY})
    with pytest.raises(KeyUnavailable):
        local.unwrap("local:nobody", FIXTURE_WRAPPED, wrap_aad(TENANT, 1))
    with pytest.raises(KeyUnavailable):
        local.unwrap(KMS_KEY, FIXTURE_WRAPPED, wrap_aad(TENANT, 1))
    local.disable("fixture")
    with pytest.raises(KeyUnavailable):
        local.unwrap("local:fixture", FIXTURE_WRAPPED, wrap_aad(TENANT, 1))
    local.enable("fixture")
    assert local.unwrap("local:fixture", FIXTURE_WRAPPED, wrap_aad(TENANT, 1)) == FIXTURE_DATA_KEY
    with pytest.raises(KeyUnavailable):
        NoKeyService().unwrap("local:fixture", FIXTURE_WRAPPED, wrap_aad(TENANT, 1))
    assert {key_service_from(k).kind for k in ("none", "local", "google-kms", "anything")} == {"none", "local", "google-kms"}


# ------------------------------------------------------------------ the content key and one field

def test_the_content_key_is_derived_per_company_and_version_never_the_data_key_itself() -> None:
    k1 = content_key(FIXTURE_DATA_KEY, TENANT, "company:1")
    assert len(k1) == 32 and k1 != FIXTURE_DATA_KEY
    assert k1 == content_key(FIXTURE_DATA_KEY, TENANT, "company:1")              # the same every time
    assert k1 != content_key(FIXTURE_DATA_KEY, TENANT, "company:2")
    assert k1 != content_key(FIXTURE_DATA_KEY, "00000000-0000-4000-8000-0000000000bb", "company:1")
    with pytest.raises(SealError):
        content_key(b"short", TENANT, "company:1")


def test_a_sealed_field_opens_only_at_its_own_place() -> None:
    key = content_key(FIXTURE_DATA_KEY, TENANT, "company:1")
    sealed = seal_text(key, "How the cooling pump is restarted after a power cut.", ref())
    assert b"cooling" not in sealed
    assert open_text(key, sealed, ref()) == "How the cooling pump is restarted after a power cut."
    # copied to another row, column, company, version, or opened with another key: refused
    for elsewhere in (ref(row="row-2"), ref(column="title"), ref(tenant="00000000-0000-4000-8000-0000000000bb"), ref(version=2)):
        with pytest.raises(SealError):
            open_text(key, sealed, elsewhere)
    with pytest.raises(SealError):
        open_text(content_key(FIXTURE_DATA_KEY, TENANT, "company:2"), sealed, ref())
    # one changed byte, a cut-off value, or not a sealed value at all
    damaged = bytearray(sealed)
    damaged[-1] ^= 1
    for bad in (bytes(damaged), sealed[:20], b"\x02" + sealed[1:], b"plain text"):
        with pytest.raises(SealError):
            open_bytes(key, bad, ref())


def test_every_sealing_uses_a_fresh_nonce() -> None:
    key = content_key(FIXTURE_DATA_KEY, TENANT, "company:1")
    a, b = seal_bytes(key, b"same", ref()), seal_bytes(key, b"same", ref())
    assert a != b and a[1:13] != b[1:13]


def test_a_vector_round_trips_as_float32() -> None:
    key = content_key(FIXTURE_DATA_KEY, TENANT, "company:1")
    vector = [0.125, -0.5, 0.0, 1.0] + [0.01 * i for i in range(380)]
    sealed = seal_vector(key, vector, ref(column="embedding"))
    assert len(sealed) == 1 + 12 + 384 * 4 + 16
    back = open_vector(key, sealed, ref(column="embedding"))
    assert back[:4] == [0.125, -0.5, 0.0, 1.0]
    assert all(abs(x - y) < 1e-6 for x, y in zip(back, vector, strict=True))


def test_a_field_reference_cannot_be_made_ambiguous() -> None:
    key = content_key(FIXTURE_DATA_KEY, TENANT, "company:1")
    for bad in (FieldRef(TENANT, "chunks", "te|xt", "row", "company:1"), FieldRef(TENANT, "chunks", "text", "", "company:1"),
                FieldRef(TENANT, "chunks", "text", "row", "company:0"), FieldRef(TENANT, "chunks", "text", "row", "mine:1")):
        with pytest.raises(SealError):
            seal_text(key, "x", bad)


# ------------------------------------------------------------------ the short-lived key cache

def test_unwrapped_keys_are_kept_five_minutes_and_a_switched_off_key_stops_working_after_that() -> None:
    now = [1000.0]
    local = LocalKeyService({"fixture": FIXTURE_KEY})
    cache = KeyCache(local, clock=lambda: now[0])
    first = cache.content_key(TENANT, "company:1", "local:fixture", FIXTURE_WRAPPED)
    assert first == content_key(FIXTURE_DATA_KEY, TENANT, "company:1")
    local.disable("fixture")
    now[0] += 299
    assert cache.content_key(TENANT, "company:1", "local:fixture", FIXTURE_WRAPPED) == first   # still within 5 minutes
    now[0] += 2
    with pytest.raises(KeyUnavailable):
        cache.content_key(TENANT, "company:1", "local:fixture", FIXTURE_WRAPPED)
    local.enable("fixture")
    assert cache.content_key(TENANT, "company:1", "local:fixture", FIXTURE_WRAPPED) == first
    cache.forget(TENANT)
    local.disable("fixture")
    with pytest.raises(KeyUnavailable):                                                # forgotten: asked again
        cache.content_key(TENANT, "company:1", "local:fixture", FIXTURE_WRAPPED)


# ------------------------------------------------------------------ Cloud KMS (a stand-in transport)

class FakeKms:
    """Answers cryptoKeys.decrypt as documented (REST v1, read 2026-10-24); the 'wrapped' value is the plaintext
    reversed, which is enough to test the request, the checksums and the refusals."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str], dict[str, str]]] = []
        self.status = 200
        self.damage = False
        self.once_401 = False

    def __call__(self, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes]:
        sent = json.loads(body)
        self.calls.append((url, headers, sent))
        if self.once_401:
            self.once_401 = False
            return 401, b""
        if self.status != 200:
            return self.status, b'{"error":{"message":"projects/acme-prod-1234/... is disabled"}}'
        plaintext = base64.b64decode(sent["ciphertext"])[::-1]
        return 200, json.dumps({
            "plaintext": base64.b64encode(plaintext).decode(),
            "plaintextCrc32c": "1" if self.damage else str(crc32c(plaintext)),
        }).encode()


def kms_with(fake: FakeKms, tokens: list[int]) -> GoogleKmsKeyService:
    def token() -> tuple[str, float]:
        tokens.append(1)
        import time
        return f"test-access-token-{len(tokens)}", time.time() + 3600
    return GoogleKmsKeyService(tokens=token, transport=fake, api="https://kms.test")


def test_crc32c_is_castagnoli() -> None:
    assert crc32c(b"123456789") == 0xE3069283
    assert crc32c(b"") == 0


def test_kms_decrypt_is_the_documented_request_with_checksums_and_a_bearer_token() -> None:
    fake, tokens = FakeKms(), []
    kms = kms_with(fake, tokens)
    data_key = os.urandom(32)
    assert kms.unwrap(KMS_KEY, data_key[::-1], wrap_aad(TENANT, 1)) == data_key
    url, headers, sent = fake.calls[-1]
    assert url == f"https://kms.test/v1/{KMS_KEY}:decrypt"
    assert headers["authorization"] == "Bearer test-access-token-1"
    aad = wrap_aad(TENANT, 1).encode()
    assert sent == {
        "ciphertext": base64.b64encode(data_key[::-1]).decode(), "ciphertextCrc32c": str(crc32c(data_key[::-1])),
        "additionalAuthenticatedData": base64.b64encode(aad).decode(), "additionalAuthenticatedDataCrc32c": str(crc32c(aad)),
    }
    kms.unwrap(KMS_KEY, data_key[::-1], wrap_aad(TENANT, 1))
    assert len(tokens) == 1                                    # the token is reused


def test_kms_refusals_damage_and_a_401_all_fail_closed_without_repeating_google() -> None:
    fake, tokens = FakeKms(), []
    kms = kms_with(fake, tokens)
    fake.status = 400                                          # FAILED_PRECONDITION: the key version is disabled
    with pytest.raises(KeyUnavailable) as err:
        kms.unwrap(KMS_KEY, b"x" * 40, wrap_aad(TENANT, 1))
    assert "HTTP 400" in str(err.value) and "acme-prod" not in str(err.value)
    fake.status = 200
    fake.damage = True
    with pytest.raises(KeyUnavailable):
        kms.unwrap(KMS_KEY, b"x" * 40, wrap_aad(TENANT, 1))
    fake.damage = False
    fake.once_401 = True
    with pytest.raises(KeyUnavailable):
        kms.unwrap(KMS_KEY, b"x" * 40, wrap_aad(TENANT, 1))
    kms.unwrap(KMS_KEY, b"x" * 40, wrap_aad(TENANT, 1))
    assert len(tokens) == 2                                    # the 401 dropped the token; a fresh one was fetched
    # not a key name: no request at all
    before = len(fake.calls)
    for bad in ("local:fixture", f"{KMS_KEY}/cryptoKeyVersions/1", "https://cloudkms.googleapis.com/v1/x"):
        with pytest.raises(KeyUnavailable):
            kms.unwrap(bad, b"x" * 40, wrap_aad(TENANT, 1))
    assert len(fake.calls) == before


def test_no_token_means_no_key() -> None:
    def broken() -> tuple[str, float]:
        raise OSError("metadata server unreachable")
    kms = GoogleKmsKeyService(tokens=broken, transport=FakeKms(), api="https://kms.test")
    with pytest.raises(KeyUnavailable):
        kms.unwrap(KMS_KEY, b"x" * 40, wrap_aad(TENANT, 1))


# ------------------------------------------------------------------ wrapping (step 4b: the platform's content key)

def test_the_local_stand_in_wraps_in_the_apis_format() -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    local = LocalKeyService({"platform": FIXTURE_KEY})
    data_key = os.urandom(32)
    wrapped = local.wrap("local:platform", data_key, "content-data-key:t:1")
    assert len(wrapped) == 12 + 16 + 32 and data_key not in wrapped
    nonce, tag, body = wrapped[:12], wrapped[12:28], wrapped[28:]        # nonce | tag | ciphertext, as the API writes it
    assert AESGCM(FIXTURE_KEY).decrypt(nonce, body + tag, b"content-data-key:t:1") == data_key
    assert local.unwrap("local:platform", wrapped, "content-data-key:t:1") == data_key
    with pytest.raises(KeyUnavailable):
        local.unwrap("local:platform", wrapped, "content-data-key:t:2")
    local.disable("platform")
    with pytest.raises(KeyUnavailable):
        local.wrap("local:platform", data_key, "content-data-key:t:1")
    with pytest.raises(KeyUnavailable):
        NoKeyService().wrap("local:platform", data_key, "x")


def test_key_ids_name_one_data_key_and_platform_keys_are_bound_apart() -> None:
    from app.platform.sealing import key_id_aad, parse_key_id

    assert parse_key_id("company:3") == ("company", 3) and parse_key_id("platform:1") == ("platform", 1)
    for bad in ("company:0", "platform:-1", "mine:1", "company:1:2", "company:", "", "platform:1234567"):
        with pytest.raises(SealError):
            parse_key_id(bad)
    assert key_id_aad(TENANT, "company:1") == wrap_aad(TENANT, 1)
    assert key_id_aad(TENANT, "platform:1") == f"content-data-key:{TENANT}:1"
    # the same data key gives a different content key as a company key and as a platform key
    assert content_key(FIXTURE_DATA_KEY, TENANT, "company:1") != content_key(FIXTURE_DATA_KEY, TENANT, "platform:1")


class FakeKmsEncrypt(FakeKms):
    """Adds cryptoKeys.encrypt as documented: the 'ciphertext' is the plaintext reversed."""

    def __init__(self) -> None:
        super().__init__()
        self.unverified = False

    def __call__(self, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes]:
        if not url.endswith(":encrypt"):
            return super().__call__(url, headers, body, timeout)
        sent = json.loads(body)
        self.calls.append((url, headers, sent))
        if self.status != 200:
            return self.status, b'{"error":{"message":"projects/acme-prod-1234/... permission denied"}}'
        plaintext = base64.b64decode(sent["plaintext"])
        ok = sent["plaintextCrc32c"] == str(crc32c(plaintext)) and not self.unverified
        ct = plaintext[::-1]
        return 200, json.dumps({"name": f"{KMS_KEY}/cryptoKeyVersions/1", "ciphertext": base64.b64encode(ct).decode(),
                                "ciphertextCrc32c": "1" if self.damage else str(crc32c(ct)),
                                "verifiedPlaintextCrc32c": ok, "verifiedAdditionalAuthenticatedDataCrc32c": ok}).encode()


def test_kms_encrypt_is_the_documented_request_and_refuses_what_does_not_add_up() -> None:
    fake, tokens = FakeKmsEncrypt(), []
    kms = GoogleKmsKeyService(tokens=lambda: (tokens.append(1) or "test-access-token", 9e18), transport=fake, api="https://kms.test")
    data_key = os.urandom(32)
    wrapped = kms.wrap(KMS_KEY, data_key, f"content-data-key:{TENANT}:1")
    assert wrapped == data_key[::-1]
    url, _, sent = fake.calls[-1]
    aad = f"content-data-key:{TENANT}:1".encode()
    assert url == f"https://kms.test/v1/{KMS_KEY}:encrypt"
    assert sent == {"plaintext": base64.b64encode(data_key).decode(), "plaintextCrc32c": str(crc32c(data_key)),
                    "additionalAuthenticatedData": base64.b64encode(aad).decode(), "additionalAuthenticatedDataCrc32c": str(crc32c(aad))}
    assert kms.unwrap(KMS_KEY, wrapped, f"content-data-key:{TENANT}:1") == data_key
    fake.unverified = True                                   # KMS did not confirm our checksums
    with pytest.raises(KeyUnavailable):
        kms.wrap(KMS_KEY, data_key, "x")
    fake.unverified, fake.damage = False, True                # its answer was damaged on the way
    with pytest.raises(KeyUnavailable):
        kms.wrap(KMS_KEY, data_key, "x")
    fake.damage, fake.status = False, 403                     # permission taken back
    with pytest.raises(KeyUnavailable):
        kms.wrap(KMS_KEY, data_key, "x")
