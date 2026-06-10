from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from ..application.queries.billing_view_service import get_billing_view
from ..domain.entities import AuditEvent, Enterprise
from ..repositories.audit_event_repo import AuditEventRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from ..transactions.uow import UnitOfWork

_ALLOWED_SETTINGS_PATCH_FIELDS = {
    "name",
    "logo_url",
    "contact_phone",
    "contact_wechat",
    "help_doc_url",
    "feedback_form_url",
    "version_label",
    "version_notes_url",
    "notification_policy",
    "low_balance_threshold_cents",
    "warning_enabled",
}
_VALID_PAYMENT_METHODS = {"wechat_pay", "alipay", "bank_transfer", "mock_pay"}
_ADMIN_ROLES = {"owner", "enterprise_admin", "finance_admin"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _money_from_cents(value: int | None) -> str:
    cents = int(value or 0)
    return f"{cents / 100:.2f}"


def _tokens_from_cents(amount_cents: int) -> int:
    # Explicit mock exchange-rate seam for MVP billing/recharge behavior.
    return int(amount_cents * 10)


def _ensure_enterprise(cur) -> tuple[Enterprise | None, tuple[int, dict] | None]:
    enterprises = EnterpriseRepo(cur).list_all()
    enterprise = enterprises[0] if enterprises else None
    if enterprise is None:
        return None, (400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"})
    return enterprise, None


def _audit(cur, enterprise_id: str, event_type: str, target_type: str, target_id: str, payload: dict, *, request_id: str | None = None) -> None:
    AuditEventRepo(cur).create(
        AuditEvent(
            id=f"audit_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            actor_type="user",
            actor_id="team_panel",
            event_type=event_type,
            target_type=target_type,
            target_id=target_id,
            request_id=request_id,
            payload_json=json.dumps(payload, ensure_ascii=False),
            created_by="team_panel",
        )
    )


def _ensure_settings_row(cur, enterprise_id: str) -> None:
    cur.execute(
        """
        INSERT INTO enterprise_settings (
            enterprise_id,
            invite_code,
            version_label,
            version_notes_url,
            help_doc_url,
            feedback_form_url,
            notification_policy_json
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (enterprise_id) DO NOTHING
        """,
        (
            enterprise_id,
            f"INV-{enterprise_id[-6:].upper()}",
            "MVP",
            "/docs/changelog",
            "/docs",
            "/support/feedback",
            json.dumps(
                {
                    "employee_task_completed": True,
                    "system_announcements": True,
                    "low_balance_email": True,
                },
                ensure_ascii=False,
            ),
        ),
    )


def _ensure_billing_account_row(cur, enterprise_id: str) -> None:
    cur.execute(
        """
        INSERT INTO enterprise_billing_account (
            enterprise_id,
            balance_cents,
            token_balance,
            low_balance_threshold_cents,
            warning_enabled
        )
        VALUES (%s, 0, 0, 5000, TRUE)
        ON CONFLICT (enterprise_id) DO NOTHING
        """,
        (enterprise_id,),
    )


def _fetch_settings_row(cur, enterprise_id: str) -> dict:
    _ensure_settings_row(cur, enterprise_id)
    cur.execute(
        """
        SELECT
            logo_url,
            contact_phone,
            contact_wechat,
            invite_code,
            help_doc_url,
            feedback_form_url,
            version_label,
            version_notes_url,
            notification_policy_json
        FROM enterprise_settings
        WHERE enterprise_id = %s
        """,
        (enterprise_id,),
    )
    row = cur.fetchone()
    return {
        "logo_url": row[0],
        "contact_phone": row[1],
        "contact_wechat": row[2],
        "invite_code": row[3],
        "help_doc_url": row[4],
        "feedback_form_url": row[5],
        "version_label": row[6],
        "version_notes_url": row[7],
        "notification_policy": row[8] or {},
    }


def _fetch_admin_invites(cur, enterprise_id: str) -> list[dict]:
    cur.execute(
        """
        SELECT id, invitee_phone, role, permissions_json, invite_code, status, idempotency_key, invited_by, message, created_at
        FROM admin_invite
        WHERE enterprise_id = %s
          AND status <> 'revoked'
        ORDER BY created_at DESC, id DESC
        """,
        (enterprise_id,),
    )
    return [
        {
            "invite_id": row[0],
            "phone": row[1],
            "role": row[2],
            "permissions": row[3] or {},
            "invite_code": row[4],
            "status": row[5],
            "idempotency_key": row[6],
            "invited_by": row[7],
            "message": row[8],
            "created_at": str(row[9]),
        }
        for row in cur.fetchall()
    ]


def handle_get_admin_invites(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        items = _fetch_admin_invites(cur, enterprise.id)
        return 200, {
            "enterprise_id": enterprise.id,
            "items": items,
            "total": len(items),
        }
    finally:
        cur.close()


def _fetch_admin_members(cur, enterprise_id: str) -> list[dict]:
    cur.execute(
        """
        SELECT id, user_id, role, status, joined_at
        FROM membership
        WHERE enterprise_id = %s
          AND role IN ('owner', 'enterprise_admin', 'finance_admin')
          AND status IN ('active', 'invited')
        ORDER BY joined_at DESC, id DESC
        """,
        (enterprise_id,),
    )
    return [
        {
            "membership_id": row[0],
            "user_id": row[1],
            "role": row[2],
            "status": row[3],
            "joined_at": str(row[4]),
        }
        for row in cur.fetchall()
    ]


def _fetch_billing_account(cur, enterprise_id: str) -> dict:
    _ensure_billing_account_row(cur, enterprise_id)
    cur.execute(
        """
        SELECT balance_cents, token_balance, low_balance_threshold_cents, warning_enabled, updated_at
        FROM enterprise_billing_account
        WHERE enterprise_id = %s
        """,
        (enterprise_id,),
    )
    row = cur.fetchone()
    return {
        "balance_cents": int(row[0] or 0),
        "token_balance": int(row[1] or 0),
        "low_balance_threshold_cents": int(row[2] or 5000),
        "warning_enabled": bool(row[3]),
        "updated_at": str(row[4]),
    }


def _assemble_settings_response(cur, enterprise: Enterprise) -> dict:
    settings = _fetch_settings_row(cur, enterprise.id)
    billing = _fetch_billing_account(cur, enterprise.id)
    return {
        "enterprise_id": enterprise.id,
        "name": enterprise.name,
        "status": enterprise.status,
        "slug": enterprise.slug,
        **settings,
        "admin_members": _fetch_admin_members(cur, enterprise.id),
        "admin_invites": _fetch_admin_invites(cur, enterprise.id),
        "low_balance_threshold_cents": billing["low_balance_threshold_cents"],
        "warning_enabled": billing["warning_enabled"],
        "updated_at": billing["updated_at"],
    }


def _fetch_recharges(cur, enterprise_id: str, *, limit: int = 50) -> list[dict]:
    cur.execute(
        """
        SELECT id, order_no, amount_cents, payment_method, status, token_credited, idempotency_key,
               mock_provider, provider_reference, failure_reason, completed_at, created_at, updated_at
        FROM recharge_order
        WHERE enterprise_id = %s
        ORDER BY created_at DESC, id DESC
        LIMIT %s
        """,
        (enterprise_id, limit),
    )
    return [
        {
            "recharge_id": row[0],
            "order_no": row[1],
            "amount": _money_from_cents(row[2]),
            "amount_cents": int(row[2]),
            "payment_method": row[3],
            "status": row[4],
            "token_credited": int(row[5] or 0),
            "idempotency_key": row[6],
            "mock_provider": bool(row[7]),
            "provider_reference": row[8],
            "failure_reason": row[9],
            "completed_at": str(row[10]) if row[10] else None,
            "created_at": str(row[11]),
            "updated_at": str(row[12]),
        }
        for row in cur.fetchall()
    ]


def _build_balance_response(conn, enterprise_id: str) -> dict:
    cur = conn.cursor()
    try:
        account = _fetch_billing_account(cur, enterprise_id)
        conn.commit()
    finally:
        cur.close()

    with UnitOfWork(conn) as uow:
        usage = get_billing_view(uow, enterprise_id, period_start="2000-01-01", period_end="2099-12-31")

    estimated_days = None
    if usage.total_cost_cents > 0 and account["balance_cents"] > 0:
        estimated_days = round(account["balance_cents"] / usage.total_cost_cents, 2)

    return {
        "enterprise_id": enterprise_id,
        "balance": _money_from_cents(account["balance_cents"]),
        "balance_cents": account["balance_cents"],
        "token_balance": account["token_balance"],
        "estimated_days_remaining": estimated_days,
        "low_balance_threshold_cents": account["low_balance_threshold_cents"],
        "low_balance_warning": account["warning_enabled"] and account["balance_cents"] < account["low_balance_threshold_cents"],
        "warning_enabled": account["warning_enabled"],
        "usage_summary": {
            "period_start": usage.period_start,
            "period_end": usage.period_end,
            "total_tokens": usage.total_tokens,
            "total_cost_cents": usage.total_cost_cents,
        },
        "updated_at": account["updated_at"],
    }


def handle_get_settings(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        conn.commit()
        return 200, _assemble_settings_response(cur, enterprise)
    finally:
        cur.close()


def handle_patch_settings(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    unknown_fields = sorted(set(body) - _ALLOWED_SETTINGS_PATCH_FIELDS)
    if unknown_fields:
        return 400, {"error": "INVALID_FIELD", "message": f"Unsupported settings fields: {', '.join(unknown_fields)}"}
    notification_policy = body.get("notification_policy")
    if notification_policy is not None and not isinstance(notification_policy, dict):
        return 400, {"error": "INVALID_NOTIFICATION_POLICY", "message": "notification_policy must be an object"}

    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        _ensure_settings_row(cur, enterprise.id)
        _ensure_billing_account_row(cur, enterprise.id)
        if "name" in body:
            enterprise.name = str(body.get("name") or enterprise.name)
            EnterpriseRepo(cur).update(enterprise)
        cur.execute(
            """
            UPDATE enterprise_settings
            SET logo_url = COALESCE(%s, logo_url),
                contact_phone = COALESCE(%s, contact_phone),
                contact_wechat = COALESCE(%s, contact_wechat),
                help_doc_url = COALESCE(%s, help_doc_url),
                feedback_form_url = COALESCE(%s, feedback_form_url),
                version_label = COALESCE(%s, version_label),
                version_notes_url = COALESCE(%s, version_notes_url),
                notification_policy_json = COALESCE(%s::jsonb, notification_policy_json),
                updated_at = now()
            WHERE enterprise_id = %s
            """,
            (
                body.get("logo_url"),
                body.get("contact_phone"),
                body.get("contact_wechat"),
                body.get("help_doc_url"),
                body.get("feedback_form_url"),
                body.get("version_label"),
                body.get("version_notes_url"),
                json.dumps(notification_policy, ensure_ascii=False) if notification_policy is not None else None,
                enterprise.id,
            ),
        )
        cur.execute(
            """
            UPDATE enterprise_billing_account
            SET low_balance_threshold_cents = COALESCE(%s, low_balance_threshold_cents),
                warning_enabled = COALESCE(%s, warning_enabled),
                updated_at = now()
            WHERE enterprise_id = %s
            """,
            (
                body.get("low_balance_threshold_cents"),
                body.get("warning_enabled"),
                enterprise.id,
            ),
        )
        _audit(cur, enterprise.id, "settings.updated", "enterprise_settings", enterprise.id, body)
        conn.commit()
        return 200, _assemble_settings_response(cur, enterprise)
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def handle_post_admin_invite(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    phone = str(body.get("phone") or "").strip()
    role = str(body.get("role") or "enterprise_admin").strip()
    idempotency_key = str(body.get("idempotency_key") or "").strip() or None
    permissions = body.get("permissions") or {}
    message = body.get("message")
    if not phone:
        return 400, {"error": "INVALID_PHONE", "message": "phone is required"}
    if role not in _ADMIN_ROLES:
        return 400, {"error": "INVALID_ROLE", "message": f"role must be one of {sorted(_ADMIN_ROLES)}"}
    if not isinstance(permissions, dict):
        return 400, {"error": "INVALID_PERMISSIONS", "message": "permissions must be an object"}

    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        _ensure_settings_row(cur, enterprise.id)
        if idempotency_key:
            cur.execute(
                """
                SELECT id, invitee_phone, role, permissions_json, invite_code, status, idempotency_key, invited_by, message, created_at
                FROM admin_invite
                WHERE enterprise_id = %s AND idempotency_key = %s
                """,
                (enterprise.id, idempotency_key),
            )
            row = cur.fetchone()
            if row is not None:
                return 200, {
                    "invite_id": row[0],
                    "phone": row[1],
                    "role": row[2],
                    "permissions": row[3] or {},
                    "invite_code": row[4],
                    "status": row[5],
                    "idempotency_key": row[6],
                    "invited_by": row[7],
                    "message": row[8],
                    "created_at": str(row[9]),
                }
        invite_id = f"invite_{uuid.uuid4().hex[:12]}"
        invite_code = f"ADM-{uuid.uuid4().hex[:8].upper()}"
        cur.execute(
            """
            INSERT INTO admin_invite (
                id, enterprise_id, invitee_phone, role, permissions_json, invite_code,
                status, idempotency_key, invited_by, message
            )
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, 'pending', %s, %s, %s)
            """,
            (
                invite_id,
                enterprise.id,
                phone,
                role,
                json.dumps(permissions, ensure_ascii=False),
                invite_code,
                idempotency_key,
                "team_panel",
                message,
            ),
        )
        _audit(
            cur,
            enterprise.id,
            "admin_invite.created",
            "admin_invite",
            invite_id,
            {"phone": phone, "role": role, "permissions": permissions},
            request_id=idempotency_key,
        )
        conn.commit()
        return 201, {
            "invite_id": invite_id,
            "phone": phone,
            "role": role,
            "permissions": permissions,
            "invite_code": invite_code,
            "status": "pending",
            "idempotency_key": idempotency_key,
            "invited_by": "team_panel",
            "message": message,
            "created_at": _now_iso(),
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def handle_delete_admin_invite(conn, path: str, invite_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        cur.execute(
            """
            SELECT id, status
            FROM admin_invite
            WHERE enterprise_id = %s AND id = %s
            """,
            (enterprise.id, invite_id),
        )
        row = cur.fetchone()
        if row is None:
            return 404, {"error": "ADMIN_INVITE_NOT_FOUND", "message": f"Admin invite {invite_id} not found"}
        if row[1] != "revoked":
            cur.execute(
                """
                UPDATE admin_invite
                SET status = 'revoked',
                    revoked_at = now(),
                    updated_at = now()
                WHERE enterprise_id = %s AND id = %s
                """,
                (enterprise.id, invite_id),
            )
            _audit(
                cur,
                enterprise.id,
                "admin_invite.revoked",
                "admin_invite",
                invite_id,
                {"status": "revoked"},
            )
        conn.commit()
        return 200, {"invite_id": invite_id, "status": "revoked"}
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def handle_get_billing_balance(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        return 200, _build_balance_response(conn, enterprise.id)
    finally:
        cur.close()


def handle_get_billing_recharges(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        items = _fetch_recharges(cur, enterprise.id)
        return 200, {
            "enterprise_id": enterprise.id,
            "items": items,
            "total": len(items),
            "balance": _build_balance_response(conn, enterprise.id),
        }
    finally:
        cur.close()


def handle_post_billing_recharge(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    payment_method = str(body.get("payment_method") or "mock_pay").strip()
    if payment_method not in _VALID_PAYMENT_METHODS:
        return 400, {"error": "INVALID_PAYMENT_METHOD", "message": f"payment_method must be one of {sorted(_VALID_PAYMENT_METHODS)}"}
    amount_cents = body.get("amount_cents")
    amount = body.get("amount")
    if amount_cents is None:
        if amount is None:
            return 400, {"error": "INVALID_AMOUNT", "message": "amount or amount_cents is required"}
        amount_cents = int(round(float(amount) * 100))
    amount_cents = int(amount_cents)
    if amount_cents < 100:
        return 400, {"error": "INVALID_AMOUNT", "message": "minimum recharge amount is ¥1.00"}
    idempotency_key = str(body.get("idempotency_key") or "").strip() or None

    cur = conn.cursor()
    try:
        enterprise, error = _ensure_enterprise(cur)
        if error is not None:
            return error
        assert enterprise is not None
        _ensure_billing_account_row(cur, enterprise.id)
        if idempotency_key:
            cur.execute(
                """
                SELECT id, order_no, amount_cents, payment_method, status, token_credited, idempotency_key,
                       mock_provider, provider_reference, failure_reason, completed_at, created_at, updated_at
                FROM recharge_order
                WHERE enterprise_id = %s AND idempotency_key = %s
                """,
                (enterprise.id, idempotency_key),
            )
            row = cur.fetchone()
            if row is not None:
                return 200, {
                    "recharge_id": row[0],
                    "order_no": row[1],
                    "amount": _money_from_cents(row[2]),
                    "amount_cents": int(row[2]),
                    "payment_method": row[3],
                    "status": row[4],
                    "token_credited": int(row[5] or 0),
                    "idempotency_key": row[6],
                    "mock_provider": bool(row[7]),
                    "provider_reference": row[8],
                    "failure_reason": row[9],
                    "completed_at": str(row[10]) if row[10] else None,
                    "created_at": str(row[11]),
                    "updated_at": str(row[12]),
                }
        recharge_id = f"recharge_{uuid.uuid4().hex[:12]}"
        order_no = f"RCG{uuid.uuid4().hex[:20].upper()}"[:32]
        mock_provider = payment_method == "mock_pay"
        token_credited = _tokens_from_cents(amount_cents) if mock_provider else 0
        status = "succeeded" if mock_provider else "pending"
        provider_reference = f"mock://{recharge_id}" if mock_provider else None
        cur.execute(
            """
            INSERT INTO recharge_order (
                id, enterprise_id, order_no, amount_cents, payment_method, status,
                token_credited, idempotency_key, mock_provider, provider_reference, created_by,
                completed_at
            )
            VALUES (
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                CASE WHEN %s = 'succeeded' THEN now() ELSE NULL END
            )
            """,
            (
                recharge_id,
                enterprise.id,
                order_no,
                amount_cents,
                payment_method,
                status,
                token_credited,
                idempotency_key,
                mock_provider,
                provider_reference,
                "team_panel",
                status,
            ),
        )
        if mock_provider:
            cur.execute(
                """
                UPDATE enterprise_billing_account
                SET balance_cents = balance_cents + %s,
                    token_balance = token_balance + %s,
                    updated_at = now()
                WHERE enterprise_id = %s
                """,
                (amount_cents, token_credited, enterprise.id),
            )
        _audit(
            cur,
            enterprise.id,
            "recharge.created",
            "recharge_order",
            recharge_id,
            {"amount_cents": amount_cents, "payment_method": payment_method, "status": status},
            request_id=idempotency_key,
        )
        conn.commit()
        return 201, {
            "recharge_id": recharge_id,
            "order_no": order_no,
            "amount": _money_from_cents(amount_cents),
            "amount_cents": amount_cents,
            "payment_method": payment_method,
            "status": status,
            "token_credited": token_credited,
            "idempotency_key": idempotency_key,
            "mock_provider": mock_provider,
            "provider_reference": provider_reference,
            "completed_at": _now_iso() if mock_provider else None,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def guard_run_creation_allowed(cur, enterprise_id: str) -> tuple[int, dict] | None:
    cur.execute(
        """
        SELECT balance_cents, token_balance, low_balance_threshold_cents, warning_enabled
        FROM enterprise_billing_account
        WHERE enterprise_id = %s
        """,
        (enterprise_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    balance_cents = int(row[0] or 0)
    token_balance = int(row[1] or 0)
    threshold = int(row[2] or 5000)
    warning_enabled = bool(row[3])
    if balance_cents > 0 or token_balance > 0:
        return None
    return 402, {
        "error": "INSUFFICIENT_BALANCE",
        "message": "Enterprise balance is insufficient for a new run",
        "recharge_required": True,
        "balance": "0.00",
        "balance_cents": 0,
        "token_balance": 0,
        "low_balance_threshold_cents": threshold,
        "low_balance_warning": warning_enabled,
    }
