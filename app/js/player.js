// Player: Direct Play oder HLS (nativ bzw. hls.js), Ton- und Untertitelwahl, Intro überspringen, nächste Folge,
// Nachtmodus/Dialog-Anhebung (nur wenn eingeschaltet – sonst bleibt der Ton unangetastet), Fortschritt, Marker setzen (Admin)
'use strict';
import { el, icon, zeit, meldung } from './ui.js';
import { api } from './api.js';

let aktiv = null;

function faehigkeiten() {
    const v = document.createElement('video');
    const a = document.createElement('audio');
    const kann = (t) => v.canPlayType(t) !== '' || (window.MediaSource && MediaSource.isTypeSupported?.(t));
    const video = {
        h264: kann('video/mp4; codecs="avc1.640028"'),
        hevc: kann('video/mp4; codecs="hvc1.1.6.L120.90"') || kann('video/mp4; codecs="hev1.1.6.L120.90"'),
        av1: kann('video/mp4; codecs="av01.0.08M.08"'),
        vp9: kann('video/webm; codecs="vp9"'),
    };
    const audio = {
        aac: kann('audio/mp4; codecs="mp4a.40.2"'), mp3: a.canPlayType('audio/mpeg') !== '', opus: kann('audio/webm; codecs="opus"'),
        flac: a.canPlayType('audio/flac') !== '', ac3: kann('audio/mp4; codecs="ac-3"'), eac3: kann('audio/mp4; codecs="ec-3"'),
    };
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    return {
        video, audio,
        // MKV spielen Browser nur unzuverlässig – dann wandelt der Server um
        container: { mp4: true, webm: v.canPlayType('video/webm') !== '', mkv: false },
        hdr: window.matchMedia('(dynamic-range: high)').matches && video.hevc,
        hls: v.canPlayType('application/vnd.apple.mpegurl') ? 'nativ' : (window.MediaSource ? 'mse' : false),
        max_hoehe: Math.round(Math.max(screen.width, screen.height) * dpr * 9 / 16),
    };
}

let hlsLaden = null;
function hlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    hlsLaden ??= new Promise((ok, nein) => {
        const s = document.createElement('script');
        s.src = '/js/vendor/hls.min.js';
        s.onload = () => (window.Hls ? ok(window.Hls) : nein(new Error('hls.js fehlt')));
        s.onerror = () => nein(new Error('hls.js konnte nicht geladen werden'));
        document.head.append(s);
    });
    return hlsLaden;
}

/** Öffentlicher Einstieg: ziel = {art, id, fassung_id?, start_ms?} */
export async function spielen(ziel, app) {
    if (aktiv) await aktiv.schliessen(false);
    aktiv = new Player(ziel, app);
    await aktiv.starten();
}

class Player {
    constructor(ziel, app) {
        this.ziel = ziel;
        this.app = app;
        this.e = app.konto.einstellungen || {};
        this.admin = app.konto.rolle === 'admin';
        this.hls = null;
        this.daten = null;
        this.introUebersprungen = false;
        this.naechsteGezeigt = false;
        this.countdownTimer = null;
        this.fortschrittTimer = null;
        this.leerlaufTimer = null;
        this.audio = null; // WebAudio-Kette, nur wenn Nachtmodus/Dialog an
        this.nacht = this.e.nachtmodus || 'aus';
        this.dialogDb = Number(this.e.dialog_db || 0);
        this.markerEntwurf = {};
        this.aufbauen();
    }

