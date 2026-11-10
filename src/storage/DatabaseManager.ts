/**
 * DatabaseManager
 * Manages SQLite database connections, schema, and low-level operations using sql.js
 * Now supports workspace-specific databases for project isolation
 */

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import initSqlJs from "sql.js";

type SqlJsDatabase = any;

import {
  TrackingEvent,
  DailyMetrics,
  ToolMetrics,
  CodingSession,
  Achievement,
  SnoozeState,
  AlertHistory,
  AlertType,
  IDatabaseManager,
  EventRecord,
  DailyMetricsRecord,
  ToolMetricsRecord,
  SessionRecord,
  AchievementRecord,
  ConfigRecord,
  SnoozeStateRecord,
  AlertHistoryRecord,
  AssignmentRecord,
  AITool,
  EventType,
  ReviewQuality,
  AgentSession,
  AgentSessionRecord,
  FileReviewStatus,
  FileReviewStatusRecord,
  CodeSource,
  AIClassification,
  PolicyViolationType,
  Assignment,
  AssignmentPolicy,
  AIDetectionMethod,
} from "../types";
import { safeJsonParse } from "../utils/SecurityUtils";
import { PathAnonymizer } from "../utils/PathAnonymizer";
import { addDays, startOfLocalDay } from "../utils/DateUtils";

export class DatabaseManager implements IDatabaseManager {
  private db: SqlJsDatabase | null = null;
  private readonly dbPath: string;
  private readonly workspacePath: string | null;
  private readonly workspaceHash: string;
  /** Reversible path anonymizer applied to every file_path read/written. */
  private pathAnonymizer!: PathAnonymizer;
  private autoSaveInterval: NodeJS.Timeout | null = null;
  private operationCount = 0;
  private readonly AUTO_SAVE_INTERVAL_MS = 30000; // 30 seconds
  private readonly AUTO_SAVE_OPERATION_COUNT = 10; // Every 10 operations

  /**
   * True when initialize() found an unreadable database and quarantined it.
   * Surfaces in diagnostics so the user can be told their history did not
   * survive rather than silently presenting empty numbers.
   */
  public recoveredFromCorruption = false;

  /** Where the unreadable database was moved, if one was. */
  public quarantinedDbPath: string | null = null;

  /**
   * Create a new DatabaseManager
   * @param storagePath Base storage directory (~/.codepause)
   * @param workspacePath Optional workspace path for project-specific DB
   */
  constructor(storagePath: string, workspacePath?: string) {
    // SECURITY: Validate and normalize workspace path
    if (workspacePath) {
      // Resolve to absolute path
      const resolved = path.resolve(workspacePath);

      // Check for null bytes (path traversal attack)
      if (resolved.includes("\0")) {
        throw new Error("Invalid workspace path: contains null byte");
      }

      // Validate path length (prevent DoS)
      if (resolved.length > 500) {
        throw new Error("Workspace path too long");
      }

      this.workspacePath = resolved;
    } else {
      this.workspacePath = null;
    }

    this.workspaceHash = this.generateWorkspaceHash(
      this.workspacePath || undefined,
    );

    // Reversible path anonymization for data at rest (codePause.anonymizePaths).
    // Writes store workspace-relative / ~-relative paths; reads resolve them
    // back to absolute so in-memory logic and file opening are unaffected.
    this.pathAnonymizer = new PathAnonymizer(this.workspacePath, true);

    // Use workspace-specific path if workspace is provided
    if (this.workspacePath) {
      const workspaceDir = path.join(
        storagePath,
        "projects",
        this.workspaceHash,
      );
      this.dbPath = path.join(workspaceDir, "codepause.db");

      // SECURITY: Verify final path is within storagePath
      const normalizedDbPath = path.resolve(this.dbPath);
      const normalizedStoragePath = path.resolve(storagePath);
      if (!normalizedDbPath.startsWith(normalizedStoragePath)) {
        throw new Error("Database path outside storage directory");
      }
    } else {
      // Fallback to global DB for no-workspace scenarios (single files)
      this.dbPath = path.join(storagePath, "global.db");
    }
  }

  /**
   * Generate a stable hash for the workspace path
   */
  private generateWorkspaceHash(workspacePath?: string): string {
    if (!workspacePath) {
      return "global";
    }

    // Create a short, readable hash of the workspace path
    const hash = crypto
      .createHash("sha256")
      .update(workspacePath)
      .digest("hex")
      .substring(0, 16);

    // Also include a readable folder name for easy identification
    const folderName = path
      .basename(workspacePath)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .substring(0, 32);

    return `${folderName}-${hash}`;
  }

  /**
   * Get the workspace path for this database
   */
  getWorkspacePath(): string | null {
    return this.workspacePath;
  }

  /**
   * Get the workspace identifier (hash)
   */
  getWorkspaceHash(): string {
    return this.workspaceHash;
  }

