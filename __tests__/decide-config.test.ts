import { describe, expect, it } from "@jest/globals";
import { join } from "node:path";
import { loadDecideConfig, parseDecideConfig, VERDICTS } from "../src/services/decide-config.js";

const good = {
  model: "jev-latest",
  timeout_ms: 15000,
  thresholds: { resolved: 0.85, unresolved: 0.5 },
};
const SCORER = "http://127.0.0.1:8010";

describe("VERDICTS", () => {
  it("is the three-way vocabulary the thresholds map onto", () => {
    expect(VERDICTS).toEqual(["resolved", "review", "unresolved"]);
  });
});

describe("parseDecideConfig", () => {
  it("reads a complete document", () => {
    const config = parseDecideConfig(good, SCORER);

    expect(config.baseUrl).toBe(SCORER);
    expect(config.thresholds).toEqual({ resolved: 0.85, unresolved: 0.5 });
  });

  // The band only exists if resolved sits strictly above unresolved. Inverted
  // thresholds would silently delete the review band and turn every decision
  // into resolved-or-unresolved, which is the opposite of the design.
  it("rejects thresholds that do not leave a review band", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.85 } }, SCORER)).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.5 } }, SCORER)).toThrow(/threshold/i);
  });

  it("rejects a threshold outside 0..1", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 1.5, unresolved: 0.5 } }, SCORER)).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.85, unresolved: -0.1 } }, SCORER)).toThrow(/threshold/i);
  });

  // The scorer's address lives in config/host.yaml. A base_url left here would be a second source
  // that silently disagrees with the one check-services.sh and run-jev.sh use.
  it("refuses a base_url, pointing at the host profile", () => {
    expect(() => parseDecideConfig({ ...good, base_url: "http://127.0.0.1:8010" }, SCORER)).toThrow(/host\.yaml/);
  });

  it("rejects a non-object document", () => {
    expect(() => parseDecideConfig(null, SCORER)).toThrow();
    expect(() => parseDecideConfig("thresholds", SCORER)).toThrow();
  });

  it("rejects an array as the top-level document", () => {
    expect(() => parseDecideConfig([1, 2, 3], SCORER)).toThrow(/expected a YAML mapping/i);
  });

  it("rejects thresholds that is an array instead of an object", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: [0.85, 0.5] }, SCORER)).toThrow(/thresholds must be a mapping/i);
  });

  it("rejects a missing model field", () => {
    const { model: _drop, ...noModel } = good;
    expect(() => parseDecideConfig(noModel, SCORER)).toThrow(/model/i);
  });

  it("rejects a non-string model field", () => {
    expect(() => parseDecideConfig({ ...good, model: 123 }, SCORER)).toThrow(/model/i);
  });

  it("rejects a missing timeout_ms field", () => {
    const { timeout_ms: _drop, ...noTimeout } = good;
    expect(() => parseDecideConfig(noTimeout, SCORER)).toThrow(/timeout_ms/i);
  });

  it("rejects a non-numeric timeout_ms field", () => {
    expect(() => parseDecideConfig({ ...good, timeout_ms: "15000" }, SCORER)).toThrow(/timeout_ms/i);
  });

  it("rejects a non-finite timeout_ms field", () => {
    expect(() => parseDecideConfig({ ...good, timeout_ms: Infinity }, SCORER)).toThrow(/timeout_ms/i);
  });

  it("rejects a non-positive timeout_ms field", () => {
    expect(() => parseDecideConfig({ ...good, timeout_ms: 0 }, SCORER)).toThrow(/timeout_ms/i);
    expect(() => parseDecideConfig({ ...good, timeout_ms: -100 }, SCORER)).toThrow(/timeout_ms/i);
  });

  // The gap workflow's page pre-check skips 27B extraction for pages below
  // this probability. Off unless spelled out, like shadow_detection: it
  // decides what knowledge is never read.
  it("leaves the page relevance pre-check off when page_relevance_skip_below is absent", () => {
    expect(parseDecideConfig(good, SCORER).pageRelevanceSkipBelow).toBeNull();
  });

  it("reads page_relevance_skip_below as a probability", () => {
    expect(parseDecideConfig({ ...good, page_relevance_skip_below: 0.1 }, SCORER).pageRelevanceSkipBelow).toBe(0.1);
    expect(() => parseDecideConfig({ ...good, page_relevance_skip_below: 1.5 }, SCORER)).toThrow(/page_relevance_skip_below/);
    expect(() => parseDecideConfig({ ...good, page_relevance_skip_below: "0.1" }, SCORER)).toThrow(/page_relevance_skip_below/);
  });
});

describe("loadDecideConfig", () => {
  it("takes the scorer URL from the host profile", () => {
    const config = loadDecideConfig(join(process.cwd(), "config", "decide.yaml"));
    expect(config.baseUrl).toBe("http://127.0.0.1:8010");
  });
});
