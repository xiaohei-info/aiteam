"""Tests for shared/crypto module.

Validates production key management and credential encryption functionality.
"""

import os
import json
import pytest
from cryptography.fernet import Fernet, InvalidToken

from shared.crypto import KeyManager, KeyRotationError, CredentialEncryptor


class TestKeyManager:
    """Tests for KeyManager."""

    def test_generate_key(self):
        """Generated key should be valid Fernet key."""
        key = KeyManager.generate_key()
        assert isinstance(key, str)
        assert len(key) > 0

        # Should be valid Fernet key
        key_bytes = key.encode('utf-8')
        f = Fernet(key_bytes)
        assert f is not None

    def test_load_single_key(self, monkeypatch):
        """Should load single key from environment."""
        test_key = KeyManager.generate_key()
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY", test_key)

        km = KeyManager()
        assert km.get_primary_version() == 1
        assert km.get_primary_key() == test_key.encode('utf-8')
        assert km.list_versions() == [1]

    def test_load_versioned_keys(self, monkeypatch):
        """Should load multiple versioned keys."""
        key1 = KeyManager.generate_key()
        key2 = KeyManager.generate_key()
        keys_json = json.dumps({"1": key1, "2": key2})

        monkeypatch.setenv("AITEAM_ENCRYPTION_KEYS", keys_json)
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY_VERSION", "2")

        km = KeyManager()
        assert km.get_primary_version() == 2
        assert km.get_primary_key() == key2.encode('utf-8')
        assert km.list_versions() == [1, 2]
        assert km.has_version(1)
        assert km.has_version(2)

    def test_load_versioned_keys_default_primary(self, monkeypatch):
        """Should use latest version as primary if not specified."""
        key1 = KeyManager.generate_key()
        key2 = KeyManager.generate_key()
        key3 = KeyManager.generate_key()
        keys_json = json.dumps({"1": key1, "2": key2, "3": key3})

        monkeypatch.setenv("AITEAM_ENCRYPTION_KEYS", keys_json)

        km = KeyManager()
        assert km.get_primary_version() == 3

    def test_no_keys_raises_error(self, monkeypatch):
        """Should fail fast if no keys configured."""
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEY", raising=False)
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEYS", raising=False)

        with pytest.raises(KeyRotationError) as exc_info:
            KeyManager()

        assert "No encryption keys found" in str(exc_info.value)

    def test_invalid_key_format_raises_error(self, monkeypatch):
        """Should reject invalid Fernet keys."""
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY", "not-a-valid-key")

        with pytest.raises(KeyRotationError) as exc_info:
            KeyManager()

        assert "Invalid encryption key" in str(exc_info.value)

    def test_invalid_json_raises_error(self, monkeypatch):
        """Should reject invalid JSON format."""
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEYS", "not valid json")

        with pytest.raises(KeyRotationError) as exc_info:
            KeyManager()

        assert "Invalid encryption keys format" in str(exc_info.value)

    def test_add_key_version(self, monkeypatch):
        """Should add new key version."""
        key1 = KeyManager.generate_key()
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY", key1)

        km = KeyManager()
        assert km.list_versions() == [1]

        # Add new version
        key2 = Fernet.generate_key()
        km.add_key_version(2, key2)

        assert km.list_versions() == [1, 2]
        assert km.get_key(2) == key2

    def test_add_duplicate_version_raises_error(self, monkeypatch):
        """Should reject duplicate version numbers."""
        key1 = KeyManager.generate_key()
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY", key1)

        km = KeyManager()

        key2 = Fernet.generate_key()
        with pytest.raises(KeyRotationError) as exc_info:
            km.add_key_version(1, key2)

        assert "already exists" in str(exc_info.value)

    def test_promote_version(self, monkeypatch):
        """Should promote version to primary."""
        key1 = KeyManager.generate_key()
        key2 = KeyManager.generate_key()
        keys_json = json.dumps({"1": key1, "2": key2})

        monkeypatch.setenv("AITEAM_ENCRYPTION_KEYS", keys_json)
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY_VERSION", "1")

        km = KeyManager()
        assert km.get_primary_version() == 1

        km.promote_version(2)
        assert km.get_primary_version() == 2

    def test_promote_nonexistent_version_raises_error(self, monkeypatch):
        """Should reject promoting nonexistent version."""
        key1 = KeyManager.generate_key()
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY", key1)

        km = KeyManager()

        with pytest.raises(KeyRotationError) as exc_info:
            km.promote_version(99)

        assert "not found" in str(exc_info.value)


