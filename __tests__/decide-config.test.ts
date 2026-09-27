import { describe, expect, it } from "@jest/globals";
import { parseDecideConfig, VERDICTS } from "../src/services/decide-config.js";

const good = {
  base_url: "http://127.0.0.1:8000",
  model: "jev-latest",
  timeout_ms: 15000,
  thresholds: { resolved: 0.85, unresolved: 0.5 },
};

describe("VERDICTS", () => {
  it("is the three-way vocabulary the thresholds map onto", () => {
    expect(VERDICTS).toEqual(["resolved", "review", "unresolved"]);
  });
});

describe("parseDecideConfig", () => {
  it("reads a complete document", () => {
    const config = parseDecideConfig(good);

    expect(config.baseUrl).toBe("http://127.0.0.1:8000");
    expect(config.thresholds).toEqual({ resolved: 0.85, unresolved: 0.5 });
  });

  // The band only exists if resolved sits strictly above unresolved. Inverted
  // thresholds would silently delete the review band and turn every decision
  // into resolved-or-unresolved, which is the opposite of the design.
  it("rejects thresholds that do not leave a review band", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.85 } })).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.5 } })).toThrow(/threshold/i);
  });

  it("rejects a threshold outside 0..1", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 1.5, unresolved: 0.5 } })).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.85, unresolved: -0.1 } })).toThrow(/threshold/i);
  });

  it("rejects a missing or non-string base url", () => {
    const { base_url: _drop, ...noUrl } = good;
    expect(() => parseDecideConfig(noUrl)).toThrow(/base_url/i);
    expect(() => parseDecideConfig({ ...good, base_url: 8000 })).toThrow(/base_url/i);
  });

  it("rejects a non-object document", () => {
    expect(() => parseDecideConfig(null)).toThrow();
    expect(() => parseDecideConfig("thresholds")).toThrow();
  });

  it("rejects an array as the top-level document", () => {
    expect(() => parseDecideConfig([1, 2, 3])).toThrow(/expected a YAML mapping/i);
  });

  it("rejects thresholds that is an array instead of an object", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: [0.85, 0.5] })).toThrow(/thresholds must be a mapping/i);
  });

  it("rejects a missing model field", () => {
    const { model: _drop, ...noModel } = good;
    expect(() => parseDecideConfig(noModel)).toThrow(/model/i);
  });

  it("rejects a non-string model field", () => {
    expect(() => parseDecideConfig({ ...good, model: 123 })).toThrow(/model/i);
  });

  it("rejects a missing timeout_ms field", () => {
    const { timeout_ms: _drop, ...noTimeout } = good;
    expect(() => parseDecideConfig(noTimeout)).toThrow(/timeout_ms/i);
  });

  it("rejects a non-numeric timeout_ms field", () => {
    expect(() => parseDecideConfig({ ...good, timeout_ms: "15000" })).toThrow(/timeout_ms/i);
  });

  it("rejects a non-finite timeout_ms field", () => {
    expect(() => parseDecideConfig({ ...good, timeout_ms: Infinity })).toThrow(/timeout_ms/i);
  });

  it("rejects a non-positive timeout_ms field", () => {
    expect(() => parseDecideConfig({ ...good, timeout_ms: 0 })).toThrow(/timeout_ms/i);
    expect(() => parseDecideConfig({ ...good, timeout_ms: -100 })).toThrow(/timeout_ms/i);
  });
});
