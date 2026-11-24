import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentShell } from '../src/executor.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PersistentShell', () => {
  it('stops the running command when the wait is aborted', { timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'motif-shell-abort-'));
    const shell = new PersistentShell(dir);
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 100);
    await shell.send("sleep 1; printf 'CANCEL_TEST' > after-esc.txt", 5, controller.signal);

    // Longer than the sleep: without the interrupt the marker appears.
    await wait(1300);
    expect(existsSync(join(dir, 'after-esc.txt'))).toBe(false);
    shell.close();
  });

  it('keeps the shell alive after an interrupted command', { timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'motif-shell-alive-'));
    const shell = new PersistentShell(dir);
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 100);
    await shell.send('sleep 1', 5, controller.signal);
    const after = await shell.send('echo still-here', 1);

    expect(after.output).toContain('still-here');
    shell.close();
  });
});
