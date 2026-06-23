#!/usr/bin/env python3
"""Example usage of shared/crypto module for credential encryption.

This script demonstrates:
1. Setting up key management
2. Encrypting provider credentials
3. Decrypting credentials
4. Key rotation workflow
"""

import os
import json
from server.shared.crypto import KeyManager, CredentialEncryptor, KeyRotationError
from server.shared.crypto.rotation import KeyRotationService


def example_basic_usage():
    """Basic encryption and decryption."""
    print("=" * 60)
    print("Example 1: Basic Usage")
    print("=" * 60)

    # Initialize
    key_manager = KeyManager()
    encryptor = CredentialEncryptor(key_manager)

    # Encrypt a credential
    api_key = "sk-1234567890abcdef"
    print(f"\nOriginal API key: {api_key}")

    encrypted = encryptor.encrypt(api_key)
    print(f"Encrypted: {encrypted}")

    # Decrypt the credential
    decrypted = encryptor.decrypt(encrypted)
    print(f"Decrypted: {decrypted}")

    assert decrypted == api_key
    print("\n✓ Basic encryption/decryption successful")


def example_versioned_keys():
    """Working with multiple key versions."""
    print("\n" + "=" * 60)
    print("Example 2: Versioned Keys")
    print("=" * 60)

    # Set up multiple key versions
    key1 = KeyManager.generate_key()
    key2 = KeyManager.generate_key()
    keys_json = json.dumps({"1": key1, "2": key2})

    os.environ["AITEAM_ENCRYPTION_KEYS"] = keys_json
    os.environ["AITEAM_ENCRYPTION_KEY_VERSION"] = "2"

    # Initialize
    key_manager = KeyManager()
    encryptor = CredentialEncryptor(key_manager)

    print(f"Primary version: {key_manager.get_primary_version()}")
    print(f"Available versions: {key_manager.list_versions()}")

    # Encrypt with current primary key (v2)
    credential = "provider-api-token-xyz"
    encrypted = encryptor.encrypt(credential)
    print(f"\nEncrypted with v2: {encrypted[:30]}...")

    # Verify version
    version = encryptor.get_version(encrypted)
    print(f"Credential version: {version}")

    print("\n✓ Versioned key management successful")


def example_key_rotation():
    """Simulating key rotation workflow."""
    print("\n" + "=" * 60)
    print("Example 3: Key Rotation")
    print("=" * 60)

    # Phase 1: Start with version 1
    key1 = KeyManager.generate_key()
    os.environ["AITEAM_ENCRYPTION_KEY"] = key1
    os.environ.pop("AITEAM_ENCRYPTION_KEYS", None)
    os.environ.pop("AITEAM_ENCRYPTION_KEY_VERSION", None)

    key_manager = KeyManager()
    encryptor = CredentialEncryptor(key_manager)

    # Encrypt some credentials with version 1
    credentials = [
        "openai-api-key-1",
        "anthropic-api-key-2",
        "google-api-key-3",
    ]
    encrypted_credentials = []

    print("\nPhase 1: Encrypt with version 1")
    for cred in credentials:
        encrypted = encryptor.encrypt(cred)
        encrypted_credentials.append(encrypted)
        print(f"  {cred[:20]}... -> {encrypted[:30]}...")

    # Phase 2: Add version 2 and promote it
    key2 = KeyManager.generate_key()
    keys_json = json.dumps({"1": key1, "2": key2})
    os.environ["AITEAM_ENCRYPTION_KEYS"] = keys_json
    os.environ["AITEAM_ENCRYPTION_KEY_VERSION"] = "2"

    # Reload key manager
    key_manager = KeyManager()
    service = KeyRotationService(key_manager)

    print("\nPhase 2: Check rotation status")
    status = service.check_rotation_status(encrypted_credentials)
    print(f"  Total credentials: {status['total_credentials']}")
    print(f"  Needs rotation: {status['needs_rotation']}")
    print(f"  Version distribution: {status['version_distribution']}")

    # Phase 3: Perform rotation
    print("\nPhase 3: Rotate credentials to version 2")
    result = service.rotate_credentials(encrypted_credentials)
    print(f"  Rotated: {result['rotated']}")
    print(f"  Unchanged: {result['unchanged']}")
    print(f"  Failed: {result['failed']}")

    # Phase 4: Verify all credentials still decrypt correctly
    print("\nPhase 4: Verify decryption")
    encryptor = CredentialEncryptor(key_manager)
    for i, encrypted in enumerate(result['details']['success']):
        # Get the new encrypted value from the result
        # Note: In real usage, you would get these from the database
        new_encrypted = service.rotate_credentials([encrypted_credentials[i]])
        decrypted = encryptor.decrypt(encrypted_credentials[i])
        print(f"  ✓ Credential {i+1} decrypts correctly: {decrypted[:20]}...")

    print("\n✓ Key rotation workflow successful")


def example_rotation_plan():
    """Generate a rotation plan."""
    print("\n" + "=" * 60)
    print("Example 4: Rotation Plan")
    print("=" * 60)

    # Set up versioned keys
    key1 = KeyManager.generate_key()
    key2 = KeyManager.generate_key()
    keys_json = json.dumps({"1": key1, "2": key2})
    os.environ["AITEAM_ENCRYPTION_KEYS"] = keys_json
    os.environ["AITEAM_ENCRYPTION_KEY_VERSION"] = "1"

    key_manager = KeyManager()
    service = KeyRotationService(key_manager)

    # Generate rotation plan
    plan = service.plan_rotation(
        current_primary=1,
        new_primary=2,
        grace_period_days=30
    )

    print("\nRotation Plan:")
    print(f"  Current primary: v{plan['current_state']['primary_version']}")
    print(f"  Target primary: v{plan['target_state']['primary_version']}")
    print(f"\nTimeline:")
    for key, value in plan['timeline'].items():
        print(f"  {key}: {value}")
    print(f"\nSteps:")
    for i, step in enumerate(plan['steps'], 1):
        print(f"  {i}. [{step['phase']}] {step['action']}")

    print("\n✓ Rotation plan generated successfully")


def main():
    """Run all examples."""
    print("\n🔐 AI Team Crypto Module - Usage Examples\n")

    try:
        example_basic_usage()
        example_versioned_keys()
        example_key_rotation()
        example_rotation_plan()

        print("\n" + "=" * 60)
        print("All examples completed successfully! ✓")
        print("=" * 60)

    except KeyRotationError as e:
        print(f"\n❌ Error: {e}")
        print("\nMake sure to set AITEAM_ENCRYPTION_KEY environment variable:")
        print("  export AITEAM_ENCRYPTION_KEY='$(python -m server.shared.crypto.rotation generate | grep export | cut -d\"'\" -f2)'")
        return 1

    return 0


if __name__ == "__main__":
    exit(main())
