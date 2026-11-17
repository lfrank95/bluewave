// Direct Stream über MediaSource: Der Server liefert fragmentiertes MP4 mit den echten Zeitstempeln der Datei.
// Dadurch gibt es eine durchgehende Zeitleiste über den ganzen Film: Spulen innerhalb des Geladenen ist sofort da,
// schon geladene Stücke bleiben erhalten (auch nach einem Sprung zurück), nur echte Sprünge ins Ungeladene holen
// einen neuen Strom – ohne extra Anfrage für die Startposition.
'use strict';

// Vorauspuffer: rund 100 MB (Browser halten pro Video etwa 150 MB, sonst werfen sie Geladenes weg), 20–90 s
const VORAUS_MB = 100;
const HINTER_S = 120;    // so viel hinter der Position behalten
const MS = window.ManagedMediaSource || window.MediaSource;
import { diag } from './diagnose.js';

export const mseVerfuegbar = () => !!MS;

// ---------- Codec-Kennung aus dem MP4-Kopf (moov) lesen ----------
function finde(b, typ, von = 0) {
    const t = [...typ].map((c) => c.charCodeAt(0));
    for (let i = von; i < b.length - 4; i++) {
        if (b[i] === t[0] && b[i + 1] === t[1] && b[i + 2] === t[2] && b[i + 3] === t[3]) return i;
    }
    return -1;
}
const hex = (n) => n.toString(16).padStart(2, '0');

function videoCodec(b) {
    let i = finde(b, 'avcC');
    if (i >= 0) return `avc1.${hex(b[i + 5])}${hex(b[i + 6])}${hex(b[i + 7])}`;
    i = finde(b, 'hvcC');
    if (i >= 0) {
        const p = b[i + 5];
        const raum = ['', 'A', 'B', 'C'][p >> 6];
        const tier = (p >> 5) & 1 ? 'H' : 'L';
        const profil = p & 0x1f;
        let kompat = ((b[i + 6] << 24) | (b[i + 7] << 16) | (b[i + 8] << 8) | b[i + 9]) >>> 0;
        let umgedreht = 0;
        for (let k = 0; k < 32; k++) { umgedreht = (umgedreht << 1) | (kompat & 1); kompat >>>= 1; }
        const stufe = b[i + 16];
        const zw = [];
        for (let k = 10; k < 16; k++) zw.push(b[i + k]);
        while (zw.length && zw[zw.length - 1] === 0) zw.pop();
        const typ = finde(b, 'hev1') >= 0 && finde(b, 'hvc1') < 0 ? 'hev1' : 'hvc1';
        return [typ, raum + profil, (umgedreht >>> 0).toString(16), tier + stufe, ...zw.map((x) => x.toString(16))].join('.');
    }
    i = finde(b, 'av1C');
    if (i >= 0) {
        const p = b[i + 5] >> 5;
        const stufe = b[i + 5] & 0x1f;
        const tier = b[i + 6] >> 7 ? 'H' : 'M';
        const tiefe = (b[i + 6] >> 6) & 1 ? ((b[i + 6] >> 5) & 1 ? 12 : 10) : 8;
        return `av01.${p}.${String(stufe).padStart(2, '0')}${tier}.${String(tiefe).padStart(2, '0')}`;
    }
    return null;
}

function tonCodec(b) {
    if (finde(b, 'ec-3') >= 0) return 'ec-3';
    if (finde(b, 'ac-3') >= 0) return 'ac-3';
    if (finde(b, 'Opus') >= 0) return 'opus';
    if (finde(b, 'fLaC') >= 0) return 'flac';
    const e = finde(b, 'esds');
    if (e >= 0) {
        // DecoderConfigDescriptor (Tag 4): Objekttyp; bei AAC (0x40) den Audio-Objekttyp aus DecoderSpecificInfo (Tag 5)
        let i = e + 8;
        const ende = Math.min(b.length, e + 200);
        const laenge = () => { let n = 0; for (let k = 0; k < 4; k++) { const x = b[i++]; n = (n << 7) | (x & 0x7f); if (!(x & 0x80)) break; } return n; };
        while (i < ende) {
            const tag = b[i++];
            const n = laenge();
            if (tag === 3) { i += 3; continue; }
            if (tag === 4) {
                const oti = b[i];
                if (oti !== 0x40) return 'mp4a.' + hex(oti).toUpperCase();
                i += 13;
                continue;
            }
            if (tag === 5) return 'mp4a.40.' + (b[i] >> 3);
            i += n;
        }
        return 'mp4a.40.2';
    }
    return null;
}

