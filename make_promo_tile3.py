# -*- coding: utf-8 -*-
"""生成 Chrome 应用商店宣传图块 3（写实界面展示）：
promo_tile_3_1280x800.png —— 真实 WIRED 整页翻译截图（含设置面板）+ ①②③ 标注与图例。
1280x800、24 位 RGB PNG（无 alpha）。素材：素材/ScreenShot_2026-11-18_215048_660.png
（经 OCR 确认为 www.wired.com 中文译文页，面板位于源图 x≈1472–2194, y≈215–1300）。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(BASE, "Ptrans", "icons", "icon128.png")
SHOT = os.path.join(BASE, "素材", "ScreenShot_2026-11-18_215048_660.png")
OUT = os.path.join(BASE, "store_assets")

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"

C1 = (37, 99, 235)
BG = (246, 247, 251)
CARD = (255, 255, 255)
BORDER = (228, 231, 240)
INK = (31, 37, 51)
GRAY = (92, 101, 117)

W, H = 1280, 800


def font(path, size):
    return ImageFont.truetype(path, size, index=0)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def soft_shadow(canvas, box, radius, blur=16, opacity=30):
    x, y, w, h = box
    sh = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(sh).rounded_rectangle([x + 2, y + 8, x + w - 2, y + h + 6], radius, fill=opacity)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    dark = Image.new("RGB", canvas.size, (30, 35, 60))
    canvas.paste(Image.composite(dark, canvas, sh), (0, 0))


def text(d, xy, s, f, fill):
    bb = d.textbbox((0, 0), s, font=f)
    d.text((xy[0] - bb[0], xy[1] - bb[1]), s, font=f, fill=fill)


def text_w(d, s, f):
    bb = d.textbbox((0, 0), s, font=f)
    return bb[2] - bb[0]


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 顶部品牌行
icon = Image.open(ICON).convert("RGBA").resize((48, 48), Image.LANCZOS)
img.paste(icon, (64, 44), icon.split()[3])
d = ImageDraw.Draw(img)
text(d, (128, 48), "真实界面，所见即所得", font(FONT_BOLD, 36), INK)
f_sub = font(FONT_REG, 20)
sub = "WIRED 整页翻译效果 · 设置面板"
text(d, (W - 64 - text_w(d, sub, f_sub), 60), sub, f_sub, GRAY)

# 中央真实截图（等比缩放，圆角卡片）
shot = Image.open(SHOT).convert("RGB")
orig_w = shot.width
sw = 900
sh = round(shot.height * sw / orig_w)
shot = shot.resize((sw, sh), Image.LANCZOS)
sx, sy = (W - sw) // 2, 112
soft_shadow(img, (sx, sy, sw, sh), 14)
d = ImageDraw.Draw(img)
img.paste(shot, (sx, sy), rounded_mask((sw, sh), 14))
d.rounded_rectangle([sx, sy, sx + sw, sy + sh], 14, outline=BORDER, width=2)

# 标注点：源图坐标 -> 缩放后坐标
scale = sw / orig_w
marks = [
    ("1", (700, 1000)),    # 译文正文
    ("2", (1830, 350)),    # 面板：语言/风格/模型
    ("3", (1830, 1235)),   # 面板：还原原文
]
f_num = font(FONT_BOLD, 19)
for num, (ox, oy) in marks:
    cx, cy = sx + ox * scale, sy + oy * scale
    r = 15
    d.ellipse([cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2], fill=CARD)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=C1)
    bb = d.textbbox((0, 0), num, font=f_num)
    d.text((cx - (bb[2] - bb[0]) / 2 - bb[0], cy - (bb[3] - bb[1]) / 2 - bb[1]),
           num, font=f_num, fill=CARD)

# 底部图例
f_leg = font(FONT_REG, 19)
legs = ("① 译文原地替换，排版不变", "② 语言 · 风格 · 模型可选", "③ 一键还原原文")
pads = 18
widths = [text_w(d, s, f_leg) + pads * 2 for s in legs]
total = sum(widths) + 16 * (len(legs) - 1)
lx = (W - total) // 2
ly = sy + sh + 22
for s, w in zip(legs, widths):
    d.rounded_rectangle([lx, ly, lx + w, ly + 40], 20, fill=CARD, outline=BORDER, width=2)
    text(d, (lx + pads, ly + 9), s, f_leg, INK)
    lx += w + 16

p = os.path.join(OUT, "promo_tile_3_1280x800.png")
img.convert("RGB").save(p, "PNG")
with Image.open(p) as im:
    print(os.path.basename(p), im.size, im.mode, os.path.getsize(p), "bytes")
print("screenshot box:", (sx, sy, sw, sh), "legend bottom:", ly + 40)