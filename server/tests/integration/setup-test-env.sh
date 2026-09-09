#!/usr/bin/env bash
# Wave0 测试底座 PG 环境变量（与 docker-compose.test-pg.yml / .github/workflows/ci.yml 一致）。
#
# 用法（**source 本文件，别 copy-paste**——这样口令按变量真实展开，不受文档/日志展示层
# 把 URL 的 `:口令@` 位遮成 `***` 的影响）：
#
#     source server/tests/integration/setup-test-env.sh
#     # 非默认端口（如本地已占用 5432）：
#     PG_PORT=5440 source server/tests/integration/setup-test-env.sh
#
# 这些是一次性本地测试口令（与 docker-compose / ci.yml 完全相同的 postgres / apprwpass），
# 非生产 secret——本仓 docker-compose.test-pg.yml 与 ci.yml 已明文带同值。
#
# 两类连接（#60）：管理连接（postgres 超管，跑迁移/建角色/DDL）+ 业务连接（app_rw，受 RLS）。

export AITEAM_ENV="${AITEAM_ENV:-test}"
export PG_HOST="${PG_HOST:-localhost}"
export PG_PORT="${PG_PORT:-5432}"
export PG_SUPER_USER="${PG_SUPER_USER:-postgres}"
export PG_SUPER_PASSWORD="${PG_SUPER_PASSWORD:-postgres}"
# app_rw 的 LOGIN 口令——由首次 apply_migrations(ADMIN_DB_URL, app_rw_password=...) 幂等下发到 PG。
export APP_RW_PASSWORD="${APP_RW_PASSWORD:-apprwpass}"

export ADMIN_DB_URL="postgresql://${PG_SUPER_USER}:${PG_SUPER_PASSWORD}@${PG_HOST}:${PG_PORT}/manager_control_db"
export DB_URL="postgresql://app_rw:${APP_RW_PASSWORD}@${PG_HOST}:${PG_PORT}/manager_control_db"
export OPERATION_ADMIN_DB_URL="postgresql://${PG_SUPER_USER}:${PG_SUPER_PASSWORD}@${PG_HOST}:${PG_PORT}/operation_control_db"
export OPERATION_DB_URL="postgresql://app_rw:${APP_RW_PASSWORD}@${PG_HOST}:${PG_PORT}/operation_control_db"

# 运营端 app 装配需要（缺则三端 app 构建 setup 阶段 ERROR）。
export OPERATION_SYSTEM_USERNAME="${OPERATION_SYSTEM_USERNAME:-sysadmin}"
export OPERATION_SYSTEM_PASSWORD="${OPERATION_SYSTEM_PASSWORD:-changeme-me}"
export SERVICE_TOKEN="${SERVICE_TOKEN:-test-service-token}"

# sanity（口令脱敏后打印，确认 URL 已真实展开、不是 ***）：
echo "ADMIN_DB_URL=postgresql://${PG_SUPER_USER}:****@${PG_HOST}:${PG_PORT}/manager_control_db"
echo "DB_URL=postgresql://app_rw:****@${PG_HOST}:${PG_PORT}/manager_control_db"
echo "OPERATION_ADMIN_DB_URL=postgresql://${PG_SUPER_USER}:****@${PG_HOST}:${PG_PORT}/operation_control_db"
echo "OPERATION_DB_URL=postgresql://app_rw:****@${PG_HOST}:${PG_PORT}/operation_control_db"
