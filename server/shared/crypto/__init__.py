"""Shared cryptographic utilities for AI Team v1 architecture.

Provides production-grade key management, credential encryption, and key rotation
for Manager and Operation services.

Core principles (aligned with v1 概要设计 §3.6 + D18):
- No hardcoded keys in source code
- Keys loaded from environment or key management service
- Support for key rotation with versioning
- Fernet symmetric encryption for provider credentials
- Clear separation between encryption keys and signing keys
"""

from .key_manager import KeyManager, KeyRotationError
from .credential_encryptor import CredentialEncryptor

__all__ = [
    "KeyManager",
    "KeyRotationError",
    "CredentialEncryptor",
]
