# Putting SeIn between your agent and its money

Your agent keeps deciding what to do. It just no longer holds the wallet. It asks SeIn, and only SeIn can make custody sign.

The SeIn gateway runs as its own OS user with the custody key, the policy and the owner token. The agent runs as another user with one agent token, and optionally a signing key.

## 1. Start the gateway and give the agent access

```bash
cp .env.example .env          # fill it in, chmod 600 .env
SEALED_MODE=live pnpm rest    # listens on 127.0.0.1:8787
pnpm owner agent-issue my-agent <agent-public-key-hex>   # prints the agent token once
```

Without a public key the token alone works. With one, every request must also be signed, so a stolen token is useless.

## 2a. Any MCP client

The bridge holds only the agent's token and refuses to start if a secret reached its environment.

```json
{
  "mcpServers": {
    "sein": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/sealed-intent", "mcp:agent"],
      "env": {
        "SEALED_REST_URL": "http://127.0.0.1:8787",
        "SEALED_AGENT_TOKEN": "<token from agent-issue>",
        "SEALED_AGENT_SIGNING_KEY": "<32-byte hex seed, if the agent has a key>"
      }
    }
  }
}
```

Tools: `preflight_swap`, `preflight_transfer`, `preflight_call`, `execute_swap`, `report_counterparty`, `get_receipt`. None of them can approve, freeze or unfreeze.

## 2b. Plain HTTP, in a few lines

```ts
const sein = (path: string, body: unknown, key = crypto.randomUUID()) =>
  fetch(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SEALED_AGENT_TOKEN}`, "Idempotency-Key": key },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const intent = { kind: "transfer", token: "nep141:wrap.near", amount: "1000000000000000000000000", recipient: "bob.near", taskText: userMessage };
const d = await sein("/v1/preflight", { intent });
if (d.verdict === "BLOCK") return `Refused: ${d.reasonCodes.join(", ")}`;
if (d.verdict === "WARN") return "Waiting for the owner"; // execute once the owner approved
const paid = await sein("/v1/execute", { decisionId: d.decisionId }, `pay-${d.decisionId}`);
```

- Always pass `taskText`: the message or task that led to the payment. Without it SeIn cannot screen for tricks and asks the owner.
- Reuse the same `Idempotency-Key` when you retry. The payment then happens once.
- The agent only ever hears generic reasons. It never learns the limits.

If the agent has a signing key, add two headers. The signature is ed25519 over `${timestamp}.${method}.${path}.${sha256hex(body)}`, and each signed request works once within a minute.

```ts
headers["X-SeIn-Timestamp"] = String(Date.now());
headers["X-SeIn-Signature"] = sign(`${ts}.POST./v1/preflight.${sha256hex(raw)}`); // hex
```

## 3. The owner answers

`pnpm owner pending` prints, for each payment that needs a human, a link to the approve page on the SeIn website. It opens the request in plain words and asks for a signature from the owner's NEAR wallet. The link carries the address of your gateway and a one-time key after `#`, so the website never receives them. Set `SEALED_OWNER_ACCOUNT` to require that signature.

## 4. Anyone checks

Every decision has a signed receipt. Publish it, and anyone can check it at `https://sein-near.vercel.app/verify.html`, with the amount and receiver still sealed. With a registry configured, receipts are written to NEAR in batches, so they cannot be edited or made up later.
