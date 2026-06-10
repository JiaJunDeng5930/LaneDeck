export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export type PickCopyResult =
  | { status: "copied"; pickId: string }
  | { status: "failed"; pickId: string; error: unknown };

export class PickerController {
  private enabled = false;

  constructor(private readonly clipboard: ClipboardWriter) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async copyPickId(pickId: string): Promise<PickCopyResult> {
    try {
      await this.clipboard.writeText(pickId);
      return { status: "copied", pickId };
    } catch (error) {
      return { status: "failed", pickId, error };
    }
  }
}

export function createNavigatorClipboardWriter(
  clipboard: Clipboard | undefined = globalThis.navigator?.clipboard,
): ClipboardWriter {
  return {
    async writeText(text: string): Promise<void> {
      if (clipboard === undefined) {
        throw new Error("clipboard is unavailable");
      }
      await clipboard.writeText(text);
    },
  };
}
