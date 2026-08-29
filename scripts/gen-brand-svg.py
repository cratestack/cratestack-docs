#!/usr/bin/env python3
"""Emit every CrateStack brand SVG from one geometry definition.

Usage:  python3 scripts/gen-brand-svg.py images/branding

The rasters beside them (PNG/JPEG at each size) are rendered from these
SVGs; regenerate those with any SVG rasteriser if a source changes.

The geometry is MEASURED from the shipped mark (packages/cratestack-vscode/
icon.png), not eyeballed. In the 256-unit space of that file:

    glyph bbox      x 51..204, y 33..226
    side-corner     y 70..106, 111..147, 152..188   (three crate bodies)
    => half-width 76.5, rhombus half-height 37, body height 36, spacing 41

An earlier hand-guessed version was ~35% too wide and too widely spaced, which
measured as only 69.3% of pixels within 8/255 of the original. Everything below
derives from the numbers above so the app icon, the logomark and the file icons
cannot drift from each other or from the mark.
"""

# --- measured geometry, normalised to a unit-height glyph ------------------
M_HALF_W = 76.5   # centre to widest point
M_R = 37.0        # rhombus half-height (top face)
M_H = 36.0        # body height (the vertical side edge)
M_S = 41.0        # centre-to-centre spacing between crates

M_W_TOTAL = M_HALF_W * 2                 # 153
M_H_TOTAL = M_R * 2 + M_S * 2 + M_H      # apex..bottom = 74 + 82 + 36 = 192

BRAND = dict(top="#F7B270", left="#E88A3A", right="#BF6A26")
# Legibility adjustment for near-white backgrounds: same hue, one step deeper.
BRAND_LIGHT = dict(top="#EDA05C", left="#D97B2E", right="#A85920")


def crates(cx, apex_y, scale, palette, indent="  "):
    """Three stacked isometric crates, bottom-drawn-first so upper occlude lower."""
    w, r, h, s = M_HALF_W * scale, M_R * scale, M_H * scale, M_S * scale
    n = lambda v: f"{round(v, 2):g}"
    out, labels = [], ["bottom", "middle", "top"]
    # index 0 is the topmost crate visually; emit in reverse for painter's order
    centres = [apex_y + r + s * i for i in range(3)]
    for label, cy in zip(labels, reversed(centres)):
        L, R_, T, B = cx - w, cx + w, cy - r, cy + r
        out.append(f"{indent}<!-- {label} crate -->")
        out.append(
            f'{indent}<polygon points="{n(cx)},{n(T)} {n(R_)},{n(cy)} '
            f'{n(cx)},{n(B)} {n(L)},{n(cy)}" fill="{palette["top"]}"/>'
        )
        out.append(
            f'{indent}<polygon points="{n(L)},{n(cy)} {n(cx)},{n(B)} '
            f'{n(cx)},{n(B + h)} {n(L)},{n(cy + h)}" fill="{palette["left"]}"/>'
        )
        out.append(
            f'{indent}<polygon points="{n(R_)},{n(cy)} {n(cx)},{n(B)} '
            f'{n(cx)},{n(B + h)} {n(R_)},{n(cy + h)}" fill="{palette["right"]}"/>'
        )
        out.append("")
    return "\n".join(out).rstrip()


HEADER = """<!--
  {what}

  Geometry measured from the shipped mark (icon.png), not eyeballed — see
  gen-svg.py in the brand asset tooling. All CrateStack marks share one
  definition so the app icon, logomark and file icons cannot drift apart.
{extra}-->
"""


def svg(view, body, title, what, extra="", px=None):
    px = px or view
    return (
        HEADER.format(what=what, extra=extra)
        + f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view} {view}" '
        f'width="{px}" height="{px}" role="img">\n'
        f"  <title>{title}</title>\n\n{body}\n</svg>\n"
    )


def build():
    files = {}

    # 1. App icon — the mark on its tile, reproducing icon.png's own layout.
    files["cratestack-app-icon.svg"] = svg(
        256,
        '  <rect width="256" height="256" rx="56" fill="#1E222E"/>\n\n'
        + crates(cx=127.5, apex_y=33.0, scale=1.0, palette=BRAND),
        "CrateStack app icon",
        "App icon: the mark on its #1E222E tile.",
        extra="  The tile belongs to THIS asset only, never to a file icon.\n",
    )

    # 2. Logomark — same glyph, transparent, tightly cropped with a small margin.
    pad = 8.0
    vb = M_H_TOTAL + pad * 2
    files["cratestack-logomark.svg"] = svg(
        round(vb, 2),
        crates(cx=vb / 2, apex_y=pad, scale=1.0, palette=BRAND),
        "CrateStack logomark",
        "Logomark: the mark alone, transparent ground, tightly cropped.",
        px=512,
    )

    # 3/4. File icons — scaled to fill a 32-unit box, because the explorer
    #      renders these at 16x16 and margin is wasted legibility there.
    box, margin = 32.0, 1.5
    scale = (box - margin * 2) / M_H_TOTAL
    apex = margin
    for name, palette, which in (
        ("cratestack-file-icon-dark.svg", BRAND, "dark"),
        ("cratestack-file-icon-light.svg", BRAND_LIGHT, "light"),
    ):
        note = (
            "  Palette deepened one step for legibility on near-white\n"
            "  backgrounds; the hue is unchanged.\n"
            if which == "light"
            else ""
        )
        files[name] = svg(
            32,
            crates(cx=box / 2, apex_y=apex, scale=scale, palette=palette),
            "CrateStack schema file",
            f"`.cstack` file-type icon, {which}-theme variant. No background "
            f"plate:\n  a file icon sits on the host's own background.",
            extra=note,
        )
    return files


if __name__ == "__main__":
    import sys, os

    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, content in build().items():
        open(os.path.join(out, name), "w").write(content)
        print(f"wrote {name}")
