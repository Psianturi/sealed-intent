import { describe, expect, it } from "vitest";
import { FreezeStore } from "../src/freeze";

const HOUR = 3_600_000;

describe("limit probes are counted over a day", () => {
  it("three cap refusals spread over a day still add up", () => {
    const f = new FreezeStore(":memory:");
    const t = Date.now();
    f.recordBlock("agent", "limit", t);
    f.recordBlock("agent", "limit", t + 5 * HOUR);
    const third = f.recordBlock("agent", "limit", t + 20 * HOUR);
    expect(third.limitProbes).toBe(3);
    // other blocks are still counted per hour
    expect(third.blocks).toBe(1);
  });

  it("a refusal older than a day no longer counts", () => {
    const f = new FreezeStore(":memory:");
    const t = Date.now();
    f.recordBlock("agent", "limit", t);
    expect(f.recordBlock("agent", "limit", t + 25 * HOUR).limitProbes).toBe(1);
  });

  it("each agent is counted on its own", () => {
    const f = new FreezeStore(":memory:");
    const t = Date.now();
    f.recordBlock("a", "limit", t);
    f.recordBlock("a", "limit", t + HOUR);
    expect(f.recordBlock("b", "limit", t + 2 * HOUR).limitProbes).toBe(1);
  });
});
