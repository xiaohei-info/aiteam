"""验证矩阵骨架（占位）。

这些是 Wave 2 集成验收的关键闸门，但依赖尚未建成的服务/DB/runtime，故先以 skip 占位、
钉死"必须验什么、归哪个 Phase、对哪份文档"。对应模块就绪后，去掉 skip 并填实。

防跑偏意义：把"完成"的客观标准提前写死在仓库里，避免各模块各自宣称完成却没有统一验收靶子。
"""

import pytest


@pytest.mark.integration
@pytest.mark.skip(reason="待 Manager 多租户底座+PG 就绪（Phase 1）；口径见 04 §6.1.1/§6.1.3，D20/D22")
def test_rls_cross_tenant_isolation():
    """RLS 跨租户串线回归：tenant A 的 token 不得读到 tenant B 数据（DB 与 RAG workspace 双测）。"""
    raise AssertionError("placeholder")


@pytest.mark.integration
@pytest.mark.skip(reason="待用户端本地主链就绪（Phase 2）；口径见 10 §17 / 07 §8")
def test_timeline_parity_vs_frozen_baseline():
    """streaming/timeline parity：事件类型/顺序/cursor/payload 关键字段对齐冻结契约基线。"""
    raise AssertionError("placeholder")


@pytest.mark.integration
@pytest.mark.skip(reason="待跨端链路就绪（Phase 2/4）；口径见 04 §6.5 / CLAUDE-AGENTS §3.3，D13")
def test_privacy_no_session_content_leaves_device():
    """隐私 e2e：跨端流量只含认证/授权/脱敏摘要，绝无会话内容/raw event/工具明细外泄。"""
    raise AssertionError("placeholder")


@pytest.mark.integration
@pytest.mark.skip(reason="待分端构建产物就绪（Phase 1+）；口径见 09 §14.2，D15")
def test_user_client_build_excludes_control_plane():
    """分端产物隔离：用户端交付物不含 operation/manager 后端与前端代码。"""
    raise AssertionError("placeholder")


@pytest.mark.integration
@pytest.mark.skip(reason="待入户链就绪（Phase 1）；口径见 09 §14.3 / 05 F01-F02-F09")
def test_onboarding_chain_operator_to_manager_to_agent():
    """入户链 e2e：Operator 开通企业→Manager 建 tenant→负责人登录→Agent 绑定 tenant。"""
    raise AssertionError("placeholder")
