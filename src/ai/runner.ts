/**
 * Optional AI step (opt-in with --ai), run through a CONSOLE tool the user is already logged in
 * to - no API keys, usage counts against the user's subscription:
 *
 *   claude   Claude Code headless:  claude -p --output-format json --json-schema ... --tools ""
 *   codex    OpenAI Codex CLI:      codex exec --output-schema ... --sandbox read-only --ephemeral
 *   command  any executable (e.g. an orchestrator): API_AI_COMMAND
 *
 * Contract for `command`: the request is written to stdin as JSON
 *   { "system": "...", "prompt": "...", "schema": { JSON Schema } }
 * and the answer object (matching the schema) is read from stdout as JSON.
 *
 * Every answer is validated against the schema here (ajv); an invalid or missing answer is
 * treated as "no answer", never guessed. The model gets no tools and runs in an empty temp folder.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Ajv } from 'ajv';

export type RunnerKind = 'claude' | 'codex' | 'command';
export const RUNNERS: RunnerKind[] = ['claude', 'codex', 'command'];

export interface AiUsage {
  calls: number;
  failed: number;
  durationMs: number;
  /** Equivalent API cost if the tool reports it (claude does); with a subscription nothing is billed per call. */
  reportedCostUsd: number;
}

export interface AiOptions {
  runner?: RunnerKind;
  model?: string;
  maxCalls?: number;
  timeoutMs?: number;
  command?: string;
}

export class AiBudgetExceeded extends Error {}
export class AiUnavailable extends Error {}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Exec = (command: string, args: string[], o: { input: string; cwd: string; timeoutMs: number; shell?: boolean }) => Promise<ExecResult>;

const realExec: Exec = (command, args, o) =>
  new Promise((done) => {
    const child = spawn(command, args, { cwd: o.cwd, shell: o.shell ?? false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), o.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.end(o.input);
  });

/**
 * On Windows, npm installs CLIs as .cmd shims, which cannot be spawned without a shell (and
 * quoting JSON through cmd.exe is unreliable). Find what the shim really runs instead.
 */
export function resolveCli(name: string, env: NodeJS.ProcessEnv = process.env): { command: string; prefix: string[] } | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    return dirs.some((d) => existsSync(join(d, name))) ? { command: name, prefix: [] } : undefined;
  }
  for (const d of dirs) {
    for (const ext of ['.exe', '']) if (ext && existsSync(join(d, name + ext))) return { command: join(d, name + ext), prefix: [] };
    const shim = join(d, `${name}.cmd`);
    if (!existsSync(shim)) continue;
    const m = /"%dp0%\\([^"]+\.(exe|js|cjs|mjs))"/i.exec(readFileSync(shim, 'utf8'));
    if (!m) continue;
    const target = join(dirname(shim), m[1]);
    if (!existsSync(target)) continue;
    return m[2].toLowerCase() === 'exe' ? { command: target, prefix: [] } : { command: process.execPath, prefix: [target] };
  }
  return undefined;
}

export class AiRunner {
  readonly usage: AiUsage = { calls: 0, failed: 0, durationMs: 0, reportedCostUsd: 0 };
  readonly kind: RunnerKind;
  readonly model?: string;
  private attempts = 0;
  private readonly maxCalls: number;
  private readonly timeoutMs: number;
  private readonly command?: string;
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  constructor(o: AiOptions = {}, private readonly exec: Exec = realExec) {
    this.kind = o.runner ?? ((process.env.API_AI as RunnerKind) || 'claude');
    if (!RUNNERS.includes(this.kind)) throw new AiUnavailable(`API_AI must be one of ${RUNNERS.join(', ')}, got "${this.kind}".`);
    this.model = o.model ?? (process.env.API_AI_MODEL || undefined);
    this.maxCalls = o.maxCalls ?? 10;
    this.timeoutMs = o.timeoutMs ?? 180_000;
    this.command = o.command ?? process.env.API_AI_COMMAND;
    if (this.kind === 'command' && !this.command) throw new AiUnavailable('API_AI=command needs API_AI_COMMAND (the executable to run).');
  }

