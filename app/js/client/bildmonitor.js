// Windows-Client: Überwachung der flüssigen Bewegung (Taste B im Player). Zeigt, was mpv liefert (Bildrate der Quelle,
// Bildwiederholrate, Aussetzer, Renderer, HDR), die Grafikkarte (nvidia-smi) und den Stand von NVIDIA Smooth Motion.
// Smooth Motion selbst sitzt im Treiber hinter mpv: mpv sieht die erzeugten Zwischenbilder nicht. Nachweisen lässt es
// sich über die Testbalken des Treibers (farbige Balken am Rand) oder dessen Log (C:\NvPresent\).
'use strict';
import { el } from '../ui.js';

/** Passt die Ziel-Bildrate zur Bildwiederholrate? (gleichmäßig = ganzzahliges Verhältnis, sonst Ruckeln/verworfene Bilder) */
export function bewertung(quelleFps, hz, faktor) {
    if (!(quelleFps > 0) || !(hz > 0)) return { ziel: null, stufe: 'unbekannt', text: 'Noch keine Werte' };
    const ziel = quelleFps * (faktor === true ? 2 : Number(faktor) || 1);
    const v = hz / ziel;
    if (v < 0.985) return { ziel, stufe: 'schlecht', text: `${hz.toFixed(0)} Hz reichen nicht für ${ziel.toFixed(2)} fps – Bilder fallen weg` };
    const n = Math.round(v);
    if (Math.abs(v - n) / v < 0.006) return { ziel, stufe: 'gut', text: n === 1 ? 'Passt genau (1 : 1)' : `Passt gleichmäßig (jedes Bild ${n}×)` };
    return { ziel, stufe: 'mittel', text: `Ungleichmäßig (${v.toFixed(2).replace('.', ',')} : 1) – leichtes Ruckeln, außer mit VRR (G-Sync/FreeSync)` };
}

const zahl = (x, n = 2) => (x == null || Number.isNaN(Number(x)) ? '–' : Number(x).toFixed(n).replace('.', ','));
const GAMMA = { pq: 'HDR10 (PQ)', hlg: 'HLG', 'bt.1886': 'SDR', srgb: 'SDR (sRGB)' };

