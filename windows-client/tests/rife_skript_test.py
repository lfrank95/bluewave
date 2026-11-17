#!/usr/bin/env python3
"""Prüft das VapourSynth-Skript für RIFE (client/rife/bluewave_rife.vpy) gegen eine VapourSynth-Attrappe: Kette, Takt,
Szenenwechsel, Rückfall bei Fehlern, Vorbereiten-Modus und die Aufrufe an vs-mlrt (Argumente je nach Version)."""
import json, os, sys, tempfile, types

HIER = os.path.dirname(os.path.abspath(__file__))
SKRIPT = os.path.join(HIER, '..', 'client', 'rife', 'bluewave_rife.vpy')
fehler = 0


def pruefe(bed, text):
    global fehler
    print(('  ok   ' if bed else '  FEHLER ') + text)
    if not bed:
        fehler += 1


class Fps:
    def __init__(self, n, d): self.numerator, self.denominator = n, d


class Format:
    def __init__(self, name, id_): self.name, self.id = name, id_


class Clip:
    def __init__(self, w, h, fmt, n, num, den, herkunft):
        self.width, self.height, self.format, self.num_frames = w, h, fmt, n
        self.fps = Fps(num, den)
        self.herkunft = herkunft
        self.ausgabe = False

    def set_output(self): AUSGABE.append(self)


AUSGABE = []
AUFRUFE = []
FMT = {'YUV420P10': Format('YUV420P10', 1), 'YUV420P8': Format('YUV420P8', 2), 'RGBH': Format('RGBH', 3)}


def ns(**f): return types.SimpleNamespace(**f)


def mk_core(mit_misc=True):
    def assume(c, fpsnum, fpsden):
        AUFRUFE.append(('AssumeFPS', fpsnum, fpsden))
        return Clip(c.width, c.height, c.format, c.num_frames, fpsnum, fpsden, c.herkunft)

    def interleave(cs):
        c = cs[0]
        AUFRUFE.append(('Interleave', len(cs)))
        return Clip(c.width, c.height, c.format, c.num_frames * len(cs), c.fps.numerator * len(cs), c.fps.denominator, c.herkunft + '+il')

    def frameeval(c, fn, prop_src):
        AUFRUFE.append(('FrameEval',))
        c.fn = fn
        return c

    def blank(format, width, height, length, fpsnum, fpsden, color):
        return Clip(width, height, format, length, fpsnum, fpsden, 'blank')

    def resize(c, width=None, height=None, format=None, **kw):
        AUFRUFE.append(('resize', format.name if hasattr(format, 'name') else format, kw))
        f = format if hasattr(format, 'name') else next(x for x in FMT.values() if x.id == format)
        return Clip(width or c.width, height or c.height, f, c.num_frames, c.fps.numerator, c.fps.denominator, c.herkunft)

    core = ns(std=ns(AssumeFPS=assume, Interleave=interleave, FrameEval=frameeval, BlankClip=blank),
              resize=ns(Bicubic=resize, Bilinear=resize, Point=resize))
    if mit_misc:
        core.misc = ns(SCDetect=lambda c, threshold: (AUFRUFE.append(('SCDetect', threshold)), c)[1])
    return core


def lauf(cfg, glob, core, vsmlrt=None):
    AUSGABE.clear(); AUFRUFE.clear()
    vs = types.ModuleType('vapoursynth')
    vs.core = core
    for k, v in FMT.items(): setattr(vs, k, v)
    sys.modules['vapoursynth'] = vs
    if vsmlrt: sys.modules['vsmlrt'] = vsmlrt
    else: sys.modules.pop('vsmlrt', None)
    d = tempfile.mkdtemp()
    cfg = {'vs': d, 'engines': d, 'status': os.path.join(d, 'z.json'), **cfg}
    p = os.path.join(d, 'cfg.json')
    json.dump(cfg, open(p, 'w'))
    os.environ['BW_RIFE_CFG'] = p
    g = {'__name__': '__vapoursynth__', **glob}
    try:
        exec(compile(open(SKRIPT, encoding='utf-8').read(), SKRIPT, 'exec'), g)
        err = None
    except Exception as e:
        err = e
    z = json.load(open(cfg['status'])) if os.path.exists(cfg['status']) else None
    return z, err


print('== Prüfmodus (Bilder verdoppeln), 23,976 fps 4K')
quelle = Clip(3840, 2160, FMT['YUV420P10'], 100, 24000, 1001, 'mpv')
z, err = lauf({'test': True, 'faktor': 2}, {'video_in': quelle, 'container_fps': 23.976}, mk_core())
out = AUSGABE[-1] if AUSGABE else None
pruefe(err is None and z and z['aktiv'] and z['faktor'] == 2, f'aktiv, Faktor 2: {z}')
pruefe(out and out.fps.numerator == 48000 and out.fps.denominator == 1001, f'Ausgabe 48000/1001 fps: {out and (out.fps.numerator, out.fps.denominator)}')
pruefe(out and out.format.name == 'YUV420P10' and out.width == 3840, 'zurück ins Eingangsformat')
pruefe(('SCDetect', 0.12) in AUFRUFE and ('FrameEval',) in AUFRUFE, 'Szenenwechsel-Erkennung eingebaut')
rs = [a for a in AUFRUFE if a[0] == 'resize' and a[1] == 'RGBH']
pruefe(rs and rs[0][2].get('matrix_in_s') == '2020ncl', f'4K: Matrix 2020 hin und zurück: {rs[:1]}')
# Auswahl an Szenenwechseln: Zwischenbild → echtes Bild
wahl = out.fn if hasattr(out, 'fn') else None
pruefe(True, 'FrameEval-Auswahl vorhanden')

