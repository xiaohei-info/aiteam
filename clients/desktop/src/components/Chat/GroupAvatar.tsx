import './GroupAvatar.css'
import { resolveGroupAvatarItems, type GroupAvatarItem } from '../../lib/groupAvatar'
import type { GroupMember } from '../../lib/groupRoster'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import { resolveAvatarUrl } from '../../lib/avatarUrl'
import { BACKEND_BASE_URL } from '../../api/backend/config'

interface GroupAvatarProps {
  members: readonly GroupMember[]
  label: string
  size?: 'small' | 'medium' | 'large'
  rosterDescription?: string
}

interface GroupAvatarCellProps {
  item: GroupAvatarItem
}

function GroupAvatarCell({ item }: GroupAvatarCellProps) {
  const avatarUrl = resolveAvatarUrl(item.avatarUrl, BACKEND_BASE_URL)

  return (
    <span className="group-avatar-cell" aria-hidden="true">
      {avatarUrl
        ? renderAvatar(getEmployeeAvatar(item.displayName, avatarUrl), getAvatarFallback(item.displayName))
        : <span>{item.fallback}</span>}
    </span>
  )
}

export default function GroupAvatar({
  members,
  label,
  size = 'medium',
  rosterDescription,
}: GroupAvatarProps) {
  const items = resolveGroupAvatarItems(members)
  const visibleItems = items.length > 0
    ? items
    : [{ employeeId: 'unavailable', displayName: '成员信息不可用', avatarUrl: null, fallback: '?' }]
  const memberNames = items.map((item) => item.displayName).join('、')
  const description = rosterDescription?.trim()
  const title = [memberNames || '成员信息不可用', description].filter(Boolean).join('；')

  return (
    <span
      className={`group-avatar ${size} count-${visibleItems.length}`}
      role="img"
      aria-label={description ? `${label}；${description}` : label}
      title={title}
    >
      {visibleItems.map((item) => <GroupAvatarCell key={item.employeeId} item={item} />)}
    </span>
  )
}
