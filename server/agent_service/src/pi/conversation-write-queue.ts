/**
 * Employees of a group share one working folder, so their file changes and commands run one at a
 * time, in call order. A waiting call can be aborted without giving up its neighbours' turns.
 */
export class ConversationWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(conversationId: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this.tails.set(conversationId, tail);
    try {
      await untilAborted(previous, signal);
      return await task();
    } finally {
      release();
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
    }
  }
}

function untilAborted(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return wait;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void wait.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
