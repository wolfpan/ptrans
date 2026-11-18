# -*- coding: utf-8 -*-
"""生成 Chrome Web Store 屏幕截图素材（1280x800 与 640x400，24 位 RGB PNG / JPEG，无 alpha）：
对 素材/ 中的真实截图做艺术加工——
1) 裁掉浏览器深红主题顶栏，按 2:1 取景保留「页面报头 + 扩展弹窗 + 翻译完成提示」；
2) 置入圆角浏览器样机（白色描边 + 柔和投影 + 仿工具栏），突出用户界面；
3) 品牌渐变背景（#2563eb -> #7c3aed，星芒 #fde047）+ 标题文案，与现有商店图块同一设计语言。
源截图在 素材/（不入库），成品在 store_assets/。
"""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

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
SUB_TEXT = (224, 231, 255)
BAR_BG = (244, 245, 249)
BAR_LINE = (227, 230, 238)
URL_GRAY = (148, 155, 170)
DOTS = [(248, 113, 113), (251, 191, 36), (52, 211, 153)]

# 取景框 (left, top, right, bottom)：去掉浏览器顶栏(约 y<95)，保留弹窗(约 y95-1145)与右侧头条/提示
SHOTS = [
    dict(src="素材/ScreenShot_2026-11-18_215032_268.png", crop=(571, 95, 2986, 1303),
         url="techcrunch.com", name="techcrunch",
         headline="一键翻译整个网页",
         sub="英文媒体 → 简体中文 · 455 段文本一次译完，排版不变",
         chips=("OpenAI 兼容 API", "术语括号解释")),
    dict(src="素材/ScreenShot_2026-11-18_215048_660.png", crop=(571, 95, 2997, 1308),
         url="www.wired.com", name="wired",
         headline="你的模型，你的风格",
         sub="自定义大模型 · 三档翻译风格 · 16 种目标语言",
         chips=("悬停 Ctrl 翻译", "一键还原原文")),
]


def font(path, size):
    return ImageFont.truetype(path, size, index=0)


def diagonal_gradient(w, h, c1, c2):
    """对角线性渐变：小网格计算 t=(x/w+y/h)/2 后双线性放大，平滑且快。"""
    gw, gh = 160, 160
    small = Image.new("RGB", (gw, gh))
    px = small.load()
    for y in range(gh):
        for x in range(gw):
            t = (x / (gw - 1) + y / (gh - 1)) / 2
            px[x, y] = tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return small.resize((w, h), Image.BILINEAR)


