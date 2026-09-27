// System One decision config: the verdict vocabulary and the thresholds that
// map a scorer probability onto it.
//
// Thresholds are config rather than constants because they are judgement, not
// statistics: open-jev's noul is a softmax over log-probs, not a calibrated
// confidence, so the numbers are expected to move once the replay harness
// reports how they actually distribute.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlDocument } from "yaml";

export const VERDICTS = ["resolved", "review", "unresolved"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface DecideThresholds {
  resolved: number;
  unresolved: number;
}

export interface DecideConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  // Run the scorer alongside the 27B at gap-detection time and record both,
  // without letting it decide anything. Defaults to false: shadow scoring adds
  // a call to every chat turn, so it is opt-in even once a scorer is installed.
  shadowDetection: boolean;
  thresholds: DecideThresholds;
}

// Type guard that distinguishes objects from arrays: typeof handles both as "object".
// Exported because decide.ts reads the scorer's body with the same guard.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`decide config: "${key}" must be a non-empty string`);
  }
  return value;
}

function requireProbability(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`decide config: threshold "${key}" must be a number between 0 and 1`);
  }
  return value;
}

export function parseDecideConfig(raw: unknown): DecideConfig {
  if (!isRecord(raw)) {
    throw new Error("decide config: expected a YAML mapping");
  }
  const thresholdsRaw = raw.thresholds;
  if (!isRecord(thresholdsRaw)) {
    throw new Error("decide config: thresholds must be a mapping");
  }
  const resolved = requireProbability(thresholdsRaw, "resolved");
  const unresolved = requireProbability(thresholdsRaw, "unresolved");
  // Strictly greater: equal thresholds collapse the review band to nothing,
  // and inverted ones invert every verdict.
  if (!(resolved > unresolved)) {
    throw new Error(
      `decide config: threshold "resolved" (${resolved}) must be strictly greater than "unresolved" (${unresolved})`,
    );
  }

  const timeout = raw.timeout_ms;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`decide config: "timeout_ms" must be a positive number`);
  }

  return {
    baseUrl: requireString(raw, "base_url"),
    model: requireString(raw, "model"),
    timeoutMs: timeout,
    // Absent means off. A boolean that must be spelled out to take effect is
    // the right default for something that touches every chat turn.
    shadowDetection: raw.shadow_detection === true,
    thresholds: { resolved, unresolved },
  };
}

export function loadDecideConfig(path: string = resolve(process.cwd(), "config", "decide.yaml")): DecideConfig {
  return parseDecideConfig(parseYamlDocument(readFileSync(path, "utf8")));
}
