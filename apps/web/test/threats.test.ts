import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKS, render, type Incident } from "../src/incident-watch";

const data = JSON.parse(readFileSync(join(__dirname, "..", "public", "threats", "incidents.json"), "utf8"));
const list: Incident[] = data.incidents;

describe("public incident dataset", () => {
  it("has the expected header", () => {
    expect(data.schema).toBe(1);
    expect(data.license).toBe("CC BY 4.0");
    expect(data.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(list.length).toBeGreaterThan(0);
  });

  it("gives every record the required fields", () => {
    for (const r of list) {
      expect(r.id, JSON.stringify(r)).toBeTruthy();
      expect(r.title, r.id).toBeTruthy();
      expect(r.date, r.id).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
      expect(r.category, r.id).toBeTruthy();
      expect(Object.keys(CHECKS), r.id).toContain(r.seinCheck);
      expect(r.sources.some((s) => s.url.startsWith("https://")), r.id).toBe(true);
    }
  });

  it("publishes no unverified claims or working fields", () => {
    for (const r of list) {
      expect(r, r.id).not.toHaveProperty("unverified");
      expect(r, r.id).not.toHaveProperty("addedRun");
      expect(["high", "medium"], r.id).toContain((r as unknown as { confidence: string }).confidence);
    }
  });

  it("has unique ids", () => {
    const ids = list.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("incident watch rendering", () => {
  it("shows six rows until expanded and escapes text", () => {
    const evil = { ...list[0]!, id: "x", date: "2099-01-01", title: '<img src=x onerror="alert(1)">' };
    const html = render([evil, ...list]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect((html.match(/class="iw-row/g) ?? []).length).toBe(list.length + 1);
    expect((html.match(/ hidden>/g) ?? []).length).toBe(list.length + 1 - 6);
    expect(html).not.toMatch(/would have (been )?(prevented|stopped|blocked)/i);
  });
});