  async initialize(): Promise<void> {
    const dirname = path.dirname(this.dbPath);
    if (!fs.existsSync(dirname)) {
      fs.mkdirSync(dirname, { recursive: true });
    }

    const SQL = await initSqlJs({
      locateFile: (file: string) => {
        // Prefer the wasm shipped next to the bundle (out/sql.js/), which is
        // what the packaged VSIX includes; fall back to node_modules so the
        // dev runner can also find it.
        const bundledPath = path.join(__dirname, "sql.js", file);
        if (fs.existsSync(bundledPath)) {
          return bundledPath;
        }
        const wasmPath = path.join(
          __dirname,
          "..",
          "..",
          "node_modules",
          "sql.js",
          "dist",
          file,
        );
        if (fs.existsSync(wasmPath)) {
          return wasmPath;
        }
        return `node_modules/sql.js/dist/${file}`;
      },
    });

    // Issues #6/#7: "file is not a database" killed activation entirely.
    //
    // sql.js does NOT reject a corrupt buffer in the Database constructor - it
    // accepts it and only throws on the first exec(), which is createTables().
    // So the try/catch around the constructor never fired, and a torn write
    // from an earlier crash left the extension permanently unusable with no
    // way to recover except deleting the file by hand.
    //
    // Verify with a cheap query before trusting the handle. On failure,
    // quarantine the bytes (never delete - this is audit evidence) and start
    // fresh so the extension still activates.
    if (fs.existsSync(this.dbPath)) {
      if (this.openExistingDatabase(SQL)) {
        // Healthy.
      } else {
        this.quarantineCorruptDatabase();
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }

    try {
      this.createTables();
      this.runMigrations();
      this.createIndices();
    } catch (error) {
      // Still unreadable even as a fresh database: the failure is not the
      // file but the environment (unwritable directory, wasm problem).
      // Report it rather than pretending recovery worked.
      this.db = null;
      console.error(
        "[CodePause] Database initialization failed:",
        error,
      );
      throw new Error(
        `Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.startAutoSave();
  }

  /**
   * Open the database file at dbPath, confirming it is really a SQLite file.
   *
   * Returns false when the bytes are unreadable, having already closed the
   * handle so no file lock is left behind.
   */
  private openExistingDatabase(SQL: any): boolean {
    try {
      const buffer = fs.readFileSync(this.dbPath);
      const candidate = new SQL.Database(buffer);
      // exec() is where sql.js actually rejects a non-SQLite file.
      candidate.exec("SELECT name FROM sqlite_master LIMIT 1;");
      this.db = candidate;
      return true;
    } catch (error) {
      console.error(
        "[CodePause] Existing database is unreadable, recovering:",
        error,
      );
      return false;
    }
  }

  /**
   * Move an unreadable database aside and start a new one.
   *
   * The corrupt file is always preserved. This tool exists to produce evidence
   * about a student's work, so silently destroying a database - or silently
   * replacing it with an empty one - would be the worst possible failure mode.
   * Renaming keeps the bytes for inspection and leaves the live path writable.
   */
  private quarantineCorruptDatabase(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${this.dbPath}.corrupt-${stamp}`;

    try {
      fs.renameSync(this.dbPath, quarantinePath);
      this.quarantinedDbPath = quarantinePath;
      this.recoveredFromCorruption = true;
      console.error(
        `[CodePause] Quarantined unreadable database to ${quarantinePath}. ` +
          `History before today could not be recovered.`,
      );
    } catch (error) {
      // Could not move it (locked, read-only, permissions). Move it out of
      // the way by emptying it so initialize() can still succeed.
      console.error(
        `[CodePause] Could not quarantine ${this.dbPath}, truncating instead:`,
        error,
      );
      try {
        fs.writeFileSync(this.dbPath, Buffer.alloc(0));
      } catch (writeError) {
        console.error(
          "[CodePause] Could not clear the corrupt database either:",
          writeError,
        );
      }
      this.quarantinedDbPath = null;
      this.recoveredFromCorruption = true;
    }
  }

  /**
   * Run database migrations (add new columns, update schema, etc.)
   */
  private runMigrations(): void {
    // Migration: Add reviewed_in_terminal column to track terminal reviews separately
    this.safeAddColumn(
      "file_review_status",
      "reviewed_in_terminal",
      "INTEGER NOT NULL DEFAULT 0",
    );

    // Phase 2 Migration: Add unified source tracking (AI vs Manual)
    // Replaces tool-specific tracking with unified detection system
    this.safeAddColumn("events", "source", "TEXT"); // 'ai' or 'manual' (nullable for backward compatibility)
    this.safeAddColumn("events", "detection_method", "TEXT"); // How the event was detected
    this.safeAddColumn("events", "confidence", "TEXT"); // Detection confidence level ('high', 'medium', 'low')

    // Migration: Add lines_changed column for accurate review scoring
    // Tracks total lines changed (added + deleted) for review time calculation
    // Unlike lines_of_code which only tracks additions for metrics
    this.safeAddColumn("events", "lines_changed", "INTEGER"); // Total changes for review scoring

    // Migration: Add lines_changed to file_review_status for review scoring
    // This tracks total changes (added + |deleted|) for calculating expected review time
    this.safeAddColumn(
      "file_review_status",
      "lines_changed",
      "INTEGER DEFAULT 0",
    );

    // Migration: Add review_method column to track manual vs automatic reviews
    // 'manual' = user clicked "Mark as Reviewed" button
    // 'automatic' = system detected proper review via file viewing, scrolling, editing
    this.safeAddColumn(
      "file_review_status",
      "review_method",
      'TEXT DEFAULT "manual"',
    );

    // Add lines_since_review column to track only new lines since last review
    // lines_generated = total AI lines since file creation (cumulative, never resets)
    // lines_since_review = AI lines added since last review (resets to 0 when marked as reviewed)
    this.safeAddColumn(
      "file_review_status",
      "lines_since_review",
      "INTEGER DEFAULT 0",
    );

    // Migration: Add lines_removed column to track line deletions
    // This allows proper tracking of AI deletions for code review
    this.safeAddColumn("events", "lines_removed", "INTEGER DEFAULT 0");

    // Migration: Add lines_added and lines_removed to file_review_status
    // Tracks separate addition and removal counts for better transparency
    this.safeAddColumn(
      "file_review_status",
      "lines_added",
      "INTEGER DEFAULT 0",
    );
    this.safeAddColumn(
      "file_review_status",
      "lines_removed",
      "INTEGER DEFAULT 0",
    );

    // Migration: Add assignment tracking columns to events
    this.safeAddColumn("events", "assignment_id", "TEXT");
    this.safeAddColumn("events", "ai_classification", "TEXT"); // 'permitted', 'prohibited', 'flag'
    this.safeAddColumn("events", "policy_violation", "TEXT"); // PolicyViolationType value
  }

  private startAutoSave(): void {
    this.autoSaveInterval = setInterval(() => {
      this.sync();
    }, this.AUTO_SAVE_INTERVAL_MS);
  }

  sync(): void {
    if (!this.db) {
      return;
    }

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);

      // Issues #6/#7: writing straight to dbPath left a window where a crash,
      // a killed process or a full disk truncated the file mid-write. The next
      // launch then read a half-written file and sql.js rejected it with
      // "file is not a database", taking activation down with it.
      //
      // Write to a sibling temp file and rename. rename() is atomic within a
      // filesystem, so dbPath is only ever the old file or the new one, never
      // a partial one. Same directory matters: the temp file must not be a
      // different volume, or rename is not atomic.
      const tempPath = `${this.dbPath}.tmp-${process.pid}`;
      try {
        fs.writeFileSync(tempPath, buffer);
        fs.renameSync(tempPath, this.dbPath);
      } catch (error) {
        // Never let a failed save destroy the last good copy.
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch {
          // Best effort.
        }
        throw error;
      }

      this.operationCount = 0;
    } catch (error) {
      console.error("[CodePause] Failed to sync database:", error);
    }
  }

  private incrementOperations(): void {
    this.operationCount++;
    if (this.operationCount >= this.AUTO_SAVE_OPERATION_COUNT) {
      this.sync();
    }
  }

  isUsingFallback(): boolean {
    return true;
  }

  close(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }

    if (this.db) {
      this.sync();
      this.db.close();
      this.db = null;
    }
  }

  /**
   * SECURITY: Validate SQL identifier to prevent SQL injection
   * Only allows alphanumeric characters and underscores
   */
  private validateSqlIdentifier(identifier: string, context: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid SQL identifier for ${context}: ${identifier}`);
    }
  }

  /**
   * SECURITY: Validate SQL type to prevent SQL injection
   * Only allows known safe SQL types
   */
  private validateSqlType(type: string): void {
    const allowedTypes = [
      "TEXT",
      "INTEGER",
      "REAL",
      "BLOB",
      "NUMERIC",
      "BOOLEAN",
      "DATE",
      "DATETIME",
    ];

    // Extract base type by removing constraints (DEFAULT, NOT NULL, etc.)
    // Split on space and take first token, then split on ( for types like VARCHAR(255)
    const baseType = type.trim().split(/\s+/)[0].toUpperCase().split("(")[0];

    if (
      !allowedTypes.includes(baseType) &&
      !type.match(/^(TEXT|INTEGER|VARCHAR)\(\d+\)/i)
    ) {
      throw new Error(`Invalid SQL type: ${type}`);
    }
  }

  /**
   * Safely add a column to a table if it doesn't already exist
   * SECURITY: Uses whitelist validation to prevent SQL injection
   */
  private safeAddColumn(table: string, column: string, type: string): void {
    if (!this.db) {
      return;
    }

    try {
      // SECURITY: Validate all identifiers before using in SQL
      this.validateSqlIdentifier(table, "table name");
      this.validateSqlIdentifier(column, "column name");
      this.validateSqlType(type);

      // Check if column exists by querying table info (now safe after validation)
      const stmt = this.db.prepare(`PRAGMA table_info(${table})`);
      const columns: string[] = [];

      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        columns.push(row.name as string);
      }
      stmt.free();

      // Add column if it doesn't exist (now safe after validation)
      if (!columns.includes(column)) {
        // pi-lens-ignore: sql-injection
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    } catch (error) {
      // Column might already exist - ignore
    }
  }

  private createTables(): void {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        tool TEXT NOT NULL,
        event_type TEXT NOT NULL,
        lines_of_code INTEGER,
        characters_count INTEGER,
        acceptance_time_delta INTEGER,
        file_path TEXT,
        language TEXT,
        session_id TEXT,
        metadata TEXT,
        review_quality TEXT,
        review_quality_score INTEGER,
        is_reviewed INTEGER DEFAULT 0,
        is_agent_mode INTEGER DEFAULT 0,
        agent_session_id TEXT,
        source TEXT,
        detection_method TEXT,
        confidence TEXT,
        lines_removed INTEGER DEFAULT 0,
        lines_changed INTEGER,
        assignment_id TEXT,
        ai_classification TEXT,
        policy_violation TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_metrics (
        date TEXT PRIMARY KEY,
        total_events INTEGER NOT NULL DEFAULT 0,
        total_ai_suggestions INTEGER NOT NULL DEFAULT 0,
        total_ai_lines INTEGER NOT NULL DEFAULT 0,
        total_manual_lines INTEGER NOT NULL DEFAULT 0,
        ai_percentage REAL NOT NULL DEFAULT 0,
        average_review_time REAL NOT NULL DEFAULT 0,
        session_count INTEGER NOT NULL DEFAULT 0,
        review_quality_score REAL NOT NULL DEFAULT 0,
        unreviewed_lines INTEGER NOT NULL DEFAULT 0,
        unreviewed_percentage REAL NOT NULL DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_metrics (
        date TEXT NOT NULL,
        tool TEXT NOT NULL,
        suggestion_count INTEGER NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        lines_generated INTEGER NOT NULL DEFAULT 0,
        average_review_time REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, tool)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration INTEGER,
        event_count INTEGER NOT NULL DEFAULT 0,
        ai_lines_generated INTEGER NOT NULL DEFAULT 0,
        manual_lines_written INTEGER NOT NULL DEFAULT 0,
        tools_used TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS achievements (
        id TEXT PRIMARY KEY,
        unlocked INTEGER NOT NULL DEFAULT 0,
        unlocked_at INTEGER,
        progress REAL NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snooze_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snoozed INTEGER NOT NULL DEFAULT 0,
        snooze_until INTEGER,
        snooze_reason TEXT
      )
    `);

