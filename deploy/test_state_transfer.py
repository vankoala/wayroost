import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location('state_transfer', Path(__file__).with_name('state-transfer.py'))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)
SENTINEL = b'FAKE_PRIVATE_SENTINEL_do_not_emit\x00\xff'
NAMES = [name for family in transfer.FAMILIES.values() for name in family]


@pytest.fixture
def tree(tmp_path, monkeypatch):
    private = tmp_path / 'private'
    private.mkdir(mode=0o700)
    legacy, primary, journal = [private / name for name in ('legacy', 'primary', 'journal')]
    for directory in (legacy, primary, journal):
        directory.mkdir(mode=0o700)
    for directory in (legacy, primary):
        (directory / '.wayroost-role').write_bytes(b'primary\n')
        (directory / '.wayroost-role').chmod(0o600)
    for index, name in enumerate(NAMES):
        (legacy / name).write_bytes(SENTINEL + b'\n' + str(index).encode('ascii'))
        (legacy / name).chmod(0o600 if index % 2 == 0 else 0o400)
        (primary / name).write_bytes(b'Invented destination original: ' + name.encode('ascii'))
        (primary / name).chmod(0o600)
    original_lstat = os.lstat
    original_fstat = os.fstat

    def root_info(info):
        values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
        values['st_uid'] = 0
        return SimpleNamespace(**values)

    def simulated_lstat(path, *args, **kwargs):
        info = original_lstat(path, *args, **kwargs)
        path = Path(path)
        if stat.S_ISDIR(info.st_mode) and path not in (legacy, primary):
            result = root_info(info)
            if path == Path('/tmp'):
                result.st_mode &= ~0o022
            return result
        if path.parent == journal and path.name.endswith(('.json', '.tmp', '.lock')):
            return root_info(info)
        return info

    monkeypatch.setattr(os, 'lstat', simulated_lstat)
    # Only the lock's root metadata is relevant to fstat; binary hashing uses identities.
    monkeypatch.setattr(os, 'fstat', lambda fd: root_info(original_fstat(fd)))
    calls = []

    def runner(argv, **kwargs):
        calls.append(argv)
        if argv[1] == 'show':
            return SimpleNamespace(returncode=0, stdout='loaded\n')
        return SimpleNamespace(returncode=3, stdout='inactive\n')

    real_transfer = transfer.transfer

    def run(mode, **kwargs):
        return real_transfer(mode, str(legacy), str(primary), str(journal), ['example-legacy.service', 'example-primary.service'], runner=runner, uid=0, **kwargs)

    return SimpleNamespace(legacy=legacy, primary=primary, journal=journal, run=run, calls=calls, original_lstat=original_lstat, monkeypatch=monkeypatch)


def bytes_of(root):
    return {name: (root / name).read_bytes() if (root / name).exists() else None for name in NAMES}


def test_every_allowlisted_family_forward_verify_and_current_reverse(tree, capsys):
    original = bytes_of(tree.legacy)
    destination_original = bytes_of(tree.primary)
    assert tree.run('plan')['files'].keys() == set(NAMES)
    assert not (tree.journal / 'forward-journal.json').exists()
    assert tree.run('forward')['verified']
    assert bytes_of(tree.primary) == original
    assert tree.run('verify')['verified']
    assert bytes_of(tree.legacy) == original
    for name in NAMES:
        info = tree.original_lstat(tree.primary / name)
        source_info = tree.original_lstat(tree.legacy / name)
        assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (source_info.st_uid, source_info.st_gid, stat.S_IMODE(source_info.st_mode))
        assert (tree.journal / 'forward-rollback' / name).read_bytes() == destination_original[name]
    changed = {}
    for name in NAMES:
        changed[name] = b'CURRENT invented bytes ' + name.encode('ascii') + SENTINEL
        (tree.primary / name).chmod(0o600)
        (tree.primary / name).write_bytes(changed[name])
    assert tree.run('reverse', compatible=list(transfer.FAMILIES))['verified']
    assert bytes_of(tree.legacy) == changed
    for name in NAMES:
        assert (tree.journal / 'reverse-rollback' / name).read_bytes() == original[name]
    assert tree.run('reverse', compatible=list(transfer.FAMILIES))['verified']
    assert tree.run('verify')['verified']
    assert all(call[0] == '/usr/bin/systemctl' and call[1] in ('show', 'is-active') for call in tree.calls)
    assert all(call[1:5] == ['show', '-p', 'LoadState', '--value'] for call in tree.calls if call[1] == 'show')
    output = capsys.readouterr()
    assert SENTINEL[:20].decode('ascii') not in output.out + output.err
    for path in tree.journal.glob('*.json'):
        assert SENTINEL[:20] not in path.read_bytes()
    # Only fixed marker metadata is interpreted; store bytes need not be JSON or UTF-8.
    assert (tree.primary / 'hermes-credentials.json').read_bytes().endswith(SENTINEL)


