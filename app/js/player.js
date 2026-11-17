// Player: Direct Play oder HLS (nativ bzw. hls.js), Ton- und Untertitelwahl, Intro überspringen, nächste Folge,
// Nachtmodus/Dialog-Anhebung (nur wenn eingeschaltet – sonst bleibt der Ton unangetastet), Fortschritt, Marker setzen (Admin)
'use strict';
import { el, icon, zeit, meldung } from './ui.js';
import { api } from './api.js';
import { MseStrom, mseVerfuegbar } from './mse_strom.js';
import { diag, diagNeu, diagEnde, diagVideo, diagKennung } from './diagnose.js';

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
        // Direct Stream (Video unverändert, fortlaufendes fragmentiertes MP4) kann jeder Browser
        remux: true,
        // Fernseher melden dem Browser oft nur 1920×1080, auch bei 4K → der Server begrenzt dann nicht auf die Bildschirmhöhe
        fernseher: /web0s|webos|tizen|smart-?tv|smarttv|hbbtv|netcast|bravia|aft[a-z]|android tv|googletv|crkey|vidaa|viera|philipstv|roku/i.test(navigator.userAgent),
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
    diagNeu({ art: ziel.art, id: ziel.id, bildschirm: `${screen.width}x${screen.height}@${devicePixelRatio}`, verbindung: navigator.connection?.effectiveType || null,
        mse: mseVerfuegbar(), faehigkeiten: JSON.stringify(faehigkeiten()).slice(0, 600) });
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
        this.versatz = 0;          // Direct Stream: Startpunkt des laufenden Stroms in der Datei (Sekunden)
        this.qualitaetWahl = null; // im Player gewählte Qualität (gilt bis zum Schließen)
        this.aufbauen();
        this.diagLos = diagVideo(this.video, () => ({ modus: this.daten?.modus || null, versatz: this.versatz || undefined }));
    }

    aufbauen() {
        this.video = el('video', { playsinline: true, preload: 'auto' });
        this.kreisel = el('div.kreisel');
        this.mitte = el('div.mitte-status', this.kreisel);
        this.titelEl = el('div.titel');
        this.zeitJetzt = el('span.zeit', '0:00');
        this.zeitRest = el('span.zeit.rest', '0:00');
        this.gespielt = el('div.gespielt');
        this.geladen = el('div.geladen');
        this.knauf = el('div.knauf');
        this.markierungen = el('div.markierungen');
        this.vorschau = el('div.vorschau-zeit', { hidden: true });
        this.spurEl = el('div.leiste-spur', this.geladen, this.markierungen, this.gespielt, this.knauf);
        this.leiste = el('div.zeitleiste', this.spurEl, this.vorschau);
        const knopf = (name, label, fn, extra = '') => el('button.p-knopf' + extra, { 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(name));
        this.playKnopf = knopf('play', 'Abspielen/Pause (Leertaste)', () => this.umschalten());
        this.mittePlay = el('button.mitte-play', { 'aria-label': 'Abspielen/Pause', onclick: (e) => { e.stopPropagation(); this.umschalten(); } }, icon('play'));
        this.vollKnopf = knopf('vollbild', 'Vollbild (F)', () => this.vollbild());
        // Lautstärke: Knopf schaltet stumm, Regler (am Rechner) daneben
        this.tonKnopf = knopf('ton', 'Stumm (M)', () => { this.video.muted = !this.video.muted; });
        this.lautRegler = el('input.laut', { type: 'range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Lautstärke',
            oninput: (e) => { this.video.volume = Number(e.target.value); this.video.muted = this.video.volume === 0; }, onclick: (e) => e.stopPropagation() });
        this.qualitaetKnopf = el('button.p-knopf.mit-text.qualitaet-chip', { title: 'Qualität', onclick: (e) => { e.stopPropagation(); this.panel('einstellungen'); } }, el('span', ''));
        this.naechsteKnopf = el('button.p-knopf.mit-text', { hidden: true, title: 'Nächste Folge', onclick: (e) => { e.stopPropagation(); this.naechste(); } }, icon('naechste'), el('span', 'Nächste'));
        this.panelEl = el('div.panel', { hidden: true, onclick: (e) => e.stopPropagation() });
        this.ueberspringenEl = el('button.ueberspringen', { hidden: true, onclick: (e) => { e.stopPropagation(); this.introUeberspringen(); } }, 'Intro überspringen', icon('naechste'));
        this.naechsteEl = el('div.naechste-karte', { hidden: true, onclick: (e) => e.stopPropagation() });
        this.ebene = el('div.ebene',
            el('div.oben', knopf('zurueck', 'Zurück (Esc)', () => this.schliessen(), '.rund'), this.titelEl),
            el('div.mitte-steuerung',
                knopf('zurueck10', '10 Sekunden zurück (←)', () => this.springen(-10), '.mittel'),
                this.mittePlay,
                knopf('vor10', '10 Sekunden vor (→)', () => this.springen(10), '.mittel')),
            el('div.unten',
                el('div.leiste-zeile', this.zeitJetzt, this.leiste, this.zeitRest),
                el('div.steuerung',
                    el('div.links', this.playKnopf, knopf('zurueck10', '10 Sekunden zurück (←)', () => this.springen(-10), '.nur-gross'),
                        knopf('vor10', '10 Sekunden vor (→)', () => this.springen(10), '.nur-gross'), el('div.lautstaerke', this.tonKnopf, this.lautRegler)),
                    el('div.rechts', this.naechsteKnopf, this.qualitaetKnopf,
                        knopf('untertitel', 'Ton und Untertitel', () => this.panel('spuren')),
                        knopf('einstellungen', 'Einstellungen', () => this.panel('einstellungen')),
                        this.vollKnopf))));
        this.wurzel = el('div.player', this.video, this.mitte, this.ebene, this.ueberspringenEl, this.naechsteEl, this.panelEl);
        document.body.append(this.wurzel);
        document.body.style.overflow = 'hidden';

        const v = this.video;
        const playIcons = () => {
            const n = v.paused ? 'play' : 'pause';
            this.playKnopf.replaceChildren(icon(n));
            this.mittePlay.replaceChildren(icon(n));
            this.wurzel.classList.toggle('pausiert', v.paused);
        };
        v.addEventListener('play', playIcons);
        v.addEventListener('pause', () => { playIcons(); this.fortschrittSenden(); this.wach(); });
        v.addEventListener('volumechange', () => {
            this.tonKnopf.replaceChildren(icon(v.muted || v.volume === 0 ? 'stumm' : 'ton'));
            this.lautRegler.value = v.muted ? 0 : v.volume;
            try { localStorage.setItem('bluewave.lautstaerke', JSON.stringify({ v: v.volume, m: v.muted })); } catch { /* privat */ }
        });
        try {
            const l = JSON.parse(localStorage.getItem('bluewave.lautstaerke') || 'null');
            if (l) { v.volume = Math.min(1, Math.max(0, Number(l.v) || 1)); v.muted = !!l.m; }
        } catch { /* privat */ }
        v.addEventListener('waiting', () => { this.mitte.hidden = false; });
        v.addEventListener('playing', () => { this.mitte.hidden = true; });
        v.addEventListener('canplay', () => { this.mitte.hidden = true; });
        v.addEventListener('timeupdate', () => this.zeitAktualisieren());
        v.addEventListener('progress', () => this.zeitAktualisieren());
        v.addEventListener('ended', () => this.ende());
        // Direct Stream: natives Spulen (Medientasten, Systemsteuerung) außerhalb des Puffers → Strom neu starten
        v.addEventListener('seeking', () => {
            if (this.daten?.modus !== 'remux' || this.remuxNr === undefined || this.mse) return;
            const rel = v.currentTime;
            const drin = (r) => { for (let i = 0; i < r.length; i++) if (rel >= r.start(i) && rel <= r.end(i)) return true; return false; };
            if (drin(v.buffered) && drin(v.seekable)) return;
            this.remuxLaden(this.versatz + rel);
        });
        v.addEventListener('error', () => {
            // Direct Stream klappt auf diesem Gerät nicht → einmal automatisch mit Umwandlung
            if (this.daten?.modus === 'remux' && !this.remuxFehler) {
                this.remuxFehler = true;
                meldung('Direct Stream klappt hier nicht – wandle um …');
                this.neuStarten({ erzwinge_transkodieren: true });
                return;
            }
            if (!this.hls) this.fehler('Die Datei lässt sich hier nicht abspielen.' + (this.daten?.modus === 'direkt' ? ' Versuche es mit Umwandlung …' : ''), this.daten?.modus === 'direkt'); });
        playIcons();

        // Zeitleiste: klicken und ziehen, Vorschau der Zielzeit
        const position = (ev) => {
            const r = this.spurEl.getBoundingClientRect();
            return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        };
        let ziehen = false;
        this.leiste.addEventListener('click', (ev) => ev.stopPropagation());
        this.leiste.addEventListener('pointerdown', (ev) => { ziehen = true; this.leiste.setPointerCapture(ev.pointerId); this.leiste.classList.add('zieht'); this.zeigeZiel(position(ev)); });
        this.leiste.addEventListener('pointermove', (ev) => {
            const p = position(ev);
            this.vorschau.hidden = false;
            this.vorschau.style.left = p * 100 + '%';
            this.vorschau.textContent = zeit(p * this.dauer());
            if (ziehen) this.zeigeZiel(p);
            this.wach();
        });
        this.leiste.addEventListener('pointerleave', () => { if (!ziehen) this.vorschau.hidden = true; });
        const loslassen = (ev) => {
            if (!ziehen) return;
            ziehen = false;
            this.leiste.classList.remove('zieht');
            this.vorschau.hidden = true;
            this.gehe(position(ev) * this.dauer());
        };
        this.leiste.addEventListener('pointerup', loslassen);
        this.leiste.addEventListener('pointercancel', loslassen);

        this.taste = (ev) => {
            if (ev.target.closest('input:not([type=range]), select, textarea')) return;
            const k = ev.key;
            if (k === ' ' || k === 'k') { ev.preventDefault(); this.umschalten(); } else if (k === 'ArrowLeft') this.springen(-10);
            else if (k === 'ArrowRight') this.springen(10);
            else if (k === 'ArrowUp') { ev.preventDefault(); this.video.volume = Math.min(1, this.video.volume + 0.1); this.video.muted = false; }
            else if (k === 'ArrowDown') { ev.preventDefault(); this.video.volume = Math.max(0, this.video.volume - 0.1); }
            else if (k === 'm') this.video.muted = !this.video.muted;
            else if (k === 'f') this.vollbild();
            else if (k === 'n' && this.daten?.naechste) this.naechste();
            else if (k === 'i') this.diagLive();
            else if (k === 'Escape') { if (!this.panelEl.hidden) this.panelEl.hidden = true; else if (!document.fullscreenElement) this.schliessen(); }
            else return;
            this.wach();
        };
        document.addEventListener('keydown', this.taste);
        this.wurzel.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse') this.wach(); });
        // Klick/Tippen auf das Bild: Maus = Pause umschalten; Touch = Steuerung zeigen/verstecken, Doppeltipp links/rechts = ±10 s
        let letzterTipp = 0;
        this.wurzel.addEventListener('click', (ev) => {
            if (!this.panelEl.hidden) { this.panelEl.hidden = true; return; }
            if (ev.target.closest('button, input, .zeitleiste, .naechste-karte')) return;
            const touch = matchMedia('(pointer: coarse)').matches;
            if (!touch) { this.umschalten(); this.wach(); return; }
            const jetzt = Date.now();
            if (jetzt - letzterTipp < 300) {
                const x = ev.clientX / window.innerWidth;
                if (x < 0.35) this.springen(-10, true); else if (x > 0.65) this.springen(10, true);
                letzterTipp = 0;
                return;
            }
            letzterTipp = jetzt;
            if (this.wurzel.classList.contains('leerlauf')) this.wach(); else if (!this.video.paused) this.wurzel.classList.add('leerlauf');
        });
        this.video.addEventListener('dblclick', () => { if (!matchMedia('(pointer: coarse)').matches) this.vollbild(); });
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
        const t0 = performance.now();
        diag('api_start_anfrage', { ...extra, qualitaet: this.qualitaetWahl || 'auto' });
        try {
            const d = await api('wiedergabe/start', 'POST', { ...this.ziel, ...(this.qualitaetWahl ? { qualitaet: this.qualitaetWahl } : {}), ...extra,
                faehigkeiten: faehigkeiten(), sitzung_alt: this.daten?.sitzung || '' });
            this.daten = d;
            diag('api_start_antwort', { titel: [d.info?.titel, d.info?.untertitel].filter(Boolean).join(' · '), dauer_ms: Math.round(performance.now() - t0), modus: d.modus, grund: d.grund || null, start_ms: d.start_ms,
                quelle: d.quelle ? `${d.quelle.hoehe}p ${d.quelle.video_codec} ${d.quelle.container} ${d.quelle.bitrate_k} kbit/s${d.quelle.hdr ? ' HDR' : ''}` : null,
                ton: d.remux ? `${d.remux.audio} ${d.remux.kanaele}ch (Spur ${d.remux.ton})` : null, transkodierung: d.transkodierung ? `${d.transkodierung.hoehe}p ${d.transkodierung.profil}` : null,
                untertitel_aktiv: d.untertitel_aktiv ?? null });
        } catch (x) {
            diag('api_start_fehler', { dauer_ms: Math.round(performance.now() - t0), text: x.message, status: x.status });
            this.fehler(x.message);
            return;
        }
        const d = this.daten;
        this.titelEl.replaceChildren(d.info.untertitel ? el('small', d.info.titel) : null, el('b', d.info.untertitel ? String(d.info.untertitel) : d.info.titel));
        this.naechsteKnopf.hidden = !d.naechste;
        this.qualitaetKnopf.firstChild.textContent = this.qualitaetText(d);
        this.qualitaetKnopf.classList.toggle('original', d.modus !== 'hls');
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
        this.versatz = 0;
        this.mse?.beenden();
        this.mse = null;
        if (d.modus === 'remux') {
            if (mseVerfuegbar() && !this.mseAus) await this.mseStarten(start);
            else await this.remuxLaden(start, false);
            return;
        }
        if (d.modus === 'hls' && v.canPlayType('application/vnd.apple.mpegurl')) {
            v.src = d.url;
            v.addEventListener('loadedmetadata', () => { if (start > 0) v.currentTime = start; }, { once: true });
        } else if (d.modus === 'hls') {
            let Hls;
            try { Hls = await hlsJs(); } catch (x) { this.fehler(x.message); return; }
            this.hls = new Hls({ startPosition: start, maxBufferLength: 60, backBufferLength: 90, fragLoadingTimeOut: 60000, manifestLoadingTimeOut: 20000,
                fragLoadingMaxRetry: 4, xhrSetup: (xhr) => { xhr.withCredentials = true; if (diagKennung()) xhr.setRequestHeader('X-Bluewave-Diag', diagKennung()); } });
            this.hls.on(Hls.Events.FRAG_LOADED, (_, x) => {
                const st = x.frag.stats || x.stats || {};
                const dauer = (st.loading?.end || 0) - (st.loading?.start || 0);
                if (dauer > 1500 || x.frag.sn % 10 === 0) diag('hls_teil', { nr: x.frag.sn, ms: Math.round(dauer), erstes_byte_ms: Math.round((st.loading?.first || 0) - (st.loading?.start || 0)), kb: Math.round((st.total || st.loaded || 0) / 1024) });
            });
            this.hls.on(Hls.Events.ERROR, (_, info) => {
                diag('hls_fehler', { typ: info.type, details: info.details, fatal: !!info.fatal });
                if (!info.fatal) return;
                if (info.type === Hls.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
                else if (info.type === Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
                else this.fehler('Wiedergabe abgebrochen (' + info.details + ').');
            });
            this.hls.loadSource(d.url);
            this.hls.attachMedia(v);
        } else {
            v.src = d.url + (diagKennung() ? (d.url.includes('?') ? '&' : '?') + 'diag=' + diagKennung() : '');
            v.addEventListener('loadedmetadata', () => { if (start > 0) v.currentTime = start; }, { once: true });
        }
        this.spurenSetzen();
        try { await v.play(); } catch (x) { this.playKnopf.replaceChildren(icon('play')); this.mitte.hidden = true; }
    }

    /** Text-Untertitel als Spuren (bei Direct Stream um den Versatz verschoben); die gewählte einschalten */
    spurenSetzen() {
        const v = this.video;
        const d = this.daten;
        v.querySelectorAll('track').forEach((t) => t.remove());
        const versatzMs = Math.round(this.versatz * 1000);
        // eingebettete Untertitel werden beim ersten Mal im Hintergrund ausgelesen → bis dahin regelmäßig neu versuchen
        const spur = (u, versuch = 0) => {
            const src = u.url + (versatzMs > 0 ? '?versatz_ms=' + versatzMs : '') + (versuch ? (versatzMs > 0 ? '&' : '?') + 'v=' + versuch : '');
            const t = el('track', { kind: 'subtitles', src, srclang: (u.sprache || 'und').slice(0, 2),
                label: u.sprache_name + (u.erzwungen ? ' (erzwungen)' : '') });
            t.dataset.id = u.id;
            t.addEventListener('error', () => {
                if (this.daten !== d || !t.isConnected || versuch > 120) return;
                const aktiv = String(d.untertitel_aktiv) === String(u.id);
                if (aktiv && !this.utHinweis) { this.utHinweis = true; meldung('Untertitel werden vorbereitet – erscheinen gleich.'); }
                setTimeout(() => {
                    if (this.daten !== d || !t.isConnected) return;
                    t.replaceWith(spur(u, versuch + 1));
                    if (String(d.untertitel_aktiv) === String(u.id)) this.untertitelAktivieren(u.id);
                }, 6000);
            });
            return t;
        };
        for (const u of d.untertitel.filter((x) => x.url)) v.append(spur(u));
        this.untertitelAktivieren(d.untertitel_aktiv);
    }

    /** Direct Stream über MediaSource: durchgehende Zeitleiste, Geladenes bleibt, kein Neustart beim Spulen im Puffer */
    async mseStarten(start) {
        const d = this.daten;
        const v = this.video;
        const p = new URLSearchParams({ ton: d.remux.ton, audio: d.remux.audio, kanaele: d.remux.kanaele });
        if (diagKennung()) p.set('diag', diagKennung());
        const strom = new MseStrom(v, `${d.url}/strom?${p}`, this.dauer(), (x) => {
            diag('mse_fehler', { text: x?.message || String(x) });
            // MSE klappt hier nicht (Codec, alter Browser) → einfacher Strom
            console.warn('Direct Stream über MSE nicht möglich:', x?.message || x);
            if (this.mse !== strom) return;
            strom.beenden();
            this.mse = null;
            this.mseAus = true;
            // Server liefert gar nichts (ffmpeg scheitert am Umpacken) → einfacher Strom hilft nicht, also umwandeln
            if (x?.leer) { diag('rueckfall_umwandeln', { grund: x.message }); this.neuStarten({ erzwinge_transkodieren: true }); return; }
            this.remuxLaden(this.pos() || start, false);
        }, d.quelle?.bitrate_k || 8000);
        this.mse = strom;
        try { await strom.oeffnen(); } catch (x) { strom.fehler(x); return; }
        if (this.mse !== strom) return;
        this.spurenSetzen();
        v.currentTime = start;
        strom.laden(start);
        try { await v.play(); } catch (x) { this.playKnopf.replaceChildren(icon('play')); this.mitte.hidden = true; }
    }

    /** Direct Stream ab Sekunde $start (wird auf das Schlüsselbild davor gelegt) neu laden */
    async remuxLaden(start, weiterSpielen = true) {
        const d = this.daten;
        const v = this.video;
        const nr = (this.remuxNr = (this.remuxNr || 0) + 1);
        const warPausiert = weiterSpielen && v.paused && !!v.currentSrc;
        this.mitte.hidden = false;
        let k = 0;
        if (start > 0.5) {
            try { k = (await api(`remux/${d.datei_id}/position?start=${start.toFixed(3)}`)).start; } catch { k = Math.max(0, start - 2); }
        }
        if (nr !== this.remuxNr) return; // schon wieder gespult
        this.versatz = k;
        const p = new URLSearchParams({ start: k.toFixed(3), ton: d.remux.ton, audio: d.remux.audio, kanaele: d.remux.kanaele });
        if (diagKennung()) p.set('diag', diagKennung());
        diag('remux_einfach_laden', { start: k });
        v.src = `${d.url}/strom?${p}`;
        this.spurenSetzen();
        this.zeitAktualisieren();
        if (warPausiert) {
            v.addEventListener('loadeddata', () => { this.mitte.hidden = true; }, { once: true });
            return;
        }
        try { await v.play(); } catch (x) { this.playKnopf.replaceChildren(icon('play')); this.mitte.hidden = true; }
    }

    /** Position in der Datei (Sekunden) – bei Direct Stream plus Versatz */
    pos() { return this.versatz + (this.video.currentTime || 0); }

    /** Springen: im Puffer direkt, bei Direct Stream außerhalb des Puffers Strom neu starten */
    gehe(t) {
        t = Math.max(0, Math.min(this.dauer() - 0.5, t));
        if (this.mse) {
            this.mse.gehe(t);
            this.zeigeZiel(t / (this.dauer() || 1));
            return;
        }
        if (this.daten?.modus === 'remux') {
            // nur springen, wo der Browser wirklich kann (gepuffert UND spulbar); sonst Strom an der Stelle neu starten
            const rel = t - this.versatz;
            const drin = (r) => { for (let i = 0; i < r.length; i++) if (rel >= r.start(i) && rel <= r.end(i) - 0.5) return true; return false; };
            if (drin(this.video.buffered) && drin(this.video.seekable)) { this.video.currentTime = rel; return; }
            this.remuxLaden(t);
            this.zeigeZiel(t / (this.dauer() || 1));
            return;
        }
        this.video.currentTime = t;
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
    springen(s, zeigen = false) {
        this.gehe(this.pos() + s);
        if (zeigen) {
            const b = el('div.sprung-anzeige' + (s < 0 ? '.links' : '.rechts'), icon(s < 0 ? 'zurueck10' : 'vor10'), `${s > 0 ? '+' : ''}${s} s`);
            this.wurzel.append(b);
            setTimeout(() => b.remove(), 650);
        }
    }
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
        const t = this.pos();
        const d = this.dauer();
        if (d > 0) {
            this.zeigeZiel(t / d);
            const b = this.video.buffered;
            const rel = t - this.versatz;
            for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= rel + 0.3 && b.end(i) >= rel) {
                    this.geladen.style.left = ((b.start(i) + this.versatz) / d) * 100 + '%';
                    this.geladen.style.width = ((b.end(i) - b.start(i)) / d) * 100 + '%';
                }
            }
        }
        this.zeitJetzt.textContent = zeit(t);
        this.zeitRest.textContent = d > 0 ? '−' + zeit(Math.max(0, d - t)) : '0:00';
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
        this.gehe(intro.ende_ms / 1000);
    }

    naechsteKarte(n) {
        let rest = Number(this.e.countdown_s || 10);
        const zaehler = el('span', String(rest));
        const balken = el('span.countdown-balken', { style: { animationDuration: rest + 's' } });
        this.naechsteEl.replaceChildren(
            el('button.bild', { onclick: () => this.naechste(), 'aria-label': 'Nächste Folge jetzt' }, n.standbild ? el('img', { src: n.standbild, alt: '' }) : null, el('span.play-rund', icon('play'))),
            el('div.text', el('small', 'Nächste Folge in ', zaehler, ' s'), el('b', n.titel), el('span', n.kennung),
                el('div.knoepfe',
                    el('button.knopf.weiss.klein', { onclick: () => this.naechste() }, icon('play'), 'Jetzt ansehen'),
                    el('button.knopf.klein', { onclick: () => { clearInterval(this.countdownTimer); this.naechsteEl.hidden = true; } }, 'Abspann'))),
            balken);
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

    /** Live-Anzeige für die Fehlersuche (Taste I oder Einstellungen › Diagnose) */
    diagLive() {
        if (this.diagLiveAus) { this.diagLiveAus(); return; }
        const box = el('pre.diag-live');
        this.wurzel.append(box);
        let warten = 0;
        const zaehlen = () => warten++;
        this.video.addEventListener('waiting', zaehlen);
        let letzteBytes = null;
        const zeigen = () => {
            const v = this.video;
            const d = this.daten || {};
            const b = v.buffered;
            let voraus = 0;
            for (let i = 0; i < b.length; i++) if (v.currentTime >= b.start(i) - 0.3 && v.currentTime <= b.end(i)) voraus = b.end(i) - v.currentTime;
            const q = v.getVideoPlaybackQuality?.();
            const zustand = ['nichts', 'Metadaten', 'aktuelles Bild', 'etwas voraus', 'genug'][v.readyState];
            box.textContent = [
                `Modus      ${{ direkt: 'Direct Play', remux: this.mse ? 'Direct Stream (MSE)' : 'Direct Stream (einfach)', hls: 'Umwandeln (HLS)' }[d.modus] || '–'}`,
                d.quelle ? `Quelle     ${d.quelle.hoehe}p ${d.quelle.video_codec} ${d.quelle.container} ${(d.quelle.bitrate_k / 1000).toFixed(1)} Mbit/s` : null,
                d.remux ? `Ton        ${d.remux.audio} ${d.remux.kanaele} Kanäle` : null,
                d.transkodierung ? `Ziel       ${d.transkodierung.hoehe}p ${d.transkodierung.profil}` : null,
                d.grund ? `Grund      ${d.grund}` : null,
                `Bild       ${v.videoWidth}×${v.videoHeight}`,
                `Position   ${this.pos().toFixed(1)} s  (Versatz ${this.versatz || 0})`,
                `Puffer     ${voraus.toFixed(1)} s voraus${this.mse ? `, Vorrat bis ${this.mse.vorausS} s` : ''}`,
                `Zustand    ${zustand}${v.paused ? ', pausiert' : ''}${v.seeking ? ', spult' : ''}`,
                `Gewartet   ${warten}×`,
                q ? `Bilder     ${q.totalVideoFrames} (${q.droppedVideoFrames} verworfen)` : null,
                `Diagnose   ${diagKennung() || '–'}  (Verwaltung › Diagnose)`,
            ].filter(Boolean).join('\n');
            letzteBytes = null;
        };
        zeigen();
        const t = setInterval(zeigen, 1000);
        this.diagLiveAus = () => { clearInterval(t); box.remove(); this.video.removeEventListener('waiting', zaehlen); this.diagLiveAus = null; };
    }

    qualitaetText(d) {
        if (d.modus === 'hls') return `${d.transkodierung.hoehe}p`;
        const h = d.quelle?.hoehe || 0;
        return (h >= 2000 ? '4K' : h ? `${h >= 1040 ? 1080 : h >= 700 ? 720 : h}p` : 'Original') + (d.modus === 'remux' ? ' · DS' : '');
    }

    // ---------- Panels ----------
    panel(art) {
        if (!this.panelEl.hidden && this.panelEl.dataset.art === art) { this.panelEl.hidden = true; return; }
        this.panelEl.dataset.art = art;
        const d = this.daten;
        if (!d) return;
        const wahl = (text, an, fn, zusatz) => el('button.wahl' + (an ? '.an' : ''), { onclick: fn }, el('span.haken', an ? icon('haken') : null),
            el('span.text', el('span', text), zusatz ? el('small', zusatz) : null));
        const setzen = (...teile) => this.panelEl.replaceChildren(...teile.flat(Infinity).filter(Boolean));
        if (art === 'spuren') {
            setzen(el('div.panel-spalte',
                el('h3', 'Ton'),
                d.tonspuren.map((t) => wahl(t.sprache_name, t.index === d.ton, () => this.neuStarten({ ton: t.index }), t.text + (t.kommentar ? ' · Kommentar' : '')))),
                el('div.panel-spalte',
                el('h3', 'Untertitel'),
                wahl('Aus', !d.untertitel_aktiv, () => { if (d.transkodierung?.eingebrannt) this.neuStarten({ untertitel: 'aus' }); else { this.untertitelAktivieren(null); this.panelEl.hidden = true; } }),
                d.untertitel.map((u) => wahl(u.sprache_name + (u.erzwungen ? ' (erzwungen)' : '') + (u.sdh ? ' (SDH)' : ''), u.id === d.untertitel_aktiv, () => {
                    if (u.bild || d.transkodierung?.eingebrannt) this.neuStarten({ untertitel: u.id });
                    else { this.untertitelAktivieren(u.id); this.panelEl.hidden = true; }
                }, u.bild ? 'wird eingebrannt' : (u.quelle === 'opensubtitles' ? 'OpenSubtitles' : '')))));
        } else {
            const q = d.quelle || {};
            const quelleText = [q.hoehe ? `${q.hoehe}p` : null, q.video_codec, q.hdr ? 'HDR' : null, q.bitrate_k ? `${(q.bitrate_k / 1000).toFixed(1).replace('.', ',')} Mbit/s` : null,
                q.container ? q.container.toUpperCase() : null].filter(Boolean).join(' · ');
            const info = d.modus === 'direkt' ? 'Direct Play – die Datei läuft unverändert.'
                : d.modus === 'remux' ? `Direct Stream – Bild unverändert, ${{ copy: 'Ton unverändert', eac3: 'Ton nach Dolby Digital Plus', aac: 'Ton nach AAC' }[d.remux.audio] || 'Ton umgewandelt'}, nur der Container wird angepasst${d.grund ? ` (${d.grund})` : ''}.`
                : `Umgewandelt: ${d.transkodierung.hoehe}p · ${(d.transkodierung.bitrate_k / 1000).toString().replace('.', ',')} Mbit/s · ${d.transkodierung.profil}`
                    + (d.transkodierung.tonemap ? ' · HDR→SDR' : '') + (d.grund ? ` (Grund: ${d.grund})` : '');
            const QT = { original: ['Original', 'Direct Play/Stream, wenn möglich'], 2160: ['4K', '30 Mbit/s'], 1080: ['1080p', '10 Mbit/s'], 720: ['720p', '4 Mbit/s'], 480: ['480p', '1,5 Mbit/s'] };
            const einst = { original: 'Original', 1080: '1080p', 720: '720p', 480: '480p' }[d.qualitaet_einstellung] || d.qualitaet_einstellung;
            const qualitaet = [
                wahl('Automatisch', !this.qualitaetWahl, () => { this.qualitaetWahl = null; this.neuStarten({ qualitaet: null }); }, `wie eingestellt: ${einst}`),
                (d.qualitaeten || []).map((k) => wahl(QT[k][0], this.qualitaetWahl === k, () => { this.qualitaetWahl = k; this.neuStarten({ qualitaet: k }); }, QT[k][1])),
            ];
            setzen(
                el('h3', 'Qualität'),
                qualitaet,
                el('div.info-text', info, quelleText ? el('div', 'Quelle: ' + quelleText) : null),
                d.modus !== 'hls' ? wahl('Umwandeln erzwingen', false, () => this.neuStarten({ erzwinge_transkodieren: true })) : null,
                wahl('Diagnose anzeigen', !!this.diagLiveAus, () => { this.panelEl.hidden = true; this.diagLive(); }, 'Taste I'),
                el('h3', 'Nachtmodus'),
                ['aus', 'leicht', 'stark'].map((n) => wahl({ aus: 'Aus (Ton unverändert)', leicht: 'Leicht', stark: 'Stark' }[n], this.nacht === n, () => { this.nacht = n; this.tonKette(); this.panel('einstellungen'); this.panel('einstellungen'); })),
                el('h3', 'Dialog-Anhebung'),
                [0, 2, 4, 6].map((db) => wahl(db ? `+${db} dB` : 'Aus', this.dialogDb === db, () => { this.dialogDb = db; this.tonKette(); this.panel('einstellungen'); this.panel('einstellungen'); })),
                this.admin ? [
                    el('h3', 'Marker setzen (Admin)'),
                    wahl('Intro beginnt hier', false, () => this.markerSetzen('intro', 'start')),
                    wahl('Intro endet hier', false, () => this.markerSetzen('intro', 'ende')),
                    wahl('Abspann beginnt hier', false, () => this.markerSetzen('abspann', 'start')),
                    d.marker?.intro ? wahl('Intro-Marker löschen', false, () => this.markerLoeschen('intro'), d.marker.intro.quelle) : null,
                    d.marker?.abspann ? wahl('Abspann-Marker löschen', false, () => this.markerLoeschen('abspann'), d.marker.abspann.quelle) : null,
                ] : null);
        }
        this.panelEl.classList.toggle('zweispaltig', art === 'spuren');
        this.panelEl.hidden = false;
        this.wach();
    }

    async neuStarten(extra) {
        this.panelEl.hidden = true;
        const pos = Math.round(this.pos() * 1000);
        this.ziel = { ...this.ziel, datei_id: this.daten.datei_id };
        await this.starten({ start_ms: pos, ton: this.daten.ton, untertitel: this.daten.untertitel_aktiv ?? 'aus', ...(this.qualitaetWahl ? { qualitaet: this.qualitaetWahl } : {}), ...extra });
    }

    async markerSetzen(art, teil) {
        const t = Math.round(this.pos() * 1000);
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
        if (!d || !this.pos()) return;
        const daten = { art: d.art, id: d.id, datei_id: d.datei_id, position_ms: Math.round(this.pos() * 1000), dauer_ms: d.dauer_ms, sitzung: d.sitzung || null };
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
        this.mse?.beenden();
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
        if (this.daten?.sitzung) api('stream/' + this.daten.sitzung, 'DELETE').catch(() => {});
        this.audio?.ctx.close?.();
        this.diagLos?.();
        this.diagLiveAus?.();
        this.wurzel.remove();
        document.body.style.overflow = '';
        if (aktiv === this) { aktiv = null; diagEnde(); }
        if (neuLaden) this.app.neuLaden();
    }
}
