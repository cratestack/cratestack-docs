---
title: Spatial Columns (PostGIS)
description: Declare geography and geometry columns in .cstack, emit real PostGIS DDL, and query them with typed ST_Covers, ST_DWithin and ST_Distance builders.
---

# Spatial Columns (PostGIS)

CrateStack can declare PostGIS `geography` / `geometry` columns directly
in `.cstack`, emit the matching DDL and `CREATE EXTENSION`, and query
them through typed builders — so a spatial column is an ordinary part of
the schema rather than something bolted on with a hand-written migration.

## Enabling it

Two things are required, and **both** — this is the most common mistake.

**1. Declare the extension in the schema.** This unlocks the syntax:

```cstack
extension postgis {
}
```

**2. Enable the matching Cargo feature.** This is what makes the
supporting code exist in your build:

```toml
cratestack = { package = "cratestack-pg", features = ["postgis"] }
```

Declaring the extension without the feature is a `compile_error!`, not a
silent no-op — the message names the feature and the facade to enable it
on. The feature pulls in no third-party crate: PostGIS's wire format is
EWKB, which is just bytes.

The feature also gates the query surface (`ST_Covers` / `ST_DWithin` /
`ST_Distance` and their `FieldRef` accessors), so enable it even on a
service that only *queries* spatial columns another service writes.

## Declaring a column

```cstack
extension postgis {
}

model DeliveryZone {
  id           Int    @id
  label        String
  service_area Geography(Polygon, 4326)
  pickup_point Geography(Point, 4326)?

  @@index([service_area], using: gist)
}
```

Both `Geography` (spheroidal — distances in metres on the WGS-84
spheroid) and `Geometry` (planar) are available. Three argument forms
are accepted:

| Written | Emitted | Meaning |
|---|---|---|
| `Geography` | `geography` | Unmodified — any subtype, any SRID. |
| `Geography(Point)` | `geography(Point)` | Subtype fixed; SRID left to PostGIS's default. |
| `Geography(Point, 4326)` | `geography(Point,4326)` | Subtype and SRID both fixed. |

An SRID without a subtype (`Geography(4326)`) is rejected, because
PostGIS's type modifier is positional.

### Subtypes

Subtype names are validated against PostGIS's own vocabulary, so a typo
is a schema error rather than a runtime SQL failure:

`Point`, `LineString`, `Polygon`, `MultiPoint`, `MultiLineString`,
`MultiPolygon`, `GeometryCollection`, `CircularString`, `CompoundCurve`,
`CurvePolygon`, `MultiCurve`, `MultiSurface`, `PolyhedralSurface`,
`Triangle`, `Tin`, and `Geometry` (the "any subtype" modifier).

Each accepts a `Z`, `M`, or `ZM` suffix for 3D and measured geometries —
`PointZ`, `PointZM`, `MultiPolygonZM`. Casing is free (`POINT`, `point`
and `Point` all work) and is normalised into the migration snapshot, so
re-casing a subtype is not treated as a column change.

<Note>
The index attribute takes a **bare** access method name — `using: gist`,
not `using: "gist"`. A quoted value is rejected.
</Note>

## Generated DDL

`cratestack migrate diff` emits the extension once, before any DDL that
references it:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE delivery_zones (
    id BIGINT NOT NULL,
    label TEXT NOT NULL,
    service_area geography(Polygon,4326) NOT NULL,
    pickup_point geography(Point,4326),
    PRIMARY KEY (id)
);

CREATE INDEX delivery_zones_service_area_gist_idx
    ON delivery_zones USING gist (service_area);
```

The type modifier is rendered without a space after the comma, matching
how PostGIS itself reports the type — so a later introspection diff of
the same column compares equal instead of reporting a phantom change.

## Querying

The generated `FieldRef` accessor carries the column name, so it is
checked at compile time:

```rust
use cratestack::point;
use cratestack_schema::delivery_zone;

// Accessors are named after the field as written in `.cstack` —
// `service_area()` here, `serviceArea()` if the field is camelCase.

// ST_Covers — is this point inside the zone?
let covering = delivery_zone::service_area()
    .covers_geography(point(-122.4194, 37.7749));

// ST_DWithin — is the zone within 1500 m of this point?
let nearby = delivery_zone::service_area()
    .dwithin_geography(point(-122.4194, 37.7749), 1500.0);

// ST_Distance — nearest first
let nearest = delivery_zone::service_area()
    .order_by_distance_to(point(-122.4194, 37.7749));
```

`point(lng, lat)` follows PostGIS's `ST_MakePoint(x, y)` convention —
**longitude first**. Nothing can detect a swap for you; the filter will
simply match the wrong side of the world.

`order_by_distance_to` is the ordering half of the pair whose filtering
half is `dwithin_geography`. Use them together for "closest N within X
metres" rather than re-computing distance in application code after the
radius filter returns:

```rust
let zones = db
    .delivery_zone()
    .bind(ctx)
    .find_many()
    .where_expr(delivery_zone::service_area()
        .dwithin_geography(point(lng, lat), 25_000.0))
    .order_by(delivery_zone::service_area()
        .order_by_distance_to(point(lng, lat)))
    .run()
    .await?;
```

For farthest-first, use `.distance_to_point(p).desc()`. A `NULL`
geography compares as a `NULL` distance and sorts last under the
framework's default `NULLS LAST`.

## The Rust type

A spatial field is a `Vec<u8>` holding **EWKB**, PostGIS's binary
format — the same Rust type a `Bytes` field gets, so it serialises as
base64 on the REST/RPC surface and maps to `Uint8List` (Dart) and
`Uint8Array` (TypeScript) in generated clients.

CrateStack does not parse EWKB for you. Produce and consume it with
PostGIS's own functions (`ST_GeogFromText`, `ST_AsEWKB`) or a geometry
crate of your choosing. Writing a literal is usually easiest in SQL:

```sql
INSERT INTO delivery_zones (id, label, service_area)
VALUES (1, 'central',
        ST_GeogFromText('SRID=4326;POLYGON((0 0,2 0,2 2,0 2,0 0))'));
```

## Not supported

- **The embedded backend.** PostGIS is Postgres-only, and
  `include_embedded_schema!` rejects `extension postgis { }`
  unconditionally — no Cargo feature makes it valid, because the
  rusqlite backend ships no SpatiaLite.
- **Procedure arguments and return types.** Spatial types are
  model/mixin/type/auth fields only in this release.
- **Trigger generation.** Deriving a geography from ordinary lat/lng
  columns is application policy, so it belongs in a migration you own.