    this.db.exec(`
      INSERT OR IGNORE INTO snooze_state (id, snoozed) VALUES (1, 0)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_history (
        alert_type TEXT PRIMARY KEY,
        last_shown INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        course_id TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        repo_url TEXT,
        policy TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    // New table: agent_sessions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration INTEGER,
        file_count INTEGER NOT NULL DEFAULT 0,
        total_lines INTEGER NOT NULL DEFAULT 0,
        total_characters INTEGER NOT NULL DEFAULT 0,
        was_reviewed INTEGER NOT NULL DEFAULT 0,
        review_quality TEXT,
        review_score REAL,
        review_time INTEGER,
        detection_signals TEXT NOT NULL,
        confidence TEXT NOT NULL,
        files_affected TEXT NOT NULL,
        alert_shown INTEGER NOT NULL DEFAULT 0,
        alert_shown_at INTEGER,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    // New table: file_review_status
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_review_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        date TEXT NOT NULL,
        tool TEXT NOT NULL,
        review_quality TEXT NOT NULL,
        review_score REAL NOT NULL DEFAULT 0,
        is_reviewed INTEGER NOT NULL DEFAULT 0,
        lines_generated INTEGER NOT NULL DEFAULT 0,
        characters_count INTEGER NOT NULL DEFAULT 0,
        agent_session_id TEXT,
        is_agent_generated INTEGER NOT NULL DEFAULT 0,
        was_file_open INTEGER NOT NULL DEFAULT 0,
        first_generated_at INTEGER NOT NULL,
        last_reviewed_at INTEGER,
        total_review_time INTEGER NOT NULL DEFAULT 0,
        language TEXT,
        modification_count INTEGER NOT NULL DEFAULT 0,
        total_time_in_focus INTEGER NOT NULL DEFAULT 0,
        scroll_event_count INTEGER NOT NULL DEFAULT 0,
        cursor_movement_count INTEGER NOT NULL DEFAULT 0,
        edits_made INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        review_sessions_count INTEGER NOT NULL DEFAULT 0,
        reviewed_in_terminal INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        UNIQUE(file_path, date, tool)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exclusion_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        globs_json TEXT NOT NULL,
        source TEXT NOT NULL
      )
    `);

    // Migrate existing tables: Add new columns to events table
    this.safeAddColumn("events", "review_quality", "TEXT");
    this.safeAddColumn("events", "review_quality_score", "REAL");
    this.safeAddColumn("events", "is_reviewed", "INTEGER DEFAULT 0");
    this.safeAddColumn("events", "is_agent_mode", "INTEGER DEFAULT 0");
    this.safeAddColumn("events", "agent_session_id", "TEXT");

    // Migrate existing tables: Add new columns to daily_metrics table
    // Use NULL (not 0) for undefined values - 0 means "bad", NULL means "N/A"
    this.safeAddColumn("daily_metrics", "review_quality_score", "REAL");
    this.safeAddColumn("daily_metrics", "unreviewed_lines", "INTEGER");
    this.safeAddColumn("daily_metrics", "unreviewed_percentage", "REAL");
    this.safeAddColumn(
      "daily_metrics",
      "agent_session_count",
      "INTEGER DEFAULT 0",
    );
    this.safeAddColumn(
      "daily_metrics",
      "total_ai_suggestions",
      "INTEGER DEFAULT 0",
    );

