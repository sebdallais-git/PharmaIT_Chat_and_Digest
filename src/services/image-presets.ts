// Style presets and sizes for generated images (spec 2026-10-04).
//
// A preset is a style phrase appended to the prompt; "none" is built in and
// adds nothing. Sizes are the platform specs rounded to multiples of 16, which
// FLUX requires, so no image is ever cropped and no image library is needed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const IMAGE_PRESETS_FILE = "config/image-presets.yaml";

export const IMAGE_SIZES = {
  square: { width: 1088, height: 1088 }, // LinkedIn feed post, spec 1080 × 1080
  portrait: { width: 1088, height: 1360 }, // LinkedIn 4:5, spec 1080 × 1350
  linkedin: { width: 1200, height: 624 }, // LinkedIn landscape, spec 1200 × 627
  slide: { width: 1280, height: 720 }, // 16:9 PowerPoint
} as const;

export type ImageSize = keyof typeof IMAGE_SIZES;

export function isImageSize(value: unknown): value is ImageSize {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(IMAGE_SIZES, value);
}

export interface ImagePreset {
  name: string;
  style: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseImagePresets(yaml: string): Map<string, ImagePreset> {
  const fail = (message: string): never => {
    throw new Error(`${IMAGE_PRESETS_FILE}: ${message}`);
  };
  const doc: unknown = parse(yaml) ?? {};
  const raw = isRecord(doc) ? doc.presets ?? {} : null;
  if (!isRecord(raw)) return fail("presets must be a mapping");
  const presets = new Map<string, ImagePreset>([["none", { name: "none", style: "" }]]);
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "none") fail("'none' is built in");
    if (!/^[a-z0-9-]+$/.test(name)) fail(`preset name ${JSON.stringify(name)} must be lowercase letters, digits and dashes`);
    const style = isRecord(entry) && typeof entry.style === "string" ? entry.style.trim() : "";
    if (style === "") fail(`presets.${name}.style must be a non-empty string`);
    presets.set(name, { name, style });
  }
  return presets;
}

export function loadImagePresets(root: string = process.cwd()): Map<string, ImagePreset> {
  return parseImagePresets(readFileSync(join(root, IMAGE_PRESETS_FILE), "utf-8"));
}
