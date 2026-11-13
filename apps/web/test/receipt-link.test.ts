import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiptFromLink, receiptLink } from "../src/receipt-link";
import { verifyReceipt } from "../src/verify-core";

const sample = JSON.parse(readFileSync(join(__dirname, "..", "public", "samples", "receipt.json"), "utf8"));

describe("a receipt inside its link", () => {
  it("comes out exactly as it went in, and still verifies", async () => {
    const link = await receiptLink(sample, "https://sein-near.vercel.app");
    expect(link.startsWith("https://sein-near.vercel.app/verify.html#receipt=z.")).toBe(true);
    expect(link.length).toBeLessThan(4000);
    const back = JSON.parse((await receiptFromLink(link))!);
    expect(back).toEqual(sample);
    expect(verifyReceipt(back, "").valid).toBe(true);
  });

  it("stays after the #, so no server ever sees it", async () => {
    const url = new URL(await receiptLink(sample, "https://sein-near.vercel.app"));
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/verify.html");
  });

  it("says nothing for text that carries no receipt", async () => {
    expect(await receiptFromLink("https://nearblocks.io/txns/abc")).toBeUndefined();
    expect(await receiptFromLink("")).toBeUndefined();
  });
});
