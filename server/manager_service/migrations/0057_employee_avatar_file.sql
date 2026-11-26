-- 0057: 员工头像改为「每员工固定一个文件 avatars/{tenant}/{employee}.webp」，表里只存元数据。
-- 旧实现在 avatar_url 列里存绝对 URL（取自请求 Host 头），文件名随机：avatars/{tenant}/{employee}/{随机}.webp。
-- 只扩展（见 deploy/ci/README.md）：本次只放开 avatar_url 的非空约束，新代码不再读写该列；
-- 删列留到下一次发布的收缩型迁移。
-- 清理范围只限「新代码读不到的行」：storage_key 不是固定路径的行（旧实现写的）。新代码按固定路径
-- 读文件，这些行指向的随机文件名对它无效，保留只会让三端拿到一个读不出内容的头像版本。
-- 幂等、可回滚：新代码写的行 storage_key 恒为固定路径，不会被匹配；代码回滚到旧版本期间旧代码再写的行，
-- 下次部署照样只清这些新代码读不到的行。
-- 开发阶段不回填：存量员工头像（含从模板继承的）部署后变为首字占位，重新招募或上传后恢复（见 PR #231 发布说明）。
ALTER TABLE employee_avatar ALTER COLUMN avatar_url DROP NOT NULL;
DELETE FROM employee_avatar
WHERE storage_key IS DISTINCT FROM 'avatars/' || tenant_id::text || '/' || employee_id::text || '.webp';
