import Anthropic from "@anthropic-ai/sdk";

export function getAnthropicClient(apiKey) {
  return new Anthropic({ apiKey });
}

export async function createClaudeMessage({
  apiKey,
  model,
  system,
  messages,
  maxTokens,
  tools,
  toolChoice,
  trace,
  purpose,
}) {
  const client = getAnthropicClient(apiKey);
  trace?.({
    type: "anthropic:request",
    purpose: purpose || "unknown",
    model,
    max_tokens: maxTokens,
    messages: Array.isArray(messages) ? messages.length : 0,
    tools: Array.isArray(tools) ? tools.length : 0,
  });
  const resp = await client.messages.create({
    model,
    system,
    max_tokens: maxTokens,
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  });
  trace?.({
    type: "anthropic:response",
    purpose: purpose || "unknown",
    id: resp?.id,
    stop_reason: resp?.stop_reason,
    usage: resp?.usage || null,
  });
  return resp;
}

