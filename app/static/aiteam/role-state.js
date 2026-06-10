// role-state.js — L4-D2: Role-aware governance helpers for AI Team frontend
// Mirrors the backend permission_service.py permission matrix.
// Reads role from window.aiteam.role which can be set by server template or test harness.
window.aiteam = window.aiteam || {};
var aiteam = window.aiteam;

(function registerRoleState(ns) {
  // ── Enterprise roles ──
  var ENTERPRISE_ROLES = {
    OWNER: 'owner',
    ENTERPRISE_ADMIN: 'enterprise_admin',
    FINANCE_ADMIN: 'finance_admin',
    MEMBER: 'member',
  };

  // ── System roles ──
  var SYSTEM_ROLES = {
    SYSTEM_ADMIN: 'system_admin',
    SYSTEM_OPERATOR: 'system_operator',
  };

  // ── Permission matrix (mirrors backend) ──
  var ROLE_PERMISSIONS = {};
  ROLE_PERMISSIONS[ENTERPRISE_ROLES.OWNER] = [
    'manage_enterprise', 'manage_employees', 'view_billing',
    'export_data', 'view_audit_logs',
    'manage_connectors', 'view_all_conversations',
  ];
  ROLE_PERMISSIONS[ENTERPRISE_ROLES.ENTERPRISE_ADMIN] = [
    'manage_employees', 'export_data', 'view_audit_logs',
    'manage_connectors', 'view_all_conversations',
  ];
  ROLE_PERMISSIONS[ENTERPRISE_ROLES.FINANCE_ADMIN] = [
    'view_billing', 'export_data', 'view_audit_logs',
  ];
  ROLE_PERMISSIONS[ENTERPRISE_ROLES.MEMBER] = [
    'view_own_conversations', 'send_message',
  ];
  ROLE_PERMISSIONS[SYSTEM_ROLES.SYSTEM_ADMIN] = [
    'system_read', 'system_write',
  ];
  ROLE_PERMISSIONS[SYSTEM_ROLES.SYSTEM_OPERATOR] = [
    'system_read',
  ];

  // ── Navigation visibility rules ──
  // Which roles can see which admin nav items?
  // Returns array of nav labels that should be visible.
  function _hasPermission(role, action) {
    var permissions = ROLE_PERMISSIONS[role] || [];
    return permissions.indexOf(action) !== -1;
  }

  function visibleNavSections(role) {
    if (!role) return { admin: true, system: true };
    var result = { admin: false, system: false };

    // Admin section: visible if role has any enterprise admin permission
    result.admin = _hasPermission(role, 'manage_employees') ||
                   _hasPermission(role, 'manage_connectors') ||
                   _hasPermission(role, 'view_billing') ||
                   _hasPermission(role, 'export_data') ||
                   _hasPermission(role, 'view_audit_logs') ||
                   _hasPermission(role, 'manage_enterprise');

    // System section: visible for system roles only
    result.system = _hasPermission(role, 'system_read');

    return result;
  }

  function visibleNavItems(role, section) {
    var items = [];

    if (section === 'admin') {
      if (_hasPermission(role, 'manage_employees')) {
        items.push({ label: '员工', href: '/admin/employees', note: 'Employees' });
        items.push({ label: '技能', href: '/admin/skills', note: 'Skills' });
        items.push({ label: '人才市场', href: '/admin/templates', note: 'Templates' });
      }
      if (_hasPermission(role, 'manage_connectors')) {
        items.push({ label: '连接器', href: '/admin/connectors', note: 'Connectors' });
      }
      if (_hasPermission(role, 'view_billing')) {
        items.push({ label: '费用', href: '/admin/billing/usage', note: 'Billing' });
      }
    } else if (section === 'system') {
      if (_hasPermission(role, 'system_read')) {
        items.push({ label: '企业', href: '/system/accounts', note: 'Enterprises' });
        items.push({ label: '健康', href: '/system/health', note: 'Health' });
      }
    }

    return items;
  }

  // ── Action visibility helpers ──

  function canExportBilling(role) {
    return _hasPermission(role, 'export_data');
  }

  function canExportEmployees(role) {
    return _hasPermission(role, 'export_data');
  }

  function canViewAudit(role) {
    return _hasPermission(role, 'view_audit_logs');
  }

  // ── Export ──

  ns.role = {
    ROLES: ENTERPRISE_ROLES,
    SYSTEM_ROLES: SYSTEM_ROLES,
    PERMISSIONS: ROLE_PERMISSIONS,
    hasPermission: _hasPermission,
    visibleNavSections: visibleNavSections,
    visibleNavItems: visibleNavItems,
    canExportBilling: canExportBilling,
    canExportEmployees: canExportEmployees,
    canViewAudit: canViewAudit,
    // Read the active role from the namespace or default to none
    getActiveRole: function () {
      return ns._role || '';
    },
    setActiveRole: function (role) {
      ns._role = role || '';
    },
  };
}(window.aiteam));
