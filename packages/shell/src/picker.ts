export type ClipboardWriter = (text: string) => Promise<void>;

export type PickCopyResult =
  | { status: "copied"; pickId: string }
  | { status: "failed"; pickId: string; error: unknown };

export async function copyPickId(
  clipboard: ClipboardWriter,
  pickId: string,
): Promise<PickCopyResult> {
  try {
    await clipboard(pickId);
    return { status: "copied", pickId };
  } catch (error) {
    return { status: "failed", pickId, error };
  }
}

export function createNavigatorClipboardWriter(
  clipboard: Clipboard | undefined = globalThis.navigator?.clipboard,
): ClipboardWriter {
  return async (text: string): Promise<void> => {
    if (clipboard === undefined) {
      throw new Error("clipboard is unavailable");
    }
    await clipboard.writeText(text);
  };
}
