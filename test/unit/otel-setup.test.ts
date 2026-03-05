import { OpenBoxSpanProcessor, setupOpenBoxOpenTelemetry } from "../../src/index.js";

describe("setupOpenBoxOpenTelemetry", () => {
  it("respects instrumentation toggles", async () => {
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const names = controller.instrumentations.map(
      instrumentation => instrumentation.instrumentationName
    );

    expect(names).not.toContain("@opentelemetry/instrumentation-fs");
    expect(names).not.toContain("@opentelemetry/instrumentation-pg");
    expect(names).not.toContain("@opentelemetry/instrumentation-http");

    await controller.shutdown();
  });

  it("selects only requested database instrumentations", async () => {
    const controller = setupOpenBoxOpenTelemetry({
      dbLibraries: new Set(["pg", "redis"]),
      instrumentDatabases: true,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const names = controller.instrumentations.map(
      instrumentation => instrumentation.instrumentationName
    );

    expect(names).toContain("@opentelemetry/instrumentation-http");
    expect(names).toContain("@opentelemetry/instrumentation-undici");
    expect(names).toContain("@opentelemetry/instrumentation-pg");
    expect(names).toContain("@opentelemetry/instrumentation-redis");
    expect(names).not.toContain("@opentelemetry/instrumentation-mysql");

    await controller.shutdown();
  });
});
