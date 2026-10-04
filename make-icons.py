#!/usr/bin/env python3
"""生成悬浮便签扩展的图标（16/32/48/128 PNG，无第三方依赖）。

设计：琥珀色圆角便签 + 右下角折角 + 三条白色横线（表示"记录"）。
用法：python3 make-icons.py
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).parent / "icons"
AMBER = (251, 191, 36, 255)
AMBER_DARK = (245, 158, 11, 255)
WHITE = (255, 255, 255, 235)
EDGE = (180, 120, 10, 255)


def rounded_rect(px, size, x0, y0, x1, y1, r, color):
    for y in range(max(0, y0), min(size, y1)):
        for x in range(max(0, x0), min(size, x1)):
            cx = min(max(x, x0 + r), x1 - r - 1)
            cy = min(max(y, y0 + r), y1 - r - 1)
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                px[y][x] = color


def fill_triangle(px, size, pts, color):
    (x1, y1), (x2, y2), (x3, y3) = pts
    for y in range(size):
        for x in range(size):
            d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
            d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
            d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
            if (d1 >= 0 and d2 >= 0 and d3 >= 0) or (d1 <= 0 and d2 <= 0 and d3 <= 0):
                px[y][x] = color


def write_png(path, px, size):
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in px)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def draw(size: int):
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]
    m = max(1, round(size * 0.06))  # 外边距
    r = max(2, round(size * 0.18))  # 圆角
    rounded_rect(px, size, m, m, size - m, size - m, r, EDGE)
    rounded_rect(px, size, m + 1, m + 1, size - m - 1, size - m - 1, r, AMBER)

    # 右下折角
    fold = max(3, round(size * 0.30))
    fill_triangle(px, size, [(size - m - fold, size - m - 1), (size - m - 1, size - m - fold), (size - m - 1, size - m - 1)], AMBER_DARK)

    # 三条横线
    lw = max(1, round(size * 0.075))
    x0, x1 = m + round(size * 0.16), size - m - round(size * 0.20)
    for i, frac in enumerate((0.30, 0.46, 0.62)):
        y0 = m + round(size * frac)
        yy1 = min(y0 + lw, size - m - fold if i == 2 else size - m)
        rounded_rect(px, size, x0, y0, x1, yy1, max(1, lw // 2), WHITE)
    return px


def main():
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(OUT / f"icon{size}.png", draw(size), size)
        print("wrote", OUT / f"icon{size}.png")


if __name__ == "__main__":
    main()