def test_incompatible_families_are_archived_without_resetting_legacy(tree):
    tree.run('forward')
    originals = bytes_of(tree.legacy)
    (tree.primary / 'feed.json').write_bytes(b'Invented incompatible current format' + SENTINEL)
    result = tree.run('reverse', compatible=['voice'])
    assert 'feed' in result['archived']
    assert (tree.legacy / 'feed.json').read_bytes() == originals['feed.json']
    assert (tree.journal / 'reverse-archive' / 'feed.json').read_bytes() == (tree.primary / 'feed.json').read_bytes()
    receipt = json.loads((tree.journal / 'reverse-receipt.json').read_text())
    assert receipt['archived'] == result['archived']
    assert receipt['files']['feed.json']['compatible'] is False
    assert tree.run('verify')['verified']


def test_reverse_verification_uses_recorded_current_sources_and_absence(tree):
    tree.run('forward')
    (tree.primary / 'voice.json').chmod(0o600)
    (tree.primary / 'voice.json').write_bytes(b'Current compatible voice' + SENTINEL)
    (tree.primary / 'feed.json').write_bytes(b'Current incompatible feed' + SENTINEL)
    (tree.primary / 'schedule-ideas.json').unlink()
    originals = bytes_of(tree.legacy)
    tree.run('reverse', compatible=['voice'])
    assert (tree.legacy / 'voice.json').read_bytes() != originals['voice.json']
    assert (tree.legacy / 'feed.json').read_bytes() == originals['feed.json']
    assert not (tree.journal / 'reverse-archive' / 'schedule-ideas.json').exists()
    assert tree.run('verify')['verified']
    path = tree.journal / 'reverse-archive' / 'schedule-ideas.json'
    path.write_bytes(b'Unexpected archived member')
    path.chmod(0o600)
    with pytest.raises(transfer.TransferError):
        tree.run('verify')


@pytest.mark.parametrize('step', ['receipted', 'complete'])
def test_incompatible_reverse_receipt_verifies_after_interruption_and_resume(tree, step):
    tree.run('forward')
    (tree.primary / 'feed.json').write_bytes(b'Current incompatible format')

    def interrupt(current):
        if current == step:
            raise RuntimeError('Invented interruption')

    with pytest.raises(RuntimeError, match='Invented interruption'):
        tree.run('reverse', compatible=['voice'], checkpoint=interrupt)
    assert tree.run('verify')['verified']
    assert tree.run('reverse', compatible=['voice'])['verified']
    assert tree.run('verify')['verified']


@pytest.mark.parametrize('mode', ['verify', 'reverse'])
@pytest.mark.parametrize('artifact', ['destination', 'retained-original', 'archive', 'rollback', 'compatible-rollback', 'source'])
@pytest.mark.parametrize('kind', ['hash', 'size', 'mode', 'owner', 'missing'])
def test_reverse_verification_checks_each_receipted_artifact(tree, artifact, kind, mode):
    (tree.legacy / 'voice.json').chmod(0o600)
    tree.run('forward')
    for name in ('voice.json', 'feed.json'):
        (tree.primary / name).chmod(0o600)
        (tree.primary / name).write_bytes(b'Current bytes ' + name.encode('ascii'))
    tree.run('reverse', compatible=['voice'])
    assert tree.run('verify')['verified']
    path = {
        'destination': tree.legacy / 'voice.json',
        'retained-original': tree.legacy / 'feed.json',
        'archive': tree.journal / 'reverse-archive' / 'feed.json',
        'rollback': tree.journal / 'reverse-rollback' / 'feed.json',
        'compatible-rollback': tree.journal / 'reverse-rollback' / 'voice.json',
        'source': tree.primary / 'voice.json',
    }[artifact]
    if kind == 'hash':
        data = bytearray(path.read_bytes())
        data[0] ^= 1
        path.write_bytes(data)
    elif kind == 'size':
        with path.open('ab') as file:
            file.write(b'longer')
    elif kind == 'mode':
        path.chmod(0o400)
    elif kind == 'owner':
        previous = os.lstat

        def changed_owner(at, *args, **kwargs):
            info = previous(at, *args, **kwargs)
            if Path(at) == path:
                values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
                values['st_uid'] = 4242
                return SimpleNamespace(**values)
            return info

        tree.monkeypatch.setattr(os, 'lstat', changed_owner)
    else:
        path.unlink()
    with pytest.raises(transfer.TransferError):
        tree.run(mode, **({'compatible': ['voice']} if mode == 'reverse' else {}))


@pytest.mark.parametrize('folder', ['reverse-archive', 'reverse-rollback'])
@pytest.mark.parametrize('kind', ['mode', 'missing', 'symlink'])
def test_completed_reverse_checks_private_retained_directories(tree, folder, kind):
    tree.run('forward')
    tree.run('reverse', compatible=['voice'])
    path = tree.journal / folder
    if kind == 'mode':
        path.chmod(0o755)
    else:
        saved = tree.journal / (folder + '-saved')
        path.rename(saved)
        if kind == 'symlink':
            path.symlink_to(saved, target_is_directory=True)
    with pytest.raises((transfer.TransferError, FileNotFoundError)):
        tree.run('reverse', compatible=['voice'])


