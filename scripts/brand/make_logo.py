"""
Usage:  pip install uharfbuzz fonttools brotli && python scripts/brand/make_logo.py
Outputs public/brand/*.svg, public/favicon.svg and scripts/brand/paths.json
(the path data used by src/components/brand/Logo.tsx).
Generate HOVIDA logo assets (mark + wordmark) as pure SVG paths.

The mark is rebuilt geometrically from the brand board: two interlocking
rounded pieces with a four‑point star knocked out at their junction.
The wordmark is shaped with HarfBuzz from Vazirmatn (wght 900) and the
Latin line from Inter (wght 600), converted to outlines so the SVG never
depends on installed fonts.
"""
import io, math, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

import os
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def static_font(path, wght):
    f = TTFont(path)
    inst = instancer.instantiateVariableFont(f, {"wght": wght})
    buf = io.BytesIO()
    inst.flavor = None
    inst.save(buf)
    data = buf.getvalue()
    return TTFont(io.BytesIO(data)), data

def shape(data, text, features=None, direction=None):
    face = hb.Face(data)
    font = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    if direction:
        buf.direction = direction
    hb.shape(font, buf, features or {"kern": True, "liga": True})
    return buf.glyph_infos, buf.glyph_positions

def text_path(tt, data, text, scale, x0, y0, letter_spacing=0.0, direction=None):
    """Return (svg path d, advance width, bounds) for `text`, baseline at y0."""
    infos, positions = shape(data, text, direction=direction)
    glyph_order = tt.getGlyphOrder()
    gs = tt.getGlyphSet()
    pen = SVGPathPen(gs, lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    bpen = BoundsPen(gs)
    x = 0.0
    for i, (info, pos) in enumerate(zip(infos, positions)):
        name = glyph_order[info.codepoint]
        gx = x0 + (x + pos.x_offset) * scale
        gy = y0 - pos.y_offset * scale
        t = (scale, 0, 0, -scale, gx, gy)
        gs[name].draw(TransformPen(pen, t))
        gs[name].draw(TransformPen(bpen, t))
        x += pos.x_advance + (letter_spacing if i < len(infos) - 1 else 0)
    return pen.getCommands(), x * scale, bpen.bounds


# ---------------------------------------------------------------- mark ----
def rounded_poly(points, radii):
    """Closed polygon with per-vertex corner radius (quadratic-free arcs)."""
    n = len(points)
    d = []
    for i in range(n):
        p0 = points[i - 1]
        p1 = points[i]
        p2 = points[(i + 1) % n]
        r = radii[i]
        v1 = (p0[0] - p1[0], p0[1] - p1[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1 = math.hypot(*v1)
        l2 = math.hypot(*v2)
        u1 = (v1[0] / l1, v1[1] / l1)
        u2 = (v2[0] / l2, v2[1] / l2)
        a = (p1[0] + u1[0] * r, p1[1] + u1[1] * r)
        b = (p1[0] + u2[0] * r, p1[1] + u2[1] * r)
        # cross product sign decides sweep
        cross = u1[0] * u2[1] - u1[1] * u2[0]
        sweep = 0 if cross > 0 else 1
        cmd = "M" if i == 0 else "L"
        d.append(f"{cmd}{a[0]:.2f} {a[1]:.2f}")
        if r > 0:
            d.append(f"A{r:.2f} {r:.2f} 0 0 {sweep} {b[0]:.2f} {b[1]:.2f}")
    d.append("Z")
    return " ".join(d)

def star_path(cx, cy, R, a=0.31, b=0.37):
    """Four-point sparkle fitted to the board: c1 = c + d*aR + n*bR."""
    dirs = [(0, -1), (1, 0), (0, 1), (-1, 0)]
    d = []
    for i, (dx, dy) in enumerate(dirs):
        nx, ny = dirs[(i + 1) % 4]
        tx, ty = cx + dx * R, cy + dy * R
        ux, uy = cx + nx * R, cy + ny * R
        c1 = (cx + dx * a * R + nx * b * R, cy + dy * a * R + ny * b * R)
        c2 = (cx + nx * a * R + dx * b * R, cy + ny * a * R + dy * b * R)
        if i == 0:
            d.append(f"M{tx:.2f} {ty:.2f}")
        d.append(f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {ux:.2f} {uy:.2f}")
    d.append("Z")
    return " ".join(d)

# Mark geometry measured from the brand board (1 unit = 1 source px; mark is ~98x100).
LEFT = rounded_poly(
    [(0, 0), (43.4, 0), (43.4, 43), (24.3, 43), (24.3, 100), (0, 100)],
    [25, 2.6, 0, 0, 12, 4],
)
RIGHT = rounded_poly(
    [(57.2, 0), (98.4, 0), (98.4, 100), (42.4, 100), (42.4, 46), (57.2, 46)],
    [20, 4, 32, 4, 0, 0],
)
STAR = star_path(52.6, 43, 28.2)

GRAD_DEFS = (
    '<linearGradient id="hvL" x1="0" y1="0" x2="0.9" y2="1">'
    '<stop offset="0" stop-color="#1D7A34"/><stop offset="0.6" stop-color="#28A045"/>'
    '<stop offset="1" stop-color="#3CC05B"/></linearGradient>'
    '<linearGradient id="hvR" x1="0.2" y1="1" x2="0.9" y2="0">'
    '<stop offset="0" stop-color="#3CC05B"/><stop offset="0.45" stop-color="#2DAA4B"/>'
    '<stop offset="1" stop-color="#1D7A34"/></linearGradient>'
)
SHADOW_DEF = (
    '<filter id="hvSh" x="-30%" y="-30%" width="160%" height="160%">'
    '<feDropShadow dx="-0.6" dy="1.4" stdDeviation="1.6" flood-color="#0E3B1B" flood-opacity="0.28"/></filter>'
)

def mark_inner(variant="color", piece=None, star="#FFFFFF"):
    """Return (defs, body) for the mark. variants: color | flat | mono."""
    if variant == "color":
        defs = GRAD_DEFS + SHADOW_DEF
        body = (
            f'<path d="{LEFT}" fill="url(#hvL)"/><path d="{RIGHT}" fill="url(#hvR)"/>'
            f'<path d="{STAR}" fill="{star}" filter="url(#hvSh)"/>'
        )
    elif variant == "flat":
        defs = ""
        body = (
            f'<path d="{LEFT}" fill="{piece or "#2DBA4E"}"/><path d="{RIGHT}" fill="{piece or "#2DBA4E"}"/>'
            f'<path d="{STAR}" fill="{star}"/>'
        )
    else:  # mono: star knocked out (transparent)
        defs = (
            '<mask id="hvK"><rect x="-10" y="-10" width="120" height="120" fill="#fff"/>'
            f'<path d="{STAR}" fill="#000"/></mask>'
        )
        body = (
            f'<g mask="url(#hvK)"><path d="{LEFT}" fill="{piece}"/><path d="{RIGHT}" fill="{piece}"/></g>'
        )
    return defs, body

def mark_svg(variant="color", piece=None, star="#FFFFFF", size=None):
    defs, body = mark_inner(variant, piece, star)
    wh = f' width="{size}" height="{size}"' if size else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.8 -0.5 100 101"{wh}>'
        + (f"<defs>{defs}</defs>" if defs else "")
        + body + "</svg>"
    )

def tile_svg(size=64, radius=14, bg="#E8F1EA", piece="#23A047", inset=0.2):
    s = size * (1 - 2 * inset) / 100
    off = size * inset
    defs, body = mark_inner("flat", piece=piece)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">'
        f'<rect width="{size}" height="{size}" rx="{radius}" fill="{bg}"/>'
        f'<g transform="translate({off + 0.8 * s:.3f} {off:.3f}) scale({s:.4f})">{body}</g></svg>'
    )

def main():
    vaz_tt, vaz = static_font(f"{REPO}/public/fonts/Vazirmatn-var.woff2", 900)
    int_tt, inter = static_font(f"{REPO}/public/fonts/Inter-var-latin.woff2", 560)
    upm_v = vaz_tt["head"].unitsPerEm
    upm_i = int_tt["head"].unitsPerEm

    # Persian wordmark
    fa_scale = 100 / upm_v  # 100px font size
    fa_d, fa_w, fa_b = text_path(vaz_tt, vaz, "هویدا", fa_scale, 0, 0)
    # Latin line, tracked out
    la_scale = 22 / upm_i
    la_d, la_w, la_b = text_path(int_tt, inter, "HOVIDA", la_scale, 0, 0, letter_spacing=upm_i * 0.62)
    print("fa bounds", fa_b, "w", fa_w)
    print("la bounds", la_b, "w", la_w)

    # Layout wordmark block: Persian on top, Latin centred beneath.
    fa_minx, fa_miny, fa_maxx, fa_maxy = fa_b
    la_minx, la_miny, la_maxx, la_maxy = la_b
    fa_wd = fa_maxx - fa_minx
    la_wd = la_maxx - la_minx
    gap = 24
    block_w = max(fa_wd, la_wd)
    # translate so the block starts at (0,0)
    fa_tx = -fa_minx + (block_w - fa_wd) / 2
    fa_ty = -fa_miny
    la_tx = -la_minx + (block_w - la_wd) / 2
    la_ty = (fa_maxy - fa_miny) + gap - la_miny
    block_h = la_ty + la_maxy

    def g(d, tx, ty, fill):
        return f'<path transform="translate({tx:.2f} {ty:.2f})" d="{d}" fill="{fill}"/>'

    wordmark_inner_dark = g(fa_d, fa_tx, fa_ty, "#252C28") + g(la_d, la_tx, la_ty, "#252C28")

    out = f"{REPO}/public/brand"
    import os
    os.makedirs(out, exist_ok=True)
    with open(f"{out}/hovida-wordmark.svg", "w") as fh:
        fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {block_w:.2f} {block_h:.2f}">{wordmark_inner_dark}</svg>')

    # Persian-only wordmark (for compact headers)
    fa_only_h = fa_maxy - fa_miny
    with open(f"{out}/hovida-wordmark-fa.svg", "w") as fh:
        fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fa_wd:.2f} {fa_only_h:.2f}">{g(fa_d, -fa_minx, -fa_miny, "#252C28")}</svg>')

    variants = {
        "hovida-mark.svg": mark_svg("color"),
        "hovida-mark-flat.svg": mark_svg("flat"),
        "hovida-mark-white.svg": mark_svg("mono", piece="#FFFFFF"),
        "hovida-mark-charcoal.svg": mark_svg("mono", piece="#252C28"),
    }
    for name, svg in variants.items():
        with open(f"{out}/{name}", "w") as fh:
            fh.write(svg)

    # Horizontal lockup: wordmark left, mark right (RTL reading order: mark first)
    mark_h = block_h
    lock_gap = block_h * 0.26
    total_w = block_w + lock_gap + mark_h
    defs, body = mark_inner("color")
    s = mark_h / 101
    lock = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total_w:.2f} {block_h:.2f}">'
        f"<defs>{defs}</defs>{wordmark_inner_dark}"
        f'<g transform="translate({block_w + lock_gap + 0.8 * s:.2f} {0.5 * s:.2f}) scale({s:.4f})">{body}</g></svg>'
    )
    with open(f"{out}/hovida-lockup.svg", "w") as fh:
        fh.write(lock)

    with open(f"{REPO}/public/favicon.svg", "w") as fh:
        fh.write(tile_svg(64, 15))
    with open(f"{out}/hovida-app-icon.svg", "w") as fh:
        fh.write(tile_svg(512, 116, inset=0.22))

    # Emit TSX path data for in-app React components
    with open(os.path.join(os.path.dirname(__file__), "paths.json"), "w") as fh:
        import json
        json.dump({
            "LEFT": LEFT, "RIGHT": RIGHT, "STAR": STAR,
            "FA": fa_d, "FA_T": [round(-fa_minx, 2), round(-fa_miny, 2)], "FA_BOX": [round(fa_wd, 2), round(fa_only_h, 2)],
            "LA": la_d, "LA_T": [round(la_tx, 2), round(la_ty, 2)],
            "FA_T_BLOCK": [round(fa_tx, 2), round(fa_ty, 2)],
            "BLOCK": [round(block_w, 2), round(block_h, 2)],
        }, fh)
    print("ok", block_w, block_h)

main()
