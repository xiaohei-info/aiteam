"""Wave 0 共享测试底座 fixtures（最终执行 DAG §5.1 P1-F1~F7）。

后续三端 Service Integration（Phase 2）与 Browser E2E（Phase 3）共享本包：
- postgres：真 PG + 迁移 + RLS + 隔离 tenant scope（P1-F1）
- identities：operator/manager/agent/service-token/cross-tenant 身份（P1-F2）
- data_lifecycle：seed/cleanup（P1-F3）
- eventual：统一等待窗口 30/60/120/300s（P1-F4）
- diagnostics：失败诊断，不收集 secret/会话/文件/工具 I/O（P1-F7）

fixtures 经同目录 conftest.py 注册；契约测试同目录。
"""
