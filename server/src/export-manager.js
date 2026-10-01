import path from "node:path";
import { promises as fs } from "node:fs";
import { newId } from "@cv/shared";
import { renderPdf, isReadablePdf } from "./pdf.js";
import {
  insertExport,
  updateExport,
  getExport,
  latestExportToken,
  getSnapshot,
} from "./db.js";

/**
 * Export job lifecycle.
 *
 * Tokens are monotonic per snapshot.  If a user exports twice quickly, the
 * first job becomes "superseded": when it finishes late (slow disk / retry)
 * its outcome is DISCARDED and never overwrites the newer export record or
 * file.  This directly handles the "旧任务迟到" requirement.
 */

export class ExportManager {
  constructor(db, { outDir = "./data/exports", clock = () => new Date() } = {}) {
    this.db = db;
    this.outDir = outDir;
    this.clock = clock;
    /** in-flight job -> abortable hooks (tests drive completion manually) */
    this.gates = new Map();
  }

  /** Test hook: block a job until release(id) is called. */
  gate(id) {
    return new Promise((resolve) => this.gates.set(id, resolve));
  }
  release(id, err) {
    const r = this.gates.get(id);
    if (r) {
      this.gates.delete(id);
      r(err);
    }
  }

  async enqueue(snapshotId, { format = "pdf", simulateWriteFailure = false, delayMs = 0 } = {}) {
    const snapshot = await getSnapshot(this.db, snapshotId);
    if (!snapshot) throw new Error("snapshot not found: " + snapshotId);

    const token = (await latestExportToken(this.db, snapshotId)) + 1;
    const id = newId("exp");
    const createdAt = this.clock().toISOString();
    await insertExport(this.db, {
      id,
      snapshotId,
      purpose: snapshot.purpose,
      format,
      status: "pending",
      path: null,
      error: null,
      token,
      superseded: false,
      bytes: null,
      createdAt,
      finishedAt: null,
    });

    // run async; callers may await finishExport(id) via pollExport
    this._run(id, snapshot, token, { format, simulateWriteFailure, delayMs }).catch(() => {});
    return { id, token };
  }

  async _run(id, snapshot, token, opts) {
    if (opts.delayMs) await sleep(opts.delayMs);
    const gateErr = this.gates.has(id) ? await this.gate(id) : null;

    // Late-task check #1: a newer job already exists -> stop, do not write.
    const newest = await latestExportToken(this.db, snapshot.id);
    if (token < newest) {
      await updateExport(this.db, id, {
        status: "failed",
        superseded: true,
        error: "superseded by newer export before write",
        finishedAt: this.clock().toISOString(),
      });
      return;
    }
    if (gateErr) {
      await this._fail(id, gateErr.message, token);
      return;
    }

    const fileName = `${snapshot.id}-${token}.pdf`;
    const filePath = path.join(this.outDir, fileName);
    try {
      const { bytes } = await renderPdf(snapshot.compiled, snapshot.metrics, filePath, {
        simulateWriteFailure: opts.simulateWriteFailure,
      });

      // Late-task check #2: while we were writing, a newer job finished.
      const newest2 = await latestExportToken(this.db, snapshot.id);
      if (token < newest2) {
        await fs.rm(filePath, { force: true });
        await updateExport(this.db, id, {
          status: "failed",
          superseded: true,
          error: "superseded by newer export after write",
          finishedAt: this.clock().toISOString(),
        });
        return;
      }

      await updateExport(this.db, id, {
        status: "succeeded",
        path: fileName,
        bytes: bytes.length,
        error: null,
        finishedAt: this.clock().toISOString(),
      });
    } catch (err) {
      await this._fail(id, err.message, token, filePath);
    }
  }

  async _fail(id, message, token, filePath) {
    // a failure never clobbers a newer successful export
    const rec = await getExport(this.db, id);
    if (rec && rec.token < (await latestExportToken(this.db, rec.snapshotId))) {
      await updateExport(this.db, id, {
        status: "failed",
        superseded: true,
        error: message,
        finishedAt: this.clock().toISOString(),
      });
      return;
    }
    // ensure no truncated partial is left behind
    if (filePath) await fs.rm(filePath, { force: true });
    await updateExport(this.db, id, {
      status: "failed",
      path: null,
      error: message,
      finishedAt: this.clock().toISOString(),
    });
  }

  async waitFor(id, { timeoutMs = 5000, intervalMs = 20 } = {}) {
    const start = Date.now();
    for (;;) {
      const rec = await getExport(this.db, id);
      if (rec && rec.status !== "pending") return rec;
      if (Date.now() - start > timeoutMs) throw new Error("export did not finish in time");
      await sleep(intervalMs);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { isReadablePdf };
