"""Production key management for encrypted credential storage.

Manages encryption keys with versioning and rotation support.
Keys are loaded from environment variables or external key management services.

Design principles:
- Never hardcode keys in source code (D18)
- Support multiple key versions for zero-downtime rotation
- Primary key for new encryption, historical keys for decryption
- Clear error messages for missing or invalid keys
"""

import os
import secrets
from typing import Dict, Optional
from cryptography.fernet import Fernet


class KeyRotationError(Exception):
    """Raised when key rotation operations fail."""
    pass


class KeyManager:
    """Manages encryption keys with rotation support.

    Key sources (in priority order):
    1. Environment variable AITEAM_ENCRYPTION_KEYS (JSON format)
    2. External KMS (future: AWS KMS, Azure Key Vault, HashiCorp Vault)
    3. Local key file (development only, not for production)

    Key format:
    - Single key: base64-encoded Fernet key string
    - Multiple keys: JSON object {"1": "key1", "2": "key2", ...}
    - Latest version number is the primary key

    Example:
        # Single key (simple mode)
        export AITEAM_ENCRYPTION_KEY="base64-fernet-key=="

        # Multiple keys with versioning (rotation mode)
        export AITEAM_ENCRYPTION_KEYS='{"1":"old-key==","2":"new-key=="}'
        export AITEAM_ENCRYPTION_KEY_VERSION=2
    """

    def __init__(
        self,
        key_env_var: str = "AITEAM_ENCRYPTION_KEY",
        keys_env_var: str = "AITEAM_ENCRYPTION_KEYS",
        version_env_var: str = "AITEAM_ENCRYPTION_KEY_VERSION",
    ):
        """Initialize key manager.

        Args:
            key_env_var: Environment variable for single key (simple mode)
            keys_env_var: Environment variable for versioned keys (JSON)
            version_env_var: Environment variable for primary key version
        """
        self._key_env_var = key_env_var
        self._keys_env_var = keys_env_var
        self._version_env_var = version_env_var
        self._keys: Dict[int, bytes] = {}
        self._primary_version: int = 1
        self._load_keys()

    def _load_keys(self) -> None:
        """Load encryption keys from environment.

        Raises:
            KeyRotationError: If no valid keys found or keys are invalid
        """
        import json

        # Try versioned keys first (production mode)
        keys_json = os.environ.get(self._keys_env_var)
        if keys_json:
            try:
                keys_dict = json.loads(keys_json)
                for version_str, key_str in keys_dict.items():
                    version = int(version_str)
                    key_bytes = key_str.encode('utf-8')
                    # Validate Fernet key format
                    Fernet(key_bytes)
                    self._keys[version] = key_bytes

                # Get primary version from env or use latest
                version_str = os.environ.get(self._version_env_var)
                if version_str:
                    self._primary_version = int(version_str)
                else:
                    self._primary_version = max(self._keys.keys())

                if self._primary_version not in self._keys:
                    raise KeyRotationError(
                        f"Primary key version {self._primary_version} not found in keys"
                    )
                return
            except (json.JSONDecodeError, ValueError, KeyError) as e:
                raise KeyRotationError(f"Invalid encryption keys format: {e}")

        # Fall back to single key (simple mode)
        single_key = os.environ.get(self._key_env_var)
        if single_key:
            try:
                key_bytes = single_key.encode('utf-8')
                Fernet(key_bytes)
                self._keys[1] = key_bytes
                self._primary_version = 1
                return
            except Exception as e:
                raise KeyRotationError(f"Invalid encryption key: {e}")

        # No keys found - fail fast in production
        raise KeyRotationError(
            f"No encryption keys found. Set {self._keys_env_var} or {self._key_env_var} "
            "environment variable. Use generate_key() to create a new key."
        )

    def get_primary_key(self) -> bytes:
        """Get the primary encryption key for new encryptions.

        Returns:
            Primary key bytes
        """
        return self._keys[self._primary_version]

    def get_primary_version(self) -> int:
        """Get the primary key version number.

        Returns:
            Primary version integer
        """
        return self._primary_version

    def get_key(self, version: int) -> Optional[bytes]:
        """Get a specific key version for decryption.

        Args:
            version: Key version number

        Returns:
            Key bytes if found, None otherwise
        """
        return self._keys.get(version)

    def list_versions(self) -> list[int]:
        """List all available key versions.

        Returns:
            Sorted list of version numbers
        """
        return sorted(self._keys.keys())

    def has_version(self, version: int) -> bool:
        """Check if a specific key version exists.

        Args:
            version: Key version number

        Returns:
            True if version exists
        """
        return version in self._keys

    @staticmethod
    def generate_key() -> str:
        """Generate a new Fernet encryption key.

        Returns:
            Base64-encoded Fernet key string

        Example:
            >>> key = KeyManager.generate_key()
            >>> print(f"export AITEAM_ENCRYPTION_KEY='{key}'")
        """
        return Fernet.generate_key().decode('utf-8')

    def add_key_version(self, version: int, key: bytes) -> None:
        """Add a new key version (for rotation).

        This is typically used when loading keys from an external KMS
        or during automated key rotation processes.

        Args:
            version: New key version number
            key: Key bytes (must be valid Fernet key)

        Raises:
            KeyRotationError: If key already exists or is invalid
        """
        if version in self._keys:
            raise KeyRotationError(f"Key version {version} already exists")

        try:
            # Validate Fernet key format
            Fernet(key)
            self._keys[version] = key
        except Exception as e:
            raise KeyRotationError(f"Invalid key format: {e}")

    def promote_version(self, version: int) -> None:
        """Promote a key version to primary (for rotation).

        Args:
            version: Version to promote to primary

        Raises:
            KeyRotationError: If version doesn't exist
        """
        if version not in self._keys:
            raise KeyRotationError(f"Key version {version} not found")

        self._primary_version = version
