/**
 * SQLite persistence for multi-agent runs.
 *
 * Uses Node's built-in `node:sqlite` (Electron 42 / Node 24) — no native
 * dependency, nothing to bundle. The database lives in the mini tool's private
 * storage directory, so it survives extension updates and is removed with an
 * uninstall like any other runtime data.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DB_FILENAME = 'multi-agent.sqlite';

export type RunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export type TaskState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed', 'blocked', 'cancelled'];

export interface RunRecord {
  runId: string;
  goal: string;
  status: RunStatus;
  scopeId: string;
  coordinatorSessionId?: string;
  topic?: string;
  spaceId?: string;
  spaceName?: string;
  modelKey?: string;
  reasoningEffort?: string;
  maxParallel: number;
  background: boolean;
  documentId?: string;
  documentRevision?: number;
  reportArtifactId?: string;
  summaryArtifactId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRecord {
  runId: string;
  taskKey: string;
  title: string;
  prompt: string;
  deliverable?: string;
  dependsOn: string[];
  modelKey?: string;
  reasoningEffort?: string;
  state: TaskState;
  sessionId?: string;
  turnId?: string;
  collaborationTaskId?: string;
  taskVersion?: number;
  artifactId?: string;
  artifactHash?: string;
  effectiveModel?: string;
  /** Set when a requested model could not be matched, so the fallback is visible. */
  modelNote?: string;
  queuedMs?: number;
  waitRequestId?: string;
  waitKind?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface HandoffRecord {
  handoffId: string;
  runId: string;
  fromTask: string;
  toTask: string;
  artifactId?: string;
  summary?: string;
  state?: string;
  createdAt: number;
}

const RUN_COLUMNS = [
  'run_id', 'goal', 'status', 'scope_id', 'coordinator_session_id', 'topic',
  'space_id', 'space_name', 'model_key', 'reasoning_effort', 'max_parallel',
  'background', 'document_id', 'document_revision', 'report_artifact_id',
  'summary_artifact_id', 'error', 'created_at', 'updated_at',
] as const;

const TASK_COLUMNS = [
  'run_id', 'task_key', 'title', 'prompt', 'deliverable', 'depends_on',
  'model_key', 'reasoning_effort', 'state', 'session_id', 'turn_id',
  'collaboration_task_id', 'task_version', 'artifact_id', 'artifact_hash',
  'effective_model', 'model_note', 'queued_ms', 'wait_request_id', 'wait_kind', 'error',
  'started_at', 'finished_at', 'created_at', 'updated_at',
] as const;

/** Columns added after the first release; applied to an existing database. */
const ADDED_TASK_COLUMNS: readonly [string, string][] = [['model_note', 'TEXT']];

