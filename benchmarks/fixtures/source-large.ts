/**
 * Large source file fixture for benchmarking file-read pruning.
 * Simulates a real-world service module that an agent might read.
 */
import { Database } from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { join, dirname, basename, extname, resolve, relative } from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { watch, FSWatcher } from 'chokidar';
import { z } from 'zod';
import { LRUCache } from 'lru-cache';
import { PinoLogger } from 'pino';
import { Mutex } from 'async-mutex';
import { Semaphore } from 'async-mutex';

// Types and interfaces

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin' | 'moderator';
  status: 'active' | 'suspended' | 'deleted';
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  metadata: Record<string, unknown>;
}

interface SessionRecord {
  id: string;
  userId: string;
  token: string;
  expiresAt: number;
  ipAddress: string;
  userAgent: string;
  createdAt: number;
}

interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  timestamp: number;
  metadata: Record<string, unknown>;
  ipAddress: string;
  success: boolean;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
  accessCount: number;
}

interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'ASC' | 'DESC';
  filter?: Record<string, unknown>;
}

interface QueryResult<T> {
  data: T[];
  total: number;
  hasMore: boolean;
}

// Zod schemas for validation

const UserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  role: z.enum(['user', 'admin', 'moderator']).default('user'),
  metadata: z.record(z.unknown()).default({}),
});

const SessionSchema = z.object({
  userId: z.string().uuid(),
  ipAddress: z.string().ip(),
  userAgent: z.string().max(500),
});

const AuditSchema = z.object({
  userId: z.string().uuid().nullable(),
  action: z.string().min(1).max(100),
  resource: z.string().min(1).max(100),
  resourceId: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
  ipAddress: z.string().ip(),
  success: z.boolean(),
});

// Configuration

const CONFIG = {
  dbPath: process.env.DB_PATH || './data/app.db',
  sessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
  cacheMaxSize: 1000,
  cacheTTL: 5 * 60 * 1000, // 5 minutes
  auditLogEnabled: process.env.AUDIT_LOG !== 'false',
  maxQueryLimit: 100,
  defaultQueryLimit: 20,
  passwordMinLength: 12,
  passwordMaxLength: 128,
  maxLoginAttempts: 5,
  lockoutDuration: 15 * 60 * 1000, // 15 minutes
  rateLimitWindow: 60 * 1000, // 1 minute
  rateLimitMax: 100,
} as const;

// Database service

export class DatabaseService {
  private db: Database;
  private logger: PinoLogger;
  private cache: LRUCache<string, CacheEntry<unknown>>;
  private writeMutex: Mutex;
  private readonlyMutex: Semaphore;

