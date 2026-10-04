// The final prompt for one image: the 27B's visual expansion of the user's
// request (unless raw), then the preset's style, then the no-text clause.
// Style and clause are appended by code so no model reply can drop them.
// Diffusion models garble words and numbers: text belongs to the documents.

import type { ImagePreset } from "./image-presets.js";

export const NO_TEXT = "no text, no letters, no words, no logos, no watermark";
export const MAX_PROMPT_CHARS = 1000;
// FLUX reads about 500 tokens of prompt; past that, words are ignored anyway
const MAX_FINAL_CHARS = 1500;

export type CompleteFn = (prompt: string, maxTokens: number) => Promise<string>;

function expansionPrompt(request: string): string {
  return `Rewrite this image request as one detailed visual description for an image generator: subject, setting, composition, lighting, colours. One paragraph, at most 80 words, no lists. Describe only what is seen. Never ask for text, words, numbers, labels or logos in the image.

Request: ${request}`;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
}

export async function buildImagePrompt(input: { prompt: string; preset: ImagePreset; raw: boolean }, complete: CompleteFn): Promise<string> {
  const request = clean(input.prompt);
  let base = request;
  if (!input.raw) {
    try {
      base = clean(await complete(expansionPrompt(request), 200)) || request;
    } catch {
      // The image is still worth drawing from the user's own words
      base = request;
    }
  }
  const tail = [input.preset.style, NO_TEXT].filter((part) => part !== "").join(", ");
  const room = MAX_FINAL_CHARS - tail.length - 2;
  const trimmed = base.length > room ? base.slice(0, room).replace(/\s+\S*$/, "") : base;
  return `${trimmed}, ${tail}`;
}
