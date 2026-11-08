/**
 * Optional AI adapter (opt-in with --ai). Everything else in api-test-agent is deterministic;
 * the model is used only where rules cannot decide, with minimal context, a call budget,
 * schema-validated output, and its answers are PROPOSALS a human confirms.
 *
 * Credentials: the SDK's own resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
 * `ant auth login` profile). Never .env API secrets: those are not sent to the model.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

export const DEFAULT_MODEL = 'claude-opus-5-5';

// Per-million-token prices for the cost estimate shown to the user (Claude API list prices).
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export interface AiUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  refusals: number;
}

export interface AiOptions {
  model?: string;
  maxCalls?: number; // hard budget per run
  effort?: 'low' | 'medium' | 'high';
}

/** Minimal surface used here, so tests can inject a fake client. */
export interface ParseClient {
  beta: { messages: { parse: (params: any) => Promise<any> } };
}

export class AiBudgetExceeded extends Error {}

export class ClaudeAdvisor {
  readonly usage: AiUsage = { calls: 0, inputTokens: 0, outputTokens: 0, refusals: 0 };
  private attempts = 0;
  readonly model: string;
  private readonly maxCalls: number;
  private readonly effort: 'low' | 'medium' | 'high';
  private readonly client: ParseClient;

  constructor(o: AiOptions = {}, client?: ParseClient) {
    this.model = o.model ?? process.env.API_AI_MODEL ?? DEFAULT_MODEL;
    this.maxCalls = o.maxCalls ?? 10;
    this.effort = o.effort ?? 'medium';
    this.client = client ?? (new Anthropic() as unknown as ParseClient);
  }

  /**
   * One schema-constrained call. Returns null on refusal or unparseable output (never guesses).
   * The system prompt is constant so it can be cached across calls.
   */
  async ask<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T | null> {
    if (this.attempts >= this.maxCalls) throw new AiBudgetExceeded(`AI call budget of ${this.maxCalls} is spent (--ai-max-calls).`);
    this.attempts++;
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 4000,
      // Server-side fallback: if a safety classifier declines, the API retries on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort: this.effort, format: betaZodOutputFormat(schema) },
    });
    this.usage.calls++; // completed calls only
    this.usage.inputTokens += (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0);
    this.usage.outputTokens += response.usage?.output_tokens ?? 0;
    if (response.stop_reason === 'refusal') {
      this.usage.refusals++;
      return null;
    }
    return (response.parsed_output as T | null) ?? null;
  }

  costEstimateUsd(): number | undefined {
    const p = PRICES[this.model];
    if (!p) return undefined;
    return (this.usage.inputTokens * p.input + this.usage.outputTokens * p.output) / 1_000_000;
  }

  summary(): string {
    const cost = this.costEstimateUsd();
    return `AI (${this.model}): ${this.usage.calls} call(s), ${this.usage.inputTokens} input / ${this.usage.outputTokens} output tokens${cost !== undefined ? `, ~$${cost.toFixed(4)}` : ''}${this.usage.refusals ? `, ${this.usage.refusals} declined` : ''}`;
  }
}

/** Typed API errors → one readable line (no request bodies, no keys). */
export function describeAiError(e: unknown): string {
  if (e instanceof AiBudgetExceeded) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic API: authentication failed. Set ANTHROPIC_API_KEY (or run `ant auth login`).';
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic API: rate limited, try again later.';
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ''}`.trim();
  if (/authentication method|api ?key/i.test(String((e as any)?.message ?? ''))) return 'No Anthropic credentials: set ANTHROPIC_API_KEY (or run `ant auth login`). The rest of the run is unaffected.';
  return `AI call failed: ${String((e as any)?.message ?? e).split('\n')[0]}`;
}
