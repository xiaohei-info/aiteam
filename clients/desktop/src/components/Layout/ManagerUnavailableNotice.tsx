/**
 * 企业服务连不上时的全局提示。登录保持有效；会话列表轮询等请求成功后自动消失。
 */
import { Info } from 'lucide-react'
import { MANAGER_UNAVAILABLE_NOTICE, useManagerReachability } from '../../lib/managerReachability'
import './ManagerUnavailableNotice.css'

export default function ManagerUnavailableNotice() {
  const unavailable = useManagerReachability((s) => s.unavailable)
  if (!unavailable) return null
  return (
    <div className="manager-unavailable-notice" role="status" aria-live="polite">
      <Info size={14} aria-hidden="true" />
      <span>{MANAGER_UNAVAILABLE_NOTICE}</span>
    </div>
  )
}
