#!/usr/bin/env python3
"""Lifecycle hooks and a small, stdin-only RPC for local/SSH agent control."""
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time

HOME = Path(os.environ.get('ONETERM_HOME', Path.home() / '.oneterm'))
NATIVE = HOME / 'native'
SHELLS = {'zsh', 'bash', 'fish', 'sh', 'dash', 'nu'}


def read(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + '.%s.tmp' % os.getpid())
    tmp.write_text(json.dumps(value))
    tmp.chmod(0o600)
    tmp.replace(path)


def processes():
    out = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,tpgid=,tty=,args='], text=True)
    result = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 5)
        if len(parts) == 6:
            pid, ppid, pgid, tpgid, tty, args = parts
            result[int(pid)] = dict(pid=int(pid), ppid=int(ppid), pgid=int(pgid), tpgid=int(tpgid), tty=tty, args=args)
    return result


def identity(pid):
    try:
        if sys.platform.startswith('linux'):
            fields = Path('/proc/%s/stat' % pid).read_text().rsplit(')', 1)[1].split()
            if fields[0] == 'Z':
                return None
            return fields[19]
        return subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='], text=True, stderr=subprocess.DEVNULL).strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def agent_name(args):
    # Native binaries or Node's launcher. Never mistake a prompt mentioning an agent for the executable.
    words = args.split()
    if not words:
        return None
    name = Path(words[0]).name
    if name in {'claude', 'claude.exe', 'codex'}:
        return 'claude' if name.startswith('claude') else 'codex'
    if name in {'node', 'bun'} and len(words) > 1:
        if '/pi-coding-agent/' in words[1]:
            return 'pi'
        if '/@openai/codex/' in words[1]:
            return 'codex'
    if name == 'pi':
        return 'pi'
    return None


def hook_owner(kind, procs):
    chain = []
    pid = os.getppid()
    while pid in procs:
        p = procs[pid]
        chain.append(p)
        pid = p['ppid']
    # Exclude pi's model bridge and nested agent tools, even when they inherit a tty.
    owners = [p for p in chain if agent_name(p['args'])]
    if not owners or agent_name(owners[0]['args']) != kind:
        return None
    p = owners[0]
    if any(a['tty'] == p['tty'] and (agent_name(a['args']) != kind or a['pgid'] != p['pgid']) for a in owners[1:]):
        return None
    if p['tty'] in {'?', '??', '-'} or p['pgid'] != p['tpgid']:
        return None
    if any(x in p['args'].split() for x in ['--print', '-p', '--output-format', '--headless', 'app-server', 'exec']):
        return None
    return p


def transition(state, event, data, requested):
    """Pure state transition; concurrent hooks are serialized by a per-PID lock."""
    tools = state.setdefault('tools', [])
    key = data.get('tool_use_id')
    output = None
    if event == 'UserPromptSubmit':
        state['phase'] = 'busy'
        state['lastUser'] = re.sub(r'\s+', ' ', data.get('prompt') or '')[:280]
        if requested:
            output = {'continue': False, 'stopReason': 'Session is being stashed by oneterm.'}
    elif event == 'PreToolUse':
        if requested:
            output = {'hookSpecificOutput': {'hookEventName': event, 'permissionDecision': 'deny', 'permissionDecisionReason': 'Session is being stashed by oneterm.'}}
        elif key:
            if (data.get('tool_input') or {}).get('run_in_background') or data.get('tool_name') in {'spawn_agent', 'Agent'}:
                state['background'] = True
            if key not in tools:
                tools.append(key)
            state['phase'] = 'busy'
        else:
            # Unknown schema: do not infer safety from a missing tool identity.
            state['phase'] = 'unknown'
            if 'unknown' not in tools:
                tools.append('unknown')
    elif event in {'PostToolUse', 'PostToolUseFailure'}:
        if key in tools:
            tools.remove(key)
        response = data.get('tool_response')
        if isinstance(response, dict) and response.get('status') == 'async_launched':
            state['background'] = True
        if requested and state.get('kind') != 'codex' and not state.get('background'):
            output = {'continue': False, 'stopReason': 'Session stashed by oneterm; resume to continue.'}
        # Codex continue:false here replaces the tool result rather than ending the turn.
        # Leave its result intact and stop the process once this batch has drained.
        if requested and not tools and not state.get('background'):
            state['phase'] = 'safe'
    elif event in {'Stop', 'StopFailure'}:
        if 'background_tasks' in data:
            state['background'] = bool(data['background_tasks'] or data.get('session_crons'))
        state['phase'] = 'background' if state.get('background') else 'idle'
        state['lastAssistant'] = re.sub(r'\s+', ' ', (data.get('last_assistant_message') or ''))[:280]
        if requested:
            output = {'continue': False, 'stopReason': 'Session stashed by oneterm.'}
    elif event == 'SessionEnd':
        # Ending a logical thread does not necessarily exit the terminal client.
        state['phase'] = 'ended' if not tools and not state.get('background') else 'unknown'
    elif event == 'Notification' and data.get('notification_type') == 'idle_prompt':
        if not tools and state.get('phase') != 'background':
            state['phase'] = 'idle'
    elif event == 'Interrupt':
        # An interrupt can leave background tools alive: never erase their identities.
        if not tools:
            state['phase'] = 'idle'
    return output


