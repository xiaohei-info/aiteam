-- 0057: 员工头像改为「每员工固定一个文件 avatars/{tenant}/{employee}.webp」，表里只存元数据。
-- 旧实现在 avatar_url 列里存绝对 URL（取自请求 Host 头），文件名随机且每次上传一份。
-- 开发阶段不保留旧头像：首次执行时清空旧行并删除 avatar_url 列；之后由招募/方案应用重新复制模板头像。
-- 幂等：每次部署都会重跑，只有 avatar_url 列仍存在时才清空，避免每次启动都删掉头像。
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'employee_avatar' AND column_name = 'avatar_url'
    ) THEN
        DELETE FROM employee_avatar;
        ALTER TABLE employee_avatar DROP COLUMN avatar_url;
    END IF;
END $$;
