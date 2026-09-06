#!/usr/bin/env python3
"""Secret-free hosted-Linux native gate for the SAME S05 legacy-stop candidate.

Never run on taiyi/a developer workstation. Only unique temporary units and
synthetic processes are touched; unsafe old teardown is a marker, not Docker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'deploy/ci/stop_legacy_unit.py'

# These are harmless replicas of the relevant old daemon control flow, not a
# second cutover implementation. All stops below invoke the production candidate.
CTL = '''#!/usr/bin/env bash
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$1" != start ]]; then echo exec-stop >> "$root/dangerous-teardown"; exit 0; fi
trap 'echo daemon-trap >> "$root/dangerous-teardown"; exit 0' TERM INT
echo start >> "$root/starts"
for tier in manager operation agent; do
  setsid /usr/bin/python3 "$root/server/run.py" --tier="$tier" &
  echo $! > "$root/.state/$tier.pid"
done
while true; do
  for tier in manager operation agent; do
    if ! kill -0 "$(cat "$root/.state/$tier.pid")" 2>/dev/null; then
      echo worker-exit-watcher >> "$root/dangerous-teardown"
      exit 1
    fi
  done
  sleep 0.05
done
'''
WORKER = '''import argparse, os, signal, time
from pathlib import Path
p = argparse.ArgumentParser(); p.add_argument('--tier'); args = p.parse_args()
root = Path(__file__).resolve().parents[1]
def term(*_):
    (root / (args.tier + '.term')).touch()
    if (root / 'hang').exists() and args.tier == 'manager':
        return
    time.sleep(0.15)
    (root / (args.tier + '.drained')).touch()
    raise SystemExit(0)
signal.signal(signal.SIGTERM, term)
(root / (args.tier + '.ready')).touch()
while True: time.sleep(0.05)
'''


def ctl(*args, check=True):
    return subprocess.run(['systemctl', *args], text=True, capture_output=True, check=check, timeout=25)


def wait(predicate, message, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.03)
    raise AssertionError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def show(unit, prop):
    return ctl('show', unit, '--property=' + prop, '--value').stdout.strip()


class Fixture:
    def __init__(self, report: Path, case: str, timeout=2):
        self.unit = f'aiteam-cutover-probe-{uuid.uuid4().hex}-{case}.service'
        self.root = Path(tempfile.mkdtemp(prefix='aiteam-s05-probe-'))
        self.report, self.case, self.timeout = report, case, timeout
        self.unit_file = Path('/run/systemd/system') / self.unit
        self.override_dir = self.unit_file.with_name(self.unit + '.d')
        self.record = self.root / 'cutover.json'
        self.upstream = None
        self.helper_process = None
        (self.root / '.state').mkdir()
        (self.root / 'scripts').mkdir()
        (self.root / 'server').mkdir()
        (self.root / 'scripts/ctl.sh').write_text(CTL)
        (self.root / 'server/run.py').write_text(WORKER)
        self.unit_file.write_text(f'''[Unit]
Description=Harmless S05 legacy cutover probe
[Service]
Type=simple
ExecStart=/usr/bin/env bash {self.root}/scripts/ctl.sh start --env test --daemon
ExecStop=/usr/bin/env bash {self.root}/scripts/ctl.sh stop --env test
ExecReload=/usr/bin/env bash {self.root}/scripts/ctl.sh restart --env test --daemon
Restart=on-failure
RestartSec=0.1
KillMode=control-group
''')
        self.unit_hash, self.daemon_hash = sha(self.unit_file), sha(self.root / 'scripts/ctl.sh')

    def args(self, action):
        return [sys.executable, str(HELPER), action, '--unit', self.unit,
                '--root', str(self.root), '--record', str(self.record),
                '--unit-sha256', self.unit_hash, '--daemon-sha256', self.daemon_hash,
                '--timeout', str(self.timeout), '--upstream-pid', str(self.upstream.pid)]

    def helper(self, action, success=True):
        result = subprocess.run(self.args(action), capture_output=True, text=True, timeout=30)
        with (self.report / f'{self.case}.log').open('a') as stream:
            stream.write(f'{action} rc={result.returncode}\n{result.stdout}{result.stderr}')
        assert (result.returncode == 0) == success, f'{self.case}: {action} unexpected result'

    def start(self):
        self.upstream = subprocess.Popen([sys.executable, str(self.root / 'server/run.py'), '--tier=upstream'])
        wait(lambda: (self.root / 'upstream.ready').exists(), 'upstream fixture did not start')
        ctl('daemon-reload')
        ctl('start', self.unit)
        wait(lambda: all((self.root / f'{tier}.ready').exists() for tier in ('manager', 'operation', 'agent')),
             'tier fixture did not start')

    def healthy(self):
        assert not (self.root / 'dangerous-teardown').exists(), 'old ExecStop/trap/watcher ran'
        assert self.upstream.poll() is None, 'external upstream was stopped'
        assert not (self.root / 'upstream.term').exists(), 'external upstream received TERM'
        assert (self.root / 'starts').read_text().splitlines() == ['start'], 'automatic restart occurred'
        assert show(self.unit, 'NRestarts') == '0'

    def stopped(self, hang=False):
        self.healthy()
        assert show(self.unit, 'ActiveState') in ('inactive', 'failed')
        assert show(self.unit, 'MainPID') == '0'
        group = Path('/sys/fs/cgroup/system.slice') / self.unit
        assert all(not path.read_text().strip() for path in group.rglob('cgroup.procs'))
        for tier in ('manager', 'operation', 'agent'):
            assert (self.root / f'{tier}.term').exists(), f'{tier} did not receive TERM'
            assert (self.root / f'{tier}.drained').exists() == (not hang or tier != 'manager')
        assert not (self.override_dir / '90-aiteam-s05-cutover.conf').exists()
        data = json.loads(self.record.read_text())
        assert data['phase'] == 'stopped'
        (self.report / f'{self.case}-identity.json').write_text(json.dumps(data, indent=2))

    def cleanup(self):
        if self.helper_process and self.helper_process.poll() is None:
            self.helper_process.kill()
            self.helper_process.wait(timeout=5)
        # Failure cleanup is fixture-only: do not call the dangerous old ExecStop.
        # These exact temporary units/dirs were created above and cannot be taiyi.
        self.override_dir.mkdir(exist_ok=True)
        (self.override_dir / '99-probe-cleanup.conf').write_text(
            '[Service]\nExecStop=\nExecStopPost=\nExecReload=\nRestart=no\nKillSignal=SIGKILL\nTimeoutStopSec=1s\n')
        ctl('daemon-reload')
        ctl('stop', self.unit, check=False)
        assert show(self.unit, 'MainPID') == '0', 'fixture cleanup left main process'
        group = Path('/sys/fs/cgroup/system.slice') / self.unit
        assert all(not p.read_text().strip() for p in group.rglob('cgroup.procs')), 'fixture cleanup left workers'
        if self.upstream:
            self.upstream.terminate()
            self.upstream.wait(timeout=5)
        shutil.rmtree(self.override_dir)
        self.unit_file.unlink()
        ctl('daemon-reload')
        ctl('reset-failed', self.unit, check=False)
        shutil.rmtree(self.root)


def run_case(report, case):
    fixture = Fixture(report, case, timeout=3 if case == 'interrupt' else 2)
    outsider = None
    try:
        hang = case in ('bounded-timeout', 'interrupt')
        if hang:
            (fixture.root / 'hang').touch()
        fixture.start()
        if case == 'unexpected-manager':
            outsider_root = fixture.root / 'outsider'
            (outsider_root / 'server').mkdir(parents=True)
            (outsider_root / 'server/run.py').write_text(WORKER)
            outsider = subprocess.Popen([sys.executable, str(outsider_root / 'server/run.py'), '--tier=manager'])
            wait(lambda: (outsider_root / 'manager.ready').exists(), 'outside Manager did not start')
            fixture.helper('preflight', success=False)
            fixture.healthy()
            assert outsider.poll() is None and not (outsider_root / 'manager.term').exists(), 'unexpected Manager was signalled'
            assert not fixture.override_dir.exists()
            outsider.terminate(); outsider.wait(timeout=5); outsider = None
        fixture.helper('preflight')
        if case == 'unit-mismatch':
            original = fixture.unit_file.read_text()
            fixture.unit_file.write_text(original + '# unapproved change\n')
            fixture.helper('stop', success=False)
            fixture.healthy()
            assert not fixture.override_dir.exists()
            fixture.unit_file.write_text(original)
        if case == 'pid-mismatch':
            original = fixture.record.read_text()
            data = json.loads(original); data['main']['start'] = '0'
            fixture.record.write_text(json.dumps(data))
            fixture.helper('stop', success=False)
            fixture.healthy()
            assert not fixture.override_dir.exists()
            fixture.record.write_text(original)
        start = time.monotonic()
        if case == 'interrupt':
            with (report / 'interrupt-child.log').open('w') as stream:
                fixture.helper_process = subprocess.Popen(fixture.args('stop'), stdout=stream, stderr=stream)
                wait(lambda: (fixture.root / 'manager.term').exists(), 'no real drain boundary reached')
                fixture.helper_process.kill()  # Only this owned fixture runner, never a service PID.
                fixture.helper_process.wait(timeout=5)
            assert (fixture.override_dir / '90-aiteam-s05-cutover.conf').exists()
            fixture.healthy()
            # Resume exact identity/record, even if systemd finished while runner was absent.
            fixture.helper('stop')
        else:
            fixture.helper('stop')
        elapsed = time.monotonic() - start
        assert elapsed < 15, 'stop was not bounded'
        if hang:
            assert elapsed >= fixture.timeout - 0.2, 'hanging tier did not exercise real systemd timeout'
        time.sleep(0.3)  # More than the fixture RestartSec, not a fake systemctl result.
        fixture.stopped(hang=hang)
        return {'case': case, 'result': 'passed', 'elapsed_seconds': round(elapsed, 3)}
    finally:
        if outsider:
            outsider.kill(); outsider.wait(timeout=5)
        fixture.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hosted-fixture', action='store_true', required=True)
    parser.add_argument('--report-dir', type=Path, required=True)
    args = parser.parse_args()
    if not (sys.platform == 'linux' and os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'):
        raise SystemExit('REFUSED: requires explicitly authorized GitHub-hosted Linux temporary-unit fixture')
    assert Path('/run/systemd/system').is_dir(), 'real systemd is required; not a skip'
    assert Path('/sys/fs/cgroup/cgroup.controllers').is_file(), 'real unified cgroup v2 is required'
    version = ctl('--version').stdout.splitlines()[0]
    args.report_dir.mkdir(parents=True, exist_ok=True)
    summary = {'systemd': version, 'helper_sha256': sha(HELPER), 'cases': []}
    try:
        for case in ('graceful', 'bounded-timeout', 'interrupt', 'unit-mismatch', 'pid-mismatch', 'unexpected-manager'):
            result = run_case(args.report_dir, case)
            summary['cases'].append(result)
            print(json.dumps(result), flush=True)
    finally:
        (args.report_dir / 'summary.json').write_text(json.dumps(summary, indent=2))
    print('S05 native candidate probe passed; taiyi rollout still requires independent review/owner window approval')


if __name__ == '__main__':
    main()