def hook(kind):
    data = json.load(sys.stdin)
    if data.get('agent_id'):
        return
    p = hook_owner(kind, processes())
    if not p:
        return
    pid = p['pid']
    start = identity(pid)
    NATIVE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (NATIVE / ('%s.lock' % pid)).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = NATIVE / ('%s.json' % pid)
        state = read(path)
        sid = data.get('session_id')
        if not sid or not start:
            return
        event = data['hook_event_name']
        if not state or state.get('identity') != start or state.get('sessionId') != sid:
            state = dict(pid=pid, identity=start, kind=kind, sessionId=sid, sessionFile=None, cwd=data['cwd'], name=None,
                         phase='idle' if event == 'SessionStart' else 'unknown', tools=[])
        if data.get('session_title'):
            state['name'] = data['session_title']
        state['sessionFile'] = data.get('transcript_path') or state.get('sessionFile')
        state['cwd'] = data['cwd']
        req = read(HOME / 'requests' / ('%s.json' % pid))
        requested = bool(req and req.get('identity') == start and req.get('sessionId') == sid and req.get('expiresAt', 0) > time.time())
        output = transition(state, event, data, requested)
        state['updatedAt'] = time.time()
        write(path, state)
        if output:
            print(json.dumps(output))


def live():
    result = []
    procs = processes()
    for directory, kind in [(HOME / 'live', 'pi'), (NATIVE, None)]:
        for path in directory.glob('*.json'):
            s = read(path)
            if not s or not isinstance(s.get('pid'), int):
                continue
            if s['pid'] not in procs:
                if kind is None:
                    path.unlink(missing_ok=True)
                continue
            start = identity(s['pid'])
            if not start or (kind is None and start != s.get('identity')):
                continue
            result.append(dict(s, kind=kind or s['kind'], identity=start))
    return result


def connection_of(pid, procs):
    while pid in procs:
        try:
            env = Path('/proc/%s/environ' % pid).read_bytes().split(b'\0')
            val = next((v[15:].decode() for v in env if v.startswith(b'SSH_CONNECTION=')), '')
            if val:
                return val.split()[:2]
        except (OSError, UnicodeError):
            pass
        pid = procs[pid]['ppid']
    return None


def probe(connection):
    procs = processes()
    matched = [p for p in procs.values() if p['tty'] not in {'?', '??', '-'} and connection_of(p['pid'], procs) == connection]
    ttys = {p['tty'] for p in matched}
    if len(ttys) != 1:
        return {'skip': 'SSH terminal could not be matched (multiplexing is not supported)'}
    tty = next(iter(ttys))
    group = [p for p in procs.values() if p['tty'] == tty and p['pgid'] == p['tpgid']]
    registered = [s for s in live() if any(p['pid'] == s['pid'] for p in group)]
    if len(registered) == 1:
        return {'live': registered[0]}
    leader = next((p for p in group if p['pid'] == p['pgid']), None)
    if leader and Path(leader['args'].split()[0]).name.lstrip('-') in SHELLS and all(
            Path(p['args'].split()[0]).name.lstrip('-') in SHELLS for p in group):
        try:
            return {'cwd': os.readlink('/proc/%s/cwd' % leader['pid'])}
        except OSError:
            pass
    return {'skip': 'remote program needs oneterm hooks or is still running'}


def request(item, group_id, timeout):
    current = next((s for s in live() if s['pid'] == item['pid'] and s['identity'] == item['identity'] and s['sessionId'] == item['sessionId']), None)
    if not current:
        raise ValueError('agent identity changed before stash')
    req = dict(itemId=item['id'], groupId=group_id, timeoutMs=timeout, identity=item['identity'], sessionId=item['sessionId'], expiresAt=time.time() + timeout / 1000, interrupted=current.get('phase') != 'idle')
    (HOME / 'acks' / ('%s.json' % item['pid'])).unlink(missing_ok=True)
    write(HOME / 'requests' / ('%s.json' % item['pid']), req)
    return {'ok': True}


