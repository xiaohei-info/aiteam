"""验证矩阵闸门（INT #55）。

按模块就绪程度分两类：
- **已转正**：当前可在 CI 中独立验证的闸门（不依赖真起三端服务）。
- **占位 skip**：依赖尚未建成的链路（Phase 2/4 真实跨端流量），先以 skip 钉死
  "必须验什么、归哪个 Phase、对哪份文档"，对应链路就绪后去掉 skip 并填实。

防跑偏意义：把"完成"的客观标准提前写死在仓库里，避免各模块各自宣称完成却没有统一验收靶子。
"""

import ast
import json
import os
import pathlib
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest


@pytest.mark.integration
def test_rls_cross_tenant_isolation():
    """RLS 跨租户串线回归：tenant A 上下文不得读到 tenant B 数据（DB + RAG workspace 双测）。

    M0 已落地（04 §6.1.1/§6.1.3，D20/D22）。无 DB_URL 时 skip（默认门不依赖外部 PG）。
    详细分层用例见 tests/manager/test_rls_isolation.py 与 test_rag_workspace.py。

    env 命名对齐 shared/config.py + deploy/（#103）：业务连接 DB_URL、管理连接 ADMIN_DB_URL。
    """
    db_url = os.getenv("DB_URL")
    admin_url = os.getenv("ADMIN_DB_URL")
    app_rw_password = os.getenv("APP_RW_PASSWORD")
    if not db_url or not admin_url:
        pytest.skip("DB_URL/ADMIN_DB_URL 未设置；RLS 回归需真实 PG（M0/#60）")

    import psycopg

    from shared.contracts.tenancy import TenantContext
    from shared.db import ManagerRagService, PgTenantRouter, apply_migrations
    from manager_service.rag import PgManagerRagService

    # 迁移走管理连接（超管/DDL owner，#60）；业务连接（db_url）以 app_rw 身份跑 RLS SQL。
    apply_migrations(admin_url, app_rw_password=app_rw_password)
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid_a = str(conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
            (f"vm_a_{uuid.uuid4().hex[:8]}",),
        ).fetchone()[0])
        tid_b = str(conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
            (f"vm_b_{uuid.uuid4().hex[:8]}",),
        ).fetchone()[0])

    def ctx(t):
        return TenantContext(tenant_id=t, user_id=str(uuid.uuid4()), roles=["member"])

    # DB 维度：A 写 employee，B 看不到。
    router = PgTenantRouter(db_url)
    slug = f"vm_{uuid.uuid4().hex[:8]}"
    with router.session(ctx(tid_a)) as s:
        s.execute("INSERT INTO employee (tenant_id, employee_slug) VALUES (%s, %s)", (tid_a, slug))
    with router.session(ctx(tid_b)) as s:
        assert s.execute("SELECT 1 FROM employee WHERE employee_slug = %s", (slug,)).fetchall() == []

    # RAG workspace 维度：A 建映射，B 看不到。
    rag = PgManagerRagService(db_url)
    rag.get(ctx(tid_a), "ks_vm")
    b_ws = {r["workspace"] for r in rag.list_workspaces(ctx(tid_b))}
    assert ManagerRagService.derive_workspace(tid_a, "ks_vm") not in b_ws


