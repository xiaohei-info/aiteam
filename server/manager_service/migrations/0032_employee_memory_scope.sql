-- Manager one-enterprise architecture: long-term memory defaults to employee-private scope.
-- Existing tenant-scoped settings are moved to the new product default; Manager
-- authorization still controls which members may access an employee.
ALTER TABLE employee_memory_setting
    ALTER COLUMN scope SET DEFAULT 'employee';

UPDATE employee_memory_setting
SET scope = 'employee'
WHERE scope = 'tenant';