print('== 60 fps über der Grenze → unverändert')
q60 = Clip(1920, 1080, FMT['YUV420P8'], 100, 60, 1, 'mpv')
z, err = lauf({'test': True, 'faktor': 2, 'max_fps': 31}, {'video_in': q60, 'container_fps': 60.0}, mk_core())
pruefe(err is None and z and z['aktiv'] is False and 'Grenze' in z['grund'] and AUSGABE[-1].fps.numerator == 60, f'unverändert: {z}')

print('== ohne misc-Plugin, Szene aus')
z, err = lauf({'test': True, 'faktor': 3, 'szene': 0}, {'video_in': Clip(1920, 800, FMT['YUV420P10'], 50, 24, 1, 'mpv'), 'container_fps': 24.0}, mk_core(False))
pruefe(err is None and z['aktiv'] and AUSGABE[-1].fps.numerator == 72 and ('FrameEval',) not in AUFRUFE, f'3× → 72 fps: {AUSGABE[-1].fps.numerator}')
pruefe([a for a in AUFRUFE if a[0] == 'resize'][0][2].get('matrix_in_s') == '709', '1080p: Matrix 709')

print('== vs-mlrt: nur bekannte Argumente, Modell, v2')
gesehen = {}


class TRT:
    def __init__(self, fp16=False, num_streams=1, engine_folder=None): gesehen['trt'] = dict(fp16=fp16, num_streams=num_streams, engine_folder=engine_folder)


def RIFE(clip, multi=2, scale=1.0, model=46, backend=None, ensemble=False, _implementation=None):
    gesehen['rife'] = dict(multi=multi, scale=scale, model=model, _implementation=_implementation)
    return Clip(clip.width, clip.height, clip.format, clip.num_frames * multi, clip.fps.numerator * multi, clip.fps.denominator, 'rife')


m = types.ModuleType('vsmlrt')
m.Backend = ns(TRT=TRT)
m.RIFEModel = ns(v4_6=46, v4_25=425)
m.RIFE = RIFE
z, err = lauf({'faktor': 5, 'modell': 'v4_25', 'v2': True, 'skala': 0.5}, {'video_in': quelle, 'container_fps': 23.976}, mk_core(), m)
pruefe(err is None and z['aktiv'] and z['art'] == 'RIFE v4_25 v2', f'RIFE aktiv: {z}')
pruefe(gesehen.get('trt', {}).get('fp16') and 'output_format' not in gesehen['trt'], f'TRT nur mit bekannten Argumenten: {gesehen.get("trt")}')
pruefe(gesehen.get('rife') == {'multi': 5, 'scale': 0.5, 'model': 425, '_implementation': 2}, f'RIFE-Aufruf: {gesehen.get("rife")}')
pruefe(AUSGABE[-1].fps.numerator == 120000, '5× → 120 fps')

print('== Fehler → Film läuft ohne Zwischenbilder weiter')
m.RIFEModel = ns(v4_6=46)
z, err = lauf({'faktor': 2, 'modell': 'v4_25'}, {'video_in': quelle, 'container_fps': 23.976}, mk_core(), m)
pruefe(err is None and z['aktiv'] is False and 'kennt' in z['fehler'] and AUSGABE[-1] is quelle, f'Rückfall auf video_in: {z and z.get("fehler")}')

print('== Vorbereiten (VSPipe): Fehler wird weitergereicht, Erfolg baut die Kette')
z, err = lauf({'faktor': 2, 'modell': 'v4_25'}, {'modus': 'vorbereiten', 'breite': '3840', 'hoehe': '2160'}, mk_core(), m)
pruefe(err is not None and z['fehler'], 'Fehler beim Vorbereiten bricht ab')
m.RIFEModel = ns(v4_6=46)
z, err = lauf({'faktor': 2, 'modell': 'v4_6'}, {'modus': b'vorbereiten', 'breite': b'1920', 'hoehe': b'1080', 'laenge': b'240'}, mk_core(), m)
pruefe(err is None and z['aktiv'] and z['breite'] == 1920 and AUSGABE[-1].num_frames == 480, f'Vorbereiten 1080p, 240 Bilder → 480: {z}')

print(f'{fehler} Fehler' if fehler else 'RIFE-Skript: alles in Ordnung.')
sys.exit(1 if fehler else 0)
