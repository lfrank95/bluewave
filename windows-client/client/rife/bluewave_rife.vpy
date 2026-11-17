# Bluewave: RIFE-Zwischenbilder (KI) für mpv (--vf=vapoursynth) und zum Vorbereiten der TensorRT-Engines (VSPipe).
# Einstellungen kommen als JSON-Datei (Umgebung BW_RIFE_CFG oder --arg cfg=…); der Zustand geht als JSON in cfg['status'],
# das liest der Bildmonitor. Schlägt etwas fehl, läuft der Film in mpv ohne Zwischenbilder weiter.
import inspect
import json
import os
import sys
import time
import traceback
from fractions import Fraction

import vapoursynth as vs

core = vs.core


def _arg(name, standard=None):
    w = globals().get(name, standard)
    return w.decode() if isinstance(w, bytes) else w


CFG = json.load(open(_arg('cfg') or os.environ['BW_RIFE_CFG'], encoding='utf-8'))
MODUS = _arg('modus', 'mpv')


def status(**w):
    try:
        with open(CFG['status'], 'w', encoding='utf-8') as f:
            json.dump({'zeit': time.time(), 'modus': MODUS, **w}, f)
    except Exception:
        pass


def aufruf(fn, *a, **kw):
    """Nur die Argumente übergeben, die die vs-mlrt-Version kennt"""
    try:
        p = inspect.signature(fn).parameters
        if not any(x.kind == x.VAR_KEYWORD for x in p.values()):
            kw = {k: v for k, v in kw.items() if k in p}
    except (TypeError, ValueError):
        pass
    return fn(*a, **kw)


def bildrate(fps):
    """Bildrate als Bruch (23,976 → 24000/1001)"""
    for n in (24, 25, 30, 48, 50, 60):
        if abs(fps - n * 1000 / 1001) < 0.01:
            return n * 1000, 1001
    f = Fraction(fps).limit_denominator(1001)
    return f.numerator, f.denominator


def interpolieren(rgb, m):
    # RIFE rechnet in Kacheln von 32 Pixeln: rechts/unten auffüllen (z. B. 2160 → 2176) und danach wieder abschneiden
    pr, pu = -rgb.width % 32, -rgb.height % 32
    if pr or pu:
        rgb = core.std.AddBorders(rgb, right=pr, bottom=pu)
    neu, art = _interpolieren(rgb, m)
    if pr or pu:
        neu = core.std.Crop(neu, right=pr, bottom=pu)
    return neu, art


def _interpolieren(rgb, m):
    if CFG.get('test'):
        # Prüflauf ohne NVIDIA-Karte (CI): Bilder wiederholen statt RIFE – prüft Einbindung, Takt und Rückwandlung
        return core.std.Interleave([rgb] * m), 'test'
    if CFG['vs'] not in sys.path:
        sys.path.insert(0, CFG['vs'])
    import vsmlrt
    modell = getattr(vsmlrt.RIFEModel, CFG.get('modell', 'v4_6'), None)
    if modell is None:
        raise RuntimeError(f"Modell {CFG.get('modell')} kennt diese vs-mlrt-Version nicht")
    backend = aufruf(vsmlrt.Backend.TRT, fp16=True, num_streams=int(CFG.get('streams', 2)), engine_folder=CFG['engines'], output_format=1)
    kw = dict(multi=m, model=modell, backend=backend, scale=float(CFG.get('skala', 1.0)), ensemble=False)
    if CFG.get('v2'):
        kw['_implementation'] = 2
    return aufruf(vsmlrt.RIFE, rgb, **kw), f"RIFE {CFG.get('modell')}{' v2' if CFG.get('v2') else ''}"


def kette(clip, fps):
    m = max(1, int(CFG.get('faktor', 2)))
    num, den = bildrate(fps)
    clip = core.std.AssumeFPS(clip, fpsnum=num, fpsden=den)
    if fps > float(CFG.get('max_fps', 31)) or m == 1:
        status(aktiv=False, grund=f'Quelle hat {fps:.3f} fps – über der Grenze, ohne Zwischenbilder', quelle_fps=fps)
        return clip
    # Matrix nur für den Hin- und Rückweg (gleich in beide Richtungen, das Bild bleibt farbtreu); Bereich: begrenzt
    matrix = '2020ncl' if clip.width > 2000 or clip.height > 1200 else '709'
    rgb = core.resize.Bicubic(clip, format=vs.RGBH, matrix_in_s=matrix)
    t0 = time.time()
    neu, art = interpolieren(rgb, m)
    vorbereitet = time.time() - t0
    if neu.format.id != rgb.format.id:   # z. B. Ausgabe in 32 Bit → zurück auf das Format der echten Bilder (Szenenwechsel)
        neu = core.resize.Point(neu, format=rgb.format.id)
    # Szenenwechsel: an Schnitten statt eines verschmierten Zwischenbilds das echte Bild wiederholen
    szene = float(CFG.get('szene', 0.12))
    if szene > 0 and hasattr(core, 'misc'):
        klein = core.resize.Bilinear(clip, 480, 270, format=vs.YUV420P8)
        sc = core.std.Interleave([core.misc.SCDetect(klein, threshold=szene)] * m)
        dup = core.std.Interleave([rgb] * m)

        def waehlen(n, f, neu=neu, dup=dup):
            return dup if n % m and f.props.get('_SceneChangeNext', 0) else neu

        neu = core.std.FrameEval(neu, waehlen, prop_src=sc)
    neu = core.std.AssumeFPS(neu, fpsnum=num * m, fpsden=den)
    aus = core.resize.Bicubic(neu, format=clip.format.id, matrix_s=matrix)
    status(aktiv=True, art=art, faktor=m, quelle_fps=fps, ziel_fps=fps * m, breite=clip.width, hoehe=clip.height,
           format=clip.format.name, vorbereitet_s=round(vorbereitet, 1), szene=szene)
    return aus


try:
    if MODUS == 'vorbereiten':
        b, h = int(_arg('breite')), int(_arg('hoehe'))
        quelle = core.std.BlankClip(format=vs.YUV420P10, width=b, height=h, length=int(_arg('laenge', 24)), fpsnum=24000, fpsden=1001, color=[512, 512, 512])
        kette(quelle, 24000 / 1001).set_output()
    else:
        fps = float(globals().get('container_fps') or 0) or (video_in.fps.numerator / video_in.fps.denominator if video_in.fps.numerator else 24000 / 1001)  # noqa: F821
        kette(video_in, fps).set_output()  # noqa: F821
except Exception as e:
    status(aktiv=False, fehler=f'{type(e).__name__}: {e}', spur=traceback.format_exc()[-2000:])
    if MODUS == 'vorbereiten':
        raise
    video_in.set_output()  # noqa: F821
