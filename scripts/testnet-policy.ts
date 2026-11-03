import { DEMO_POLICY, Policy, TESTNET_ASSET } from "@sealed-intent/core";

/** SeIn's own policy for the testnet runs. An enclave objection goes to the owner, so the approval path runs. */
export const testnetPolicy = (wallet: string, vendor: string) =>
  Policy.parse({
    ...DEMO_POLICY,
    allowedAssets: [TESTNET_ASSET.NEAR, TESTNET_ASSET.wNEAR],
    allowedRecipients: [vendor],
    unknownRecipient: "warn",
    minAccountAgeDays: 0,
    ownAccounts: [wallet],
    perTxUsd: 2,
    hourlyUsd: 20,
    dailyUsd: 20,
    contracts: {},
    tee: { ...DEMO_POLICY.tee, required: true, obeyBlockSignal: false },
    freeze: { onForbiddenAction: true, maxBlocksPerHour: 50, maxLimitProbesPerDay: 3 },
  });