    aufbauen() {
        this.video = el('video', { playsinline: true, preload: 'auto' });
        this.kreisel = el('div.kreisel');
        this.mitte = el('div.mitte-status', this.kreisel);
        this.titelEl = el('div.titel');
        this.zeitEl = el('span.zeit', '0:00 / 0:00');
        this.gespielt = el('div.gespielt');
        this.geladen = el('div.geladen');
        this.knauf = el('div.knauf');
        this.markierungen = el('div');
        this.vorschau = el('div.vorschau-zeit', { hidden: true });
        this.spur = el('div.spur', this.geladen, this.markierungen, this.gespielt, this.knauf);
        this.leiste = el('div.zeitleiste', this.spur, this.vorschau);
        this.playKnopf = el('button.p-knopf.gross', { 'aria-label': 'Abspielen/Pause', onclick: () => this.umschalten() }, icon('play'));
        this.vollKnopf = el('button.p-knopf', { 'aria-label': 'Vollbild', onclick: () => this.vollbild() }, icon('vollbild'));
        this.panelEl = el('div.panel.glass-panel', { hidden: true });
        this.ueberspringenEl = el('button.knopf.weiss.ueberspringen', { hidden: true, onclick: () => this.introUeberspringen() }, 'Intro überspringen', icon('naechste'));
        this.naechsteEl = el('div.naechste-karte.glass-panel', { hidden: true });
        this.ebene = el('div.ebene',
            el('div.oben', el('button.p-knopf', { 'aria-label': 'Schließen', onclick: () => this.schliessen() }, icon('zurueck')), this.titelEl),
            el('div.unten', this.leiste,
                el('div.steuerung',
                    this.playKnopf,
                    el('button.p-knopf', { 'aria-label': '10 Sekunden zurück', onclick: () => this.springen(-10) }, icon('zurueck10')),
                    el('button.p-knopf', { 'aria-label': '10 Sekunden vor', onclick: () => this.springen(10) }, icon('vor10')),
                    this.zeitEl,
                    el('div.rechts',
                        el('button.p-knopf', { 'aria-label': 'Ton und Untertitel', onclick: () => this.panel('spuren') }, icon('untertitel')),
                        el('button.p-knopf', { 'aria-label': 'Einstellungen', onclick: () => this.panel('einstellungen') }, icon('einstellungen')),
                        this.vollKnopf))));
        this.wurzel = el('div.player', this.video, this.mitte, this.ebene, this.ueberspringenEl, this.naechsteEl, this.panelEl);
        document.body.append(this.wurzel);
        document.body.style.overflow = 'hidden';

        const v = this.video;
        v.addEventListener('play', () => this.playKnopf.replaceChildren(icon('pause')));
        v.addEventListener('pause', () => { this.playKnopf.replaceChildren(icon('play')); this.fortschrittSenden(); this.wach(); });
        v.addEventListener('waiting', () => { this.mitte.hidden = false; });
        v.addEventListener('playing', () => { this.mitte.hidden = true; });
        v.addEventListener('canplay', () => { this.mitte.hidden = true; });
        v.addEventListener('timeupdate', () => this.zeitAktualisieren());
        v.addEventListener('progress', () => this.zeitAktualisieren());
        v.addEventListener('ended', () => this.ende());
        v.addEventListener('error', () => { if (!this.hls) this.fehler('Die Datei lässt sich hier nicht abspielen.' + (this.daten?.modus === 'direkt' ? ' Versuche es mit Umwandlung …' : ''), this.daten?.modus === 'direkt'); });

        // Zeitleiste: klicken und ziehen
        const position = (ev) => {
            const r = this.spur.getBoundingClientRect();
            return Math.min(1, Math.max(0, ((ev.touches?.[0]?.clientX ?? ev.clientX) - r.left) / r.width));
        };
        let ziehen = false;
        this.leiste.addEventListener('pointerdown', (ev) => { ziehen = true; this.leiste.setPointerCapture(ev.pointerId); this.zeigeZiel(position(ev)); });
        this.leiste.addEventListener('pointermove', (ev) => {
            const p = position(ev);
            this.vorschau.hidden = false;
            this.vorschau.style.left = p * 100 + '%';
            this.vorschau.textContent = zeit(p * this.dauer());
            if (ziehen) this.zeigeZiel(p);
        });
        this.leiste.addEventListener('pointerleave', () => { this.vorschau.hidden = true; });
        this.leiste.addEventListener('pointerup', (ev) => {
            if (!ziehen) return;
            ziehen = false;
            this.video.currentTime = position(ev) * this.dauer();
        });

        this.taste = (ev) => {
            if (ev.target.closest('input, select, textarea')) return;
            const k = ev.key;
            if (k === ' ' || k === 'k') { ev.preventDefault(); this.umschalten(); } else if (k === 'ArrowLeft') this.springen(-10);
            else if (k === 'ArrowRight') this.springen(10);
            else if (k === 'f') this.vollbild();
            else if (k === 'Escape') { if (!this.panelEl.hidden) this.panelEl.hidden = true; else if (!document.fullscreenElement) this.schliessen(); }
            else return;
            this.wach();
        };
        document.addEventListener('keydown', this.taste);
        this.wurzel.addEventListener('pointermove', () => this.wach());
        this.wurzel.addEventListener('click', (ev) => {
            if (ev.target === this.video || ev.target === this.ebene) {
                if (!this.panelEl.hidden) { this.panelEl.hidden = true; return; }
                if (matchMedia('(pointer: coarse)').matches) this.wach(); else this.umschalten();
            }
        });
        this.video.addEventListener('dblclick', () => this.vollbild());
        document.addEventListener('fullscreenchange', this.vollAenderung = () => this.vollKnopf.replaceChildren(icon(document.fullscreenElement ? 'vollbildAus' : 'vollbild')));
        this.wach();
    }