@pytest.mark.parametrize('artifact', ['archive', 'rollback'])
def test_completed_reverse_checks_recorded_absence_in_retained_copies(tree, artifact):
    if artifact == 'rollback':
        (tree.legacy / 'schedule-ideas.json').unlink()
    tree.run('forward')
    (tree.primary / 'schedule-ideas.json').unlink(missing_ok=True)
    tree.run('reverse', compatible=['voice'])
    path = tree.journal / ('reverse-' + artifact) / 'schedule-ideas.json'
    path.write_bytes(b'Unexpected retained member')
    path.chmod(0o600)
    with pytest.raises(transfer.TransferError):
        tree.run('reverse', compatible=['voice'])


@pytest.mark.parametrize('field', ['mode', 'archive', 'rollback', 'archived', 'families', 'files', 'missing'])
def test_completed_reverse_validates_its_receipt(tree, field):
    tree.run('forward')
    tree.run('reverse', compatible=['voice'])
    path = tree.journal / 'reverse-receipt.json'
    if field == 'missing':
        path.unlink()
    else:
        receipt = json.loads(path.read_text())
        if field == 'files':
            receipt['files']['../not-a-store'] = receipt['files'].pop('voice.json')
        else:
            receipt[field] = [] if field in ('archived', 'families') else 'invented-invalid-value'
        path.write_text(json.dumps(receipt))
    with pytest.raises((transfer.TransferError, FileNotFoundError)):
        tree.run('reverse', compatible=['voice'])


@pytest.mark.parametrize('compatible', [list(transfer.FAMILIES), ['voice']])
@pytest.mark.parametrize('step', ['prepared', 'staged', 'published:voice.json', 'receipted', 'complete'])
def test_verify_requires_reverse_receipt_once_reverse_has_begun(tree, compatible, step):
    tree.run('forward')

    def interrupt(current):
        if current == step:
            raise RuntimeError('Invented interruption')

    with pytest.raises(RuntimeError, match='Invented interruption'):
        tree.run('reverse', compatible=compatible, checkpoint=interrupt)
    receipt = tree.journal / 'reverse-receipt.json'
    receipt.unlink(missing_ok=True)
    before = {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()}
    with pytest.raises(transfer.TransferError, match='reverse receipt'):
        tree.run('verify')
    assert {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()} == before
    if step not in ('receipted', 'complete'):
        assert tree.run('reverse', compatible=compatible)['verified']
        assert tree.run('verify')['verified']


@pytest.mark.parametrize('compatible', [list(transfer.FAMILIES), ['voice']])
@pytest.mark.parametrize('artifact', ['intact', 'rollback', 'archive'])
def test_verify_cannot_skip_reverse_artifacts_when_receipt_is_missing(tree, compatible, artifact):
    tree.run('forward')
    tree.run('reverse', compatible=compatible)
    (tree.journal / 'reverse-receipt.json').unlink()
    if artifact != 'intact':
        (tree.journal / ('reverse-' + artifact) / 'feed.json').unlink(missing_ok=True)
    before = {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()}
    with pytest.raises(transfer.TransferError, match='reverse receipt'):
        tree.run('verify')
    assert {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()} == before


@pytest.mark.parametrize('mode', ['verify', 'reverse'])
def test_reverse_receipt_must_match_its_journal_even_when_artifacts_match(tree, mode):
    tree.run('forward')
    compatible = list(transfer.FAMILIES)
    tree.run('reverse', compatible=compatible)
    path = tree.journal / 'reverse-receipt.json'
    receipt = json.loads(path.read_text())
    receipt['files']['feed.json']['original']['mode'] = 0o400
    (tree.journal / 'reverse-rollback' / 'feed.json').chmod(0o400)
    path.write_text(json.dumps(receipt))
    before = {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()}
    with pytest.raises(transfer.TransferError, match='Receipt does not match.*journal'):
        tree.run(mode, **({'compatible': compatible} if mode == 'reverse' else {}))
    assert {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()} == before


def test_verify_never_recreates_a_missing_lock_when_reverse_receipt_is_missing(tree):
    tree.run('forward')
    tree.run('reverse', compatible=list(transfer.FAMILIES))
    (tree.journal / 'reverse-receipt.json').unlink()
    (tree.journal / 'transfer.lock').unlink()
    before = {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()}
    with pytest.raises(FileNotFoundError):
        tree.run('verify')
    assert {path: path.read_bytes() for path in tree.legacy.parent.rglob('*') if path.is_file()} == before


def test_absence_is_part_of_a_family_and_retention_is_transferred(tree):
    (tree.legacy / 'task-events.jsonl.retention').unlink()
    (tree.legacy / 'voice.json').unlink()
    tree.run('forward')
    assert not (tree.primary / 'task-events.jsonl.retention').exists()
    assert not (tree.primary / 'voice.json').exists()
    assert (tree.journal / 'forward-rollback' / 'task-events.jsonl.retention').exists()
    tree.run('verify')
    (tree.primary / 'tasks.json').unlink()
    tree.run('reverse', compatible=list(transfer.FAMILIES))
    assert not (tree.legacy / 'tasks.json').exists()
    assert (tree.journal / 'reverse-rollback' / 'tasks.json').exists()
    assert tree.run('verify')['verified']


