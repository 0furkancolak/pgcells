/** Tenant-bound BullMQ queues. Job data is `{ tenantId, payload }`; for each job the worker sets up `db` with `createDbScope`.
 * Pass `redis.queue` (`maxRetriesPerRequest: null`) as the connection. On Redis Cluster use `prefix: "{bull}"`.
 * `onSpan`: `queue.add` and `queue.job` (tenantId, detail is the job name; `error` code on a failed job). */
import { AppError, type SpanHandler, validateTenantId } from "@0furkancolak/pgcells";
import { createDbScope, type Database, type PlacementCache, type RequestDb } from "@0furkancolak/pgcells/middleware";
import { type Job, type JobsOptions, Queue, type QueueOptions, UnrecoverableError, Worker, type WorkerOptions } from "bullmq";
import { endWith, startSpan } from "./span";

interface TenantJobData<T> {
  tenantId: string;
  payload: T;
}

function queueName(name: string) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new AppError("INVALID_QUEUE_NAME", "queue name must be a-z, 0-9 and hyphens");
  return name;
}

export function createTenantQueue<T>(name: string, { onSpan, ...options }: QueueOptions & { onSpan?: SpanHandler }) {
  const queue = new Queue<TenantJobData<T>>(queueName(name), options);
  return {
    queue,
    /** If `opts.jobId` is given it becomes `<tenantId>_<jobId>` (a tenant ID contains no `_`; BullMQ does not accept `:`). An invalid tenant ID throws synchronously. */
    add: (tenantId: string, jobName: string, payload: T, opts: JobsOptions = {}) => {
      const added = queue.add(jobName, { tenantId: validateTenantId(tenantId), payload }, opts.jobId ? { ...opts, jobId: `${tenantId}_${opts.jobId}` } : opts);
      return endWith(startSpan(onSpan, "queue.add", tenantId), added, jobName);
    },
    close: () => queue.close(),
  };
}

interface TenantWorkerOptions extends WorkerOptions {
  db: Database;
  /** E.g. `createPlacementCache(…).loadPlacement`. */
  placement?: PlacementCache;
  onSpan?: SpanHandler;
}

type TenantHandler<T, R> = (job: Job<TenantJobData<T>, R>, scope: { tenantId: string; db: RequestDb }) => Promise<R>;

/** A job with an invalid tenant ID fails without being retried. */
export function createTenantWorker<T, R = unknown>(name: string, handler: TenantHandler<T, R>, { db, placement, onSpan, ...options }: TenantWorkerOptions) {
  return new Worker<TenantJobData<T>, R>(
    queueName(name),
    (job) => {
      let tenantId: string;
      try {
        tenantId = validateTenantId(job.data.tenantId);
      } catch (error) {
        startSpan(onSpan, "queue.job")?.(job.name, error);
        throw new UnrecoverableError((error as Error).message);
      }
      const end = startSpan(onSpan, "queue.job", tenantId);
      return endWith(end, handler(job, { tenantId, db: createDbScope(db, tenantId, placement) }), job.name);
    },
    options,
  );
}
