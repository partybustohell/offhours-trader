import Anthropic from '@anthropic-ai/sdk';

export interface StructuredCallOpts {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolSchema: Record<string, unknown>;
  maxTokens?: number;
}

/** Minimal structural surface so tests/replay can inject a mock client. */
export interface LlmClient {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Messages.Message>;
  };
}

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let singleton: Anthropic | undefined;
function defaultClient(): LlmClient {
  // Reads ANTHROPIC_API_KEY from env; constructed lazily so tests that inject
  // a client never require credentials.
  if (!singleton) singleton = new Anthropic();
  return singleton;
}

const RETRY_BACKOFF_MS = [1000, 3000];

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  const status = err.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const type = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
  return type === 'overloaded_error';
}

/**
 * Single forced-tool-use call: one tool, tool_choice pinned to it, the
 * tool_use input returned as T. Throws if the model returns no tool_use
 * block. Retries twice on 429/5xx/overloaded_error.
 */
export async function callStructured<T>(
  opts: StructuredCallOpts,
  client: LlmClient = defaultClient(),
  sleep: Sleep = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
    try {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2000,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        tools: [
          {
            name: opts.toolName,
            input_schema: opts.toolSchema as Anthropic.Messages.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: opts.toolName },
      });
      const block = response.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(`no tool_use block in response for tool ${opts.toolName}`);
      }
      return block.input as T;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === RETRY_BACKOFF_MS.length) throw err;
    }
  }
  throw lastError;
}
