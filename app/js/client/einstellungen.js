// Profil › Windows-Client: Tonweg (Engine / mpv / Bitstream), Ausgabe der Engine (aus Amberwave übernommen: Geräte,
// ASIO-Ausgänge, Lautsprecher-Manager, Kanal-EQ), Bild, Updates und Client-Optionen. Im Browser: Download des Clients.
'use strict';
import { el, meldung, bestaetigen } from '../ui.js';
import { api } from '../api.js';
import { nativ } from './nativ.js';

const WEGE = [
    ['engine', 'Bluewave-Engine', 'WASAPI geteilt/exklusiv oder ASIO, mit Lautsprecher-Manager, Delay, Pegel, Subwoofer und Kanal-EQ. Der Server liefert den Ton verlustfrei als PCM.'],
    ['mpv', 'mpv (WASAPI)', 'mpv spielt den Ton selbst, auf Wunsch exklusiv. Am wenigsten Umwege, ohne Lautsprecher-Manager.'],
    ['bitstream', 'Bitstream zum Receiver', 'Dolby Digital, Dolby TrueHD (Atmos), DTS und DTS-HD gehen unverändert per HDMI/S/PDIF an den AV-Receiver. Lautstärke regelt der Receiver.'],
];
const FORMATE = [['ac3', 'Dolby Digital'], ['eac3', 'Dolby Digital Plus'], ['truehd', 'Dolby TrueHD / Atmos'], ['dts', 'DTS'], ['dts-hd', 'DTS-HD MA']];

const zeile = (titel, text, regler) => el('div.client-zeile', el('div', el('b', titel), text ? el('p', text) : null), regler);

/** Browser: Hinweis und Download, wenn das Image einen Client mitbringt */
async function downloadKarte() {
    let info = null;
    try { info = await api('client/version'); } catch { return null; }
    if (!info?.version) return null;
    return el('section.karte.glass-panel.client-karte', el('h2', 'Windows-Client'),
        el('p.leise', 'Spielt jede Datei unverändert mit mpv ab – ohne Umwandeln, mit allen Ton- und Untertitelspuren, HDR und Ton über WASAPI exklusiv, ASIO oder als Bitstream zum AV-Receiver. Updates kommen später direkt über diesen Server.'),
        el('div.client-download',
            el('a.knopf.haupt', { href: '/api/v1/client/download', download: info.datei }, `Herunterladen (${info.version})`),
            el('span.leise', `${(info.groesse / 1048576).toFixed(0)} MB · Windows 10/11 (64 Bit)`),
            el('a.leise', { href: 'https://github.com/lfrank95/bluewave/releases', target: '_blank', rel: 'noopener' }, 'oder bei GitHub')));
}

/** Zustand der Engine-Ausgabe für die übernommene Amberwave-Sektion (Format, Anlauf, Aussetzer) */
function ausgabeZustand() {
    const audio = new EventTarget();
    const pl = {
        audio, track: null, nativAusgabe: {}, nativGeraete: [], spielt: false,
        pausieren() {}, ausgangBassLaden() {},
        bewertung() {
            const f = audio.format;
            if (!f) return { stufe: 'transparent', grund: '' };
            return (f.asio || f.exklusiv) && !f.umgerechnet ? { stufe: 'bitgenau', grund: '' } : { stufe: f.umgerechnet ? 'veraendert' : 'transparent', grund: f.umgerechnet ? 'Abtastrate wird umgerechnet' : 'Windows mischt' };
        },
        nativAusgabeSetzen(w) { nativ.ausgabeSetzen(w); pl.nativAusgabe = { ...pl.nativAusgabe, ...w }; },
    };
    const uebernehmen = (s) => {
        if (!s) return;
        if (s.format) audio.format = s.format;
        if (s.anlauf) audio.anlaufLetzt = s.anlauf;
        audio.aussetzerZahl = s.aussetzer || 0;
    };
    nativ.ausgabeStatus?.().then((s) => { uebernehmen(s); audio.dispatchEvent(new Event('nativformat')); }).catch(() => {});
    const aus = nativ.auf((m) => {
        if (m.e === 'format') { audio.format = m; audio.dispatchEvent(new Event('nativformat')); }
        else if (m.e === 'anlauf') { audio.anlaufLetzt = m; audio.dispatchEvent(new Event('nativformat')); }
        else if (m.e === 'aussetzer') audio.aussetzerZahl = (audio.aussetzerZahl || 0) + 1;
    });
    return { pl, aus };
}