  constructor(dbPath: string = CONFIG.dbPath, logger?: PinoLogger) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.logger = logger || console as unknown as PinoLogger;
    this.cache = new LRUCache({ max: CONFIG.cacheMaxSize, ttl: CONFIG.cacheTTL });
    this.writeMutex = new Mutex();
    this.readonlyMutex = new Semaphore(10);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        ip_address TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        resource_id TEXT,
        timestamp INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        ip_address TEXT NOT NULL,
        success INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS login_attempts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        success INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email);
      CREATE INDEX IF NOT EXISTS idx_login_attempts_timestamp ON login_attempts(timestamp);
    `);
  }

  // User operations

  async createUser(input: z.infer<typeof UserSchema>, password: string): Promise<UserRecord> {
    const validated = UserSchema.parse(input);

    if (password.length < CONFIG.passwordMinLength || password.length > CONFIG.passwordMaxLength) {
      throw new Error(`Password must be between ${CONFIG.passwordMinLength} and ${CONFIG.passwordMaxLength} characters`);
    }

    const id = randomBytes(16).toString('hex');
    const now = Date.now();
    const passwordHash = createHash('sha256').update(password).digest('hex');

    await this.writeMutex.runExclusive(async () => {
      this.db.prepare(
        'INSERT INTO users (id, email, name, role, status, password_hash, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, validated.email, validated.name, validated.role, 'active', passwordHash, now, now, JSON.stringify(validated.metadata));
    });

    this.logger.info({ userId: id, email: validated.email }, 'User created');

    if (CONFIG.auditLogEnabled) {
      await this.writeAudit({
        userId: id,
        action: 'user.create',
        resource: 'user',
        resourceId: id,
        metadata: { email: validated.email, role: validated.role },
        ipAddress: 'system',
        success: true,
      });
    }

    return this.getUserById(id);
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const cacheKey = `user:${id}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<UserRecord> | undefined;
    if (cached && cached.expiresAt > Date.now()) {
      cached.accessCount++;
      return cached.value;
    }

    return this.readonlyMutex.runExclusive(async () => {
      const row = this.db.prepare(
        'SELECT id, email, name, role, status, created_at, updated_at, last_login_at, metadata FROM users WHERE id = ?',
      ).get(id) as Record<string, unknown> | undefined;

      if (!row) return null;

      const user: UserRecord = {
        id: row.id as string,
        email: row.email as string,
        name: row.name as string,
        role: row.role as UserRecord['role'],
        status: row.status as UserRecord['status'],
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        lastLoginAt: row.last_login_at as number | null,
        metadata: JSON.parse(row.metadata as string),
      };

      this.cache.set(cacheKey, {
        value: user,
        expiresAt: Date.now() + CONFIG.cacheTTL,
        createdAt: Date.now(),
        accessCount: 0,
      });

      return user;
    });
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    return this.readonlyMutex.runExclusive(async () => {
      const row = this.db.prepare(
        'SELECT id, email, name, role, status, created_at, updated_at, last_login_at, metadata FROM users WHERE email = ?',
      ).get(email) as Record<string, unknown> | undefined;

      if (!row) return null;

      return {
        id: row.id as string,
        email: row.email as string,
        name: row.name as string,
        role: row.role as UserRecord['role'],
        status: row.status as UserRecord['status'],
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        lastLoginAt: row.last_login_at as number | null,
        metadata: JSON.parse(row.metadata as string),
      };
    });
  }

  async updateUser(id: string, updates: Partial<Omit<UserRecord, 'id' | 'createdAt'>>): Promise<UserRecord | null> {
    const allowedFields = ['name', 'role', 'status', 'metadata'];
    const updateParts: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        updateParts.push(`${key} = ?`);
        values.push(key === 'metadata' ? JSON.stringify(value) : value);
      }
    }

    if (updateParts.length === 0) return this.getUserById(id);

    updateParts.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    await this.writeMutex.runExclusive(async () => {
      this.db.prepare(
        `UPDATE users SET ${updateParts.join(', ')} WHERE id = ?`,
      ).run(...values);
    });

    this.cache.delete(`user:${id}`);
    this.logger.info({ userId: id, updates: Object.keys(updates) }, 'User updated');

    if (CONFIG.auditLogEnabled) {
      await this.writeAudit({
        userId: id,
        action: 'user.update',
        resource: 'user',
        resourceId: id,
        metadata: { fields: Object.keys(updates) },
        ipAddress: 'system',
        success: true,
      });
    }

    return this.getUserById(id);
  }

  async deleteUser(id: string): Promise<boolean> {
    await this.writeMutex.runExclusive(async () => {
      this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('deleted', id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });

    this.cache.delete(`user:${id}`);
    this.logger.info({ userId: id }, 'User deleted');

    if (CONFIG.auditLogEnabled) {
      await this.writeAudit({
        userId: id,
        action: 'user.delete',
        resource: 'user',
        resourceId: id,
        metadata: {},
        ipAddress: 'system',
        success: true,
      });
    }

    return true;
  }

  async listUsers(options: QueryOptions = {}): Promise<QueryResult<UserRecord>> {
    const limit = Math.min(options.limit || CONFIG.defaultQueryLimit, CONFIG.maxQueryLimit);
    const offset = options.offset || 0;

    let whereClause = 'WHERE status != ?';
    const whereValues: unknown[] = ['deleted'];

    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (['role', 'status', 'email'].includes(key)) {
          whereClause += ` AND ${key} = ?`;
          whereValues.push(value);
        }
      }
    }

    const orderClause = options.orderBy
      ? `ORDER BY ${options.orderBy} ${options.orderDir || 'ASC'}`
      : 'ORDER BY created_at DESC';

    return this.readonlyMutex.runExclusive(async () => {
      const total = this.db.prepare(
        `SELECT COUNT(*) as count FROM users ${whereClause}`,
      ).get(...whereValues) as { count: number };

      const rows = this.db.prepare(
        `SELECT id, email, name, role, status, created_at, updated_at, last_login_at, metadata FROM users ${whereClause} ${orderClause} LIMIT ? OFFSET ?`,
      ).all(...whereValues, limit, offset) as Record<string, unknown>[];

      const data = rows.map(row => ({
        id: row.id as string,
        email: row.email as string,
        name: row.name as string,
        role: row.role as UserRecord['role'],
        status: row.status as UserRecord['status'],
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        lastLoginAt: row.last_login_at as number | null,
        metadata: JSON.parse(row.metadata as string),
      }));

      return {
        data,
        total: total.count,
        hasMore: offset + data.length < total.count,
      };
    });
  }

  // Session operations

  async createSession(userId: string, ipAddress: string, userAgent: string): Promise<SessionRecord> {
    const validated = SessionSchema.parse({ userId, ipAddress, userAgent });
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + CONFIG.sessionTimeout;

    await this.writeMutex.runExclusive(async () => {
      this.db.prepare(
        'INSERT INTO sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, validated.userId, token, expiresAt, validated.ipAddress, validated.userAgent, now);
    });

    this.logger.info({ sessionId: id, userId: validated.userId }, 'Session created');

    return {
      id,
      userId: validated.userId,
      token,
      expiresAt,
      ipAddress: validated.ipAddress,
      userAgent: validated.userAgent,
      createdAt: now,
    };
  }

  async getSessionByToken(token: string): Promise<SessionRecord | null> {
    return this.readonlyMutex.runExclusive(async () => {
      const row = this.db.prepare(
        'SELECT * FROM sessions WHERE token = ? AND expires_at > ?',
      ).get(token, Date.now()) as Record<string, unknown> | undefined;

      if (!row) return null;

      return {
        id: row.id as string,
        userId: row.user_id as string,
        token: row.token as string,
        expiresAt: row.expires_at as number,
        ipAddress: row.ip_address as string,
        userAgent: row.user_agent as string,
        createdAt: row.created_at as number,
      };
    });
  }

  async deleteSession(token: string): Promise<boolean> {
    await this.writeMutex.runExclusive(async () => {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    });
    return true;
  }

  async cleanupExpiredSessions(): Promise<number> {
    return this.writeMutex.runExclusive(async () => {
      const result = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      this.logger.info({ deleted: result.changes }, 'Expired sessions cleaned up');
      return result.changes;
    });
  }

  // Audit log

  async writeAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    if (!CONFIG.auditLogEnabled) return;

    const validated = AuditSchema.parse(entry);
    const id = randomBytes(16).toString('hex');
    const timestamp = Date.now();

    await this.writeMutex.runExclusive(async () => {
      this.db.prepare(
        'INSERT INTO audit_log (id, user_id, action, resource, resource_id, timestamp, metadata, ip_address, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, validated.userId, validated.action, validated.resource, validated.resourceId, timestamp, JSON.stringify(validated.metadata), validated.ipAddress, validated.success ? 1 : 0);
    });
  }

  async getAuditLog(options: QueryOptions & { userId?: string; action?: string } = {}): Promise<QueryResult<AuditEntry>> {
    const limit = Math.min(options.limit || CONFIG.defaultQueryLimit, CONFIG.maxQueryLimit);
    const offset = options.offset || 0;

    let whereClause = 'WHERE 1=1';
    const whereValues: unknown[] = [];

    if (options.userId) {
      whereClause += ' AND user_id = ?';
      whereValues.push(options.userId);
    }

    if (options.action) {
      whereClause += ' AND action = ?';
      whereValues.push(options.action);
    }

    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (['resource', 'success'].includes(key)) {
          whereClause += ` AND ${key} = ?`;
          whereValues.push(value);
        }
      }
    }

    const orderClause = options.orderBy
      ? `ORDER BY ${options.orderBy} ${options.orderDir || 'DESC'}`
      : 'ORDER BY timestamp DESC';

    return this.readonlyMutex.runExclusive(async () => {
      const total = this.db.prepare(
        `SELECT COUNT(*) as count FROM audit_log ${whereClause}`,
      ).get(...whereValues) as { count: number };

      const rows = this.db.prepare(
        `SELECT * FROM audit_log ${whereClause} ${orderClause} LIMIT ? OFFSET ?`,
      ).all(...whereValues, limit, offset) as Record<string, unknown>[];

      const data = rows.map(row => ({
        id: row.id as string,
        userId: row.user_id as string | null,
        action: row.action as string,
        resource: row.resource as string,
        resourceId: row.resource_id as string | null,
        timestamp: row.timestamp as number,
        metadata: JSON.parse(row.metadata as string),
        ipAddress: row.ip_address as string,
        success: row.success === 1,
      }));

      return {
        data,
        total: total.count,
        hasMore: offset + data.length < total.count,
      };
    });
  }

  // Login attempt tracking

  async recordLoginAttempt(email: string, ipAddress: string, success: boolean): Promise<void> {
    const id = randomBytes(16).toString('hex');
    const timestamp = Date.now();

    await this.writeMutex.runExclusive(async () => {
      this.db.prepare(
        'INSERT INTO login_attempts (id, email, ip_address, success, timestamp) VALUES (?, ?, ?, ?, ?)',
      ).run(id, email, ipAddress, success ? 1 : 0, timestamp);
    });
  }

  async getRecentFailedAttempts(email: string, since: number): Promise<number> {
    return this.readonlyMutex.runExclusive(async () => {
      const row = this.db.prepare(
        'SELECT COUNT(*) as count FROM login_attempts WHERE email = ? AND success = 0 AND timestamp > ?',
      ).get(email, since) as { count: number };
      return row.count;
    });
  }

  async isAccountLocked(email: string): Promise<boolean> {
    const since = Date.now() - CONFIG.lockoutDuration;
    const failedAttempts = await this.getRecentFailedAttempts(email, since);
    return failedAttempts >= CONFIG.maxLoginAttempts;
  }

  // Password verification

  async verifyPassword(email: string, password: string): Promise<UserRecord | null> {
    const user = await this.getUserByEmail(email);
    if (!user || user.status !== 'active') return null;

    if (await this.isAccountLocked(email)) {
      this.logger.warn({ email }, 'Account locked due to too many failed attempts');
      return null;
    }

    return this.readonlyMutex.runExclusive(async () => {
      const row = this.db.prepare(
        'SELECT password_hash FROM users WHERE id = ?',
      ).get(user.id) as { password_hash: string } | undefined;

      if (!row) return null;

      const hash = createHash('sha256').update(password).digest('hex');
      if (hash !== row.password_hash) {
        await this.recordLoginAttempt(email, 'unknown', false);
        return null;
      }

      await this.recordLoginAttempt(email, 'unknown', true);

      // Update last login
      await this.writeMutex.runExclusive(async () => {
        this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
      });

      this.cache.delete(`user:${user.id}`);

      if (CONFIG.auditLogEnabled) {
        await this.writeAudit({
          userId: user.id,
          action: 'user.login',
          resource: 'user',
          resourceId: user.id,
          metadata: {},
          ipAddress: 'unknown',
          success: true,
        });
      }

      return user;
    });
  }

  // Cache management

  clearCache(): void {
    this.cache.clear();
    this.logger.info('Cache cleared');
  }

  getCacheStats(): { size: number; hitRate: number } {
    return {
      size: this.cache.size,
      hitRate: 0, // Would need hit/miss tracking for real hit rate
    };
  }

  // Database maintenance

  async vacuum(): Promise<void> {
    await this.writeMutex.runExclusive(async () => {
      this.db.exec('VACUUM');
    });
    this.logger.info('Database vacuumed');
  }

  async backup(targetPath: string): Promise<void> {
    await this.writeMutex.runExclusive(async () => {
      const backup = this.db.backup(targetPath);
      await backup.complete();
    });
    this.logger.info({ targetPath }, 'Database backed up');
  }

  close(): void {
    this.db.close();
    this.logger.info('Database connection closed');
  }
}