@pytest.mark.parametrize('source_present', [False, True])
@pytest.mark.parametrize('destination_present', [False, True])
@pytest.mark.parametrize('compatible', [False, True])
def test_task_and_lineage_markers_transfer_with_absence_and_exact_retained_originals(tree, source_present, destination_present, compatible):
    markers = ('task-admissions.json', 'tasks-quiet.json', 'lineage-quiet.json', 'lineage-quiet-save.json')
    originals = {}
    for directory, present in ((tree.legacy, source_present), (tree.primary, destination_present)):
        for name in markers:
            path = directory / name
            path.unlink(missing_ok=True)
            originals[path] = (directory.name + ':' + name).encode() if present else None
            if present:
                path.write_bytes(originals[path])
                path.chmod(0o400)
    families = ['tasks', 'lineage']
    plan = tree.run('plan', families=families)
    assert set(markers) <= plan['files'].keys()
    tree.run('forward', families=families)
    tree.run('verify', families=families)
    for name in markers:
        transfer.check_copy(tree.primary / name, transfer.metadata(tree.legacy / name),
                            (os.getuid(), os.getgid()))
        backup = tree.journal / 'forward-rollback' / name
        assert (backup.read_bytes() if backup.exists() else None) == originals[tree.primary / name]
        if backup.exists():
            assert stat.S_IMODE(backup.stat().st_mode) == 0o400
        path = tree.primary / name
        path.unlink(missing_ok=True)
        if not source_present:
            path.write_bytes(b'Current primary marker: ' + name.encode())
            path.chmod(0o600)
    current = {name: transfer.metadata(tree.primary / name) for name in markers}
    tree.run('reverse', families=families, compatible=families if compatible else [])
    tree.run('verify', families=families)
    for name in markers:
        backup = tree.journal / 'reverse-rollback' / name
        assert (backup.read_bytes() if backup.exists() else None) == originals[tree.legacy / name]
        if backup.exists():
            assert stat.S_IMODE(backup.stat().st_mode) == 0o400
        expected = current[name] if compatible else transfer.metadata(backup)
        transfer.check_copy(tree.legacy / name, expected, (os.getuid(), os.getgid()))


@pytest.mark.parametrize('source_present', [False, True])
@pytest.mark.parametrize('destination_present', [False, True])
def test_holds_and_admin_sockets_stay_local_in_both_directions(tree, source_present, destination_present, monkeypatch):
    holds, sockets = {}, {}
    for directory, present in ((tree.legacy, source_present), (tree.primary, destination_present)):
        hold = directory / 'bridge-maintenance.json'
        holds[hold] = (directory.name + ': independent hold').encode() if present else None
        if present:
            hold.write_bytes(holds[hold])
            hold.chmod(0o600)
        (directory / 'bridge-admin').mkdir()
        monkeypatch.chdir(directory)
        with socket.socket(socket.AF_UNIX) as admin:
            admin.bind('bridge-admin/admin.sock')
        path = directory / 'bridge-admin/admin.sock'
        sockets[path] = path.stat().st_ino
    for mode in ('forward', 'reverse'):
        tree.run(mode, **({'compatible': list(transfer.FAMILIES)} if mode == 'reverse' else {}))
        tree.run('verify')
        for path, expected in holds.items():
            assert (path.read_bytes() if path.exists() else None) == expected
        for path, inode in sockets.items():
            assert stat.S_ISSOCK(path.stat().st_mode) and path.stat().st_ino == inode
        for path in tree.journal.rglob('*'):
            assert path.name not in ('bridge-maintenance.json', 'bridge-admin', 'admin.sock')


def test_transferred_storage_failure_keeps_the_destination_quiet_check_unavailable(tree):
    for directory in (tree.legacy, tree.primary):
        for name in (*transfer.FAMILIES['tasks'], 'task-admissions.json', 'tasks-quiet.json'):
            (directory / name).unlink(missing_ok=True)
        (directory / 'tasks.json').write_bytes(b'{"tasks":[]}')
        (directory / 'tasks.json').chmod(0o600)
        (directory / 'bridge-maintenance.json').write_bytes(b'{"version":1,"held":true}')
    marker = tree.legacy / 'tasks-quiet.json'
    marker.write_bytes(b'{"reason":"tasks_unavailable"}')
    marker.chmod(0o600)
    script = """
import { MaintenanceHold } from './server/src/bridge/maintenance.js';
import { quietReport } from './server/src/bridge/quiet.js';
import { DisabledHermes, DisabledPaseo } from './server/src/disabled.js';
import { TaskRelay } from './server/src/tasks/relay.js';
import { TaskStore } from './server/src/tasks/store.js';
const log = { info() {}, warn() {} };
const stateDir = process.argv[2];
const store = new TaskStore(stateDir, Date.now, undefined, log);
const tasks = new TaskRelay({ store, workers: { revision: {} } });
console.log(JSON.stringify(await quietReport({ hold: new MaintenanceHold(stateDir), tasks,
  sources: { hermes: new DisabledHermes(), paseo: new DisabledPaseo() } })));
"""

    def quiet(directory):
        result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-', str(directory)],
                                input=script, cwd=Path(__file__).resolve().parent.parent,
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    assert quiet(tree.primary)['quiet'] is True
    assert 'tasks_unavailable' in quiet(tree.legacy)['reasons']
    tree.run('forward')
    report = quiet(tree.primary)
    assert report['quiet'] is False
    assert report['pendingRelays'] is None
    assert 'tasks_unavailable' in report['reasons']


