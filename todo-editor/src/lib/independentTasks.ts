type Task<T> = {
  run: () => Promise<T>
  onSuccess: (value: T) => void | Promise<void>
  onError: (error: unknown) => void
  onFinally: () => void
}

/** Publish each result immediately; a failed task never discards a sibling result. */
export async function runIndependentTasks<T extends unknown[]>(tasks: { [K in keyof T]: Task<T[K]> }) {
  return Promise.allSettled(tasks.map(async task => {
    try { await task.onSuccess(await task.run()) }
    catch (error) { task.onError(error) }
    finally { task.onFinally() }
  }))
}