    dauer() {
        return (this.daten?.dauer_ms || 0) / 1000 || this.video.duration || 0;
    }

    async starten(extra = {}) {
        this.mitte.hidden = false;
        this.mitte.style.pointerEvents = '';
        this.mitte.replaceChildren(this.kreisel);
        try {
            const d = await api('wiedergabe/start', 'POST', { ...this.ziel, ...extra, faehigkeiten: faehigkeiten(), sitzung_alt: this.daten?.sitzung || '' });
            this.daten = d;
        } catch (x) {
            this.fehler(x.message);
            return;
        }
        const d = this.daten;
        this.titelEl.replaceChildren(el('b', d.info.titel), d.info.untertitel ? el('span', String(d.info.untertitel)) : null);
        this.markerZeichnen();
        this.introUebersprungen = false;
        this.naechsteGezeigt = false;
        this.naechsteEl.hidden = true;
        await this.quelleSetzen(d.start_ms / 1000);
        clearInterval(this.fortschrittTimer);
        this.fortschrittTimer = setInterval(() => { if (!this.video.paused) this.fortschrittSenden(); }, 10000);
        if (this.nacht !== 'aus' || this.dialogDb > 0) this.tonKette();
    }

    async quelleSetzen(start) {
        const d = this.daten;
        const v = this.video;
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        v.querySelectorAll('track').forEach((t) => t.remove());
        if (d.modus === 'hls' && v.canPlayType('application/vnd.apple.mpegurl')) {
            v.src = d.url;
            v.addEventListener('loadedmetadata', () => { if (start > 0) v.currentTime = start; }, { once: true });
        } else if (d.modus === 'hls') {
            let Hls;
            try { Hls = await hlsJs(); } catch (x) { this.fehler(x.message); return; }
            this.hls = new Hls({ startPosition: start, maxBufferLength: 60, backBufferLength: 90, fragLoadingTimeOut: 60000, manifestLoadingTimeOut: 20000,
                fragLoadingMaxRetry: 4, xhrSetup: (xhr) => { xhr.withCredentials = true; } });
            this.hls.on(Hls.Events.ERROR, (_, info) => {
                if (!info.fatal) return;
                if (info.type === Hls.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
                else if (info.type === Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
                else this.fehler('Wiedergabe abgebrochen (' + info.details + ').');
            });
            this.hls.loadSource(d.url);
            this.hls.attachMedia(v);
        } else {
            v.src = d.url;
            v.addEventListener('loadedmetadata', () => { if (start > 0) v.currentTime = start; }, { once: true });
        }
        // Text-Untertitel als Spuren; die gewählte einschalten
        for (const u of d.untertitel.filter((x) => x.url)) {
            const t = el('track', { kind: 'subtitles', src: u.url, srclang: (u.sprache || 'und').slice(0, 2), label: u.sprache_name + (u.erzwungen ? ' (erzwungen)' : '') });
            t.dataset.id = u.id;
            v.append(t);
        }
        this.untertitelAktivieren(d.untertitel_aktiv);
        try { await v.play(); } catch (x) { this.playKnopf.replaceChildren(icon('play')); this.mitte.hidden = true; }
    }

    untertitelAktivieren(id) {
        const tracks = this.video.textTracks;
        const elemente = [...this.video.querySelectorAll('track')];
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].mode = elemente[i] && Number(elemente[i].dataset.id) === Number(id) ? 'showing' : 'disabled';
        }
        if (this.daten) this.daten.untertitel_aktiv = id;
    }