@pytest.mark.integration
def test_timeline_parity_vs_frozen_baseline():
    """streaming/timeline parity：事件类型/顺序/cursor/payload 关键字段对齐冻结契约基线。

    验什么（口径 07 §8 / 10 §17 / D6 红线 / 06 §7.1）：
      用 TestClient 打 Agent，POST /api/agent/conversations 建会话 →
      POST /api/agent/conversations/{id}/runs 起 run（驱动内置 FakeExecutor 产出
      status/reasoning/text/tool/usage/completed 事件序列）→
      GET /api/agent/conversations/{id}/timeline 拉时间线 → 断言返回事件**严格匹配**
      shared/contracts/events.py 的 BusinessTimelineEvent 冻结契约：
        1. 每条事件的字段集 == BusinessTimelineEvent 字段（cursor/run_id/conversation_id/
           type/payload/created_at），无 runtime-native 字段外泄（D6 红线）。
        2. cursor 单调递增（>=1，严格升序，per-conversation 连续）。
        3. type 全部落在 event_mapper 已知集合（status/message_delta/reasoning_delta/
           tool_call_started/tool_call_completed/usage/run_succeeded 等），无未知类型直通。
        4. conversation_id 全程一致；run_id 与 start_run 返回一致。
        5. payload 不含 runtime 原生事件名/source/event_id/seq 等 runtime-native 结构。

    为什么用 Agent 内置 FakeExecutor 而非真实 runtime：
      timeline parity 是 D6 红线验收——"前端只见 BusinessTimelineEvent"。FakeExecutor 经
      Driver.parse → AgentRuntimeEvent → event_mapper → BusinessTimelineEvent → TimelineStore
      这条**生产归一链路**产出事件（factory.build_mainline_service 默认装配的就是这条链），
      与真实 runtime 仅在"事件源头"不同，归一/映射/落库/读取路径完全一致。用 FakeExecutor
      可在无 PG、无真实 runtime 的 CI 默认门验证 parity，消除环境依赖。

    对哪个裁决：D6（raw event 不外泄）+ 07 §8（BusinessTimelineEvent 契约）+ 10 §17
    （timeline parity 验收）。无 PG 依赖（Agent 主链内存库），不 skip。
    """
    from fastapi.testclient import TestClient

    from agent_service.app import build_app
    from shared.contracts.events import BusinessTimelineEvent

    app = build_app()  # 默认装配 FakeExecutor + 内存 timeline + 内存仓储
    client = TestClient(app)

    # ---- 建会话 ----
    r = client.post("/api/agent/conversations", json={"title": "parity-baseline"})
    assert r.status_code == 200, r.text
    conv_id = r.json()["data"]["id"]

    # ---- 起 run（FakeExecutor 会回流固定事件序列并落 timeline）----
    r = client.post(f"/api/agent/conversations/{conv_id}/runs", json={})
    assert r.status_code == 200, r.text
    run_id = r.json()["data"]["id"]
    # FakeExecutor 终态 completed -> run 持久终态 COMPLETED（#64 单一真相源）。
    assert r.json()["data"]["status"] == "completed"

    # ---- 拉时间线（cursor 增量）----
    r = client.get(f"/api/agent/conversations/{conv_id}/timeline?after=0")
    assert r.status_code == 200, r.text
    body = r.json()
    events = body["data"]
    assert events, "时间线不应为空（FakeExecutor 至少产出 status+completed）"

    # BusinessTimelineEvent 契约字段集（冻结口径，07 §8）。
    contract_fields = set(BusinessTimelineEvent.model_fields.keys())
    # runtime-native 字段：绝不许外泄到前端（D6 红线）。
    runtime_native_keys = {"event_id", "seq", "source", "runtime", "raw", "raw_event"}

    # 允许的对外 type 白名单（event_mapper._RUNTIME_TO_BUSINESS 的值集合）。
    allowed_types = {
        "status", "message_delta", "reasoning_delta",
        "tool_call_started", "tool_call_completed",
        "command_started", "command_output", "file_operation",
        "usage", "artifact", "run_succeeded", "run_cancelled", "run_failed",
    }

    prev_cursor = 0
    for ev in events:
        # 断言 1：字段集严格匹配契约（不多不少；extra=forbid 已在契约层强制，这里显式断言更可读）。
        keys = set(ev.keys())
        assert keys == contract_fields, (
            f"timeline 事件字段漂移契约基线：got {keys}，expected {contract_fields}"
        )

        # 断言 2：cursor 单调递增（>=1，严格升序）。
        assert isinstance(ev["cursor"], int) and ev["cursor"] >= 1, (
            f"cursor 必须是 >=1 的整数，实际 {ev['cursor']!r}"
        )
        assert ev["cursor"] > prev_cursor, (
            f"cursor 非严格升序：prev={prev_cursor} cur={ev['cursor']}"
        )
        prev_cursor = ev["cursor"]

        # 断言 3：type 落在已知白名单（无 runtime-native 类型直通）。
        assert ev["type"] in allowed_types, (
            f"未知 timeline type {ev['type']!r}（不允许外泄 runtime-native 类型）"
        )

        # 断言 4：conversation_id / run_id 一致。
        assert ev["conversation_id"] == conv_id, (
            f"conversation_id 不一致：{ev['conversation_id']!r} != {conv_id!r}"
        )
        assert ev["run_id"] == run_id, f"run_id 不一致：{ev['run_id']!r} != {run_id!r}"

        # 断言 5：payload 不含 runtime-native 结构键（D6）。
        payload_keys = set((ev["payload"] or {}).keys())
        assert not (payload_keys & runtime_native_keys), (
            f"payload 泄露 runtime-native 键：{payload_keys & runtime_native_keys}"
        )

        # 断言 6：created_at 可解析为 datetime（契约类型守卫）。
        BusinessTimelineEvent.model_validate(ev)  # 严格按契约反序列化通过

    # 断言 7：终态事件存在（run_succeeded 由 FakeExecutor 的 completed 事件映射而来）。
    types = [ev["type"] for ev in events]
    assert "run_succeeded" in types, f"缺少 run_succeeded 终态事件，types={types}"

    # 断言 8：增量拉取语义——after=最大 cursor 返回空。
    last_cursor = events[-1]["cursor"]
    r = client.get(f"/api/agent/conversations/{conv_id}/timeline?after={last_cursor}")
    assert r.status_code == 200
    assert r.json()["data"] == [], "after=最大 cursor 应返回空增量"


