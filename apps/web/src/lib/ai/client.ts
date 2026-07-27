import type { AiModelSettings } from "@/lib/ai/types";
import { resolveAiApiKey, resolveAiBaseUrl } from "@/lib/ai/settings";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";

export interface StrictJsonCompletionParams {
  modelSettings: AiModelSettings;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AI_ERROR_DETAIL_CHARS = 4_096;

function safeProviderErrorDetail(body: string, fallback: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > MAX_AI_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_AI_ERROR_DETAIL_CHARS)}…`
    : normalized;
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AI_RESPONSE_BYTES) {
        await reader.cancel("response too large").catch(() => undefined);
        throw new Error("AI provider response exceeded the 2 MB limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function extractJsonPayload(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("AI returned an empty response");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue trying to recover JSON from fenced or mixed responses.
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
    throw new Error("AI response did not contain valid JSON");
  }

  const sliced = trimmed.slice(firstBrace, lastBrace + 1);
  return JSON.parse(sliced);
}

async function callOpenAiCompatible(
  params: StrictJsonCompletionParams,
  apiKey: string,
  baseUrl: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (params.modelSettings.provider === "openrouter") {
      headers["HTTP-Referer"] = process.env.APP_URL || "https://backslash.app";
      headers["X-Title"] = "Backslash";
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: params.modelSettings.model,
        temperature: params.temperature ?? 0.1,
        response_format: { type: "json_object" },
        max_tokens: params.maxTokens ?? 2_000,
        messages: [
          {
            role: "system",
            content: params.systemPrompt,
          },
          {
            role: "user",
            content: params.userPrompt,
          },
        ],
      }),
      signal: controller.signal,
      redirect: "error",
    });

    if (!res.ok) {
      const body = await readResponseText(res).catch(() => "");
      throw new Error(
        `AI provider request failed (${res.status}): ${safeProviderErrorDetail(body, res.statusText)}`
      );
    }

    const json = JSON.parse(await readResponseText(res)) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("AI provider returned no completion content");
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(
  params: StrictJsonCompletionParams,
  apiKey: string,
  baseUrl: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: params.modelSettings.model,
        max_tokens: params.maxTokens ?? 2_000,
        temperature: params.temperature ?? 0.1,
        system: params.systemPrompt,
        messages: [
          {
            role: "user",
            content: params.userPrompt,
          },
        ],
      }),
      signal: controller.signal,
      redirect: "error",
    });

    if (!res.ok) {
      const body = await readResponseText(res).catch(() => "");
      throw new Error(
        `Anthropic request failed (${res.status}): ${safeProviderErrorDetail(body, res.statusText)}`
      );
    }

    const json = JSON.parse(await readResponseText(res)) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const firstText = json.content?.find((item) => item.type === "text")?.text;
    if (!firstText) {
      throw new Error("Anthropic returned no text content");
    }

    return firstText;
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeStrictJson(
  params: StrictJsonCompletionParams
): Promise<unknown> {
  const apiKey = resolveAiApiKey(params.modelSettings);
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${params.modelSettings.provider}". Set it in Settings or environment variables.`
    );
  }

  const configuredBaseUrl = resolveAiBaseUrl(params.modelSettings);
  if (!configuredBaseUrl) {
    throw new Error(
      `Missing API endpoint for provider "${params.modelSettings.provider}".`
    );
  }

  const baseUrl = await assertSafeOutboundUrl(configuredBaseUrl);

  const text =
    params.modelSettings.provider === "anthropic"
      ? await callAnthropic(params, apiKey, baseUrl)
      : await callOpenAiCompatible(params, apiKey, baseUrl);

  return extractJsonPayload(text);
}
