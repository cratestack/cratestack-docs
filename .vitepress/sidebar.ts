import type { DefaultTheme } from "vitepress";

// The sidebar, in the order and grouping the Mintlify site's `docs.json` had: one
// sidebar per former tab. VitePress picks the deepest key that matches the
// page's path, so `/studio/` and `/internals/` win over `/`.
//
// A new page is not in the navigation until it is listed here. Each `text`
// is the page's frontmatter `title` (or its H1); it is rendered as HTML, so
// write `<` as `&lt;` and code as `<code>…</code>`.

const documentation: DefaultTheme.SidebarItem[] = [
  {
    text: "Overview",
    items: [
      { text: "Introduction", link: "/" },
      { text: "Current State", link: "/overview/current-state" },
      { text: "Banking Readiness", link: "/overview/banking-readiness" },
      { text: "Release Track", link: "/overview/release-track" },
      { text: "Migrating to 0.8.0", link: "/overview/migrating-to-0-8" },
      { text: "Migrating the Dart client to the HTTP transport", link: "/overview/migrating-dart-http-transport" },
      { text: "Roadmap", link: "/overview/roadmap" },
      { text: "Branding", link: "/overview/branding" },
    ],
  },
  {
    text: "Get Started",
    items: [
      { text: "Quickstart", link: "/getting-started/quickstart" },
      { text: "Auth Provider", link: "/guides/auth-provider" },
      { text: "Step-up examples", link: "/guides/step-up-examples" },
    ],
  },
  {
    text: "Guides",
    items: [
      { text: "CrateStack Telemetry", link: "/guides/telemetry" },
      { text: "Validators", link: "/guides/validators" },
      { text: "Offline-First with Embedded SQLite", link: "/guides/offline-first-sqlite" },
      { text: "Async I/O with Embedded SQLite", link: "/guides/async-io-with-embedded-sqlite" },
      { text: "Materialized views", link: "/guides/materialized-views" },
      { text: "Spatial Columns (PostGIS)", link: "/guides/spatial-postgis" },
      { text: "Search with Filters — FindMany&lt;Model&gt;", link: "/guides/find-many" },
      { text: "Declarative Query Blocks", link: "/guides/declarative-query" },
      { text: "Computed Fields", link: "/guides/computed-fields" },
      { text: "Prepared Statements and Query Caching", link: "/guides/prepared-statements-and-caching" },
      { text: "Reducing payload size", link: "/guides/payload-size" },
      { text: "RPC transport", link: "/guides/rpc-transport" },
      { text: "MCP: tools and resources for agents", link: "/guides/mcp" },
      { text: "Procedures-Only Servers with No Database", link: "/guides/no-database-procedures" },
    ],
  },
  {
    text: "Client Generation",
    items: [
      { text: "TypeScript client generation", link: "/guides/typescript-client-generation" },
      { text: "Dart client generation", link: "/guides/dart-client-generation" },
      { text: "Dart HTTP transport", link: "/guides/dart-http-transport" },
      { text: "The fespalier preset", link: "/guides/dart-fespalier-preset" },
      { text: "refine.dev integration", link: "/guides/refine-integration" },
    ],
  },
  {
    text: "Banking Readiness",
    items: [
      { text: "Idempotency", link: "/guides/idempotency" },
      { text: "Signed transport (COSE envelope layer)", link: "/guides/signed-transport" },
      { text: "Upsert", link: "/guides/upsert" },
      { text: "Batches", link: "/guides/batches" },
      { text: "Optimistic Locking", link: "/guides/optimistic-locking" },
      { text: "Audit Log", link: "/guides/audit-log" },
      { text: "Trusted Proxy / Client IP", link: "/guides/trusted-proxy" },
      { text: "Transaction Isolation", link: "/guides/transaction-isolation" },
      { text: "Rate Limiting", link: "/guides/rate-limiting" },
      { text: "Soft Delete", link: "/guides/soft-delete" },
      { text: "Pagination", link: "/guides/pagination" },
      { text: "Migrations", link: "/guides/migrations" },
    ],
  },
  {
    text: "Architecture",
    items: [
      { text: "CrateStack Transport Architecture", link: "/architecture/transport-architecture" },
      { text: "CrateStack HTTP Transport Contract", link: "/architecture/http-transport-contract" },
      { text: "CrateStack Client Runtime Architecture", link: "/architecture/client-runtime" },
    ],
  },
  {
    text: "Tooling",
    items: [
      { text: "Installing the CLI", link: "/tooling/cli-install" },
      { text: "Schema diff", link: "/tooling/schema-diff" },
      { text: "Adopting an Existing Database", link: "/tooling/migrate-baseline" },
      { text: "CrateStack Editor Tooling", link: "/tooling/editor-tooling" },
      { text: "Generating WireMock stubs", link: "/tooling/generate-wiremock" },
      { text: "Agent Skills", link: "/tooling/agent-skills" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Mixins", link: "/reference/mixins" },
      { text: "Field Attributes", link: "/reference/field-attributes" },
      { text: "Composite Keys", link: "/reference/composite-keys" },
      { text: "Scalars", link: "/reference/scalars" },
      { text: "Auth Support Matrix", link: "/reference/auth-support-matrix" },
      { text: "Crypto Provider", link: "/reference/crypto" },
      { text: "Views", link: "/reference/views" },
    ],
  },
];

const studio: DefaultTheme.SidebarItem[] = [
  {
    text: "Get Started",
    items: [
      { text: "Studio Quickstart", link: "/studio/quickstart" },
    ],
  },
  {
    text: "API",
    items: [
      { text: "Studio Read API", link: "/studio/read-api" },
      { text: "Studio Write API", link: "/studio/write-api" },
    ],
  },
  {
    text: "Extending",
    items: [
      { text: "Studio Power Tools", link: "/studio/tools" },
      { text: "Studio UI", link: "/studio/ui" },
      { text: "Studio Eject", link: "/studio/eject" },
    ],
  },
];

const internals: DefaultTheme.SidebarItem[] = [
  {
    text: "Architecture Decisions",
    items: [
      { text: "ADR 0001: Core Architecture for CrateStack v0", link: "/internals/core-architecture-adr" },
      { text: "ADR 0002: Optional MCP Operator Surface", link: "/internals/mcp-operator-adr" },
      { text: "ADR 0003: SQL Views as Projections of Models", link: "/internals/views-adr" },
      { text: "ADR 0004: Schema Diff and Migration Generation", link: "/internals/schema-diff-adr" },
      { text: "ADR 0005: RPC Binding for <code>transport rpc</code> Schemas", link: "/internals/rpc-transport-adr" },
      { text: "ADR 0006: COSE Envelope Modes and Key Management", link: "/internals/cose-envelope-adr" },
      { text: "ADR 0020: Offline Sync Engine", link: "/internals/sync-engine-adr" },
      { text: "ADR 0021: Pluggable Authentication: the AuthProvider Seam", link: "/internals/auth-seam-adr" },
      { text: "ADR 0022: Authentication Requirements in the Schema", link: "/internals/authn-requirements-adr" },
    ],
  },
  {
    text: "Planning",
    items: [
      { text: "CrateStack v0 PRD", link: "/internals/product-requirements" },
      { text: "CrateStack Package Selection and Dependency Decision Log", link: "/internals/package-selection" },
    ],
  },
];

export const sidebar: DefaultTheme.Sidebar = {
  "/studio/": studio,
  "/internals/": internals,
  "/": documentation,
};
