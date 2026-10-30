import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const blockedSeverities = new Set(['high', 'critical'])

function runAudit(label, extraArgs) {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(
    executable,
    ['audit', '--json', '--audit-level', 'high', ...extraArgs],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )

  assert.equal(result.error, undefined, `${label} audit could not start: ${result.error?.message}`)

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim()
    assert.fail(`${label} audit did not return JSON: ${detail}`)
  }

  if (report.error) {
    assert.fail(`${label} audit failed: ${report.error.code ?? 'unknown'} ${report.error.message ?? ''}`.trim())
  }

  const advisories = Object.values(report.advisories ?? {})
  const blocked = advisories.filter((advisory) => blockedSeverities.has(advisory.severity))
  return {
    blocked,
    counts: report.metadata?.vulnerabilities ?? {},
  }
}

function advisoryKey(advisory) {
  return String(advisory.github_advisory_id ?? advisory.id ?? `${advisory.module_name}:${advisory.title}`)
}

function formatAdvisory(advisory) {
  const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? [])
  const dependencyPaths = [...new Set(paths)].join(', ') || advisory.module_name
  return `${advisory.severity} ${advisoryKey(advisory)} ${dependencyPaths}`
}

function formatCounts(counts) {
  return ['critical', 'high', 'moderate', 'low', 'info']
    .map((severity) => `${severity}=${counts[severity] ?? 0}`)
    .join(' ')
}

const production = runAudit('production', ['--prod'])
const full = runAudit('full', [])
const productionKeys = new Set(production.blocked.map(advisoryKey))
const developmentOnly = full.blocked.filter((advisory) => !productionKeys.has(advisoryKey(advisory)))

console.log(`[dependency-audit] production: ${formatCounts(production.counts)}`)
console.log(`[dependency-audit] full tree: ${formatCounts(full.counts)}`)
console.log(`[dependency-audit] development-only high/critical: ${developmentOnly.length}`)

const violations = [
  ...production.blocked.map((advisory) => `production ${formatAdvisory(advisory)}`),
  ...developmentOnly.map((advisory) => `development ${formatAdvisory(advisory)}`),
]
assert.deepEqual(
  violations,
  [],
  `known high/critical dependency vulnerabilities detected:\n${violations.join('\n')}`,
)

console.log('[dependency-audit] no known high or critical npm dependency vulnerabilities')
