"""Trace Capri's body from a reference frame into vector layers.

Usage:  py tools/trace_art.py   ->  src/renderer/art.js

Her body comes from reference/capri-full.png. The art is hard-edged cut
paper, so flat color thresholds separate it cleanly. Each color layer is
upsampled, traced and simplified into polygons, and every connected piece of
the silhouette becomes its own part so detached shards can be animated
independently. The hair glitter is lifted straight out of the frame as an
alpha mask.

To let her move, the main silhouette is cut into puppet pieces: joint polygons
carve out the head, torso and legs, and morphological opening splits the mane
into a core and the spikes sticking out of it. Each piece gets a pivot, and
each one also draws a thin underlay of the pieces drawn after it, so seams
stay closed while pieces rotate a few degrees.

Her face is too small in the full-body frame to trace (about 50 px wide), so
it is modelled from the close-up reference/capri-face.png and mapped onto the
full-body frame through the two eye centers. The rig draws it, so it can
blink and talk.
"""

import base64
import io
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'reference' / 'capri-full.png'
OUT = ROOT / 'src' / 'renderer' / 'art.js'

SUPERSAMPLE = 4
SIMPLIFY = 0.6          # max polygon deviation, in source pixels
REGION_X = (200, 760)   # columns of the frame that contain her
PAD = 6
DRAW_ORDER = ['purple', 'blue', 'pink', 'shade', 'green']
PINK = '#f8034d'        # dominant hair color (k-means), not the edge-polluted mean
INK = '#08061a'
EXTEND = 80             # rows added above and below the frame to finish shards it cuts off
RIM = (3, 1)            # offset of the purple rim under each finished shard

# Face model, measured on a 6x zoom of reference/capri-face.png cropped at
# (95, 85): source = (95 + zx / 6, 85 + zy / 6).
FACE_ZOOM = {
    'eyes': [(205, 320), (578, 240)],
    'ring': 78,  # outer radius of the green ring
    'visor': [(40, 243), (98, 186), (270, 152), (300, 150), (440, 100), (700, 28), (712, 330), (330, 405), (120, 468)],
    'wedge': [(282, -40), (308, -40), (314, 392)],
    'sockets': [
        [(62, 252), (120, 212), (222, 205), (272, 148), (262, 232), (302, 318), (338, 394), (240, 400), (150, 446)],
        [(462, 118), (528, 158), (640, 165), (706, 212), (684, 300), (600, 332), (470, 358), (505, 290), (498, 190)],
    ],
    'mouth': [(300, 490), (370, 455), (395, 468), (445, 438), (470, 462), (510, 428), (570, 397)],
}
# Where those two eyes sit in the full-body frame (blue blob centers).
EYES_FULL = [(485.0, 222.1), (514.3, 221.6)]

# Puppet joints in reference-frame pixels, in draw order: (name, parent,
# pivot, polygon). The head claims its pixels first; after that, earlier
# entries win where polygons overlap. Whatever no polygon claims is mane.
BODY = [
    ('torso', None, (498, 392), [(456, 248), (548, 248), (548, 300), (538, 350), (534, 386), (468, 388), (462, 330), (452, 290)]),
    ('legL', 'torso', (482, 392), [(296, 352), (468, 356), (492, 376), (494, 418), (296, 424)]),
    ('legR', 'torso', (515, 394), [(510, 372), (560, 366), (690, 380), (700, 405), (640, 432), (560, 428), (506, 422)]),
    ('shin', 'legR', (688, 410), [(560, 428), (640, 432), (700, 405), (726, 398), (726, 660), (452, 660), (470, 560), (520, 470)]),
    ('head', 'torso', (497, 254), [(452, 196), (468, 168), (505, 182), (542, 168), (580, 156), (568, 196), (542, 226), (532, 246), (506, 258), (482, 256), (462, 246), (450, 228)]),
]
MANE_PIVOT = (500, 214)  # the mane sways about her head
LOCK_OPEN = 17           # opening radius that leaves the mane's core without its spikes
LOCK_MIN_AREA = 140
UNDERLAY = 6             # px of each later piece drawn under the one before
# The traced legs still claim their pixels (so they don't become mane), but
# the rig draws posable limbs instead, so they're left out of the art.
RETIRED = {'legL', 'legR', 'shin'}
DEBUG = None             # --debug out.png saves a map of the pieces and pivots