/** Ende des moov-Kastens (wenn vollständig da), sonst -1 */
function moovEnde(b) {
    let o = 0;
    while (o + 8 <= b.length) {
        const groesse = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
        const typ = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
        if (groesse < 8) return -1;
        if (typ === 'moov') return o + groesse <= b.length ? o + groesse : -1;
        o += groesse;
    }
    return -1;
}

function zusammen(a, b) {
    const n = new Uint8Array(a.length + b.length);
    n.set(a, 0);
    n.set(b, a.length);
    return n;
}

const warten = (ms) => new Promise((r) => setTimeout(r, ms));

export class MseStrom {
    /**
     * @param video   <video>
     * @param url     Basis-URL des Stroms (…/strom?ton=…&audio=…&kanaele=…)
     * @param dauer   Gesamtdauer in Sekunden
     * @param fehler  Rückruf, wenn MSE hier nicht geht (dann übernimmt der einfache Weg / Umwandlung)
     */
    constructor(video, url, dauer, fehler, bitrateK = 8000) {
        this.vorausS = Math.max(20, Math.min(90, Math.round((VORAUS_MB * 8000) / Math.max(1000, bitrateK))));
        this.video = video;
        this.url = url;
        this.dauer = dauer;
        this.fehler = fehler;
        this.nr = 0;
        this.token = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        this.sb = null;
        this.mime = null;
        this.weg = false;
        this.anVideo = () => this.pruefen();
        video.addEventListener('seeking', this.anVideo);
        video.addEventListener('timeupdate', this.anVideo);
    }

    async oeffnen() {
        this.ms = new MS();
        if (window.ManagedMediaSource) this.video.disableRemotePlayback = true;
        this.objektUrl = URL.createObjectURL(this.ms);
        this.video.src = this.objektUrl;
        await new Promise((r) => this.ms.addEventListener('sourceopen', r, { once: true }));
        try { this.ms.duration = this.dauer; } catch { /* manche Browser erst nach dem ersten Anhängen */ }
    }