def add_glow(img):
    """柔光圆斑（screen 叠加约 7% 亮度），全部不透明绘制。"""
    w, h = img.size
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([w * 0.62, -h * 0.55, w * 1.25, h * 0.45], fill=(255, 255, 255))
    gd.ellipse([-w * 0.25, h * 0.55, w * 0.35, h * 1.45], fill=(255, 255, 255))
    glow = glow.point(lambda v: v // 14)
    return ImageChops.screen(img, glow)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


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


def chip(d, xy, s, f, pad_x=16, pad_y=8):
    """白描边胶囊，右对齐排版用，返回宽度。"""
    x, y = xy
    bb = d.textbbox((0, 0), s, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    h = th + pad_y * 2
    d.rounded_rectangle([x, y, x + tw + pad_x * 2, y + h], h // 2,
                        outline=(255, 255, 255), width=2)
    text(d, (x + pad_x, y + pad_y), s, f, (255, 255, 255))
    return tw + pad_x * 2


def lock(d, x, y, s=1.0, color=URL_GRAY):
    """小锁图标：锁钩 + 锁体。s 为缩放。"""
    w = max(1, round(2 * s))
    d.arc([x, y, x + 8 * s, y + 9 * s], start=180, end=360, fill=color, width=w)
    d.rounded_rectangle([x - 1 * s, y + 4.5 * s, x + 9 * s, y + 12 * s], 2 * s, fill=color)


def build_mockup(content, bar_h, radius, url, compact=False):
    """浏览器样机：仿工具栏 + 截图内容，整体圆角。content 已缩放至目标宽度。"""
    w = content.width
    h = bar_h + content.height
    m = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(m)
    d.rectangle([0, 0, w, bar_h], fill=BAR_BG)
    d.line([0, bar_h - 1, w, bar_h - 1], fill=BAR_LINE, width=1)
    # 窗口圆点
    r = 3 if compact else 6
    x0, gap = (14, 11) if compact else (28, 22)
    cy = bar_h // 2
    for i, c in enumerate(DOTS):
        d.ellipse([x0 + i * gap - r, cy - r, x0 + i * gap + r, cy + r], fill=c)
    # 地址栏
    px0 = 48 if compact else 96
    px1 = w - (70 if compact else 140)
    pad = 5 if compact else 10
    d.rounded_rectangle([px0, pad, px1, bar_h - pad], (bar_h - 2 * pad) // 2,
                        fill=(255, 255, 255), outline=BAR_LINE, width=1)
    f_url = font(FONT_REG, 8 if compact else 15)
    tx = px0 + (12 if compact else 34)
    ty = (bar_h - (8 if compact else 15)) // 2
    if not compact:
        lock(d, px0 + 12, ty - 1)
    text(d, (tx, ty), url, f_url, URL_GRAY)
    # 工具栏右侧固定的扩展图标
    isz = 12 if compact else 24
    paste_icon(m, isz, (w - isz - (14 if compact else 28), (bar_h - isz) // 2))
    m.paste(content, (0, bar_h))
    return m


def place_mockup(canvas, mockup, x, y, radius, border_w=2, compact=False):
    """柔和投影 + 圆角粘贴 + 白色描边。"""
    w, h = mockup.size
    sh = Image.new("L", canvas.size, 0)
    off = 6 if compact else 14
    ImageDraw.Draw(sh).rounded_rectangle(
        [x - 4, y + off, x + w + 4, y + h + off + 6], radius + 4,
        fill=90 if compact else 110)
    sh = sh.filter(ImageFilter.GaussianBlur(10 if compact else 20))
    dark = Image.new("RGB", canvas.size, (15, 12, 45))
    canvas.paste(Image.composite(dark, canvas, sh), (0, 0))
    canvas.paste(mockup, (x, y), rounded_mask((w, h), radius))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([x, y, x + w - 1, y + h - 1], radius,
                        outline=(255, 255, 255), width=border_w)


def render_1280(shot):
    W, H = 1280, 800
    img = add_glow(diagonal_gradient(W, H, C1, C2))
    d = ImageDraw.Draw(img)
    # 品牌行
    paste_icon(img, 46, (64, 34))
    d = ImageDraw.Draw(img)
    text(d, (126, 42), "AI Web Translator", font(FONT_LATIN, 30), (255, 255, 255))
    # 右上功能胶囊（右对齐至样机右缘 1216）
    f_chip = font(FONT_REG, 16)
    widths = [text_w(d, s, f_chip) + 32 for s in shot["chips"]]
    cx = 1216 - sum(widths) - 12 * (len(widths) - 1)
    for s, cw in zip(shot["chips"], widths):
        chip(d, (cx, 40), s, f_chip)
        cx += cw + 12
    # 标题与副标题
    text(d, (64, 96), shot["headline"], font(FONT_BOLD, 36), (255, 255, 255))
    text(d, (66, 143), shot["sub"], font(FONT_REG, 18), SUB_TEXT)
    # 星芒点缀（避开内容区）
    spark(d, 1240, 128, 9)
    spark(d, 40, 128, 7, (255, 255, 255))
    spark(d, 1244, 756, 6, (255, 255, 255))
    # 浏览器样机：内容 2:1，弹窗完整入画
    src = Image.open(os.path.join(BASE, shot["src"])).convert("RGB")
    content = src.crop(shot["crop"]).resize((1104, 552), Image.LANCZOS)
    mockup = build_mockup(content, 44, 18, shot["url"])
    place_mockup(img, mockup, 88, 176, 18)
    return img


def render_640(shot):
    W, H = 640, 400
    img = add_glow(diagonal_gradient(W, H, C1, C2))
    d = ImageDraw.Draw(img)
    paste_icon(img, 24, (32, 16))
    d = ImageDraw.Draw(img)
    text(d, (64, 19), "AI Web Translator", font(FONT_LATIN, 16), (255, 255, 255))
    text(d, (32, 50), shot["headline"], font(FONT_BOLD, 19), (255, 255, 255))
    spark(d, 614, 64, 5)
    spark(d, 20, 64, 4, (255, 255, 255))
    src = Image.open(os.path.join(BASE, shot["src"])).convert("RGB")
    content = src.crop(shot["crop"]).resize((552, 276), Image.LANCZOS)
    mockup = build_mockup(content, 22, 10, shot["url"], compact=True)
    place_mockup(img, mockup, 44, 88, 10, border_w=1, compact=True)
    return img


for i, shot in enumerate(SHOTS, 1):
    for size, render in ((("1280x800"), render_1280), (("640x400"), render_640)):
        img = render(shot).convert("RGB")
        stem = f"screenshot_{i}_{shot['name']}_{size}"
        png = os.path.join(OUT, stem + ".png")
        jpg = os.path.join(OUT, stem + ".jpg")
        img.save(png, "PNG")
        img.save(jpg, "JPEG", quality=92, subsampling=0, optimize=True)
        for p in (png, jpg):
            with Image.open(p) as im:
                assert im.mode == "RGB", f"{p} 含 alpha 或非 RGB: {im.mode}"
                print(os.path.basename(p), im.size, im.mode, os.path.getsize(p), "bytes")