import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';

/** Private host state. Never serialize this record into a model tool result. */
export interface McpAuthRecord {
  version: 1;
  key: string;
  endpoint: string;
  revision: string;
  clientInformation?: StoredOAuthClientInformation;
  clientRedirectUrl?: string;
  discovery?: OAuthDiscoveryState;
  tokens?: StoredOAuthTokens;
  expiresAt?: number;
  /** A local consent marker only; the external credential stays in its owner. */
  externalCredential?: { provider: 'github-cli'; granted: true };
}

export class McpAuthError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'McpAuthError'; }
}
const storageError = () => new McpAuthError('auth_storage_error', 'The private MCP credential store could not be accessed safely.');
export const authKey = (endpoint: string, clientId = '', scope = '', metadataUrl = ''): string => createHash('sha256')
  .update(JSON.stringify([endpoint, clientId, scope.trim().split(/\s+/).filter(Boolean).sort(), metadataUrl])).digest('hex');

/** One private file per endpoint/client/scope; atomic updates avoid partial secrets. */
export class McpAuthStore {
  readonly directory: string;
  constructor(home = homedir()) { this.directory = join(home, '.motif', 'auth'); }
  private file(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw storageError();
    return join(this.directory, `${key}.json`);
  }
  read(key: string): McpAuthRecord | undefined {
    const file = this.file(key);
    try {
      if (!existsSync(file)) return undefined;
      if (lstatSync(this.directory).isSymbolicLink()) throw storageError();
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 256 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw storageError();
        const value = JSON.parse(readFileSync(fd, 'utf8')) as McpAuthRecord;
        if (value.version !== 1 || value.key !== key || typeof value.endpoint !== 'string' || typeof value.revision !== 'string') throw storageError();
        return value;
      } finally { closeSync(fd); }
    } catch { throw storageError(); }
  }
  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw storageError();
  }
  private locked<T>(key: string, action: () => T): T {
    const lock = `${this.file(key)}.lock`; let owned = false;
    try {
      this.ensureDirectory(); mkdirSync(lock, { mode: 0o700 }); owned = true;
      return action();
    } catch (error) { if (error instanceof McpAuthError) throw error; throw storageError(); }
    finally { if (owned) rmSync(lock, { recursive: true, force: true }); }
  }
  private replace(record: McpAuthRecord): void {
    const file = this.file(record.key);
    let temporary: string | undefined;
    try {
      temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) { if (error instanceof McpAuthError) throw error; throw storageError(); }
    finally { if (temporary) rmSync(temporary, { force: true }); }
  }
  /** null requires an absent entry; the lock protects compare-and-replace across processes. */
  write(record: McpAuthRecord, expectedRevision?: string | null): void {
    this.locked(record.key, () => {
      const previous = this.read(record.key);
      if (expectedRevision !== undefined && (previous?.revision ?? null) !== expectedRevision) throw new McpAuthError('auth_changed', 'MCP authorization changed; reconnect before continuing.');
      this.replace(record);
    });
  }
  remove(key: string, expectedRevision?: string): void {
    this.locked(key, () => {
      const previous = this.read(key);
      if (expectedRevision !== undefined && previous?.revision !== expectedRevision) return;
      // Even logout before the first login completes advances the durable generation.
      // The tombstone contains no tokens, client secret, or discovery metadata.
      this.replace({ version: 1, key, endpoint: previous?.endpoint ?? '', revision: randomBytes(16).toString('hex') });
    });
  }
}
