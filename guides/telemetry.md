# CrateStack Telemetry

## Status

Implemented current-state documentation for the generated tracing slice.

CrateStack currently emits structured `tracing` spans and events from generated server code, but it does not install or
configure a subscriber for the host application.

## Current Coverage

Generated telemetry currently covers:

1. generated procedure authorization and invocation wrappers
2. generated Axum procedure routes
3. generated Axum model list routes, including `@@paged` list responses

Generated telemetry does not currently cover:

1. generated model detail routes
2. generated model create, update, or delete routes
3. metrics export, OpenTelemetry export, or a dedicated telemetry abstraction layer

## Host Setup

CrateStack re-exports `tracing` as `cratestack::tracing`, but subscriber setup stays host-owned.

Minimal example:

```rust
use tracing_subscriber::{fmt, EnvFilter};

pub fn init_telemetry() {
    let _ = fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("cratestack=info")),
        )
        .try_init();
}
```

Use `cratestack=debug` if you want to see procedure authorization events in addition to the default route and invocation
completion events.

## Generated Procedure Telemetry

Generated procedure wrappers emit:

1. `debug` on successful `authorize(...)`
2. `warn` on failed `authorize(...)`
3. `debug` on successful `authorize_with_db(...)`
4. `info` / `warn` on `invoke(...)` completion or failure
5. `info` / `warn` on `invoke_with_db(...)` completion or failure

Generated procedure HTTP handlers also emit:

1. an `info_span!` named `cratestack_procedure_route`
2. `warn` events for transport preflight, auth, or decode failures
3. `info` / `warn` on route completion or failure

Procedure invocation spans are named:

1. `cratestack_procedure_invoke`
2. `cratestack_procedure_invoke_with_db`

## Generated Model List Telemetry

Generated model list handlers emit:

1. an `info_span!` named `cratestack_model_list_route`
2. `warn` events for response negotiation failures
3. `warn` events for auth failures
4. `warn` events for query parsing or selection validation failures
5. `warn` events when `limit` or `offset` are negative
6. `info` / `warn` on list completion or failure

For `@@paged` models, the completion event also records the paged result shape and total-count metadata.

## Event Fields

Current generated fields include:

| Field                     | Meaning                                                                                 |
|---------------------------|-----------------------------------------------------------------------------------------|
| `cratestack_route`         | Generated HTTP route path such as `/$procs/getFeedPage` or `/posts`                     |
| `cratestack_model`         | Model name for generated model list routes                                              |
| `cratestack_procedure`     | Procedure name for generated procedure wrappers and routes                              |
| `cratestack_operation`     | Operation label such as `procedure`, `list`, `authorize`, `invoke`, or `invoke_with_db` |
| `cratestack_authenticated` | Whether the resolved `CratestackContext` is authenticated                                     |
| `cratestack_error`         | `CratestackError::code()` for failed operations                                               |
| `cratestack_duration_ms`   | End-to-end elapsed time recorded by the generated wrapper or route                      |
| `cratestack_paged`         | Whether a generated model list route returned a `Page<T>` envelope                      |
| `cratestack_limit`         | Parsed `limit` query value when present                                                 |
| `cratestack_offset`        | Parsed `offset` query value when present                                                |
| `cratestack_count`         | Number of items returned by the completed list response                                 |
| `cratestack_total_count`   | Total result count recorded for paged list responses                                    |
| `cratestack_detail`        | `CratestackError::detail()` on route-level `warn` events — preflight, auth, query-parsing, and selection-validation failures |
| `cratestack_request_id`    | Request id from `CratestackContext`, recorded on procedure route completion/failure events and on model list completion/failure events |

All current generated events use the `cratestack` tracing target.

## Current Boundaries

This telemetry slice is intentionally narrow:

1. it is generated directly with `tracing` macros instead of a framework-specific telemetry trait
2. it focuses on route, authorization, and list/procedure execution visibility rather than metrics or distributed
   tracing
3. it documents the current implemented behavior only, not a future observability roadmap

If the generated surface expands later, this document should stay aligned with the actual emitted spans and fields
rather than target-state aspirations.
