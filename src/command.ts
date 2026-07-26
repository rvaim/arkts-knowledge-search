import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { KnowledgeError } from './errors.js';

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandOutput>;

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export const runCommand: CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandOutput> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    };

    const collect = (
      target: Buffer[],
      chunk: Buffer,
      processToStop: ChildProcess
    ): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        processToStop.kill();
        finishReject(
          new KnowledgeError(
            'COMMAND_OUTPUT_TOO_LARGE',
            `命令输出超过 ${maxOutputBytes} 字节限制。`
          )
        );
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, child));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, child));
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code =
        error.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : 'COMMAND_START_FAILED';
      finishReject(
        new KnowledgeError(code, `无法启动命令 ${command}。`, error)
      );
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      const result: CommandOutput = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? 1,
      };
      resolve(result);
    });

    timer = setTimeout(() => {
      child.kill();
      finishReject(
        new KnowledgeError(
          'COMMAND_TIMEOUT',
          `命令执行超过 ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} 毫秒。`
        )
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });

export async function runInteractiveLogin(loginUrl: string): Promise<void> {
  const platform = process.platform;
  const preferredBrowser = process.env.ARKTS_KNOWLEDGE_BROWSER?.trim();
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'cmd.exe'
        : 'xdg-open';
  const args =
    platform === 'win32'
      ? ['/d', '/s', '/c', 'start', '', loginUrl]
      : platform === 'darwin' && preferredBrowser
        ? ['-a', preferredBrowser, loginUrl]
      : [loginUrl];

  const result = await runCommand(command, args, {
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new KnowledgeError(
      'BROWSER_OPEN_FAILED',
      `无法自动打开浏览器：${result.stderr.trim() || result.stdout.trim()}`
    );
  }
}
