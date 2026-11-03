import { mountHero } from "./hero";

mountHero(document.getElementById("stage")!);

// the live bar reads the registry on NEAR directly; without it the bar keeps its built-in numbers
const REGISTRY = "sein-registry-mvy2i59w.testnet";
const RPC = "https://test.rpc.fastnear.com";

async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "home", method: "query", params: { request_type: "call_function", finality: "final", account_id: REGISTRY, method_name: method, args_base64: btoa(JSON.stringify(args)) } }) });
  const j = (await res.json()) as { result: { result: number[] } };
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

async function liveBar() {
  const item = document.querySelector<HTMLElement>('.livebar [data-live="anchored"]');
  if (!item) return;
  const batches = await view<number>("anchor_count");
  const counts = await Promise.all(Array.from({ length: batches }, (_, index) => view<{ count: number }>("get_anchor", { index })));
  const total = counts.reduce((s, a) => s + a.count, 0);
  const b = item.querySelector("b")!;
  item.hidden = false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return void (b.textContent = String(total));
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 900);
    b.textContent = String(Math.round(total * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
void liveBar().catch(() => undefined);
