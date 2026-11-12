# -*- coding: utf-8 -*-
"""生成 Chrome Web Store 商店素材：
1) 小型宣传图块 440x280（24 位 PNG，无 alpha）
2) 顶部宣传图块 1400x560（24 位 PNG，无 alpha）
3) 屏幕截图缩放至 1280x800
品牌色取自 Ptrans/icons/icon.svg：#2563eb -> #7c3aed 对角渐变，星芒 #fde047。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(BASE, "Ptrans", "icons", "icon128.png")
SHOT = os.path.join(BASE, "tmp", "整个网页.jpg")
OUT = os.path.join(BASE, "store_assets")
os.makedirs(OUT, exist_ok=True)

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"

C1 = (37, 99, 235)    # #2563eb
C2 = (124, 58, 237)   # #7c3aed
SPARK = (253, 224, 71)  # #fde047


def font(path, size):
    return ImageFont.truetype(path, size, index=0)


def diagonal_gradient(w, h, c1, c2):
    """对角线性渐变：先在小网格上算 t=(x/w+y/h)/2 再双线性放大，平滑且快。"""
    gw, gh = 160, 160
    small = Image.new("RGB", (gw, gh))
    px = small.load()
    for y in range(gh):
        for x in range(gw):
            t = (x / (gw - 1) + y / (gh - 1)) / 2
            px[x, y] = tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return small.resize((w, h), Image.BILINEAR)


def add_decor(img, sparks=None):
    """背景装饰：柔光圆斑 + 星芒点缀，全部不透明绘制。
    sparks: [(fx, fy, scale, color), ...] 相对坐标星芒位置，避免与内容撞位。"""
    w, h = img.size
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([w * 0.62, -h * 0.55, w * 1.25, h * 0.45], fill=(255, 255, 255))
    gd.ellipse([-w * 0.25, h * 0.55, w * 0.35, h * 1.45], fill=(255, 255, 255))
    glow = glow.point(lambda v: v // 14)  # 弱化到约 7% 亮度
    # 用 screen 方式叠加柔光
    from PIL import ImageChops
    img = ImageChops.screen(img, glow)
    d = ImageDraw.Draw(img)

    def spark(cx, cy, r, color=SPARK):
        d.polygon([(cx, cy - r), (cx + r * 0.28, cy - r * 0.28), (cx + r, cy),
                   (cx + r * 0.28, cy + r * 0.28), (cx, cy + r),
                   (cx - r * 0.28, cy + r * 0.28), (cx - r, cy),
                   (cx - r * 0.28, cy - r * 0.28)], fill=color)

    if sparks is None:
        sparks = [(0.90, 0.16, 1.0, SPARK), (0.07, 0.82, 0.7, (255, 255, 255)),
                  (0.55, 0.10, 0.5, (255, 255, 255))]
    for fx, fy, sc, color in sparks:
        spark(w * fx, h * fy, max(4, round(h * 0.035 * sc)), color=color)
    return img


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def paste_icon(canvas, path, box, size):
    """图标自带透明圆角，用自身 alpha 作掩膜粘贴，避免黑角。"""
    icon = Image.open(path).convert("RGBA").resize((size, size), Image.LANCZOS)
    canvas.paste(icon, box, icon.split()[3])


def paste_rounded(canvas, img, box, radius):
    x, y = box
    w, h = img.size
    shadow = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle([x - 4, y + 10, x + w + 4, y + h + 18],
                                             radius + 6, fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    dark = Image.new("RGB", canvas.size, (10, 10, 40))
    canvas.paste(Image.composite(dark, canvas, shadow), (0, 0))
    mask = rounded_mask((w, h), radius)
    canvas.paste(img, (x, y), mask)
    # 描边
    bd = ImageDraw.Draw(canvas)
    bd.rounded_rectangle([x, y, x + w - 1, y + h - 1], radius, outline=(255, 255, 255), width=3)


def cover_crop(img, tw, th):
    """等比缩放至覆盖目标尺寸后居中裁切，避免拉伸变形。"""
    w, h = img.size
    s = max(tw / w, th / h)
    nw, nh = round(w * s), round(h * s)
    img = img.resize((nw, nh), Image.LANCZOS)
    lx, ly = (nw - tw) // 2, (nh - th) // 2
    return img.crop((lx, ly, lx + tw, ly + th))


def chip(draw, xy, text, f, pad_x=16, pad_y=9):
    x, y = xy
    bb = draw.textbbox((0, 0), text, font=f)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    draw.rounded_rectangle([x, y, x + w + pad_x * 2, y + h + pad_y * 2], (h + pad_y * 2) // 2,
                           outline=(255, 255, 255), width=2)
    draw.text((x + pad_x - bb[0], y + pad_y - bb[1]), text, font=f, fill=(255, 255, 255))
    return w + pad_x * 2


# ---------- 屏幕截图 1280x800 ----------
shot = Image.open(SHOT).convert("RGB")
shot_1280 = cover_crop(shot, 1280, 800)
shot_1280.save(os.path.join(OUT, "screenshot_1280x800.png"), "PNG")

# ---------- 小型宣传图块 440x280 ----------
W, H = 440, 280
img = add_decor(diagonal_gradient(W, H, C1, C2))
d = ImageDraw.Draw(img)
paste_icon(img, ICON, ((W - 88) // 2, 34), 88)
f_title = font(FONT_BOLD, 37)
f_sub = font(FONT_REG, 21)
t1 = "AI Web Translator"
bb = d.textbbox((0, 0), t1, font=f_title)
d.text(((W - (bb[2] - bb[0])) / 2 - bb[0], 140), t1, font=f_title, fill=(255, 255, 255))
t2 = "自定义大模型 · 原地翻译网页"
bb = d.textbbox((0, 0), t2, font=f_sub)
d.text(((W - (bb[2] - bb[0])) / 2 - bb[0], 196), t2, font=f_sub, fill=(224, 231, 255))
f_tag = font(FONT_REG, 16)
t3 = "OpenAI 兼容 API · 风格可调 · 术语解释"
bb = d.textbbox((0, 0), t3, font=f_tag)
d.text(((W - (bb[2] - bb[0])) / 2 - bb[0], 234), t3, font=f_tag, fill=(196, 205, 255))
img.convert("RGB").save(os.path.join(OUT, "promo_small_440x280.png"), "PNG")

# ---------- 顶部宣传图块 1400x560 ----------
W, H = 1400, 560
img = add_decor(diagonal_gradient(W, H, C1, C2),
                sparks=[(0.68, 0.92, 1.0, SPARK), (0.07, 0.82, 0.7, (255, 255, 255)),
                        (0.55, 0.10, 0.5, (255, 255, 255))])
d = ImageDraw.Draw(img)
paste_icon(img, ICON, (80, 84), 112)
f_title = font(FONT_BOLD, 62)
d.text((80, 226), "AI Web Translator", font=f_title, fill=(255, 255, 255))
f_sub = font(FONT_REG, 30)
d.text((82, 312), "自定义大模型，原地翻译整个网页", font=f_sub, fill=(224, 231, 255))
f_chip = font(FONT_REG, 21)
cx = 82
for label in ("OpenAI 兼容 API", "翻译风格可调", "术语括号解释"):
    cx += chip(d, (cx, 380), label, f_chip) + 14
# 右侧截图展示
panel = cover_crop(shot, 620, 388)
paste_rounded(img, panel, (716, 86), 14)
img.convert("RGB").save(os.path.join(OUT, "promo_marquee_1400x560.png"), "PNG")

for name in ("promo_small_440x280.png", "promo_marquee_1400x560.png", "screenshot_1280x800.png"):
    p = os.path.join(OUT, name)
    with Image.open(p) as im:
        print(name, im.size, im.mode, os.path.getsize(p), "bytes")