@pytest.mark.parametrize('marker', ['lineage-quiet.json', 'lineage-quiet-save.json'])
def test_transferred_lineage_failure_keeps_the_destination_activity_unavailable(tree, marker):
    for directory in (tree.legacy, tree.primary):
        # An absent ledger is an empty, readable lineage; only the marker differs.
        for name in transfer.FAMILIES['lineage']:
            (directory / name).unlink(missing_ok=True)
    path = tree.legacy / marker
    path.write_bytes(b'{"reason":"paseo_activity_unavailable"}')
    path.chmod(0o600)
    script = """
import { BackgroundGate } from './server/src/background.js';
import { Lineage } from './server/src/lineage.js';
const lineage = new Lineage(process.argv[2], { info() {}, warn() {} }, Date.now, new BackgroundGate('primary'));
console.log(JSON.stringify({ unavailable: lineage.unavailable }));
"""

    def unavailable(directory):
        result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-', str(directory)],
                                input=script, cwd=Path(__file__).resolve().parent.parent,
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout.strip().splitlines()[-1])['unavailable']

    assert unavailable(tree.primary) is False
    assert unavailable(tree.legacy) is True
    tree.run('forward', families=['tasks', 'lineage'])
    assert unavailable(tree.primary) is True


def steps(mode):
    result = ['prepared']
    for name in NAMES:
        result += ['stage:' + name, 'rollback:' + name, 'archive:' + name]
    result += ['staged']
    for name in NAMES:
        result += ['before-publish:' + name, 'published:' + name]
    return result + ['receipted', 'complete']


@pytest.mark.parametrize('mode', ['forward', 'reverse'])
@pytest.mark.parametrize('step', steps('forward'))
def test_interruption_at_every_journal_step_resumes_idempotently(tree, mode, step):
    if mode == 'reverse':
        tree.run('forward')
        for name in NAMES:
            (tree.primary / name).chmod(0o600)
            (tree.primary / name).write_bytes(b'CURRENT ' + name.encode('ascii') + SENTINEL)
    source = tree.legacy if mode == 'forward' else tree.primary
    destination = tree.primary if mode == 'forward' else tree.legacy
    expected = bytes_of(source)

    def interrupt(current):
        if current == step:
            raise RuntimeError('Invented interruption')

    kwargs = {'compatible': list(transfer.FAMILIES)} if mode == 'reverse' else {}
    with pytest.raises(RuntimeError, match='Invented interruption'):
        tree.run(mode, checkpoint=interrupt, **kwargs)
    assert tree.run(mode, **kwargs)['verified']
    assert bytes_of(destination) == expected
    journal_bytes = (tree.journal / (mode + '-journal.json')).read_bytes()
    assert tree.run(mode, **kwargs)['verified']
    assert (tree.journal / (mode + '-journal.json')).read_bytes() == journal_bytes


@pytest.mark.parametrize('state,code', [('active', 0), ('activating', 0), ('unknown', 4), ('inactive', 1), ('', 3)])
def test_refuses_running_and_unproved_writers(tree, state, code):
    def runner(argv, **kwargs):
        return SimpleNamespace(returncode=0, stdout='loaded\n') if argv[1] == 'show' else SimpleNamespace(returncode=code, stdout=state)
    with pytest.raises(transfer.TransferError, match='Writer is active'):
        transfer.transfer('forward', str(tree.legacy), str(tree.primary), str(tree.journal), ['example.service'], runner=runner, uid=0)
    assert not (tree.journal / 'forward-journal.json').exists()


@pytest.mark.parametrize('mode', ['plan', 'forward', 'verify', 'reverse'])
@pytest.mark.parametrize('load_state,code', [('not-found', 0), ('masked', 0), ('error', 0), ('loaded', 1)])
def test_refuses_missing_or_unproved_unit_before_writes(tree, mode, load_state, code):
    def runner(argv, **kwargs):
        if argv[1] == 'show':
            return SimpleNamespace(returncode=code, stdout=load_state + '\n')
        return SimpleNamespace(returncode=3, stdout='inactive\n')

    before = sorted(tree.journal.iterdir())
    with pytest.raises(transfer.TransferError, match='loaded'):
        transfer.transfer(mode, str(tree.legacy), str(tree.primary), str(tree.journal), ['example-missing.service'], runner=runner, uid=0)
    assert sorted(tree.journal.iterdir()) == before