    // ---------- Steuerung ----------
    umschalten() { if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause(); }
    springen(s) { this.video.currentTime = Math.max(0, Math.min(this.dauer() - 1, this.video.currentTime + s)); }
    vollbild() {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else (this.wurzel.requestFullscreen?.() || this.video.webkitEnterFullscreen?.());
    }
    wach() {
        this.wurzel.classList.remove('leerlauf');
        clearTimeout(this.leerlaufTimer);
        this.leerlaufTimer = setTimeout(() => { if (!this.video.paused && this.panelEl.hidden) this.wurzel.classList.add('leerlauf'); }, 3200);
    }
    zeigeZiel(p) {
        this.gespielt.style.width = p * 100 + '%';
        this.knauf.style.left = p * 100 + '%';
    }

    zeitAktualisieren() {
        const t = this.video.currentTime;
        const d = this.dauer();
        if (d > 0) {
            this.zeigeZiel(t / d);
            const b = this.video.buffered;
            for (let i = 0; i < b.length; i++) if (b.start(i) <= t && b.end(i) >= t) this.geladen.style.width = (b.end(i) / d) * 100 + '%';
        }
        this.zeitEl.textContent = `${zeit(t)} / ${zeit(d)}`;
        this.markerPruefen(t);
    }

    // ---------- Intro / Abspann / Nächste ----------
    markerZeichnen() {
        const m = this.daten?.marker || {};
        const d = this.dauer();
        this.markierungen.replaceChildren(...['intro', 'abspann'].filter((a) => m[a] && d).map((a) => el('div.markierung', {
            style: { left: (m[a].start_ms / 1000 / d) * 100 + '%', width: Math.max(0.4, ((m[a].ende_ms - m[a].start_ms) / 1000 / d) * 100) + '%' }, title: a === 'intro' ? 'Intro' : 'Abspann' })));
    }

    markerPruefen(t) {
        const m = this.daten?.marker || {};
        const intro = m.intro;
        const imIntro = intro && t >= intro.start_ms / 1000 && t < intro.ende_ms / 1000 - 1;
        if (imIntro && this.e.intro === 'automatisch' && !this.introUebersprungen) {
            this.introUeberspringen();
        }
        this.ueberspringenEl.hidden = !imIntro || this.introUebersprungen;
        // Abspann (oder letzte 25 s ohne Marker): nächste Folge anbieten
        const n = this.daten?.naechste;
        const d = this.dauer();
        const abspann = m.abspann ? m.abspann.start_ms / 1000 : (d > 120 ? d - 25 : Infinity);
        if (n && !this.naechsteGezeigt && t >= abspann && this.e.autoplay !== 'aus') {
            this.naechsteGezeigt = true;
            this.fortschrittSenden();
            if (this.e.autoplay === 'sofort') this.naechste();
            else this.naechsteKarte(n);
        }
    }

    introUeberspringen() {
        const intro = this.daten?.marker?.intro;
        if (!intro) return;
        this.introUebersprungen = true;
        this.ueberspringenEl.hidden = true;
        this.video.currentTime = intro.ende_ms / 1000;
    }

