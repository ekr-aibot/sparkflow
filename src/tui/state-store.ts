import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobInfo } from "./types.js";

export interface PersistedJob {
  info: JobInfo;
  pid: number;
  logPath: string;
  logOffset: number;
  pendingRequestId?: string;
  /**
   * Arguments the job was originally started with, persisted so `restartJob`
   * still works after a daemon reload.
   */
  originalPlan?: string;
  originalPlanText?: string;
  originalCwd?: string;
}

export class StateStore {
  private dir: string;

  constructor(cwd: string) {
    this.dir = join(cwd, ".sparkflow", "state", "jobs");
    mkdirSync(this.dir, { recursive: true });
  }

  saveJob(job: PersistedJob): void {
    const path = join(this.dir, `${job.info.id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, path);
  }

  loadJobs(): PersistedJob[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    const jobs: PersistedJob[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.dir, name), "utf-8");
        jobs.push(JSON.parse(raw) as PersistedJob);
      } catch {
        // skip corrupt entry
      }
    }
    return jobs;
  }

  loadJob(id: string): PersistedJob | null {
    try {
      const raw = readFileSync(join(this.dir, `${id}.json`), "utf-8");
      return JSON.parse(raw) as PersistedJob;
    } catch {
      return null;
    }
  }

  removeJob(id: string): void {
    try {
      unlinkSync(join(this.dir, `${id}.json`));
    } catch {
      // ignore
    }
  }
}