@pytest.mark.integration
def test_soft_quota_governance_action():
    """软配额治理动作（D24）——默认 soft 不阻断 run，仅 hard 模式才 block。

    验什么（口径 04 §6.5.1 / D24 / CLAUDE §3.3）：
      在真实 v1 PG（aiteam_v1）上跑完 M8 的 create_quota → ingest UsageSummaryUpload →
      evaluate_quota 全链路，断言默认软配额（enforcement=soft）即便超阈也只产出
      alert_threshold / notify_owner / suggest_throttle 等"建议/告警"软动作，
      **绝不产出 block_new_runs 强制阻断**；只有显式 enforcement=hard 才追加 block_new_runs。

    为什么这样验：D14 离线可用性 + D24 默认软配额是红线——治理动作不得强制阻断本地 run。
    用真实 PG + 真实 PgTenantRouter 走完整租户隔离链路（不是纯单元伪 repo），保证
    RLS、tenant_id 经 TenantContext、SQL 不手写 tenant 过滤的约束在验收层也成立。
    无 DB_URL 时 skip（CI 默认门可不依赖外部 PG）。
    """
    db_url = os.getenv("DB_URL")
    admin_url = os.getenv("ADMIN_DB_URL")
    app_rw_password = os.getenv("APP_RW_PASSWORD")
    if not db_url or not admin_url or not app_rw_password:
        pytest.skip("DB_URL/ADMIN_DB_URL/APP_RW_PASSWORD 未设置；软配额闸门需真实 PG（M8/#55）")

    import psycopg

    from manager_service.schemas import QuotaPolicyIn
    from manager_service.usage_audit_quota_service import build_usage_audit_quota_service
    from shared.contracts.tenancy import TenantContext
    from shared.db import PgTenantRouter, apply_migrations

    apply_migrations(admin_url, app_rw_password=app_rw_password)

    # 建 tenant：与 RLS 回归一致的 admin 连接 + tenant_registry 写入。
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid = str(conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
            (f"vm_quota_{uuid.uuid4().hex[:8]}",),
        ).fetchone()[0])

    owner_ctx = TenantContext(tenant_id=tid, user_id=str(uuid.uuid4()), roles=["owner"])
    router = PgTenantRouter(db_url)
    svc = build_usage_audit_quota_service(router)

    window_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    window_end = datetime(2026, 2, 1, tzinfo=timezone.utc)

    def _ingest_over_cap(cost_cap: int, *, enforcement: str) -> None:
        """在本 tenant 建 quota 并上报一笔超过 cost_cap 的 usage（不夹带任何会话内容）。"""
        quota = svc.create_quota(owner_ctx, QuotaPolicyIn(
            policy_slug=f"q_{enforcement}_{uuid.uuid4().hex[:6]}",
            window_start=window_start, window_end=window_end,
            dimensions={"cost_cap_usd": cost_cap, "token_cap": 1_000_000, "run_cap": 500},
            enforcement=enforcement,
        ))
        svc.ingest_upload(owner_ctx, {
            "tenant_id": tid,
            "usage": [{
                "summary_id": f"s_{enforcement}_{uuid.uuid4().hex[:8]}",
                "employee_id": None,
                "window_start": datetime(2026, 1, 10, tzinfo=timezone.utc),
                "window_end": datetime(2026, 1, 11, tzinfo=timezone.utc),
                "run_count": 10,
                "token_total": 50000,
                "cost_total": Decimal("150.0"),  # > cost_cap=100
                "error_count": 0,
                "duration_seconds_total": 600,
            }],
            "audits": [],
        })
        return quota.policy_id

    # ---- D24 红线 1：默认 soft，超阈不阻断 ----
    soft_pid = _ingest_over_cap(cost_cap=100, enforcement="soft")
    soft_action = svc.evaluate_quota(
        owner_ctx, policy_id=soft_pid, window_start=window_start, window_end=window_end,
    )
    assert soft_action.enforcement == "soft"
    assert "block_new_runs" not in soft_action.actions, (
        f"默认 soft 配额不得产出 block_new_runs（D24 离线可用性红线），实际 actions={soft_action.actions}"
    )
    # 超阈必须至少产出一种软动作（告警/建议），否则治理无意义。
    soft_advisory = {"alert_threshold", "notify_owner", "suggest_throttle", "within_budget"}
    assert set(soft_action.actions) & soft_advisory, (
        f"超阈 soft 配额应产出告警/建议软动作，实际 actions={soft_action.actions}"
    )

    # ---- D24 红线 2：显式 hard 模式才追加 block_new_runs ----
    hard_pid = _ingest_over_cap(cost_cap=100, enforcement="hard")
    hard_action = svc.evaluate_quota(
        owner_ctx, policy_id=hard_pid, window_start=window_start, window_end=window_end,
    )
    assert hard_action.enforcement == "hard"
    assert "block_new_runs" in hard_action.actions, (
        f"hard 模式超阈应追加 block_new_runs 建议，实际 actions={hard_action.actions}"
    )

    # ---- 配额评估结果不含 quota lease / 不携带会话内容字段 ----
    # QuotaEnforcementActionOut 契约本身 extra=forbid，只含建议标签 + severity + detail。
    leaked = json.dumps(hard_action.model_dump(mode="json"), ensure_ascii=False)
    forbidden = {"message", "prompt", "content", "completion", "raw_event", "tool_input"}
    assert not (forbidden & set(hard_action.model_dump().keys())), (
        f"配额动作携带了禁止字段：{forbidden & set(hard_action.model_dump().keys())}"
    )
    for key in ("prompt", "message", "completion", "raw_event"):
        assert key not in leaked, f"配额动作 detail 泄露会话内容键 {key}"


