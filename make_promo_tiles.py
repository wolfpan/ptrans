# -*- coding: utf-8 -*-
"""生成 Chrome 应用商店宣传图块（简约扁平风格，非写实）：
1) promo_tile_1_1280x800.png  主视觉：品牌 + 扁平浏览器「扫译」示意
2) promo_tile_2_1280x800.png  功能一览：六宫格扁平卡片
均为 1280x800、24 位 RGB PNG（无 alpha）。
品牌色取自 Ptrans/icons/icon.svg：#2563eb -> #7c3aed，星芒 #fde047。
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(BASE, "Ptrans", "icons", "icon128.png")
OUT = os.path.join(BASE, "store_assets")
os.makedirs(OUT, exist_ok=True)

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_LATIN = "C:/Windows/Fonts/segoeuib.ttf"
if not os.path.exists(FONT_LATIN):
    FONT_LATIN = "C:/Windows/Fonts/arialbd.ttf"

C1 = (37, 99, 235)      # #2563eb
C2 = (124, 58, 237)     # #7c3aed
SPARK = (253, 224, 71)  # #fde047
BG = (246, 247, 251)    # 浅底
CARD = (255, 255, 255)
BORDER = (228, 231, 240)
INK = (31, 37, 51)
GRAY = (92, 101, 117)
LINE_GRAY = (216, 220, 230)
TINT_BLUE = (238, 242, 255)
TINT_VIOLET = (243, 238, 255)
GREEN = (22, 163, 74)

W, H = 1280, 800


def font(path, size):
    return ImageFont.truetype(path, size, index=0)


def mix(c1, c2, t):
    return tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def hgrad(w, h, c1=C1, c2=C2):
    """水平渐变条：小网格计算后放大，平滑且快。"""
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
    x, y = box
    canvas.paste(img, (x, y), rounded_mask(img.size, radius))


def soft_shadow(canvas, box, radius, blur=18, opacity=26):
    """极浅的投影，保持扁平感。box=(x,y,w,h)"""
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


def pill(d, xy, s, f, fill_bg, fill_text, pad_x=18, pad_y=10, outline=None):
    x, y = xy
    tw = text_w(d, s, f)
    bb = d.textbbox((0, 0), s, font=f)
    th = bb[3] - bb[1]
    h = th + pad_y * 2
    d.rounded_rectangle([x, y, x + tw + pad_x * 2, y + h], h // 2,
                        fill=fill_bg, outline=outline, width=2 if outline else 0)
    text(d, (x + pad_x, y + pad_y), s, f, fill_text)
    return tw + pad_x * 2, h


def arrowhead(d, p, direction, size, color):
    """在 p 处沿 direction（单位向量）画实心三角箭头。"""
    dx, dy = direction
    nx, ny = -dy, dx
    tip = (p[0] + dx * size, p[1] + dy * size)
    b1 = (p[0] - dx * size * 0.4 + nx * size * 0.62, p[1] - dy * size * 0.4 + ny * size * 0.62)
    b2 = (p[0] - dx * size * 0.4 - nx * size * 0.62, p[1] - dy * size * 0.4 - ny * size * 0.62)
    d.polygon([tip, b1, b2], fill=color)


# ================= 图块 1：主视觉 =================
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 左侧品牌区
paste_icon(img, 120, (80, 128))
d = ImageDraw.Draw(img)
f_title = font(FONT_LATIN, 55)
text(d, (80, 292), "AI Web Translator", f_title, INK)
f_tag = font(FONT_BOLD, 32)
text(d, (80, 376), "自定义大模型，整页原地翻译", f_tag, INK)
f_sub = font(FONT_REG, 22)
text(d, (80, 430), "译文原位替换，排版与交互不变", f_sub, GRAY)

f_chip = font(FONT_REG, 19)
cx = 80
for label in ("OpenAI 兼容 API", "风格可调", "术语解释"):
    pw, _ = pill(d, (cx, 496), label, f_chip, TINT_BLUE, C1, pad_x=16, pad_y=9)
    cx += pw + 14

f_note = font(FONT_REG, 20)
text(d, (80, 682), "16 种目标语言 · 悬停翻译 · 一键还原", f_note, GRAY)

# 右侧扁平浏览器窗口
wx, wy, ww, wh = 620, 118, 580, 568
soft_shadow(img, (wx, wy, ww, wh), 20)
d = ImageDraw.Draw(img)
d.rounded_rectangle([wx, wy, wx + ww, wy + wh], 20, fill=CARD, outline=BORDER, width=2)
# 顶栏
d.rounded_rectangle([wx + 2, wy + 2, wx + ww - 2, wy + 54], 18, fill=(244, 245, 249))
d.rectangle([wx + 2, wy + 36, wx + ww - 2, wy + 54], fill=(244, 245, 249))
for i, c in enumerate([(248, 113, 113), (251, 191, 36), (52, 211, 153)]):
    d.ellipse([wx + 26 + i * 22 - 6, wy + 27 - 6, wx + 26 + i * 22 + 6, wy + 27 + 6], fill=c)
d.rounded_rectangle([wx + 100, wy + 13, wx + ww - 24, wy + 41], 14, fill=CARD, outline=BORDER, width=1)
f_url = font(FONT_REG, 15)
text(d, (wx + 118, wy + 18), "example.com/article", f_url, (148, 155, 170))

# 内容：标题 + 段落线条，扫译带左侧为译文（品牌渐变），右侧为原文（灰）
x0 = wx + 38
cw = ww - 76
y = wy + 92
d.rounded_rectangle([x0, y, x0 + 320, y + 18], 9, fill=(42, 49, 67))
y += 36
d.rounded_rectangle([x0, y, x0 + 180, y + 10], 5, fill=(201, 206, 218))
y += 44

xb = wx + 336  # 扫译带位置
line_h = 11
grad = hgrad(cw, line_h)
paras = ([1.0, 0.94, 0.97, 0.88, 0.62],
         [1.0, 0.96, 0.90, 0.97, 0.58],
         [0.98, 0.92, 0.85])
for pi, widths in enumerate(paras):
    for t in widths:
        lw = round(cw * t)
        if x0 + lw <= xb - 8:
            paste_rounded(img, grad.crop((0, 0, lw, line_h)), (x0, y), line_h // 2)
        elif x0 >= xb + 8:
            d.rounded_rectangle([x0, y, x0 + lw, y + line_h], line_h // 2, fill=LINE_GRAY)
        else:
            left_w = xb - 8 - x0
            if left_w > 0:
                paste_rounded(img, grad.crop((0, 0, left_w, line_h)), (x0, y), line_h // 2)
            rx = xb + 8
            if x0 + lw > rx:
                d.rounded_rectangle([rx, y, x0 + lw, y + line_h], line_h // 2, fill=LINE_GRAY)
        y += 23
    y += 25

# 扫译带（竖向渐变）+ 星芒
band = vgrad(8, 470)
paste_rounded(img, band, (xb - 4, wy + 84), 4)
d = ImageDraw.Draw(img)
spark(d, xb, wy + 74, 12)

# 浮动语言徽标
f_badge = font(FONT_BOLD, 20)
bw = text_w(d, "EN → 中文", f_badge) + 44
soft_shadow(img, (wx + ww - bw - 18, wy - 24, bw, 48), 24, blur=12, opacity=30)
d = ImageDraw.Draw(img)
pill(d, (wx + ww - bw - 18, wy - 24), "EN → 中文", f_badge, CARD, INK,
     pad_x=22, pad_y=12, outline=BORDER)

img.convert("RGB").save(os.path.join(OUT, "promo_tile_1_1280x800.png"), "PNG")

# ================= 图块 2：功能一览 =================
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

paste_icon(img, 64, (80, 74))
d = ImageDraw.Draw(img)
f_h1 = font(FONT_BOLD, 42)
text(d, (168, 76), "为深度阅读而生", f_h1, INK)
f_h2 = font(FONT_REG, 22)
text(d, (168, 134), "六项核心能力，翻译质量与风格尽在掌握", f_h2, GRAY)

# 六宫格卡片
cards = [
    ("自定义大模型", ["兼容 OpenAI 接口", "模型列表自动获取"], "chip", TINT_BLUE, C1),
    ("三档翻译风格", ["严谨 · 均衡 · 优雅", "三档风格按需切换"], "slider", TINT_VIOLET, C2),
    ("术语括号解释", ["专业术语首次出现时", "附原文与一句话释义"], "term", TINT_BLUE, C1),
    ("悬停段落翻译", ["悬停段落按住 Ctrl", "只翻译当前段落"], "cursor", TINT_VIOLET, C2),
    ("自动翻译外语页", ["加载时识别页面语言", "外语页面自动翻译"], "globe", TINT_BLUE, C1),
    ("一键还原原文", ["原文保留内存备份", "随时一键恢复"], "undo", TINT_VIOLET, C2),
]

mx, gap = 80, 24
cw_card = (W - mx * 2 - gap * 2) // 3   # 357
ch_card = 243
gy0 = 210


def glyph_chip(d, cx, cy, color):
    d.rounded_rectangle([cx - 11, cy - 11, cx + 11, cy + 11], 4, outline=color, width=3)
    d.rectangle([cx - 4, cy - 4, cx + 4, cy + 4], fill=color)
    for o in (-6, 6):
        d.line([cx + o, cy - 17, cx + o, cy - 11], fill=color, width=3)
        d.line([cx + o, cy + 11, cx + o, cy + 17], fill=color, width=3)
        d.line([cx - 17, cy + o, cx - 11, cy + o], fill=color, width=3)
        d.line([cx + 11, cy + o, cx + 17, cy + o], fill=color, width=3)


def glyph_slider(d, cx, cy, color):
    light = mix(color, (255, 255, 255), 0.55)
    for dy, kx in ((-9, -4), (0, 6), (9, -1)):
        d.line([cx - 13, cy + dy, cx + 13, cy + dy], fill=light, width=3)
        d.ellipse([cx + kx - 4, cy + dy - 4, cx + kx + 4, cy + dy + 4], fill=color)


def glyph_term(d, cx, cy, color):
    f = font(FONT_BOLD, 24)
    s = "(文)"
    bb = d.textbbox((0, 0), s, font=f)
    d.text((cx - (bb[2] - bb[0]) / 2 - bb[0], cy - (bb[3] - bb[1]) / 2 - bb[1]), s, font=f, fill=color)


def glyph_cursor(d, cx, cy, color):
    pts = [(0, 0), (0, 17), (4.4, 13.2), (7.2, 19), (10, 17.6), (7.2, 12), (12.6, 11.6)]
    d.polygon([(cx - 6 + px * 1.15, cy - 10 + py * 1.15) for px, py in pts], fill=color)


def glyph_globe(d, cx, cy, color):
    d.ellipse([cx - 13, cy - 13, cx + 13, cy + 13], outline=color, width=3)
    d.ellipse([cx - 6, cy - 13, cx + 6, cy + 13], outline=color, width=2)
    d.line([cx - 13, cy, cx + 13, cy], fill=color, width=2)


def glyph_undo(d, cx, cy, color):
    r = 12
    d.arc([cx - r, cy - r, cx + r, cy + r], start=120, end=420, fill=color, width=3)
    a = math.radians(60)
    p = (cx + r * math.cos(a), cy + r * math.sin(a))
    tangent = (-math.sin(a), math.cos(a))  # 顺时针行进方向
    arrowhead(d, p, tangent, 7, color)


GLYPHS = {"chip": glyph_chip, "slider": glyph_slider, "term": glyph_term,
          "cursor": glyph_cursor, "globe": glyph_globe, "undo": glyph_undo}

f_ct = font(FONT_BOLD, 26)
f_cd = font(FONT_REG, 19)
for i, (title, desc, g, tint, color) in enumerate(cards):
    row, col = divmod(i, 3)
    x = mx + col * (cw_card + gap)
    y = gy0 + row * (ch_card + gap)
    soft_shadow(img, (x, y, cw_card, ch_card), 18, blur=14, opacity=18)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x, y, x + cw_card, y + ch_card], 18, fill=CARD, outline=BORDER, width=2)
    d.rounded_rectangle([x + 28, y + 28, x + 84, y + 84], 14, fill=tint)
    GLYPHS[g](d, x + 56, y + 56, color)
    text(d, (x + 28, y + 106), title, f_ct, INK)
    for j, line in enumerate(desc):
        text(d, (x + 28, y + 152 + j * 30), line, f_cd, GRAY)

f_foot = font(FONT_REG, 18)
s = "AI Web Translator · Chrome 扩展"
text(d, ((W - text_w(d, s, f_foot)) / 2, 756), s, f_foot, (148, 155, 170))

img.convert("RGB").save(os.path.join(OUT, "promo_tile_2_1280x800.png"), "PNG")

for name in ("promo_tile_1_1280x800.png", "promo_tile_2_1280x800.png"):
    p = os.path.join(OUT, name)
    with Image.open(p) as im:
        print(name, im.size, im.mode, os.path.getsize(p), "bytes")