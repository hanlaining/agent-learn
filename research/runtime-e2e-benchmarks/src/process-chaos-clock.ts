import { readFileSync } from "node:fs";

const clockPath = process.env.PROCESS_CHAOS_CLOCK_PATH;

if (clockPath !== undefined) {
  const clockFilePath = clockPath;
  const NativeDate = Date;

  function offsetMilliseconds(): number {
    try {
      const value = Number(readFileSync(clockFilePath, "utf8").trim());
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  class ProcessChaosDate extends NativeDate {
    constructor(value?: string | number) {
      super(value === undefined ? NativeDate.now() + offsetMilliseconds() : value);
    }

    static override now(): number {
      return NativeDate.now() + offsetMilliseconds();
    }
  }

  globalThis.Date = ProcessChaosDate as DateConstructor;
}