@pytest.mark.parametrize('name', list(transfer.FORBIDDEN) + ['device-registry', 'pairing/pair.sock', '../voice.json', 'credentials', 'shadow-marker'])
def test_refuses_nontransferable_stores(tree, name):
    with pytest.raises(transfer.TransferError, match='allowlisted'):
        tree.run('forward', families=[name])


def test_refuses_wrong_user_before_any_filesystem_access():
    with pytest.raises(transfer.TransferError, match='must run as root'):
        transfer.transfer('plan', '/nonexistent/legacy', '/nonexistent/primary', '/nonexistent/journal', ['example.service'], uid=1000)


def test_cli_refuses_non_root_without_emitting_store_data():
    if os.geteuid() == 0:
        pytest.skip('This invocation exercises an unprivileged CLI.')
    result = subprocess.run(['python3', str(Path(__file__).with_name('state-transfer.py')), 'plan', '--legacy-dir', '/nonexistent/legacy', '--primary-dir', '/nonexistent/primary', '--journal-dir', '/nonexistent/journal', '--stopped-unit', 'example.service'], capture_output=True, text=True)
    assert result.returncode == 1
    assert result.stderr.strip() == 'State transfer must run as root.'


@pytest.mark.parametrize('kind', ['symlink', 'hardlink', 'mode', 'owner', 'hash', 'size'])
def test_hash_owner_mode_size_and_link_checks(tree, kind):
    tree.run('forward')
    path = tree.primary / 'feed.json'
    if kind == 'symlink':
        path.unlink()
        path.symlink_to(tree.legacy / 'feed.json')
    elif kind == 'hardlink':
        path.unlink()
        os.link(tree.legacy / 'feed.json', path)
    elif kind == 'mode':
        path.chmod(0o644)
    elif kind == 'owner':
        previous = os.lstat

        def changed_owner(at, *args, **kwargs):
            info = previous(at, *args, **kwargs)
            if Path(at) == path:
                values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
                values['st_uid'] = 4242
                return SimpleNamespace(**values)
            return info

        tree.monkeypatch.setattr(os, 'lstat', changed_owner)
    elif kind == 'hash':
        data = bytearray(path.read_bytes())
        data[0] ^= 1
        path.write_bytes(data)
    else:
        with path.open('ab') as file:
            file.write(b'longer')
    with pytest.raises(transfer.TransferError):
        tree.run('verify')


@pytest.mark.parametrize('kind', ['shadow', 'invalid-marker', 'symlink-directory', 'public-parent', 'writable-parent', 'owner-parent'])
def test_refuses_unsafe_paths_and_role_markers(tree, kind):
    if kind in ('shadow', 'invalid-marker'):
        (tree.primary / '.wayroost-role').write_bytes(b'shadow\n' if kind == 'shadow' else b'bad\n')
    elif kind == 'symlink-directory':
        moved = tree.primary.with_name('moved')
        tree.primary.rename(moved)
        tree.primary.symlink_to(moved, target_is_directory=True)
    elif kind == 'public-parent':
        tree.primary.parent.chmod(0o755)
    elif kind == 'writable-parent':
        tree.primary.parent.chmod(0o777)
    else:
        previous = os.lstat

        def changed_owner(at, *args, **kwargs):
            info = previous(at, *args, **kwargs)
            if Path(at) == tree.primary.parent:
                values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
                values['st_uid'] = 4242
                return SimpleNamespace(**values)
            return info

        tree.monkeypatch.setattr(os, 'lstat', changed_owner)
    with pytest.raises(transfer.TransferError):
        tree.run('plan')


def test_retains_markers_and_never_touches_pairing_push_tokens_or_unknown_stores(tree):
    paths = {}
    for root in (tree.legacy, tree.primary):
        for name in ('devices.json', 'push.json', 'bridge-token', 'cookies', 'unknown.json'):
            path = root / name
            paths[path] = b'Untouched invented identity'
            path.write_bytes(paths[path])
        paths[root / '.wayroost-role'] = b'primary\n'
    tree.run('forward')
    tree.run('reverse', compatible=list(transfer.FAMILIES))
    for path, expected in paths.items():
        assert path.read_bytes() == expected


def test_source_change_after_interruption_is_refused(tree):
    def interrupt(step):
        if step == 'staged':
            raise RuntimeError('Interrupted')
    with pytest.raises(RuntimeError):
        tree.run('forward', checkpoint=interrupt)
    (tree.legacy / 'feed.json').write_bytes(b'Changed after preparation')
    with pytest.raises(transfer.TransferError, match='Source changed'):
        tree.run('forward')


