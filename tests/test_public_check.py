"""Synthetic publishing-guard tests; no real accounts, keys or vaults are read."""
import importlib.util
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
import zipfile

SCANNER = Path(__file__).resolve().parents[1] / 'scripts' / 'check-public.py'
spec = importlib.util.spec_from_file_location('notework_public_check', SCANNER)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


@contextmanager
def test_directory():
    # Default mkdir permissions preserve the Windows sandbox's inherited ACL.
    base = Path(os.environ.get('NOTEWORK_TEST_TMPDIR') or tempfile.gettempdir()).resolve(strict=True)
    folder = base / ('nw-publish-test-' + uuid.uuid4().hex)
    folder.mkdir()
    try:
        yield str(folder)
    finally:
        # Verify the exact generated child path before recursive cleanup.
        if folder.resolve().parent != base or not folder.name.startswith('nw-publish-test-'):
            raise ValueError('Unsafe temporary cleanup target')
        shutil.rmtree(folder)


class PublishingGuardTests(unittest.TestCase):
    def run_guard(self, root, *, archive=None):
        args = [sys.executable, str(SCANNER), '--root', str(root)]
        if archive:
            args += ['--zip', str(archive)]
        result = subprocess.run(args, capture_output=True, text=True, check=False)
        self.assertEqual(result.stderr, '')
        return result.returncode, json.loads(result.stdout), result.stdout

    def assert_rejected(self, content, rule, *, name='source.txt', encoding='utf-8'):
        with test_directory() as folder:
            p = Path(folder) / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding=encoding)
            code, report, output = self.run_guard(folder)
            self.assertEqual(code, 1)
            self.assertTrue(any(item['rule'] == rule for item in report['findings']))
            self.assertNotIn(content, output, 'Matched values must never be printed')
            self.assertNotIn(str(p), output, 'Reports must not expose absolute local paths')

    def test_known_key_patterns_reject_synthetic_long_values(self):
        cases = [
            ('openai-or-anthropic-key', 'sk-' + 'proj-' + 'SyntheticFixture0123456789ABCDEFGHIJKLMNOP'),
            ('openai-or-anthropic-key', 'sk-' + 'ant-api03-' + 'SyntheticFixture0123456789ABCDEFGHIJKLMNOP'),
            ('github-token', 'gh' + 'p_' + 'SyntheticFixture0123456789ABCDEFGHIJKLMNOP'),
            ('github-token', 'github_' + 'pat_' + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst'),
            ('aws-access-key', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'),
            ('google-api-key', 'AI' + 'za' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789'),
            ('jwt', 'ey' + 'Jabcdefghijklmno' + '.' + 'ABCDEFGHIJKLMNOPQRSTUV' + '.' + 'abcdefghijklmnopqrstuv'),
            ('private-key', '-----BEGIN ' + 'PRIVATE KEY-----'),
        ]
        for rule, value in cases:
            with self.subTest(rule=rule):
                self.assert_rejected(value, rule)

    def test_fixture_label_does_not_whitelist_long_prefixed_key(self):
        value = 'sk-' + 'fixtureLabelStillSecret' + '0123456789ABCDEFGHIJKLMNOPQRSTUV'
        self.assert_rejected(value, 'openai-or-anthropic-key')

    def test_unknown_high_entropy_credential_assignment(self):
        value = 'AbCDeF1234567890GhIJkLMnOpQRsTuVwX'
        self.assert_rejected('api' + '_key = "' + value + '"', 'high-entropy-credential-assignment')

    def test_short_explicit_fixture_values_are_allowed(self):
        with test_directory() as folder:
            (Path(folder) / 'test.mjs').write_text('const apiKey = "fixture-key"; const accessToken = "fixture-access";', encoding='utf-8')
            code, report, _ = self.run_guard(folder)
            self.assertEqual(code, 0)
            self.assertTrue(report['passed'])

    def test_forbidden_runtime_filenames_even_without_key_pattern(self):
        for name in ['.env', '.env.local', 'data.json', 'auth.json', '.credentials/account.txt', 'chatgpt.session', 'backup.pem', 'knowledge-index.json', 'knowledge-index.json.pending', 'knowledge-index.json.previous', 'knowledge-index-mobile.json', 'knowledge-index-mobile.json.pending', 'knowledge-index-mobile.json.previous', 'conversation-index.json']:
            with self.subTest(name=name):
                self.assert_rejected('synthetic private material', 'private-runtime-file', name=name)

    def test_private_machine_paths_are_rejected_for_any_windows_profile(self):
        # Fragments keep clearly synthetic test paths out of source scan findings.
        cases = [
            ('C:', '/', 'obsidian/private.md'),
            ('C:', chr(92), 'Users' + chr(92) + 'SyntheticFixtureUser' + chr(92) + 'private.txt'),
            ('D:', '/', 'Users/Synthetic Fixture User/private.md'),
            ('z:', '/', 'uSeRs/SyntheticFixtureUnicode_테스트/private.txt'),
            ('C:', '/', 'Users/SyntheticFixtureUser'),
        ]
        for drive, separator, suffix in cases:
            with self.subTest(drive=drive, separator=separator):
                self.assert_rejected(drive + separator + suffix, 'private-local-path')

    def test_nonprofile_windows_paths_and_generic_user_words_are_allowed(self):
        for content in ['Users/SyntheticFixtureUser/private.txt', 'C:' + '/UsersManual/reference.md',
                        'D:' + '/public-docs/guide.md', 'Use the Users folder in documentation.']:
            with test_directory() as folder:
                (Path(folder) / 'source.txt').write_text(content, encoding='utf-8')
                code, report, _ = self.run_guard(folder)
                self.assertEqual(code, 0)
                self.assertTrue(report['passed'])

    def test_profile_path_inside_utf16_and_zip_is_rejected_without_printing_it(self):
        value = 'E:' + '/Users/SyntheticFixtureArchiveUser/private.txt'
        self.assert_rejected(value, 'private-local-path', encoding='utf-16')
        with test_directory() as folder:
            archive = Path(folder) / 'public.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('source.txt', value)
            code, report, output = self.run_guard(folder, archive=archive)
            self.assertEqual(code, 1)
            self.assertTrue(any(x['rule'] == 'private-local-path' for x in report['findings']))
            self.assertNotIn(value, output)

    def test_private_profile_archive_entry_name_is_redacted(self):
        value = 'F:' + '/Users/SyntheticFixtureArchiveOwner/private.txt'
        with test_directory() as folder:
            archive = Path(folder) / 'public.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr(value, 'synthetic safe text')
            code, report, output = self.run_guard(folder, archive=archive)
            self.assertEqual(code, 1)
            self.assertTrue(any(x['rule'] == 'unsafe-relative-path' for x in report['findings']))
            self.assertEqual({x['file'] for x in report['findings']}, {'<redacted-filename>'})
            self.assertNotIn('SyntheticFixtureArchiveOwner', output)

    def test_utf16_secret_is_rejected(self):
        value = 'sk-' + 'SyntheticFixture0123456789ABCDEFGHIJKLMNOP'
        self.assert_rejected(value, 'openai-or-anthropic-key', encoding='utf-16')

    def test_zip_checks_entry_content_and_private_filename(self):
        with test_directory() as folder:
            archive = Path(folder) / 'public.zip'
            value = 'gh' + 'p_' + 'SyntheticFixture0123456789ABCDEFGHIJKLMNOP'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('nested/source.js', value)
                z.writestr('plugin/data.json', '{}')
            code, report, output = self.run_guard(folder, archive=archive)
            self.assertEqual(code, 1)
            self.assertEqual({x['rule'] for x in report['findings']}, {'github-token', 'private-runtime-file'})
            self.assertNotIn(value, output)

    def test_nested_zip_cannot_hide_secret(self):
        with test_directory() as folder:
            inner = io.BytesIO()
            with zipfile.ZipFile(inner, 'w') as z:
                z.writestr('hidden.js', 'sk-' + 'SyntheticFixture0123456789ABCDEFGHIJKLMNOP')
            archive = Path(folder) / 'outer.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('nested.zip', inner.getvalue())
            code, report, _ = self.run_guard(folder, archive=archive)
            self.assertEqual(code, 1)
            self.assertTrue(any(x['rule'] == 'openai-or-anthropic-key' for x in report['findings']))

    def test_archive_traversal_is_rejected(self):
        with test_directory() as folder:
            archive = Path(folder) / 'public.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('../outside.txt', 'safe content')
            code, report, _ = self.run_guard(folder, archive=archive)
            self.assertEqual(code, 1)
            self.assertTrue(any(x['rule'] == 'unsafe-relative-path' for x in report['findings']))

    def test_index_reads_staged_blob_instead_of_clean_disk_copy(self):
        value = ('sk-' + 'SyntheticFixture0123456789ABCDEFGHIJKLMNOP').encode()
        oid = 'a' * 40
        calls = []
        def fake_git(root, args):
            calls.append(args)
            if args == ['ls-files', '--stage', '-z']:
                return ('100644 ' + oid + ' 0\tsource.mjs\0').encode()
            if args == ['cat-file', '-s', oid]:
                return str(len(value)).encode()
            if args == ['cat-file', 'blob', oid]:
                return value
            self.fail('Unexpected git request')
        with test_directory() as folder:
            (Path(folder) / 'source.mjs').write_text('safe disk file', encoding='utf-8')
            inspection = guard.Inspection()
            with patch.object(guard, 'git', fake_git):
                inspection.index(Path(folder))
            self.assertTrue(any(x['rule'] == 'openai-or-anthropic-key' for x in inspection.findings))
            self.assertEqual(len(calls), 3)

    def test_empty_scope_fails_closed(self):
        with test_directory() as folder:
            code, report, _ = self.run_guard(folder)
            self.assertEqual(code, 2)
            self.assertFalse(report['passed'])

    def test_uninspectable_zip_fails_closed(self):
        with test_directory() as folder:
            archive = Path(folder) / 'broken.zip'
            archive.write_text('not an archive', encoding='utf-8')
            code, report, _ = self.run_guard(folder, archive=archive)
            self.assertEqual(code, 2)
            self.assertFalse(report['passed'])


if __name__ == '__main__':
    unittest.main()
