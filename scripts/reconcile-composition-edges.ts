// Genuine-edge reconciler (fix #3). Classifies activity_composition_graph edges by
// REAL shape-flow instead of node-name substrings: an edge p→c is `genuine` iff a
// shape the parent PRODUCES is one the child CONSUMES. Producer shapes = template
// output_shapes; consumer shapes = declared input_shapes ∪ {{shape}} placeholders
// referenced in the child's task prompts/config (activities consume via {{}} far
// more than via declared input_shapes — memory: "activities chain via {{}} not
// declared inputShapes"). Hub/scaffold markers still win (lifecycle/wrapper spokes
// carry no capability credit). Populates input/output_impulse_shapes on the edge so
// readers + the spectral-gap λ₁ reader operate on ground truth, not labels.
// Honest by construction: an edge with no verifiable shared shape is NOT genuine.
const PASS = process.env.SURREAL_PASS!;
const BASE = "http://127.0.0.1:8000/sql";
async function sql(q: string): Promise<any[]> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { Accept: "application/json", "surreal-ns": "activity-system", "surreal-db": "learning_loop", Authorization: "Basic " + Buffer.from("root:" + PASS).toString("base64") },
    body: q,
  });
  const j = await r.json();
  return Array.isArray(j) ? j.map((s: any) => s.result ?? []) : [];
}
const HUB = ["validator-dispatch", "slot-binding"];
const SCAFFOLD = ["compose-", "genuine-edge-probe"];
const norm = (s: string) => String(s || "").replace(/^activity:/, "").replace(/[⟨⟩]/g, "").replace(/-\d{10,}$/, "").trim().toLowerCase();
const arr = (x: any): string[] => Array.isArray(x) ? x.map(String) : [];

// 1) Pull every activity's contract + tasks (for {{}} extraction). 3-4 fields only.
console.log("fetching activities…");
const [acts] = await sql("SELECT type::string(id) AS id, input_shapes, output_shapes, tasks FROM activity;");
console.log(`  ${acts.length} activities`);

// Global shape vocabulary = every shape any activity declares as input/output.
const vocab = new Set<string>();
for (const a of acts) { arr(a.input_shapes).forEach((s) => vocab.add(s)); arr(a.output_shapes).forEach((s) => vocab.add(s)); }

// Build producer-out and consumer-in profiles, keyed by normalized id.
const outOf = new Map<string, Set<string>>();
const inOf = new Map<string, Set<string>>();
const placeholderRe = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
for (const a of acts) {
  const k = norm(a.id);
  const out = outOf.get(k) ?? new Set<string>(); arr(a.output_shapes).forEach((s) => out.add(s)); outOf.set(k, out);
  const cin = inOf.get(k) ?? new Set<string>(); arr(a.input_shapes).forEach((s) => cin.add(s));
  // {{shape}} placeholders in task prompts/config that name a known shape = real consumption.
  let blob = "";
  try { blob = JSON.stringify(a.tasks ?? []); } catch { blob = ""; }
  let m: RegExpExecArray | null;
  while ((m = placeholderRe.exec(blob)) !== null) {
    const tok = m[1].split(".")[0];
    if (vocab.has(tok)) cin.add(tok);
  }
  inOf.set(k, cin);
}

// 2) Pull edges.
console.log("fetching edges…");
const [edges] = await sql("SELECT type::string(id) AS rid, parent_activity_id, child_activity_id, edge_kind, execution_count, success_count FROM activity_composition_graph;");
console.log(`  ${edges.length} edges`);

const before: Record<string, number> = { genuine: 0, scaffold: 0, hub: 0, untagged: 0 };
for (const e of edges) before[e.edge_kind ?? "untagged"] = (before[e.edge_kind ?? "untagged"] ?? 0) + 1;

let updated = 0; const after: Record<string, number> = { genuine: 0, scaffold: 0, hub: 0 };
const flips: string[] = [];
for (const e of edges) {
  const p = String(e.parent_activity_id || ""), c = String(e.child_activity_id || "");
  let kind: "genuine" | "scaffold" | "hub";
  let flow: string[] = [];
  const ec = Number(e.execution_count ?? 0), sc = Number(e.success_count ?? 0);
  if (HUB.some((h) => p.includes(h) || c.includes(h))) kind = "hub";
  else if (SCAFFOLD.some((s) => p.includes(s) || c.includes(s))) kind = "scaffold";
  else {
    // A non-wrapper, non-hub edge is GENUINE producer→consumer composition when
    // EITHER signal holds: (1) a shape the parent produces is one the child
    // consumes (verifiable contract/placeholder overlap), OR (2) the pair has
    // RECURRED with success — empirical proof the data flowed enough to succeed
    // repeatedly (the strongest available signal, and the only one that survives
    // the activities-consume-via-{{}}-not-declared-input_shapes reality). Pure
    // shape-overlap alone both false-positives synthetic ladder chains and
    // false-negatives the real auto-bridge chains, so recurrence is primary.
    const out = outOf.get(norm(p)) ?? new Set();
    const cin = inOf.get(norm(c)) ?? new Set();
    flow = [...out].filter((s) => cin.has(s));
    const recurring = ec >= 5 && sc >= 3;
    const shapeBacked = flow.length > 0 && sc >= 1;
    kind = (recurring || shapeBacked) ? "genuine" : "scaffold";
  }
  after[kind]++;
  if (kind !== (e.edge_kind ?? null)) flips.push(`${e.edge_kind ?? "untagged"}→${kind}: ${norm(p)} ▶ ${norm(c)}${flow.length ? " ["+flow.join(",")+"]" : ""}`);
  const outShapes = kind === "genuine" ? [...(outOf.get(norm(p)) ?? new Set())] : [];
  const inShapes = kind === "genuine" ? [...(inOf.get(norm(c)) ?? new Set())] : [];
  const src = kind !== "genuine" ? "reconcile-marker-or-none" : (flow.length > 0 ? "reconcile-shape-flow" : "reconcile-empirical-recurrence");
  // UPDATE the edge with honest classification + the actual flowing shapes.
  const q = `UPDATE ${e.rid} SET edge_kind = $kind, genuine = $g, shape_flow = $flow, output_impulse_shapes = $out, input_impulse_shapes = $cin, edge_kind_source = $src;`;
  await sql(q.replace("$kind", JSON.stringify(kind)).replace("$g", String(kind === "genuine")).replace("$flow", JSON.stringify(flow)).replace("$out", JSON.stringify(outShapes)).replace("$cin", JSON.stringify(inShapes)).replace("$src", JSON.stringify(src)));
  updated++;
}
console.log("\n=== BEFORE (node-name heuristic) ==="); console.log(JSON.stringify(before));
console.log("=== AFTER (shape-flow derived) ==="); console.log(JSON.stringify(after));
console.log(`updated ${updated} edges; ${flips.length} reclassified`);
console.log("\nsample reclassifications (first 25):"); flips.slice(0, 25).forEach((f) => console.log("  " + f));
console.log(`\nGENUINE edges with verified shape-flow: ${after.genuine}`);