def poll(item):
    pid = item['pid']
    reqpath = HOME / 'requests' / ('%s.json' % pid)
    ackpath = HOME / 'acks' / ('%s.json' % pid)
    start = identity(pid)
    if not start or start != item['identity']:
        ack = read(ackpath)
        if ack and ack.get('itemId') == item['id']:
            return {'done': True, 'ack': ack}
        return {'failed': True}
    if item['kind'] == 'pi':
        return {'pending': True}
    NATIVE.mkdir(parents=True, exist_ok=True)
    with (NATIVE / ('%s.lock' % pid)).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        s = read(NATIVE / ('%s.json' % pid))
        req = read(reqpath)
        ack = read(ackpath)
        if (s and s.get('phase') == 'ended' and not s.get('tools') and not s.get('background')
                and s.get('sessionId') == item['sessionId'] and s.get('identity') == item['identity']
                and ack and ack.get('itemId') == item['id'] and ack.get('identity') == item['identity']):
            return {'done': True, 'ack': ack}
        if not s or not req or req.get('itemId') != item['id'] or req.get('expiresAt', 0) < time.time():
            return {'pending': True}
        if s.get('phase') not in {'idle', 'safe', 'ended'} or s.get('tools') or s.get('background') or s.get('sessionId') != item['sessionId']:
            return {'pending': True}
        # Give the synchronous Stop hook and asynchronous transcript writer time to finish.
        if time.time() - s['updatedAt'] < 1:
            return {'pending': True}
        has_transcript = bool(s.get('sessionFile') and Path(s['sessionFile']).is_file())
        if not has_transcript and s.get('lastUser'):
            return {'pending': True}
        if identity(pid) != item['identity']:
            return {'failed': True}
        ack = dict(s, itemId=item['id'], interrupted=req.get('interrupted', False), sessionFile=s.get('sessionFile') if has_transcript else None)
        write(ackpath, ack)
        os.kill(pid, signal.SIGTERM)
    return {'pending': True}


def cancel(item):
    path = HOME / 'requests' / ('%s.json' % item['pid'])
    req = read(path)
    if req and req.get('itemId') == item['id']:
        path.unlink(missing_ok=True)
    return {'ok': True}


def install():
    script = str(Path(__file__).resolve())
    events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']
    for kind, path in [('claude', Path.home() / '.claude/settings.json'), ('codex', Path.home() / '.codex/hooks.json')]:
        original = path.read_text() if path.exists() else None
        data = json.loads(original) if original else {}
        if data.get('disableAllHooks'):
            raise ValueError('%s hooks are disabled' % kind)
        hooks = data.setdefault('hooks', {})
        for event in events + (['PostToolUseFailure', 'Notification', 'StopFailure'] if kind == 'claude' else ['Interrupt']):
            groups = hooks.setdefault(event, [])
            command = 'python3 %s --hook %s' % (shlex.quote(script), kind)
            handler = {'type': 'command', 'command': command, 'timeout': 3 if event in {'SessionEnd', 'Interrupt'} else 5}
            found = [h for g in groups for h in g.get('hooks', []) if h.get('command') == command]
            if found:
                for h in found:
                    h.update(handler)
            else:
                groups.append({'hooks': [handler]})
        if (path.read_text() if path.exists() else None) != original:
            raise ValueError('%s changed during install' % path)
        if original and json.loads(original) == data:
            print('%s hooks already installed in %s' % (kind, path))
            continue
        if original:
            backup = HOME / 'backups' / (kind + '-' + str(time.time_ns()) + '.json')
            write(backup, json.loads(original))
        write(path, data)
        print('Installed %s hooks in %s' % (kind, path))
    print('Codex: review and trust these hooks with /hooks in each installation.')


def main():
    if sys.argv[1:] == ['--install']:
        install()
    elif len(sys.argv) == 3 and sys.argv[1] == '--hook':
        hook(sys.argv[2])
    else:
        data = json.load(sys.stdin)
        action = data['action']
        if action == 'list':
            result = live()
        elif action == 'probe':
            result = probe(data['connection'])
        elif action == 'request':
            result = request(data['item'], data['groupId'], data['timeoutMs'])
        elif action == 'poll':
            result = poll(data['item'])
        elif action == 'cancel':
            result = cancel(data['item'])
        elif action == 'exists':
            result = {'exists': Path(data['path']).is_file()}
        else:
            raise ValueError('unknown action')
        print(json.dumps(result))


if __name__ == '__main__':
    main()