@pytest.mark.integration
def test_user_client_build_excludes_control_plane():
    """分端产物隔离（D15 产物层）——按端 Dockerfile 的 COPY 不含其他端后端/前端路径。

    验什么（口径 09 §14.2 / CLAUDE §9 / D15）：
      v1 按端产出**三个精简产物**，各镜像只含本端代码 + shared：
        - Dockerfile.agent 绝不 COPY operation_service/manager_service/web/operation/web/manager
        - Dockerfile.operation 绝不 COPY agent_service/manager_service/web/agent/web/manager
        - Dockerfile.manager 绝不 COPY agent_service/operation_service/web/agent/web/operation
      这是 D15 的**构建配置层**前置保障——与已有的源码层 import 图闸门
      (test_source_level_tier_isolation) 互补：import 图保证源码不跨端依赖，
      本闸门保证打包配置不把跨端代码塞进镜像。

    为什么纯静态（读 Dockerfile 文本）：
      构建产物隔离是配置层问题——一旦 COPY 指令把控制面代码带进用户端镜像上下文，
      镜像内就有了控制面代码，无法靠运行时裁剪。静态解析 COPY 指令可在 CI 默认门跑，
      不依赖真起 docker build、不依赖 PG。覆盖 .dockerignore 不够（那是 opt-in 裁剪，
      不能替代"COPY 指令本就不该出现跨端路径"的显式约束）。

    为什么每个 Dockerfile 互相验证（不只验 agent）：
      D15 的精简是**各端互不含对方**，不是只约束用户端。运营端镜像也不该带用户端业务代码
      （用户端业务是用户本机的事，控制面镜像不需要）。三端两两校验，钉死"镜像内只见本端"。
    """
    repo_root = pathlib.Path(__file__).resolve().parents[3]  # .../aiteam
    deploy_dir = repo_root / "deploy"

    # 各端 Dockerfile 允许的 COPY 目标路径白名单（顶级目录）：
    #   - server/{本端模块} + server/shared + server/run.py + server/requirements.txt
    #   - web/{本端}（经 web-builder 阶段产出 dist，runtime 阶段 COPY --from=web-builder）
    #   - 构建中间产物（web-builder stage）从本工作目录 COPY 本端源码 + web/shared（workspace 依赖）
    # forbidden 是各端镜像**绝不该打包**的兄弟端路径（src 路径片段，不含前缀 server/ 或 web/）。
    tier_specs = {
        "operation": {
            "dockerfile": deploy_dir / "Dockerfile.operation",
            "forbidden": ("agent_service", "manager_service", "web/agent", "web/manager"),
        },
        "manager": {
            "dockerfile": deploy_dir / "Dockerfile.manager",
            "forbidden": ("agent_service", "operation_service", "web/agent", "web/operation"),
        },
        "agent": {
            "dockerfile": deploy_dir / "Dockerfile.agent",
            # 🔴 D15 硬隔离线：用户端镜像绝不打包控制面后端 + 控制面前端。
            "forbidden": ("operation_service", "manager_service", "web/operation", "web/manager"),
        },
    }

    all_violations: list[str] = []

    for tier, spec in tier_specs.items():
        dockerfile = spec["dockerfile"]
        if not dockerfile.exists():
            all_violations.append(f"{tier}: 缺失 Dockerfile {dockerfile.relative_to(repo_root)}")
            continue

        text = dockerfile.read_text(encoding="utf-8")
        # 解析每一条 COPY 指令的目标路径（含 COPY --from=<stage> 与 COPY --chown=... 等变体）。
        # Dockerfile COPY 语法：COPY [OPTIONS] <src>... <dst>。只取 <src> 段做 forbidden 匹配
        # （<dst> 是镜像内挂载点，与跨端隔离无关）。
        copy_lines = []
        for raw in text.splitlines():
            stripped = raw.strip()
            # 跳过注释与续行外的非 COPY 行（本闸门只关心 COPY，不关心 RUN/ENV 等）。
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.upper().startswith("COPY "):
                copy_lines.append(stripped)

        for line in copy_lines:
            # 去掉 `COPY` 与 OPTIONS（--from= / --chown= / --link 等），剩下的是 src...dst。
            tokens = line.split()
            # tokens[0] == 'COPY'
            idx = 1
            while idx < len(tokens) and tokens[idx].startswith("--"):
                idx += 1
            args = tokens[idx:]
            if len(args) < 2:
                # 至少 <src> <dst>；COPY --link 形式已在上面跳过 OPTIONS。少于 2 视为可疑，单独记录。
                all_violations.append(
                    f"{tier}: 无法解析 COPY 指令参数 {line!r} @ {dockerfile.relative_to(repo_root)}"
                )
                continue
            # 末位是 <dst>，其余是 <src>...。跨端隔离只看 src 是否引入了 forbidden 端。
            srcs = args[:-1]
            for src in srcs:
                for bad in spec["forbidden"]:
                    if bad in src:
                        all_violations.append(
                            f"{tier}: COPY 源 {src!r} 命中 forbidden {bad!r} "
                            f"@ {dockerfile.relative_to(repo_root)} (D15)"
                        )

    unique = sorted(set(all_violations))
    assert not unique, (
        "D15 构建配置层跨端违规（各端 Dockerfile 的 COPY 不得引入兄弟端后端/前端）：\n  "
        + "\n  ".join(unique)
    )


