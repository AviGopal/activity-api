import type { BunRequest } from "bun";

const ACTIVITY_API_ENDPOINT = process.env.ACTIVITY_API_ENDPOINT ?? "http://localhost:3000";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

interface TemplateItem {
  id: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

interface TemplateListResponse {
  items?: TemplateItem[];
  data?: TemplateItem[];
  [key: string]: unknown;
}

interface SelectActivityRequest {
  goal: string;
  apiKey?: string;
}

interface SelectActivityResult {
  selected: TemplateItem | null;
  reuseList: TemplateItem[];
}

async function fetchTemplates(bareId: string, apiKey: string): Promise<TemplateItem[]> {
  const url = `${ACTIVITY_API_ENDPOINT}/v2/activities/templates?q=${encodeURIComponent(bareId)}&limit=10`;
  const res = await fetch(url, {
    headers: { Authorization: `ApiKey ${apiKey}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as TemplateListResponse;
  const items = json.items ?? json.data ?? [];
  return items;
}

async function selectBestTemplate(
  goal: string,
  templates: TemplateItem[],
): Promise<TemplateItem | null> {
  if (templates.length === 0) return null;
  if (templates.length === 1) return templates[0] ?? null;

  const prompt = [
    "You are an activity selector. Given a goal and a list of activity templates, return the index (0-based) of the best matching template as a JSON object: {\"index\": N}.",
    `Goal: ${goal}`,
    "Templates:",
    ...templates.map((t, i) => `${i}: ${t.name ?? t.id} — ${t.description ?? ""}`),
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 64,
    }),
  });

  if (!res.ok) return templates[0] ?? null;

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(content) as { index?: number };
    const idx = parsed.index ?? 0;
    return templates[idx] ?? templates[0] ?? null;
  } catch {
    return templates[0] ?? null;
  }
}

export async function handleSelectActivityForGoal(
  req: BunRequest,
): Promise<Response> {
  let body: SelectActivityRequest;
  try {
    body = (await req.json()) as SelectActivityRequest;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { goal, apiKey } = body;
  if (!goal || typeof goal !== "string") {
    return Response.json({ error: "'goal' string is required" }, { status: 400 });
  }

  const key = apiKey ?? "";
  const bareId = goal.replace(/^[a-z]+:/, "");

  const templates = await fetchTemplates(bareId, key);
  const selected = await selectBestTemplate(goal, templates);

  const result: SelectActivityResult = {
    selected,
    reuseList: templates,
  };

  return Response.json(result);
}
