import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OcClientSettings {
  baseUrl: string;
  directory: string;
  serveCommand?: string;
  startupTimeoutMs?: number;
}

export interface ModelOption {
  providerID: string;
  modelID: string;
  label: string;
  reasoningDepthOptions?: string[];
  defaultReasoningDepth?: string;
}

export interface PromptRequest {
  sessionId: string;
  prompt: string;
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  tools?: { [key: string]: boolean };
}

export interface PromptResult {
  messageID: string;
  output: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function contentHash(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex").slice(0, 8);
}

function generateMessageID(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "msg_";
  for (let i = 0; i < 20; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// SDK dynamic import (same pattern as kanban)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sdkPromise: Promise<any> | undefined;

async function loadSdk(): Promise<any> {
  if (!sdkPromise) {
    const dynamicImport = new Function("specifier", "return import(specifier);");
    const extRoot = path.resolve(__dirname, "..");
    const sdkPath = path.join(extRoot, "lib", "node_modules", "@opencode-ai", "sdk", "dist", "v2", "client.js");
    sdkPromise = dynamicImport(sdkPath);
  }
  return sdkPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapData(value: any): any {
  if (value && typeof value === "object" && "data" in value) {
    if (value.error) {
      throw value.error;
    }
    return value.data;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: unknown[]): string {
  for (const v of values) {
    const s = toTrimmedString(v);
    if (s) return s;
  }
  return "";
}

function readProviderID(raw: Record<string, unknown>): string {
  return firstNonEmpty(raw.id, raw.providerID, raw.providerId, raw.provider_id);
}

function readModelID(raw: Record<string, unknown>): string {
  return firstNonEmpty(raw.id, raw.modelID, raw.modelId, raw.model_id, raw.model);
}

function sanitizeDepth(value: unknown): string | undefined {
  const d = toTrimmedString(value).toLowerCase();
  if (!d) return undefined;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(d)) return undefined;
  return d;
}

function readDepthOptions(rawModel: Record<string, unknown>): string[] {
  const options: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const n = sanitizeDepth(value);
    if (!n || seen.has(n)) return;
    seen.add(n);
    options.push(n);
  };
  const readContainer = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) push(item); return; }
    if (isRecord(value)) { for (const key of Object.keys(value)) push(key); return; }
    push(value);
  };
  readContainer(rawModel.variants);
  readContainer(rawModel.reasoningDepthOptions);
  readContainer(rawModel.reasoningDepths);
  const optionsNode = rawModel.options;
  if (isRecord(optionsNode)) {
    readContainer(optionsNode.reasoningDepthOptions);
    readContainer(optionsNode.reasoningDepths);
    readContainer(optionsNode.reasoning);
  }
  return options;
}

function readDefaultDepth(rawModel: Record<string, unknown>): string | undefined {
  const candidates = [
    rawModel.defaultReasoningDepth, rawModel.defaultVariant,
    rawModel.reasoningDepth, rawModel.variant, rawModel.reasoningEffort,
  ];
  const optionsNode = rawModel.options;
  if (isRecord(optionsNode)) {
    candidates.push(
      optionsNode.defaultReasoningDepth, optionsNode.defaultVariant,
      optionsNode.reasoningDepth, optionsNode.variant, optionsNode.reasoningEffort,
    );
  }
  for (const c of candidates) {
    const n = sanitizeDepth(c);
    if (n) return n;
  }
  return undefined;
}

function readModelList(models: unknown): Array<{ modelID: string; name?: string; reasoningDepthOptions?: string[]; defaultReasoningDepth?: string }> {
  const result: Array<{ modelID: string; name?: string; reasoningDepthOptions?: string[]; defaultReasoningDepth?: string }> = [];
  const pushModel = (rawModel: unknown, fallback?: string) => {
    if (typeof rawModel === "string") {
      const mid = toTrimmedString(rawModel) || fallback || "";
      if (mid) result.push({ modelID: mid });
      return;
    }
    if (!isRecord(rawModel)) {
      const mid = fallback || "";
      if (mid) result.push({ modelID: mid });
      return;
    }
    const mid = readModelID(rawModel) || fallback || "";
    if (!mid) return;
    const name = firstNonEmpty(rawModel.name, rawModel.title, rawModel.label) || undefined;
    const depthOpts = readDepthOptions(rawModel);
    const defDepth = readDefaultDepth(rawModel);
    result.push({
      modelID: mid,
      name,
      ...(depthOpts.length ? { reasoningDepthOptions: depthOpts } : {}),
      ...(defDepth ? { defaultReasoningDepth: defDepth } : {}),
    });
  };
  if (Array.isArray(models)) {
    for (const item of models) pushModel(item);
    return result;
  }
  if (!isRecord(models)) return result;
  for (const [modelKey, rawModel] of Object.entries(models)) {
    const fallback = toTrimmedString(modelKey);
    if (!fallback) continue;
    pushModel(rawModel, fallback);
  }
  return result;
}

