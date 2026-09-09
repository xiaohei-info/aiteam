-- Legacy development/test recharge methods are not valid payment evidence.
-- Keep the ledger capture, balance reconciliation and public-row rewrite in
-- one explicit transaction; migration execution uses autocommit connections.
BEGIN;
-- Quarantine their original amounts once, reconcile any corresponding visible
-- balance/token estimate, then expose only a failed non-payment history row.
CREATE TABLE IF NOT EXISTS recharge_legacy_cleanup (
    recharge_id uuid PRIMARY KEY REFERENCES recharge_record(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL,
    amount numeric(18,6) NOT NULL,
    token_credited bigint NOT NULL,
    balance_reconciled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO recharge_legacy_cleanup (recharge_id, tenant_id, amount, token_credited)
SELECT id, tenant_id, amount, token_credited::bigint
FROM recharge_record
WHERE payment_method NOT IN ('wechat_pay', 'alipay', 'bank_transfer')
ON CONFLICT (recharge_id) DO NOTHING;

WITH pending AS (
    SELECT tenant_id, SUM(amount) AS amount, SUM(token_credited)::bigint AS token_credited
    FROM recharge_legacy_cleanup
    WHERE NOT balance_reconciled
    GROUP BY tenant_id
)
UPDATE billing_balance AS balance
SET balance = GREATEST(balance.balance - pending.amount, 0),
    estimated_tokens = GREATEST(balance.estimated_tokens - pending.token_credited, 0),
    updated_at = now()
FROM pending
WHERE balance.tenant_id = pending.tenant_id;

UPDATE recharge_legacy_cleanup
SET balance_reconciled = true
WHERE NOT balance_reconciled;

UPDATE recharge_record
SET payment_method = 'bank_transfer',
    status = 'failed',
    token_credited = 0
WHERE payment_method NOT IN ('wechat_pay', 'alipay', 'bank_transfer');

COMMIT;
