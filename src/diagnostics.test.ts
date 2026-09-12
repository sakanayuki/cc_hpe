import { describe, expect, it, vi } from "vitest";
import { copyDiagnostics, DiagnosticLog } from "./diagnostics";

describe("DiagnosticLog", () => {
  it("is a bounded ring buffer", () => {
    const log = new DiagnosticLog(2);
    log.add("info", "one");
    log.add("warning", "two");
    log.add("error", "three");
    expect(log.snapshot().map((entry) => entry.event)).toEqual([
      "two",
      "three",
    ]);
  });
  it("copies the environment and entries", async () => {
    const log = new DiagnosticLog();
    log.add("info", "done", { finalPoints: 42 });
    const writer = vi.fn(async (_text: string) => undefined);
    await copyDiagnostics(
      log,
      { appVersion: "1.2.3", userAgent: "test" },
      writer,
    );
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0][0]).toContain('"finalPoints":42');
    expect(writer.mock.calls[0][0]).toContain('"appVersion": "1.2.3"');
  });
  it("does not retain image data, object URLs, base64 or file paths", () => {
    const log = new DiagnosticLog();
    log.add("error", "safe", {
      imageData: "pixels",
      url: "blob:secret",
      payload: "data:image/png;base64,SECRET",
      message: "/home/person/photo.jpg failed",
    });
    const output = log.format({ appVersion: "1" });
    expect(output).not.toMatch(
      /pixels|blob:secret|base64,SECRET|person\/photo/,
    );
    expect(output).toContain("[redacted]");
  });
  it("clears every entry", () => {
    const log = new DiagnosticLog();
    log.add("info", "event");
    log.clear();
    expect(log.snapshot()).toEqual([]);
  });
});