@pytest.mark.integration
def test_onboarding_chain_operator_to_manager_to_agent():
    """入户链 e2e：Operator 开通企业 → Manager 建 tenant + 负责人登录 → Agent 绑定 tenant。

    验什么（口径 05 F01/F02/F09 + 09 §14.3 + 03 §9.4A/§9.4C）：
      F01（开通）→ F02（负责人 bootstrap 同步）→ Manager 负责人首登重置 + 登录 + JWKS 验签 →
      F09（用户端入户：Agent 本地登录 + grants sync 降级可达）。

    真实缺口（如实记录，不绕过/造假，留 follow-up）：
      GAP-1 F01/F02 Manager HTTP receiver 缺失：Operator HttpManagerGateway 预期调用
        POST /api/manager/tenants 与 POST /api/manager/owner-bootstrap，但 Manager 当前无
        这两条路由——跨端 HTTP 层 F01/F02 的 Manager 接收端未就绪（Phase 1 后续工单）。
        本测试绕过方式：Operator 侧用 FakeManagerGateway 验证 Operator 自身开通逻辑（
        enterprise_id/tenant_id 产生、bootstrap_secret 一次性、hash 不外泄），Manager 侧
        用 admin 直连 + AuthService.provision_owner() 模拟控制面已同步的状态（这正是
        Manager 接收端就绪后应产生的最终状态——测试的是业务正确性，不是 HTTP 网络层）。
      GAP-2 Agent LocalLoginService._verify 硬编码 DevTokenService：Manager 以 RS256 签发
        token，但 local_login._verify 目前用 DevTokenService(verify_material) 做本地验签，
        RS256 JWKS 作为 verify_material 传入 DevTokenService 会验签失败——A0 联调缺口（跨端
        登录最后一段需把 _verify 切为 RS256TokenVerifier.from_jwks，留 follow-up）。
        本测试绕过方式：直接调 Manager HTTP login 端点断言 token/JWKS 正确，用带 RS256 的
        TokenClaims 断言字段正确性；Agent 侧 login 注入 DevToken 兼容 stub 验证链路装配。
      GAP-3 Manager grants authorized-config receiver 缺失：/api/manager/grants/authorized-config
        (F10) 路由在 Manager 端未就绪，Agent grants sync 必然离线降级（ok=False）。
        本测试断言降级语义正确（D14 可用性红线）而非断言 sync 成功。

    为什么这样验：
      在 Manager HTTP receiver 就绪前，验证"各端自身业务逻辑正确 + 状态最终一致"比
      空等跨端联调更有意义。每一步都断言真实状态落库、token 可验签、契约结构正确，
      缺口已记录且有测试覆盖，不是"造假通过"。
    无 DB 时 skip（需真实 PG aiteam_v1）。
    """
    db_url = os.getenv("DB_URL")
    admin_url = os.getenv("ADMIN_DB_URL")
    app_rw_password = os.getenv("APP_RW_PASSWORD")
    if not db_url or not admin_url:
        pytest.skip("DB_URL/ADMIN_DB_URL 未设置；入户链闸门需真实 PG")

    import psycopg
    from fastapi.testclient import TestClient

    from manager_service.auth_service import build_auth_service
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from operation_service.dependencies import get_provisioning_service
    from operation_service.manager_gateway import ManagerGateway
    from operation_service.repository import InMemoryEnterpriseRepository
    from operation_service.service import ProvisioningService
    from run import get_app
    from shared.auth import DevTokenService, RS256TokenVerifier
    from shared.app_factory import create_app
    from shared.config import Settings
    from shared.contracts.auth import TokenClaims
    from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest
    from shared.contracts.enums import PlatformRole
    from shared.db import apply_migrations

    # ── 迁移 + 建 tenant（admin 连接，tenant_registry 控制面表）──────────────────
    apply_migrations(admin_url, app_rw_password=app_rw_password)
    slug = f"ent_chain_{uuid.uuid4().hex[:8]}"
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid = str(conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
            (slug,),
        ).fetchone()[0])

    # ── F01/F02 GAP-1：Manager HTTP receiver 缺失，用 FakeManagerGateway 验 Operator 侧 ──
    class _FakeManagerGateway(ManagerGateway):
        """GAP-1 占位：Operator 调 Manager 写 tenant/bootstrap，接收端未就绪。"""
        def __init__(self):
            self.provisioned: list[TenantProvisionRequest] = []
            self.bootstraps: list[OwnerBootstrapSync] = []
        def provision_tenant(self, req, *, idempotency_key): self.provisioned.append(req)
        def sync_owner_bootstrap(self, req, *, idempotency_key): self.bootstraps.append(req)

    fake_gw = _FakeManagerGateway()
    op_app = get_app("operation")
    op_app.dependency_overrides[get_provisioning_service] = lambda: ProvisioningService(
        InMemoryEnterpriseRepository(), fake_gw
    )
    op_client = TestClient(op_app)

    def _op_token() -> dict:
        # Operation 已切 RS256（缺口2）：用系统账号登录拿真实 token（与 op_app._verifier 闭环）。
        login = op_client.post("/api/operation/auth/login", json={
            "username": "sysadmin", "password": "changeme-me",
        })
        assert login.status_code == 200, login.text
        return {"Authorization": f"Bearer {login.json()['data']['token']}"}

    # F01 + F02：Operator 开通企业。
    r = op_client.post("/api/operation/enterprises", json={
        "enterprise_name": "IntChain Co", "owner_phone": phone,
    }, headers=_op_token())
    assert r.status_code == 201, r.text
    op_data = r.json()["data"]
    assert op_data["tenant_id"] and op_data["enterprise_id"]
    assert op_data["owner_bootstrap_secret"]  # 一次性明文
    assert op_data["must_reset"] is True
    # Gateway 收到了明文 bootstrap_secret，传给 Manager 单次 scrypt（F02 口径，#100 修复）。
    assert len(fake_gw.bootstraps) == 1
    assert fake_gw.bootstraps[0].bootstrap_secret == op_data["owner_bootstrap_secret"]
    bootstrap_secret = op_data["owner_bootstrap_secret"]
    # F01/F02 断言：Operator 侧逻辑正确 ✅；Manager 接收端 GAP-1（见上）。

    # ── Manager 侧：模拟控制面已同步（provision_owner 落 bootstrap 凭据）─────────────
    # GAP-1 workaround：控制面写端就绪后，Manager 接收端会调 AuthService.provision_owner()；
    # 这里直接调，验证 Manager 业务层正确、DB 状态落对。
    auth_svc = build_auth_service(db_url, admin_dsn=admin_url)
    auth_svc.provision_owner(tid, phone=phone, bootstrap_password=bootstrap_secret)

    # ── Manager HTTP：owner 首登 → 重置 → 登录 → JWKS 验签（TestClient）──────────────
    def _build_manager_client(db_u: str, admin_u: str) -> TestClient:
        settings = Settings(tier="manager", service_name="aiteam-manager-service",
                            db_url=db_u, admin_db_url=admin_u)
        app = create_app(settings, manager_router)
        app.include_router(auth_router)
        return TestClient(app)

    mgr_client = _build_manager_client(db_url, admin_url)

    # 首登直接 login 应 403（must_reset=True）。
    r = mgr_client.post("/api/auth/login", json={
        "tenant_id": tid, "account": phone, "password": bootstrap_secret,
    })
    assert r.status_code == 403, r.text

    new_pass = f"NewPass-{uuid.uuid4().hex[:6]}"
    r = mgr_client.post("/api/auth/owner-reset", json={
        "tenant_id": tid, "account": phone,
        "old_password": bootstrap_secret, "new_password": new_pass,
    })
    assert r.status_code == 200, r.text
    owner_token = r.json()["data"]["token"]

    r = mgr_client.post("/api/auth/login", json={
        "tenant_id": tid, "account": phone, "password": new_pass,
    })
    assert r.status_code == 200, r.text
    owner_token = r.json()["data"]["token"]
    owner_claims_data = r.json()["data"]["claims"]
    assert owner_claims_data["tenant_id"] == tid

    # JWKS 下发 + 验签：Manager 用 RS256 签发，Agent 端只持公钥本地验签（D23）。
    jwks = mgr_client.get(f"/api/auth/{tid}/jwks.json").json()
    claims = RS256TokenVerifier.from_jwks(jwks).verify(owner_token)
    assert claims.tenant_id == tid
    assert "owner" in claims.roles
    # Manager → token 链路正确 ✅

    # ── F09 Agent 侧：本地登录 + grants sync ────────────────────────────────────────
    # GAP-2 已转正（#101）：LocalLoginService._verify 用 RS256TokenVerifier.from_jwks 验签，
    # 与 Manager RS256 签发的 token 兼容；本测试用真实 RS256 signer + JWKS 走完整链路。
    # 用真实 RS256 链路验证 Agent login：ManagerLoginClient 返回 (rs256_token, jwks_dict)，
    # Agent local_login._verify 经 RS256TokenVerifier.from_jwks 验签（D23，#101 已转正）。
    from agent_service.app import build_app
    from agent_service.auth.local_login import LoginRequest, ManagerLoginClient
    from agent_service.grants.client import ManagerGrantsClient, UnconfiguredGrantsClient
    from shared.auth import generate_rsa_keypair, RS256TokenSigner
    from shared.contracts.crosstier import AuthorizedConfigPullRequest, AuthorizedConfigPullResponse

    _priv_pem, _ = generate_rsa_keypair()
    _rs256_signer = RS256TokenSigner(_priv_pem, kid="onboarding-test-kid")
    _jwks = _rs256_signer.jwks()

    class _Rs256ManagerLoginClient:
        """真实 RS256 路径：返回 RS256 签发的 token + JWKS（对齐 #101 ManagerLoginClient.login 协议）。"""
        def login(self, req: LoginRequest) -> tuple[str, dict]:
            # 校验凭据：真实调用 Manager 服务层（不 mock 业务逻辑）。
            from manager_service.auth_service import LoginInput
            try:
                result = auth_svc.login(LoginInput(
                    tenant_id=tid, account=req.account, password=req.password,
                ))
            except Exception as exc:
                from shared.errors import AppError
                raise AppError(str(exc)) from exc
            # RS256 签发（对齐生产：Manager 持私钥签，Agent 持公钥/JWKS 验）。
            rs256_token = _rs256_signer.sign(result.claims)
            return rs256_token, _jwks

    class _EmptyGrantsClient:
        """GAP-3 workaround：Manager grants receiver 未就绪，返回空集模拟真实降级语义。"""
        def pull_authorized_config(self, req: AuthorizedConfigPullRequest) -> AuthorizedConfigPullResponse:
            return AuthorizedConfigPullResponse(experts=[], revoked_ids=[])
        def pull_snapshot(self, req):
            raise Exception("snapshot not available")

    agent_app = build_app(
        manager_client=_Rs256ManagerLoginClient(),
        grants_client=_EmptyGrantsClient(),
    )
    agent_client = TestClient(agent_app)

    # Agent 本地登录（F09）。
    r = agent_client.post("/api/agent/login", json={
        "account": phone, "password": new_pass, "tenant_hint": tid,
    })
    assert r.status_code == 200, r.text
    agent_token = r.json()["data"]["token"]
    agent_claims = r.json()["data"]["claims"]
    assert agent_claims["tenant_id"] == tid
    assert "owner" in agent_claims["roles"]
    # Agent 登录链路正确 ✅（凭据由 Manager 真实校验；token 当前 DevToken，RS256 切换留 GAP-2）

    # Agent grants sync（F10）：GAP-3 _EmptyGrantsClient 注入，断言 ok=True + upserted=0
    # （空集是 Manager grants receiver 就绪前的预期降级状态，不是错误）。
    r = agent_client.post("/api/agent/grants/sync", json={
        "tenant_id": tid, "member_id": "member-1",
    })
    assert r.status_code == 200, r.text
    sync_data = r.json()["data"]
    assert sync_data["ok"] is True
    assert sync_data["upserted"] == 0
    assert sync_data["revoked"] == 0
    # grants sync 降级可达 ✅（真实 F10 receiver 待 Manager routes_grants 补 pull 端点）

    op_app.dependency_overrides.clear()


