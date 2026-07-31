// =============================================================================
// Shared shapes for the type-checked JavaScript pass.
//
// Nothing here is compiled or shipped: `npm run typecheck` reads it, Node never
// sees it. It exists because the record shapes in this project have drifted
// repeatedly — detected_version, indexer_url and operator_domain were each added
// in a different commit, in three different places — and there was no single
// statement of what a node record actually is. Referencing these from JSDoc
// (`@type {import("../types.js").PublicNode}`) makes a drift a type error.
// =============================================================================

/** A node as published in data/dojos.json and rendered on a card. */
export interface PublicNode {
  id: string;
  network: "mainnet" | "testnet";
  name: string;
  name_url: string | null;
  status: "active" | "inactive";
  paynym: string | null;
  paymentCode: string | null;
  jurisdiction: string | null;
  country: string | null;
  hardware: string | null;
  /** Effective version: the live-probed reading, else the pairing payload's. */
  version: string | null;
  /** Read from the node's X-Dojo-Version response header by the updater. */
  detected_version: string | null;
  /** Read from the node's /support/services by the updater. */
  detected_indexer: string | null;
  /** Published Electrum endpoint: detected, else declared. Null renders N/A. */
  indexer_url: string | null;
  /** The operator's verified domain, if they have proved one. */
  operator_domain: string | null;
  checked_at: string | null;
  block_height: number | null;
  payload: PairingPayload;
  signed: string | null;
}

export interface PairingPayload {
  pairing: {
    type: string;
    version?: string;
    apikey?: string;
    url: string;
  };
  explorer?: { type?: string; url?: string };
  indexer?: { type?: string; url?: string };
  services?: Array<{ type?: string; kind?: string; url?: string }>;
}

/** An operator's submission as held in the store (server/data/store.json). */
export interface StoreRecord {
  id: string;
  network: "mainnet" | "testnet";
  name: string;
  name_url: string | null;
  /** Moderation state; ids are immutable so history survives a rename. */
  status: "pending" | "approved" | "rejected";
  paynym: string | null;
  /** A PayNym usually has two BIP47 variants; either may have signed. */
  paymentCodes: string[];
  jurisdiction: string | null;
  country: string | null;
  hardware: string | null;
  payload: PairingPayload;
  signed: string | null;
  created_at?: string;
  updated_at?: string;
}

/** A verified operator domain, keyed by payment code. */
export interface DomainClaim {
  paymentCode: string;
  domain: string;
  /** The wallet-signed statement; permanent, unlike the TXT record. */
  signed: string;
  verified: boolean;
  verified_at: string | null;
  last_check: string | null;
  last_result: string | null;
  /** Set when a re-check first fails; the grace period runs from here. */
  fail_since: string | null;
  created_at: string;
  revoked?: boolean;
  also_claimed_by?: string | null;
}

/**
 * Transport settings a probe cannot work without. Marked required deliberately:
 * omitting them is the bug that broke the installer's anchor check, where
 * net.connect was handed an undefined port.
 */
export interface ProbeCfg {
  proxyHost: string;
  proxyPort: number;
  timeoutMs: number;
  apikey?: string;
  network?: string;
  connectOnly?: boolean;
  dojoVersionHeader?: string;
}

export interface ProbeResult {
  up: boolean;
  reason: string;
  ms: number;
  height?: number;
  blockTime?: number | null;
  detectedVersion?: string | null;
  detectedIndexer?: string | null;
}

// Front-end globals: assets/js/app.js is a plain script, and these are provided
// by the separate <script> tags for qrcode.js and markdown.js.
declare global {
  const qrcode: (typeNumber: number, errorCorrectionLevel: string) => {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
  const markdown: { render(src: string): string };
}