    naechsteKarte(n) {
        let rest = Number(this.e.countdown_s || 10);
        const zaehler = el('span', String(rest));
        this.naechsteEl.replaceChildren(
            n.standbild ? el('img', { src: n.standbild, alt: '' }) : el('img'),
            el('div', el('div.klein', 'Nächste Folge'), el('b', `${n.kennung} · ${n.titel}`),
                el('div.knoepfe',
                    el('button.knopf.weiss.klein', { onclick: () => this.naechste() }, icon('play'), 'Jetzt (', zaehler, ')'),
                    el('button.knopf.klein', { onclick: () => { clearInterval(this.countdownTimer); this.naechsteEl.hidden = true; } }, 'Abspann ansehen'))));
        this.naechsteEl.hidden = false;
        clearInterval(this.countdownTimer);
        this.countdownTimer = setInterval(() => {
            rest--;
            zaehler.textContent = String(rest);
            if (rest <= 0) this.naechste();
        }, 1000);
    }

    async naechste() {
        clearInterval(this.countdownTimer);
        const n = this.daten?.naechste;
        if (!n) return this.schliessen();
        await this.fortschrittSenden(true);
        this.ziel = { art: 'folge', id: n.id };
        this.naechsteEl.hidden = true;
        await this.starten({ start_ms: 0 });
    }

    ende() {
        this.fortschrittSenden(true);
        if (this.daten?.naechste && this.e.autoplay !== 'aus') this.naechste();
        else this.schliessen();
    }

    // ---------- Panels ----------
    panel(art) {
        if (!this.panelEl.hidden && this.panelEl.dataset.art === art) { this.panelEl.hidden = true; return; }
        this.panelEl.dataset.art = art;
        const d = this.daten;
        if (!d) return;
        const wahl = (text, an, fn, zusatz) => el('button.wahl', { onclick: fn }, el('span.haken', an ? icon('haken') : null), el('span', text, zusatz ? el('span.leise', ' ' + zusatz) : null));
        if (art === 'spuren') {
            this.panelEl.replaceChildren(
                el('h3', 'Ton'),
                d.tonspuren.map((t) => wahl(t.sprache_name, t.index === d.ton, () => this.neuStarten({ ton: t.index }), t.text + (t.kommentar ? ' · Kommentar' : ''))),
                el('h3', 'Untertitel'),
                wahl('Aus', !d.untertitel_aktiv, () => { if (d.transkodierung?.eingebrannt) this.neuStarten({ untertitel: 'aus' }); else { this.untertitelAktivieren(null); this.panelEl.hidden = true; } }),
                d.untertitel.map((u) => wahl(u.sprache_name + (u.erzwungen ? ' (erzwungen)' : '') + (u.sdh ? ' (SDH)' : ''), u.id === d.untertitel_aktiv, () => {
                    if (u.bild || d.transkodierung?.eingebrannt) this.neuStarten({ untertitel: u.id });
                    else { this.untertitelAktivieren(u.id); this.panelEl.hidden = true; }
                }, u.bild ? 'wird eingebrannt' : (u.quelle === 'opensubtitles' ? 'OpenSubtitles' : ''))));
        } else {
            const info = d.modus === 'direkt' ? 'Direkt abgespielt (Original)' : `Umgewandelt: ${d.transkodierung.hoehe}p · ${(d.transkodierung.bitrate_k / 1000).toString().replace('.', ',')} Mbit/s · ${d.transkodierung.profil}`
                + (d.transkodierung.tonemap ? ' · HDR→SDR' : '') + (d.grund ? ` (${d.grund})` : '');
            this.panelEl.replaceChildren(
                el('h3', 'Nachtmodus'),
                ['aus', 'leicht', 'stark'].map((n) => wahl({ aus: 'Aus (Ton unverändert)', leicht: 'Leicht', stark: 'Stark' }[n], this.nacht === n, () => { this.nacht = n; this.tonKette(); this.panel('einstellungen'); this.panel('einstellungen'); })),
                el('h3', 'Dialog-Anhebung'),
                [0, 2, 4, 6].map((db) => wahl(db ? `+${db} dB` : 'Aus', this.dialogDb === db, () => { this.dialogDb = db; this.tonKette(); this.panel('einstellungen'); this.panel('einstellungen'); })),
                el('h3', 'Wiedergabe'),
                el('div.info-text', info),
                d.modus === 'direkt' ? wahl('Umwandeln erzwingen', false, () => this.neuStarten({ erzwinge_transkodieren: true })) : null,
                this.admin ? [
                    el('h3', 'Marker setzen (Admin)'),
                    wahl('Intro beginnt hier', false, () => this.markerSetzen('intro', 'start')),
                    wahl('Intro endet hier', false, () => this.markerSetzen('intro', 'ende')),
                    wahl('Abspann beginnt hier', false, () => this.markerSetzen('abspann', 'start')),
                    d.marker?.intro ? wahl('Intro-Marker löschen', false, () => this.markerLoeschen('intro'), d.marker.intro.quelle) : null,
                    d.marker?.abspann ? wahl('Abspann-Marker löschen', false, () => this.markerLoeschen('abspann'), d.marker.abspann.quelle) : null,
                ] : null);
        }
        this.panelEl.hidden = false;
        this.wach();
    }

