import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('agents', Path(__file__).resolve().parents[1] / 'support/agents.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class AgentTests(unittest.TestCase):
    def test_parallel_tools_and_deny(self):
        s = {'phase': 'busy', 'tools': []}
        a.transition(s, 'PreToolUse', {'tool_use_id': 'one'}, False)
        a.transition(s, 'PreToolUse', {'tool_use_id': 'two'}, False)
        deny = a.transition(s, 'PreToolUse', {'tool_use_id': 'three'}, True)
        self.assertEqual(deny['hookSpecificOutput']['permissionDecision'], 'deny')
        out = a.transition(s, 'PostToolUse', {'tool_use_id': 'one'}, True)
        self.assertFalse(out['continue'])
        a.transition(s, 'Stop', {}, True)
        self.assertEqual(s['tools'], ['two'])  # Stop isn't proof a background tool ended.
        a.transition(s, 'PostToolUse', {'tool_use_id': 'two'}, True)
        self.assertEqual(s['tools'], [])

    def test_unknown_tool_never_becomes_safe(self):
        s = {'phase': 'idle'}
        a.transition(s, 'PreToolUse', {}, False)
        self.assertEqual(s['phase'], 'unknown')
        a.transition(s, 'PostToolUse', {}, False)
        self.assertEqual(s['phase'], 'unknown')
        a.transition(s, 'Stop', {}, True)
        self.assertIn('unknown', s['tools'])

    def test_codex_preserves_completed_tool_result(self):
        s = {'kind': 'codex', 'phase': 'busy', 'tools': ['one']}
        output = a.transition(s, 'PostToolUse', {'tool_use_id': 'one'}, True)
        self.assertIsNone(output)
        self.assertEqual(s['phase'], 'safe')

    def test_background_work_blocks_safe_stop(self):
        s = {'kind': 'claude', 'phase': 'busy', 'tools': ['one']}
        a.transition(s, 'PostToolUse', {'tool_use_id': 'one', 'tool_response': {'status': 'async_launched'}}, True)
        self.assertTrue(s['background'])
        a.transition(s, 'Stop', {'background_tasks': [{'id': 'running'}]}, True)
        self.assertEqual(s['phase'], 'background')
        a.transition(s, 'Notification', {'notification_type': 'idle_prompt'}, True)
        self.assertEqual(s['phase'], 'background')
        a.transition(s, 'Stop', {'background_tasks': [], 'session_crons': []}, True)
        self.assertEqual(s['phase'], 'idle')
        self.assertFalse(s['background'])

    def test_session_end_retains_resumable_identity(self):
        s = {'kind': 'codex', 'phase': 'idle', 'tools': [], 'sessionId': 'exact'}
        a.transition(s, 'SessionEnd', {}, False)
        self.assertEqual(s['phase'], 'ended')
        self.assertEqual(s['sessionId'], 'exact')
        s['tools'] = ['still-running']
        a.transition(s, 'SessionEnd', {}, True)
        self.assertEqual(s['phase'], 'unknown')

    def test_logical_end_ack_can_close_an_idle_client(self):
        with tempfile.TemporaryDirectory() as tmp:
            a.HOME = Path(tmp)
            a.NATIVE = a.HOME / 'native'
            child = subprocess.Popen(['sleep', '30'])
            try:
                item = dict(id='ended', pid=child.pid, identity=a.identity(child.pid), sessionId='s', kind='codex')
                state = dict(item, phase='ended', tools=[], updatedAt=0, sessionFile='/test')
                a.write(a.NATIVE / ('%s.json' % child.pid), state)
                ackpath = a.HOME / 'acks' / ('%s.json' % child.pid)
                a.write(ackpath, dict(state, itemId='other'))
                self.assertTrue(a.poll(item)['pending'])
                a.write(ackpath, dict(state, itemId=item['id']))
                self.assertTrue(a.poll(item)['done'])
                self.assertIsNone(child.poll())  # Logical end is verified without assuming process death.
                state['tools'] = ['running']
                a.write(a.NATIVE / ('%s.json' % child.pid), state)
                self.assertTrue(a.poll(item)['pending'])
            finally:
                child.terminate()
                child.wait()

    def test_install_preserves_other_settings_and_hooks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            config = home / '.claude/settings.json'
            config.parent.mkdir()
            old = {'model': 'unchanged', 'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'keep-this-hook'}]}]}}
            config.write_text(json.dumps(old))
            env = dict(os.environ, HOME=tmp, ONETERM_HOME=str(home / '.oneterm'))
            cmd = [os.sys.executable, str(Path(a.__file__)), '--install']
            subprocess.run(cmd, env=env, check=True, capture_output=True)
            data = json.loads(config.read_text())
            self.assertEqual(data['model'], old['model'])
            self.assertEqual(data['hooks']['Stop'][0], old['hooks']['Stop'][0])
            first = config.read_bytes()
            subprocess.run(cmd, env=env, check=True, capture_output=True)
            self.assertEqual(config.read_bytes(), first)
            codex = json.loads((home / '.codex/hooks.json').read_text())
            self.assertEqual(codex['hooks']['Interrupt'][0]['hooks'][0]['timeout'], 3)

    def test_ssh_matches_connection_not_recent_session(self):
        one = dict(pid=11, ppid=1, pgid=11, tpgid=11, tty='pts/1', args='codex')
        two = dict(pid=22, ppid=1, pgid=22, tpgid=22, tty='pts/2', args='claude')
        live = [dict(pid=11, sessionId='one'), dict(pid=22, sessionId='two')]
        def connection(pid, _):
            return ['192.0.2.1', '111'] if pid == 11 else ['192.0.2.1', '222']
        with patch.object(a, 'processes', return_value={11: one, 22: two}), patch.object(a, 'live', return_value=live), patch.object(a, 'connection_of', side_effect=connection):
            self.assertEqual(a.probe(['192.0.2.1', '111'])['live']['sessionId'], 'one')
            self.assertEqual(a.probe(['192.0.2.1', '222'])['live']['sessionId'], 'two')
        with patch.object(a, 'processes', return_value={11: one, 22: two}), patch.object(a, 'connection_of', return_value=['same', 'port']):
            self.assertIn('multiplexing', a.probe(['same', 'port'])['skip'])

    def test_idle_resume_is_identified_from_its_own_argv(self):
        sid = '01a13b62-053c-7661-8a2e-b85711209bd8'
        with tempfile.TemporaryDirectory() as tmp:
            a.HOME = Path(tmp)
            a.NATIVE = a.HOME / 'native'
            transcript = Path(tmp) / 'codex/sessions/2026/10/14' / ('rollout-2026-10-14T13-07-22-%s.jsonl' % sid)
            transcript.parent.mkdir(parents=True)
            transcript.write_text('{}\n')
            p = dict(pid=os.getpid(), ppid=1, pgid=7, tpgid=7, tty='ttys9', args='/x/codex --no-daemon resume ' + sid)
            started = time.time() - 60
            os.utime(transcript, (started + 2, started + 2))
            with patch.object(a, 'codex_home', return_value=Path(tmp) / 'codex'), \
                    patch.object(a, 'elapsed', return_value=60), patch.object(a, 'cwd_of', return_value='/work'):
                found = a.resumed(p)
                self.assertEqual((found['sessionId'], found['cwd'], found['phase']), (sid, '/work', 'resumed'))
                # A turn wrote to the transcript after startup: not provably idle.
                os.utime(transcript, None)
                self.assertIsNone(a.resumed(p))
                os.utime(transcript, (started + 2, started + 2))
                for args in ['node /x/@openai/codex/bin/codex.js resume ' + sid, '/x/codex resume ' + sid + ' prompt',
                             '/x/codex resume --last', '/x/codex app-server proxy']:
                    self.assertIsNone(a.resumed(dict(p, args=args)), args)
                self.assertIsNone(a.resumed(dict(p, tty='??')))
                self.assertIsNone(a.resumed(dict(p, tpgid=8)))  # not the foreground job
                a.write(a.NATIVE / ('%s.json' % p['pid']), {'pid': p['pid']})
                self.assertIsNone(a.resumed(p))  # hooks own it once they register

    def test_owner_excludes_bridge_and_desktop(self):
        parent = os.getppid()
        base = dict(pid=parent, ppid=1, pgid=parent, tpgid=parent, tty='ttys999', args='claude')
        self.assertEqual(a.hook_owner('claude', {parent: base})['pid'], parent)
        for args in ['claude --print', 'claude --output-format stream-json', 'codex app-server']:
            p = dict(base, args=args)
            self.assertIsNone(a.hook_owner('claude' if args.startswith('claude') else 'codex', {parent: p}))
        pi = dict(base, pid=123, ppid=1, args='node /x/pi-coding-agent/dist/cli.js')
        self.assertIsNone(a.hook_owner('claude', {parent: dict(base, ppid=123), 123: pi}))
        self.assertIsNone(a.hook_owner('claude', {parent: dict(base, tty='??')}))

    def test_safe_stop_and_identity_protection(self):
        with tempfile.TemporaryDirectory() as tmp:
            a.HOME = Path(tmp)
            a.NATIVE = a.HOME / 'native'
            child = subprocess.Popen(['sleep', '30'])
            try:
                transcript = Path(tmp) / 'session.jsonl'
                transcript.write_text('{}\n')
                item = dict(id='test', pid=child.pid, identity=a.identity(child.pid), sessionId='test-session', kind='codex')
                state = dict(item, cwd=tmp, sessionFile=str(transcript), phase='busy', tools=['active'], updatedAt=time.time()-5)
                a.write(a.NATIVE / ('%s.json' % child.pid), state)
                a.request(item, 'test-group', 5000)
                self.assertTrue(a.poll(item)['pending'])
                self.assertIsNone(child.poll())
                state.update(phase='idle', tools=[])
                a.write(a.NATIVE / ('%s.json' % child.pid), state)
                self.assertTrue(a.poll(dict(item, identity='wrong'))['failed'])
                self.assertIsNone(child.poll())
                a.poll(item)
                self.assertEqual(child.wait(timeout=3), -15)
                done = a.poll(item)
                self.assertTrue(done['done'])
                self.assertEqual(done['ack']['sessionId'], 'test-session')
                a.cancel(item)
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait()

    def test_expired_request_does_not_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            a.HOME = Path(tmp)
            a.NATIVE = a.HOME / 'native'
            child = subprocess.Popen(['sleep', '30'])
            try:
                file = Path(tmp) / 's.jsonl'
                file.write_text('{}')
                item = dict(id='old', pid=child.pid, identity=a.identity(child.pid), sessionId='s', kind='claude')
                a.write(a.NATIVE / ('%s.json' % child.pid), dict(item, phase='idle', tools=[], cwd=tmp, sessionFile=str(file), updatedAt=0))
                a.request(item, 'g', -1)
                self.assertTrue(a.poll(item)['pending'])
                self.assertIsNone(child.poll())
            finally:
                child.terminate()
                child.wait()


if __name__ == '__main__':
    unittest.main()
