export type DiagnosticLevel = "info" | "warning" | "error";

/** Deliberately accepts structured, allow-listed data only (never image/file data). */
export interface DiagnosticEntry {
  time: string;
  level: DiagnosticLevel;
  event: string;
  data: Record<string, string | number | boolean | null>;
}

export class DiagnosticLog {
  private entries: DiagnosticEntry[] = [];
  constructor(private readonly capacity = 100) {}

  add(
    level: DiagnosticLevel,
    event: string,
    data: DiagnosticEntry["data"] = {},
  ) {
    const safe = Object.fromEntries(
      Object.entries(data)
        .filter(([key]) => !/(image|file|path|url|base64)/i.test(key))
        .filter(
          ([, value]) =>
            ["string", "number", "boolean"].includes(typeof value) ||
            value === null,
        )
        .map(([key, value]) => [
          key,
          typeof value === "string" ? sanitizeText(value) : value,
        ]),
    );
    this.entries.push({
      time: new Date().toISOString(),
      level,
      event,
      data: safe,
    });
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity);
  }
  clear() {
    this.entries = [];
  }
  snapshot(): readonly DiagnosticEntry[] {
    return this.entries.map((entry) => ({ ...entry, data: { ...entry.data } }));
  }
  format(environment: Record<string, string | number | boolean>): string {
    return [
      "PoseSplat diagnostics",
      JSON.stringify(environment, null, 2),
      ...this.entries.map((entry) => JSON.stringify(entry)),
    ].join("\n");
  }
}

function sanitizeText(value: string) {
  return value
    .replace(/(?:blob:|data:)[^\s]+/gi, "[redacted]")
    .replace(
      /(?:[A-Za-z]:\\|\/(?:home|Users|workspace|tmp)\/)[^\s]+/g,
      "[redacted-path]",
    );
}

export async function copyDiagnostics(
  log: DiagnosticLog,
  environment: Record<string, string | number | boolean>,
  writeText: (text: string) => Promise<void> = (text) =>
    navigator.clipboard.writeText(text),
) {
  await writeText(log.format(environment));
}

export function browserEnvironment(version: string) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  const debug = gl?.getExtension("WEBGL_debug_renderer_info");
  return {
    appVersion: version,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    webglRenderer: gl
      ? String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))
      : "unavailable",
    webglVendor: gl
      ? String(gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR))
      : "unavailable",
    webglContextLost: gl?.isContextLost() ?? false,
  };
}
