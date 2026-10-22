#!/usr/bin/env python3
"""为内置人物头像生成离线透明轮廓；仅维护素材时运行，依赖 Pillow。

源 WebP 保持不变。只移除与画面边缘连通的浅色背景，保留被线稿围住的
白发、皮肤及服装；最后保留人物主体，去除截帧中游离的背景线条。
"""
from collections import deque
import json
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
AVATARS = ROOT / 'resources' / 'avatars'
OUTPUT = AVATARS / 'backgrounds'


def silhouette(image):
    """边缘泛洪生成遮罩，不对人物内部的浅色像素做全局色键删除。"""
    image = image.convert('RGBA')
    width, height = image.size
    pixels = image.load()
    mask = Image.new('L', image.size, 255)
    alpha = mask.load()
    queue = deque()

    def visit(x, y):
        r, g, b, _ = pixels[x, y]
        if alpha[x, y] and min(r, g, b) >= 230 and max(r, g, b) - min(r, g, b) <= 22:
            alpha[x, y] = 0
            queue.append((x, y))

    # 底边是裁切后的衣服和头发，不将底边白色服装直接当成背景种子。
    for x in range(width):
        visit(x, 0)
    for y in range(height):
        visit(0, y)
        visit(width - 1, y)
    while queue:
        x, y = queue.popleft()
        for a, b in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= a < width and 0 <= b < height:
                visit(a, b)

    # 最大连通主体包含人物及相连饰品；独立的背景圆弧、字幕碎片不参与遮挡。
    seen = set()
    largest = []
    for y in range(height):
        for x in range(width):
            if not alpha[x, y] or (x, y) in seen:
                continue
            component = []
            queue.append((x, y))
            seen.add((x, y))
            while queue:
                a, b = queue.popleft()
                component.append((a, b))
                for c, d in ((a - 1, b), (a + 1, b), (a, b - 1), (a, b + 1)):
                    if 0 <= c < width and 0 <= d < height and alpha[c, d] and (c, d) not in seen:
                        seen.add((c, d))
                        queue.append((c, d))
            if len(component) > len(largest):
                largest = component
    mask = Image.new('L', image.size)
    alpha = mask.load()
    for x, y in largest:
        alpha[x, y] = 255
    # 仅柔化轮廓边缘，人物内部保持不透明，先正确遮挡再由整个背景组统一淡化。
    image.putalpha(mask.filter(ImageFilter.GaussianBlur(0.45)))
    return image


if __name__ == '__main__':
    OUTPUT.mkdir(exist_ok=True)
    records = json.loads((AVATARS / 'sources.json').read_text())
    for family, record in records['models'].items():
        silhouette(Image.open(AVATARS / record['file'])).save(OUTPUT / f'model-{family}.png')
    print('Generated seven transparent background portraits; original avatars preserved.')
