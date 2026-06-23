# SERVICE_TOKEN 配置指南

## 概述

`SERVICE_TOKEN` 是跨端服务间调用的共享密钥（平面③ 代码层守卫，CLAUDE.md §3 / 03 §9.1），用于以下场景：

- **Operator → Manager**：运营端调用企业端开通 tenant、bootstrap 负责人凭据
- **Agent → Manager**：用户端主动访问企业端 pull 配置、上报治理摘要

## 安全模式

### Dev 模式（fail-open）

适用于**本地开发和测试**环境，便于快速迭代。

**判定条件**（满足任一）：
- `SERVICE_TOKEN` 未配置（为空）
- `SERVICE_TOKEN` 值为 `dev-service-token-placeholder`
- `SERVICE_TOKEN` 值以 `dev-` 开头

**行为**：
- 未携带 token 的请求会被**放行**（仅日志警告）
- 携带错误 token 的请求会被**拒绝**（便于测试 token 校验逻辑）

### 生产模式（fail-closed）

适用于**生产部署**环境，严格校验服务身份。

**判定条件**：
- `SERVICE_TOKEN` 配置了非 dev 占位值的强密钥

**行为**：
- 所有服务间调用必须携带正确的 `X-Service-Token` 或 `Authorization: Bearer <token>`
- 未配置或 token 不匹配时返回 `401 Unauthorized`
- **生产模式未配置 SERVICE_TOKEN 时 fail-closed**：拒绝所有服务间调用

## 配置步骤

### 1. 生成强密钥

使用 OpenSSL 生成 256 位（32 字节）随机密钥：

```bash
openssl rand -hex 32
```

输出示例：
```
a3f8c9d2e1b4567890abcdef1234567890abcdef1234567890abcdef12345678
```

### 2. 配置环境变量

#### Docker Compose 部署

编辑 `deploy/docker-compose.yml`，替换所有服务的 `SERVICE_TOKEN` 为生成的强密钥：

```yaml
services:
  operation:
    environment:
      SERVICE_TOKEN: a3f8c9d2e1b4567890abcdef1234567890abcdef1234567890abcdef12345678
      # ... 其他配置

  manager:
    environment:
      SERVICE_TOKEN: a3f8c9d2e1b4567890abcdef1234567890abcdef1234567890abcdef12345678
      # ... 其他配置

  agent:
    environment:
      SERVICE_TOKEN: a3f8c9d2e1b4567890abcdef1234567890abcdef1234567890abcdef12345678
      # ... 其他配置
```

**重要**：所有端必须使用**相同的 SERVICE_TOKEN**。

#### 环境变量部署

直接在宿主环境中设置：

```bash
export SERVICE_TOKEN="a3f8c9d2e1b4567890abcdef1234567890abcdef1234567890abcdef12345678"
```

#### Kubernetes 部署

使用 Secret 管理：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: aiteam-service-token
type: Opaque
stringData:
  SERVICE_TOKEN: a3f8c9d2e1b4567890abcdef1234567890abcdef12345678
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aiteam-operation
spec:
  template:
    spec:
      containers:
      - name: operation
        env:
        - name: SERVICE_TOKEN
          valueFrom:
            secretKeyRef:
              name: aiteam-service-token
              key: SERVICE_TOKEN
```

### 3. 密钥轮换

生产环境应定期轮换 SERVICE_TOKEN（建议至少每 90 天）：

1. 生成新密钥
2. 更新所有端的配置
3. 重启服务（可使用滚动更新策略）
4. 验证跨端调用正常
5. 销毁旧密钥

## 验证

### 本地验证

启动服务后，检查日志：

**Dev 模式**（使用占位值）：
```
WARNING: SERVICE_TOKEN 使用 dev 占位值（dev-service-token-placeholder），服务间调用无真实校验。
生产环境必须替换为强密钥（见 deploy/SERVICE_TOKEN.md）
```

**生产模式**（使用强密钥）：
无警告日志，服务间调用需携带正确 token。

### 跨端调用测试

#### 正确 token（应成功）

```bash
curl -X POST http://localhost:8002/api/manager/internal/test \
  -H "X-Service-Token: <your-strong-token>" \
  -H "Content-Type: application/json"
```

#### 错误 token（应返回 401）

```bash
curl -X POST http://localhost:8002/api/manager/internal/test \
  -H "X-Service-Token: wrong-token" \
  -H "Content-Type: application/json"
```

#### 无 token（生产模式应返回 401）

```bash
curl -X POST http://localhost:8002/api/manager/internal/test \
  -H "Content-Type: application/json"
```

## 安全最佳实践

1. **密钥强度**：使用至少 256 位随机密钥（`openssl rand -hex 32`）
2. **密钥隔离**：不同部署环境（dev/staging/prod）使用不同密钥
3. **传输安全**：生产环境必须配合 TLS/HTTPS 使用（防止中间人攻击）
4. **密钥存储**：
   - 不要将生产密钥提交到版本控制系统
   - 使用 Secret 管理工具（Kubernetes Secret / AWS Secrets Manager / HashiCorp Vault）
   - 限制密钥访问权限（最小权限原则）
5. **密钥轮换**：定期更换密钥（建议至少每 90 天）
6. **审计日志**：监控服务间调用失败（可能是密钥泄露或攻击迹象）
7. **多层防护**：SERVICE_TOKEN 是代码层守卫，完整 mTLS 是部署层工程（09 §14.3）

## 故障排查

### 服务间调用返回 401

**原因 1：token 不匹配**
- 检查所有端的 `SERVICE_TOKEN` 环境变量是否一致
- 验证配置文件中没有多余空格或换行

**原因 2：生产模式未配置**
- 确认 `SERVICE_TOKEN` 已配置且不是 dev 占位值
- 查看服务启动日志是否有 "SERVICE_TOKEN not configured" 错误

**原因 3：header 未携带**
- 检查调用端是否使用 `ServiceClient` 或手动添加 `X-Service-Token` header
- 验证中间件/代理未删除该 header

### 日志中持续出现 dev 模式警告

- 确认已替换 `dev-service-token-placeholder` 为强密钥
- 确认密钥不以 `dev-` 开头
- 重启服务使新配置生效

## 后续演进

当前 SERVICE_TOKEN 是**过渡方案**（代码层共享密钥守卫）。完整服务间鉴权应采用：

- **mTLS（双向 TLS）**：部署层工程，基于 CA/证书体系（09 §14.3）
- **服务网格（Service Mesh）**：如 Istio / Linkerd，提供自动化 mTLS + 细粒度访问控制
- **零信任架构**：基于服务身份的动态授权（SPIFFE/SPIRE）

SERVICE_TOKEN 在演进到 mTLS 后可保留作为应用层二次校验。

## 参考文档

- CLAUDE.md §3：核心设计原则 - 窄通信面
- 03 §9.1：平面③ 跨端服务身份
- 05 §5.1：跨端调用统一客户端
- 09 §14.3：入户链与密钥建立（mTLS 完整方案）