    /** Ist t (Sekunden) schon geladen? */
    geladen(t, reserve = 0.3) {
        const b = this.video.buffered;
        for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t <= b.end(i) - reserve) return true;
        return false;
    }

    /** Ab t laden (neuer Strom), alter Strom wird abgebrochen */
    async laden(t) {
        const nr = ++this.nr;
        this.ziel = t;
        this.ac?.abort();
        const ac = (this.ac = new AbortController());
        if (this.sb) {
            try { this.sb.abort(); } catch { /* */ }
            await this.bereit();
        }
        if (nr !== this.nr || this.weg) return;
        const t0 = performance.now();
        diag('strom_anfrage', { nr, start: +t.toFixed(2) });
        let antwort;
        try {
            antwort = await fetch(`${this.url}&absolut=1&token=${this.token}&start=${Math.max(0, t).toFixed(3)}`, { signal: ac.signal, credentials: 'same-origin' });
        } catch (x) {
            if (x.name !== 'AbortError') this.fehler?.(x);
            return;
        }
        if (!antwort.ok || !antwort.body) { diag('strom_http_fehler', { status: antwort.status }); this.fehler?.(new Error('Strom ' + antwort.status)); return; }
        diag('strom_antwort', { nr, kopf_ms: Math.round(performance.now() - t0) });
        let empfangen = 0;
        let erstesByte = 0;
        let letzterBericht = performance.now();
        let wartenLesen = 0;
        const leser = antwort.body.getReader();
        let kopf = new Uint8Array(0);
        let gesammelt = [];
        let groesse = 0;
        try {
            for (;;) {
                // Vorrat voll? Strom beenden (ffmpeg hört auf) – pruefen() setzt später ab dem Pufferende fort.
                // So wird nie doppelt geladen, auch wenn der Strom in schon Geladenes hineinläuft.
                if (this.sb && this.voraus() > this.vorausS) {
                    diag('strom_vorrat_voll', { nr, voraus: +this.voraus().toFixed(1), mb: +(empfangen / 1048576).toFixed(1) });
                    this.fertig = nr; ac.abort(); return;
                }
                if (nr !== this.nr || this.weg) { ac.abort(); return; }
                const tl = performance.now();
                const { done, value } = await leser.read();
                wartenLesen += performance.now() - tl;
                if (nr !== this.nr || this.weg) return;
                if (done) { diag('strom_ende', { nr, mb: +(empfangen / 1048576).toFixed(1), ms: Math.round(performance.now() - t0) });
                    // Strom endet, bevor überhaupt ein Kopf da war → der Server konnte nicht umpacken (ffmpeg-Fehler)
                    if (!this.sb) { this.fehler?.(Object.assign(new Error('Server konnte die Datei nicht umpacken'), { leer: true })); return; }
                    break; }
                empfangen += value.length;
                if (!erstesByte) { erstesByte = performance.now(); diag('strom_erste_bytes', { nr, ms: Math.round(erstesByte - t0) }); }
                if (performance.now() - letzterBericht > 5000) {
                    const s = (performance.now() - letzterBericht) / 1000;
                    diag('strom_rate', { nr, mbit: +((empfangen * 8) / 1e6 / ((performance.now() - erstesByte) / 1000)).toFixed(1), mb: +(empfangen / 1048576).toFixed(1),
                        warten_auf_netz_anteil: +(wartenLesen / 1000 / s).toFixed(2), voraus: +this.voraus().toFixed(1) });
                    letzterBericht = performance.now();
                    wartenLesen = 0;
                }
                if (!this.sb) {
                    kopf = zusammen(kopf, value);
                    if (moovEnde(kopf) < 0) continue;
                    if (!this.sbAnlegen(kopf)) { ac.abort(); return; }
                    diag('mse_bereit', { nr, mime: this.mime, kopf_kb: Math.round(kopf.length / 1024), ms: Math.round(performance.now() - t0) });
                    await this.anhaengen(kopf, nr, kopf.length > moovEnde(kopf) + 100); // nur Kopf = noch kein Bild
                    continue;
                }
                // kleine Stücke bündeln: jedes appendBuffer kostet eine Runde – vorher wurde beim Start jedes
                // Netzwerkstückchen (oft nur 8–64 KB) einzeln angehängt, das bremste den Start bei hohen Bitraten massiv
                gesammelt.push(value);
                groesse += value.length;
                const start = this.video.readyState < 3;
                if (groesse >= (start ? 256 * 1024 : 2 * 1024 * 1024) || performance.now() - (this.letztesAnhaengen || 0) > (start ? 120 : 600)) {
                    this.letztesAnhaengen = performance.now();
                    const alles = new Uint8Array(groesse);
                    let o = 0;
                    for (const g of gesammelt) { alles.set(g, o); o += g.length; }
                    gesammelt = [];
                    groesse = 0;
                    await this.anhaengen(alles, nr);
                }
            }
            this.fertig = nr;
            if (groesse) {
                const alles = new Uint8Array(groesse);
                let o = 0;
                for (const g of gesammelt) { alles.set(g, o); o += g.length; }
                await this.anhaengen(alles, nr);
            }
            // Ende der Datei erreicht?
            await this.bereit();
            const b = this.video.buffered;
            if (nr === this.nr && b.length && b.end(b.length - 1) >= this.dauer - 1 && this.ms.readyState === 'open') {
                try { this.ms.endOfStream(); } catch { /* */ }
            }
        } catch (x) {
            if (x.name !== 'AbortError' && nr === this.nr) { diag('strom_fehler', { nr, text: x.message }); this.fehler?.(x); }
        }
    }

    sbAnlegen(kopf) {
        const v = videoCodec(kopf);
        const a = tonCodec(kopf);
        const mime = `video/mp4; codecs="${[v, a].filter(Boolean).join(',')}"`;
        if (!v || !MS.isTypeSupported(mime)) {
            this.fehler?.(new Error('MSE kann ' + mime + ' nicht'));
            return false;
        }
        this.mime = mime;
        this.sb = this.ms.addSourceBuffer(mime);
        this.sb.mode = 'segments';
        try { if (!this.ms.duration || isNaN(this.ms.duration)) this.ms.duration = this.dauer; } catch { /* */ }
        return true;
    }

    bereit() {
        const sb = this.sb;
        if (!sb || !sb.updating) return Promise.resolve();
        return new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    }

    async anhaengen(daten, nr, mitBild = true) {
        for (let versuch = 0; versuch < 3; versuch++) {
            await this.bereit();
            if (nr !== this.nr || this.weg) return;
            try {
                if (this.ms.readyState === 'ended') { /* nach endOfStream wieder öffnen */ }
                this.sb.appendBuffer(daten);
                await this.bereit();
                if (mitBild && this.datenNr !== nr) diag('mse_erstes_bild_angehaengt', { nr, kb: Math.round(daten.length / 1024) });
                if (mitBild) this.datenNr = nr;
                this.pruefen();
                return;
            } catch (x) {
                if (x.name === 'QuotaExceededError') {
                    diag('mse_speicher_voll', {});
                    await this.aufraeumen(20);
                    await warten(300);
                    continue;
                }
                throw x;
            }
        }
    }

    /** Puffer hinter der Wiedergabe freigeben */
    async aufraeumen(behalten = HINTER_S) {
        const t = this.video.currentTime;
        if (!this.sb || t - behalten <= 1) return;
        await this.bereit();
        try {
            this.sb.remove(0, t - behalten);
            await this.bereit();
        } catch { /* */ }
    }

    voraus() {
        const t = this.video.currentTime;
        const b = this.video.buffered;
        for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.5 && t <= b.end(i)) return b.end(i) - t;
        return 0;
    }

    /** Bei Sprung/Wiedergabe: fehlt die Stelle, neu laden; liegt der Start knapp dahinter, dorthin rücken */
    pruefen() {
        if (this.weg || !this.sb) return;
        const v = this.video;
        const t = v.currentTime;
        if (this.geladen(t, 0)) {
            const bis = this.nachGeladen(t);
            if (this.voraus() < this.vorausS / 2 && !this.laeuft() && bis < this.dauer - 1) this.laden(bis);
            return;
        }
        // Ton beginnt oft ein paar Zehntel nach dem Schlüsselbild → auf den Anfang des Geladenen rücken
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) {
            if (this.datenNr === this.nr && b.start(i) > t && b.start(i) - t < 6 && this.ziel !== undefined && Math.abs(this.ziel - t) < 1) {
                v.currentTime = b.start(i) + 0.02;
                return;
            }
        }
        if (v.seeking && !(this.ziel !== undefined && Math.abs(this.ziel - t) < 0.5)) this.laden(t);
    }

    laeuft() { return this.ac && !this.ac.signal.aborted && this.nr > 0 && this.fertig !== this.nr; }

    nachGeladen(t) {
        const b = this.video.buffered;
        for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t <= b.end(i)) return b.end(i);
        return t;
    }

    /** Springen auf t: im Geladenen direkt, sonst neuer Strom ab t */
    gehe(t) {
        t = Math.max(0, Math.min(this.dauer - 0.5, t));
        if (!this.geladen(t)) {
            this.ziel = t;
            this.laden(t);
        } else if (this.laeuft() && !this.geladen(this.nachGeladen(t) + 1, 0)) {
            // Sprung in schon Geladenes: der laufende Strom füllt evtl. eine ganz andere Stelle → beenden,
            // pruefen() setzt bei Bedarf ab dem Ende dieses Stücks fort
            this.nr++;
            this.ac?.abort();
            this.fertig = this.nr;
        }
        this.video.currentTime = t;
    }

    beenden() {
        this.weg = true;
        this.nr++;
        this.ac?.abort();
        this.video.removeEventListener('seeking', this.anVideo);
        this.video.removeEventListener('timeupdate', this.anVideo);
        if (this.objektUrl) URL.revokeObjectURL(this.objektUrl);
    }
}
