# CPA 单一子域名短路径路由设计

## 目标

在不新增代理容器、不中断既有 CPA API 的前提下，使用唯一公网入口 `cpa.xiaohei.tech` 提供以下直达路径：

- `/`：CPA Management 页面。
- `/key`：`cpa-key-policy` 插件页面。
- `/usage/`：Usage Keeper 页面。

## 边界与非目标

- 保持现有 `macmini` Cloudflare Tunnel、DNS CNAME 和 `cpa.xiaohei.tech` 主机名。
- 不新增 Caddy、Nginx、Cloudflare Worker 或额外公网子域名。
- 保持 `/v1/*`、`/v0/*` 和其他现有 CPA 路径的行为不变。
- 不修改 CPA 的管理鉴权；Management 与插件接口继续要求原有管理密钥。

## 设计

Usage Keeper 支持 `APP_BASE_PATH`。为其设置 `/usage` 后，Tunnel 以路径规则将 `cpa.xiaohei.tech/usage/*` 直接转发到 `localhost:8318`；该规则必须位于 CPA 的通用 `cpa.xiaohei.tech -> localhost:8317` 规则之前。

CPA 本体的 Management 与 Key Policy 页面分别固定在 `/management.html` 和 `/v0/resource/plugins/cpa-key-policy/index.html`。Tunnel 只能选择本机服务而不能改写请求 URI，因此在 Cloudflare Zone 中增加两条精确的 URL Rewrite 规则：

- 当 hostname 为 `cpa.xiaohei.tech` 且 path 为 `/`，内部改写为 `/management.html`。
- 当 hostname 为 `cpa.xiaohei.tech` 且 path 为 `/key`，内部改写为 `/v0/resource/plugins/cpa-key-policy/index.html`。

两条规则均为内部改写，浏览器地址栏维持短路径。Management 页面使用绝对的 `/v0/management/*` API 路径，因此后续请求不会匹配上述精确规则，继续由 CPA 的通用 Tunnel 规则处理。

## 验收

- `https://cpa.xiaohei.tech/` 返回 Management HTML。
- `https://cpa.xiaohei.tech/key` 返回 Key Policy 页面。
- `https://cpa.xiaohei.tech/usage/` 返回 Usage Keeper 页面，静态资源可加载。
- `https://cpa.xiaohei.tech/v1/models` 仍由 CPA 正常响应。
- Tunnel 保持 healthy，且现有其他 hostname 路由不变。

## 回退

删除两条 URL Rewrite、删除 `/usage` Tunnel ingress 规则、移除 `APP_BASE_PATH` 并重启 Usage Keeper，即可恢复当前行为。