/** Column mapping for the camelCase patch keys accepted by `updateTask`. */
const TASK_PATCH_COLUMNS: Record<string, string> = {
  deliverable: 'deliverable',
  modelKey: 'model_key',
  reasoningEffort: 'reasoning_effort',
  state: 'state',
  sessionId: 'session_id',
  turnId: 'turn_id',
  collaborationTaskId: 'collaboration_task_id',
  taskVersion: 'task_version',
  artifactId: 'artifact_id',
  artifactHash: 'artifact_hash',
  effectiveModel: 'effective_model',
  modelNote: 'model_note',
  queuedMs: 'queued_ms',
  waitRequestId: 'wait_request_id',
  waitKind: 'wait_kind',
  error: 'error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

const RUN_PATCH_COLUMNS: Record<string, string> = {
  goal: 'goal',
  status: 'status',
  coordinatorSessionId: 'coordinator_session_id',
  topic: 'topic',
  spaceId: 'space_id',
  spaceName: 'space_name',
  modelKey: 'model_key',
  reasoningEffort: 'reasoning_effort',
  maxParallel: 'max_parallel',
  background: 'background',
  documentId: 'document_id',
  documentRevision: 'document_revision',
  reportArtifactId: 'report_artifact_id',
  summaryArtifactId: 'summary_artifact_id',
  error: 'error',
};

type Row = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function num(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function rowToRun(row: Row): RunRecord {
  return {
    runId: String(row.run_id),
    goal: String(row.goal),
    status: String(row.status) as RunStatus,
    scopeId: String(row.scope_id),
    coordinatorSessionId: str(row.coordinator_session_id),
    topic: str(row.topic),
    spaceId: str(row.space_id),
    spaceName: str(row.space_name),
    modelKey: str(row.model_key),
    reasoningEffort: str(row.reasoning_effort),
    maxParallel: num(row.max_parallel) ?? 2,
    background: bool(row.background),
    documentId: str(row.document_id),
    documentRevision: num(row.document_revision),
    reportArtifactId: str(row.report_artifact_id),
    summaryArtifactId: str(row.summary_artifact_id),
    error: str(row.error),
    createdAt: num(row.created_at) ?? 0,
    updatedAt: num(row.updated_at) ?? 0,
  };
}

function rowToTask(row: Row): TaskRecord {
  let dependsOn: string[] = [];
  try {
    const parsed = JSON.parse(String(row.depends_on ?? '[]'));
    if (Array.isArray(parsed)) dependsOn = parsed.map((v) => String(v));
  } catch {
    dependsOn = [];
  }
  return {
    runId: String(row.run_id),
    taskKey: String(row.task_key),
    title: String(row.title),
    prompt: String(row.prompt),
    deliverable: str(row.deliverable),
    dependsOn,
    modelKey: str(row.model_key),
    reasoningEffort: str(row.reasoning_effort),
    state: String(row.state) as TaskState,
    sessionId: str(row.session_id),
    turnId: str(row.turn_id),
    collaborationTaskId: str(row.collaboration_task_id),
    taskVersion: num(row.task_version),
    artifactId: str(row.artifact_id),
    artifactHash: str(row.artifact_hash),
    effectiveModel: str(row.effective_model),
    modelNote: str(row.model_note),
    queuedMs: num(row.queued_ms),
    waitRequestId: str(row.wait_request_id),
    waitKind: str(row.wait_kind),
    error: str(row.error),
    startedAt: num(row.started_at),
    finishedAt: num(row.finished_at),
    createdAt: num(row.created_at) ?? 0,
    updatedAt: num(row.updated_at) ?? 0,
  };
}

export class RunStore {
  private readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(storagePath: string) {
    // `ctx.storagePath` is handed to us before anything has written into it, so
    // the directory may not exist yet — SQLite refuses to create a file there.
    mkdirSync(storagePath, { recursive: true });
    this.dbPath = join(storagePath, DB_FILENAME);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 4000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        coordinator_session_id TEXT,
        topic TEXT,
        space_id TEXT,
        space_name TEXT,
        model_key TEXT,
        reasoning_effort TEXT,
        max_parallel INTEGER NOT NULL DEFAULT 2,
        background INTEGER NOT NULL DEFAULT 1,
        document_id TEXT,
        document_revision INTEGER,
        report_artifact_id TEXT,
        summary_artifact_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_by_coordinator ON runs (coordinator_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS tasks (
        run_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        deliverable TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]',
        model_key TEXT,
        reasoning_effort TEXT,
        state TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        collaboration_task_id TEXT,
        task_version INTEGER,
        artifact_id TEXT,
        artifact_hash TEXT,
        effective_model TEXT,
        model_note TEXT,
        queued_ms INTEGER,
        wait_request_id TEXT,
        wait_kind TEXT,
        error TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, task_key)
      );

      CREATE TABLE IF NOT EXISTS session_index (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_key TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_task TEXT NOT NULL,
        to_task TEXT NOT NULL,
        artifact_id TEXT,
        summary TEXT,
        state TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS handoffs_by_run ON handoffs (run_id, created_at);
    `);

    // A database written by an earlier build is missing whatever columns have
    // been added since; SQLite has no `ADD COLUMN IF NOT EXISTS`, so just try.
    for (const [column, type] of ADDED_TASK_COLUMNS) {
      try {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
      } catch {
        /* already present */
      }
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  insertRun(run: RunRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO runs (${RUN_COLUMNS.join(', ')})
       VALUES (${RUN_COLUMNS.map(() => '?').join(', ')})`,
    );
    stmt.run(
      run.runId, run.goal, run.status, run.scopeId,
      run.coordinatorSessionId ?? null, run.topic ?? null,
      run.spaceId ?? null, run.spaceName ?? null,
      run.modelKey ?? null, run.reasoningEffort ?? null,
      run.maxParallel, run.background ? 1 : 0,
      run.documentId ?? null, run.documentRevision ?? null,
      run.reportArtifactId ?? null, run.summaryArtifactId ?? null,
      run.error ?? null, run.createdAt, run.updatedAt,
    );
  }

  updateRun(runId: string, patch: Partial<RunRecord>): void {
    const entries = Object.entries(patch).filter(([key]) => key in RUN_PATCH_COLUMNS);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${RUN_PATCH_COLUMNS[key]} = ?`);
    const values = entries.map(([, value]) => (typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null)));
    this.db
      .prepare(`UPDATE runs SET ${assignments.join(', ')}, updated_at = ? WHERE run_id = ?`)
      .run(...(values as never[]), Date.now(), runId);
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(limit = 30, coordinatorSessionId?: string): RunRecord[] {
    const rows = coordinatorSessionId
      ? (this.db
          .prepare('SELECT * FROM runs WHERE coordinator_session_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(coordinatorSessionId, limit) as Row[])
      : (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]);
    return rows.map(rowToRun);
  }

  listActiveRuns(): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map(rowToRun);
  }

  deleteRun(runId: string): void {
    this.db.prepare('DELETE FROM handoffs WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM tasks WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM session_index WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
  }

  /** Drop the oldest finished runs so the database does not grow forever. */
  pruneRuns(keep = 60): void {
    const rows = this.db
      .prepare("SELECT run_id FROM runs WHERE status <> 'running' ORDER BY created_at DESC LIMIT -1 OFFSET ?")
      .all(keep) as Row[];
    for (const row of rows) this.deleteRun(String(row.run_id));
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /**
   * Insert a task, or overwrite it in place when a running task is re-tasked.
   *
   * Overwriting in place (rather than adding a second row) is what lets a
   * caller redirect an existing subtask: keep the same task key, keep the same
   * dependency edges, and let anything waiting on it pick the new result up.
   */
  upsertTask(task: TaskRecord): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO tasks (${TASK_COLUMNS.join(', ')})
       VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})`,
    );
    stmt.run(
      task.runId, task.taskKey, task.title, task.prompt,
      task.deliverable ?? null, JSON.stringify(task.dependsOn),
      task.modelKey ?? null, task.reasoningEffort ?? null, task.state,
      task.sessionId ?? null, task.turnId ?? null,
      task.collaborationTaskId ?? null, task.taskVersion ?? null,
      task.artifactId ?? null, task.artifactHash ?? null,
      task.effectiveModel ?? null, task.modelNote ?? null, task.queuedMs ?? null,
      task.waitRequestId ?? null, task.waitKind ?? null, task.error ?? null,
      task.startedAt ?? null, task.finishedAt ?? null,
      task.createdAt, task.updatedAt,
    );
  }

  updateTask(runId: string, taskKey: string, patch: Partial<TaskRecord>): void {
    const entries = Object.entries(patch).filter(([key]) => key in TASK_PATCH_COLUMNS);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${TASK_PATCH_COLUMNS[key]} = ?`);
    const values = entries.map(([, value]) => (value ?? null));
    this.db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')}, updated_at = ? WHERE run_id = ? AND task_key = ?`)
      .run(...(values as never[]), Date.now(), runId, taskKey);
  }

  getTask(runId: string, taskKey: string): TaskRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? AND task_key = ?')
      .get(runId, taskKey) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(runId: string): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(runId) as Row[];
    return rows.map(rowToTask);
  }

  // ── Session index ─────────────────────────────────────────────────────────

  indexSession(sessionId: string, runId: string, taskKey: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO session_index (session_id, run_id, task_key) VALUES (?, ?, ?)')
      .run(sessionId, runId, taskKey);
  }

  lookupSession(sessionId: string): { runId: string; taskKey: string } | undefined {
    const row = this.db
      .prepare('SELECT run_id, task_key FROM session_index WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return row ? { runId: String(row.run_id), taskKey: String(row.task_key) } : undefined;
  }

  // ── Handoffs ──────────────────────────────────────────────────────────────

  insertHandoff(handoff: HandoffRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO handoffs
         (handoff_id, run_id, from_task, to_task, artifact_id, summary, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff.handoffId, handoff.runId, handoff.fromTask, handoff.toTask,
        handoff.artifactId ?? null, handoff.summary ?? null, handoff.state ?? null,
        handoff.createdAt,
      );
  }

  listHandoffs(runId: string): HandoffRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM handoffs WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Row[];
    return rows.map((row) => ({
      handoffId: String(row.handoff_id),
      runId: String(row.run_id),
      fromTask: String(row.from_task),
      toTask: String(row.to_task),
      artifactId: str(row.artifact_id),
      summary: str(row.summary),
      state: str(row.state),
      createdAt: num(row.created_at) ?? 0,
    }));
  }
}
