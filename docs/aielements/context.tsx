"use client";

import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentBreakdown,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@repo/elements/context";

const Example = () => (
  <div className="flex items-center justify-center p-8">
    <Context
      maxTokens={168_000}
      modelId="openai:gpt-5"
      usage={{
        inputTokens: 32_656,
        inputTokenDetails: {
          noCacheTokens: 32_656,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokens: 8000,
        outputTokenDetails: {
          textTokens: 8000,
          reasoningTokens: 0,
        },
        totalTokens: 40_656,
      }}
      usedTokens={40_656}
    >
      <ContextTrigger />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody>
          <ContextContentBreakdown />
        </ContextContentBody>
        <ContextContentFooter />
      </ContextContent>
    </Context>
  </div>
);

export default Example;