/** Panel öffnen; gibt eine Funktion zum Schließen zurück */
export function bildmonitor(wurzel, brücke) {
    const box = el('div.bildmonitor', { onclick: (e) => e.stopPropagation() });
    wurzel.append(box);
    let zu = false;
    let altVerworfen = null;
    const zeile = (titel, wert, stufe) => el('div.bm-zeile', el('span', titel), el('b' + (stufe ? `.bm-${stufe}` : ''), wert));
    const block = (titel, ...z) => el('section.bm-block', el('h4', titel), ...z.flat().filter(Boolean));

    const zeigen = async () => {
        let s = null;
        try { s = await brücke.monitor(); } catch { /* weg */ }
        if (zu) return;
        if (!s) { box.replaceChildren(el('h3', 'Bildmonitor'), el('p.leise', 'Keine Daten vom Client.')); return; }
        const m = s.mpv || {};
        const e = s.einst || {};
        const smooth = e.bewegung === 'smooth';
        const nv = s.nv || {};
        const g = s.gpu;
        const rifeWahl = e.bewegung === 'rife';
        const rz = s.rife?.zustand;
        const rifeAktiv = rifeWahl && m.rife && rz?.aktiv;
        const b = bewertung(m.quelle_fps, m.anzeige_hz, rifeAktiv ? rz.faktor : (smooth && nv.an ? 2 : 1));
        let rifeBlock = null;
        if (rifeWahl) {
            const soll = rifeAktiv ? m.quelle_fps * rz.faktor : null;
            const ist = m.filter_fps;
            const haelt = soll && ist ? ist / soll : null;
            rifeBlock = block('RIFE',
                zeile('Stand', !s.rife?.bereit ? 'Nicht eingerichtet – Profil › Flüssige Bewegung'
                    : m.rife_grund && !m.rife ? `Abgeschaltet: ${m.rife_grund}`
                    : !m.rife ? 'Aus – startet mit dem nächsten Film'
                    : rifeAktiv ? `${rz.art} · ${rz.faktor}×`
                    : rz?.phase === 'baut' ? `TensorRT baut die Engine für ${rz.breite}×${rz.hoehe} (einmalig, einige Minuten)`
                    : m.rife_grund || rz?.grund || 'Startet …',
                    (m.rife_grund && !m.rife) || rz?.fehler ? 'schlecht' : rifeAktiv ? 'gut' : 'mittel'),
                rifeAktiv ? zeile('Ausgabe', `${zahl(ist, 2)} von ${zahl(soll, 2)} fps`, haelt == null ? null : haelt > 0.97 ? 'gut' : haelt > 0.85 ? 'mittel' : 'schlecht') : null,
                rifeAktiv && haelt != null ? zeile('Hält mit', haelt > 0.97 ? 'Ja' : `Nein – ${Math.round(haelt * 100)} % (Faktor, Modell oder halbe Auflösung probieren)`, haelt > 0.97 ? 'gut' : 'schlecht') : null,
                rz?.fehler ? el('pre.bm-log', rz.fehler) : null,
                rifeAktiv && rz.vorbereitet_s > 20 ? el('p.bm-hinweis', `Die Engine wurde beim Start gebaut (${Math.round(rz.vorbereitet_s)} s) – mit „Vorbereiten“ geht das künftig sofort.`) : null);
        }
        const neuVerworfen = altVerworfen == null ? 0 : Math.max(0, (m.verworfen || 0) - altVerworfen);
        altVerworfen = m.verworfen || 0;

        let smText; let smStufe;
        if (!smooth) { smText = 'Aus (in den Einstellungen)'; smStufe = null; }
        else if (nv.nvidia === false) { smText = 'Keine NVIDIA-Grafikkarte erkannt'; smStufe = 'schlecht'; }
        else if (!nv.an) { smText = 'Nicht im Treiber eingetragen'; smStufe = 'schlecht'; }
        else if (m.weg && e.renderer === 'vulkan' && !/RTX 50/i.test(g?.name || '')) { smText = 'Eingetragen – Vulkan erst ab RTX 50'; smStufe = 'mittel'; }
        else { smText = 'Im Treiber aktiv · 2× (fest)'; smStufe = 'gut'; }

        box.replaceChildren(
            el('div.bm-kopf', el('h3', 'Bildmonitor'), el('span.leise', 'Taste B')),
            block('Bewegung',
                zeile('Quelle', `${zahl(m.quelle_fps, 3)} fps`),
                rifeWahl ? null : zeile('Smooth Motion', smText, smStufe),
                zeile('Ziel', b.ziel ? `${zahl(b.ziel, 2)} fps` : '–'),
                zeile('Bildschirm', m.anzeige_hz ? `${zahl(m.anzeige_hz, 2)} Hz` : '–'),
                zeile('Takt', b.text, b.stufe === 'unbekannt' ? null : b.stufe),
                zeile('mpv-Takt', `${m.sync || '–'}${m.interpolation ? ' + Interpolation' : ''}${e.vsync === false ? ' · VSync aus' : ''}`)),
            rifeBlock,
            block('Aussetzer',
                zeile('Verworfen', `${m.verworfen ?? 0}${neuVerworfen ? ` (+${neuVerworfen})` : ''}`, neuVerworfen ? 'schlecht' : null),
                zeile('Verspätet', String(m.verspaetet ?? 0), m.verspaetet ? 'mittel' : null),
                zeile('Decoder', String(m.dec_verworfen ?? 0), m.dec_verworfen ? 'mittel' : null),
                m.weg === 'engine' && m.engine_diff != null ? zeile('Ton ↔ Bild', `${zahl(m.engine_diff * 1000, 0)} ms`, Math.abs(m.engine_diff) > 0.08 ? 'mittel' : null) : null),
            block('Bild',
                zeile('Auflösung', m.breite ? `${m.breite}×${m.hoehe}` : '–'),
                zeile('Format', `${GAMMA[m.gamma] || m.gamma || '–'}${m.primaer ? ` · ${m.primaer}` : ''}${m.spitze ? ` · Spitze ${zahl(m.spitze * 203, 0)} nits` : ''}`),
                zeile('Dekodieren', m.hwdec && m.hwdec !== 'no' ? `Grafikkarte (${m.hwdec})` : 'Prozessor'),
                zeile('Renderer', `gpu-next · ${m.gpu || e.renderer || '–'}`)),
            g ? block('Grafikkarte',
                zeile('Modell', `${g.name} · Treiber ${g.treiber}`),
                zeile('Last', `${g.last} % · ${g.takt} MHz`, g.last > 90 ? 'mittel' : null),
                zeile('Leistung', `${zahl(g.watt, 0)} W · ${g.grad} °C`),
                zeile('Speicher', `${(g.vram / 1024).toFixed(1).replace('.', ',')} / ${(g.vram_gesamt / 1024).toFixed(0)} GB`)) : block('Grafikkarte', el('p.leise', 'nvidia-smi nicht verfügbar')),
            smooth ? el('p.bm-hinweis', e.sm_balken
                ? 'Testbalken sind an: Siehst du farbige Balken am Bildrand, erzeugt der Treiber Zwischenbilder.'
                : 'mpv sieht die Zwischenbilder des Treibers nicht. Zum Nachweis „Testbalken“ in den Einstellungen einschalten.') : null,
            s.log?.length ? block('Treiber-Log (NvPresent)', el('pre.bm-log', s.log.join('\n'))) : null,
        );
    };
    zeigen();
    const t = setInterval(zeigen, 1000);
    return () => { zu = true; clearInterval(t); box.remove(); };
}