def test_refuses_split_provenance_and_reverse_without_receipt(tree):
    with pytest.raises(transfer.TransferError, match='Tasks and lineage'):
        tree.run('forward', families=['tasks'])
    with pytest.raises(transfer.TransferError, match='forward receipt'):
        tree.run('reverse')


def test_journal_manifest_cannot_expand_the_allowlist(tree):
    def interrupt(step):
        if step == 'prepared':
            raise RuntimeError('Interrupted')
    with pytest.raises(RuntimeError):
        tree.run('forward', checkpoint=interrupt)
    path = tree.journal / 'forward-journal.json'
    document = json.loads(path.read_text())
    document['files']['../not-a-store'] = document['files'].pop('voice.json')
    path.write_text(json.dumps(document))
    with pytest.raises(transfer.TransferError, match='allowlisted journal'):
        tree.run('forward')


def test_stopped_units_are_rechecked_before_any_publication(tree):
    original = bytes_of(tree.primary)
    calls = 0

    def runner(argv, **kwargs):
        nonlocal calls
        if argv[1] == 'show':
            return SimpleNamespace(returncode=0, stdout='loaded\n')
        calls += 1
        return SimpleNamespace(returncode=3 if calls <= 2 else 0, stdout='inactive' if calls <= 2 else 'active')

    with pytest.raises(transfer.TransferError, match='Writer is active'):
        transfer.transfer('forward', str(tree.legacy), str(tree.primary), str(tree.journal), ['example-legacy.service', 'example-primary.service'], runner=runner, uid=0)
    assert bytes_of(tree.primary) == original
    assert tree.run('forward')['verified']


def test_opaque_copy_supports_different_filesystems(tree):
    import errno
    tree.monkeypatch.setattr(os, 'copy_file_range', lambda *args: (_ for _ in ()).throw(OSError(errno.EXDEV, 'Invented device boundary')))
    assert tree.run('forward')['verified']
    assert bytes_of(tree.primary) == bytes_of(tree.legacy)


def test_dynamic_service_ownership_is_taken_from_prepared_directory(tree):
    previous = os.lstat
    ownership = {}
    primary_owner = (65534, 65534)

    def outside_namespace_info(path, *args, **kwargs):
        info = previous(path, *args, **kwargs)
        path = Path(path)
        chosen = primary_owner if path == tree.primary else ownership.get(path)
        if chosen is None:
            return info
        values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
        values['st_uid'], values['st_gid'] = chosen
        return SimpleNamespace(**values)

    # Opaque publications are renamed; move the simulated ownership with the inode.
    original_replace = os.replace

    def replace(source, destination):
        original_replace(source, destination)
        source, destination = Path(source), Path(destination)
        if source in ownership:
            ownership[destination] = ownership.pop(source)

    chowns = []
    opened_paths = {}
    original_open = os.open

    def opened(path, *args, **kwargs):
        fd = original_open(path, *args, **kwargs)
        opened_paths[fd] = Path(path)
        return fd

    def fchown(fd, uid, gid):
        path = opened_paths[fd]
        ownership[path] = (uid, gid)
        chowns.append((uid, gid))

    # Existing destination files must already share the prepared directory's owner.
    for name in NAMES:
        ownership[tree.primary / name] = primary_owner
    tree.monkeypatch.setattr(os, 'lstat', outside_namespace_info)
    tree.monkeypatch.setattr(os, 'open', opened)
    tree.monkeypatch.setattr(os, 'fchown', fchown)
    tree.monkeypatch.setattr(os, 'replace', replace)
    assert tree.run('forward')['verified']
    assert primary_owner in chowns
    assert all(ownership[tree.primary / name] == primary_owner for name in NAMES)
    tree.run('verify')


def test_cli_output_and_metadata_contain_no_store_contents(tree, capsys):
    tree.monkeypatch.setattr(transfer, 'transfer', lambda mode, *args, **kwargs: tree.run(mode))
    args = ['--legacy-dir', str(tree.legacy), '--primary-dir', str(tree.primary), '--journal-dir', str(tree.journal), '--stopped-unit', 'example.service']
    assert transfer.main(['plan', *args]) == 0
    assert transfer.main(['forward', *args]) == 0
    output = capsys.readouterr()
    assert 'FAKE_PRIVATE_SENTINEL' not in output.out + output.err
    for path in tree.journal.glob('*.json'):
        assert 'FAKE_PRIVATE_SENTINEL' not in path.read_text()


def test_reverse_refuses_split_compatibility(tree):
    tree.run('forward')
    with pytest.raises(transfer.TransferError, match='compatibility must be confirmed together'):
        tree.run('reverse', compatible=['tasks'])


def test_completed_reverse_refuses_new_current_state_without_a_new_transaction(tree):
    tree.run('forward')
    tree.run('reverse', compatible=list(transfer.FAMILIES))
    (tree.primary / 'feed.json').write_bytes(b'New current state after completed reverse')
    with pytest.raises(transfer.TransferError, match='Source changed since preparation'):
        tree.run('reverse', compatible=list(transfer.FAMILIES))


