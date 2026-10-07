import { createOpenAI } from "@ai-sdk/openai";

/**
 * Gemini is exposed through Google's OpenAI-compatible endpoint so the
 * existing AI SDK agent/tool stack can switch providers without changing its
 * public behavior. GEMINI_API_KEY is the only AI credential required.
 */
const gemini = createOpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

export const CHAT_MODEL_ID = "gemini-3.8-flash";
export const EMBEDDING_MODEL_ID = "gemini-embedding-2";

export const chatModel = gemini.chat(CHAT_MODEL_ID);
export const embeddingModel = gemini.embedding(EMBEDDING_MODEL_ID);

export function isAiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export const AI_NOT_CONFIGURED_MESSAGE =
  "Meherah AI is not configured. Set GEMINI_API_KEY on the Convex deployment.";

export function assertAiConfigured(): void {
  if (!isAiConfigured()) {
    throw new Error(AI_NOT_CONFIGURED_MESSAGE);
  }
}
