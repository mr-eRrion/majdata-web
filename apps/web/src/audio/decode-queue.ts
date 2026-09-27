export type DecodeQueueResult<T> =
  | { status: 'completed'; generation: number; value: T }
  | { status: 'superseded'; generation: number }
  | { status: 'rejected'; generation: number; error: Error };

interface Job<TInput, TResult> {
  generation: number;
  input: TInput;
  resolve: (result: DecodeQueueResult<TResult>) => void;
}

/** Serializes non-cancellable decodes and retains only the newest waiting candidate. */
export class LatestDecodeQueue<TInput, TResult> {
  private generation = 0;
  private pending: Job<TInput, TResult> | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly decode: (input: TInput, isCurrent: () => boolean) => Promise<TResult>,
    private readonly options: {
      onSelection?: () => void;
      onAccepted?: (value: TResult, generation: number) => void;
      onDiscarded?: (value: TResult) => void;
    } = {},
  ) {}

  submit(input: TInput): Promise<DecodeQueueResult<TResult>> {
    const generation = ++this.generation;
    if (this.disposed) {
      return Promise.resolve({ status: 'rejected', generation, error: new Error('解码队列已释放') });
    }

    this.options.onSelection?.();
    if (this.pending) {
      this.pending.resolve({ status: 'superseded', generation: this.pending.generation });
    }

    const result = new Promise<DecodeQueueResult<TResult>>((resolve) => {
      this.pending = { generation, input, resolve };
    });
    this.pump();
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.pending) {
      this.pending.resolve({ status: 'superseded', generation: this.pending.generation });
      this.pending = null;
    }
  }

  private pump(): void {
    if (this.running || this.disposed || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.running = true;

    void this.run(job).finally(() => {
      this.running = false;
      this.pump();
    });
  }

  private async run(job: Job<TInput, TResult>): Promise<void> {
    const isCurrent = () => !this.disposed && job.generation === this.generation;
    try {
      const value = await this.decode(job.input, isCurrent);
      if (!isCurrent()) {
        this.options.onDiscarded?.(value);
        job.resolve({ status: 'superseded', generation: job.generation });
        return;
      }
      this.options.onAccepted?.(value, job.generation);
      job.resolve({ status: 'completed', generation: job.generation, value });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      job.resolve(isCurrent()
        ? { status: 'rejected', generation: job.generation, error }
        : { status: 'superseded', generation: job.generation });
    }
  }
}

