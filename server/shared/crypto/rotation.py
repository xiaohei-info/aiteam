"""Key rotation utilities and CLI for production key management.

Provides tools for:
- Rotating encryption keys with zero downtime
- Re-encrypting existing credentials with new keys
- Validating key health and rotation status

Usage:
    # Generate a new key
    python -m server.shared.crypto.rotation generate

    # Check rotation status for all credentials
    python -m server.shared.crypto.rotation status --database-url postgresql://...

    # Perform key rotation (re-encrypt all credentials)
    python -m server.shared.crypto.rotation rotate --database-url postgresql://...

For production deployments, this should be integrated with your key management
service (AWS KMS, Azure Key Vault, etc.) and automated rotation schedule.
"""

import sys
import json
from typing import Optional
from datetime import datetime, timedelta

from .key_manager import KeyManager, KeyRotationError
from .credential_encryptor import CredentialEncryptor


class KeyRotationService:
    """Service for managing key rotation operations."""

    def __init__(self, key_manager: KeyManager):
        """Initialize rotation service.

        Args:
            key_manager: KeyManager instance with loaded keys
        """
        self._key_manager = key_manager
        self._encryptor = CredentialEncryptor(key_manager)

    def check_rotation_status(self, encrypted_values: list[str]) -> dict:
        """Check how many credentials need rotation.

        Args:
            encrypted_values: List of encrypted credentials to check

        Returns:
            Status dict with counts and details
        """
        primary_version = self._key_manager.get_primary_version()
        needs_rotation = []
        version_counts = {}

        for value in encrypted_values:
            version = self._encryptor.get_version(value)
            if version is None:
                continue

            version_counts[version] = version_counts.get(version, 0) + 1

            if version != primary_version:
                needs_rotation.append({
                    "value": value[:20] + "...",  # Truncate for display
                    "current_version": version,
                    "target_version": primary_version,
                })

        return {
            "total_credentials": len(encrypted_values),
            "primary_version": primary_version,
            "needs_rotation": len(needs_rotation),
            "version_distribution": version_counts,
            "rotation_candidates": needs_rotation,
        }

    def rotate_credentials(self, encrypted_values: list[str]) -> dict:
        """Re-encrypt credentials with current primary key.

        Args:
            encrypted_values: List of encrypted credentials

        Returns:
            Result dict with re-encrypted values and stats
        """
        results = {
            "success": [],
            "failed": [],
            "unchanged": [],
        }

        for value in encrypted_values:
            try:
                if self._encryptor.needs_rotation(value):
                    new_value = self._encryptor.re_encrypt(value)
                    results["success"].append({
                        "old": value[:20] + "...",
                        "new": new_value[:20] + "...",
                    })
                else:
                    results["unchanged"].append(value[:20] + "...")
            except Exception as e:
                results["failed"].append({
                    "value": value[:20] + "...",
                    "error": str(e),
                })

        return {
            "rotated": len(results["success"]),
            "unchanged": len(results["unchanged"]),
            "failed": len(results["failed"]),
            "details": results,
        }

    def plan_rotation(
        self,
        current_primary: int,
        new_primary: int,
        grace_period_days: int = 30,
    ) -> dict:
        """Generate a key rotation plan.

        Args:
            current_primary: Current primary key version
            new_primary: New primary key version to promote
            grace_period_days: Days to keep old key active

        Returns:
            Rotation plan with timeline and steps
        """
        now = datetime.now()
        cutover_date = now + timedelta(days=1)  # Next day
        deprecation_date = cutover_date + timedelta(days=grace_period_days)

        return {
            "current_state": {
                "primary_version": current_primary,
                "available_versions": self._key_manager.list_versions(),
            },
            "target_state": {
                "primary_version": new_primary,
            },
            "timeline": {
                "preparation": now.isoformat(),
                "cutover": cutover_date.isoformat(),
                "deprecation": deprecation_date.isoformat(),
            },
            "steps": [
                {
                    "phase": "preparation",
                    "action": f"Generate and deploy new key version {new_primary}",
                    "deadline": now.isoformat(),
                },
                {
                    "phase": "cutover",
                    "action": f"Promote version {new_primary} to primary",
                    "deadline": cutover_date.isoformat(),
                },
                {
                    "phase": "migration",
                    "action": "Re-encrypt all credentials with new primary key",
                    "deadline": cutover_date.isoformat(),
                },
                {
                    "phase": "grace_period",
                    "action": f"Monitor for {grace_period_days} days, keep version {current_primary} available",
                    "deadline": deprecation_date.isoformat(),
                },
                {
                    "phase": "cleanup",
                    "action": f"Remove version {current_primary} from key store",
                    "deadline": deprecation_date.isoformat(),
                },
            ],
        }


def generate_key_command():
    """Generate a new encryption key."""
    key = KeyManager.generate_key()
    print(f"Generated new Fernet encryption key:\n")
    print(f"export AITEAM_ENCRYPTION_KEY='{key}'\n")
    print("Store this key securely. It cannot be recovered if lost.")


def status_command(database_url: Optional[str] = None):
    """Check key rotation status."""
    try:
        key_manager = KeyManager()
        print(f"Current primary key version: {key_manager.get_primary_version()}")
        print(f"Available key versions: {key_manager.list_versions()}")

        if database_url:
            # This would query the database for encrypted credentials
            # For now, just show the configuration
            print("\nDatabase integration not yet implemented.")
            print("To check credentials, use the rotation service programmatically.")
        else:
            print("\nNo database URL provided. Showing key configuration only.")

    except KeyRotationError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def rotate_command(database_url: str, dry_run: bool = False):
    """Perform key rotation."""
    try:
        key_manager = KeyManager()
        service = KeyRotationService(key_manager)

        print(f"Starting key rotation (dry_run={dry_run})")
        print(f"Primary key version: {key_manager.get_primary_version()}")

        if not database_url:
            print("Error: --database-url required", file=sys.stderr)
            sys.exit(1)

        # This would query and update the database
        # For now, just show what would happen
        print("\nDatabase integration not yet implemented.")
        print("To rotate credentials, use the rotation service programmatically.")

    except KeyRotationError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="AI Team encryption key rotation utility"
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # Generate command
    subparsers.add_parser("generate", help="Generate a new encryption key")

    # Status command
    status_parser = subparsers.add_parser("status", help="Check key rotation status")
    status_parser.add_argument(
        "--database-url",
        help="Database connection URL",
    )

    # Rotate command
    rotate_parser = subparsers.add_parser("rotate", help="Perform key rotation")
    rotate_parser.add_argument(
        "--database-url",
        required=True,
        help="Database connection URL",
    )
    rotate_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be rotated without making changes",
    )

    args = parser.parse_args()

    if args.command == "generate":
        generate_key_command()
    elif args.command == "status":
        status_command(args.database_url)
    elif args.command == "rotate":
        rotate_command(args.database_url, args.dry_run)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
