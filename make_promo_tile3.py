# -*- coding: utf-8 -*-
"""生成 Chrome 应用商店宣传图块 3（写实界面展示，Mac 风格浏览器边框）：
promo_tile_3_1280x800.png —— Mac 窗框内：WIRED 整页中文翻译截图做柔化浅色背景
（裁去源图 Chrome 深色工具栏 y<202、左侧深色窗边 x<8、右侧 Windows 滚动条 x>2960），
右上角原位叠加清晰的真实设置面板截图；右侧绘 macOS 悬浮式滚动条。
1280x800、24 位 RGB PNG（无 alpha）。
素材：素材/ScreenShot_2026-11-18_215048_660.png（OCR 确认 www.wired.com 中文译文页）
      素材/ScreenShot_2026-11-18_215753_095.png（扩展设置面板，722x1082）
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(BASE, "Ptrans", "icons", "icon128.png")
SHOT = os.path.join(BASE, "素材", "ScreenShot_2026-11-18_215048_660.png")
POPUP = os.path.join(BASE, "素材", "ScreenShot_2026-11-18_215753_095.png")
OUT = os.path.join(BASE, "store_assets")

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"

BG = (246, 247, 251)
CARD = (255, 255, 255)
BORDER = (228, 231, 240)
INK = (31, 37, 51)
GRAY = (92, 101, 117)
TOOLBAR = (246, 246, 248)
URL_BORDER = (226, 228, 234)
URL_TEXT = (120, 127, 140)
DOTS = ((255, 95, 87), (254, 188, 46), (40, 200, 64))
SCROLL_THUMB = (205, 207, 214)

W, H = 1280, 800
PAGE_TOP = 202   # 源图 Chrome 工具栏结束行
PAGE_LEFT = 8    # 源图左侧深色窗边
PAGE_RIGHT = 2960  # 源图 Windows 滚动条左缘


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

# Mac 风格窗框
fw, bar_h = 1160, 48
inner_w = fw - 4
content_h = 600
fh = bar_h + content_h
fx, fy = (W - fw) // 2, 112

# 页面背景：裁净 -> 抹去原面板残影 -> 覆盖缩放（顶对齐保留刊头）-> 柔化 -> 提亮
page = Image.open(SHOT).convert("RGB")
page = page.crop((PAGE_LEFT, PAGE_TOP, PAGE_RIGHT, page.height))
ImageDraw.Draw(page).rectangle([1460 - PAGE_LEFT, 205 - PAGE_TOP,
                                2210 - PAGE_LEFT, 1310 - PAGE_TOP], fill=CARD)
s = max(inner_w / page.width, content_h / page.height)
page = page.resize((round(page.width * s), round(page.height * s)), Image.LANCZOS)
page = page.crop((0, 0, inner_w, content_h))
page = page.filter(ImageFilter.GaussianBlur(10))
page = Image.blend(page, Image.new("RGB", page.size, CARD), 0.5)

soft_shadow(img, (fx, fy, fw, fh), 14)
d = ImageDraw.Draw(img)
d.rounded_rectangle([fx, fy, fx + fw, fy + fh], 14, fill=CARD, outline=BORDER, width=2)
img.paste(page, (fx + 2, fy + bar_h), rounded_mask((inner_w, content_h), 12))
d = ImageDraw.Draw(img)
# 工具栏（上圆角、下直角）
d.rounded_rectangle([fx + 2, fy + 2, fx + fw - 2, fy + bar_h], 12, fill=TOOLBAR)
d.rectangle([fx + 2, fy + 30, fx + fw - 2, fy + bar_h], fill=TOOLBAR)
d.line([fx + 2, fy + bar_h, fx + fw - 2, fy + bar_h], fill=BORDER, width=1)
for i, c in enumerate(DOTS):
    cx, cy, r = fx + 26 + i * 22, fy + bar_h // 2, 6
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
pw, ph = 380, 28
px0, py0 = fx + (fw - pw) // 2, fy + (bar_h - ph) // 2
d.rounded_rectangle([px0, py0, px0 + pw, py0 + ph], 8, fill=CARD, outline=URL_BORDER, width=1)
lx, ly = px0 + 16, py0 + ph // 2
d.rounded_rectangle([lx - 5, ly - 1, lx + 5, ly + 7], 2, fill=URL_TEXT)
d.arc([lx - 4, ly - 7, lx + 4, ly + 1], start=180, end=360, fill=URL_TEXT, width=2)
f_url = font(FONT_REG, 15)
url = "www.wired.com"
text(d, (px0 + (pw - text_w(d, url, f_url)) / 2 + 8, py0 + 6), url, f_url, URL_TEXT)

# macOS 悬浮式滚动条（细圆角浅灰滑块）
th_w, th_h = 7, 190
th_x = fx + fw - 2 - th_w - 4
th_y = fy + bar_h + 26
d.rounded_rectangle([th_x, th_y, th_x + th_w, th_y + th_h], th_w // 2, fill=SCROLL_THUMB)

# 右上角清晰面板（真实截图，原位放大）
pop = Image.open(POPUP).convert("RGB")
pop_w = 361
pop_h = round(pop.height * pop_w / pop.width)
pop = pop.resize((pop_w, pop_h), Image.LANCZOS)
pop_x, pop_y = fx + fw - pop_w - 28, fy + bar_h + 16
soft_shadow(img, (pop_x, pop_y, pop_w, pop_h), 10, blur=18, opacity=45)
d = ImageDraw.Draw(img)
img.paste(pop, (pop_x, pop_y), rounded_mask((pop_w, pop_h), 10))
d.rounded_rectangle([pop_x, pop_y, pop_x + pop_w, pop_y + pop_h], 10, outline=BORDER, width=1)

p = os.path.join(OUT, "promo_tile_3_1280x800.png")
img.convert("RGB").save(p, "PNG")
with Image.open(p) as im:
    print(os.path.basename(p), im.size, im.mode, os.path.getsize(p), "bytes")
print("frame:", (fx, fy, fw, fh), "popup:", (pop_x, pop_y, pop_w, pop_h))