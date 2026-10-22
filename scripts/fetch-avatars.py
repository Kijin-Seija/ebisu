#!/usr/bin/env python3
"""从固定提交下载角色截帧，生成离线头像并保留来源；只在维护素材时运行。"""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import urllib.request
from PIL import Image, ImageOps, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'resources' / 'avatars'
OUTPUT.mkdir(parents=True, exist_ok=True)
HEADERS = {'User-Agent': 'Ebisu-avatar-collector'}


def download(url):
    """有界请求；下载失败直接报错，不用不相关图片代替。"""
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=35) as response:
        return response.read()


record_file = OUTPUT / 'sources.json'
existing = json.loads(record_file.read_text()) if record_file.exists() else {}
commit = existing.get('commit') or json.loads(download('https://api.github.com/repos/shuaizenge/ai-girls/commits/main'))['sha']
base = f'https://raw.githubusercontent.com/shuaizenge/ai-girls/{commit}/'
frames = {'gpt': '23', 'claude': '17', 'deepseek': '05', 'kimi': '41', 'qwen': '53', 'gemini': '11', 'grok': '29'}
crops = {'gpt': (120,80,600,560), 'claude': (150,80,550,480), 'deepseek': (140,130,620,610),
         'kimi': (160,110,600,550), 'qwen': (150,80,590,520), 'gemini': (120,100,600,580), 'grok': (240,160,720,640)}


def avatar(item):
    model, second = item
    source_path = f'characters/{model}/chibi/zipzippipe-BV1tE9XBbErS-{second}s.png'
    raw = download(base + source_path)
    image = Image.open(io.BytesIO(raw)).convert('RGB')
    # 完整截帧留在参考拼图用于视觉核对；默认裁切区域后续可按头部位置调整。
    crop = image.crop(crops[model])
    crop.resize((256, 256), Image.Resampling.LANCZOS).save(OUTPUT / f'model-{model}.webp', quality=92)
    return model, image, {'file': f'model-{model}.webp', 'source': base + source_path,
        'sourceSha256': hashlib.sha256(raw).hexdigest(), 'author': 'ZipZipPipe',
        'originalCharacterAuthor': '上善无形' if model == 'deepseek' else None,
        'work': 'https://www.bilibili.com/video/BV1tE9XBbErS/', 'timeSeconds': int(second),
        'modifications': '裁切为头像，缩放并转换为 WebP', 'crop': crops[model],
        'license': 'CC BY-NC-SA 4.0' if model == 'deepseek' else '作者声明开放分享与再创作；无统一标准许可证'}


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(avatar, frames.items()))
records = {model: record for model, image, record in results}
record_file.write_text(json.dumps({'repository': 'https://github.com/shuaizenge/ai-girls', 'commit': commit,
    'retrievedOn': '2026-10-22', 'models': records}, ensure_ascii=False, indent=2) + '\n')
(OUTPUT / 'UPSTREAM-NOTICE.md').write_bytes(download(base + 'NOTICE.md'))
sheet = Image.new('RGB', (7 * 180, 350), '#eee')
draw = ImageDraw.Draw(sheet)
for index, (model, image, _) in enumerate(results):
    image.thumbnail((180, 320))
    sheet.paste(image, (index * 180, 20))
    draw.text((index * 180 + 8, 4), model, fill='black')
(ROOT / '.smoke').mkdir(exist_ok=True)
sheet.save(ROOT / '.smoke' / 'avatar-sources.jpg')
print('Downloaded seven model portraits at commit', commit)