    async neuStarten(extra) {
        this.panelEl.hidden = true;
        const pos = Math.round(this.video.currentTime * 1000);
        this.ziel = { ...this.ziel, datei_id: this.daten.datei_id };
        await this.starten({ start_ms: pos, ton: this.daten.ton, untertitel: this.daten.untertitel_aktiv ?? 'aus', ...extra });
    }

    async markerSetzen(art, teil) {
        const t = Math.round(this.video.currentTime * 1000);
        const vorhanden = this.daten.marker?.[art] || {};
        const m = { start_ms: vorhanden.start_ms ?? 0, ende_ms: vorhanden.ende_ms ?? this.daten.dauer_ms, ...(this.markerEntwurf[art] || {}) };
        if (teil === 'start') m.start_ms = t; else m.ende_ms = t;
        if (art === 'abspann') m.ende_ms = this.daten.dauer_ms;
        if (art === 'intro' && teil === 'start' && (!vorhanden.ende_ms || vorhanden.ende_ms <= t)) m.ende_ms = t + 60000;
        this.markerEntwurf[art] = m;
        try {
            await api('marker', 'PUT', { datei_id: this.daten.datei_id, art, start_ms: m.start_ms, ende_ms: m.ende_ms });
            this.daten.marker = { ...(this.daten.marker || {}), [art]: { ...m, quelle: 'manuell' } };
            this.markerZeichnen();
            meldung(`${art === 'intro' ? 'Intro' : 'Abspann'}: ${zeit(m.start_ms / 1000)} – ${zeit(m.ende_ms / 1000)} gespeichert.`);
        } catch (x) { meldung(x.message, true); }
        this.panelEl.hidden = true;
    }

    async markerLoeschen(art) {
        await api(`marker/${this.daten.datei_id}/${art}`, 'DELETE');
        delete this.daten.marker[art];
        this.markerZeichnen();
        this.panelEl.hidden = true;
        meldung('Marker gelöscht.');
    }

