// Loads each model alone and records how much memory Ollama gives it:
// once as Saxby serves it (through /v1, so the server's default
// context) and once at a fixed 128K context. Run after the bake-off;
// it unloads everything first.
//
//   deno run -A --no-config --no-lock measure.ts qwen3.8:27b ...

// ---- Constants --------------------------------------------------------

const ROOT = new URL(".", import.meta.url).pathname;

const OUT = `${ROOT}results/memory.json`;

const OLLAMA = "http://127.0.0.1:11434";

const FIXED_CTX = 131_072;

const GIB = 1024 ** 3;

const LOAD_TIMEOUT_MS = 25 * 60_000;

// ---- Types ------------------------------------------------------------

interface PsModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  context_length?: number;
}

// ---- Ollama -----------------------------------------------------------

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${OLLAMA}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`${path}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function loaded(): Promise<PsModel[]> {
  const res = await fetch(`${OLLAMA}/api/ps`);
  const data = await res.json() as { models: PsModel[] };

  return data.models ?? [];
}

async function unloadAll(): Promise<void> {
  for (const model of await loaded()) {
    await post("/api/generate", { model: model.name, keep_alive: 0 });
  }

  for (let i = 0; i < 60; i += 1) {
    if ((await loaded()).length === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("models did not unload");
}

async function loadAsServed(model: string): Promise<void> {
  await post("/v1/chat/completions", {
    model,
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  });
}

async function loadFixed(model: string): Promise<void> {
  await post("/api/generate", {
    model,
    prompt: "",
    keep_alive: "5m",
    options: { num_ctx: FIXED_CTX },
  });
}

// ---- Measuring --------------------------------------------------------

async function sizeOf(model: string, load: (m: string) => Promise<void>) {
  await unloadAll();
  await load(model);

  const tagged = model.includes(":") ? model : `${model}:latest`;

  const entry = (await loaded()).find((item) => {
    return item.name === tagged || item.model === tagged;
  });

  if (!entry) {
    return null;
  }

  return {
    gib: Math.round((entry.size / GIB) * 10) / 10,
    vramGib: Math.round((entry.size_vram / GIB) * 10) / 10,
    context: entry.context_length ?? null,
  };
}

async function readPrevious(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(OUT));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = await readPrevious();

  for (const model of Deno.args) {
    const served = await sizeOf(model, loadAsServed);
    const fixed = await sizeOf(model, loadFixed);

    results[model] = { served, fixed128k: fixed };
    console.log(model, JSON.stringify(results[model]));
  }

  await unloadAll();
  await Deno.writeTextFile(OUT, JSON.stringify(results, null, 2));
}

if (import.meta.main) {
  await main();
}
