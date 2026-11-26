-- 0057: 员工头像改为「每员工固定一个文件 avatars/{tenant}/{employee}.webp」，表里只存元数据。
-- 旧实现在 avatar_url 列里存绝对 URL（取自请求 Host 头），文件名随机且每次上传一份。
-- 只扩展（见 deploy/ci/README.md）：本次只放开 avatar_url 的非空约束，新代码不再读写该列；
-- 删列留到下一次发布的收缩型迁移。
-- 开发阶段不保留旧头像：旧实现写的行 avatar_url 一定非空，清掉后由招募/方案应用重新复制模板头像。
-- 幂等：每次部署都会重跑；新代码写的行 avatar_url 为 NULL，不会被删。
ALTER TABLE employee_avatar ALTER COLUMN avatar_url DROP NOT NULL;
DELETE FROM employee_avatar WHERE avatar_url IS NOT NULL;
