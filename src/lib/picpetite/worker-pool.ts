/**
 * Worker pool — promise-based dispatch over N compression workers.
 *
 * Adapted from PicPetite's `apps/web/src/services/worker-pool.ts`.
 * Two changes from the original:
 *   1. Type imports come from `./types` instead of `@picpetite/shared`.
 *   2. The worker URL is `./compression.worker.ts` (sibling) instead of
 *      `../workers/compression.worker.ts`.
 *
 * Workers are spawned lazily — the constructor creates exactly one and the
 * pool grows up to `MAX_WORKERS` only as backpressure demands. For Yapgone's
 * single-user-uploading-1-to-5-images flow, the pool will rarely exceed 1.
 */
import type { CompressionTask, CompressionResult } from "./types";
import { memoryManager } from "./memory-manager";

interface PendingTask {
  task: CompressionTask;
  resolve: (result: CompressionResult) => void;
  reject: (error: Error) => void;
}

const isMobile = typeof navigator !== "undefined" && /Mobi|Android/i.test(navigator.userAgent);
const MOBILE_COOLDOWN_MS = 200;
const MAX_WORKERS = Math.min(navigator?.hardwareConcurrency || 4, 8);

export class WorkerPool {
  private workers: Worker[] = [];
  private pendingResponses = new Map<
    string,
    { resolve: (r: CompressionResult) => void; reject: (e: Error) => void }
  >();
  private taskQueue: PendingTask[] = [];
  private busyWorkers = new Set<number>();
  private maxWorkers: number;
  private rafHandle: number | null = null;
  private lastFrameTime = 0;

  constructor(maxWorkers: number = MAX_WORKERS) {
    this.maxWorkers = maxWorkers;
    this.spawnWorker(); // Start with 1 worker
  }

  private spawnWorker(): number {
    const worker = new Worker(new URL("./compression.worker.ts", import.meta.url), {
      type: "module",
    });

    const index = this.workers.length;
    this.workers.push(worker);

    worker.onmessage = (e) => {
      const { type, id, payload } = e.data;

      if (type === "READY") {
        this.processQueue();
        return;
      }

      if (type === "RESULT") {
        this.busyWorkers.delete(index);
        memoryManager.release();
        const pending = this.pendingResponses.get(id);
        if (pending) {
          this.pendingResponses.delete(id);
          pending.resolve({
            id,
            compressedBuffer: payload.compressedBuffer,
            width: payload.width,
            height: payload.height,
            format: payload.format,
          });
        }
        this.processQueue();
      }

      if (type === "ERROR") {
        this.busyWorkers.delete(index);
        memoryManager.release();
        const pending = this.pendingResponses.get(id);
        if (pending) {
          this.pendingResponses.delete(id);
          pending.reject(new Error(payload.message));
        }
        this.processQueue();
      }
    };

    // Initialize the worker
    worker.postMessage({ type: "INIT" });

    return index;
  }

  async dispatch(task: CompressionTask): Promise<CompressionResult> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ task, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue() {
    while (this.taskQueue.length > 0) {
      // Find a free worker
      let freeWorkerIndex = -1;
      for (let i = 0; i < this.workers.length; i++) {
        if (!this.busyWorkers.has(i)) {
          freeWorkerIndex = i;
          break;
        }
      }

      // Scale up if all workers busy and below max
      if (freeWorkerIndex === -1 && this.workers.length < this.maxWorkers) {
        freeWorkerIndex = this.spawnWorker();
        // Wait for INIT/READY before dispatching
        await new Promise<void>((r) => setTimeout(r, 50));
      }

      if (freeWorkerIndex === -1) break; // All workers busy

      // Acquire memory slot (blocks if at limit)
      await memoryManager.acquire();

      const pending = this.taskQueue.shift();
      if (!pending) {
        memoryManager.release();
        break;
      }

      this.busyWorkers.add(freeWorkerIndex);
      this.pendingResponses.set(pending.task.id, {
        resolve: pending.resolve,
        reject: pending.reject,
      });

      const { id, imageBuffer, sourceFormat, targetFormat, quality, stripMetadata, bgFillColor } =
        pending.task;

      // freeWorkerIndex is either an index we just located via the loop above
      // or one we just spawned, so the slot is guaranteed to exist.
      this.workers[freeWorkerIndex]!.postMessage(
        {
          type: "COMPRESS",
          id,
          payload: { imageBuffer, sourceFormat, targetFormat, quality, stripMetadata, bgFillColor },
        },
        { transfer: [imageBuffer] },
      );

      // Mobile cool-down
      if (isMobile) {
        await new Promise((r) => setTimeout(r, MOBILE_COOLDOWN_MS));
      }
    }
  }

  // Dynamic scaling based on main thread latency
  startLatencyMonitor() {
    const check = () => {
      const now = performance.now();
      if (this.lastFrameTime > 0) {
        const delta = now - this.lastFrameTime;
        if (delta > 50 && this.maxWorkers > 1) {
          // Main thread struggling — reduce pool
          this.maxWorkers = Math.max(1, this.maxWorkers - 1);
        } else if (delta < 16 && this.taskQueue.length > 0 && this.maxWorkers < MAX_WORKERS) {
          // Plenty of headroom and work waiting — scale up
          this.maxWorkers = Math.min(MAX_WORKERS, this.maxWorkers + 1);
        }
      }
      this.lastFrameTime = now;
      this.rafHandle = requestAnimationFrame(check);
    };
    this.rafHandle = requestAnimationFrame(check);
  }

  stopLatencyMonitor() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  terminate() {
    this.stopLatencyMonitor();
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.busyWorkers.clear();
    this.pendingResponses.clear();
    this.taskQueue = [];
  }
}