/** Client: Tonweg, Ausgabe, Bild, Updates, Optionen */
async function clientKarten() {
    const v = await nativ.video.einst();
    const karten = [];

    // ---- Tonweg ----
    const wegeEl = el('div.client-wege');
    const mpvKarte = el('div');
    const engineKarte = el('div');
    const wegZeigen = () => {
        wegeEl.replaceChildren(...WEGE.map(([w, titel, text]) => el('button.client-weg', { type: 'button', 'aria-pressed': String(v.ton_weg === w),
            onclick: async () => { Object.assign(v, await nativ.video.einstSetzen({ ton_weg: w })); wegZeigen(); meldung(`Ton: ${titel}`); } }, el('b', titel), el('span', text))));
        mpvKarte.hidden = v.ton_weg === 'engine';
        lfeZeile.hidden = v.ton_weg === 'bitstream';   // erst nach dem Aufbau aufgerufen
        engineKarte.hidden = v.ton_weg !== 'engine';
        mpvZeigen();
    };
    const geraetWahl = el('select.eingabe');
    const exklusiv = el('input', { type: 'checkbox' });
    const formate = FORMATE.map(([w, name]) => [w, el('input', { type: 'checkbox' }), name]);
    const formatBox = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px' } }, formate.map(([, c, name]) => el('label.schalter', c, name)));
    const mpvZeigen = () => {
        geraetWahl.replaceChildren(el('option', { value: 'auto' }, 'Windows-Standardgerät'),
            ...(v.mpv_geraete || []).filter((g) => g.id !== 'auto').map((g) => el('option', { value: g.id, selected: g.id === v.mpv_geraet }, g.name)));
        geraetWahl.value = v.mpv_geraet || 'auto';
        exklusiv.checked = !!v.mpv_exklusiv;
        for (const [w, c] of formate) c.checked = (v.spdif || []).includes(w);
        formatBox.parentElement && (formatBox.closest('.client-zeile').hidden = v.ton_weg !== 'bitstream');
        exklusiv.closest('.client-zeile') && (exklusiv.closest('.client-zeile').hidden = v.ton_weg === 'bitstream');
    };
    const mpvSpeichern = async () => {
        Object.assign(v, await nativ.video.einstSetzen({ mpv_geraet: geraetWahl.value, mpv_exklusiv: exklusiv.checked, spdif: formate.filter(([, c]) => c.checked).map(([w]) => w) }));
        meldung('Übernommen – gilt ab dem nächsten Abspielen.');
    };
    geraetWahl.addEventListener('change', mpvSpeichern);
    exklusiv.addEventListener('change', mpvSpeichern);
    formate.forEach(([, c]) => c.addEventListener('change', mpvSpeichern));
    mpvKarte.append(
        zeile('Ausgabegerät', 'Für Bitstream das Gerät am HDMI- bzw. S/PDIF-Ausgang zum Receiver wählen.', geraetWahl),
        zeile('Exklusiv', 'mpv belegt das Gerät allein (an der Windows-Mischung vorbei). Andere Programme sind solange stumm.', el('label.schalter', exklusiv, 'An')),
        zeile('Formate, die der Receiver kann', 'Alles andere wandelt mpv in PCM. Im Zweifel nur Dolby Digital und DTS anhaken.', formatBox));

    // Ausgabe der Engine: übernommene Amberwave-Sektion
    const ausgabeBox = el('div.einst-ausgabe');
    engineKarte.append(ausgabeBox);
    const steuer = new AbortController();
    const { pl, aus } = ausgabeZustand();
    steuer.signal.addEventListener('abort', aus);
    import('./ausgabe_amberwave.js').then(({ ausgabeZeichnen }) => ausgabeZeichnen(ausgabeBox, steuer.signal, pl)).catch((x) => {
        ausgabeBox.replaceChildren(el('p.leise', 'Ausgabe-Einstellungen nicht verfügbar: ' + x.message));
    });
    // Seite verlassen → Beobachter weg
    let warDa = false;
    const wache = setInterval(() => {
        if (ausgabeBox.isConnected) { warDa = true; return; }
        if (warDa) { steuer.abort(); clearInterval(wache); }
    }, 2000);

    // LFE ohne Subwoofer: weglassen (wie Dolby-Downmix) oder auf die Front – gilt für Engine und mpv, nicht bei Bitstream
    const lfeWahl = el('select.eingabe', {}, el('option', { value: 'aus' }, 'Weglassen (wie Dolby-Downmix)'), el('option', { value: 'an' }, 'Auf die Front-Lautsprecher'));
    lfeWahl.value = v.lfe_front ? 'an' : 'aus';
    const lfePegel = el('input.eingabe', { type: 'number', min: -20, max: 6, step: 1, value: v.lfe_db || 0, style: { width: '90px' } });
    const lfePegelBox = el('span', { hidden: !v.lfe_front }, lfePegel, ' dB');
    const lfeSpeichern = async () => {
        Object.assign(v, await nativ.video.einstSetzen({ lfe_front: lfeWahl.value === 'an', lfe_db: Number(lfePegel.value) || 0 }));
        lfePegelBox.hidden = !v.lfe_front;
        lfePegel.value = v.lfe_db;
        meldung(v.lfe_front ? `LFE auf die Front, ${v.lfe_db > 0 ? '+' : ''}${v.lfe_db} dB gegenüber der Norm.` : 'LFE ohne Subwoofer: weggelassen.');
    };
    lfeWahl.addEventListener('change', lfeSpeichern);
    lfePegel.addEventListener('change', lfeSpeichern);
    const lfeZeile = zeile('LFE ohne Subwoofer', 'Wenn der Film mehr Kanäle hat als deine Lautsprecher und kein Subwoofer eingerichtet ist (z. B. 5.1 auf Quadro oder Stereo). 0 dB = nach Norm (wie mit Sub); die Engine regelt kurz herunter, statt zu übersteuern. Mit Subwoofer im Lautsprecher-Manager geht der LFE immer zum Sub.',
        el('div.client-download', lfeWahl, lfePegelBox));

    const versatz = el('input.eingabe', { type: 'number', min: -500, max: 500, step: 5, value: v.versatz_ms || 0, style: { width: '120px' } });
    versatz.addEventListener('change', async () => { Object.assign(v, await nativ.video.einstSetzen({ versatz_ms: Number(versatz.value) || 0 })); meldung('Ton-Versatz übernommen.'); });

    karten.push(el('section.karte.glass-panel.client-karte', el('h2', 'Ton im Windows-Client'),
        wegeEl, mpvKarte, lfeZeile,
        zeile('Ton-Versatz', 'Plus: Ton später, minus: früher (z. B. wenn der Fernseher das Bild verzögert).', el('span', versatz, ' ms'))));
    karten.push(el('section.client-ausgabe', engineKarte));

    // ---- Bild ----
    const hwdec = el('select.eingabe', {}, [['auto-safe', 'Grafikkarte (empfohlen)'], ['no', 'Prozessor (bei Bildfehlern)']].map(([w, t]) => el('option', { value: w, selected: v.hwdec === w }, t)));
    hwdec.addEventListener('change', async () => { Object.assign(v, await nativ.video.einstSetzen({ hwdec: hwdec.value })); meldung('Übernommen – gilt ab dem nächsten Abspielen.'); });
    const vollbild = el('input', { type: 'checkbox', checked: !!v.vollbild });
    vollbild.addEventListener('change', async () => { Object.assign(v, await nativ.video.einstSetzen({ vollbild: vollbild.checked })); });
    karten.push(el('section.karte.glass-panel.client-karte', el('h2', 'Bild'),
        zeile('Dekodieren', 'Die Grafikkarte dekodiert HEVC, AV1 und 4K sparsam. HDR zeigt mpv auf HDR-Bildschirmen direkt, sonst rechnet es sauber auf SDR um.', hwdec),
        zeile('Im Vollbild starten', 'Sonst öffnet der Film in der Größe des Bluewave-Fensters (F oder Doppelklick schaltet um).', el('label.schalter', vollbild, 'An'))));

    // ---- Flüssige Bewegung (Test): NVIDIA Smooth Motion ----
    karten.push(bewegungKarte(v));

    // ---- Client ----
    const ce = await nativ.clientEinst();
    const tray = el('input', { type: 'checkbox', checked: !!ce?.tray });
    const autostart = el('input', { type: 'checkbox', checked: !!ce?.autostart });
    tray.addEventListener('change', () => nativ.clientEinstSetzen({ tray: tray.checked }));
    autostart.addEventListener('change', () => nativ.clientEinstSetzen({ autostart: autostart.checked }));
    const updateText = el('span.leise');
    const quelle = el('select.eingabe', {}, el('option', { value: 'github' }, 'GitHub (neueste Version sofort)'), el('option', { value: 'server' }, 'Bluewave-Server (passend zum Server)'));
    quelle.value = ce?.update_quelle === 'server' ? 'server' : 'github';
    quelle.addEventListener('change', async () => {
        await nativ.clientEinstSetzen({ update_quelle: quelle.value });
        meldung(quelle.value === 'github' ? 'Updates kommen jetzt von GitHub.' : 'Updates kommen jetzt vom Bluewave-Server.');
        setTimeout(async () => updateZeigen(await nativ.update.info()), 2500);
    });
    const updateKnopf = el('button.knopf.klein', 'Nach Updates suchen');
    const updateZeigen = (u) => {
        if (u?.stand === 'laedt') { updateText.textContent = `Lade Version ${u.version} … ${u.prozent || 0} %`; updateKnopf.disabled = true; return; }
        if (u?.stand === 'startet') { updateText.textContent = 'Installiere – der Client startet gleich neu …'; updateKnopf.disabled = true; return; }
        updateKnopf.disabled = false;
        if (u?.version) {
            updateText.textContent = u.stand === 'fehler' ? `Update fehlgeschlagen: ${u.fehler}` : `Neue Version ${u.version} verfügbar${u.quelle === 'github' ? ' (GitHub)' : u.quelle === 'server' ? ' (Server)' : ''}.`;
            updateKnopf.textContent = 'Jetzt aktualisieren';
            updateKnopf.onclick = () => nativ.update.installieren();
        } else {
            updateText.textContent = `Installiert: ${nativ.version}`;
            updateKnopf.textContent = 'Nach Updates suchen';
            updateKnopf.onclick = async () => {
                updateKnopf.disabled = true;
                const r = await nativ.update.suchen();
                updateKnopf.disabled = false;
                if (!r?.ok) { meldung('Der Server ist gerade nicht erreichbar.', true); return; }
                if (!r.update) meldung('Der Client ist auf dem neuesten Stand.');
                updateZeigen(r.update);
            };
        }
    };
    updateZeigen(await nativ.update.info());
    const updateAus = nativ.update.auf(updateZeigen);
    steuer.signal.addEventListener('abort', updateAus);
    karten.push(el('section.karte.glass-panel.client-karte', el('h2', 'Windows-Client'),
        zeile('Updates', 'Neue Versionen kommen von GitHub (Releases im Bluewave-Repo) oder vom eigenen Bluewave-Server, der sie mit jedem Server-Update mitbringt. Ist die gewählte Quelle nicht erreichbar, fragt der Client die andere.', el('div.client-download', updateText, updateKnopf)),
        zeile('Update-Quelle', null, quelle),
        zeile('Im Infobereich weiterlaufen', 'Schließen versteckt das Fenster nur; Beenden über das Symbol im Infobereich.', el('label.schalter', tray, 'An')),
        zeile('Mit Windows starten', 'Startet unsichtbar im Infobereich.', el('label.schalter', autostart, 'An')),
        zeile('Server', 'Anderen Bluewave-Server wählen oder die Adresse ändern.', el('button.knopf.klein', { onclick: async () => {
            if (await bestaetigen('Server wechseln?', 'Der Client zeigt die Serversuche.', 'Wechseln')) nativ.serverWechseln();
        } }, 'Server wechseln …')),
        zeile('Fehlersuche', 'Log von Client, mpv und Engine; die Diagnosedatei landet auf dem Desktop.', el('div.client-download',
            el('button.knopf.klein', { onclick: () => nativ.logOeffnen() }, 'Log-Ordner'),
            el('button.knopf.klein', { onclick: async () => { const r = await nativ.diagnose(); if (r?.ok) meldung('Diagnosedatei auf dem Desktop gespeichert.'); else meldung(r?.text || 'Fehlgeschlagen', true); } }, 'Diagnosedatei')))));
    wegZeigen();
    return karten;
}

