# P01 登录与企业入户 QA / PM 验收清单

日期：2026-06-10  
范围：`docs/实施计划/验收规格包/2026-06-06-AI-Team-P01-登录与企业入户验收规格.md`

## 使用方式

本清单不是重新定义需求，而是把当前已实现的 P01 主链转换成 QA / PM 可直接执行的验收材料。

建议使用顺序：

1. 先跑自动化验证，确认当前基线无回归
2. 再按本清单做人工验收
3. 对每个 `spec_id` 记录：
   - `通过 / 不通过`
   - `证据链接`
   - `备注`

## 自动化基线

执行命令：

```bash
pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q
pytest app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py -q
pytest app/tests/aiteam/layer4_frontend_bff/test_workbench_page_rendering.py -q
pytest app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py -q
```

当前预期：

- `8 passed`
- `8 passed`
- `11 passed`
- `4 passed`

若任一命令失败，停止人工验收，先回到开发修复。

## P01-F01 登录页结构、默认入口与引导呈现

### QA 检查

- 打开 `/login`
- 确认默认 visible tab 为 `WeChat QR`
- 确认页面存在：
  - 扫码主文案
  - 手机号入口 tab
  - `Refresh QR code`
  - 协议提示文案
- 确认不是单按钮占位页

### PM 验收点

- 这是正式登录页而不是调试页
- 默认视觉焦点是扫码登录，不是 password / passkey

### 当前代码证据

- [app/api/routes.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/api/routes.py)
- [app/static/login.js](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/static/login.js)
- [app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py)

### 验收记录

- 状态：
- 证据：
- 备注：

## P01-F02 微信扫码 / 手机验证码双入口与生命周期反馈

### QA 检查

- 在登录页观察扫码自动启动
- 确认二维码可刷新
- 模拟二维码失效，确认有明确 expired 提示
- 切到手机号 tab
- 输入手机号发送验证码
- 确认按钮进入 `60s` 冷却
- 输入正确验证码，确认继续进入后续流程
- 输入错误验证码，确认显示错误并可重试

### PM 验收点

- 用户能理解两种入口
- 二维码过期不会让用户困惑
- 验证码冷却和错误反馈清晰

### 当前代码证据

- [app/static/login.js](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/static/login.js)
- [app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py)
- [app/team_panel/api_team/router_auth.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/team_panel/api_team/router_auth.py)

### 验收记录

- 状态：
- 证据：
- 备注：

## P01-F03 token / refresh / device / rate-limit 会话安全

### QA 检查

- 完成一次登录
- 验证 `/api/me` 在登录后可返回用户身份
- 验证 refresh 后 access token 可续期
- 验证旧 refresh token 重放会被拒绝
- 验证同一手机号发送验证码冷却生效
- 验证同 IP 高频登录会被限流
- 验证多设备超过上限后最旧设备会失效

### PM 验收点

- 不要求理解底层 token 细节，但不能出现“看起来登录成功，实际会话断掉”的体验

### 当前代码证据

- [app/team_panel/api_team/router_auth.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/team_panel/api_team/router_auth.py)
- [app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py)

### 验收记录

- 状态：
- 证据：
- 备注：

## P01-F04 首次企业创建 / 加入企业路径与登录成功进入反馈

### QA 检查

- 新用户手机号登录
- 确认进入 `/app/workbench?onboarding=create_or_join_enterprise`
- 在 onboarding 卡中创建企业
- 确认跳回 `/app/workbench`
- 新用户手机号登录后走邀请码加入
- 确认 `current_enterprise` 建立
- 确认 workbench 不再停留在 onboarding 提示态

### PM 验收点

- 登录成功后，用户能真正进入企业空间
- 不是“登录成功但卡在中间页”

### 当前代码证据

- [app/static/aiteam/pages/app-workbench.js](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/static/aiteam/pages/app-workbench.js)
- [app/team_panel/api_team/router_auth.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/team_panel/api_team/router_auth.py)
- [app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py)

### 验收记录

- 状态：
- 证据：
- 备注：

## P01-F05 登录失败、超时与异常恢复

### QA 检查

- 验证码错误后是否仍可重试
- 二维码失效后是否提示刷新
- 无效邀请码后是否仍保留 onboarding 状态
- 重复加入同一企业后是否返回冲突且不破坏当前企业状态
- 如可模拟，补扫二维码超时/网络异常场景

### PM 验收点

- 失败后不应静默卡死
- 用户能理解下一步该做什么

### 当前代码证据

- [app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py)
- [app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py)
- [app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py](/Users/chiangguantik/.codex/worktrees/8f3a/aiteam/app/tests/aiteam/layer5_flows/test_login_enterprise_onboarding_flow.py)

### 验收记录

- 状态：
- 证据：
- 备注：

## 汇总判断

当以下条件都满足时，P01 才可考虑从开发完成推进到更接近 `accepted_verified`：

- 自动化基线四条命令均通过
- `P01-F01 ~ P01-F05` 每项都有人工验收记录
- 至少补齐截图/录屏或同等级可复核证据
- QA / PM 对失败矩阵没有未解决阻塞项