def face_transform():
    src = [np.array([95 + x / 6, 85 + y / 6]) for x, y in FACE_ZOOM['eyes']]
    dst = [np.array(p) for p in EYES_FULL]
    v2, v3 = src[1] - src[0], dst[1] - dst[0]
    scale = np.linalg.norm(v3) / np.linalg.norm(v2)
    angle = math.atan2(v3[1], v3[0]) - math.atan2(v2[1], v2[0])
    rot = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]) * scale

    def apply(zx, zy):
        p = np.array([95 + zx / 6, 85 + zy / 6]) - src[0]
        return rot @ p + dst[0]

    return apply, scale / 6  # zoom px -> full-frame px


def load_masks(img):
    R, G, B = (img[..., i] for i in range(3))
    m = {
        'pink': (R > 150) & (G < 140) & (R > G + 80) & (R > B + 20),
        'shade': (R > 60) & (R <= 150) & (G < 45) & (R > B + 20),
        'glitter': (R > 200) & (G > 140) & (B > 150),
        'purple': (B > 110) & (B > R - 10) & (G < 90) & (R > 60),
        'green': (G > 170) & (R < 120) & (B < 170) & (G > B + 40),
        # Her black is violet-black with almost no green (G under 10, B well
        # above it); the room's darkest shadows are grayer (G 12+, B - G < 10).
        'black': (G < 12) & (R < 60) & (B < 50) & (B >= G + 12),
        'blue': (B > 110) & (R < 70) & (G > 50) & (G < 150) & (B > G + 30),
    }
    region = np.zeros(R.shape, bool)
    region[:, REGION_X[0]:REGION_X[1]] = True
    for k in m:
        m[k] &= region
    return m


def poly_mask(shape, polys, grow=0):
    mask = np.zeros(shape, np.uint8)
    for poly in polys:
        cv2.fillPoly(mask, [np.round(np.array(poly)).astype(np.int32)], 1)
    if grow:
        mask = cv2.dilate(mask, np.ones((2 * grow + 1, 2 * grow + 1), np.uint8))
    return mask > 0


def mean_color(img, mask):
    return '#%02x%02x%02x' % tuple(img[mask].mean(0).round().astype(int))


def drop_specks(mask, min_area):
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    return keep[lab]


