"""Tests for shared/crypto/service.py (CryptoService + build_crypto_service).

Covers all branches: encrypt/decrypt None guards, injected vs default Fernet,
_load_key env-vs-dev fallback, and build_crypto_service factory.
"""

import os
import pytest
from cryptography.fernet import Fernet

from shared.crypto.service import CryptoService, build_crypto_service, _load_key, _default_fernet, _DEV_KEY


class TestCryptoService:
    """Tests for CryptoService encrypt/decrypt and Fernet injection paths."""

    def test_encrypt_none_raises(self):
        svc = CryptoService(fernet=Fernet.generate_key())
        with pytest.raises(ValueError, match="plaintext secret must not be None"):
            svc.encrypt(None)

    def test_decrypt_none_raises(self):
        svc = CryptoService(fernet=Fernet.generate_key())
        with pytest.raises(ValueError, match="encrypted token must not be None"):
            svc.decrypt(None)

    def test_encrypt_decrypt_roundtrip_injected_fernet(self):
        key = Fernet.generate_key()
        f = Fernet(key)
        svc = CryptoService(fernet=f)
        token = svc.encrypt("sk-secret-12345")
        assert isinstance(token, bytes)
        assert svc.decrypt(token) == "sk-secret-12345"

    def test_encrypt_decrypt_roundtrip_default_fernet(self):
        # fernet=None → uses _default_fernet (lru_cache'd)
        _default_fernet.cache_clear()
        svc = CryptoService()  # fernet=None path
        token = svc.encrypt("hello")
        assert svc.decrypt(token) == "hello"

    def test_get_uses_injected_fernet(self):
        # Inject a distinct Fernet; _get should return it, not the default
        key = Fernet.generate_key()
        f = Fernet(key)
        svc = CryptoService(fernet=f)
        assert svc._get() is f

    def test_get_falls_back_to_default(self):
        _default_fernet.cache_clear()
        svc = CryptoService()
        f = svc._get()
        assert isinstance(f, Fernet)
        # Same instance from cache on second call
        assert svc._get() is f

    def test_unicode_roundtrip(self):
        svc = CryptoService(fernet=Fernet(Fernet.generate_key()))
        plaintext = "密钥-🔑-clé"
        assert svc.decrypt(svc.encrypt(plaintext)) == plaintext


class TestLoadKey:
    """Tests for _load_key env-vs-fail-closed behavior (AITEAM-331 B1)."""

    def test_load_key_from_env(self, monkeypatch):
        key = Fernet.generate_key().decode("utf-8")
        monkeypatch.setenv("MANAGER_CREDENTIAL_KEY", key)
        assert _load_key() == key.encode("utf-8")

    def test_load_key_fails_closed_when_unset(self, monkeypatch):
        # AITEAM-331 B1: missing env key must raise (no silent dev fallback).
        monkeypatch.delenv("MANAGER_CREDENTIAL_KEY", raising=False)
        with pytest.raises(RuntimeError, match="MANAGER_CREDENTIAL_KEY is not configured"):
            _load_key()

    def test_default_fernet_uses_env_key(self, monkeypatch):
        key = Fernet.generate_key().decode("utf-8")
        monkeypatch.setenv("MANAGER_CREDENTIAL_KEY", key)
        _default_fernet.cache_clear()
        f = _default_fernet()
        assert isinstance(f, Fernet)
        # Verify it actually uses the env key by encrypting/decrypting
        token = f.encrypt(b"test")
        assert Fernet(key.encode("utf-8")).decrypt(token) == b"test"

    def test_default_fernet_fails_closed_without_env(self, monkeypatch):
        # AITEAM-331 B1: no env key → default Fernet construction must raise.
        monkeypatch.delenv("MANAGER_CREDENTIAL_KEY", raising=False)
        _default_fernet.cache_clear()
        with pytest.raises(RuntimeError, match="MANAGER_CREDENTIAL_KEY is not configured"):
            _default_fernet()


class TestBuildCryptoService:
    """Tests for build_crypto_service factory."""

    def test_returns_crypto_service_instance(self):
        svc = build_crypto_service()
        assert isinstance(svc, CryptoService)
        # fernet is None → will lazily use default
        assert svc._fernet is None

    def test_build_then_encrypt_decrypt(self):
        _default_fernet.cache_clear()
        svc = build_crypto_service()
        token = svc.encrypt("provider-api-key")
        assert svc.decrypt(token) == "provider-api-key"
