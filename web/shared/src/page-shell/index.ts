/**
 * page-shell（08 §12.2，12.3）。各端「壳」的框架无关描述模型 + 装配逻辑。
 *
 * 无中心 BFF / 无中心 Edge（08 §12.3）：壳只描述本端导航/布局/会话门控，
 * 不做跨端聚合。各端用 React/Vue 等把本模型渲染成实际布局，逻辑（可见项过滤、
 * 当前激活项、登录门控）在此共享，杜绝三端各写一套壳。
 */

import type { AuthSession } from "../contracts/auth.js";
import { hasRole, isAuthenticated, type Role } from "../role-state/index.js";
import type { Tier } from "../api-client/index.js";

/** 单个导航项。`requiredRoles` 为空表示登录即可见。 */
export interface NavItem {
  id: string;
  /** i18n key，由壳渲染时经 I18n.t 翻译。 */
  labelKey: string;
  path: string;
  icon?: string;
  /** 命中任一角色才可见；空数组=登录可见。 */
  requiredRoles?: Role[];
  children?: NavItem[];
}

export interface PageShellConfig {
  tier: Tier;
  /** 应用标题 i18n key。 */
  titleKey: string;
  nav: NavItem[];
}

/** 壳渲染态：经会话过滤后的可见导航 + 当前激活项 + 是否需登录。 */
export interface ShellViewModel {
  tier: Tier;
  titleKey: string;
  nav: NavItem[];
  activeItemId: string | null;
  requiresLogin: boolean;
}

/** 按会话角色递归过滤导航树（未登录只保留无 requiredRoles 项时也隐藏——见 requiresLogin）。 */
function filterNav(items: NavItem[], session: AuthSession | null): NavItem[] {
  const result: NavItem[] = [];
  for (const item of items) {
    if (!isItemVisible(item, session)) continue;
    const children = item.children ? filterNav(item.children, session) : undefined;
    result.push(children ? { ...item, children } : item);
  }
  return result;
}

function isItemVisible(item: NavItem, session: AuthSession | null): boolean {
  if (!item.requiredRoles || item.requiredRoles.length === 0) return true;
  return hasRole(session, ...item.requiredRoles);
}

/** 选当前激活项：最长前缀匹配 path（消除「/a 命中 /ab」的误匹配）。 */
function resolveActive(items: NavItem[], currentPath: string): string | null {
  let bestId: string | null = null;
  let bestLen = -1;
  const walk = (nodes: NavItem[]): void => {
    for (const node of nodes) {
      if (
        (currentPath === node.path || currentPath.startsWith(`${node.path}/`)) &&
        node.path.length > bestLen
      ) {
        bestId = node.id;
        bestLen = node.path.length;
      }
      if (node.children) walk(node.children);
    }
  };
  walk(items);
  return bestId;
}

/** 由配置 + 会话 + 当前路径装配壳视图模型。纯函数，便于各端框架直接消费与测试。 */
export function buildShellViewModel(
  config: PageShellConfig,
  session: AuthSession | null,
  currentPath: string,
): ShellViewModel {
  const authed = isAuthenticated(session);
  const nav = authed ? filterNav(config.nav, session) : [];
  return {
    tier: config.tier,
    titleKey: config.titleKey,
    nav,
    activeItemId: resolveActive(nav, currentPath),
    requiresLogin: !authed,
  };
}
