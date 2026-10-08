#!/usr/bin/env python3
"""Fail closed on common secrets and private runtime files before publishing.

Exit codes: 0 clean, 1 findings, 2 inspection failure. Reports contain only
relative file names, line numbers and rule IDs, never matched secret values.
Use --mode git-index before committing to inspect staged blobs, not disk copies.
This is a local publishing guard, not proof that every possible secret is absent.
"""
from __future__ import annotations

import argparse
from collections import Counter
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import zipfile

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
EXCLUDED_DIRS = {'.git', 'node_modules', 'dist', 'coverage', 'qa-output', '__pycache__'}
FORBIDDEN_FILES = {
    'data.json', 'auth.json', 'credentials.json', 'secrets.json', 'token.json',
    'tokens.json', 'session.json', 'sessions.json', 'accounts.json', '.credentials',
    '.netrc', '.npmrc', 'id_rsa', 'id_ed25519', 'private-plugin-before.json',
    'knowledge-index.json', 'knowledge-index.json.pending', 'knowledge-index.json.previous',
    'knowledge-index-mobile.json', 'knowledge-index-mobile.json.pending', 'knowledge-index-mobile.json.previous',
    'conversation-index.json',
}
FORBIDDEN_DIRS = {'.obsidian', '.credentials', '.ssh', 'backups', 'vault-contents'}
FORBIDDEN_SUFFIXES = {'.pem', '.p12', '.pfx', '.key', '.session', '.sqlite', '.sqlite3', '.db'}
RULES = [
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----')),
    ('openai-or-anthropic-key', re.compile(r'(?<![\w-])sk-(?:proj-|svcacct-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{20,}(?![\w-])')),
    ('github-token', re.compile(r'(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})(?!\w)')),
    ('aws-access-key', re.compile(r'(?<!\w)(?:AKIA|ASIA)[A-Z0-9]{16}(?!\w)')),
    ('google-api-key', re.compile(r'(?<!\w)AIza[0-9A-Za-z_-]{35}(?!\w)')),
    ('jwt', re.compile(r'(?<![\w-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![\w-])')),
    ('private-local-path', re.compile(r"(?i)[A-Z]:[/\\]+(?:obsidian(?:[/\\]|\b)|Users[/\\]+[^/\\\r\n\"'<>|:]+(?:[/\\]|\b))")),
]
ASSIGNMENT = re.compile(
    r'''(?i)(?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|[A-Z_]*(?:API_KEY|AUTH_TOKEN|SECRET_ACCESS_KEY))(?:["']?)\s*[:=]\s*["']([A-Za-z0-9_+/=-]{24,})["']'''
)


def entropy(value: str) -> float:
    return -sum((n / len(value)) * math.log2(n / len(value)) for n in Counter(value).values())


def safe_name(name: str) -> str:
    if any(pattern.search(name) for _, pattern in RULES):
        return '<redacted-filename>'
    return name.replace('\n', '<newline>').replace('\r', '<return>')


