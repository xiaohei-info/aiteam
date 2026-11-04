/**
 * 工作台的运行状态：识别每个目录里能单独运行的单元、轮询运行中的代码项目，以及运行、停止、
 * 首次运行确认等操作。页面只负责展示；运行状态按 unitKey 区分。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { detectRunners, openProjectAddress, openProjectFile, openPythonDownload, projectRunStatus, startProject, stopProject } from './api'
import { errorText } from './format'
import { htmlPageToRun, needsPolling, partKey, runStatusFromOutcome, unitKey, unitRevealFile, type ProjectPart, type RunStatus, type RunUnit, type StartOutcome } from './projects'

const RUN_POLL_MS = 1500

/** 首次运行（或命令、依赖文件变化后）等待用户确认的代码项目。 */
export interface ConsentRequest {
  part: ProjectPart
  unit: RunUnit
  projectName: string
  commands: string[]
  script: string | null
  cwd: string
  fingerprint: string
}

export function useProjectRuns(desktop: boolean, partsByKey: ReadonlyMap<string, ProjectPart>) {
  /** 每个目录（partKey）能单独运行的单元。 */
  const [units, setUnits] = useState<Record<string, RunUnit[]>>({})
  const [runs, setRuns] = useState<Record<string, RunStatus>>({})
  const [pendingRun, setPendingRun] = useState<string | null>(null)
  const [runError, setRunError] = useState<{ key: string; message: string } | null>(null)
  const [consent, setConsent] = useState<ConsentRequest | null>(null)
  const detectGeneration = useRef(0)
  const detecting = useRef(new Set<string>())

  /** 文件可能已变化：重新识别运行方式；正在运行的状态由宿主保留，不清空。 */
  const redetect = useCallback(() => {
    detectGeneration.current += 1
    detecting.current.clear()
    setUnits({})
  }, [])

  useEffect(() => () => { detectGeneration.current += 1 }, [])

  // 识别每个目录里能单独运行的单元，顺带取应用内已有的运行状态。
  useEffect(() => {
    if (!desktop) return
    const parts = [...partsByKey.entries()]
      .filter(([key]) => !(key in units) && !detecting.current.has(key))
      .map(([, part]) => part)
    if (parts.length === 0) return
    const generation = detectGeneration.current
    for (const part of parts) detecting.current.add(partKey(part))
    void detectRunners(parts, (part, found, statuses) => {
      if (generation !== detectGeneration.current) return
      setUnits(previous => ({ ...previous, [partKey(part)]: found }))
      const known = Object.entries(statuses)
      if (known.length) setRuns(previous => ({ ...previous, ...Object.fromEntries(known.map(([dir, status]) => [unitKey(part, dir), status])) }))
    })
  }, [desktop, partsByKey, units])

  const unitsByKey = useMemo(() => new Map([...partsByKey.values()].flatMap(part =>
    (units[partKey(part)] ?? []).map(unit => [unitKey(part, unit.dir), { part, unit }] as const))), [partsByKey, units])

  // 代码项目运行时轮询状态与日志；地址由宿主识别后自动在浏览器打开。
  const pollSignature = useMemo(
    () => Object.keys(runs).filter(key => needsPolling(unitsByKey.get(key)?.unit.runner, runs[key])).sort().join('\n'),
    [runs, unitsByKey],
  )
  useEffect(() => {
    if (!pollSignature) return
    const keys = pollSignature.split('\n')
    const timer = window.setInterval(() => {
      for (const key of keys) {
        const entry = unitsByKey.get(key)
        if (!entry) continue
        void projectRunStatus(entry.part, entry.unit.dir)
          .then(status => setRuns(previous => ({ ...previous, [key]: status })))
          .catch(() => undefined)
      }
    }, RUN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [pollSignature, unitsByKey])

  const applyOutcome = (part: ProjectPart, unit: RunUnit, outcome: StartOutcome, projectName: string) => {
    if (outcome.outcome === 'needs_consent') {
      setConsent({ part, unit, projectName, commands: outcome.commands, script: outcome.script, cwd: outcome.cwd, fingerprint: outcome.fingerprint })
      return
    }
    const status = runStatusFromOutcome(outcome)
    if (status) setRuns(previous => ({ ...previous, [unitKey(part, unit.dir)]: status }))
  }

  /** 运行；已在运行时宿主复用进程或服务，并在浏览器重新打开。selectedFileId 决定 HTML 单元打开哪一页。 */
  const run = async (part: ProjectPart, unit: RunUnit, projectName: string, options: { selectedFileId?: string | null; fingerprint?: string } = {}) => {
    const key = unitKey(part, unit.dir)
    if (unit.runner.kind === 'none' || pendingRun) return
    setPendingRun(key)
    setRunError(null)
    try {
      const outcome = await startProject(part, unit.dir, { fileId: htmlPageToRun(unit.runner, options.selectedFileId ?? null), consent: options.fingerprint })
      applyOutcome(part, unit, outcome, projectName)
    } catch (error) {
      setRunError({ key, message: errorText(error, '运行失败，请重试') })
    } finally {
      setPendingRun(null)
    }
  }

  const stop = async (part: ProjectPart, unit: RunUnit) => {
    const key = unitKey(part, unit.dir)
    if (pendingRun) return
    setPendingRun(key)
    setRunError(null)
    try {
      const status = await stopProject(part, unit.dir)
      setRuns(previous => ({ ...previous, [key]: status }))
    } catch (error) {
      setRunError({ key, message: errorText(error, '停止失败，请重试') })
    } finally {
      setPendingRun(null)
    }
  }

  /** 不改变运行状态的操作：失败时把错误挂到对应单元上。 */
  const attempt = async (part: ProjectPart, dir: string, action: () => Promise<void>, fallback: string) => {
    setRunError(null)
    try {
      await action()
    } catch (error) {
      setRunError({ key: unitKey(part, dir), message: errorText(error, fallback) })
    }
  }

  const reveal = (part: ProjectPart, dir: string) =>
    attempt(part, dir, () => openProjectFile(part, unitRevealFile(part, dir), true), '无法在文件夹中显示，请重试')

  /** 没识别到访问地址时，试着在浏览器打开分配给项目的端口。 */
  const tryOpen = (part: ProjectPart, dir: string) =>
    attempt(part, dir, () => openProjectAddress(part, dir), '无法在浏览器打开，请重试')

  const downloadPython = (part: ProjectPart, dir: string) =>
    attempt(part, dir, openPythonDownload, '无法打开下载页，请访问 python.org 下载')

  const confirmConsent = () => {
    if (!consent) return
    const request = consent
    setConsent(null)
    void run(request.part, request.unit, request.projectName, { fingerprint: request.fingerprint })
  }

  return {
    units, runs, pendingRun, runError, consent,
    redetect,
    clearRunError: () => setRunError(null),
    cancelConsent: () => setConsent(null),
    run, stop, reveal, tryOpen, downloadPython, confirmConsent,
  }
}
