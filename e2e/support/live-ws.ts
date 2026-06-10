export interface JsonMessageObserver {
  waitForMessage(predicate: (message: unknown) => boolean): Promise<unknown>;
  close(): void;
}

interface MessageWaiter {
  predicate: (message: unknown) => boolean;
  resolve(message: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export async function connectJsonMessageObserver(
  url: string,
): Promise<JsonMessageObserver> {
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  const waiters: MessageWaiter[] = [];

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`failed to open live WebSocket at ${url}`)),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const message = parseMessage(event.data);
    messages.push(message);
    resolveWaitingMessage(message, waiters);
  });

  socket.addEventListener("error", () => {
    rejectWaitingMessages(
      waiters,
      new Error("LaneDeck live WebSocket emitted an error"),
    );
  });

  return {
    waitForMessage: (predicate) =>
      waitForBufferedOrNextMessage(messages, waiters, predicate),
    close: () => socket.close(),
  };
}

export function matchesBatchNotification(
  message: unknown,
  batchId: string,
): boolean {
  const object = jsonObject(message);
  if (object === undefined || typeof object.type !== "string") {
    return false;
  }

  return (
    object.batchId === batchId ||
    jsonObject(object.payload)?.batchId === batchId
  );
}

function waitForBufferedOrNextMessage(
  messages: readonly unknown[],
  waiters: MessageWaiter[],
  predicate: (message: unknown) => boolean,
): Promise<unknown> {
  const buffered = messages.find(predicate);
  if (buffered !== undefined) {
    return Promise.resolve(buffered);
  }

  return new Promise<unknown>((resolve, reject) => {
    const waiter: MessageWaiter = {
      predicate,
      resolve,
      reject,
      timeout: setTimeout(() => {
        removeWaiter(waiters, waiter);
        reject(
          new Error("timed out waiting for LaneDeck live WebSocket event"),
        );
      }, 5_000),
    };
    waiters.push(waiter);
  });
}

function resolveWaitingMessage(
  message: unknown,
  waiters: MessageWaiter[],
): void {
  for (const waiter of [...waiters]) {
    if (!waiter.predicate(message)) {
      continue;
    }

    clearTimeout(waiter.timeout);
    removeWaiter(waiters, waiter);
    waiter.resolve(message);
  }
}

function rejectWaitingMessages(waiters: MessageWaiter[], error: Error): void {
  for (const waiter of [...waiters]) {
    clearTimeout(waiter.timeout);
    removeWaiter(waiters, waiter);
    waiter.reject(error);
  }
}

function removeWaiter(waiters: MessageWaiter[], waiter: MessageWaiter): void {
  const index = waiters.indexOf(waiter);
  if (index >= 0) {
    waiters.splice(index, 1);
  }
}

function parseMessage(data: unknown): unknown {
  if (typeof data !== "string") {
    return data;
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