class Inspection:
    def __init__(self) -> None:
        self.findings: list[dict] = []
        self.files = 0
        self.total = 0

    def add(self, name: str, rule: str, line: int = 0) -> None:
        item = {'file': safe_name(name), 'line': line, 'rule': rule}
        if item not in self.findings:
            self.findings.append(item)

    def filename(self, name: str) -> None:
        parts = PurePosixPath(name.replace('\\', '/')).parts
        for part in parts:
            lower = part.lower()
            if (lower in FORBIDDEN_FILES or lower in FORBIDDEN_DIRS
                or lower.startswith('.env') or lower.startswith('delivery-manifest')
                or lower.startswith('package-delivery') or lower.startswith('credentials.')
                or Path(lower).suffix in FORBIDDEN_SUFFIXES):
                self.add(name, 'private-runtime-file')
                break
        if name.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:', name) or '..' in parts:
            self.add(name, 'unsafe-relative-path')

    def content(self, name: str, data: bytes, *, depth: int = 0) -> None:
        self.filename(name)
        self.files += 1
        self.total += len(data)
        if len(data) > MAX_FILE_BYTES or self.total > MAX_TOTAL_BYTES:
            raise ValueError('inspection-size-limit')
        if data[:4] == b'PK\x03\x04':
            if depth >= 2:
                raise ValueError('archive-depth-limit')
            self.archive(io.BytesIO(data), name + '!', depth=depth + 1)
            return
        if data.startswith((b'\xff\xfe', b'\xfe\xff')):
            text = data.decode('utf-16', errors='replace')
        elif data and data.count(b'\x00') / len(data) > 0.15:
            text = data.decode('utf-16-le', errors='replace')
        else:
            text = data.decode('utf-8', errors='replace')
        for rule, pattern in RULES:
            for match in pattern.finditer(text):
                self.add(name, rule, text.count('\n', 0, match.start()) + 1)
        for match in ASSIGNMENT.finditer(text):
            if entropy(match.group(1)) >= 3.8:
                self.add(name, 'high-entropy-credential-assignment', text.count('\n', 0, match.start()) + 1)

    def archive(self, source, prefix: str = '', *, depth: int = 0) -> None:
        with zipfile.ZipFile(source) as z:
            for info in z.infolist():
                self.filename(prefix + info.filename)
                if stat.S_ISLNK(info.external_attr >> 16):
                    self.add(prefix + info.filename, 'symlink-or-reparse-point')
                    continue
                if info.is_dir():
                    continue
                if info.flag_bits & 1 or info.file_size > MAX_FILE_BYTES:
                    raise ValueError('uninspectable-archive-entry')
                self.content(prefix + info.filename, z.read(info), depth=depth)

    def working(self, root: Path) -> None:
        for base, dirs, files in os.walk(root, followlinks=False):
            for name in list(dirs):
                p = Path(base) / name
                if name in EXCLUDED_DIRS:
                    dirs.remove(name)
                elif reparse(p):
                    self.add(p.relative_to(root).as_posix(), 'symlink-or-reparse-point')
                    dirs.remove(name)
                else:
                    self.filename(p.relative_to(root).as_posix())
            for name in files:
                p = Path(base) / name
                rel = p.relative_to(root).as_posix()
                if reparse(p):
                    self.add(rel, 'symlink-or-reparse-point')
                    continue
                if p.stat().st_size > MAX_FILE_BYTES:
                    raise ValueError('inspection-size-limit')
                self.content(rel, p.read_bytes())

    def index(self, root: Path) -> None:
        result = git(root, ['ls-files', '--stage', '-z'])
        for entry in result.split(b'\x00'):
            if not entry:
                continue
            header, raw_name = entry.split(b'\t', 1)
            mode, oid, stage = header.split(b' ')
            name = raw_name.decode('utf-8', errors='replace')
            self.filename(name)
            if stage != b'0':
                raise ValueError('unmerged-index-entry')
            if mode not in (b'100644', b'100755'):
                self.add(name, 'symlink-or-submodule')
                continue
            if not re.fullmatch(rb'[0-9a-f]{40,64}', oid):
                raise ValueError('invalid-object-id')
            size = int(git(root, ['cat-file', '-s', oid.decode('ascii')]))
            if size > MAX_FILE_BYTES:
                raise ValueError('inspection-size-limit')
            self.content(name, git(root, ['cat-file', 'blob', oid.decode('ascii')]))


def reparse(path: Path) -> bool:
    flags = getattr(path.lstat(), 'st_file_attributes', 0)
    return path.is_symlink() or bool(flags & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def git(root: Path, args: list[str]) -> bytes:
    result = subprocess.run(['git', '-C', str(root), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise ValueError('git-inspection-failed')
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('.'))
    parser.add_argument('--mode', choices=['working', 'git-index'], default='working')
    parser.add_argument('--zip', dest='archive', type=Path)
    args = parser.parse_args()
    inspection = Inspection()
    try:
        if args.archive:
            inspection.archive(args.archive)
        else:
            root = args.root.resolve(strict=True)
            if not root.is_dir():
                raise ValueError('root-is-not-a-directory')
            if args.mode == 'git-index':
                inspection.index(root)
            else:
                inspection.working(root)
        if inspection.files == 0:
            raise ValueError('empty-inspection-scope')
        print(json.dumps({'passed': not inspection.findings, 'filesScanned': inspection.files,
                          'findings': inspection.findings}, ensure_ascii=True))
        return 1 if inspection.findings else 0
    except Exception as error:
        print(json.dumps({'passed': False, 'inspectionError': type(error).__name__,
                          'message': 'Inspection could not finish; publishing must stop.'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
