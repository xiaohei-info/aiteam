import type { GroupMember } from './groupRoster'

export const GROUP_AVATAR_MAX_MEMBERS = 4

export interface GroupAvatarItem {
  employeeId: string
  displayName: string
  avatarUrl: string | null
  fallback: string
}

function firstNameCharacter(displayName: string, profileAvailable: boolean): string {
  if (!profileAvailable) return '?'
  const character = Array.from(displayName.trim()).find((item) => /[\p{L}\p{N}]/u.test(item))
  return character?.toUpperCase() ?? '?'
}

export function resolveGroupAvatarItems(
  members: readonly GroupMember[],
): GroupAvatarItem[] {
  const seenEmployeeIds = new Set<string>()
  const items: GroupAvatarItem[] = []

  for (const member of members) {
    if (!member.employee_id || seenEmployeeIds.has(member.employee_id)) continue
    seenEmployeeIds.add(member.employee_id)

    const displayName = member.profile_available === false
      ? '成员信息不可用'
      : member.display_name.trim() || '成员信息不可用'
    items.push({
      employeeId: member.employee_id,
      displayName,
      avatarUrl: member.avatar_url?.trim() || null,
      fallback: firstNameCharacter(member.display_name, member.profile_available !== false),
    })
    if (items.length === GROUP_AVATAR_MAX_MEMBERS) break
  }

  return items
}
