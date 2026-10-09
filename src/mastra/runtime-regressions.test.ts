import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextWithMastra } from "@mastra/core/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { isCompleteAgentResult } from "../shared/agent-contract.ts";
import { handleWorkError, workError } from "./errors.ts";

const errorResponseSchema = z.looseObject({
  error: z.string(),
  code: z.string(),
  domain: z.string(),
  category: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

test("a consumed error response can be rendered again", async () => {
  const error = workError("REQUEST_TIMEOUT");
  const first = error.getResponse();
  const body = await first.json();
  assert.equal(first.bodyUsed, true);

  const second = error.getResponse();
  assert.notEqual(second, first);
  assert.equal(second.bodyUsed, false);
  assert.equal(second.status, 504);
  assert.deepEqual(await second.json(), body);
});

test("concurrent conversions do not share an error body stream", async () => {
  const error = workError("VALIDATION_FAILED", {
    details: { field: "beforeContext" },
  });
  const responses = Array.from({ length: 4 }, () => error.getResponse());
  const bodies = await Promise.all(responses.map((response) => response.json()));
  for (const value of bodies) {
    const body = errorResponseSchema.parse(value);
    assert.equal(body.code, "VALIDATION_FAILED");
    assert.deepEqual(body.details, { field: "beforeContext" });
  }
});

test("a repeated route error keeps CORS and its structured payload", async () => {
  const error = workError("REQUEST_TIMEOUT");
  const app = new Hono();
  app.use("*", cors({ origin: "http://localhost:5173" }));
  app.onError((failure, context) =>
    handleWorkError(failure, context as unknown as ContextWithMastra),
  );
  app.get("/error", () => {
    throw error;
  });

  for (let request = 0; request < 2; request += 1) {
    const response = await app.request("http://localhost/error", {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(response.status, 504);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173");
    assert.equal(errorResponseSchema.parse(await response.json()).code, "REQUEST_TIMEOUT");
  }
});

test("error causes stay available locally without entering the HTTP payload", async () => {
  const cause = new Error("private provider credentials");
  const error = workError("MCP_CONNECTION_FAILED", { cause });
  assert.equal(error.cause, cause);

  const response = error.getResponse();
  assert.equal(response.status, 502);
  const body = errorResponseSchema.parse(await response.json());
  assert.equal(body.code, "MCP_CONNECTION_FAILED");
  assert.equal(JSON.stringify(body).includes(cause.message), false);
});

test("timeouts and cancellation use distinct standard HTTP responses", async () => {
  for (const [name, code, status] of [
    ["TimeoutError", "REQUEST_TIMEOUT", 504],
    ["AbortError", "REQUEST_CANCELLED", 408],
  ] as const) {
    const app = new Hono();
    app.onError((failure, context) =>
      handleWorkError(failure, context as unknown as ContextWithMastra),
    );
    app.get("/error", () => {
      throw new DOMException("operation stopped", name);
    });
    const response = await app.request("http://localhost/error");
    assert.equal(response.status, status);
    assert.equal(errorResponseSchema.parse(await response.json()).code, code);
  }
});

test("a final report can complete a delegated task", () => {
  assert.equal(
    isCompleteAgentResult({ text: "Implemented and checked.", finishReason: "stop" }),
    true,
  );
  assert.equal(isCompleteAgentResult({ text: "Findings with file references." }), true);
});

test("empty output is incomplete even when the model stops normally", () => {
  assert.equal(isCompleteAgentResult({ text: "", finishReason: "stop" }), false);
  assert.equal(isCompleteAgentResult({ text: " \n\t ", finishReason: "stop" }), false);
});

test("intermediate text does not turn an interrupted run into a completed task", () => {
  for (const finishReason of ["tool-calls", "length", "error", "content-filter"]) {
    assert.equal(
      isCompleteAgentResult({ text: "I will now implement the server.", finishReason }),
      false,
      finishReason,
    );
  }
});
