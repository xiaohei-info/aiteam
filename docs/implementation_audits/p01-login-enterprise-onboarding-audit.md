# P01 登录与企业入户实现审计

日期：2026-06-10  
工作树：`/Users/chiangguantik/.codex/worktrees/8f3a/aiteam`  
分支：`codex/p01-login-enterprise-onboarding`

## 结论

当前 P01 已从“登录后只有提示、没有真实企业入户闭环”的状态，推进到“mock-first 主链可跑通、关键自动化证据已补齐”的状态。

但**还不能**把 P01 判定为 `accepted_verified`。原因不是主链代码未通，而是：

- 部分验收项目前只有开发侧自动化证据，缺更完整的 QA / PM 级证据
- 失败矩阵虽然已补了一批，但还没有形成完整的产品级验收包

## 已完成的代码面

### 1. Auth onboarding northbound

已补齐：

- `POST /api/auth/onboarding/create-enterprise`
- `POST /api/auth/onboarding/join-enterprise`
- `GET /api/enterprises/current`

并保证：

- `/api/me` 会在企业创建/加入后更新 `current_enterprise`
- 重复加入同一企业返回 `409`
- 无效邀请码返回 `404`

证据文件：

- [app/team_panel/api_team/router_auth.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/team_panel/api_team/router_auth.py)
- [app/api/routes.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/api/routes.py)

### 2. 登录后企业入户承接

已补齐：

- 登录成功但无企业时跳到 `/app/workbench?onboarding=create_or_join_enterprise`
- workbench 内提供最小 create/join 表单
- 创建企业成功后回到 `/app/workbench`
- 邀请码加入成功后回到 `/app/workbench`
- 邀请码失败时在当前 onboarding 卡内显示错误，不静默失败

证据文件：

- [app/static/login.js](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/static/login.js)
- [app/static/aiteam/pages/app-workbench.js](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/static/aiteam/pages/app-workbench.js)

## 自动化证据

### 已通过命令

```bash
pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q
pytest app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py -q
pytest app/tests/aiteam/layer4_frontend_bff/test_workbench_page_rendering.py -q
pytest app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py -q
```

最新结果：

- `test_auth_northbound_routes.py` → `8 passed`
- `test_login_page_contract.py` → `8 passed`
- `test_workbench_page_rendering.py` → `11 passed`
- `test_login_enterprise_onboarding_flow.py` → `4 passed`

证据文件：

- [app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py)
- [app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py)
- [app/tests/aiteam/layer4_frontend_bff/test_workbench_page_rendering.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer4_frontend_bff/test_workbench_page_rendering.py)
- [app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py)

### Layer5 主路径证据

新增了更高层的业务 flow 证明：

- 手机号登录 → `/api/me` 返回 `onboarding.action`
- 创建企业 → `current_enterprise` 建立
- 邀请码加入企业 → `current_enterprise` 建立
- 无效邀请码 → 保持 `onboarding.action=create_or_join_enterprise`
- 重复加入同一企业 → 返回 `409` 且不破坏当前企业状态

这条证据比单独的 layer2/layer4 contract 更接近业务闭环。

## 真实运行证据

用系统 Python 在 `app/` 下启动 `server.py`，改用端口 `8788` 后可正常服务：

- `GET /health` 返回 `status: ok`
- 浏览器可打开 `http://127.0.0.1:8788/login`
- 浏览器实际触发了：
  - `POST /api/auth/login/wechat/init`
  - `GET /api/auth/login/wechat/poll?...`
  - `POST /api/auth/login/wechat/callback`
  - `GET /api/me`
  - `GET /app/workbench?onboarding=create_or_join_enterprise`

这说明：

- 登录页真实可访问
- mock 微信登录主链真实可走
- 登录成功后的 onboarding 承接路由真实存在

## 按 spec_id 的当前审计

| spec_id | 当前判断 | 依据 | 仍缺什么 |
|---|---|---|---|
| `P01-F01` | `开发侧基本满足` | 登录页默认扫码态、手机号 Tab、主文案与 CTA 有 contract 覆盖；真实页可访问 | 缺 PRD 原型逐项对照截图/录屏 |
| `P01-F02` | `开发侧基本满足` | 微信扫码 init/poll/callback、二维码失效提示、验证码发送/冷却/校验 已有 layer2/layer4 证据 | 缺更完整的扫码生命周期展示证据与手工验收 |
| `P01-F03` | `开发侧较强满足` | refresh rotation、replay 失效、device limit、IP cooldown 都已覆盖 | 缺更明确的前端会话失效产品反馈证据 |
| `P01-F04` | `主链已闭环` | create/join/current-enterprise + workbench onboarding 交互 + layer5 登录入户主路径 已实现并测试通过 | 缺 QA/PM 场景签收材料 |
| `P01-F05` | `开发侧证据明显增强，但仍未最终收口` | 验证码错误、二维码失效、无效邀请码、重复加入冲突已有 layer2/layer4/layer5 自动化证据 | 仍缺更完整的产品级失败矩阵与 QA/PM 证据 |

## 最近提交

- `1faa8e5` `test: cover p01 qr expiry feedback`
- `2463b54` `test: expand p01 onboarding and login contracts`
- `135c5c5` `feat: add p01 enterprise onboarding flow`
- `98bc927` `docs: add p01 login enterprise onboarding design`

## 下一步建议

1. 若继续补代码，优先补扫码超时这一格失败矩阵的更高层证据。
2. 补一轮真实页面截图或录屏，把 `P01-F01/F02/F04/F05` 的产品级证据补齐。
3. 若要追求 `accepted_verified`，需要把当前开发证据再整理成 QA / PM 可签收的材料，而不是只停在测试绿。
