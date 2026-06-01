# 启动、联调和跑测试

这份文档讲的是：**怎么把 `app/` 跑起来，怎么做本地联调，怎么按层跑测试。**

## 1. 先确认目录关系

默认目录关系是：

```text
/home/ubuntu/code/aiteam/
├── app/
└── hermes-agent/
```

要求：
- `app/` 是 AI Team 当前主开发目录
- `hermes-agent/` 是外部运行时基座
- 默认不要把 AI Team 业务逻辑写进 `hermes-agent/`

## 2. 先做最小环境检查

在 `app/` 下至少能跑通：

```bash
cd /home/ubuntu/code/aiteam/app
python -V
python -m pytest --version
```

如果这里就失败，不要直接怀疑业务代码，先修 Python/venv/依赖环境。

## 3. 启动服务：优先用 `ctl.sh`

`ctl.sh` 是当前最适合开发联调的入口，因为它同时提供：
- 后台启动
- 状态查看
- 健康检查
- 日志查看
- 停止服务

### 3.1 启动

```bash
cd /home/ubuntu/code/aiteam/app
./ctl.sh start
```

默认绑定：
- host: `127.0.0.1`
- port: `8787`

也可以显式指定：

```bash
./ctl.sh start --host 0.0.0.0 8787
```

### 3.2 看状态

```bash
./ctl.sh status
```

这一步会告诉你：
- 进程是否还活着
- 当前 host / port
- 日志文件在哪里
- `/health` 是否正常

### 3.3 看日志

```bash
./ctl.sh logs --lines 200 --no-follow
./ctl.sh logs --follow
```

默认 WebUI 宿主层日志位置：
- `~/.hermes/webui.log`

### 3.4 停止

```bash
./ctl.sh stop
```

## 4. 需要前台看报错时再用这些命令

### 4.1 直接前台启动

```bash
cd /home/ubuntu/code/aiteam/app
python server.py
```

### 4.2 通过脚本前台启动

```bash
cd /home/ubuntu/code/aiteam/app
./start.sh --foreground
```

适合场景：
- 你正在查启动期异常
- 你想直接看 traceback
- 你不需要后台守护进程

## 5. 启动后先验什么

### 5.1 健康检查

```bash
curl -s http://127.0.0.1:8787/health
```

如果你改了 host/port，请替换成实际值。

### 5.2 页面是否能打开

最小检查：
- 打开 `http://127.0.0.1:8787/`
- 打开 `http://127.0.0.1:8787/system/health`
- 打开 `http://127.0.0.1:8787/admin/employees`

### 5.3 API 是否能通

```bash
curl -s http://127.0.0.1:8787/api/system-admin/health
curl -s http://127.0.0.1:8787/api/enterprise-admin/employees
curl -s http://127.0.0.1:8787/api/enterprise-admin/billing/usage
```

## 6. 本地 PostgreSQL：开发 Team Panel 数据层时再起

如果你只是看页面壳或查 host seam，不一定要先起 PostgreSQL。

如果你要：
- 跑 `tests/aiteam/layer1_data`
- 验证企业/员工/计费等 Team Panel 读写
- 验证企业后台接口

那就先准备本地 PostgreSQL。

### 6.1 启动数据库

```bash
docker run -d \
  --name aiteam-pg \
  -e POSTGRES_USER=aiteam \
  -e POSTGRES_PASSWORD=*** \
  -e POSTGRES_DB=aiteam \
  -p 5433:5432 \
  -v aiteam_pg_data:/var/lib/postgresql/data \
  postgres:16-alpine
```

### 6.2 创建测试库

```bash
docker exec -it aiteam-pg psql -U aiteam -d aiteam -c "CREATE DATABASE aiteam_test;"
```

### 6.3 常用连接串

```text
postgresql://aiteam:***@127.0.0.1:5433/aiteam_test
```

### 6.4 最小验证

