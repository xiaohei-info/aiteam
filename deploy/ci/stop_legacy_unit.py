#!/usr/bin/env python3
"""Unverified S05 main-first candidate. NOT wired into taiyi deployment.

Only the hosted, secret-free native probe may exercise this until its evidence
and the maintenance window are approved. No code/DB rollback or service start.
Reads process identity/argv (never environ); diagnostics contain no argv/logs.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


class CutoverError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CutoverError(message)


def digest(path: Path) -> str:
    require(path.is_file() and not path.is_symlink(), "expected regular approved file")
    return hashlib.sha256(path.read_bytes()).hexdigest()


class LinuxHost:
    def __init__(self, proc=Path('/proc'), cgroups=Path('/sys/fs/cgroup'), runtime=Path('/run/systemd/system')):
        self.proc, self.cgroups, self.runtime = proc, cgroups, runtime

    def systemctl(self, *args: str, timeout: int = 15) -> str:
        result = subprocess.run(['systemctl', *args], capture_output=True, text=True, timeout=timeout)
        # systemctl error/status output can contain environment/command values.
        require(result.returncode == 0, 'systemctl operation failed; keep cutover record/override for owner diagnosis')
        return result.stdout

    def info(self, unit: str) -> dict:
        names = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup',
                 'FragmentPath', 'DropInPaths', 'KillMode', 'Restart', 'NRestarts',
                 'ExecStop', 'ExecStopPost', 'ExecReload', 'KillSignal', 'SendSIGKILL', 'TimeoutStopUSec')
        text = self.systemctl('show', unit, '--property=' + ','.join(names))
        values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
        require(all(name in values for name in names), 'incomplete systemd unit identity')
        return values

    def process(self, pid: int) -> dict | None:
        directory = self.proc / str(pid)
        try:
            before = (directory / 'stat').read_text().rsplit(')', 1)[1].split()
            argv = (directory / 'cmdline').read_bytes().decode(errors='replace').rstrip('\0').split('\0')
            groups = (directory / 'cgroup').read_text().splitlines()
            after = (directory / 'stat').read_text().rsplit(')', 1)[1].split()
        except FileNotFoundError:
            return None
        require(before[19] == after[19], 'process identity changed during preflight')
        require(len(groups) == 1 and groups[0].startswith('0::/'), 'requires unified cgroup v2; owner preflight required')
        return {'pid': pid, 'start': before[19], 'cgroup': groups[0][3:], 'argv': argv}

    def processes(self) -> list[dict]:
        return [process for path in self.proc.iterdir() if path.name.isdigit()
                if (process := self.process(int(path.name))) is not None]

    def members(self, group: str) -> set[int]:
        require(group.startswith('/system.slice/') and '..' not in group, 'unexpected application cgroup')
        directory = self.cgroups / group.lstrip('/')
        members = set()
        for file in directory.rglob('cgroup.procs'):
            members.update(int(pid) for pid in file.read_text().split())
        return members

    def boot(self) -> str:
        return (self.proc / 'sys/kernel/random/boot_id').read_text().strip()


def identity(process: dict) -> dict:
    return {key: process[key] for key in ('pid', 'start', 'cgroup')}


def manager_process(process: dict) -> bool:
    argv = process['argv']
    return any('manager_service' in arg for arg in argv) or (
        any(Path(arg).name == 'run.py' for arg in argv)
        and ('--tier=manager' in argv or any(argv[i:i + 2] == ['--tier', 'manager'] for i in range(len(argv)))))


class LegacyStop:
    def __init__(self, host: LinuxHost, unit: str, root: Path, record: Path, unit_hash: str, daemon_hash: str, timeout: int):
        require(bool(re.fullmatch(r'aiteam-(?:v1|cutover-probe-[a-z0-9-]+)\.service', unit)), 'unexpected unit name; owner preflight required')
        require(root.is_absolute() and root == root.resolve(), 'deployment root must be an absolute canonical path')
        require(1 <= timeout <= 120, 'stop timeout must be 1..120 seconds')
        require(all(re.fullmatch(r'[0-9a-f]{64}', value) for value in (unit_hash, daemon_hash)), 'approved file hashes required')
        self.host, self.unit, self.root, self.record = host, unit, root, record
        self.unit_hash, self.daemon_hash, self.timeout = unit_hash, daemon_hash, timeout
        self.override = host.runtime / (unit + '.d') / '90-aiteam-s05-cutover.conf'

    def override_text(self) -> str:
        return ('# S05 main-first cutover; retain until recorded cgroup is empty.\n[Service]\n'
                'ExecStop=\nExecStopPost=\nExecReload=\nRestart=no\nKillMode=control-group\n'
                'KillSignal=SIGTERM\nSendSIGKILL=yes\nFinalKillSignal=SIGKILL\n'
                f'TimeoutStopSec={self.timeout}s\n')

    def save(self, record: dict) -> None:
        temporary = self.record.with_suffix('.tmp')
        with temporary.open('w') as stream:
            os.chmod(temporary, 0o600)
            json.dump(record, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.record)

    def approved_files(self, info: dict) -> None:
        require(info['Id'] == self.unit and info['LoadState'] == 'loaded', 'unit identity mismatch')
        require(digest(Path(info['FragmentPath'])) == self.unit_hash, 'unit bytes differ from approved preflight')
        require(digest(self.root / 'scripts/ctl.sh') == self.daemon_hash, 'daemon bytes differ from approved preflight')

    def check_upstreams(self, upstreams: list[dict], group: str) -> None:
        require(bool(upstreams), 'explicit external upstream process inventory required')
        for expected in upstreams:
            process = self.host.process(expected['pid'])
            require(process is not None and identity(process) == expected, 'upstream identity changed; owner preflight required')
            require(process['cgroup'] != group and not process['cgroup'].startswith(group + '/'), 'upstream belongs to application cgroup')

    def no_unexpected_manager(self, allowed: set[int]) -> None:
        require(all(not manager_process(p) or p['pid'] in allowed for p in self.host.processes()),
                'unexpected Manager process; release remains blocked; owner preflight required')

    def preflight(self, upstream_pids: list[int]) -> None:
        require(not self.record.exists() and not self.override.exists(), 'existing cutover record/override; resume it instead')
        info = self.host.info(self.unit)
        self.approved_files(info)
        require(info['ActiveState'] == 'active' and info['SubState'] == 'running', 'legacy unit is not running')
        require(not info['DropInPaths'] and info['KillMode'] == 'control-group', 'unexpected unit override or kill mode')
        group = info['ControlGroup']
        require(group == f'/system.slice/{self.unit}', 'unexpected unit cgroup')
        main = self.host.process(int(info['MainPID']))
        require(main is not None and main['cgroup'] == group, 'daemon identity unavailable')
        require(main['argv'] == ['bash', str(self.root / 'scripts/ctl.sh'), 'start', '--env', 'test', '--daemon']
                or main['argv'] == ['/usr/bin/bash', str(self.root / 'scripts/ctl.sh'), 'start', '--env', 'test', '--daemon']
                or main['argv'] == ['/bin/bash', str(self.root / 'scripts/ctl.sh'), 'start', '--env', 'test', '--daemon'],
                'unexpected daemon argv; owner preflight required')
        members = self.host.members(group)
        tiers = {}
        for tier in ('manager', 'operation', 'agent'):
            pid = int((self.root / '.state' / f'{tier}.pid').read_text().strip())
            process = self.host.process(pid)
            require(pid in members and process is not None and process['cgroup'] == group, 'tier PID not owned by the approved cgroup')
            tiers[tier] = identity(process)
        require(len({main['pid'], *(p['pid'] for p in tiers.values())}) == 4, 'tier PID inventory is ambiguous')
        manager = self.host.process(tiers['manager']['pid'])
        require(manager is not None and manager_process(manager), 'Manager PID does not identify Manager')
        self.no_unexpected_manager({tiers['manager']['pid']})
        upstreams = []
        for pid in upstream_pids:
            process = self.host.process(pid)
            require(process is not None, 'upstream process missing')
            upstreams.append(identity(process))
        self.check_upstreams(upstreams, group)
        self.save({'unit': self.unit, 'root': str(self.root), 'unit_hash': self.unit_hash,
                   'daemon_hash': self.daemon_hash, 'timeout': self.timeout, 'boot': self.host.boot(),
                   'main': identity(main), 'tiers': tiers, 'upstreams': upstreams, 'phase': 'preflight'})
        print('[cutover] preflight recorded (identity metadata only)', flush=True)

    def same_main(self, info: dict, record: dict) -> bool:
        if info['MainPID'] == '0':
            return False
        process = self.host.process(int(info['MainPID']))
        require(process is not None and identity(process) == record['main'], 'daemon identity changed; refusing to signal replacement')
        return True

    def stop(self) -> None:
        record = json.loads(self.record.read_text())
        expected = {'unit': self.unit, 'root': str(self.root), 'unit_hash': self.unit_hash,
                    'daemon_hash': self.daemon_hash, 'timeout': self.timeout, 'boot': self.host.boot()}
        require(all(record.get(k) == v for k, v in expected.items()), 'cutover record does not match current approval/boot')
        group = record['main']['cgroup']
        info = self.host.info(self.unit)
        self.approved_files(info)
        self.check_upstreams(record['upstreams'], group)
        self.no_unexpected_manager({record['tiers']['manager']['pid']})
        self.same_main(info, record)
        require(info['DropInPaths'] in ('', str(self.override)), 'unexpected runtime override; owner preflight required')
        if self.override.exists():
            require(self.override.read_text() == self.override_text(), 'cutover override was changed')
        else:
            require(info['ActiveState'] == 'active' and self.same_main(info, record), 'missing cutover override on recovery; owner preflight required')
            self.override.parent.mkdir(parents=True, exist_ok=True)
            with self.override.open('x') as stream:
                stream.write(self.override_text())
                stream.flush()
                os.fsync(stream.fileno())
        # Reload even on resume: interruption may have occurred after the write.
        self.host.systemctl('daemon-reload')
        info = self.host.info(self.unit)
        require(info['DropInPaths'] == str(self.override) and info['Restart'] == 'no'
                and not info['ExecStop'] and not info['ExecStopPost'] and not info['ExecReload']
                and info['KillMode'] == 'control-group' and info['KillSignal'] == '15'
                and info['SendSIGKILL'] == 'yes' and info['TimeoutStopUSec'] == f'{self.timeout}s',
                'safe stop override not effective; no signal sent')
        self.approved_files(info)
        self.check_upstreams(record['upstreams'], group)
        # Validate the recorded generation, not only a possibly-reused PID file.
        for expected_tier in record['tiers'].values():
            process = self.host.process(expected_tier['pid'])
            require(process is None or identity(process) == expected_tier, 'tier PID was reused; owner preflight required')
        self.no_unexpected_manager({record['tiers']['manager']['pid']})
        if self.same_main(info, record):
            record['phase'] = 'override-ready'
            self.save(record)
            print('[cutover] override verified; stopping approved legacy main first', flush=True)
            self.host.systemctl('kill', '--kill-who=main', '--signal=SIGKILL', self.unit)
        self.host.systemctl('stop', self.unit, timeout=self.timeout + 20)
        info = self.host.info(self.unit)
        require(info['MainPID'] == '0' and info['ActiveState'] in ('inactive', 'failed')
                and not self.host.members(group), 'application cgroup not empty; retain override')
        self.no_unexpected_manager(set())
        self.check_upstreams(record['upstreams'], group)
        record['phase'] = 'stopped'
        self.save(record)
        # Keep the record for the release checkpoint; never restore old code/DB.
        self.override.unlink()
        self.host.systemctl('daemon-reload')
        print('[cutover] application cgroup empty; upstream identities unchanged; no restart performed', flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'stop'))
    parser.add_argument('--unit', required=True)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--record', required=True, type=Path)
    parser.add_argument('--unit-sha256', required=True)
    parser.add_argument('--daemon-sha256', required=True)
    parser.add_argument('--timeout', type=int, default=60)
    parser.add_argument('--upstream-pid', type=int, action='append', default=[])
    args = parser.parse_args()
    try:
        require(sys.platform == 'linux' and os.geteuid() == 0, 'requires approved root/systemd Linux fixture or maintenance window')
        os.umask(0o077)
        with args.record.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            stop = LegacyStop(LinuxHost(), args.unit, args.root, args.record,
                              args.unit_sha256, args.daemon_sha256, args.timeout)
            if args.action == 'preflight':
                stop.preflight(args.upstream_pid)
            else:
                stop.stop()
    except CutoverError as error:
        # Only fixed, source-defined reasons; never subprocess/file/argv values.
        print(f'[cutover][ERR] {error}; retain record/override; release blocked', file=sys.stderr)
        return 1
    except (OSError, ValueError, subprocess.SubprocessError):
        print('[cutover][ERR] preflight/stop I/O failed; retain record/override; owner diagnosis required', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
