/**
 * First-run environment setup for the three native engines this mini tool needs.
 *
 * The state machine lives here, deliberately free of engine specifics, so it can
 * be driven from `activate()` (and tested) without touching the network. Its
 * snapshot outlives any panel: a run started while the App View is open keeps
 * going after the user navigates away, and a fresh page picks the progress back
 * up by asking for the current snapshot.
 */

export type EnvironmentStepStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface EnvironmentStep {
  id: string;
  status: EnvironmentStepStatus;
  /** Optional components do not block the library; they keep installing in the background. */
  optional: boolean;
  /** Live message from the installer, e.g. "Downloading …". */
  message?: string;
  /** 0–100 when the installer reports one. */
  percent?: number;
  /** Short note shown next to a finished step, e.g. the pinned version. */
  detail?: string;
  /** Failure text, shown verbatim so it can be pasted into a conversation. */
  error?: string;
}

export interface EnvironmentSnapshot {
  running: boolean;
  /** Every component, optional included, is ready. */
  ready: boolean;
  /** Enough is installed to use the library; only optional work may remain. */
  usable: boolean;
  steps: EnvironmentStep[];
  startedAt?: number;
  finishedAt?: number;
}

export interface EnvironmentTask {
  id: string;
  /** Cheap presence check — no network, no downloads. */
  probe: () => boolean | Promise<boolean>;
  /** Installs and verifies; may return a short detail string. */
  install: (report: (message: string, percent?: number) => void) => Promise<string | void>;
  /** Version shown for a component that is already present. */
  version?: string;
  /** Marks a component the library can run without, so setup need not block on it. */
  optional?: boolean;
}

export class EnvironmentManager {
  private steps: EnvironmentStep[];
  private running: Promise<EnvironmentSnapshot> | null = null;
  private startedAt?: number;
  private finishedAt?: number;
  /** Components confirmed present at least once here, so re-verifying them never revokes usability. */
  private readonly everReady = new Set<string>();

  constructor(
    private readonly tasks: EnvironmentTask[],
    private readonly onChange: (snapshot: EnvironmentSnapshot) => void = () => {},
  ) {
    this.steps = tasks.map((task) => ({ id: task.id, status: 'pending', optional: Boolean(task.optional) }));
  }

  snapshot(): EnvironmentSnapshot {
    // A required component that is merely being re-checked stays usable; one that failed does not.
    const usable = this.steps.every((step) => {
      if (step.optional) return true;
      if (step.status === 'failed') return false;
      return step.status === 'ready' || this.everReady.has(step.id);
    });
    return {
      running: this.running !== null,
      ready: this.steps.every((step) => step.status === 'ready'),
      usable,
      steps: this.steps.map((step) => ({ ...step })),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.finishedAt === undefined ? {} : { finishedAt: this.finishedAt }),
    };
  }

  private step(id: string): EnvironmentStep {
    const found = this.steps.find((item) => item.id === id);
    if (!found) throw new Error(`Unknown environment step: ${id}`);
    return found;
  }

  /** Marks already-present components ready without touching the network. */
  async probe(): Promise<EnvironmentSnapshot> {
    if (this.running) return this.snapshot();
    for (const task of this.tasks) {
      let installed = false;
      try { installed = await task.probe(); } catch { installed = false; }
      const step = this.step(task.id);
      if (installed && step.status === 'pending') {
        step.status = 'ready';
        step.detail = task.version;
        this.everReady.add(step.id);
      } else if (!installed && step.status === 'ready') {
        // Something removed the files behind our back; fall back to needing setup.
        step.status = 'pending';
        step.detail = undefined;
        this.everReady.delete(step.id);
      }
    }
    this.emit();
    return this.snapshot();
  }

  /**
   * Runs every component in turn. A second call while one is in flight joins the
   * existing run instead of starting a duplicate download.
   */
  install(force = false): Promise<EnvironmentSnapshot> {
    if (this.running) return this.running;
    const run = this.execute(force).then(() => {
      if (this.running === run) this.running = null;
      return this.snapshot();
    });
    this.running = run;
    return run;
  }

  private async execute(force: boolean): Promise<void> {
    this.startedAt = Date.now();
    this.finishedAt = undefined;
    for (const task of this.tasks) await this.runStep(task, force);
    this.finishedAt = Date.now();
    this.emit();
  }

  private async runStep(task: EnvironmentTask, force: boolean): Promise<void> {
    const step = this.step(task.id);
    if (!force) {
      let installed = false;
      try { installed = await task.probe(); } catch { installed = false; }
      if (installed) {
        step.status = 'ready';
        step.detail = task.version;
        step.message = undefined;
        step.percent = undefined;
        step.error = undefined;
        this.everReady.add(step.id);
        this.emit();
        return;
      }
    }
    step.status = 'running';
    step.message = undefined;
    step.percent = undefined;
    step.error = undefined;
    this.emit();
    try {
      const detail = await task.install((message, percent) => {
        step.message = message;
        if (typeof percent === 'number') step.percent = percent;
        this.emit();
      });
      step.status = 'ready';
      step.detail = detail || task.version;
      step.message = undefined;
      step.percent = 100;
      this.everReady.add(step.id);
      this.emit();
    } catch (error) {
      step.status = 'failed';
      step.message = undefined;
      step.percent = undefined;
      step.error = error instanceof Error ? error.message : String(error);
      this.emit();
    }
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }
}