  /** One schema-constrained question. Returns null when there is no valid answer (never guesses). */
  async ask<T>(system: string, prompt: string, schema: Record<string, unknown>): Promise<T | null> {
    if (this.attempts >= this.maxCalls) throw new AiBudgetExceeded(`AI call budget of ${this.maxCalls} is spent (--ai-max-calls).`);
    this.attempts++;
    const dir = await mkdtemp(join(tmpdir(), 'api-agent-ai-')); // empty folder: no project files, no project instructions
    const started = Date.now();
    try {
      const raw = await this.invoke(dir, system, prompt, schema);
      this.usage.durationMs += Date.now() - started;
      if (raw === undefined) {
        this.usage.failed++;
        return null;
      }
      const validate = this.ajv.compile(schema);
      if (!validate(raw)) {
        this.usage.failed++;
        return null;
      }
      this.usage.calls++;
      return raw as T;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async invoke(dir: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<unknown> {
    if (this.kind === 'claude') {
      const cli = resolveCli('claude');
      if (!cli) throw new AiUnavailable('Claude Code CLI not found: install it and log in (`claude`), or choose another runner with API_AI.');
      const args = [
        ...cli.prefix,
        '-p',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(schema),
        '--tools', '', // no tools: the model only answers
        '--system-prompt', system,
        '--no-session-persistence',
        ...(this.model ? ['--model', this.model] : []),
      ];
      const r = await this.exec(cli.command, args, { input: prompt, cwd: dir, timeoutMs: this.timeoutMs });
      if (r.code !== 0) throw new AiUnavailable(`claude exited with ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''}`.trim());
      let out: any;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        return undefined;
      }
      if (typeof out?.total_cost_usd === 'number') this.usage.reportedCostUsd += out.total_cost_usd;
      if (out?.is_error) return undefined;
      if (out?.structured_output && typeof out.structured_output === 'object') return out.structured_output;
      return parseJsonLoose(out?.result);
    }

    if (this.kind === 'codex') {
      const cli = resolveCli('codex');
      if (!cli) throw new AiUnavailable('Codex CLI not found: install it and log in (`codex`), or choose another runner with API_AI.');
      const schemaFile = join(dir, 'schema.json');
      const outFile = join(dir, 'answer.json');
      await writeFile(schemaFile, JSON.stringify({ ...schema, additionalProperties: false }));
      const args = [...cli.prefix, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--output-schema', schemaFile, '-o', outFile, ...(this.model ? ['-m', this.model] : []), '-'];
      const r = await this.exec(cli.command, args, { input: `${system}\n\n${prompt}`, cwd: dir, timeoutMs: this.timeoutMs });
      if (r.code !== 0) throw new AiUnavailable(`codex exited with ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''}`.trim());
      return parseJsonLoose(existsSync(outFile) ? await readFile(outFile, 'utf8') : r.stdout);
    }

    // command: the user's own executable (an orchestrator, a wrapper around another CLI...)
    const request = JSON.stringify({ system, prompt, schema });
    const r = await this.exec(this.command!, [], { input: request, cwd: dir, timeoutMs: this.timeoutMs, shell: true });
    if (r.code !== 0) throw new AiUnavailable(`API_AI_COMMAND exited with ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''}`.trim());
    return parseJsonLoose(r.stdout);
  }

  summary(): string {
    const cost = this.usage.reportedCostUsd ? `, reported cost ~$${this.usage.reportedCostUsd.toFixed(4)} (billed per call only without a subscription)` : '';
    return `AI via ${this.kind}${this.model ? ` (${this.model})` : ''}: ${this.usage.calls} answer(s), ${this.usage.failed} without a valid answer, ${(this.usage.durationMs / 1000).toFixed(1)}s${cost}`;
  }
}

/** The answer as JSON: a whole JSON document, or the first {...} block in the text. */
export function parseJsonLoose(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}

export function describeAiError(e: unknown): string {
  if (e instanceof AiBudgetExceeded || e instanceof AiUnavailable) return e.message;
  return `AI step failed: ${String((e as any)?.message ?? e).split('\n')[0]}`;
}