    // ---------- Ton: Nachtmodus und Dialog (nur wenn an) ----------
    tonKette() {
        const an = this.nacht !== 'aus' || this.dialogDb > 0;
        if (!this.audio) {
            if (!an) return; // Ton bleibt komplett unangetastet
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const quelle = ctx.createMediaElementSource(this.video);
            this.audio = { ctx, quelle };
        }
        const { ctx, quelle } = this.audio;
        ctx.resume?.();
        quelle.disconnect();
        this.audio.knoten?.forEach((k) => k.disconnect());
        this.audio.knoten = [];
        if (!an) { quelle.connect(ctx.destination); return; }
        let letzter = quelle;
        const k = (n) => { this.audio.knoten.push(n); return n; };
        if (this.dialogDb > 0) {
            // Mitte (L+R) anheben: L' = M·g + S, R' = M·g − S – vorher sauber auf Stereo heruntermischen
            const stereo = k(ctx.createGain());
            stereo.channelCount = 2; stereo.channelCountMode = 'explicit'; stereo.channelInterpretation = 'speakers';
            const teilen = k(ctx.createChannelSplitter(2));
            const mitte = k(ctx.createGain());
            const seite = k(ctx.createGain());
            const seiteMinus = k(ctx.createGain());
            const lHalb = k(ctx.createGain()); lHalb.gain.value = 0.5;
            const rHalb = k(ctx.createGain()); rHalb.gain.value = 0.5;
            const rHalbMinus = k(ctx.createGain()); rHalbMinus.gain.value = -0.5;
            const mischen = k(ctx.createChannelMerger(2));
            mitte.gain.value = Math.pow(10, this.dialogDb / 20);
            seiteMinus.gain.value = -1;
            letzter.connect(stereo); stereo.connect(teilen);
            teilen.connect(lHalb, 0); teilen.connect(rHalb, 1); teilen.connect(rHalbMinus, 1);
            lHalb.connect(mitte); rHalb.connect(mitte);
            lHalb.connect(seite); rHalbMinus.connect(seite);
            mitte.connect(mischen, 0, 0); seite.connect(mischen, 0, 0);
            mitte.connect(mischen, 0, 1); seite.connect(seiteMinus); seiteMinus.connect(mischen, 0, 1);
            letzter = mischen;
        }
        if (this.nacht !== 'aus') {
            // weicher Kompressor nach Art der Dolby-Dynamikprofile, danach Pegel wieder anheben
            const c = k(ctx.createDynamicsCompressor());
            const stark = this.nacht === 'stark';
            c.threshold.value = stark ? -34 : -26; c.knee.value = stark ? 10 : 14; c.ratio.value = stark ? 6 : 3;
            c.attack.value = 0.008; c.release.value = 0.3;
            const auf = k(ctx.createGain()); auf.gain.value = Math.pow(10, (stark ? 9 : 5) / 20);
            letzter.connect(c); c.connect(auf);
            letzter = auf;
        }
        letzter.connect(ctx.destination);
    }

    // ---------- Fortschritt und Ende ----------
    async fortschrittSenden(sofort = false) {
        const d = this.daten;
        if (!d || !this.video.currentTime) return;
        const daten = { art: d.art, id: d.id, datei_id: d.datei_id, position_ms: Math.round(this.video.currentTime * 1000), dauer_ms: d.dauer_ms, sitzung: d.sitzung || null };
        try { await api('wiedergabe/fortschritt', 'POST', daten); } catch (x) { if (sofort) console.warn(x); }
    }

    fehler(text, umwandeln = false) {
        this.mitte.hidden = false;
        this.mitte.replaceChildren(el('div.fehler-box', el('div', el('h2', 'Wiedergabe nicht möglich'), el('p.leise', text),
            el('div.knoepfe', { style: { justifyContent: 'center' } },
                umwandeln ? el('button.knopf.haupt', { onclick: () => this.neuStarten({ erzwinge_transkodieren: true }) }, 'Mit Umwandlung versuchen') : null,
                el('button.knopf', { onclick: () => this.schliessen() }, 'Schließen')))));
        this.mitte.style.pointerEvents = 'auto';
    }

    async schliessen(neuLaden = true) {
        clearInterval(this.fortschrittTimer);
        clearInterval(this.countdownTimer);
        clearTimeout(this.leerlaufTimer);
        await this.fortschrittSenden(true);
        document.removeEventListener('keydown', this.taste);
        document.removeEventListener('fullscreenchange', this.vollAenderung);
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        if (this.hls) this.hls.destroy();
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
        if (this.daten?.sitzung) api('stream/' + this.daten.sitzung, 'DELETE').catch(() => {});
        this.audio?.ctx.close?.();
        this.wurzel.remove();
        document.body.style.overflow = '';
        if (aktiv === this) aktiv = null;
        if (neuLaden) this.app.neuLaden();
    }
}
