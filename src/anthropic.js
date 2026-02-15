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
}) {
  const client = getAnthropicClient(apiKey);
  const resp = await client.messages.create({
    model,
    system,
    max_tokens: maxTokens,
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  });
  return resp;
}

