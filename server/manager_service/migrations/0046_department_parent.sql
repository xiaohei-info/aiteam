-- 0046: 部门层级。parent_id 为空表示顶级部门。
-- 外键只保证上级存在；防环与层数上限由应用层在同一事务内校验（见 department_tree.py）。
-- 删除部门前由应用层把其子部门挂回被删部门的上级，所以这里不设级联。
ALTER TABLE department ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES department(id);
CREATE INDEX IF NOT EXISTS idx_department_parent ON department (tenant_id, parent_id);
