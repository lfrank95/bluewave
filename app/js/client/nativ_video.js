// Windows-Client: Ersatz für das <video>-Element. Das Bild zeigt mpv in einem eigenen Fenster unter dieser (durchsichtigen)
// Seite, den Ton spielt mpv selbst oder die Bluewave-Engine (ASIO, WASAPI exklusiv, Lautsprecher-Manager).
// Die Schnittstelle bildet nach, was player.js vom <video>-Element benutzt: src/laden, play(), pause(), paused, ended,
// currentTime, duration, volume, muted, buffered, seekable, readyState, videoWidth/-Height und die üblichen Ereignisse.

/** TimeRanges-Ersatz */
class Bereiche {
    constructor(liste = []) { this.liste = liste; }
    get length() { return this.liste.length; }
    start(i) { return this.liste[i][0]; }
    end(i) { return this.liste[i][1]; }
}

export class NativVideo extends EventTarget {
    constructor(brücke) {
        super();
        this.b = brücke;
        this.element = document.createElement('div');   // Platzhalter im Player (das Bild liegt darunter)
        this.element.className = 'nativ-bild';
        this._zeit = 0;
        this._dauer = 0;
        this._pausiert = true;
        this._ende = false;
        this._laut = 1;
        this._stumm = false;
        this._puffer = 0;          // Sekunden voraus (Zwischenspeicher von mpv)
        this._bereit = 0;
        this._spult = false;
        this._breite = 0;
        this._hoehe = 0;
        this._verworfen = 0;
        this._bilder = 0;
        this.error = null;
        this.weg = brücke.tonWeg?.() || 'mpv';
        this.aus = brücke.auf((m) => this.meldung(m));
    }

    meldung(m) {
        const feuern = (n) => this.dispatchEvent(new Event(n));
        switch (m.e) {
            case 'geladen':
                this._dauer = m.dauer || this._dauer;
                this._breite = m.breite || 0;
                this._hoehe = m.hoehe || 0;
                this._bereit = 4;
                this.weg = m.ton_weg || this.weg;
                feuern('durationchange'); feuern('loadedmetadata'); feuern('loadeddata'); feuern('canplay');
                break;
            case 'zeit':
                this._zeit = m.pos;
                if (m.dauer) this._dauer = m.dauer;
                if (m.puffer != null) this._puffer = m.puffer;
                if (m.verworfen != null) this._verworfen = m.verworfen;
                if (m.bilder != null) this._bilder = m.bilder;
                feuern('timeupdate');
                if (m.puffer != null) feuern('progress');
                break;
            case 'pause':
                if (this._pausiert !== m.an) { this._pausiert = m.an; feuern(m.an ? 'pause' : 'play'); if (!m.an) feuern('playing'); }
                break;
            case 'warten':
                feuern(m.an ? 'waiting' : 'playing');
                break;
            case 'spult':
                this._spult = m.an;
                feuern(m.an ? 'seeking' : 'seeked');
                break;
            case 'ende':
                this._ende = true;
                this._pausiert = true;
                feuern('pause'); feuern('ended');
                break;
            case 'fehler':
                this.error = { code: 4, message: m.text || 'Wiedergabe nicht möglich' };
                feuern('error');
                break;
            case 'lautstaerke':
                this._laut = m.wert; this._stumm = !!m.stumm;
                feuern('volumechange');
                break;
            case 'ton_weg':
                this.weg = m.weg;
                break;
            default:
                this.dispatchEvent(new CustomEvent('nativ', { detail: m }));
        }
    }

    /** Datei/Strom laden: url relativ zum Server, start in s; spuren = { ton, untertitel } */
    laden(url, start = 0, spuren = {}) {
        this._ende = false;
        this.error = null;
        this._bereit = 0;
        this._zeit = start;
        this._pausiert = false;
        this.b.laden({ url: new URL(url, location.href).href, start, ...spuren });
    }

    play() { this._ende = false; this.b.befehl({ c: 'spielen' }); return Promise.resolve(); }
    pause() { this.b.befehl({ c: 'pause' }); }
    get paused() { return this._pausiert; }
    get ended() { return this._ende; }
    get seeking() { return this._spult; }
    get currentTime() { return this._zeit; }
    set currentTime(t) { this._zeit = Math.max(0, Number(t) || 0); this.b.befehl({ c: 'springen', pos: this._zeit }); }
    get duration() { return this._dauer || NaN; }
    get volume() { return this._laut; }
    set volume(v) { this._laut = Math.min(1, Math.max(0, Number(v) || 0)); this.b.befehl({ c: 'lautstaerke', wert: this._laut, stumm: this._stumm }); this.dispatchEvent(new Event('volumechange')); }
    get muted() { return this._stumm; }
    set muted(m) { this._stumm = !!m; this.b.befehl({ c: 'lautstaerke', wert: this._laut, stumm: this._stumm }); this.dispatchEvent(new Event('volumechange')); }
    get buffered() { return new Bereiche(this._dauer ? [[Math.max(0, this._zeit - 1), Math.min(this._dauer, this._zeit + this._puffer)]] : []); }
    get seekable() { return new Bereiche(this._dauer ? [[0, this._dauer]] : []); }
    get readyState() { return this._bereit; }
    get videoWidth() { return this._breite; }
    get videoHeight() { return this._hoehe; }
    get currentSrc() { return 'nativ'; }
    get textTracks() { return []; }
    getVideoPlaybackQuality() { return { totalVideoFrames: this._bilder, droppedVideoFrames: this._verworfen }; }
    querySelectorAll() { return []; }
    append() {}
    removeAttribute() {}
    load() {}

    /** Tonspur (Index unter den Tonspuren der Datei) */
    tonspur(index) { this.b.befehl({ c: 'ton', index }); }
    /** Untertitel: null = aus; { eingebettet, strom_index } oder { url } (Originaldatei bzw. WebVTT) */
    untertitel(u) { this.b.befehl({ c: 'untertitel', ...(u ? { eingebettet: !!u.eingebettet, index: u.index ?? null, url: u.url ? new URL(u.url, location.href).href : null } : { aus: true }) }); }
    /** Nachtmodus und Dialog-Anhebung (mpv-Filter bzw. vom Server für die Engine) */
    tonFilter(nacht, dialogDb) { this.b.befehl({ c: 'tonfilter', nacht, dialog: dialogDb }); }

    beenden() {
        this.aus?.();
        this.b.befehl({ c: 'stopp' });
    }
}
