export class ExecutionLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(executionId: string, attemptId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${executionId}:${attemptId}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

const executionLocksSymbol = Symbol.for("openclaw.flowosExecutionRuntimeLocks");

export function getExecutionLocks(): ExecutionLocks {
  const root = globalThis as typeof globalThis & { [executionLocksSymbol]?: ExecutionLocks };
  return (root[executionLocksSymbol] ??= new ExecutionLocks());
}