    // Migration: Add file review time columns to daily_metrics
    this.safeAddColumn("daily_metrics", "average_file_review_time", "REAL");
    this.safeAddColumn("daily_metrics", "reviewed_files_count", "INTEGER");
  }

  private createIndices(): void {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const indices = [
      { name: "idx_events_timestamp", table: "events", column: "timestamp" },
      { name: "idx_events_tool", table: "events", column: "tool" },
      { name: "idx_events_session", table: "events", column: "session_id" },
      {
        name: "idx_events_agent_session",
        table: "events",
        column: "agent_session_id",
      },
      {
        name: "idx_events_assignment",
        table: "events",
        column: "assignment_id",
      },
      {
        name: "idx_events_classification",
        table: "events",
        column: "ai_classification",
      },
      {
        name: "idx_events_violation",
        table: "events",
        column: "policy_violation",
      },
      { name: "idx_tool_metrics_date", table: "tool_metrics", column: "date" },
      {
        name: "idx_agent_sessions_start_time",
        table: "agent_sessions",
        column: "start_time",
      },
      {
        name: "idx_agent_sessions_tool",
        table: "agent_sessions",
        column: "tool",
      },
      {
        name: "idx_agent_sessions_was_reviewed",
        table: "agent_sessions",
        column: "was_reviewed",
      },
      {
        name: "idx_file_review_status_file_path",
        table: "file_review_status",
        column: "file_path",
      },
      {
        name: "idx_file_review_status_date",
        table: "file_review_status",
        column: "date",
      },
      {
        name: "idx_file_review_status_is_reviewed",
        table: "file_review_status",
        column: "is_reviewed",
      },
      {
        name: "idx_file_review_status_agent_session",
        table: "file_review_status",
        column: "agent_session_id",
      },
    ];

    for (const index of indices) {
      try {
        if (this.columnExists(index.table, index.column)) {
          // pi-lens-ignore: sql-injection
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table}(${index.column})`,
          );
        }
      } catch (error) {
        // Ignore index creation errors on old databases with missing columns
        console.warn(
          `[CodePause] Failed to create index ${index.name}:`,
          error,
        );
      }
    }
  }

  private columnExists(table: string, column: string): boolean {
    if (!this.db) {
      return false;
    }

    try {
      this.validateSqlIdentifier(table, "table name");
      this.validateSqlIdentifier(column, "column name");

      const stmt = this.db.prepare(`PRAGMA table_info(${table})`);
      const columns: string[] = [];

      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        columns.push(row.name as string);
      }
      stmt.free();

      return columns.includes(column);
    } catch (error) {
      return false;
    }
  }

  async insertEvent(event: TrackingEvent): Promise<number> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT INTO events (
        timestamp, tool, event_type, lines_of_code, lines_removed, characters_count,
        acceptance_time_delta, file_path, language, session_id, metadata,
        review_quality, review_quality_score, is_reviewed, is_agent_mode, agent_session_id,
        source, detection_method, confidence, lines_changed,
        assignment_id, ai_classification, policy_violation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
      event.timestamp,
      event.tool,
      event.eventType,
      event.linesOfCode ?? null,
      event.linesRemoved ?? null, // NEW: Lines removed
      event.charactersCount ?? null,
      event.acceptanceTimeDelta ?? null,
      // Anonymize at rest (workspace-relative / ~-relative)
      this.pathAnonymizer.toStorage(event.filePath) ?? null,
      event.language ?? null,
      event.sessionId ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.reviewQuality ?? null,
      event.reviewQualityScore ?? null,
      event.isReviewed ? 1 : 0,
      event.isAgentMode ? 1 : 0,
      event.agentSessionId ?? null,
      event.source ?? null, // NEW: Unified source tracking (ai/manual)
      event.detectionMethod ?? null, // NEW: Detection method metadata
      event.confidence ?? null, // NEW: Detection confidence level
      event.linesChanged ?? null, // NEW: Total changes for review scoring
      event.assignmentId ?? null,
      event.aiClassification ?? null,
      event.policyViolation ?? null,
    ]);

    stmt.step();
    const lastId = this.db.exec("SELECT last_insert_rowid() as id")[0]
      .values[0][0] as number;
    stmt.free();

    this.incrementOperations();
    return lastId;
  }

  async getEvents(
    startDate: string,
    endDate: string,
  ): Promise<TrackingEvent[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Resolve to LOCAL day boundaries. `new Date('2026-01-15')` parses as UTC
    // midnight, which put a local date string against a UTC boundary and
    // mis-bucketed events for every non-UTC user.
    const startTimestamp = startOfLocalDay(startDate);
    const endTimestamp = startOfLocalDay(addDays(endDate, 1));

    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE timestamp >= ? AND timestamp < ?
      ORDER BY timestamp DESC
    `);

    stmt.bind([startTimestamp, endTimestamp]);

    const rows: EventRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as EventRecord);
    }
    stmt.free();

    return rows.map((r) => this.mapEventRecordToEvent(r));
  }

  async getSessionEvents(sessionId: string): Promise<TrackingEvent[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);

    stmt.bind([sessionId]);

    const rows: EventRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as EventRecord);
    }
    stmt.free();

    return rows.map((r) => this.mapEventRecordToEvent(r));
  }

  async getRecentEvents(limit: number): Promise<TrackingEvent[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM events
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    stmt.bind([limit]);

    const rows: EventRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as EventRecord);
    }
    stmt.free();

    return rows.map((r) => this.mapEventRecordToEvent(r));
  }

  async getDailyMetrics(date: string): Promise<DailyMetrics | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM daily_metrics WHERE date = ?
    `);

    stmt.bind([date]);

    let row: DailyMetricsRecord | undefined;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      row = stmt.getAsObject() as unknown as DailyMetricsRecord;
    }
    stmt.free();

    if (!row) {
      return null;
    }

    const toolBreakdown = await this.getToolMetrics(date);

    return this.mapDailyMetricsRecordToMetrics(row, toolBreakdown);
  }

  async getDailyMetricsRange(
    startDate: string,
    endDate: string,
  ): Promise<DailyMetrics[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM daily_metrics
      WHERE date >= ? AND date <= ?
      ORDER BY date DESC
    `);

    stmt.bind([startDate, endDate]);

    const rows: DailyMetricsRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as DailyMetricsRecord);
    }
    stmt.free();

    const metricsWithTools = await Promise.all(
      rows.map(async (row) => {
        const toolBreakdown = await this.getToolMetrics(row.date);
        return this.mapDailyMetricsRecordToMetrics(row, toolBreakdown);
      }),
    );

    return metricsWithTools;
  }

  async insertOrUpdateDailyMetrics(metrics: DailyMetrics): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO daily_metrics (
        date, total_events, total_ai_suggestions, total_ai_lines, total_manual_lines,
        ai_percentage, average_review_time,
        session_count,
        review_quality_score, unreviewed_lines, unreviewed_percentage,
        average_file_review_time, reviewed_files_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      metrics.date,
      metrics.totalEvents,
      metrics.totalAISuggestions,
      metrics.totalAILines,
      metrics.totalManualLines,
      metrics.aiPercentage,
      metrics.averageReviewTime,
      metrics.sessionCount,
      // Use null for undefined values (not 0!)
      metrics.reviewQualityScore !== undefined
        ? metrics.reviewQualityScore
        : null,
      metrics.unreviewedLines !== undefined ? metrics.unreviewedLines : null,
      metrics.unreviewedPercentage !== undefined
        ? metrics.unreviewedPercentage
        : null,
      metrics.averageFileReviewTime !== undefined
        ? metrics.averageFileReviewTime
        : null,
      metrics.reviewedFilesCount !== undefined
        ? metrics.reviewedFilesCount
        : null,
    ]);

    for (const toolMetrics of Object.values(metrics.toolBreakdown)) {
      await this.insertOrUpdateToolMetrics(metrics.date, toolMetrics);
    }
  }

  async getToolMetrics(date: string): Promise<Record<AITool, ToolMetrics>> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM tool_metrics WHERE date = ?
    `);

    stmt.bind([date]);

    const rows: ToolMetricsRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as ToolMetricsRecord);
    }
    stmt.free();

    const breakdown: Record<string, ToolMetrics> = {};

    for (const row of rows) {
      breakdown[row.tool] = {
        tool: row.tool as AITool,
        suggestionCount: row.suggestion_count,
        acceptedCount: row.accepted_count,
        rejectedCount: row.rejected_count,
        linesGenerated: row.lines_generated,
        averageReviewTime: row.average_review_time,
      };
    }

    return breakdown as Record<AITool, ToolMetrics>;
  }

  async insertOrUpdateToolMetrics(
    date: string,
    metrics: ToolMetrics,
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tool_metrics (
        date, tool, suggestion_count, accepted_count, rejected_count,
        lines_generated, average_review_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      date,
      metrics.tool,
      metrics.suggestionCount,
      metrics.acceptedCount,
      metrics.rejectedCount,
      metrics.linesGenerated,
      metrics.averageReviewTime,
    ]);
  }

  async insertOrUpdateSession(session: CodingSession): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, start_time, end_time, duration, event_count,
        ai_lines_generated, manual_lines_written, tools_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      session.id,
      session.startTime,
      session.endTime ?? null,
      session.duration ?? null,
      session.eventCount,
      session.aiLinesGenerated,
      session.manualLinesWritten,
      JSON.stringify(session.toolsUsed),
    ]);
  }

  async getSession(sessionId: string): Promise<CodingSession | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    stmt.bind([sessionId]);

    let row: SessionRecord | undefined;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      row = stmt.getAsObject() as unknown as SessionRecord;
    }
    stmt.free();

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time ?? undefined,
      duration: row.duration ?? undefined,
      eventCount: row.event_count,
      aiLinesGenerated: row.ai_lines_generated,
      manualLinesWritten: row.manual_lines_written,
      // Security: Safe JSON parsing with fallback
      toolsUsed: safeJsonParse(row.tools_used, []),
    };
  }

  async getRecentSessions(limit: number): Promise<CodingSession[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      ORDER BY start_time DESC
      LIMIT ?
    `);

    stmt.bind([limit]);

    const rows: SessionRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as SessionRecord);
    }
    stmt.free();

    return rows.map((row) => ({
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time ?? undefined,
      duration: row.duration ?? undefined,
      eventCount: row.event_count,
      aiLinesGenerated: row.ai_lines_generated,
      manualLinesWritten: row.manual_lines_written,
      // Security: Safe JSON parsing with fallback
      toolsUsed: safeJsonParse(row.tools_used, []),
    }));
  }

  async getAllAchievements(): Promise<Achievement[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`SELECT * FROM achievements`);

    const rows: AchievementRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as AchievementRecord);
    }
    stmt.free();

    return rows.map((row) => ({
      id: row.id,
      title: "",
      description: "",
      category: "review" as const,
      icon: "",
      requirement: {
        type: "count" as const,
        metric: "",
        target: 0,
      },
      unlocked: row.unlocked === 1,
      unlockedAt: row.unlocked_at ?? undefined,
      progress: row.progress,
    }));
  }

  async updateAchievement(
    achievementId: string,
    unlocked: boolean,
    progress: number,
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO achievements (id, unlocked, unlocked_at, progress)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run([
      achievementId,
      unlocked ? 1 : 0,
      unlocked ? Date.now() : null,
      progress,
    ]);
  }

  async getConfig(key: string): Promise<unknown> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`SELECT value FROM config WHERE key = ?`);

    stmt.bind([key]);

    let row: ConfigRecord | undefined;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      row = stmt.getAsObject() as unknown as ConfigRecord;
    }
    stmt.free();

    if (!row) {
      return null;
    }

    // Security: Safe JSON parsing with fallback to raw value
    const parsed = safeJsonParse(row.value, null);
    return parsed !== null ? parsed : row.value;
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value)
      VALUES (?, ?)
    `);

    const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
    stmt.run([key, jsonValue]);
  }

  async getSnoozeState(): Promise<SnoozeState> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`SELECT * FROM snooze_state WHERE id = 1`);

    let row: SnoozeStateRecord | undefined;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      row = stmt.getAsObject() as unknown as SnoozeStateRecord;
    }
    stmt.free();

    if (!row) {
      return { snoozed: false };
    }

    return {
      snoozed: row.snoozed === 1,
      snoozeUntil: row.snooze_until ?? undefined,
      snoozeReason: row.snooze_reason ?? undefined,
    };
  }

  async setSnoozeState(state: SnoozeState): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      UPDATE snooze_state
      SET snoozed = ?, snooze_until = ?, snooze_reason = ?
      WHERE id = 1
    `);

    stmt.run([
      state.snoozed ? 1 : 0,
      state.snoozeUntil ?? null,
      state.snoozeReason ?? null,
    ]);
  }

  async getAlertHistory(alertType: string): Promise<AlertHistory | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM alert_history WHERE alert_type = ?
    `);

    stmt.bind([alertType]);

    let row: AlertHistoryRecord | undefined;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      row = stmt.getAsObject() as unknown as AlertHistoryRecord;
    }
    stmt.free();

    if (!row) {
      return null;
    }

    return {
      alertType: row.alert_type as AlertType,
      lastShown: row.last_shown,
      count: row.count,
    };
  }

  async updateAlertHistory(
    alertType: string,
    timestamp: number,
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT INTO alert_history (alert_type, last_shown, count)
      VALUES (?, ?, 1)
      ON CONFLICT(alert_type) DO UPDATE SET
        last_shown = ?,
        count = count + 1
    `);

    stmt.run([alertType, timestamp, timestamp]);
  }

  private mapEventRecordToEvent(record: EventRecord): TrackingEvent {
    return {
      id: record.id,
      timestamp: record.timestamp,
      tool: record.tool as AITool,
      eventType: record.event_type as EventType,
      linesOfCode: record.lines_of_code ?? undefined,
      linesRemoved: record.lines_removed ?? undefined,
      linesChanged: record.lines_changed ?? undefined,
      charactersCount: record.characters_count ?? undefined,
      acceptanceTimeDelta: record.acceptance_time_delta ?? undefined,
      // Resolve anonymized path back to absolute for in-memory use
      filePath:
        this.pathAnonymizer.fromStorage(record.file_path ?? undefined) ??
        undefined,
      language: record.language ?? undefined,
      sessionId: record.session_id ?? undefined,
      // Security: Safe JSON parsing with error handling
      metadata: safeJsonParse(record.metadata, undefined),
      reviewQuality: record.review_quality as ReviewQuality | undefined,
      reviewQualityScore: record.review_quality_score ?? undefined,
      isReviewed: record.is_reviewed === 1,
      isAgentMode: record.is_agent_mode === 1,
      agentSessionId: record.agent_session_id ?? undefined,
      // NEW: Phase 2 unified source tracking
      source: record.source ? (record.source as CodeSource) : undefined,
      detectionMethod: record.detection_method ?? undefined,
      confidence: record.confidence as "high" | "medium" | "low" | undefined,
      // Assignment tracking
      assignmentId: record.assignment_id ?? undefined,
      aiClassification: record.ai_classification
        ? (record.ai_classification as AIClassification)
        : undefined,
      policyViolation: record.policy_violation
        ? (record.policy_violation as PolicyViolationType)
        : undefined,
    };
  }

  private mapDailyMetricsRecordToMetrics(
    record: DailyMetricsRecord,
    toolBreakdown: Record<AITool, ToolMetrics>,
  ): DailyMetrics {
    return {
      date: record.date,
      totalEvents: record.total_events,
      totalAISuggestions: record.total_ai_suggestions ?? 0,
      totalAILines: record.total_ai_lines,
      totalManualLines: record.total_manual_lines,
      aiPercentage: record.ai_percentage,
      averageReviewTime: record.average_review_time,
      sessionCount: record.session_count,
      toolBreakdown,
      reviewQualityScore: record.review_quality_score ?? undefined,
      unreviewedLines: record.unreviewed_lines ?? undefined,
      unreviewedPercentage: record.unreviewed_percentage ?? undefined,
      agentSessionCount: record.agent_session_count ?? undefined,
      averageFileReviewTime: record.average_file_review_time ?? undefined,
      reviewedFilesCount: record.reviewed_files_count ?? undefined,
    };
  }

  async getStats(): Promise<{
    totalEvents: number;
    totalSessions: number;
    databaseSize: number;
  }> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const eventsStmt = this.db.prepare("SELECT COUNT(*) as count FROM events");
    let eventsCount = { count: 0 };
    if (eventsStmt.step()) {
      eventsCount = eventsStmt.getAsObject() as { count: number };
    }
    eventsStmt.free();

    const sessionsStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM sessions",
    );
    let sessionsCount = { count: 0 };
    if (sessionsStmt.step()) {
      sessionsCount = sessionsStmt.getAsObject() as { count: number };
    }
    sessionsStmt.free();

    const fs = require("fs");
    let dbSize = 0;
    try {
      const stats = fs.statSync(this.dbPath);
      dbSize = stats.size;
    } catch {
      // Ignore errors getting file size
    }

    return {
      totalEvents: eventsCount.count,
      totalSessions: sessionsCount.count,
      databaseSize: dbSize,
    };
  }

  /**
   * Count total events in database
   * Used by DataRetentionManager
   */
  async countEvents(): Promise<number> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM events");
    let result = { count: 0 };
    if (stmt.step()) {
      result = stmt.getAsObject() as { count: number };
    }
    stmt.free();

    return result.count;
  }

  /**
   * Delete events older than a specific timestamp
   * @param timestamp Unix timestamp in milliseconds
   * @returns Number of deleted records
   */
  async deleteEventsBefore(timestamp: number): Promise<number> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare("DELETE FROM events WHERE timestamp < ?");
    stmt.bind([timestamp]);
    stmt.step();
    stmt.free();

    // Get count of deleted rows using changes() function
    const changesStmt = this.db.prepare("SELECT changes() as deleted");
    let deletedCount = { deleted: 0 };
    if (changesStmt.step()) {
      deletedCount = changesStmt.getAsObject() as { deleted: number };
    }
    changesStmt.free();

    // Save database after deletion
    this.incrementOperations();
    this.sync();

    return deletedCount.deleted;
  }

  /**
   * Record a change to the user-supplied exclusion list (tamper-evidence).
   * Written whenever `codePause.excludedGlobs` changes and when assignments
   * are activated/deactivated, so assignment reports can show exactly what
   * was ignored during the assignment window.
   */
  async recordExclusionAudit(
    timestamp: number,
    globs: string[],
    source: string,
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      "INSERT INTO exclusion_audit (timestamp, globs_json, source) VALUES (?, ?, ?)",
    );
    stmt.bind([timestamp, JSON.stringify(globs), source]);
    stmt.step();
    stmt.free();
    this.incrementOperations();
  }

  /**
   * Get exclusion audit entries within [since, until].
   */
  async getExclusionAudit(
    since: number,
    until: number,
  ): Promise<
    Array<{ id: number; timestamp: number; globs: string[]; source: string }>
  > {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      "SELECT id, timestamp, globs_json, source FROM exclusion_audit WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
    );
    stmt.bind([since, until]);

    const rows: Array<{
      id: number;
      timestamp: number;
      globs: string[];
      source: string;
    }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as {
        id: number;
        timestamp: number;
        globs_json: string;
        source: string;
      };
      let globs: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.globs_json);
        if (Array.isArray(parsed)) {
          globs = parsed.filter((g): g is string => typeof g === "string");
        }
      } catch {
        // Corrupt row - surface as empty rather than failing the report
      }
      rows.push({
        id: row.id,
        timestamp: row.timestamp,
        globs,
        source: row.source,
      });
    }
    stmt.free();

    return rows;
  }

  /**
   * Lightweight scan of all events for purge operations.
   * Returns only id/path/timestamp so large databases can be filtered in JS
   * with ExcludedPaths.isExcludedFile (SQL LIKE cannot do segment matching).
   */
  async getAllEventPaths(): Promise<
    Array<{ id: number; file_path: string | null; timestamp: number }>
  > {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      "SELECT id, file_path, timestamp FROM events",
    );
    const rows: Array<{ id: number; file_path: string | null; timestamp: number }> = [];
    while (stmt.step()) {
      rows.push(
        stmt.getAsObject() as unknown as {
          id: number;
          file_path: string | null;
          timestamp: number;
        },
      );
    }
    stmt.free();

    return rows;
  }

  /**
   * Delete events by id in chunks (SQLite limits bound variables).
   * @returns Number of deleted records
   */
  async deleteEventsByIds(ids: number[]): Promise<number> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    if (ids.length === 0) {
      return 0;
    }

    let deleted = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `DELETE FROM events WHERE id IN (${placeholders})`,
      );
      stmt.bind(chunk);
      stmt.step();
      stmt.free();

      const changesStmt = this.db.prepare("SELECT changes() as deleted");
      if (changesStmt.step()) {
        deleted += (changesStmt.getAsObject() as { deleted: number }).deleted;
      }
      changesStmt.free();
    }

    this.incrementOperations();
    this.sync();

    return deleted;
  }

  /**
   * Lightweight scan of all file review rows for purge operations.
   */
  async getAllFileReviewPaths(): Promise<
    Array<{ id: number; file_path: string; date: string }>
  > {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      "SELECT id, file_path, date FROM file_review_status",
    );
    const rows: Array<{ id: number; file_path: string; date: string }> = [];
    while (stmt.step()) {
      rows.push(
        stmt.getAsObject() as unknown as {
          id: number;
          file_path: string;
          date: string;
        },
      );
    }
    stmt.free();

    return rows;
  }

  /**
   * Delete file review rows by id in chunks.
   * @returns Number of deleted records
   */
  async deleteFileReviewsByIds(ids: number[]): Promise<number> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    if (ids.length === 0) {
      return 0;
    }

    let deleted = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `DELETE FROM file_review_status WHERE id IN (${placeholders})`,
      );
      stmt.bind(chunk);
      stmt.step();
      stmt.free();

      const changesStmt = this.db.prepare("SELECT changes() as deleted");
      if (changesStmt.step()) {
        deleted += (changesStmt.getAsObject() as { deleted: number }).deleted;
      }
      changesStmt.free();
    }

    this.incrementOperations();
    this.sync();

    return deleted;
  }

  /**
   * Get the oldest event in database
   */
  async getOldestEvent(): Promise<{ timestamp: number } | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      "SELECT timestamp FROM events ORDER BY timestamp ASC LIMIT 1",
    );
    let result: { timestamp: number } | null = null;

    if (stmt.step()) {
      const row = stmt.getAsObject() as { timestamp: number };
      result = { timestamp: row.timestamp };
    }
    stmt.free();

    return result;
  }

  /**
   * Get the newest event in database
   */
  async getNewestEvent(): Promise<{ timestamp: number } | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      "SELECT timestamp FROM events ORDER BY timestamp DESC LIMIT 1",
    );
    let result: { timestamp: number } | null = null;

    if (stmt.step()) {
      const row = stmt.getAsObject() as { timestamp: number };
      result = { timestamp: row.timestamp };
    }
    stmt.free();

    return result;
  }

  /**
   * Get events within a date range
   * @param startDate Unix timestamp in milliseconds
   * @param endDate Unix timestamp in milliseconds
   * @returns Array of tracking events
   */
  async getEventsByDateRange(
    startDate: number,
    endDate: number,
  ): Promise<TrackingEvent[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC
    `);
    stmt.bind([startDate, endDate]);

    const events: TrackingEvent[] = [];
    while (stmt.step()) {
      const record = stmt.getAsObject() as EventRecord;
      events.push(this.mapEventRecordToEvent(record));
    }
    stmt.free();

    return events;
  }

  // ========== Assignment CRUD Methods ==========

  async insertOrUpdateAssignment(assignment: Assignment): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO assignments (
        id, name, course_id, start_date, end_date, repo_url, policy, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      assignment.id,
      assignment.name,
      assignment.courseId ?? null,
      assignment.startDate,
      assignment.endDate,
      assignment.repoUrl ?? null,
      JSON.stringify(assignment.policy),
      assignment.isActive ? 1 : 0,
      assignment.createdAt,
      assignment.updatedAt,
    ]);
  }

  async getAssignment(id: string): Promise<Assignment | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`SELECT * FROM assignments WHERE id = ?`);
    stmt.bind([id]);

    let row: AssignmentRecord | undefined;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      row = stmt.getAsObject() as unknown as AssignmentRecord;
    }
    stmt.free();

    if (!row) {
      return null;
    }
    return this.mapAssignmentRecordToAssignment(row);
  }

  async getAssignments(): Promise<Assignment[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      `SELECT * FROM assignments ORDER BY created_at DESC`,
    );

    const rows: AssignmentRecord[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      rows.push(stmt.getAsObject() as unknown as AssignmentRecord);
    }
    stmt.free();

    return rows.map((r) => this.mapAssignmentRecordToAssignment(r));
  }

  async getActiveAssignment(): Promise<Assignment | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(
      `SELECT * FROM assignments WHERE is_active = 1 LIMIT 1`,
    );

    let row: AssignmentRecord | undefined;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      row = stmt.getAsObject() as unknown as AssignmentRecord;
    }
    stmt.free();

    if (!row) {
      return null;
    }
    return this.mapAssignmentRecordToAssignment(row);
  }

  /**
   * Globs that should be exempt from authorship accounting right now.
   *
   * Prefers the active assignment's own policy so the dashboard and the
   * assignment report agree (issue #5). Falls back to the built-in default
   * policy when no assignment is active, so README/markdown stay exempt even
   * for someone who has not set an assignment up.
   */
  async getActiveExemptFileGlobs(): Promise<string[]> {
    try {
      const assignment = await this.getActiveAssignment();
      if (assignment?.policy?.exemptFileGlobs?.length) {
        return assignment.policy.exemptFileGlobs;
      }
    } catch (error) {
      // A missing/uninitialised assignments table must not take down metrics.
    }

    return this.createDefaultAssignmentPolicy().exemptFileGlobs;
  }

  async setActiveAssignment(id: string | null): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // First deactivate all
    this.db.exec(`UPDATE assignments SET is_active = 0`);

    if (id) {
      const stmt = this.db.prepare(
        `UPDATE assignments SET is_active = 1, updated_at = ? WHERE id = ?`,
      );
      stmt.run([Date.now(), id]);
    }
  }

  async getEventsForAssignment(
    assignment: Assignment,
  ): Promise<TrackingEvent[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Events explicitly tagged with this assignment, plus untagged events
    // recorded inside the assignment window (e.g. work done before the
    // assignment was created or while it was inactive). Events tagged to a
    // different assignment are never pulled in. The window end includes the
    // full end day, matching PolicyEngine.detectTrackingGaps.
    // Local day boundaries, consistent with PolicyEngine.detectTrackingGaps and
    // the daily-metrics range. All three must agree or a graded report can
    // disagree with the dashboard it was exported from.
    const windowStart = startOfLocalDay(assignment.startDate);
    const windowEnd = startOfLocalDay(addDays(assignment.endDate, 1));

    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE assignment_id = ?
         OR (assignment_id IS NULL AND timestamp >= ? AND timestamp < ?)
      ORDER BY timestamp ASC
    `);
    stmt.bind([assignment.id, windowStart, windowEnd]);

    const events: TrackingEvent[] = [];
    while (stmt.step()) {
      const record = stmt.getAsObject() as EventRecord;
      events.push(this.mapEventRecordToEvent(record));
    }
    stmt.free();

    return events;
  }

  private mapAssignmentRecordToAssignment(
    record: AssignmentRecord,
  ): Assignment {
    return {
      id: record.id,
      name: record.name,
      courseId: record.course_id ?? undefined,
      startDate: record.start_date,
      endDate: record.end_date,
      repoUrl: record.repo_url ?? undefined,
      policy: safeJsonParse(
        record.policy,
        this.createDefaultAssignmentPolicy(),
      ),
      isActive: record.is_active === 1,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  private createDefaultAssignmentPolicy(): AssignmentPolicy {
    return {
      maxAuthorshipPercentage: 30,
      minOwnershipScore: 40,
      exemptFileGlobs: [
        "**/README*",
        "**/*.md",
        "**/package.json",
        "**/package-lock.json",
        "**/yarn.lock",
        "**/pnpm-lock.yaml",
      ],
      prohibitedMethods: [
        AIDetectionMethod.ExternalFileChange,
        AIDetectionMethod.GitCommitMarker,
      ],
      permittedMethods: [AIDetectionMethod.InlineCompletionAPI],
      flaggedMethods: [
        AIDetectionMethod.LargePaste,
        AIDetectionMethod.ChangeVelocity,
      ],
      minLargePasteReviewTimeMs: 5000,
      maxTrackingGapSeconds: 1800,
    };
  }

  // ========== NEW: Agent Session CRUD Methods ==========

  async insertAgentSession(session: AgentSession): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      INSERT INTO agent_sessions (
        id, tool, start_time, end_time, duration, file_count, total_lines, total_characters,
        was_reviewed, review_quality, review_score, review_time, detection_signals,
        confidence, files_affected, alert_shown, alert_shown_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
      session.id,
      session.tool,
      session.startTime,
      session.endTime ?? null,
      session.duration ?? null,
      session.fileCount,
      session.totalLines,
      session.totalCharacters,
      session.wasReviewed ? 1 : 0,
      session.reviewQuality ?? null,
      session.reviewScore ?? null,
      session.reviewTime ?? null,
      JSON.stringify(session.detectionSignals),
      session.confidence,
      // Anonymize each affected file path at rest
      JSON.stringify(
        session.filesAffected.map((p) => this.pathAnonymizer.toStorage(p) ?? p),
      ),
      session.alertShown ? 1 : 0,
      session.alertShownAt ?? null,
      session.metadata ? JSON.stringify(session.metadata) : null,
    ]);

    stmt.step();
    stmt.free();
    this.incrementOperations();
  }

  async getAgentSession(sessionId: string): Promise<AgentSession | null> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
    stmt.bind([sessionId]);

    let session: AgentSession | null = null;
    if (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      const record = stmt.getAsObject() as unknown as AgentSessionRecord;
      session = this.mapAgentSessionRecordToSession(record);
    }

    stmt.free();
    return session;
  }

  async getRecentAgentSessions(limit: number = 10): Promise<AgentSession[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM agent_sessions
      ORDER BY start_time DESC
      LIMIT ?
    `);
    stmt.bind([limit]);

    const sessions: AgentSession[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      const record = stmt.getAsObject() as unknown as AgentSessionRecord;
      sessions.push(this.mapAgentSessionRecordToSession(record));
    }

    stmt.free();
    return sessions;
  }

  private mapAgentSessionRecordToSession(
    record: AgentSessionRecord,
  ): AgentSession {
    return {
      id: record.id,
      tool: record.tool as AITool,
      startTime: record.start_time,
      endTime: record.end_time ?? undefined,
      duration: record.duration ?? undefined,
      fileCount: record.file_count,
      totalLines: record.total_lines,
      totalCharacters: record.total_characters,
      wasReviewed: record.was_reviewed === 1,
      reviewQuality: record.review_quality as ReviewQuality | undefined,
      reviewScore: record.review_score ?? undefined,
      reviewTime: record.review_time ?? undefined,
      detectionSignals: safeJsonParse(record.detection_signals, {
        rapidFileChanges: false,
        closedFileModifications: false,
        bulkCodeGeneration: false,
        gitCommitSignature: false,
        consistentSource: false,
      }),
      confidence: record.confidence as any,
      // Resolve anonymized paths back to absolute
      filesAffected: safeJsonParse<string[]>(record.files_affected, []).map(
        (p) => this.pathAnonymizer.fromStorage(p) ?? p,
      ),
      alertShown: record.alert_shown === 1,
      alertShownAt: record.alert_shown_at ?? undefined,
      metadata: safeJsonParse(record.metadata, undefined),
    };
  }

  // ========== NEW: File Review Status CRUD Methods ==========

  async insertOrUpdateFileReviewStatus(
    status: FileReviewStatus,
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Preserve manually marked as reviewed status
    // If the file is already marked as reviewed in the database, keep it that way
    // This prevents periodic aggregation from overwriting manual reviews
    //
    // IMPORTANT: sql.js returns arrays, not objects. Column indices:
    // 0: id, 1: file_path, 2: date, 3: tool, 4: review_quality, 5: review_score, 6: is_reviewed
    // Anonymize once; used for the existing-record lookup and the write below
    const storedPath = this.pathAnonymizer.toStorage(status.filePath);

    const rawRecord = this.db
      .prepare(`
      SELECT * FROM file_review_status
      WHERE file_path = ? AND date = ? AND tool = ?
    `)
      .get([storedPath, status.date, status.tool]);

    // sql.js returns an array, not an object with named properties
    const existingRecord = rawRecord as number[] | undefined;
    const existingIsReviewed = existingRecord?.[6]; // Index 6 = is_reviewed column
    const existingReviewScore = existingRecord?.[5]; // Index 5 = review_score column
    const existingReviewQuality = existingRecord?.[4]; // Index 4 = review_quality column
    // Index 9 = agent_session_id column (may be string or null in DB)
    const existingAgentSessionId = existingRecord?.[9] as
      | string
      | null
      | undefined;

    // Check if this is the SAME agent session or a NEW one
    // If it's a new agent session, the file was modified again and needs re-review
    //
    // CRITICAL FIX: Only consider it a "new modification" if it's a different session
    // If it's the same agent session continuing work, preserve reviewed status
    const hasDifferentSession =
      existingAgentSessionId !== null &&
      existingAgentSessionId !== undefined &&
      status.agentSessionId !== undefined &&
      status.agentSessionId !== existingAgentSessionId;

    const isNewModification = hasDifferentSession;

    // CRITICAL FIX: Separate preservation of is_reviewed vs review_score/quality
    //
    // For is_reviewed:
    // - If new modification: Set to false (file needs re-review)
    // - If same modification: Preserve existing reviewed status
    const wasManuallyReviewed = existingRecord && existingIsReviewed === 1;
    const shouldPreserveReviewedStatus =
      wasManuallyReviewed && !isNewModification;
    const finalIsReviewed = shouldPreserveReviewedStatus
      ? true
      : status.isReviewed;

    // Get existing review data
    // Index 14 = total_review_time in the original table schema
    const existingTotalReviewTime = existingRecord?.[14] || 0;

    // For review_score and review_quality:
    // - ALWAYS preserve if they exist (partial review data is valuable!)
    // - Even if new modification, the ALREADY REVIEWED portion still has value
    // - Only use status values if no existing values (or explicitly provided)
    const shouldPreserveReviewData =
      existingRecord &&
      ((existingReviewScore ?? 0) > 0 || existingTotalReviewTime > 0);
    const finalReviewScore =
      shouldPreserveReviewData && existingReviewScore
        ? existingReviewScore
        : status.reviewScore;
    const finalReviewQuality =
      shouldPreserveReviewData && existingReviewQuality
        ? existingReviewQuality
        : status.reviewQuality;

    // Handle lines_since_review tracking
    // - MetricsCollector.ts already accumulates linesSinceReview before sending to database
    // - Database should just store the value as-is, NOT accumulate again (would cause double accumulation)
    // - If status.linesSinceReview is undefined (from periodic aggregation), preserve existing value
    // - If file is being marked as reviewed, reset lines_since_review to 0
    //
    // IMPORTANT: Column indices after migrations (in order of addition):
    // 0-22: original columns, 23: created_at, 24: updated_at, 25: reviewed_in_terminal,
    // 26: lines_changed, 27: review_method, 28: lines_since_review, 29: lines_added, 30: lines_removed
    const existingLinesSinceReview = existingRecord?.[28] || 0; // Index 28 = lines_since_review column
    const existingLinesAdded = existingRecord?.[29] || 0; // Index 29 = lines_added column
    const existingLinesRemoved = existingRecord?.[30] || 0; // Index 30 = lines_removed column
    let finalLinesSinceReview: number;

    // Check if linesSinceReview was explicitly provided (not undefined)
    // undefined = from periodic aggregation, preserve existing value
    // number = from actual event, use as-is (already accumulated by MetricsCollector)
    const isLinesSinceReviewProvided = status.linesSinceReview !== undefined;

    if (!finalIsReviewed) {
      // File is NOT reviewed
      if (isLinesSinceReviewProvided) {
        // From actual event - use value as-is (MetricsCollector already accumulated)
        // Event 1: receives 123, stores 123
        // Event 2: receives 216 (already 123+93), stores 216 (NOT 123+216)
        finalLinesSinceReview = status.linesSinceReview ?? 0;
      } else {
        // From periodic aggregation - preserve existing value
        finalLinesSinceReview = existingLinesSinceReview;
      }
    } else {
      // File is reviewed - reset to 0
      finalLinesSinceReview = 0;
    }

    // CRITICAL FIX: Preserve linesAdded and linesRemoved from existing record
    // if not explicitly provided in the status object.
    // This prevents periodic aggregation from resetting these values to 0.
    const isLinesAddedProvided = status.linesAdded !== undefined;
    const isLinesRemovedProvided = status.linesRemoved !== undefined;
    const finalLinesAdded = isLinesAddedProvided
      ? (status.linesAdded ?? 0)
      : existingLinesAdded;
    const finalLinesRemoved = isLinesRemovedProvided
      ? (status.linesRemoved ?? 0)
      : existingLinesRemoved;

    // CRITICAL FIX: Preserve total_review_time - ALWAYS preserve if exists
    // Preserves time already spent reviewing, even if file needs re-review after new modifications
    const finalTotalReviewTime =
      shouldPreserveReviewData && existingTotalReviewTime > 0
        ? existingTotalReviewTime
        : status.totalReviewTime;

    // Always update updated_at timestamp to NOW
    // Preserve created_at from existing record (or use firstGeneratedAt for new records)
    const now = Date.now();
    const createdAt = existingRecord?.[23] || status.firstGeneratedAt; // Index 23 = created_at

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO file_review_status (
        file_path, date, tool, review_quality, review_score, is_reviewed,
        lines_generated, lines_changed, lines_since_review, lines_added, lines_removed, characters_count, agent_session_id, is_agent_generated,
        was_file_open, first_generated_at, last_reviewed_at, total_review_time,
        language, modification_count, total_time_in_focus, scroll_event_count,
        cursor_movement_count, edits_made, last_opened_at, review_sessions_count, reviewed_in_terminal,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
      storedPath,
      status.date,
      status.tool,
      finalReviewQuality,
      finalReviewScore,
      finalIsReviewed ? 1 : 0,
      status.linesGenerated,
      status.linesChanged ?? 0,
      finalLinesSinceReview,
      finalLinesAdded,
      finalLinesRemoved,
      status.charactersCount,
      status.agentSessionId ?? null,
      status.isAgentGenerated ? 1 : 0,
      status.wasFileOpen ? 1 : 0,
      status.firstGeneratedAt,
      status.lastReviewedAt ?? null,
      finalTotalReviewTime,
      status.language ?? null,
      status.modificationCount,
      status.totalTimeInFocus,
      status.scrollEventCount,
      status.cursorMovementCount,
      status.editsMade ? 1 : 0,
      status.lastOpenedAt ?? null,
      status.reviewSessionsCount,
      status.reviewedInTerminal ? 1 : 0,
      createdAt,
      now,
    ]);

    stmt.step();
    stmt.free();
    this.incrementOperations();
  }

  async getUnreviewedFiles(date: string): Promise<FileReviewStatus[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM file_review_status
      WHERE date = ? AND is_reviewed = 0
      ORDER BY first_generated_at DESC
    `);
    stmt.bind([date]);

    const files: FileReviewStatus[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      const record = stmt.getAsObject() as unknown as FileReviewStatusRecord;
      files.push(this.mapFileReviewStatusRecordToStatus(record));
    }

    stmt.free();
    return files;
  }

  async getAllFilesForDate(date: string): Promise<FileReviewStatus[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // AUTHORSHIP FIX: Get ALL files for a date (reviewed or not) for authorship calculation
    const stmt = this.db.prepare(`
      SELECT * FROM file_review_status
      WHERE date(first_generated_at / 1000, 'unixepoch') = ?
      ORDER BY first_generated_at DESC
    `);
    stmt.bind([date]);

    const files: FileReviewStatus[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      const record = stmt.getAsObject() as unknown as FileReviewStatusRecord;
      files.push(this.mapFileReviewStatusRecordToStatus(record));
    }

    stmt.free();
    return files;
  }

  async getTerminalReviewedFiles(date: string): Promise<FileReviewStatus[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Get terminal workflow files that haven't been opened in editor yet
    // These files have reviewed_in_terminal=1 but still unreviewed (score=0)
    const stmt = this.db.prepare(`
      SELECT * FROM file_review_status
      WHERE date = ? AND reviewed_in_terminal = 1 AND review_score = 0
      ORDER BY first_generated_at DESC
    `);
    stmt.bind([date]);

    const files: FileReviewStatus[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      const record = stmt.getAsObject() as unknown as FileReviewStatusRecord;
      files.push(this.mapFileReviewStatusRecordToStatus(record));
    }

    stmt.free();
    return files;
  }

  async getFileReviewsForDate(date: string): Promise<FileReviewStatus[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT * FROM file_review_status
      WHERE date = ?
      ORDER BY first_generated_at DESC
    `);
    stmt.bind([date]);

    const files: FileReviewStatus[] = [];
    while (stmt.step()) {
      // SAFETY: sql.js getAsObject() returns an untyped row object; the table schema guarantees the record shape.
      const record = stmt.getAsObject() as unknown as FileReviewStatusRecord;
      files.push(this.mapFileReviewStatusRecordToStatus(record));
    }

    stmt.free();
    return files;
  }

  private mapFileReviewStatusRecordToStatus(
    record: FileReviewStatusRecord,
  ): FileReviewStatus {
    return {
      // Resolve anonymized path back to absolute for in-memory use
      filePath:
        this.pathAnonymizer.fromStorage(record.file_path) ?? record.file_path,
      date: record.date,
      tool: record.tool as AITool,
      reviewQuality: record.review_quality as ReviewQuality,
      reviewScore: record.review_score,
      isReviewed: record.is_reviewed === 1,
      linesGenerated: record.lines_generated,
      linesChanged: record.lines_changed,
      linesSinceReview: record.lines_since_review,
      linesAdded: record.lines_added, // CRITICAL FIX: Map lines_added from database
      linesRemoved: record.lines_removed, // CRITICAL FIX: Map lines_removed from database
      charactersCount: record.characters_count,
      agentSessionId: record.agent_session_id ?? undefined,
      isAgentGenerated: record.is_agent_generated === 1,
      wasFileOpen: record.was_file_open === 1,
      firstGeneratedAt: record.first_generated_at,
      lastReviewedAt: record.last_reviewed_at ?? undefined,
      totalReviewTime: record.total_review_time,
      language: record.language ?? undefined,
      modificationCount: record.modification_count,
      totalTimeInFocus: record.total_time_in_focus,
      scrollEventCount: record.scroll_event_count,
      cursorMovementCount: record.cursor_movement_count,
      editsMade: record.edits_made === 1,
      lastOpenedAt: record.last_opened_at ?? undefined,
      reviewSessionsCount: record.review_sessions_count,
      reviewedInTerminal: record.reviewed_in_terminal === 1,
    };
  }

  async markFileAsReviewed(
    filePath: string,
    tool: string,
    date: string,
    developerLevel: string = "mid",
    reviewMethod: "manual" | "automatic" = "manual",
    actualReviewTime?: number,
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const now = Date.now();

    // Anonymize at rest so the lookup matches stored rows
    const storedPath = this.pathAnonymizer.toStorage(filePath);

    // CRITICAL FIX: Use actual review time if provided, otherwise calculate expected time
    // actualReviewTime comes from FileReviewSessionTracker (real time user spent)
    // expectedReviewTime is calculated based on lines (fallback for manual reviews)
    let finalReviewTime: number;

    if (actualReviewTime !== undefined && actualReviewTime > 0) {
      // Use actual time from tracking session
      finalReviewTime = actualReviewTime;
    } else {
      // Fallback: Calculate expected review time based on lines changed
      const fileQuery = this.db.prepare(`
        SELECT * FROM file_review_status
        WHERE file_path = ? AND tool = ? AND date = ?
      `);
      const fileData = fileQuery.get([storedPath, tool, date]) as
        | number[]
        | undefined;

      // Junior: 600ms per line, Mid: 400ms per line, Senior: 200ms per line
      const msPerLine =
        developerLevel === "senior"
          ? 200
          : developerLevel === "junior"
            ? 600
            : 400;

      // Use lines_changed if available, otherwise fall back to lines_generated
      const linesForReview = fileData?.[26] || fileData?.[7] || 50;
      finalReviewTime = Math.max(5000, linesForReview * msPerLine); // Min 5 seconds
    }

    const stmt = this.db.prepare(`
      UPDATE file_review_status
      SET is_reviewed = 1,
          review_score = 100,
          review_quality = 'thorough',
          review_method = ?,
          lines_since_review = 0,
          last_reviewed_at = ?,
          total_review_time = ?,
          updated_at = ?
      WHERE file_path = ? AND tool = ? AND date = ?
    `);

    stmt.run([reviewMethod, now, finalReviewTime, now, storedPath, tool, date]);
  }

  /**
   * Enable/disable reversible path anonymization for data at rest.
   * Driven by the `codePause.anonymizePaths` setting (default: true).
   *
   * NOTE: toggling only affects future writes. Rows written while disabled
   * keep their absolute form and are still resolved correctly on read.
   */
  setAnonymizePaths(enabled: boolean): void {
    this.pathAnonymizer.setEnabled(enabled);
  }

  isAnonymizePathsEnabled(): boolean {
    return this.pathAnonymizer.isEnabled();
  }

  /**
   * One-time migration: rewrite existing absolute file_path values in
   * anonymized form. Idempotent (toStorage is a no-op on already-anonymized
   * paths), and safe to run on every startup.
   *
   * This is what makes the setting honest for data collected before it was
   * implemented - otherwise old rows would keep leaking usernames forever.
   */
  migrateAnonymizeExistingPaths(): { events: number; fileReviews: number } {
    if (!this.db || !this.pathAnonymizer.isEnabled()) {
      return { events: 0, fileReviews: 0 };
    }

    let events = 0;
    let fileReviews = 0;

    try {
      const eventRows = this.db.prepare("SELECT id, file_path FROM events");
      const eventUpdates: Array<[string, number]> = [];
      while (eventRows.step()) {
        const row = eventRows.getAsObject() as unknown as {
          id: number;
          file_path: string | null;
        };
        if (!row.file_path) {
          continue;
        }
        const anonymized = this.pathAnonymizer.toStorage(row.file_path);
        if (anonymized && anonymized !== row.file_path) {
          eventUpdates.push([anonymized, row.id]);
        }
      }
      eventRows.free();

      const reviewRows = this.db.prepare(
        "SELECT id, file_path FROM file_review_status",
      );
      const reviewUpdates: Array<[string, number]> = [];
      while (reviewRows.step()) {
        const row = reviewRows.getAsObject() as unknown as {
          id: number;
          file_path: string | null;
        };
        if (!row.file_path) {
          continue;
        }
        const anonymized = this.pathAnonymizer.toStorage(row.file_path);
        if (anonymized && anonymized !== row.file_path) {
          reviewUpdates.push([anonymized, row.id]);
        }
      }
      reviewRows.free();

      for (const [filePath, id] of eventUpdates) {
        this.db
          .prepare("UPDATE events SET file_path = ? WHERE id = ?")
          .run([filePath, id]);
        events++;
      }
      for (const [filePath, id] of reviewUpdates) {
        this.db
          .prepare("UPDATE file_review_status SET file_path = ? WHERE id = ?")
          .run([filePath, id]);
        fileReviews++;
      }

      if (events > 0 || fileReviews > 0) {
        this.incrementOperations();
        this.sync();
        console.log(
          `[CodePause] Anonymized ${events} event path(s) and ${fileReviews} file review path(s)`,
        );
      }
    } catch (error) {
      console.error("[CodePause] Path anonymization migration failed:", error);
    }

    return { events, fileReviews };
  }
}
