"""Render the iOS app icon (1024x1024 PNG, opaque) from the same geometry as the Android vector icon
(android/app/src/main/res/drawable/ic_launcher_foreground.xml on #245C8A, values/colors.xml): a face outline with the
three guided-capture points on a 108-unit canvas. The App Store icon must be square and have no alpha channel; iOS
applies the rounded mask itself.

Usage: python render_app_icon.py <output.png>
"""
import sys

from PIL import Image, ImageDraw

SIZE, SUPER, VIEW = 1024, 4, 108.0
BACKGROUND, INK = (0x24, 0x5C, 0x8A), (255, 255, 255)
# The outline as the Android path: M54,30 then four cubic segments back to the start.
OUTLINE = [((54, 30), (64, 30), (71, 39), (71, 52)), ((71, 52), (71, 66), (64, 78), (54, 78)),
           ((54, 78), (44, 78), (37, 66), (37, 52)), ((37, 52), (37, 39), (44, 30), (54, 30))]
STROKE = 3.0
DOTS = [((47, 48), 2.5), ((61, 48), 2.5), ((54, 56), 2.0)]


def cubic(p0, p1, p2, p3, steps=200):
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        yield (u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
               u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1])


def main(out):
    big = SIZE * SUPER
    k = big / VIEW
    img = Image.new('RGB', (big, big), BACKGROUND)
    draw = ImageDraw.Draw(img)
    points = [(x * k, y * k) for seg in OUTLINE for x, y in cubic(*seg)]
    width = round(STROKE * k)
    draw.line(points, fill=INK, width=width, joint='curve')
    for x, y in points[:: max(1, len(points) // 400)]:  # round the stroke ends and joints
        r = width / 2
        draw.ellipse((x - r, y - r, x + r, y + r), fill=INK)
    for (cx, cy), r in DOTS:
        draw.ellipse(((cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k), fill=INK)
    img.resize((SIZE, SIZE), Image.LANCZOS).save(out, 'PNG', optimize=True)


if __name__ == '__main__':
    main(sys.argv[1])