```bash
docker ps | grep aiteam-pg
docker exec -it aiteam-pg psql -U aiteam -d aiteam_test -c '\l'
```

## 7. AI Team 分层测试怎么跑

推荐从低层到高层顺序执行：

```bash
cd /home/ubuntu/code/aiteam/app
python -m pytest tests/aiteam/layer0_contracts -v
python -m pytest tests/aiteam/layer1_data -v
python -m pytest tests/aiteam/layer2_team_panel -v
python -m pytest tests/aiteam/layer3_gateway -v
python -m pytest tests/aiteam/layer4_frontend_bff -v
python -m pytest tests/aiteam/layer5_flows -v
```

推荐理解：
- `layer0`：先锁 host seam、事件协议、SSE 北向口径
- `layer1`：再看数据模型、仓储、数据库约束
- `layer2`：再看 Team Panel API
- `layer3`：再看 Gateway 适配
- `layer4`：再看页面/BFF 边界
- `layer5`：最后看业务流程闭环

## 8. Docker 什么时候用

Docker 不是当前开发的唯一主路径。

### 更推荐直接本地启动的场景
- 日常开发
- 查 Python traceback
- 跑 pytest
- 单步联调 Team Panel / Gateway

### Docker 更适合的场景
- 快速起演示环境
- 隔离宿主依赖
- 验证 compose 结构
- 验证宿主层与 Runtime 的协同边界

当前保留的容器入口包括：
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.two-container.yml`
- `docker-compose.three-container.yml`
- `docker_init.bash`

如果你在看多容器模式下的 agent 源码挂载边界，继续参考：
- `../docs/design-notes/app-rfcs/agent-source-boundary.md`

这份 RFC 是 #2453 的 **source/API boundary inventory**，适合在你需要判断“为什么默认要求只读挂载、哪些 WebUI 能力仍依赖 Hermes Agent 源码内部耦合”时回看。

### 使用 Docker 前先想清楚
- 容器启动不等于 Team Panel 数据层已经可用
- Team Panel / Gateway 当前仍是 `app/` 进程内模块
- compose 拆容器不代表已经拆成独立产品服务

## 9. 常见启动问题怎么分层看

### 现象：`./ctl.sh start` 失败
先看：
```bash
./ctl.sh logs --lines 200 --no-follow
```

优先判断：
- 端口被占用
- Python 环境缺失
- `.env` 配置问题
- 启动时 import 失败

### 现象：`/health` 不通
先看：
- `./ctl.sh status`
- `~/.hermes/webui.log`

优先判断：
- 进程根本没起来
- 绑定 host/port 与你访问的不一致
- 服务启动后立刻退出

### 现象：企业后台接口返回 503
优先判断：
- PostgreSQL 没起
- 连接串/环境变量没配好
- 表结构还没准备好

### 现象：页面打开了，但 AI Team 数据为空
优先判断：
- 页面本身只是壳/占位页
- 对应北向 API 返回空集
- Team Panel 数据库里没有种子数据

### 现象：群聊/编排/Loop 验不通
优先判断：
- 先低层测试有没有过
- `run_id` / `runtime_handle` 有没有拿到
- Runtime 日志里有没有对应执行记录

## 10. 当前最实用的一组命令

```bash
cd /home/ubuntu/code/aiteam/app

./ctl.sh start
./ctl.sh status
./ctl.sh logs --lines 200 --no-follow

python -m pytest tests/aiteam/layer0_contracts -v
python -m pytest tests/aiteam/layer1_data -v
python -m pytest tests/aiteam/layer2_team_panel -v
python -m pytest tests/aiteam/layer3_gateway -v
python -m pytest tests/aiteam/layer4_frontend_bff -v
python -m pytest tests/aiteam/layer5_flows -v
```

## 11. 什么时候继续看下一份文档

当你已经能：
- 把服务起起来
- 打开页面
- 打通基础 API
- 开始验证业务链路

下一步就去看：[`mvp-acceptance.md`](./mvp-acceptance.md)
