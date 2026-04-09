/**
 * Concurrency throttling for the compression worker pool.
 *
 * Adapted from PicPetite's `apps/web/src/services/memory-manager.ts`.
 * The `MEMORY_BUFFER_LIMIT` constant (5) is inlined here instead of being
 * imported from a shared package — that's the only change.
 *
 * Limits how many large image buffers can be in flight simultaneously so a
 * user dragging in 5 photos at once doesn't OOM the tab on a low-memory phone.
 */

const MEMORY_BUFFER_LIMIT = 5;

type Resolver = () => void;

export class MemoryManager {
  private activeCount = 0;
  private maxBuffers: number;
  private waitQueue: Resolver[] = [];

  constructor(maxBuffers: number = MEMORY_BUFFER_LIMIT) {
    this.maxBuffers = maxBuffers;
  }

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxBuffers) {
      this.activeCount++;
      return;
    }

    // Block until a slot opens
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    this.activeCount--;

    if (this.waitQueue.length > 0 && this.activeCount < this.maxBuffers) {
      this.activeCount++;
      const next = this.waitQueue.shift()!;
      next();
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get waiting(): number {
    return this.waitQueue.length;
  }
}

export const memoryManager = new MemoryManager();