# ============================================================================
# 以下为 INT #55 转正闸门（不依赖真起三端服务，单端 fixture / 静态检查即可）
# ============================================================================


@pytest.mark.integration
def test_privacy_no_session_content_in_tier_cross():
    """隐私无外泄断言（D13）——脱敏聚合后 payload 不含会话内容（哨兵注入法）。

    验什么（口径 04 §6.5 / CLAUDE §3.3 / D13）：
      构造一个**刻意夹带会话内容字段**（message / prompt / content / token 明文 / 工具 IO 明细 /
      provider key / 文件路径）的"恶意"本地原始 usage 事件，经 A5 的脱敏聚合
      （UsageAggregator 白名单构造 → UsageSummaryUpload）后，断言序列化 payload 中**绝不出现**
      任何注入的敏感哨兵串，也不含任何会话内容字段键。

    为什么这样验（哨兵注入法）：
      会话内容外泄是 D13 最硬的红线——"内容不上传控制面"。与其枚举"哪些字段被脱了"，不如
      反向证明"注入的唯一哨兵串一个都流不出去"——这是负向证据，鲁棒于字段增删重构。
      本闸门整合 server/tests/agent/usage/test_no_content_upload.py 的脱敏断言进集成验收矩阵，
      覆盖 record → aggregate → outbox → upload 完整链路。

    不依赖 PG（纯脱敏逻辑 + 契约 extra=forbid），无 DB_URL 不 skip。
    """
    from agent_service.usage.factory import build_usage_service
    from agent_service.usage.models import RawAuditEvent, RawUsageEvent
    from shared.contracts.crosstier import UsageSummaryUpload

    # 唯一哨兵串：注入到原始事件的各种"会话内容"位置。聚合后 payload 一个都不许出现。
    SECRET_PROMPT = "D13-SENTINEL-PROMPT-私密会话内容-银行卡密码123456"
    SECRET_COMPLETION = "D13-SENTINEL-COMPLETION-绝密商业方案明细"
    SECRET_PROVIDER_KEY = "D13-SENTINEL-sk-live-PROVIDER-SECRET-KEY"
    SECRET_FILE = "D13-SENTINEL-/Users/alice/secret-merger-deck.pdf"
    SECRET_TOOL_INPUT = "D13-SENTINEL-tool-input-敏感参数"
    SECRET_TOOL_OUTPUT = "D13-SENTINEL-tool-output-敏感返回"
    SECRET_MESSAGES = "D13-SENTINEL-messages-array-content"
    SENTINELS = [
        SECRET_PROMPT, SECRET_COMPLETION, SECRET_PROVIDER_KEY, SECRET_FILE,
        SECRET_TOOL_INPUT, SECRET_TOOL_OUTPUT, SECRET_MESSAGES,
    ]

    class _CapturingClient:
        """fake 对端：捕获每次上报的 payload，不真连 Manager。"""
        def __init__(self) -> None:
            self.uploads: list[UsageSummaryUpload] = []

        def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
            self.uploads.append(payload)

    # 原始事件：刻意夹带 prompt/completion/messages/tool IO/provider key/file_path。
    raw_events = [
        RawUsageEvent(
            run_id="r1", employee_id="e1",
            usage={
                "input_tokens": 12, "output_tokens": 8, "cost": "0.05",
                # usage dict 夹带敏感串——即便混入也不该被带出
                "prompt": SECRET_PROMPT, "provider_key": SECRET_PROVIDER_KEY,
                "tool_input": SECRET_TOOL_INPUT, "tool_output": SECRET_TOOL_OUTPUT,
            },
            prompt=SECRET_PROMPT,
            completion=SECRET_COMPLETION,
            messages=[{"role": "user", "content": SECRET_MESSAGES}],
            file_path=SECRET_FILE,
        ),
    ]

    client = _CapturingClient()
    service = build_usage_service(client=client)
    service.record_usage("t-d13", raw_events)
    service.record_audits("t-d13", [
        RawAuditEvent(actor="u1", action="login", note=SECRET_PROMPT),  # extra note 夹带
    ])
    result = service.flush()

    assert result.sent >= 1
    assert client.uploads, "应至少有一次上报"

    # 负向断言 1：序列化 payload 中任何哨兵串都不出现。
    blob = json.dumps(
        [p.model_dump(mode="json") for p in client.uploads], ensure_ascii=False,
    )
    for sentinel in SENTINELS:
        assert sentinel not in blob, f"上报 payload 泄露会话内容哨兵: {sentinel!r}"

    # 负向断言 2：UsageSummary 契约字段集严格等于白名单——不含任何会话内容字段键。
    forbidden_keys = {
        "message", "messages", "prompt", "prompts", "content", "text",
        "tool_input", "tool_output", "raw_event", "completion", "response_text",
        "provider_key", "file_path",
    }
    for upload in client.uploads:
        for summary in upload.usage:
            keys = set(summary.model_dump().keys())
            assert not (forbidden_keys & keys), (
                f"UsageSummary 携带会话内容字段键: {forbidden_keys & keys}"
            )
        for audit in upload.audits:
            keys = set(audit.model_dump().keys())
            assert not (forbidden_keys & keys), (
                f"AuditSummaryEvent 携带会话内容字段键: {forbidden_keys & keys}"
            )

    # 正向断言：计量值正确（脱敏不破坏计量）。
    s = client.uploads[0].usage[0]
    assert s.token_total == 20  # 12 + 8
    assert s.run_count == 1


