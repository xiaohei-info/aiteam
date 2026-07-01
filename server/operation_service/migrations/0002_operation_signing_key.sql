-- Operation 系统级 RS256 签名密钥持久化（03 §9.2 / D23）。
--
-- 背景：Operation 单实例控制面用单一系统级 key 自签自验系统账号 token。原实现未配 env
-- 时每次启动重新生成 key → 重启即让操作员已签发 token 全失效（"401 / 操作失败"）。
-- 落库后：启动时"有则加载、无则生成并固定"，跨重启/多实例稳定；任何环境自动生成、无需手工。
--
-- 私钥仅本端 admin 连接读，绝不下发用户端；env OPERATION_SIGNING_* 显式配置时优先，不读本表。
CREATE TABLE IF NOT EXISTS operation_signing_key (
    kid         text PRIMARY KEY,
    private_pem text NOT NULL,
    public_pem  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
