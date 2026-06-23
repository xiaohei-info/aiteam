"""Credential encryption and decryption with key rotation support.

Handles encryption of provider credentials (API keys, OAuth tokens, etc.)
with versioned keys for zero-downtime rotation.

Encrypted format:
    v{version}:{base64_ciphertext}

Example:
    v1:gAAAAABh... (encrypted with key version 1)
    v2:gAAAAABi... (encrypted with key version 2)
"""

from typing import Optional
from cryptography.fernet import Fernet, InvalidToken

from .key_manager import KeyManager, KeyRotationError


class CredentialEncryptor:
    """Encrypts and decrypts provider credentials with key rotation support.

    Uses Fernet (symmetric encryption) for credential encryption.
    Supports multiple key versions for zero-downtime rotation.

    Usage:
        # Initialize with key manager
        key_mgr = KeyManager()
        encryptor = CredentialEncryptor(key_mgr)

        # Encrypt credential
        encrypted = encryptor.encrypt("sk-1234567890")
        # Result: "v1:gAAAAABh..."

        # Decrypt credential (automatically uses correct key version)
        plaintext = encryptor.decrypt(encrypted)
        # Result: "sk-1234567890"

        # Re-encrypt with new key version (for rotation)
        re_encrypted = encryptor.re_encrypt(encrypted)
        # Result: "v2:gAAAAABi..."
    """

    def __init__(self, key_manager: KeyManager):
        """Initialize credential encryptor.

        Args:
            key_manager: KeyManager instance with loaded keys
        """
        self._key_manager = key_manager

    def encrypt(self, plaintext: str) -> str:
        """Encrypt a credential using the primary key.

        Args:
            plaintext: Plain text credential (API key, token, etc.)

        Returns:
            Encrypted credential with version prefix: "v{version}:{ciphertext}"

        Raises:
            ValueError: If plaintext is empty
        """
        if not plaintext:
            raise ValueError("Cannot encrypt empty credential")

        primary_key = self._key_manager.get_primary_key()
        primary_version = self._key_manager.get_primary_version()

        f = Fernet(primary_key)
        ciphertext = f.encrypt(plaintext.encode('utf-8'))
        ciphertext_b64 = ciphertext.decode('utf-8')

        return f"v{primary_version}:{ciphertext_b64}"

    def decrypt(self, encrypted: str) -> str:
        """Decrypt a credential using the appropriate key version.

        Args:
            encrypted: Encrypted credential with version prefix

        Returns:
            Plain text credential

        Raises:
            ValueError: If format is invalid
            KeyRotationError: If key version not found
            InvalidToken: If decryption fails (wrong key or corrupted data)
        """
        if not encrypted or ':' not in encrypted:
            raise ValueError("Invalid encrypted credential format (expected 'v{version}:{ciphertext}')")

        # Parse version prefix
        prefix, ciphertext_b64 = encrypted.split(':', 1)
        if not prefix.startswith('v'):
            raise ValueError(f"Invalid version prefix: {prefix}")

        try:
            version = int(prefix[1:])
        except ValueError:
            raise ValueError(f"Invalid version number: {prefix}")

        # Get key for this version
        key = self._key_manager.get_key(version)
        if key is None:
            raise KeyRotationError(
                f"Key version {version} not found. "
                f"Available versions: {self._key_manager.list_versions()}"
            )

        # Decrypt
        try:
            f = Fernet(key)
            plaintext_bytes = f.decrypt(ciphertext_b64.encode('utf-8'))
            return plaintext_bytes.decode('utf-8')
        except InvalidToken as e:
            raise InvalidToken(
                f"Failed to decrypt credential with key version {version}. "
                "Key may be incorrect or data corrupted."
            ) from e

    def re_encrypt(self, encrypted: str) -> str:
        """Re-encrypt a credential with the current primary key.

        This is used during key rotation to migrate encrypted data
        from old key versions to the new primary key.

        Args:
            encrypted: Encrypted credential with old key version

        Returns:
            Re-encrypted credential with current primary key version

        Raises:
            ValueError: If format is invalid
            KeyRotationError: If old key version not found
            InvalidToken: If decryption fails
        """
        # Decrypt with old key
        plaintext = self.decrypt(encrypted)

        # Re-encrypt with current primary key
        return self.encrypt(plaintext)

    def get_version(self, encrypted: str) -> Optional[int]:
        """Extract key version from encrypted credential.

        Args:
            encrypted: Encrypted credential with version prefix

        Returns:
            Version number, or None if format is invalid
        """
        if not encrypted or ':' not in encrypted:
            return None

        prefix = encrypted.split(':', 1)[0]
        if not prefix.startswith('v'):
            return None

        try:
            return int(prefix[1:])
        except ValueError:
            return None

    def needs_rotation(self, encrypted: str) -> bool:
        """Check if a credential needs re-encryption with current primary key.

        Args:
            encrypted: Encrypted credential

        Returns:
            True if credential uses old key version
        """
        version = self.get_version(encrypted)
        if version is None:
            return False

        return version != self._key_manager.get_primary_version()