/** Flüssige Bewegung (Test): NVIDIA Smooth Motion für bluewave-mpv.exe im Treiber-Profil, dazu Renderer und Takt von mpv */
function bewegungKarte(v) {
    const auswahl = (paare, wert) => { const s = el('select.eingabe', {}, paare.map(([w, t]) => el('option', { value: w }, t))); s.value = String(wert); return s; };
    const haken = (an) => el('input', { type: 'checkbox', checked: !!an });
    const modus = auswahl([['aus', 'Aus'], ['smooth', 'NVIDIA Smooth Motion (Treiber, 2×)'], ['rife', 'RIFE (KI, 2× bis 5×)']], v.bewegung);
    const renderer = auswahl([['d3d11', 'Direct3D 11 (empfohlen)'], ['vulkan', 'Vulkan (Smooth Motion erst ab RTX 50)']], v.renderer);
    const vsync = haken(v.vsync);
    const sync = auswahl([['audio', 'Nach dem Ton (Standard)'], ['display-resample', 'Nach dem Bildschirm (display-resample)']], v.mpv_sync);
    const interp = haken(v.mpv_interpolation);
    const balken = haken(v.sm_balken);
    const logStufe = auswahl([[0, 'Aus'], [1, 'Fehler'], [2, 'Normal'], [3, 'Ausführlich']], v.sm_log);
    const status = el('span.leise', 'Prüfe Treiber …');
    const eintragen = el('button.knopf.klein', 'Im Treiber eintragen');
    const optionen = el('div');

    const statusZeigen = (r) => {
        const nv = r?.nv;
        const g = r?.gpu;
        if (!nv || nv.nvidia === false) { status.textContent = nv?.fehler ? `Keine NVIDIA-Grafikkarte (${nv.fehler})` : 'Keine NVIDIA-Grafikkarte erkannt'; eintragen.disabled = true; return; }
        eintragen.disabled = false;
        const soll = v.bewegung === 'smooth';
        const passt = !!nv.an === soll && (!soll || (!!nv.balken === !!v.sm_balken && Number(nv.log || 0) === Number(v.sm_log)));
        status.textContent = `${g?.name ? g.name + ' · ' : ''}Treiber-Profil: ${nv.profil ? (nv.an ? 'Smooth Motion an' : 'Smooth Motion aus') : 'noch nicht angelegt'}${passt ? '' : ' – weicht ab, bitte eintragen'}`;
        eintragen.classList.toggle('haupt', !passt);
        eintragen.textContent = soll ? 'Im Treiber eintragen' : 'Im Treiber ausschalten';
    };
    const pruefen = (frisch) => nativ.video.bewegungStatus?.(frisch).then(statusZeigen).catch(() => { status.textContent = 'Status nicht lesbar'; });
    const speichern = async (w, text) => {
        Object.assign(v, await nativ.video.einstSetzen(w));
        optionen.hidden = v.bewegung !== 'smooth';
        rifeBox.hidden = v.bewegung !== 'rife';
        interp.disabled = v.mpv_sync !== 'display-resample';
        pruefen(false);
        meldung(text || 'Übernommen – gilt ab dem nächsten Abspielen.');
    };
    modus.addEventListener('change', () => speichern({ bewegung: modus.value }, {
        smooth: 'Smooth Motion gewählt – jetzt noch „Im Treiber eintragen“.',
        rife: 'RIFE gewählt – falls noch nicht geschehen: einrichten und vorbereiten. Smooth Motion im Treiber dann ausschalten.',
    }[modus.value] || 'Aus – trage Smooth Motion gegebenenfalls auch im Treiber aus.'));
    renderer.addEventListener('change', () => speichern({ renderer: renderer.value }));
    vsync.addEventListener('change', () => speichern({ vsync: vsync.checked }));
    sync.addEventListener('change', () => speichern({ mpv_sync: sync.value }));
    interp.addEventListener('change', () => speichern({ mpv_interpolation: interp.checked }));
    balken.addEventListener('change', () => speichern({ sm_balken: balken.checked }, 'Gemerkt – wird beim Eintragen in den Treiber geschrieben.'));
    logStufe.addEventListener('change', () => speichern({ sm_log: Number(logStufe.value) }, 'Gemerkt – wird beim Eintragen in den Treiber geschrieben.'));
    eintragen.addEventListener('click', async () => {
        eintragen.disabled = true;
        status.textContent = 'Windows fragt nach Admin-Rechten …';
        const r = await nativ.video.bewegungEintragen();
        if (r?.ok) meldung(v.bewegung === 'smooth' ? 'Smooth Motion ist im Treiber eingetragen – gilt ab dem nächsten Abspielen.' : 'Smooth Motion im Treiber ausgeschaltet.');
        else meldung(r?.fehler || 'Eintragen fehlgeschlagen', true);
        statusZeigen(r);
    });
    const rifeBox = rifeBereich(v, speichern);
    optionen.hidden = v.bewegung !== 'smooth';
    rifeBox.hidden = v.bewegung !== 'rife';
    interp.disabled = v.mpv_sync !== 'display-resample';
    optionen.append(
        zeile('Faktor', 'Smooth Motion erzeugt immer genau ein Zwischenbild zwischen zwei echten Bildern – 2× ist fest vom Treiber vorgegeben. 3× oder 4× gibt es nur bei DLSS-Multi-Frame-Generation, und die muss ein Spiel selbst einbauen; für Videos ist sie nicht verfügbar.', el('b', '2× (fest)')),
        zeile('Renderer', 'Smooth Motion greift bei Direct3D 11/12; Vulkan nur auf RTX-50-Karten.', renderer),
        zeile('VSync', 'Halbiert Smooth Motion die Bildrate, hilft oft VSync aus (NVIDIA-Empfehlung). Mit G-Sync/FreeSync meist unnötig.', el('label.schalter', vsync, 'An')),
        zeile('Testbalken', 'Der Treiber zeichnet farbige Balken auf erzeugte Bilder – so siehst du, ob Smooth Motion wirklich arbeitet.', el('label.schalter', balken, 'An')),
        zeile('Treiber-Log', 'Schreibt nach C:\\NvPresent\\; die letzten Zeilen zeigt der Bildmonitor.', logStufe));
    pruefen(true);
    return el('section.karte.glass-panel.client-karte', el('h2', 'Flüssige Bewegung (Test)'),
        el('p.leise', 'Versuch: Die Grafikkarte rechnet Zwischenbilder, aus 24 fps werden z. B. 48 oder 120 fps. Das wirkt flüssiger, kann aber den „Seifenoper-Effekt“ und bei schnellen Szenen Artefakte bringen. Im Player zeigt Taste B den Bildmonitor.'),
        zeile('Modus', 'Smooth Motion steckt im NVIDIA-Treiber (fest 2×, Profil „Bluewave Wiedergabe“, Eintragen braucht Admin-Rechte). RIFE rechnet mit einem KI-Modell über TensorRT, in mpv eingebunden, mit wählbarem Faktor.', modus),
        zeile('Smooth Motion im Treiber', null, el('div.client-download', status, eintragen)),
        optionen,
        rifeBox,
        zeile('mpv-Takt', 'Nach dem Bildschirm passt mpv das Tempo minimal an die Bildwiederholrate an – Voraussetzung für die eigene Interpolation von mpv.', sync),
        zeile('mpv-Interpolation', 'Glättet nur das Ruckeln durch unpassende Bildwiederholraten (z. B. 24 fps auf 60 Hz) – erzeugt keine echten Zwischenbilder. Nur mit „Nach dem Bildschirm“.', el('label.schalter', interp, 'An')));
}

