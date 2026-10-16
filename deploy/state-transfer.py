#!/usr/bin/env python3
"""Stopped-writer, opaque state-family copy with durable resume and rollback copies."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

FAMILIES = {
    'feed': ('feed.json',),
    'tasks': ('tasks.json', 'task-events.jsonl', 'task-event-totals.json', 'task-events.jsonl.retention',
              'task-admissions.json', 'tasks-quiet.json'),
    'lineage': ('lineage.json', 'hermes-chat-moves.json', 'lineage-quiet.json', 'lineage-quiet-save.json'),
    'voice': ('voice.json',),
    'schedule-ideas': ('schedule-ideas.json',),
    'paseo-client-id': ('paseo-client-id',),
    'hermes-sign-in': ('hermes-credentials.json',),
}
FORBIDDEN = ('devices.json', 'push.json', 'pairing', 'cookies', 'bridge-token', '.wayroost-role',
             'bridge-maintenance.json', 'bridge-admin', 'pair.sock')
UNIT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}\.service\Z')


class TransferError(Exception):
    pass


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def safe_file(path, private=True):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (private and info.st_mode & 0o7077):
        raise TransferError('Store must be a private regular file with one link.')
    return info


def metadata(path):
    """Hash binary chunks; never decode or interpret a store."""
    try:
        before = safe_file(path)
    except FileNotFoundError:
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise TransferError('Store changed during inspection.')
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
        after = os.fstat(fd)
        current = os.lstat(path)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if identity(before) != identity(after) or identity(before) != identity(current) or size != before.st_size:
            raise TransferError('Store changed during inspection.')
        return {'path': str(path), 'sha256': digest.hexdigest(), 'size': size, 'mode': stat.S_IMODE(before.st_mode)}
    finally:
        os.close(fd)


def same_bytes(first, second):
    return first is None and second is None or first is not None and second is not None and all(first[key] == second[key] for key in ('sha256', 'size', 'mode'))


def check_copy(path, expected, owner):
    actual = metadata(path)
    if not same_bytes(actual, expected):
        raise TransferError('Hash, size or mode verification failed.')
    if expected is not None:
        info = os.lstat(path)
        if (info.st_uid, info.st_gid) != owner:
            raise TransferError('Ownership verification failed.')


def opaque_copy(source, destination, expected, owner):
    if os.path.lexists(destination):
        check_copy(destination, expected, owner)
        return
    temporary = destination.with_name(destination.name + '.tmp')
    # A killed copy may leave only this uncommitted temporary file.
    try:
        safe_file(temporary)
        temporary.unlink()
    except FileNotFoundError:
        pass
    input_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    output_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        if not same_bytes(metadata(source), expected):
            raise TransferError('Source changed before copy.')
        remaining = expected['size']
        while remaining:
            try:
                copied = os.copy_file_range(input_fd, output_fd, min(remaining, 1024 * 1024))
            except OSError as error:
                if error.errno not in (errno.EXDEV, errno.ENOSYS, errno.EOPNOTSUPP):
                    raise
                chunk = os.read(input_fd, min(remaining, 1024 * 1024))
                copied = len(chunk)
                offset = 0
                while offset < copied:
                    offset += os.write(output_fd, chunk[offset:])
            if not copied:
                raise TransferError('Incomplete opaque copy.')
            remaining -= copied
        os.fchown(output_fd, *owner)
        os.fchmod(output_fd, expected['mode'])
        os.fsync(output_fd)
    finally:
        os.close(input_fd)
        os.close(output_fd)
    check_copy(temporary, expected, owner)
    if not same_bytes(metadata(source), expected):
        raise TransferError('Source changed while copying.')
    os.replace(temporary, destination)
    sync_directory(destination.parent)


def canonical(path):
    text = str(path)
    if not text.startswith('/') or text != os.path.normpath(text) or any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise TransferError('Use canonical absolute physical paths.')
    return Path(text)


def trusted_parents(path, private_parent=False):
    for index, parent in enumerate(path.parents):
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise TransferError('Parents must be root-owned directories without symlinks or writable grants.')
        if index == 0 and private_parent and stat.S_IMODE(info.st_mode) != 0o700:
            raise TransferError('The physical state parent must be private to root.')


def state_directory(path):
    trusted_parents(path, True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
        raise TransferError('State directory must already exist and be private, without symlinks.')
    for directory in (path, *path.parents):
        marker = directory / '.wayroost-role'
        try:
            marker_info = safe_file(marker)
        except FileNotFoundError:
            continue
        if marker_info.st_size > 8:
            raise TransferError('Invalid state role marker.')
        fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            role = os.read(fd, 9)
        finally:
            os.close(fd)
        if role != b'primary\n':
            raise TransferError('State role must be primary; shadow and invalid markers are refused.')
    # An unclaimed empty primary tree is valid. Its application creates its own marker.
    # Older legacy state may also predate markers.
    return info.st_uid, info.st_gid


def stopped_units(units, runner):
    if not units or len(set(units)) != len(units) or any(not UNIT.fullmatch(unit) for unit in units):
        raise TransferError('Name every writer with --stopped-unit UNIT.')
    for unit in units:
        loaded = runner(['/usr/bin/systemctl', 'show', '-p', 'LoadState', '--value', unit], capture_output=True, text=True, check=False)
        if loaded.returncode != 0 or loaded.stdout.strip() != 'loaded':
            raise TransferError('Writer unit must be loaded: ' + unit)
        result = runner(['/usr/bin/systemctl', 'is-active', unit], capture_output=True, text=True, check=False)
        if result.returncode != 3 or result.stdout.strip() not in ('inactive', 'failed'):
            raise TransferError('Writer is active or stopped state is unproved: ' + unit)


def private_directory(path):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise TransferError('Journal storage must be root-owned and private, without symlinks.')


def save_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    try:
        safe_file(temporary)
        temporary.unlink()
    except FileNotFoundError:
        pass
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        data = (json.dumps(value, sort_keys=True) + '\n').encode('ascii')
        offset = 0
        while offset < len(data):
            offset += os.write(fd, data[offset:])
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    sync_directory(path.parent)


def load_json(path):
    info = safe_file(path)
    if info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 1024 * 1024:
        raise TransferError('Unsafe journal or receipt.')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, 'r', encoding='ascii') as source:
            return json.load(source)
    except (ValueError, UnicodeError):
        raise TransferError('Invalid journal or receipt.') from None



def validate_manifest(value, names, source, destination):
    if not isinstance(value, dict) or not isinstance(value.get('files'), dict) or set(value['files']) != set(names):
        raise TransferError('Invalid allowlisted journal manifest.')
    for name, entry in value['files'].items():
        if not isinstance(entry, dict) or set(entry) != {'source', 'original', 'compatible'} or type(entry['compatible']) is not bool:
            raise TransferError('Invalid journal file metadata.')
        for key, directory in (('source', source), ('original', destination)):
            item = entry[key]
            if item is None:
                continue
            if not isinstance(item, dict) or set(item) != {'path', 'sha256', 'size', 'mode'} or item['path'] != str(directory / name) or not isinstance(item['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256']) or type(item['size']) is not int or item['size'] < 0 or type(item['mode']) is not int or not 0 <= item['mode'] <= 0o7777 or item['mode'] & 0o7077:
                raise TransferError('Invalid journal file metadata.')


def matching_receipt(mode, names, legacy, primary, root, selected, complete=False):
    receipt_path, journal_path = [root / (mode + suffix) for suffix in ('-receipt.json', '-journal.json')]
    if not os.path.lexists(receipt_path):
        raise TransferError('Reverse requires the completed forward receipt.' if mode == 'forward'
                            else 'Verification requires the completed reverse receipt.')
    if not os.path.lexists(journal_path):
        raise TransferError('Receipt requires its recorded transaction journal.')
    receipt, journal = load_json(receipt_path), load_json(journal_path)
    source, destination = (legacy, primary) if mode == 'forward' else (primary, legacy)
    validate_manifest(receipt, names, source, destination)
    validate_manifest(journal, names, source, destination)
    identity = {'mode': mode, 'legacy': str(legacy), 'primary': str(primary), 'families': list(selected)}
    archived = journal.get('archived')
    choices = journal.get('compatible')
    if not isinstance(archived, list) or not isinstance(choices, list) or any(family not in selected for family in choices):
        raise TransferError('Invalid journal compatibility metadata.')
    expected_archived = [family for family in selected if mode == 'reverse' and family not in choices]
    if archived != expected_archived or ('tasks' in choices) != ('lineage' in choices):
        raise TransferError('Invalid journal compatibility metadata.')
    if any(entry['compatible'] != (mode == 'forward' or family in choices)
           for family in selected for name in FAMILIES[family] for entry in [journal['files'][name]]):
        raise TransferError('Invalid journal compatibility metadata.')
    expected = {**identity, 'files': journal['files'], 'archived': archived,
                'rollback': str(root / (mode + '-rollback')), 'archive': str(root / (mode + '-archive'))}
    if any(journal.get(key) != value for key, value in identity.items()) or receipt != expected:
        raise TransferError('Receipt does not match ' + mode + ' journal.')
    if complete and journal.get('step') != 'complete':
        raise TransferError('Reverse requires the completed forward transaction.')
    return receipt


def verify_reverse_receipt(names, legacy, primary, root, selected, owners):
    receipt = matching_receipt('reverse', names, legacy, primary, root, selected)
    archived = []
    for family in selected:
        choices = {receipt['files'][name]['compatible'] for name in FAMILIES[family]}
        if len(choices) != 1:
            raise TransferError('Invalid receipt compatibility metadata.')
        if False in choices:
            archived.append(family)
    if receipt.get('archived') != archived or ('tasks' in archived) != ('lineage' in archived):
        raise TransferError('Invalid receipt compatibility metadata.')
    archive, rollback = root / 'reverse-archive', root / 'reverse-rollback'
    if receipt.get('archive') != str(archive) or receipt.get('rollback') != str(rollback):
        raise TransferError('Invalid receipt storage paths.')
    private_directory(archive)
    private_directory(rollback)
    for name, entry in receipt['files'].items():
        check_copy(primary / name, entry['source'], owners[str(primary)])
        check_copy(legacy / name, entry['source'] if entry['compatible'] else entry['original'], owners[str(legacy)])
        check_copy(rollback / name, entry['original'], owners[str(legacy)])
        if not entry['compatible']:
            check_copy(archive / name, entry['source'], owners[str(primary)])


def transfer(mode, legacy, primary, journal_dir, units, families=None, compatible=(), runner=subprocess.run, uid=None, checkpoint=lambda step: None):
    if (os.geteuid() if uid is None else uid) != 0:
        raise TransferError('State transfer must run as root.')
    if mode not in ('plan', 'forward', 'verify', 'reverse'):
        raise TransferError('Unknown transfer mode.')
    selected = tuple(FAMILIES if families is None else families)
    if not selected or len(set(selected)) != len(selected) or any(name not in FAMILIES for name in selected):
        raise TransferError('Only fixed allowlisted families can transfer; pairing, push, cookies, tokens and markers never transfer.')
    if any(name not in selected for name in compatible):
        raise TransferError('Compatibility must name a selected allowlisted family.')
    if mode != 'reverse' and compatible:
        raise TransferError('Compatibility choices are only valid for reverse.')
    if ('tasks' in compatible) != ('lineage' in compatible):
        raise TransferError('Tasks and lineage compatibility must be confirmed together.')
    if ('tasks' in selected) != ('lineage' in selected):
        raise TransferError('Tasks and lineage must transfer in the same transaction.')
    stopped_units(units, runner)
    legacy, primary, journal_dir = map(canonical, (legacy, primary, journal_dir))
    roots = (legacy, primary, journal_dir)
    if any(first == second or first in second.parents or second in first.parents for index, first in enumerate(roots) for second in roots[index + 1:]):
        raise TransferError('State and journal roots must be separate.')
    owners = {str(legacy): state_directory(legacy), str(primary): state_directory(primary)}
    trusted_parents(journal_dir)
    private_directory(journal_dir)
    if mode == 'plan':
        return run_transfer(mode, legacy, primary, journal_dir, units, selected, set(compatible), owners, runner, checkpoint)
    if mode != 'verify':
        prepare_transfer(mode, legacy, primary, journal_dir, selected, set(compatible), owners)
    lock_path = journal_dir / 'transfer.lock'
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW | (0 if mode == 'verify' else os.O_CREAT), 0o600)
    try:
        info = os.fstat(lock_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
            raise TransferError('Unsafe transfer lock.')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TransferError('Another transfer holds the journal lock.') from None
        return run_transfer(mode, legacy, primary, journal_dir, units, selected, set(compatible), owners, runner, checkpoint)
    finally:
        os.close(lock_fd)


def prepare_transfer(mode, legacy, primary, root, selected, compatible, owners):
    lock = root / 'transfer.lock'
    if os.path.lexists(lock):
        info = safe_file(lock)
        if info.st_uid != 0:
            raise TransferError('Unsafe transfer lock.')
    forward_receipt = root / 'forward-receipt.json'
    if mode == 'reverse' and not os.path.lexists(forward_receipt):
        raise TransferError('Reverse requires the completed forward receipt.')
    source, destination = (primary, legacy) if mode == 'reverse' else (legacy, primary)
    names = [name for family in selected for name in FAMILIES[family]]
    records = {name: metadata(source / name) for name in names}
    for name, record in records.items():
        check_copy(source / name, record, owners[str(source)])
    if mode == 'plan':
        return {'result': {'mode': mode, 'files': records}}
    if mode == 'verify':
        reverse_receipt = root / 'reverse-receipt.json'
        if os.path.lexists(root / 'reverse-journal.json') or os.path.lexists(reverse_receipt):
            verify_reverse_receipt(names, legacy, primary, root, selected, owners)
            return {'result': {'mode': mode, 'verified': True}}
        matching_receipt('forward', names, legacy, primary, root, selected, complete=True)
        for name in names:
            check_copy(destination / name, records[name], owners[str(destination)])
        return {'result': {'mode': mode, 'verified': True}}
    if mode == 'reverse':
        matching_receipt('forward', names, legacy, primary, root, selected, complete=True)
    journal_path = root / (mode + '-journal.json')
    identity = {'mode': mode, 'legacy': str(legacy), 'primary': str(primary), 'families': list(selected)}
    if os.path.lexists(journal_path):
        journal = load_json(journal_path)
        validate_manifest(journal, names, source, destination)
        if any(journal.get(key) != value for key, value in identity.items()):
            raise TransferError('Journal belongs to different paths or families.')
        expected_archived = [family for family in selected if mode == 'reverse' and family not in compatible]
        if journal.get('archived') != expected_archived or any(entry['compatible'] != (mode == 'forward' or family in compatible) for family in selected for name in FAMILIES[family] for entry in [journal['files'][name]]):
            raise TransferError('Invalid journal compatibility metadata.')
        if journal.get('compatible') != sorted(compatible):
            raise TransferError('Resume must keep the original compatibility choices.')
        for name, entry in journal['files'].items():
            if not same_bytes(records[name], entry['source']):
                raise TransferError('Source changed since preparation; resume refused.')
        # Never replace a completed transaction with a fresh snapshot.
        if journal.get('step') == 'complete':
            if mode == 'reverse':
                verify_reverse_receipt(names, legacy, primary, root, selected, owners)
            for name, entry in journal['files'].items():
                check_copy(destination / name, entry['source'] if entry['compatible'] else entry['original'], owners[str(destination)])
            if mode == 'forward':
                matching_receipt('forward', names, legacy, primary, root, selected, complete=True)
            return {'result': {'mode': mode, 'verified': True, 'archived': journal.get('archived', [])}}
    else:
        entries = {}
        for family in selected:
            for name in FAMILIES[family]:
                original = metadata(destination / name)
                check_copy(destination / name, original, owners[str(destination)])
                entries[name] = {'source': records[name], 'original': original, 'compatible': mode == 'forward' or family in compatible}
        journal = {**identity, 'compatible': sorted(compatible), 'step': 'prepared', 'files': entries, 'archived': [family for family in selected if mode == 'reverse' and family not in compatible]}
    preflight_artifacts(mode, names, legacy, primary, root, selected, owners, source, destination, journal)
    return {'journal': journal, 'new': not os.path.lexists(journal_path)}


def preflight_artifacts(mode, names, legacy, primary, root, selected, owners, source, destination, journal):
    """Validate every existing transaction and publication path without creating storage."""
    for suffix in ('-journal.json', '-receipt.json'):
        path = root / (mode + suffix)
        if os.path.lexists(path):
            load_json(path)
        temporary = path.with_name(path.name + '.tmp')
        if os.path.lexists(temporary):
            info = safe_file(temporary)
            if info.st_uid != 0:
                raise TransferError('Unsafe journal temporary file.')
    if os.path.lexists(root / (mode + '-receipt.json')):
        matching_receipt(mode, names, legacy, primary, root, selected)
    for suffix in ('-stage', '-rollback', '-archive'):
        folder = root / (mode + suffix)
        if os.path.lexists(folder):
            private_directory(folder)
        for name, entry in journal['files'].items():
            expected = entry['original'] if suffix == '-rollback' else entry['source']
            if suffix == '-archive' and entry['compatible']:
                expected = None
            owner = owners[str(source)] if suffix == '-archive' else owners[str(destination)]
            path = folder / name
            if os.path.lexists(path) or expected is None:
                check_copy(path, expected, owner)
            temporary = path.with_name(path.name + '.tmp')
            if os.path.lexists(temporary):
                safe_file(temporary)
    rollback = root / (mode + '-rollback')
    for name, entry in journal['files'].items():
        actual = metadata(destination / name)
        original, current = entry['original'], entry['source']
        if not same_bytes(actual, original) and not (entry['compatible'] and same_bytes(actual, current)):
            raise TransferError('Destination changed outside the transaction.')
        check_copy(destination / name, actual, owners[str(destination)])
        # Published destinations must already have a retained original to resume safely.
        if original is not None and not os.path.lexists(rollback / name) and not same_bytes(actual, original):
            raise TransferError('Missing destination rollback copy.')
        publication = destination / ('.transfer-' + name)
        if os.path.lexists(publication):
            check_copy(publication, current if entry['compatible'] else None, owners[str(destination)])
        temporary = publication.with_name(publication.name + '.tmp')
        if os.path.lexists(temporary):
            safe_file(temporary)


def run_transfer(mode, legacy, primary, root, units, selected, compatible, owners, runner, checkpoint):
    prepared = prepare_transfer(mode, legacy, primary, root, selected, compatible, owners)
    if 'result' in prepared:
        return prepared['result']
    journal = prepared['journal']
    journal_path = root / (mode + '-journal.json')
    source, destination = (primary, legacy) if mode == 'reverse' else (legacy, primary)
    identity = {'mode': mode, 'legacy': str(legacy), 'primary': str(primary), 'families': list(selected)}
    if prepared['new']:
        save_json(journal_path, journal)
        checkpoint('prepared')
    # Every file is staged and every destination original saved before any publication.
    for folder_name in (mode + '-stage', mode + '-rollback', mode + '-archive'):
        folder = root / folder_name
        if not os.path.lexists(folder):
            folder.mkdir(mode=0o700)
            sync_directory(root)
        private_directory(folder)
    stage, rollback, archive = [root / (mode + suffix) for suffix in ('-stage', '-rollback', '-archive')]
    for name, entry in journal['files'].items():
        if entry['source'] is not None:
            opaque_copy(source / name, stage / name, entry['source'], owners[str(destination)])
        checkpoint('stage:' + name)
        if entry['original'] is not None:
            # On resume this copy already exists if a destination has been published.
            opaque_copy(destination / name, rollback / name, entry['original'], owners[str(destination)])
        checkpoint('rollback:' + name)
        if not entry['compatible'] and entry['source'] is not None:
            opaque_copy(source / name, archive / name, entry['source'], owners[str(source)])
        checkpoint('archive:' + name)
    journal['step'] = 'staged'
    save_json(journal_path, journal)
    checkpoint('staged')
    stopped_units(units, runner)
    for name, entry in journal['files'].items():
        path = destination / name
        if not entry['compatible']:
            continue
        actual = metadata(path)
        # A write-ahead publication can be resumed whether or not rename happened.
        if not same_bytes(actual, entry['original']) and not same_bytes(actual, entry['source']):
            raise TransferError('Destination changed outside the transaction.')
        journal['step'] = 'publish:' + name
        save_json(journal_path, journal)
        checkpoint('before-publish:' + name)
        if entry['source'] is None:
            if actual is not None:
                path.unlink()
                sync_directory(destination)
        elif not same_bytes(actual, entry['source']):
            # Retain the staged copy so a killed rename remains repeatable.
            publication = destination / ('.transfer-' + name)
            opaque_copy(stage / name, publication, entry['source'], owners[str(destination)])
            os.replace(publication, path)
            sync_directory(destination)
        check_copy(path, entry['source'], owners[str(destination)])
        checkpoint('published:' + name)
    for name, entry in journal['files'].items():
        check_copy(destination / name, entry['source'] if entry['compatible'] else entry['original'], owners[str(destination)])
    receipt = {**identity, 'files': journal['files'], 'archived': journal['archived'], 'rollback': str(rollback), 'archive': str(archive)}
    save_json(root / (mode + '-receipt.json'), receipt)
    checkpoint('receipted')
    journal['step'] = 'complete'
    save_json(journal_path, journal)
    checkpoint('complete')
    return {'mode': mode, 'verified': True, 'archived': journal['archived']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('plan', 'forward', 'verify', 'reverse'))
    parser.add_argument('--legacy-dir', required=True)
    parser.add_argument('--primary-dir', required=True)
    parser.add_argument('--journal-dir', required=True)
    parser.add_argument('--stopped-unit', action='append', required=True)
    parser.add_argument('--family', action='append')
    parser.add_argument('--compatible', action='append', default=[], help='Reverse only: operator-confirmed legacy-compatible family; others are archived.')
    args = parser.parse_args(argv)
    try:
        result = transfer(args.mode, args.legacy_dir, args.primary_dir, args.journal_dir, args.stopped_unit, args.family, args.compatible)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (TransferError, OSError):
        # Kernel/decoder errors can contain untrusted data; only our fixed messages leave here.
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, TransferError) else 'State transfer I/O failed; keep writers stopped and resume.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