function pickDefaultDepth(options: string[]): string | undefined {
  if (!options.length) return undefined;
  for (const p of ["high", "medium", "low", "xhigh"]) {
    if (options.includes(p)) return p;
  }
  return options[0];
}

function dedupeOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const o of options) {
    const n = sanitizeDepth(o);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

function extractOutputFromParts(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const type = toTrimmedString(part.type);
    if (type === "text") {
      const text = toTrimmedString(part.text);
      if (text) texts.push(text);
    }
  }
  return texts.join("\n\n");
}

// ---------------------------------------------------------------------------
// OpenCodeClient - SDK-based (mirrors kanban OpenCodeClientAdapter)
// ---------------------------------------------------------------------------

export class OpenCodeClient {
  private settings: OcClientSettings;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientPromise: Promise<any> | undefined;

  constructor(settings: OcClientSettings) {
    this.settings = settings;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient();
    }
    return this.clientPromise;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async createClient(): Promise<any> {
    const sdk = await loadSdk();
    return sdk.createOpencodeClient({
      baseUrl: this.settings.baseUrl,
      directory: this.settings.directory,
      responseStyle: "data",
      throwOnError: true,
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const raw = await client.global.health();
      const data = unwrapData(raw);
      return data?.healthy === true;
    } catch {
      return false;
    }
  }

  async createSession(title: string): Promise<string> {
    const client = await this.getClient();
    const raw = await client.session.create({
      title,
      directory: this.settings.directory,
      permission: [
        { permission: "edit", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "external_directory", pattern: "*", action: "allow" },
        { permission: "webfetch", pattern: "*", action: "allow" },
        { permission: "doom_loop", pattern: "*", action: "allow" },
        { permission: "question", pattern: "*", action: "allow" },
      ],
    });
    const session = unwrapData(raw);
    const id = String(session?.id ?? "").trim();
    if (!id) throw new Error("OpenCode returned an invalid session ID.");
    return id;
  }

  async prompt(request: PromptRequest): Promise<PromptResult> {
    const client = await this.getClient();
    const msgID = request.messageID || generateMessageID();
    const raw = await client.session.prompt({
      sessionID: request.sessionId,
      directory: this.settings.directory,
      messageID: msgID,
      model: request.model,
      agent: request.agent,
      parts: [{ type: "text", text: request.prompt }],
    });
    const response = unwrapData(raw);
    const info = (response?.info ?? {}) as Record<string, unknown>;
    const parts = (response?.parts ?? []) as unknown[];
    const messageID = String(info.id ?? "").trim();
    if (!messageID) throw new Error("OpenCode returned a prompt response without message ID.");
    return {
      messageID,
      output: extractOutputFromParts(parts),
    };
  }

  async promptStream(
    request: PromptRequest,
    abortFlag: { abort: boolean },
    onDelta: (delta: string) => void,
    onDone: (output: string) => void,
    onError: (err: Error) => void
  ): Promise<void> {
    const client = await this.getClient();
    const msgID = request.messageID || generateMessageID();

    let sseResult: { stream: AsyncGenerator<unknown> } | undefined;
    try {
      sseResult = await client.global.event();
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    if (!sseResult) { onError(new Error("Failed to open event stream.")); return; }

    await client.session.promptAsync({
      sessionID: request.sessionId,
      directory: this.settings.directory,
      messageID: msgID,
      model: request.model,
      agent: request.agent,
      tools: request.tools,
      parts: [{ type: "text", text: request.prompt }],
    });

    const accumulated: string[] = [];
    let done = false;
    let lastDeltaTime = Date.now();
    const NO_DELTA_TIMEOUT_MS = 60000;
    const promptSentAt = Date.now();
    const IDLE_GRACE_MS = 1500;

    const monitor = setInterval(async () => {
      if (done) return;
      const timedOut = Date.now() - lastDeltaTime > NO_DELTA_TIMEOUT_MS;
      if (abortFlag.abort || timedOut) {
        done = true;
        try { await sseResult!.stream.return?.(undefined); } catch { /* ignore */ }
      }
    }, 200);

    try {
      for await (const rawEvent of sseResult.stream) {
        if (done || abortFlag.abort) break;
        const evt = isRecord(rawEvent) ? rawEvent
          : (isRecord((rawEvent as Record<string, unknown>)?.[200])
            ? (rawEvent as Record<string, unknown>)[200]
            : rawEvent);
        const payload = isRecord(evt) && isRecord(evt.payload) ? evt.payload
          : (isRecord(evt) ? evt : null);
        if (!payload) continue;

        const type = toTrimmedString(payload.type);
        const props = isRecord(payload.properties) ? payload.properties : null;

        if (type === "message.part.delta" && props) {
          const sid = toTrimmedString(props.sessionID);
          if (sid !== request.sessionId) continue;
          const field = toTrimmedString(props.field);
          if (field !== "text") continue;
          const delta = toTrimmedString(props.delta);
          if (delta) {
            lastDeltaTime = Date.now();
            accumulated.push(delta);
            onDelta(delta);
          }
        } else if (type === "session.idle" && props) {
          const sid = toTrimmedString(props.sessionID);
          if (sid !== request.sessionId) continue;
          if (Date.now() - promptSentAt < IDLE_GRACE_MS) continue;
          done = true;
          onDone(accumulated.join(""));
          break;
        } else if (type === "session.status" && props) {
          const sid = toTrimmedString(props.sessionID);
          if (sid !== request.sessionId) continue;
          if (Date.now() - promptSentAt < IDLE_GRACE_MS) continue;
          const status = isRecord(props.status) ? props.status : null;
          if (status && toTrimmedString(status.type) === "idle") {
            done = true;
            onDone(accumulated.join(""));
            break;
          }
        }
      }
      if (!done) {
        done = true;
        if (!abortFlag.abort) onDone(accumulated.join(""));
      }
    } catch (e) {
      if (!done && !abortFlag.abort) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      clearInterval(monitor);
      try { await sseResult.stream.return?.(undefined); } catch { /* ignore */ }
    }
  }

  async compactSession(sessionId: string, model?: { providerID: string; modelID: string }): Promise<void> {
    const client = await this.getClient();
    await client.session.summarize({
      sessionID: sessionId,
      directory: this.settings.directory,
      ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
    });
  }

  async abortSession(sessionId: string): Promise<void> {
    const client = await this.getClient();
    await client.session.abort({
      sessionID: sessionId,
      directory: this.settings.directory,
    });
  }

  async discoverModels(): Promise<ModelOption[]> {
    const client = await this.getClient();

    // Fetch provider list from API (same as kanban discoverProvidersAndModels)
    const raw = await client.provider.list({
      directory: this.settings.directory,
    });
    const providerData = unwrapData(raw);

    // Build connected set
    const connectedIDs = new Set<string>();
    const connectedRaw: unknown[] = Array.isArray(providerData?.connected) ? providerData.connected : [];
    for (const connected of connectedRaw) {
      const pid = isRecord(connected) ? readProviderID(connected) : toTrimmedString(connected);
      if (pid) connectedIDs.add(pid);
    }

    // Parse all providers
    const allProviders: unknown[] = Array.isArray(providerData?.all) ? providerData.all : [];
    const options: ModelOption[] = [];

    for (const rawProvider of allProviders) {
      if (!isRecord(rawProvider)) continue;
      const providerID = readProviderID(rawProvider);
      if (!providerID) continue;

      const isConnected = connectedIDs.has(providerID) ||
        Boolean(rawProvider.connected) ||
        String(rawProvider.status || "").trim().toLowerCase() === "connected";

      if (!isConnected) continue;

      const models = readModelList(rawProvider.models);
      for (const model of models) {
        const mid = toTrimmedString(model.modelID);
        if (!mid) continue;
        const label = `${providerID}/${mid}`;
        const depthOpts = dedupeOptions(model.reasoningDepthOptions ?? []);
        const explicitDefault = sanitizeDepth(model.defaultReasoningDepth);
        const mergedDepths = [...depthOpts];
        if (explicitDefault && !mergedDepths.includes(explicitDefault)) {
          mergedDepths.unshift(explicitDefault);
        }
        const defaultDepth = explicitDefault ?? (mergedDepths.length ? pickDefaultDepth(mergedDepths) : undefined);

        options.push({
          providerID,
          modelID: mid,
          label,
          ...(mergedDepths.length ? { reasoningDepthOptions: mergedDepths } : {}),
          ...(defaultDepth ? { defaultReasoningDepth: defaultDepth } : {}),
        });
      }
    }

    // Deduplicate
    const deduped: ModelOption[] = [];
    const byKey = new Map<string, ModelOption>();
    for (const opt of options) {
      const key = `${opt.providerID}::${opt.modelID}`;
      if (!byKey.has(key)) {
        byKey.set(key, { ...opt });
        deduped.push(byKey.get(key)!);
      }
    }
    return deduped;
  }

  // Server lifecycle
  async waitForReady(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) return true;
      await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  }

  async startServer(): Promise<void> {
    const serveCmd = this.settings.serveCommand ?? "opencode serve";
    const timeoutMs = this.settings.startupTimeoutMs ?? 30000;
    if (await this.isHealthy()) return;
    const tokens = serveCmd.trim().split(/\s+/);
    const cmd = tokens[0];
    const args = tokens.slice(1);
    const child = spawn(cmd, args, {
      shell: true,
      detached: true,
      stdio: "ignore",
      cwd: this.settings.directory,
    });
    child.unref();
    const ready = await this.waitForReady(timeoutMs);
    if (!ready) throw new Error(`OpenCode server did not become ready within ${timeoutMs}ms.`);
  }
}
