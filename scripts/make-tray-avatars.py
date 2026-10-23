#!/usr/bin/env python3
"""从 Q 版角色原图生成托盘专用透明背景；仅维护素材时运行，依赖 Pillow。

托盘要把水平面（角色手下的搁板）对齐卡片底端，并让水平面以下的手和装饰
溢出卡片。水平线以上按边缘泛洪移除浅色背景；水平线以下连同白色桌面一起
移除，只保留被轮廓隔开的手部、发梢和挂饰。主窗口继续使用 backgrounds/
下的旧透明轮廓。
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
AVATARS = ROOT / 'resources' / 'avatars'
SOURCE = AVATARS / 'q-version'
OUTPUT = AVATARS / 'tray'
OUTPUT_SIZE = 256
# 各素材水平面在 512px 原图中的位置，用于让七个角色的搁板统一贴住卡片底边。
LINE_RATIOS = {
    'gpt': 0.921875,
    'claude': 0.921875,
    'deepseek': 0.93359375,
    'kimi': 0.923828125,
    'qwen': 0.865234375,
    'gemini': 0.93359375,
    'grok': 0.92578125
}


def cutout(image, line_ratio):
    image = image.convert('RGBA')
    width, height = image.size
    line_y = round(height * line_ratio)
    pixels = image.load()
    alpha = Image.new('L', image.size, 255)
    mask = alpha.load()
    queue = deque()

    def bright(x, y, minimum, chroma):
        r, g, b, _ = pixels[x, y]
        return min(r, g, b) >= minimum and max(r, g, b) - min(r, g, b) <= chroma

    def visit(x, y, y_min, y_max, minimum, chroma):
        if not (y_min <= y < y_max) or not mask[x, y]:
            return
        if bright(x, y, minimum, chroma):
            mask[x, y] = 0
            queue.append((x, y))

    def flood(seeds, y_min, y_max, minimum, chroma):
        for x, y in seeds:
            visit(x, y, y_min, y_max, minimum, chroma)
        while queue:
            x, y = queue.popleft()
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < width and 0 <= ny < height:
                    visit(nx, ny, y_min, y_max, minimum, chroma)

    # 水平线以上：从顶部和两侧移除浅色背景。
    flood(
        [(x, 0) for x in range(width)]
        + [(0, y) for y in range(line_y)]
        + [(width - 1, y) for y in range(line_y)],
        0,
        line_y,
        238,
        20
    )
    # 水平线以下：桌面白底与薄弱边缘阴影一起移除；人物手部和装饰有不透明轮廓隔开。
    flood(
        [(x, height - 1) for x in range(width)]
        + [(0, y) for y in range(line_y, height)]
        + [(width - 1, y) for y in range(line_y, height)],
        line_y,
        height,
        215,
        30
    )

    # 保留发梢、悬浮星星等所有有体积的前景，只丢弃背景噪点。
    seen = set()
    for y in range(height):
        for x in range(width):
            if not mask[x, y] or (x, y) in seen:
                continue
            component = []
            queue.append((x, y))
            seen.add((x, y))
            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < width and 0 <= ny < height and mask[nx, ny] and (nx, ny) not in seen:
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            if len(component) < 12:
                for cx, cy in component:
                    mask[cx, cy] = 0

    # 人物与装饰轮廓轻微羽化，避免缩放后出现硬边。
    image.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.3)))
    return image.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)


if __name__ == '__main__':
    OUTPUT.mkdir(exist_ok=True)
    for source in sorted(SOURCE.glob('model-*.webp')):
        family = source.stem.removeprefix('model-')
        target = OUTPUT / f'{source.stem}.png'
        cutout(Image.open(source), LINE_RATIOS[family]).save(target, optimize=True)
        print(f'{target.name} (plane {LINE_RATIOS[family]:.4f})')
