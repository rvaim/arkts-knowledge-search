import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runCommand, runInteractiveLogin } from '../dist/command.js';
import { KnowledgeError } from '../dist/errors.js';

const loginUrl = 'https://example.invalid/apply?port=12345&appid=1008&code=fake-secret';
const specialUrl = loginUrl + '&value=%26%22%20%PATH%!VAR!^|<>()"\'`$; 空格中文#fragment';
const success = { stdout: '', stderr: '', exitCode: 0 };

async function captureWindowsCommand(url, env = process.env) {
  let captured;
  await runInteractiveLogin(url, {
    platform: 'win32',
    env,
    runner: async (command, args, options) => {
      captured = { command, args, options };
      return success;
    },
  });
  return captured;
}

test('Windows keeps the complete URL in the child environment, outside command text', async () => {
  const env = { PATH: 'test-path', ARKTS_KNOWLEDGE_LOGIN_URL: 'stale' };
  const original = { ...env };
  let fixedArgs;
  for (const url of [loginUrl, specialUrl]) {
    const { command, args, options } = await captureWindowsCommand(url, env);
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(args.length, 4);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    assert.match(script, /Start-Process -FilePath \$env:ARKTS_KNOWLEDGE_LOGIN_URL -ErrorAction Stop/);
    assert.equal(script.includes(url), false);
    assert.deepEqual(options, {
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      env: { ...env, ARKTS_KNOWLEDGE_LOGIN_URL: url },
    });
    if (fixedArgs) assert.deepEqual(args, fixedArgs);
    fixedArgs = args;
  }
  assert.deepEqual(env, original);
});

test('macOS and Linux retain their browser commands and arguments', async () => {
  for (const [platform, env, command, args] of [
    ['darwin', {}, 'open', [loginUrl]],
    ['darwin', { ARKTS_KNOWLEDGE_BROWSER: ' Google Chrome ' }, 'open', ['-a', 'Google Chrome', loginUrl]],
    ['linux', { ARKTS_KNOWLEDGE_BROWSER: 'ignored' }, 'xdg-open', [loginUrl]],
  ]) {
    await runInteractiveLogin(loginUrl, {
      platform,
      env,
      runner: async (actualCommand, actualArgs, options) => {
        assert.equal(actualCommand, command);
        assert.deepEqual(actualArgs, args);
        assert.deepEqual(options, { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
        return success;
      },
    });
  }
});

test('browser launch failures reject, including stderr/stdout fallback', async () => {
  for (const [stdout, stderr, message] of [
    ['fallback', ' failed ', 'failed'],
    [' fallback ', '', 'fallback'],
  ]) {
    await assert.rejects(runInteractiveLogin(loginUrl, {
      platform: 'win32',
      runner: async () => ({ stdout, stderr, exitCode: 1 }),
    }), error => error.code === 'BROWSER_OPEN_FAILED' && error.message.endsWith(message));
  }
  for (const code of ['COMMAND_NOT_FOUND', 'COMMAND_START_FAILED', 'COMMAND_TIMEOUT']) {
    const failure = new KnowledgeError(code, 'simulated launch failure');
    await assert.rejects(runInteractiveLogin(loginUrl, {
      platform: 'win32',
      runner: async () => { throw failure; },
    }), error => error === failure);
  }
});

test('runCommand disables the shell and handles spawn errors and timeout', async t => {
  let child;
  const spawnMock = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, 'test-browser');
    assert.deepEqual(args, [specialUrl]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = t.mock.fn(() => true);
    return child;
  });
  syncBuiltinESMExports();
  try {
    for (const [code, expected] of [
      ['ENOENT', 'COMMAND_NOT_FOUND'],
      ['EACCES', 'COMMAND_START_FAILED'],
    ]) {
      const result = runCommand('test-browser', [specialUrl]);
      const rejected = assert.rejects(result, error => error.code === expected);
      child.emit('error', Object.assign(new Error('spawn failed'), { code }));
      child.emit('close', 1);
      await rejected;
    }
    await assert.rejects(runCommand('test-browser', [specialUrl], { timeoutMs: 5 }),
      error => error.code === 'COMMAND_TIMEOUT');
    assert.equal(child.kill.mock.callCount(), 1);
    child.emit('close', 1);
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

// Execute the production script in real Windows PowerShell. Only Start-Process
// is replaced, so CI never opens a browser or contacts an authorization service.
test('Windows PowerShell passes literal URLs once without executing their contents', {
  skip: process.platform !== 'win32',
}, async () => {
  const stub = `function Start-Process {
    [CmdletBinding()]
    param([string]$FilePath)
    [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($FilePath)))
  }`;
  const payloadUrl = loginUrl + '&x=";[Console]::Out.WriteLine(\'INJECTED\');#&y=$(Write-Output INJECTED)';
  for (const url of [loginUrl, specialUrl, payloadUrl]) {
    const { command, args, options } = await captureWindowsCommand(url);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    const result = await runCommand(command, [
      ...args.slice(0, 3),
      Buffer.from(stub + '\n' + script, 'utf16le').toString('base64'),
    ], options);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), Buffer.from(url, 'utf8').toString('base64'));
    assert.equal(result.stderr, '');
  }
});

test('Windows PowerShell converts Start-Process errors into a failed browser launch', {
  skip: process.platform !== 'win32',
}, async () => {
  await assert.rejects(runInteractiveLogin(loginUrl, {
    runner: async (command, args, options) => {
      const script = Buffer.from(args[3], 'base64').toString('utf16le');
      const stub = 'function Start-Process { [CmdletBinding()] param([string]$FilePath) throw "simulated failure" }';
      return runCommand(command, [
        ...args.slice(0, 3),
        Buffer.from(stub + '\n' + script, 'utf16le').toString('base64'),
      ], options);
    },
  }), error => error.code === 'BROWSER_OPEN_FAILED' &&
    error.message.includes('Unable to open the default browser.'));
});