/** RIFE: Einrichten (Download ≈ 3 GB), Vorbereiten (TensorRT-Engines), Messen und die Einstellungen */
function rifeBereich(v, speichern) {
    const r = nativ.video.rife;
    const box = el('div.rife-box');
    if (!r) { box.append(el('p.leise', 'Dieser Client kann noch kein RIFE.')); return box; }
    const auswahl = (paare, wert) => { const s = el('select.eingabe', {}, paare.map(([w, t]) => el('option', { value: w }, t))); s.value = String(wert); return s; };
    const MODELLE = [['v4_6', 'RIFE 4.6 – schnell, Standard'], ['v4_25_lite', 'RIFE 4.25 lite – neuer, schnell'], ['v4_25', 'RIFE 4.25 – beste Qualität, schwer'], ['v4_26', 'RIFE 4.26 – beste Qualität, schwer']];
    const standText = el('span.leise', 'Prüfe …');
    const fortschritt = el('progress', { max: 100, value: 0, hidden: true, style: { width: '100%' } });
    const arbeitText = el('p.leise.rife-arbeit', { hidden: true });
    const einrichten = el('button.knopf.klein.haupt', 'RIFE einrichten (ca. 3 GB)');
    const vorbereiten = el('button.knopf.klein', 'Vorbereiten');
    const messen = el('button.knopf.klein', 'Messen (4K)');
    const entfernen = el('button.knopf.klein', 'Entfernen');
    const messung = el('span.leise');
    const faktor = auswahl([[2, '2× (24 → 48 fps)'], [3, '3× (24 → 72 fps)'], [4, '4× (24 → 96 fps)'], [5, '5× (24 → 120 fps)']], v.rife_faktor ?? 2);
    const modell = auswahl(MODELLE, v.rife_modell || 'v4_6');
    const modellLaden = el('button.knopf.klein', { hidden: true }, 'Modell laden');
    const v2 = el('input', { type: 'checkbox', checked: !!v.rife_v2 });
    const skala = auswahl([[1, 'Volle Auflösung (beste Qualität)'], [0.5, 'Halbe Auflösung (deutlich schneller, für 4K mit hohem Faktor)']], v.rife_skala ?? 1);
    const szene = auswahl([[0, 'Aus'], [0.08, 'Empfindlich'], [0.12, 'Normal'], [0.2, 'Unempfindlich']], v.rife_szene ?? 0.12);
    const maxFps = auswahl([[31, 'Bis 30 fps (Filme, Serien)'], [61, 'Bis 60 fps (auch 50/60-fps-Videos)']], v.rife_max_fps ?? 31);
    let laeuft = false;

    const zeigen = (st) => {
        if (!st) return;
        const a = st.arbeit;
        laeuft = !!(a && !a.fertig);
        fortschritt.hidden = !laeuft;
        fortschritt.value = a?.prozent || 0;
        arbeitText.hidden = !a;
        arbeitText.textContent = a ? (a.fehler ? `Fehler: ${a.fehler}` : a.text || '') : '';
        arbeitText.classList.toggle('fehler', !!a?.fehler);
        const bereit = st.vs && st.mlrt;
        standText.textContent = bereit
            ? `Eingerichtet · ${(st.groesse / 1073741824).toFixed(1).replace('.', ',')} GB · ${st.engines} Engine${st.engines === 1 ? '' : 's'} vorbereitet`
            : st.vs ? 'Teilweise eingerichtet – bitte fertig einrichten' : 'Nicht eingerichtet';
        einrichten.hidden = bereit;
        einrichten.disabled = laeuft;
        vorbereiten.hidden = messen.hidden = entfernen.hidden = !bereit;
        vorbereiten.disabled = messen.disabled = entfernen.disabled = laeuft;
        const m = st.modelle?.[modell.value];
        modellLaden.hidden = !bereit || !!m?.da;
        modellLaden.disabled = laeuft;
        if (a?.ergebnisse?.length && a.art === 'vorbereiten' && a.fertig && !a.fehler) arbeitText.textContent = 'Vorbereitet: ' + a.ergebnisse.map((x) => `${x.groesse.replace('x', '×')} in ${x.sekunden} s`).join(', ');
    };
    const ausfuehren = async (fn, ok) => {
        const e = await fn();
        if (e?.stand && 'vs' in e.stand) zeigen(e.stand);
        if (e?.ok) { if (ok) meldung(ok); } else meldung(e?.fehler || 'Fehlgeschlagen', true);
        return e;
    };
    einrichten.addEventListener('click', () => {
        einrichten.disabled = true;
        ausfuehren(() => r.einrichten(), 'RIFE ist eingerichtet – jetzt „Vorbereiten“.');
    });
    vorbereiten.addEventListener('click', () => ausfuehren(() => r.vorbereiten([[3840, 2160], [3840, 1600], [1920, 1080], [1920, 800]]), 'Vorbereitet für 4K und 1080p (auch Breitbild).'));
    messen.addEventListener('click', async () => {
        messung.textContent = 'Messe 4K … (beim ersten Mal inklusive Vorbereiten)';
        messen.disabled = true;
        const e = await ausfuehren(() => r.messen(3840, 2160));
        messen.disabled = false;
        const x = e?.stand;
        messung.textContent = e?.ok && x?.fps ? `4K: ${String(x.fps).replace('.', ',')} fps gerechnet, nötig ${String(x.ziel).replace('.', ',')} fps – ${x.fps >= x.ziel * 1.05 ? 'reicht' : 'zu langsam für Echtzeit'}` : '';
        if (e?.ok) r.stand().then((s2) => zeigen(s2.stand));
    });
    entfernen.addEventListener('click', async () => {
        if (!(await bestaetigen('RIFE entfernen?', 'Löscht Python, VapourSynth, vs-mlrt, Modelle und Engines aus dem RIFE-Ordner.', 'Entfernen'))) return;
        ausfuehren(() => r.entfernen(), 'RIFE entfernt.');
    });
    modellLaden.addEventListener('click', () => ausfuehren(() => r.modell(modell.value), 'Modell geladen – danach neu vorbereiten.'));
    faktor.addEventListener('change', () => speichern({ rife_faktor: Number(faktor.value) }));
    modell.addEventListener('change', async () => { await speichern({ rife_modell: modell.value }, 'Modell gewählt – neu „Vorbereiten“, sonst baut der erste Film die Engine (dauert Minuten).'); r.stand().then((e) => zeigen(e?.stand)); });
    v2.addEventListener('change', () => speichern({ rife_v2: v2.checked }, 'Übernommen – neu „Vorbereiten“.'));
    skala.addEventListener('change', () => speichern({ rife_skala: Number(skala.value) }, 'Übernommen – neu „Vorbereiten“.'));
    szene.addEventListener('change', () => speichern({ rife_szene: Number(szene.value) }));
    maxFps.addEventListener('change', () => speichern({ rife_max_fps: Number(maxFps.value) }));

    const aus = r.auf(zeigen);
    let warDa = false;
    const wache = setInterval(() => { if (box.isConnected) { warDa = true; return; } if (warDa) { aus(); clearInterval(wache); } }, 2000);
    r.stand().then((e) => zeigen(e?.stand));

    box.append(
        zeile('RIFE', 'Lädt Python, VapourSynth, vs-mlrt mit NVIDIA TensorRT und die RIFE-Modelle direkt von den Projektseiten (ca. 3 GB, ausgepackt mehr). Danach einmal „Vorbereiten“: TensorRT optimiert das Modell für deine Karte, pro Auflösung einige Minuten.',
            el('div.client-download', standText, einrichten, vorbereiten, messen, entfernen)),
        fortschritt, arbeitText,
        messung,
        zeile('Faktor', 'Auf deinem 240-Hz-Bildschirm passen alle gleichmäßig (48, 72, 96, 120 fps). Mehr Zwischenbilder = flüssiger, aber mehr Rechenlast und mehr „Video-Look“. 4K mit 5× schafft auch eine schnelle Karte wohl nur mit halber Auflösung bei der Bewegung.', faktor),
        zeile('Modell', 'Neuere Modelle liefern sauberere Kanten, rechnen aber länger. 4.6 ist im Paket, die anderen werden einzeln geladen (je ca. 20–50 MB).', el('div.client-download', modell, modellLaden)),
        zeile('Schnellere Umsetzung (v2)', 'Andere Umsetzung desselben Modells, laut Nutzern etwa 15–25 % schneller. Falls es Fehler gibt: aus.', el('label.schalter', v2, 'An')),
        zeile('Bewegung schätzen in', 'Das Bild bleibt immer in voller Auflösung; nur die Bewegungsschätzung läuft halb so groß.', skala),
        zeile('Szenenwechsel', 'An harten Schnitten statt eines verschmierten Zwischenbilds das echte Bild wiederholen.', szene),
        zeile('Anwenden auf', 'Videos mit mehr Bildern pro Sekunde bleiben unverändert.', maxFps),
        el('p.leise', 'Hinweis: Mit RIFE dekodiert mpv mit Rückkopie in den Arbeitsspeicher; Smooth Motion im Treiber sollte dabei aus sein. Der Bildmonitor (Taste B) zeigt, ob RIFE mithält.'));
    return box;
}

/** Abschnitte für das Profil: im Client die Einstellungen, im Browser der Download (oder nichts) */
export async function clientBereich() {
    if (nativ?.video?.einst) {
        try { return await clientKarten(); } catch (x) { return [el('section.karte.glass-panel', el('h2', 'Windows-Client'), el('p.leise', x.message))]; }
    }
    const k = await downloadKarte();
    return k ? [k] : [];
}