// Event emitter for real-time notifications

export class DatabaseEvents extends EventEmitter {
  private db: DatabaseService;
  private watcher?: FSWatcher;

  constructor(db: DatabaseService) {
    super();
    this.db = db;
  }

  startWatching(dataDir: string): void {
    this.watcher = watch(dataDir, {
      persistent: false,
      ignoreInitial: true,
    });

    this.watcher.on('change', (path) => {
      this.emit('fileChange', { path, timestamp: Date.now() });
    });

    this.watcher.on('error', (err) => {
      this.emit('error', err);
    });
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}

// File-based backup service

export class BackupService {
  private db: DatabaseService;
  private logger: PinoLogger;
  private backupDir: string;

  constructor(db: DatabaseService, backupDir: string = './backups', logger?: PinoLogger) {
    this.db = db;
    this.backupDir = backupDir;
    this.logger = logger || console as unknown as PinoLogger;
  }

  async createBackup(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(this.backupDir, `backup-${timestamp}.db`);

    await mkdir(this.backupDir, { recursive: true });
    await this.db.backup(backupPath);

    this.logger.info({ backupPath }, 'Backup created');
    return backupPath;
  }

  async listBackups(): Promise<Array<{ name: string; path: string; size: number; createdAt: number }>> {
    try {
      const files = await readdir(this.backupDir);
      const backups = files.filter(f => f.endsWith('.db'));

      const results = await Promise.all(
        backups.map(async (name) => {
          const path = join(this.backupDir, name);
          const stats = await stat(path);
          return {
            name,
            path,
            size: stats.size,
            createdAt: stats.birthtime.getTime(),
          };
        }),
      );

      return results.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  async restoreBackup(backupPath: string): Promise<void> {
    const sourceData = await readFile(backupPath);
    const targetPath = CONFIG.dbPath;
    await writeFile(targetPath, sourceData);
    this.logger.info({ backupPath, targetPath }, 'Backup restored');
  }

  async deleteBackup(backupPath: string): Promise<void> {
    await unlink(backupPath);
    this.logger.info({ backupPath }, 'Backup deleted');
  }

  async cleanupOldBackups(maxAge: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const backups = await this.listBackups();
    const now = Date.now();
    let deleted = 0;

    for (const backup of backups) {
      if (now - backup.createdAt > maxAge) {
        await this.deleteBackup(backup.path);
        deleted++;
      }
    }

    if (deleted > 0) {
      this.logger.info({ deleted, maxAge }, 'Old backups cleaned up');
    }

    return deleted;
  }
}

// Health check service

export class HealthService {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async check(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Record<string, { status: 'pass' | 'fail'; latency?: number; message?: string }>;
  }> {
    const checks: Record<string, { status: 'pass' | 'fail'; latency?: number; message?: string }> = {};

    // Database check
    try {
      const start = Date.now();
      await this.db.listUsers({ limit: 1 });
      checks.database = { status: 'pass', latency: Date.now() - start };
    } catch (err) {
      checks.database = { status: 'fail', message: (err as Error).message };
    }

    // Cache check
    try {
      const stats = this.db.getCacheStats();
      checks.cache = { status: 'pass', message: `${stats.size} entries` };
    } catch (err) {
      checks.cache = { status: 'fail', message: (err as Error).message };
    }

    const allPass = Object.values(checks).every(c => c.status === 'pass');
    const anyFail = Object.values(checks).some(c => c.status === 'fail');

    return {
      status: allPass ? 'healthy' : anyFail ? 'unhealthy' : 'degraded',
      checks,
    };
  }
}

// Export singleton instance

let dbInstance: DatabaseService | null = null;

export function getDatabase(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