def artifact_tree(root):
    return {str(path.relative_to(root)): (stat.S_IMODE(path.lstat().st_mode),
            os.readlink(path) if path.is_symlink() else None if path.is_dir() else path.read_bytes())
            for path in root.rglob('*')}


@pytest.mark.parametrize('field', ['sha256', 'size', 'mode', 'compatible', 'mode-name', 'rollback', 'archive'])
def test_reverse_requires_forward_receipt_to_match_completed_journal(tree, field):
    tree.run('forward')
    path = tree.journal / 'forward-receipt.json'
    receipt = json.loads(path.read_text())
    if field in ('sha256', 'size', 'mode'):
        receipt['files']['feed.json']['source'][field] = {'sha256': '0' * 64, 'size': 1, 'mode': 0o400}[field]
    elif field == 'compatible':
        receipt['files']['feed.json']['compatible'] = False
    elif field == 'mode-name':
        receipt['mode'] = 'reverse'
    else:
        receipt[field] = str(tree.journal / 'incorrect')
    path.write_text(json.dumps(receipt))
    (tree.journal / 'transfer.lock').unlink()
    before = artifact_tree(tree.legacy.parent)
    with pytest.raises(transfer.TransferError):
        tree.run('reverse', compatible=list(transfer.FAMILIES))
    assert artifact_tree(tree.legacy.parent) == before


@pytest.mark.parametrize('mode', ['forward', 'reverse'])
@pytest.mark.parametrize('artifact', ['stage', 'rollback', 'archive', 'journal-tmp', 'receipt-tmp', 'publication', 'staged-copy'])
def test_preflights_existing_transaction_artifacts_before_any_write(tree, mode, artifact):
    if mode == 'reverse':
        tree.run('forward')
        (tree.journal / 'transfer.lock').unlink()
    if artifact in ('stage', 'rollback', 'archive'):
        path = tree.journal / (mode + '-' + artifact)
        path.mkdir(mode=0o755)
    elif artifact.endswith('-tmp'):
        path = tree.journal / (mode + '-' + artifact.removesuffix('-tmp') + '.json.tmp')
        path.symlink_to(tree.legacy / 'feed.json')
    elif artifact == 'publication':
        destination = tree.primary if mode == 'forward' else tree.legacy
        path = destination / '.transfer-feed.json'
        path.write_bytes(b'Unexpected publication')
        path.chmod(0o600)
    else:
        folder = tree.journal / (mode + '-stage')
        folder.mkdir(mode=0o700)
        path = folder / 'feed.json'
        path.write_bytes(b'Unexpected stage')
        path.chmod(0o600)
    before = artifact_tree(tree.legacy.parent)
    with pytest.raises(transfer.TransferError):
        tree.run(mode, **({'compatible': list(transfer.FAMILIES)} if mode == 'reverse' else {}))
    assert artifact_tree(tree.legacy.parent) == before


def test_missing_forward_receipt_refuses_reverse_before_creating_a_lock(tree):
    before = artifact_tree(tree.legacy.parent)
    with pytest.raises(transfer.TransferError, match='forward receipt'):
        tree.run('reverse')
    assert artifact_tree(tree.legacy.parent) == before


@pytest.mark.parametrize('kind', ['missing', 'incomplete', 'different-files'])
def test_reverse_requires_a_completed_matching_forward_journal_before_writes(tree, kind):
    tree.run('forward')
    path = tree.journal / 'forward-journal.json'
    if kind == 'missing':
        path.unlink()
    else:
        journal = json.loads(path.read_text())
        if kind == 'incomplete':
            journal['step'] = 'staged'
        else:
            journal['files']['feed.json']['source']['sha256'] = '0' * 64
        path.write_text(json.dumps(journal))
    (tree.journal / 'transfer.lock').unlink()
    before = artifact_tree(tree.legacy.parent)
    with pytest.raises(transfer.TransferError):
        tree.run('reverse', compatible=list(transfer.FAMILIES))
    assert artifact_tree(tree.legacy.parent) == before


@pytest.mark.parametrize('mode', ['forward', 'reverse'])
@pytest.mark.parametrize('artifact', ['stage', 'rollback', 'archive', 'destination'])
def test_resume_preflights_all_retained_copies_before_updating_journals(tree, mode, artifact):
    if mode == 'reverse':
        tree.run('forward')

    def interrupt(step):
        if step == 'staged':
            raise RuntimeError('Invented interruption')

    with pytest.raises(RuntimeError):
        tree.run(mode, checkpoint=interrupt)
    folder = tree.primary if mode == 'forward' else tree.legacy
    if artifact != 'destination':
        folder = tree.journal / (mode + '-' + artifact)
    path = folder / 'feed.json'
    if path.exists():
        path.chmod(0o600)
    path.write_bytes(b'Unexpected retained bytes')
    path.chmod(0o600)
    (tree.journal / 'transfer.lock').unlink()
    before = artifact_tree(tree.legacy.parent)
    with pytest.raises(transfer.TransferError):
        tree.run(mode)
    assert artifact_tree(tree.legacy.parent) == before
