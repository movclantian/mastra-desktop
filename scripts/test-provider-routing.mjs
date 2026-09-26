import assert from "node:assert/strict";
import test from "node:test";

const { createGatewayModel } = (await import("../src/mastra/models/create-model.ts")).default;

async function requestUrl(options) {
  const originalFetch = globalThis.fetch;
  const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  let seenUrl;

  process.env.ANTHROPIC_BASE_URL = "https://wrong.example/messages";
  globalThis.fetch = async (input) => {
    seenUrl = String(input);
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: options.modelId,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const model = await createGatewayModel({
      apiKey: "sk-test",
      protocol: "anthropic",
      providerName: options.registryId,
      ...options,
    });
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    return seenUrl;
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
  }
}

test("Anthropic-compatible registry providers use their registry endpoint", async () => {
  const cases = [
    ["moonshotai", "kimi-k2", "https://api.moonshot.ai/anthropic/v1/messages"],
    ["moonshotai-cn", "kimi-k2", "https://api.moonshot.cn/anthropic/v1/messages"],
    ["minimax-cn", "MiniMax-M2", "https://api.minimax.cn/anthropic/v1/messages"],
  ];

  for (const [registryId, modelId, expectedUrl] of cases) {
    assert.equal(await requestUrl({ registryId, modelId }), expectedUrl);
  }
});

test("An explicit custom endpoint still overrides registry metadata", async () => {
  assert.equal(
    await requestUrl({
      registryId: "moonshotai",
      modelId: "kimi-k2",
      baseUrl: "https://custom.example/api/v1",
    }),
    "https://custom.example/api/v1/messages",
  );
});