def her_black(black, colored):
    """Black that belongs to her: pieces bordered by her colors (big ones need less of it)."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(black.astype(np.uint8), connectivity=8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        x0, y0, x1, y1 = max(x - 3, 0), max(y - 3, 0), x + w + 3, y + h + 3
        comp = (lab[y0:y1, x0:x1] == i).astype(np.uint8)
        ring = (cv2.dilate(comp, np.ones((5, 5), np.uint8)) > 0) & (comp == 0)
        frac = colored[y0:y1, x0:x1][ring].mean() if ring.any() else 0
        keep[i] = (area >= 25 and frac >= 0.45) or (area >= 300 and frac >= 0.05)
    return keep[lab]


def spike_outline(xa, xb, row, direction, rng):
    """A row of shard points growing out of the cut edge [xa, xb) at `row`."""
    n = max(1, round((xb - xa) / 45))
    edges = np.linspace(xa, xb, n + 1)
    pts = [(xa, row)]
    for i in range(n):
        a, b = edges[i], edges[i + 1]
        h = min(rng.uniform(1.0, 1.7) * (b - a) * (1 if direction < 0 else 0.6), EXTEND - PAD - 4)
        pts.append((a + (b - a) * rng.uniform(0.3, 0.8), row + direction * max(h, 8)))
        if i < n - 1:
            pts.append((b, row + direction * rng.uniform(2, 10)))
    pts.append((xb, row))
    return pts


def finish_cut_edges(silhouette, layers, top, bottom):
    """The frame cuts off the top of her hair and the ends of her legs. Grow
    shard points out of each cut so she reads as a whole cut-paper figure."""
    rng = np.random.default_rng(3)
    for row, direction in ((top, -1), (bottom, 1)):
        cols = np.flatnonzero(silhouette[row])
        for run in np.split(cols, np.flatnonzero(np.diff(cols) > 1) + 1) if len(cols) else []:
            xa, xb = int(run[0]), int(run[-1]) + 1
            if xb - xa < 3:
                continue
            outline = spike_outline(xa, xb, row, direction, rng)
            spike = poly_mask(silhouette.shape, [outline])
            rim = poly_mask(silhouette.shape, [[(x + RIM[0], y + RIM[1] * direction) for x, y in outline]])
            beyond = np.zeros_like(spike)
            if direction < 0:
                beyond[:row] = True
            else:
                beyond[row + 1:] = True
            spike &= beyond
            rim &= beyond
            silhouette |= spike | rim
            layers['purple'] |= rim
            if layers['pink'][row, xa:xb].mean() > 0.5:
                layers['pink'] |= spike


def split_pieces(main, ey):
    """Cut the main silhouette into puppet pieces, in draw order, each with
    its own pixels, its parent and its pivot."""
    shape = main.shape
    lift = lambda pts: [(x, y + ey) for x, y in pts]
    claimed = np.zeros(shape, bool)
    body = {}
    for name, parent, pivot, poly in sorted(BODY, key=lambda b: b[0] != 'head'):
        own = poly_mask(shape, [lift(poly)]) & main & ~claimed
        claimed |= own
        body[name] = {'name': name, 'kind': name, 'parent': parent, 'pivot': (pivot[0], pivot[1] + ey), 'own': own}

    mane = main & ~claimed
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * LOCK_OPEN + 1,) * 2)
    core = (cv2.morphologyEx(mane.astype(np.uint8), cv2.MORPH_OPEN, k) > 0) & mane
    spikes = mane & ~core
    n, lab, stats, _ = cv2.connectedComponentsWithStats(spikes.astype(np.uint8), connectivity=8)
    locks = []
    k5 = np.ones((5, 5), np.uint8)
    for i in range(1, n):
        spike = lab == i
        root = (cv2.dilate(spike.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & core
        if stats[i, cv2.CC_STAT_AREA] < LOCK_MIN_AREA or not root.any():
            core |= spike
            continue
        ry, rx = np.nonzero(root)
        pivot = (float(rx.mean()), float(ry.mean()))
        sy, sx = np.nonzero(spike)
        far = np.argmax((sx - pivot[0]) ** 2 + (sy - pivot[1]) ** 2)
        tip = (float(sx[far]), float(sy[far]))
        if math.dist(pivot, tip) < 20:
            core |= spike
            continue
        # The lock reaches a little into the core so its root never shows a slit.
        own = spike | ((cv2.dilate(spike.astype(np.uint8), k5) > 0) & core)
        locks.append({'name': f'lock{len(locks)}', 'kind': 'lock', 'parent': 'mane', 'pivot': pivot, 'tip': tip, 'own': own})
    mane_piece = {'name': 'mane', 'kind': 'mane', 'parent': None, 'pivot': (MANE_PIVOT[0], MANE_PIVOT[1] + ey), 'own': core}
    return [mane_piece] + locks + [body[b[0]] for b in BODY]


def add_underlays(pieces, main):
    """Each piece also draws the pixels of later pieces within UNDERLAY px of
    it, so when a piece on top moves, the one below continues the picture."""
    k = np.ones((2 * UNDERLAY + 1,) * 2, np.uint8)
    later = np.zeros(main.shape, bool)
    for piece in reversed(pieces):
        near = cv2.dilate(piece['own'].astype(np.uint8), k) > 0
        piece['mask'] = piece['own'] | (near & later & main)
        if piece['name'] not in RETIRED:
            later |= piece['own']


def nearest_owner(pieces, main):
    """For every pixel: which piece owns the nearest main pixel, and how far it is."""
    owner = np.full(main.shape, -1, int)
    for i, piece in enumerate(pieces):
        owner[piece['own'] & (owner < 0)] = i
    dist, labels = cv2.distanceTransformWithLabels((~main).astype(np.uint8), cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(main)  # the zero pixels of the input, in label order
    return owner[ys, xs][labels - 1], dist


def save_debug(path, img, pieces):
    rng = np.random.default_rng(1)
    vis = (img * 0.25).astype(np.uint8)
    for piece in pieces:
        vis[piece['own']] = rng.integers(60, 255, 3)
    for piece in pieces:
        x, y = map(int, piece['pivot'])
        cv2.circle(vis, (x, y), 4, (255, 255, 255), -1)
        if 'tip' in piece:
            cv2.line(vis, (x, y), tuple(map(int, piece['tip'])), (255, 255, 255), 1)
    Image.fromarray(vis).save(path)


def path_data(mask, origin):
    if not mask.any():
        return ''
    big = cv2.resize(mask.astype(np.uint8) * 255, None, fx=SUPERSAMPLE, fy=SUPERSAMPLE, interpolation=cv2.INTER_LINEAR)
    contours, _ = cv2.findContours((big >= 128).astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in contours:
        if abs(cv2.contourArea(c)) < 1.5 * SUPERSAMPLE ** 2:
            continue
        poly = cv2.approxPolyDP(c, SIMPLIFY * SUPERSAMPLE, True).reshape(-1, 2)
        if len(poly) < 3:
            continue
        pts = (poly + 0.5) / SUPERSAMPLE - origin
        out.append('M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in pts) + 'Z')
    return ''.join(out)


def png_data_url(rgba):
    buf = io.BytesIO()
    Image.fromarray(rgba).save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    # Work in a copy of the frame with empty rows above and below it.
    frame = np.array(Image.open(SRC).convert('RGB')).astype(int)
    img = np.pad(frame, ((EXTEND, EXTEND), (0, 0), (0, 0)))
    top, bottom = EXTEND, EXTEND + frame.shape[0] - 1
    m = load_masks(img)
    k3 = np.ones((3, 3), np.uint8)
    frame_to_full, zoom_scale = face_transform()
    to_full = lambda zx, zy: frame_to_full(zx, zy) + (0, EXTEND)
    eyes_full = [(x, y + EXTEND) for x, y in EYES_FULL]

    face = {k: [list(map(tuple, (to_full(*p) for p in poly))) for poly in v] for k, v in
            {'visor': [FACE_ZOOM['visor']], 'wedge': [FACE_ZOOM['wedge']], 'sockets': FACE_ZOOM['sockets']}.items()}
    face_area = poly_mask(m['pink'].shape, face['visor'] + face['sockets'], grow=2)
    mouth_pts = [to_full(*p) for p in FACE_ZOOM['mouth']]
    mouth_area = poly_mask(m['pink'].shape, [cv2.convexHull(np.array(mouth_pts, np.float32)).reshape(-1, 2)], grow=3)

    # The rig draws the face: clear traced color there and let the body's ink show.
    for k in ('green', 'blue', 'glitter'):
        m[k] &= ~(face_area | mouth_area)

    colored = m['pink'] | m['shade'] | m['glitter'] | m['purple'] | m['green'] | m['blue']
    black = her_black(m['black'], colored)

    silhouette = colored | black | face_area | mouth_area
    silhouette = cv2.morphologyEx(silhouette.astype(np.uint8), cv2.MORPH_CLOSE, k3) > 0
    silhouette = drop_specks(silhouette, 10)

    # Glitter belongs to her where it connects to pink, even through dense white patches.
    n, lab = cv2.connectedComponents((m['pink'] | m['glitter']).astype(np.uint8))
    glitter = m['glitter'] & np.isin(lab, np.unique(lab[m['pink']]))
    # Dark red where pink fades into black is antialiasing, not a drawn line.
    m['shade'] &= ~(cv2.dilate(black.astype(np.uint8), k3) > 0)
    # Washed-out glitter falls between the pink and white thresholds; close
    # those pinholes, but never across her black.
    hair = cv2.morphologyEx((m['pink'] | glitter | m['shade']).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)) > 0
    layers = {
        'pink': hair & ~black,
        'shade': m['shade'],
        'purple': cv2.dilate(m['purple'].astype(np.uint8), k3) > 0,
        'blue': cv2.dilate(m['blue'].astype(np.uint8), k3) > 0,
        'green': m['green'],
    }
    for k in layers:
        layers[k] &= silhouette
    layers['pink'] &= ~face_area
    finish_cut_edges(silhouette, layers, top, bottom)

    colors = {
        'ink': INK,
        'pink': PINK,
        'shade': mean_color(img, m['shade']),
        'purple': mean_color(img, m['purple']),
        'blue': mean_color(img, m['blue']),
        'green': mean_color(img, m['green']),
    }

    ys, xs = np.nonzero(silhouette)
    x0, y0 = xs.min() - PAD, ys.min() - PAD
    x1, y1 = xs.max() + PAD + 1, ys.max() + PAD + 1
    origin = np.array([x0, y0], float)

    # Glitter: how far each hair pixel is pushed from pink toward white.
    # Finished shards past the frame borrow the glitter mirrored from inside it.
    raw = np.clip((img[..., 1] - 14) / 230, 0, 1)
    for k in range(1, EXTEND):
        raw[top - k] = raw[top + k]
        raw[bottom + k] = raw[bottom - k]
    sparkle = raw * (layers['pink'] & ~m['shade'])
    alpha = (sparkle[y0:y1, x0:x1] * 255).round().astype(np.uint8)
    rgba = np.dstack([np.full_like(alpha, 255)] * 3 + [alpha])
    bright = (alpha > 110).astype(np.uint8)
    n, lab = cv2.connectedComponents(bright)
    rng = np.random.default_rng(7)
    twinkle_ids = np.flatnonzero(rng.random(n) < 0.4)
    twinkle = np.isin(lab, twinkle_ids[twinkle_ids > 0])
    rgba_twinkle = rgba.copy()
    rgba_twinkle[..., 3] = np.where(twinkle, 255, 0)

    n, lab, stats, _ = cv2.connectedComponentsWithStats(silhouette.astype(np.uint8), connectivity=8)
    main_id = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    main_mask = lab == main_id
    pieces = split_pieces(main_mask, EXTEND)
    add_underlays(pieces, main_mask)

    # Detached shards hang off whichever piece is nearest.
    owner, dist = nearest_owner(pieces, main_mask)
    shards = []
    for i in range(1, n):
        if i == main_id or stats[i, cv2.CC_STAT_AREA] < 12:
            continue
        comp = lab == i
        ys, xs = np.nonzero(comp)
        near = np.argmin(dist[ys, xs])
        parent = pieces[owner[ys[near], xs[near]]]
        if parent['name'] in RETIRED:
            parent = next(p for p in pieces if p['name'] == 'torso')
        shards.append({'name': f'shard{len(shards)}', 'kind': 'shard', 'parent': parent['name'],
                       'pivot': (float(xs[near]), float(ys[near])), 'own': comp, 'mask': comp})
    if DEBUG:
        save_debug(DEBUG, img, pieces + shards)

    rel = lambda pts: [[round(float(x - x0), 2), round(float(y - y0), 2)] for x, y in pts]
    out = []
    for piece in [p for p in pieces if p['name'] not in RETIRED] + shards:
        entry = {
            'name': piece['name'],
            'kind': piece['kind'],
            'parent': piece['parent'],
            'pivot': rel([piece['pivot']])[0],
            'base': path_data(piece['mask'], origin),
        }
        if 'tip' in piece:
            entry['tip'] = rel([piece['tip']])[0]
        for k in DRAW_ORDER:
            d = path_data(layers[k] & piece['mask'], origin)
            if d:
                entry[k] = d
        out.append(entry)

    art = {
        'width': int(x1 - x0),
        'height': int(y1 - y0),
        'origin': [int(x0), int(y0 - EXTEND)],  # where the art sits in the reference frame
        'colors': colors,
        'pieces': out,
        'glitter': png_data_url(rgba),
        'twinkle': png_data_url(rgba_twinkle),
        'face': {
            'visor': rel(face['visor'][0]),
            'wedge': rel(face['wedge'][0]),
            'sockets': [rel(s) for s in face['sockets']],
            'eyes': [{'x': p[0], 'y': p[1]} for p in rel(eyes_full)],
            'ring': round(FACE_ZOOM['ring'] * zoom_scale, 2),
            'mouth': rel(mouth_pts),
        },
    }
    OUT.write_text(
        '// Generated by tools/trace_art.py from the reference frames. Do not edit by hand.\n'
        'window.Capri = window.Capri || {};\n'
        f'window.Capri.ART = {json.dumps(art, separators=(",", ":"))};\n',
        encoding='utf-8',
    )
    kinds = {}
    for piece in out:
        kinds[piece['kind']] = kinds.get(piece['kind'], 0) + 1
    print(f'{OUT.relative_to(ROOT)}: {art["width"]}x{art["height"]}, pieces {kinds}, {OUT.stat().st_size / 1024:.0f} KB')
    print('colors', colors, '| eye ring r', art['face']['ring'])


if __name__ == '__main__':
    if '--debug' in sys.argv:
        DEBUG = sys.argv[sys.argv.index('--debug') + 1]
    main()
