"""Candidate logic only: no real systemctl, signals, Docker, SSH or credentials.

Native SIGKILL-main -> TERM-cgroup semantics are a separate hosted probe gate.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('stop_legacy_unit', ROOT / 'deploy/ci/stop_legacy_unit.py')
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


class MockSystemd(cutover.LinuxHost):
    def __init__(self, tmp_path):
        super().__init__(runtime=tmp_path / 'run/systemd/system')
        self.root = tmp_path / 'live'
        self.root.mkdir()
        (self.root / 'scripts').mkdir()
        (self.root / 'scripts/ctl.sh').write_text('synthetic legacy daemon')
        (self.root / '.state').mkdir()
        unit_file = tmp_path / 'aiteam-v1.service'
        unit_file.write_text('synthetic approved unit')
        self.group = '/system.slice/aiteam-v1.service'
        self.values = dict(Id='aiteam-v1.service', LoadState='loaded', ActiveState='active', SubState='running',
                           MainPID='10', ControlGroup=self.group, FragmentPath=str(unit_file), DropInPaths='',
                           KillMode='control-group', Restart='on-failure', NRestarts='0', ExecStop='dangerous',
                           ExecStopPost='', ExecReload='dangerous', KillSignal='15', SendSIGKILL='yes', TimeoutStopUSec='90s')
        self.procs = {
            10: dict(pid=10, start='100', cgroup=self.group,
                     argv=['bash', str(self.root / 'scripts/ctl.sh'), 'start', '--env', 'test', '--daemon']),
            11: dict(pid=11, start='101', cgroup=self.group, argv=['python', 'run.py', '--tier=manager']),
            12: dict(pid=12, start='102', cgroup=self.group, argv=['python', 'run.py', '--tier=operation']),
            13: dict(pid=13, start='103', cgroup=self.group, argv=['node', 'agent.js']),
            20: dict(pid=20, start='200', cgroup='/other-upstream.service', argv=['synthetic-upstream']),
        }
        for pid, tier in ((11, 'manager'), (12, 'operation'), (13, 'agent')):
            (self.root / '.state' / f'{tier}.pid').write_text(str(pid))
        self.calls = []
        self.interrupt = None
        self.on_reload = None
        self.leftover = False

    def info(self, unit):
        assert unit == 'aiteam-v1.service'
        return dict(self.values)

    def process(self, pid):
        return self.procs.get(pid)

    def processes(self):
        return list(self.procs.values())

    def members(self, group):
        return {p['pid'] for p in self.procs.values() if p['cgroup'] == group}

    def boot(self):
        return 'synthetic-boot'

    def systemctl(self, *args, timeout=15):
        self.calls.append(args)
        override = self.runtime / 'aiteam-v1.service.d/90-aiteam-s05-cutover.conf'
        if args == ('daemon-reload',):
            if override.exists():
                self.values.update(DropInPaths=str(override), Restart='no', ExecStop='', ExecStopPost='',
                                   ExecReload='', TimeoutStopUSec='2s')
            else:
                assert not self.members(self.group), 'override removed before cgroup empty'
            if self.on_reload:
                self.on_reload()
        elif args[0] == 'kill':
            assert args == ('kill', '--kill-who=main', '--signal=SIGKILL', 'aiteam-v1.service')
            assert override.exists() and self.values['Restart'] == 'no' and not self.values['ExecStop']
            self.procs.pop(10)
            self.values['MainPID'] = '0'
        elif args[0] == 'stop':
            assert self.values['MainPID'] == '0', 'main must die before any stop'
            assert timeout == 22
            if not self.leftover:
                self.procs = {pid: proc for pid, proc in self.procs.items() if proc['cgroup'] != self.group}
            self.values.update(ActiveState='inactive', SubState='dead')
        else:
            raise AssertionError('unexpected systemctl operation: ' + repr(args))
        if self.interrupt == args[0]:
            self.interrupt = None
            raise KeyboardInterrupt
        return ''


@pytest.fixture
def fixture(tmp_path):
    host = MockSystemd(tmp_path)
    helper = cutover.LegacyStop(host, 'aiteam-v1.service', host.root, tmp_path / 'cutover.json',
                               cutover.digest(Path(host.values['FragmentPath'])),
                               cutover.digest(host.root / 'scripts/ctl.sh'), 2)
    return host, helper


def test_main_first_ordering_keeps_upstream_and_does_not_start_or_rollback(fixture):
    host, helper = fixture
    helper.preflight([20])
    assert host.calls == []
    helper.stop()
    assert host.calls == [('daemon-reload',), ('kill', '--kill-who=main', '--signal=SIGKILL', 'aiteam-v1.service'),
                          ('stop', 'aiteam-v1.service'), ('daemon-reload',)]
    assert set(host.procs) == {20}
    assert not helper.override.exists()
    record = json.loads(helper.record.read_text())
    assert record['phase'] == 'stopped'
    assert 'argv' not in helper.record.read_text()
    assert helper.record.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize('bad', ['unit-bytes', 'daemon-bytes', 'drop-in', 'main-argv', 'tier-pid', 'extra-manager', 'upstream-in-unit'])
def test_preflight_rejects_unexpected_deployment_without_systemctl_mutations(fixture, bad):
    host, helper = fixture
    if bad == 'unit-bytes':
        Path(host.values['FragmentPath']).write_text('changed')
    elif bad == 'daemon-bytes':
        (host.root / 'scripts/ctl.sh').write_text('changed')
    elif bad == 'drop-in':
        host.values['DropInPaths'] = '/unapproved.conf'
    elif bad == 'main-argv':
        host.procs[10]['argv'] = ['another-daemon']
    elif bad == 'tier-pid':
        (host.root / '.state/agent.pid').write_text('20')
    elif bad == 'extra-manager':
        host.procs[30] = dict(pid=30, start='300', cgroup='/another-manager.service', argv=['uvicorn', 'manager_service.app:app'])
    else:
        host.procs[20]['cgroup'] = host.group
    with pytest.raises(cutover.CutoverError):
        helper.preflight([20])
    assert host.calls == []
    assert not helper.override.exists()
    assert not helper.record.exists()


@pytest.mark.parametrize('phase', ['daemon-reload', 'kill'])
def test_interrupted_runner_retains_guard_and_resumes_exact_record(fixture, phase):
    host, helper = fixture
    helper.preflight([20])
    host.interrupt = phase
    with pytest.raises(KeyboardInterrupt):
        helper.stop()
    assert helper.override.exists()
    assert host.values['Restart'] == 'no'
    helper.stop()
    assert json.loads(helper.record.read_text())['phase'] == 'stopped'
    assert sum(call[0] == 'kill' for call in host.calls) == 1
    assert set(host.procs) == {20}


@pytest.mark.parametrize('identity', ['main', 'tier', 'upstream', 'new-manager'])
def test_identity_is_rechecked_after_reload_before_signal(fixture, identity):
    host, helper = fixture
    helper.preflight([20])
    def change():
        if identity == 'new-manager':
            host.procs[30] = dict(pid=30, start='300', cgroup=host.group, argv=['python', 'run.py', '--tier', 'manager'])
        else:
            host.procs[{'main': 10, 'tier': 12, 'upstream': 20}[identity]]['start'] = 'reused'
    host.on_reload = change
    with pytest.raises(cutover.CutoverError):
        helper.stop()
    assert host.calls == [('daemon-reload',)]
    assert helper.override.exists()


def test_failed_drain_retains_override_and_refuses_mixed_worker_success(fixture):
    host, helper = fixture
    helper.preflight([20])
    host.leftover = True
    with pytest.raises(cutover.CutoverError, match='cgroup not empty'):
        helper.stop()
    assert helper.override.exists()
    assert host.calls[-1] == ('stop', 'aiteam-v1.service')
    assert json.loads(helper.record.read_text())['phase'] != 'stopped'


def test_unapplied_or_changed_override_is_not_silently_used(fixture):
    host, helper = fixture
    helper.preflight([20])
    host.on_reload = lambda: host.values.update(ExecStop='still dangerous')
    with pytest.raises(cutover.CutoverError, match='override not effective'):
        helper.stop()
    assert all(call[0] != 'kill' for call in host.calls)
    helper.override.write_text('unapproved override')
    host.on_reload = None
    with pytest.raises(cutover.CutoverError, match='override was changed'):
        helper.stop()


def test_missing_approval_missing_upstream_and_wrong_unit_fail_closed(fixture):
    host, helper = fixture
    with pytest.raises(cutover.CutoverError):
        helper.preflight([])
    with pytest.raises(cutover.CutoverError, match='unexpected unit name'):
        cutover.LegacyStop(host, 'postgres.service', helper.root, helper.record, helper.unit_hash, helper.daemon_hash, 2)
    assert not host.calls


def test_native_probe_is_hosted_only_reuses_candidate_and_does_not_touch_taiyi():
    workflow = (ROOT / '.github/workflows/s05-cutover-probe.yml').read_text()
    probe = (ROOT / 'scripts/verification/s05_systemd_cutover_probe.py').read_text()
    assert 'runs-on: ubuntu-24.04' in workflow and 'runs-on: taiyi' not in workflow
    assert 'secrets.' not in workflow and 'contents: read' in workflow
    assert 'stop_legacy_unit.py' in probe and 'self.args(action)' in probe
    assert "RUNNER_ENVIRONMENT') == 'github-hosted'" in probe
    assert 'not a skip' in probe
    assert 'stop_legacy_unit.py' not in (ROOT / '.github/workflows/deploy-main.yml').read_text()


def test_proc_identity_parser_never_reads_environ(tmp_path):
    proc = tmp_path / 'proc'
    directory = proc / '17'
    directory.mkdir(parents=True)
    # Linux stat field 22 (starttime) is item 19 after the closing comm paren.
    (directory / 'stat').write_text('17 (worker with spaces) S ' + ' '.join(['0'] * 18 + ['12345'] + ['0'] * 5))
    (directory / 'cmdline').write_bytes(b'python\0run.py\0--tier=manager\0')
    (directory / 'cgroup').write_text('0::/system.slice/fixture.service\n')
    host = cutover.LinuxHost(proc=proc)
    process = host.process(17)
    assert process['start'] == '12345' and cutover.manager_process(process)
    assert host.process(18) is None
    (directory / 'cgroup').write_text('1:name=systemd:/unexpected\n')
    with pytest.raises(cutover.CutoverError, match='cgroup v2'):
        host.process(17)
