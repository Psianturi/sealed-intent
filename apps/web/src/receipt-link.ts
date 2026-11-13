// A receipt can travel inside its own link, after the #. Browsers never send that part to a server.
const toText = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const toBytes = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const pipe = async (bytes: Uint8Array, through: CompressionStream | DecompressionStream) => new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(through)).arrayBuffer());

export async function receiptLink(receipt: unknown, base: string): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(receipt));
  const packed = typeof CompressionStream === "function" ? `z.${toText(await pipe(raw, new CompressionStream("deflate-raw")))}` : `j.${toText(raw)}`;
  return `${base}/verify.html#receipt=${packed}`;
}

/** The receipt JSON carried by a link, or undefined when the text holds none. */
export async function receiptFromLink(text: string): Promise<string | undefined> {
  const m = text.match(/#receipt=([zj])\.([A-Za-z0-9_-]+)/);
  if (!m) return undefined;
  const bytes = toBytes(m[2]!);
  return new TextDecoder().decode(m[1] === "z" ? await pipe(bytes, new DecompressionStream("deflate-raw")) : bytes);
}
