import { AsyncLocalStorage } from "node:async_hooks";

interface ActiveNativeTargetOperation {
  owner: object;
  threadId: string;
}

const activeOperation = new AsyncLocalStorage<ActiveNativeTargetOperation>();

/** Serialize target selection and work within one AgentBrowser's mutable CDP page projection. */
const operationTails = new WeakMap<object, Promise<void>>();

export function withNativeBrowserTargetLock<T>(
  owner: object,
  threadId: string,
  bindTarget: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  const current = activeOperation.getStore();
  if (current?.owner === owner && current.threadId === threadId) return operation();

  const previous = operationTails.get(owner) ?? Promise.resolve();
  const result = previous.then(async () => {
    await bindTarget();
    return activeOperation.run({ owner, threadId }, operation);
  });
  operationTails.set(
    owner,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