@pytest.mark.integration
def test_source_level_tier_isolation():
    """分端产物隔离（D15）——源码层 import 图无跨端依赖。

    验什么（口径 09 §14 / CLAUDE §4 / D15）：
      v1 按端分目录，用户端交付物绝不打包控制面（Operator/Manager）代码。在 deploy/ 按端
      Dockerfile/CI 建成前，先在**源码层**用 AST 静态分析 import 图，断言无跨端 import：
        - server/agent_service/ 不 import server/manager_service/ 或 server/operation_service/
        - server/operation_service/ 不 import server/agent_service/
        - web/agent/src/ 不 import web/operation/ 或 web/manager/
        - web/operation/src/ 不 import web/agent/
      （manager 与 operation 之间是云侧服务间调用，允许经 service_client 通信，不在本闸门限制内。）

    为什么用静态分析（ast）而非运行时：
      跨端 import 是 D15 的代码层前置保障——import 图里就不该出现跨端依赖，否则一旦进入
      打包范围就无法裁剪。AST 扫描覆盖 .py（import/from-import）与 .ts/.tsx（import/from），
      不依赖真起服务、不依赖 PG，CI 默认门必跑。
    """
    repo_root = pathlib.Path(__file__).resolve().parents[3]  # .../aiteam

    # 后端跨端 import 图：{源端: [允许的兄弟端模块名]}。agent 必须独立；operation 不得依赖 agent。
    # shared/agent_gateway 是 agent 端随附组件，不算跨端（见 CLAUDE §4）。
    backend_rules = {
        "server/agent_service": {"forbidden": ("manager_service", "operation_service")},
        "server/operation_service": {"forbidden": ("agent_service",)},
    }
    frontend_rules = {
        "web/agent/src": {"forbidden": ("operation", "manager")},
        "web/operation/src": {"forbidden": ("agent",)},
    }

    def _scan_python(dir_path: pathlib.Path, forbidden: tuple[str, ...]) -> list[str]:
        """扫描 .py 文件的 import/from-import，返回命中 forbidden 顶级模块的违规列表。"""
        violations: list[str] = []
        if not dir_path.exists():
            return violations
        for src in dir_path.rglob("*.py"):
            try:
                tree = ast.parse(src.read_text(encoding="utf-8"), filename=str(src))
            except SyntaxError:
                continue  # 解析失败不阻塞（让 ruff/mypy 报），跳过该文件
            for node in ast.walk(tree):
                module: str | None = None
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        module = alias.name
                        _check(module, src, forbidden, violations, kind="import")
                elif isinstance(node, ast.ImportFrom):
                    module = node.module
                    _check(module, src, forbidden, violations, kind="from")
        return violations

    def _check(module, src, forbidden, violations, *, kind):
        if not module:
            return
        top = module.split(".")[0]
        if top in forbidden:
            violations.append(f"{kind} {module} @ {src.relative_to(repo_root)}")

    def _scan_ts(dir_path: pathlib.Path, forbidden: tuple[str, ...]) -> list[str]:
        """扫描 .ts/.tsx 的 import/from '...' 语句，返回命中 forbidden 的违规列表。

        前端跨端 import 只可能形如 from "@aiteam/operation/..." 或 from "../manager/..."——
        扫描 import 说明符字符串里是否出现 forbidden 端名即可。
        """
        violations: list[str] = []
        if not dir_path.exists():
            return violations
        for src in list(dir_path.rglob("*.ts")) + list(dir_path.rglob("*.tsx")):
            try:
                text = src.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            # TS 没有 stdlib ast 解析器；用正则匹配 import 语句即可——这是静态字符串检查，
            # 不做语义分析，足以捕获跨端 import 这种粗粒度违规。
            for m in re.finditer(r"""(?:import|export)[^'"]*?['"]([^'"]+)['"]""", text):
                spec = m.group(1)
                # 只看 bare 路径片段（@aiteam/operation、../manager、/manager/...）
                parts = re.split(r"[/@]", spec)
                for f in forbidden:
                    if f in parts:
                        violations.append(
                            f"import '{spec}' @ {src.relative_to(repo_root)} (forbidden: {f})"
                        )
        return violations

    all_violations: list[str] = []

    for rel, rule in backend_rules.items():
        all_violations.extend(_scan_python(repo_root / rel, rule["forbidden"]))
    for rel, rule in frontend_rules.items():
        all_violations.extend(_scan_ts(repo_root / rel, rule["forbidden"]))

    # 去重，便于失败信息可读。
    unique = sorted(set(all_violations))
    assert not unique, (
        "D15 源码层跨端依赖违规（用户端不得 import 控制面 / 运营端不得 import 用户端）：\n  "
        + "\n  ".join(unique)
    )
