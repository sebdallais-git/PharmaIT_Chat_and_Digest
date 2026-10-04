import { describe, expect, it } from "@jest/globals";
import { IMAGE_SIZES, isImageSize, loadImagePresets, parseImagePresets } from "../src/services/image-presets.js";

// Style presets are phrases appended to an image prompt; sizes are the
// platform specs rounded to multiples of 16 (FLUX's constraint), never cropped.

describe("image sizes", () => {
  it("are the four presets, every side a multiple of 16", () => {
    expect(IMAGE_SIZES).toEqual({
      square: { width: 1088, height: 1088 },
      portrait: { width: 1088, height: 1360 },
      linkedin: { width: 1200, height: 624 },
      slide: { width: 1280, height: 720 },
    });
    for (const { width, height } of Object.values(IMAGE_SIZES)) {
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
    }
    expect(isImageSize("slide")).toBe(true);
    expect(isImageSize("banner")).toBe(false);
  });
});

describe("parseImagePresets", () => {
  it("reads named style phrases and always has 'none'", () => {
    const presets = parseImagePresets('presets:\n  photo:\n    style: "photorealistic, natural light"\n');
    expect([...presets.keys()].sort()).toEqual(["none", "photo"]);
    expect(presets.get("none")).toEqual({ name: "none", style: "" });
    expect(presets.get("photo")).toEqual({ name: "photo", style: "photorealistic, natural light" });
  });

  it("refuses a bad name, a missing style, or a redefined 'none'", () => {
    expect(() => parseImagePresets("presets:\n  Photo!:\n    style: x\n")).toThrow('config/image-presets.yaml: preset name "Photo!" must be lowercase letters, digits and dashes');
    expect(() => parseImagePresets("presets:\n  photo: {}\n")).toThrow("config/image-presets.yaml: presets.photo.style must be a non-empty string");
    expect(() => parseImagePresets("presets:\n  none:\n    style: x\n")).toThrow("config/image-presets.yaml: 'none' is built in");
    expect(() => parseImagePresets("- photo\n")).toThrow("config/image-presets.yaml: presets must be a mapping");
  });

  it("parses the committed config/image-presets.yaml with house, photo, abstract and brand", () => {
    expect([...loadImagePresets().keys()].sort()).toEqual(["abstract", "brand", "house", "none", "photo"]);
  });
});
