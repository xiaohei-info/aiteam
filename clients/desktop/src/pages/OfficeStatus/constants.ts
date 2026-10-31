import type React from 'react'

export type TaskStatus = 'pending' | 'running' | 'done'

export interface Task {
  id: string
  icon: string
  name: string
  agent: string
  flow: string
  progress: number
  status: TaskStatus
}

export interface Stat {
  label: string
  value: string
}

export interface Log {
  time: string
  agent: string
  text: string
}

export const panelStyle: React.CSSProperties = {
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '10px 14px',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
}

/** 右侧竖向栏里用的面板样式：不参与横向均分，按内容高度堆叠 */
export const sidebarPanelStyle: React.CSSProperties = {
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '10px 14px',
  flex: '0 0 auto',
  minWidth: 0,
  overflow: 'hidden',
}

export const panelTitleStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--brand)', fontFamily: 'monospace',
  letterSpacing: '0.1em', marginBottom: 8,
}
