export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Both official stream parsers use this fetch; heartbeats detect a silent, half-open socket. */
export const fetchSessionStream: typeof fetch = async (input, init) => {
  const timeout = new AbortController();
  const signal = AbortSignal.any([timeout.signal, ...(init?.signal ? [init.signal] : [])]);
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => timeout.abort(new DOMException("Stream timed out", "TimeoutError")),
      60_000,
    );
  };
  touch();
  const clear = () => clearTimeout(timer);
  signal.addEventListener("abort", clear, { once: true });
  try {
    const response = await fetch(input, { ...init, signal });
    if (!response.ok || !response.body) {
      clear();
      signal.removeEventListener("abort", clear);
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            clear();
            signal.removeEventListener("abort", clear);
            controller.close();
          } else {
            touch();
            controller.enqueue(value);
          }
        } catch (error) {
          clear();
          signal.removeEventListener("abort", clear);
          controller.error(timeout.signal.aborted ? timeout.signal.reason : error);
        }
      },
      cancel(reason) {
        clear();
        signal.removeEventListener("abort", clear);
        return reader.cancel(reason);
      },
    });
    return new Response(body, response);
  } catch (error) {
    clear();
    signal.removeEventListener("abort", clear);
    throw timeout.signal.aborted ? timeout.signal.reason : error;
  }
};

/** Retry observation only. Commands must never enter this loop. */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = "status" in error ? error.status : undefined;
  if (typeof status === "number") return [408, 425, 429, 500, 502, 503, 504].includes(status);
  return error instanceof TypeError || error.name === "TimeoutError";
}

export function waitForSessionDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One owner for initial connection, resubscription, cancellation and backoff. */
export function createSessionConnection(options: {
  observe: (signal: AbortSignal, connected: () => void) => Promise<void>;
  onState: (state: ConnectionState, error?: unknown) => void;
  online: () => boolean;
}) {
  let controller: AbortController | undefined;
  let ready: Promise<void> | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  let hasConnected = false;

  const disconnect = () => {
    const previous = controller;
    controller = undefined;
    ready = undefined;
    previous?.abort();
    rejectReady?.(previous?.signal.reason ?? new DOMException("Disconnected", "AbortError"));
    rejectReady = undefined;
    options.onState("disconnected");
  };
  const connect = (): Promise<void> => {
    if (ready) return ready;
    if (!options.online()) {
      options.onState("disconnected");
      return Promise.reject(new TypeError("Offline"));
    }
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    let resolveReady!: () => void;
    let established = false;
    const resetReady = () => {
      const promise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      ready = promise;
      void promise.catch(() => undefined);
      return promise;
    };
    const initialReady = resetReady();
    void (async () => {
      let attempts = 0;
      while (!signal.aborted) {
        options.onState(hasConnected ? "reconnecting" : "connecting");
        try {
          await options.observe(signal, () => {
            signal.throwIfAborted();
            hasConnected = true;
            established = true;
            attempts = 0;
            options.onState("connected");
            resolveReady();
          });
          throw new TypeError("Session stream ended");
        } catch (error) {
          if (signal.aborted) return;
          if (!isConnectionError(error)) {
            controller = undefined;
            ready = undefined;
            rejectReady?.(error);
            options.onState("disconnected", error);
            return;
          }
          if (established) {
            established = false;
            resetReady();
          }
          options.onState(hasConnected ? "reconnecting" : "connecting");
          await waitForSessionDelay(Math.min(1000 * 2 ** Math.min(attempts++, 5), 30_000), signal);
        }
      }
    })().catch((error) => {
      if (!signal.aborted) {
        rejectReady?.(error);
        options.onState("disconnected", error);
      }
    });
    return initialReady;
  };
  return {
    connect,
    disconnect,
    reconnect: () => {
      disconnect();
      return connect();
    },
  };
}
