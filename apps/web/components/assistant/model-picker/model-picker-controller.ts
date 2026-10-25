/**
 * CHAT-5: state for the composer's model and effort picker (no React; tested directly).
 *
 * Loads the thread's model state (GET …/threads/[threadId]/model), lists a provider's models
 * through /api/models?providerId= (the server refuses providers that are off for the company), and
 * saves the choice on the thread (PUT; "Agent default" clears it with DELETE). Only providers the
 * server returned (switched on for the company) can be chosen.
 */
import type { ReasoningLevel } from '@tourbillon/shared/model-settings';
import type { ModelReasoningCapabilities } from '@tourbillon/shared/reasoning-capabilities';
import {
  effortForModel,
  effortLevelsForModel,
  type ThreadModelChoice,
  type ThreadModelState,
} from '@/lib/assistant/thread-model';

export interface PickerModel {
  id: string;
  reasoningCapabilities?: ModelReasoningCapabilities;
}

export interface ModelPickerSnapshot {
  status: 'loading' | 'ready' | 'error';
  state: ThreadModelState | null;
  /** Provider selected in the picker; '' = agent default. */
  providerId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel | '';
  /** Models of the selected provider (null while loading or with the agent default). */
  models: PickerModel[] | null;
  modelsLoading: boolean;
  /** Effort levels for the selected model; empty → effort not shown. */
  effortLevels: ReasoningLevel[];
  saving: boolean;
  error: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ModelPickerControllerOptions {
  agentId: string;
  threadId: string;
  fetch?: FetchLike;
}

export interface ModelPickerController {
  getSnapshot(): ModelPickerSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  selectProvider(providerId: string): Promise<void>;
  selectModel(modelId: string): Promise<void>;
  selectEffort(level: ReasoningLevel | ''): Promise<void>;
}

const INITIAL: ModelPickerSnapshot = {
  status: 'loading',
  state: null,
  providerId: '',
  modelId: '',
  reasoningLevel: '',
  models: null,
  modelsLoading: false,
  effortLevels: [],
  saving: false,
  error: null,
};

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error ? body.error : fallback;
}

export function createModelPickerController(opts: ModelPickerControllerOptions): ModelPickerController {
  const f: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const url = `/api/assistant/agents/${encodeURIComponent(opts.agentId)}/threads/${encodeURIComponent(opts.threadId)}/model`;
  const listeners = new Set<() => void>();
  let snap: ModelPickerSnapshot = INITIAL;
  let modelsRequest = 0;

  const set = (patch: Partial<ModelPickerSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const l of listeners) l();
  };

  const providerType = (providerId: string) => snap.state?.providers.find((p) => p.id === providerId)?.type;
  const levelsFor = (modelId: string, models: PickerModel[] | null, providerId: string) =>
    modelId
      ? effortLevelsForModel(modelId, models?.find((m) => m.id === modelId)?.reasoningCapabilities, providerType(providerId))
      : [];

  function applyState(state: ThreadModelState) {
    const choice = state.choice;
    const keep = choice && state.choiceAvailable ? choice : null;
    set({
      status: 'ready',
      state,
      providerId: keep?.providerId ?? '',
      modelId: keep?.modelId ?? '',
      reasoningLevel: keep?.reasoningLevel ?? '',
      error: choice && !state.choiceAvailable ? "This thread's model is no longer available. Choose another one." : null,
    });
  }

  async function loadModels(providerId: string): Promise<PickerModel[] | null> {
    const request = ++modelsRequest;
    set({ models: null, modelsLoading: true });
    try {
      const res = await f(`/api/models?providerId=${encodeURIComponent(providerId)}`);
      if (request !== modelsRequest) return null;
      if (!res.ok) {
        set({ modelsLoading: false, models: [], error: await errorText(res, 'Could not list models') });
        return null;
      }
      const body = (await res.json()) as { models?: PickerModel[] };
      const models = Array.isArray(body.models) ? body.models.filter((m) => m && typeof m.id === 'string') : [];
      set({ modelsLoading: false, models, effortLevels: levelsFor(snap.modelId, models, providerId) });
      return models;
    } catch {
      if (request === modelsRequest) set({ modelsLoading: false, models: [], error: 'Could not list models' });
      return null;
    }
  }

  async function save(choice: ThreadModelChoice | null): Promise<boolean> {
    set({ saving: true, error: null });
    try {
      const res = choice
        ? await f(url, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(choice),
          })
        : await f(url, { method: 'DELETE' });
      if (!res.ok) {
        set({ saving: false, error: await errorText(res, 'Could not change the model') });
        return false;
      }
      const body = (await res.json()) as { state: ThreadModelState };
      set({ saving: false, state: body.state });
      return true;
    } catch {
      set({ saving: false, error: 'Could not change the model' });
      return false;
    }
  }

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      set({ status: 'loading', error: null });
      try {
        const res = await f(url);
        if (!res.ok) {
          set({ status: 'error', error: await errorText(res, 'Could not load the model') });
          return;
        }
        const { state } = (await res.json()) as { state: ThreadModelState };
        applyState(state);
        if (snap.providerId) await loadModels(snap.providerId);
      } catch {
        set({ status: 'error', error: 'Could not load the model' });
      }
    },
    async selectProvider(providerId) {
      if (providerId === snap.providerId) return;
      if (!providerId) {
        modelsRequest++;
        const previous = { providerId: snap.providerId, modelId: snap.modelId, reasoningLevel: snap.reasoningLevel };
        set({ providerId: '', modelId: '', reasoningLevel: '', models: null, modelsLoading: false, effortLevels: [] });
        if (!(await save(null))) set(previous);
        return;
      }
      if (!snap.state?.providers.some((p) => p.id === providerId)) return;
      // A model has to be picked before the choice is saved.
      set({ providerId, modelId: '', reasoningLevel: '', effortLevels: [], error: null });
      await loadModels(providerId);
    },
    async selectModel(modelId) {
      if (!snap.providerId || !modelId || modelId === snap.modelId) return;
      const effortLevels = levelsFor(modelId, snap.models, snap.providerId);
      const reasoningLevel = effortForModel(snap.reasoningLevel || undefined, effortLevels) ?? '';
      set({ modelId, effortLevels, reasoningLevel });
      await save({ providerId: snap.providerId, modelId, ...(reasoningLevel ? { reasoningLevel } : {}) });
    },
    async selectEffort(level) {
      if (!snap.providerId || !snap.modelId) return;
      if (level && !snap.effortLevels.includes(level)) return;
      const previous = snap.reasoningLevel;
      set({ reasoningLevel: level });
      const ok = await save({ providerId: snap.providerId, modelId: snap.modelId, ...(level ? { reasoningLevel: level } : {}) });
      if (!ok) set({ reasoningLevel: previous });
    },
  };
}
