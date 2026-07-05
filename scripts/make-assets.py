# Build-time helper (the ONLY Python in the repo) — regenerates the brand
# raster assets from the torii logo. Requires Pillow: pip install Pillow.
# For brand-accurate text in og-image.png, place Archivo[*].ttf and
# JetBrainsMono[*].ttf at /tmp/ (or assets/fonts-ttf/); otherwise it falls
# back to DejaVu. The generated PNGs are committed, so contributors only
# need this when the logo changes.

#!/usr/bin/env python3
# Generates the raster brand assets from the torii+waves logo:
#   assets/icons/192x192.png, assets/icons/512x512.png  (PWA, maskable)
#   og-image.png                                         (1200x630 social card)
import math
from PIL import Image, ImageDraw, ImageFont

AMBER  = (181, 48, 42, 255)
AMBER2 = (214, 83, 74, 255)
AMBER2_DIM = (214, 83, 74, 150)
BG = (11, 11, 12)

def quad(p0, p1, p2, n=44):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt*mt*p0[0] + 2*mt*t*p1[0] + t*t*p2[0]
        y = mt*mt*p0[1] + 2*mt*t*p1[1] + t*t*p2[1]
        pts.append((x, y))
    return pts

def render_logo(px):
    """Torii gate over two minimalist waves, sized to a px-by-px transparent box."""
    SS = 4
    W = px * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = W / 48.0
    P = lambda x, y: (x * s, y * s)

    # kasagi (top beam, gentle upsweep)
    top = quad((6, 13), (24, 9), (42, 13))
    bot = quad((42, 16), (24, 12.5), (6, 16))
    d.polygon([P(*p) for p in top + bot], fill=AMBER)
    # nuki (second beam)
    d.rounded_rectangle([P(10, 19.5), P(38, 22.7)], radius=1*s, fill=AMBER)
    # posts (lean slightly inward)
    d.polygon([P(14, 16), P(16, 30), P(13, 30), P(11.5, 16)], fill=AMBER)
    d.polygon([P(34, 16), P(32, 30), P(35, 30), P(36.5, 16)], fill=AMBER)
    # waves
    def wave(base, color, amp=3.0, period=18.0):
        pts = []
        x = 7.0
        while x <= 43.0:
            y = base - amp * math.sin(2 * math.pi * (x - 7) / period)
            pts.append(P(x, y))
            x += 0.4
        d.line(pts, fill=color, width=max(1, int(round(2 * s))), joint="curve")
    wave(36, AMBER2)
    wave(41, AMBER2_DIM)

    return img.resize((px, px), Image.LANCZOS)

def make_icon(size, path):
    im = Image.new("RGBA", (size, size), BG + (255,))
    lp = int(size * 0.60)                      # logo within the maskable safe zone
    logo = render_logo(lp)
    off = (size - lp) // 2
    im.alpha_composite(logo, (off, off))
    im.convert("RGB").save(path)
    print("wrote", path, size)

import os
def _resolve(primary, fallback):
    for p in (primary, os.path.join(os.path.dirname(__file__), "..", "assets", "fonts-ttf", os.path.basename(primary))):
        if p and os.path.exists(p):
            return p
    return fallback

ARCHIVO_TTF = _resolve("/tmp/archivo.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
JBMONO_TTF  = _resolve("/tmp/jbmono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")

def load_font(path, size, weight=400, width=100):
    f = ImageFont.truetype(path, size)
    try:
        axes = f.get_variation_axes()
        vals = []
        for ax in axes:
            nm = ax.get("name", b"")
            nm = nm.decode() if isinstance(nm, (bytes, bytearray)) else str(nm)
            n = nm.lower()
            if "weight" in n or n == "wght":
                vals.append(weight)
            elif "width" in n or n == "wdth":
                vals.append(width)
            else:
                vals.append(ax.get("default", 0))
        if vals:
            f.set_variation_by_axes(vals)
    except Exception as e:
        print("  (variation note:", e, ")")
    return f

def make_og(path):
    W, H = 1200, 630
    im = Image.new("RGBA", (W, H), BG + (255,))

    # faint torii watermark, bleeding off the right edge
    wm = render_logo(620)
    wm = wm.copy()
    a = wm.getchannel("A").point(lambda v: int(v * 0.10))
    wm.putalpha(a)
    im.alpha_composite(wm, (W - 470, (H - 620) // 2))

    d = ImageDraw.Draw(im)
    # small crisp logo, top of the text block
    logo = render_logo(96)
    im.alpha_composite(logo, (88, 150))

    f_word = load_font(ARCHIVO_TTF, 108, weight=800)
    f_tag  = load_font(ARCHIVO_TTF, 40, weight=600)
    f_mono = load_font(JBMONO_TTF, 27, weight=500)

    d.text((90, 262), "THE DOJO BAY", font=f_word, fill=(244, 244, 243))
    d.text((94, 392), "Public Dojo Directory", font=f_tag, fill=(160, 160, 168))
    d.text((94, 452), "Samourai  ·  Ashigaru  ·  reachable over Tor", font=f_mono, fill=(214, 83, 74))
    # amber baseline accent
    d.rectangle([90, 516, 360, 520], fill=(214, 83, 74))

    im.convert("RGB").save(path)
    print("wrote", path, (W, H))

import os
os.makedirs("assets/icons", exist_ok=True)
make_icon(192, "assets/icons/192x192.png")
make_icon(512, "assets/icons/512x512.png")
make_og("og-image.png")
