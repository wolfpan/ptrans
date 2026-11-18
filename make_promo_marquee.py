# -*- coding: utf-8 -*-
"""生成 Chrome 应用商店顶部宣传图块（marquee）：
promo_marquee_1400x560.png —— 简约扁平风格，与 promo_tile_1/2 同一设计语言：
左侧品牌区（图标 + 产品名 + 标语 + 特性标签），右侧扁平浏览器「扫译带」示意。
1400x560、24 位 RGB PNG（无 alpha）。替换旧版渐变 marquee（旧版可由 make_store_assets.py 再生）。
品牌色取自 Ptrans/icons/icon.svg：#2563eb -> #7c3aed，星芒 #fde047。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(BASE, "Ptrans", "icons", "icon128.png")
OUT = os.path.join(BASE, "store_assets")

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_LATIN = "C:/Windows/Fonts/segoeuib.ttf"
if not os.path.exists(FONT_LATIN):
    FONT_LATIN = "C:/Windows/Fonts/arialbd.ttf"

C1 = (37, 99, 235)
C2 = (124, 58, 237)
SPARK = (253, 224, 71)
BG = (246, 247, 251)
CARD = (255, 255, 255)
BORDER = (228, 231, 240)
INK = (31, 37, 51)
GRAY = (92, 101, 117)
LINE_GRAY = (216, 220, 230)
TINT_BLUE = (238, 242, 255)

W, H = 1400, 560


def font(path, size):
    return ImageFont.truetype(path, size, index=0)


def mix(c1, c2, t):
    return tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def hgrad(w, h, c1=C1, c2=C2):
    small = Image.new("RGB", (64, 4))
    px = small.load()
    for x in range(64):
        c = mix(c1, c2, x / 63)
        for y in range(4):
            px[x, y] = c
    return small.resize((w, h), Image.BILINEAR)


def vgrad(w, h, c1=C1, c2=C2):
    small = Image.new("RGB", (4, 64))
    px = small.load()
    for y in range(64):
        c = mix(c1, c2, y / 63)
        for x in range(4):
            px[x, y] = c
    return small.resize((w, h), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def paste_rounded(canvas, img, box, radius):
    canvas.paste(img, box, rounded_mask(img.size, radius))


def soft_shadow(canvas, box, radius, blur=16, opacity=26):
    x, y, w, h = box
    sh = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(sh).rounded_rectangle([x + 2, y + 8, x + w - 2, y + h + 6], radius, fill=opacity)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    dark = Image.new("RGB", canvas.size, (30, 35, 60))
    canvas.paste(Image.composite(dark, canvas, sh), (0, 0))


def paste_icon(canvas, size, box):
    icon = Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)
    canvas.paste(icon, box, icon.split()[3])


def spark(d, cx, cy, r, color=SPARK):
    d.polygon([(cx, cy - r), (cx + r * 0.26, cy - r * 0.26), (cx + r, cy),
               (cx + r * 0.26, cy + r * 0.26), (cx, cy + r),
               (cx - r * 0.26, cy + r * 0.26), (cx - r, cy),
               (cx - r * 0.26, cy - r * 0.26)], fill=color)


def text(d, xy, s, f, fill):
    bb = d.textbbox((0, 0), s, font=f)
    d.text((xy[0] - bb[0], xy[1] - bb[1]), s, font=f, fill=fill)


def text_w(d, s, f):
    bb = d.textbbox((0, 0), s, font=f)
    return bb[2] - bb[0]


def pill(d, xy, s, f, fill_bg, fill_text, pad_x=16, pad_y=9):
    x, y = xy
    tw = text_w(d, s, f)
    bb = d.textbbox((0, 0), s, font=f)
    th = bb[3] - bb[1]
    h = th + pad_y * 2
    d.rounded_rectangle([x, y, x + tw + pad_x * 2, y + h], h // 2, fill=fill_bg)
    text(d, (x + pad_x, y + pad_y), s, f, fill_text)
    return tw + pad_x * 2


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# ---------- 左侧品牌区 ----------
paste_icon(img, 100, (72, 88))
d = ImageDraw.Draw(img)
text(d, (72, 212), "AI Web Translator", font(FONT_LATIN, 52), INK)
text(d, (72, 286), "自定义大模型，整页原地翻译", font(FONT_BOLD, 30), INK)
text(d, (72, 332), "译文原位替换，排版与交互不变", font(FONT_REG, 20), GRAY)
f_chip = font(FONT_REG, 18)
cx = 72
for label in ("OpenAI 兼容 API", "三档风格", "术语解释"):
    cx += pill(d, (cx, 384), label, f_chip, TINT_BLUE, C1) + 14
text(d, (72, 452), "16 种目标语言 · 悬停翻译 · 一键还原", font(FONT_REG, 19), GRAY)

# ---------- 右侧扁平浏览器（扫译带） ----------
wx, wy, ww, wh = 728, 60, 600, 440
soft_shadow(img, (wx, wy, ww, wh), 18)
d = ImageDraw.Draw(img)
d.rounded_rectangle([wx, wy, wx + ww, wy + wh], 18, fill=CARD, outline=BORDER, width=2)
d.rounded_rectangle([wx + 2, wy + 2, wx + ww - 2, wy + 44], 16, fill=(244, 245, 249))
d.rectangle([wx + 2, wy + 28, wx + ww - 2, wy + 44], fill=(244, 245, 249))
for i, c in enumerate([(248, 113, 113), (251, 191, 36), (52, 211, 153)]):
    d.ellipse([wx + 24 + i * 19 - 5, wy + 22 - 5, wx + 24 + i * 19 + 5, wy + 22 + 5], fill=c)
d.rounded_rectangle([wx + 92, wy + 10, wx + ww - 20, wy + 34], 12, fill=CARD, outline=BORDER, width=1)
text(d, (wx + 108, wy + 14), "example.com/article", font(FONT_REG, 13), (148, 155, 170))

x0 = wx + 34
cw = ww - 68
y = wy + 76
d.rounded_rectangle([x0, y, x0 + 270, y + 15], 7, fill=(42, 49, 67))
y += 28
d.rounded_rectangle([x0, y, x0 + 150, y + 8], 4, fill=(201, 206, 218))
y += 36

xb = wx + 330
line_h = 9
grad = hgrad(cw, line_h)
paras = ([1.0, 0.94, 0.97, 0.88, 0.62],
         [1.0, 0.96, 0.90, 0.97, 0.58],
         [0.98, 0.92])
for widths in paras:
    for t in widths:
        lw = round(cw * t)
        if x0 + lw <= xb - 7:
            paste_rounded(img, grad.crop((0, 0, lw, line_h)), (x0, y), line_h // 2)
        elif x0 >= xb + 7:
            d.rounded_rectangle([x0, y, x0 + lw, y + line_h], line_h // 2, fill=LINE_GRAY)
        else:
            left_w = xb - 7 - x0
            if left_w > 0:
                paste_rounded(img, grad.crop((0, 0, left_w, line_h)), (x0, y), line_h // 2)
            rx = xb + 7
            if x0 + lw > rx:
                d.rounded_rectangle([rx, y, x0 + lw, y + line_h], line_h // 2, fill=LINE_GRAY)
        y += 19
    y += 21

band = vgrad(7, 330)
paste_rounded(img, band, (xb - 3, wy + 68), 3)
d = ImageDraw.Draw(img)
spark(d, xb, wy + 58, 10)

f_badge = font(FONT_BOLD, 18)
bw = text_w(d, "EN → 中文", f_badge) + 40
soft_shadow(img, (wx + ww - bw - 16, wy - 20, bw, 42), 21, blur=12, opacity=30)
d = ImageDraw.Draw(img)
bx, by = wx + ww - bw - 16, wy - 20
bb = d.textbbox((0, 0), "EN → 中文", font=f_badge)
th = bb[3] - bb[1]
d.rounded_rectangle([bx, by, bx + bw, by + th + 24], (th + 24) // 2, fill=CARD, outline=BORDER, width=2)
text(d, (bx + 20, by + 12), "EN → 中文", f_badge, INK)

p = os.path.join(OUT, "promo_marquee_1400x560.png")
img.convert("RGB").save(p, "PNG")
with Image.open(p) as im:
    print(os.path.basename(p), im.size, im.mode, os.path.getsize(p), "bytes")
print("content end y:", y, "window bottom:", wy + wh)