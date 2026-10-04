import { describe, expect, it } from "@jest/globals";
import { NO_TEXT, buildImagePrompt, type CompleteFn } from "../src/services/image-prompt.js";

// The 27B turns a short request into a visual prompt; the preset's style and
// the no-text clause are added by code, so they are there whatever the model says.

const photo = { name: "photo", style: "photorealistic editorial photograph" };
const none = { name: "none", style: "" };

function model(reply: string | Error) {
  const prompts: string[] = [];
  const complete: CompleteFn = async (prompt) => {
    prompts.push(prompt);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { complete, prompts };
}

describe("buildImagePrompt", () => {
  it("expands with the 27B, then appends the preset style and the no-text clause", async () => {
    const m = model('  "A modern pharma plant at dawn, robots on a clean line"\n');
    const out = await buildImagePrompt({ prompt: "AI in pharma manufacturing", preset: photo, raw: false }, m.complete);
    expect(out).toBe(`A modern pharma plant at dawn, robots on a clean line, photorealistic editorial photograph, ${NO_TEXT}`);
    expect(m.prompts).toHaveLength(1);
    expect(m.prompts[0]).toContain("AI in pharma manufacturing");
  });

  it("raw: no model call, the prompt as written plus style and no-text", async () => {
    const m = model("unused");
    const out = await buildImagePrompt({ prompt: "a lab bench", preset: none, raw: true }, m.complete);
    expect(out).toBe(`a lab bench, ${NO_TEXT}`);
    expect(m.prompts).toEqual([]);
    expect(NO_TEXT).toBe("no text, no letters, no words, no logos, no watermark");
  });

  // Review focus 3: an expansion failure must not cost the image
  it("falls back to the user's prompt when the expansion fails or comes back empty", async () => {
    expect(await buildImagePrompt({ prompt: "a lab bench", preset: none, raw: false }, model(new Error("stack down")).complete)).toBe(`a lab bench, ${NO_TEXT}`);
    expect(await buildImagePrompt({ prompt: "a lab bench", preset: none, raw: false }, model("   ").complete)).toBe(`a lab bench, ${NO_TEXT}`);
  });

  it("trims a long expansion but never the style or the no-text clause", async () => {
    const out = await buildImagePrompt({ prompt: "x", preset: photo, raw: false }, model("word ".repeat(600)).complete);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.endsWith(`photorealistic editorial photograph, ${NO_TEXT}`)).toBe(true);
  });
});