class TestCredentialEncryptor:
    """Tests for CredentialEncryptor."""

    @pytest.fixture
    def key_manager(self, monkeypatch):
        """Provide a key manager with test keys."""
        key1 = KeyManager.generate_key()
        key2 = KeyManager.generate_key()
        keys_json = json.dumps({"1": key1, "2": key2})

        monkeypatch.setenv("AITEAM_ENCRYPTION_KEYS", keys_json)
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY_VERSION", "2")

        return KeyManager()

    @pytest.fixture
    def encryptor(self, key_manager):
        """Provide a credential encryptor."""
        return CredentialEncryptor(key_manager)

    def test_encrypt_decrypt_roundtrip(self, encryptor):
        """Should encrypt and decrypt successfully."""
        plaintext = "sk-1234567890abcdef"
        encrypted = encryptor.encrypt(plaintext)

        assert encrypted.startswith("v2:")
        assert encrypted != plaintext

        decrypted = encryptor.decrypt(encrypted)
        assert decrypted == plaintext

    def test_encrypt_empty_raises_error(self, encryptor):
        """Should reject empty credentials."""
        with pytest.raises(ValueError) as exc_info:
            encryptor.encrypt("")

        assert "empty credential" in str(exc_info.value)

    def test_decrypt_with_old_key_version(self, key_manager):
        """Should decrypt credential encrypted with old key."""
        # Encrypt with version 1 (old key)
        key_manager.promote_version(1)
        encryptor = CredentialEncryptor(key_manager)
        plaintext = "old-secret-key"
        encrypted = encryptor.encrypt(plaintext)

        assert encrypted.startswith("v1:")

        # Switch to version 2 (new key) and decrypt
        key_manager.promote_version(2)
        encryptor = CredentialEncryptor(key_manager)
        decrypted = encryptor.decrypt(encrypted)

        assert decrypted == plaintext

    def test_decrypt_invalid_format_raises_error(self, encryptor):
        """Should reject invalid format."""
        with pytest.raises(ValueError) as exc_info:
            encryptor.decrypt("no-version-prefix")

        assert "Invalid encrypted credential format" in str(exc_info.value)

    def test_decrypt_invalid_version_prefix_raises_error(self, encryptor):
        """Should reject invalid version prefix."""
        with pytest.raises(ValueError) as exc_info:
            encryptor.decrypt("x1:ciphertext")

        assert "Invalid version prefix" in str(exc_info.value)

    def test_decrypt_nonexistent_version_raises_error(self, encryptor):
        """Should reject unknown key version."""
        with pytest.raises(KeyRotationError) as exc_info:
            encryptor.decrypt("v99:gAAAAABhtest")

        assert "version 99 not found" in str(exc_info.value)

    def test_decrypt_wrong_key_raises_error(self, encryptor, monkeypatch):
        """Should reject decryption with wrong key."""
        # Encrypt with one key
        plaintext = "secret"
        encrypted = encryptor.encrypt(plaintext)

        # Extract version from encrypted credential
        version = encryptor.get_version(encrypted)

        # Create new encryptor with different key but same version number
        new_key = KeyManager.generate_key()
        keys_json = json.dumps({str(version): new_key})
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEYS", keys_json)
        monkeypatch.setenv("AITEAM_ENCRYPTION_KEY_VERSION", str(version))
        new_km = KeyManager()
        new_encryptor = CredentialEncryptor(new_km)

        with pytest.raises(InvalidToken):
            new_encryptor.decrypt(encrypted)

    def test_re_encrypt(self, key_manager):
        """Should re-encrypt with current primary key."""
        # Encrypt with version 1
        key_manager.promote_version(1)
        encryptor = CredentialEncryptor(key_manager)
        plaintext = "my-api-key"
        encrypted_v1 = encryptor.encrypt(plaintext)

        assert encrypted_v1.startswith("v1:")

        # Re-encrypt with version 2
        key_manager.promote_version(2)
        encryptor = CredentialEncryptor(key_manager)
        encrypted_v2 = encryptor.re_encrypt(encrypted_v1)

        assert encrypted_v2.startswith("v2:")
        assert encrypted_v2 != encrypted_v1

        # Verify content is preserved
        decrypted = encryptor.decrypt(encrypted_v2)
        assert decrypted == plaintext

    def test_get_version(self, encryptor):
        """Should extract version from encrypted credential."""
        plaintext = "test-key"
        encrypted = encryptor.encrypt(plaintext)

        version = encryptor.get_version(encrypted)
        assert version == 2

    def test_get_version_invalid_format(self, encryptor):
        """Should return None for invalid format."""
        assert encryptor.get_version("no-version") is None
        assert encryptor.get_version("x1:invalid") is None
        assert encryptor.get_version("") is None

    def test_needs_rotation(self, key_manager):
        """Should detect credentials needing rotation."""
        # Encrypt with version 1
        key_manager.promote_version(1)
        encryptor = CredentialEncryptor(key_manager)
        encrypted_v1 = encryptor.encrypt("old-key")

        # Switch to version 2
        key_manager.promote_version(2)
        encryptor = CredentialEncryptor(key_manager)

        # Version 1 credential needs rotation
        assert encryptor.needs_rotation(encrypted_v1) is True

        # New version 2 credential doesn't need rotation
        encrypted_v2 = encryptor.encrypt("new-key")
        assert encryptor.needs_rotation(encrypted_v2) is False

    def test_unicode_credentials(self, encryptor):
        """Should handle Unicode credentials correctly."""
        plaintext = "密钥-🔑-clé-Schlüssel"
        encrypted = encryptor.encrypt(plaintext)
        decrypted = encryptor.decrypt(encrypted)

        assert decrypted == plaintext
