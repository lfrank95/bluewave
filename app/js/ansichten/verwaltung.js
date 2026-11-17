// Verwaltung (nur Admin): Bibliothek, Universen, Aufräumen, Nutzer, Einstellungen, System
'use strict';
import { el, icon, meldung, feld, auswahl, bestaetigen, dialog, bild } from '../ui.js';
import { api } from '../api.js';
import { tmdbZuordnen } from './film.js';

export const titel = () => 'Verwaltung – Bluewave';

const REITER = [['bibliothek', 'Bibliothek'], ['universen', 'Universen'], ['aufraeumen', 'Aufräumen'], ['nutzer', 'Nutzer'], ['einstellungen', 'Einstellungen'], ['diagnose', 'Diagnose'], ['system', 'System']];
let abfrage = null;

export async function zeigen(r, app) {
    clearInterval(abfrage);
    if (app.konto.rolle !== 'admin') return el('div.leer', el('h2', 'Nur für Admins'));
    const reiter = r.teile[1] || 'bibliothek';
    const inhalt = await ({ bibliothek, universen, aufraeumen, nutzer, einstellungen, diagnose, system }[reiter] || bibliothek)(r, app);
    return el('div.seite',
        el('div.seiten-kopf', el('h1', 'Verwaltung')),
        el('nav.reiter', REITER.map(([k, t]) => el('a', { href: '#/verwaltung/' + k, class: k === reiter ? 'aktiv' : '' }, t))),
        inhalt);
}

// ---------- Bibliothek ----------
async function bibliothek() {
    const box = el('div');
    const AUFTRAEGE = [['alles', 'Alles prüfen', 'neu'], ['scan', 'Ordner einlesen', 'film'], ['metadaten_alle', 'Metadaten neu holen', 'info'],
        ['marker', 'Intro & Abspann erkennen', 'naechste'], ['untertitel', 'Untertitel suchen', 'untertitel']];
    const laden = async () => {
        const d = await api('bibliothek/status');
        const a = d.auftrag || {};
        const z = d.zahlen;
        const prozent = a.gesamt ? Math.round((a.fertig / a.gesamt) * 100) : 0;
        const erg = a.ergebnis || {};
        box.replaceChildren(
            !d.tmdb ? el('div.hinweis', 'Noch kein TMDB-Schlüssel eingetragen – ohne ihn gibt es keine Poster und Beschreibungen. ', el('a', { href: '#/verwaltung/einstellungen' }, 'Zu den Einstellungen')) : null,
            el('section.karte.glass-panel',
                el('div.status-zeile',
                    [['Filme', z.filme], ['Serien', z.serien], ['Folgen', z.folgen], ['Dateien', z.dateien], ['Intros erkannt', z.intros]].map(([t, w]) => el('div.wert', el('b', String(w)), el('span', t))),
                    z.fehlend ? el('div.wert', el('b.schlecht', String(z.fehlend)), el('span', 'Dateien fehlen')) : null),
                el('div.knoepfe', AUFTRAEGE.map(([art, text, ic]) => el('button.knopf' + (art === 'alles' ? '.haupt' : ''), { disabled: a.laeuft, onclick: async () => {
                    try {
                        await api('bibliothek/auftrag', 'POST', { art });
                        meldung('Gestartet.');
                        setTimeout(laden, 600);
                    } catch (x) { meldung(x.message, true); }
                } }, icon(ic), text))),
                a.laeuft ? el('div', { style: { marginTop: '16px' } },
                    el('b', a.schritt || 'Läuft …'), el('div.balken', el('span', { style: { width: prozent + '%' } })),
                    el('div.leise', { style: { fontSize: '0.85rem' } }, a.gesamt ? `${a.fertig} von ${a.gesamt}${a.text ? ' · ' + a.text : ''}` : (a.text || '')))
                    : el('p.leise', { style: { marginTop: '14px', fontSize: '0.88rem' } },
                        d.letzter_scan ? `Zuletzt geprüft: ${new Date(d.letzter_scan).toLocaleString('de-DE')}` : 'Noch nie eingelesen.',
                        a.ende ? ` · letzter Auftrag in ${a.dauer_s} s` : '',
                        erg.fehler ? el('span.schlecht', ' · Fehler: ' + erg.fehler) : null,
                        erg.metadaten?.fehler?.length ? el('span.schlecht', ' · ' + erg.metadaten.fehler.slice(0, 2).join(' · ')) : null,
                        erg.scan?.filme?.fehler ? el('span.schlecht', ' · ' + erg.scan.filme.fehler) : null,
                        erg.scan?.serien?.fehler ? el('span.schlecht', ' · ' + erg.scan.serien.fehler) : null)),
            offenListe('Filme ohne Zuordnung', d.offen.filme, 'film'),
            offenListe('Serien ohne Zuordnung', d.offen.serien, 'serie'));
        if (!a.laeuft) clearInterval(abfrage), abfrage = null;
        else if (!abfrage) abfrage = setInterval(() => { if (!document.body.contains(box)) { clearInterval(abfrage); abfrage = null; return; } laden(); }, 2000);
    };
    await laden();
    return box;
}

function offenListe(titel, liste, art) {
    if (!liste.length) return null;
    return el('section.karte.glass-panel', el('h2', `${titel} (${liste.length})`),
        el('p.leise', 'Offen = noch nicht abgeglichen, nicht gefunden = TMDB hatte keinen Treffer. Ordnernamen wie „Titel (Jahr)“ helfen.'),
        el('table.tabelle', liste.map((x) => el('tr',
            el('td', el('a', { href: `#/${art}/${x.id}` }, x.titel), x.jahr ? el('span.leise', ` (${x.jahr})`) : null),
            el('td.leise', x.metadaten_status === 'offen' ? 'offen' : 'nicht gefunden'),
            el('td', { style: { textAlign: 'right' } }, el('button.knopf.klein', { onclick: () => tmdbZuordnen(art, x.id, x.titel, x.jahr) }, 'Zuordnen'))))));
}

// ---------- Universen ----------
async function universen() {
    const d = await api('universen');
    const neuName = el('input.eingabe', { placeholder: 'Name, z. B. Marvel Cinematic Universe' });
    const anlegen = async () => {
        if (!neuName.value.trim()) return;
        try {
            const n = await api('universen', 'POST', { name: neuName.value.trim() });
            location.hash = `#/universum/${n.id}/bearbeiten`;
        } catch (x) { meldung(x.message, true); }
    };
    neuName.addEventListener('keydown', (e) => { if (e.key === 'Enter') anlegen(); });
    return el('div',
        el('div.karte.glass-panel', el('h2', 'Neues Universum'),
            el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, neuName, el('button.knopf.haupt', { onclick: anlegen }, icon('plus'), 'Anlegen')),
            el('p.leise', 'Bearbeitet wird im Universum selbst: Abschnitte, Reihenfolge per Ziehen, Suche und Vorschläge.')),
        d.universen.length ? el('table.tabelle', d.universen.map((u) => el('tr',
            el('td', el('a', { href: `#/universum/${u.id}` }, u.name)), el('td.leise', `${u.eintraege} Titel`),
            el('td', { style: { textAlign: 'right' } }, el('a.knopf.klein', { href: `#/universum/${u.id}/bearbeiten` }, icon('bearbeiten'), 'Bearbeiten'))))) : el('p.leise', 'Noch keine Universen.'));
}

async function aufraeumen() {
    const d = await api('aufraeumen/vorschau');
    const auswahlSet = new Set(d.liste.map((x) => x.datei_id));
    const ausfuehren = el('button.knopf.haupt', { disabled: !d.liste.length || !(d.moeglich.filme || d.moeglich.serien), onclick: async () => {
        if (!(await bestaetigen('Jetzt umbenennen?', `${auswahlSet.size} Dateien werden umbenannt bzw. verschoben. Externe Untertitel wandern mit.`, 'Ausführen'))) return;
        ausfuehren.disabled = true;
        try {
            const r = await api('aufraeumen/ausfuehren', 'POST', { ids: [...auswahlSet] });
            meldung(`${r.verschoben} Dateien verschoben.` + (r.fehler.length ? ' Fehler: ' + r.fehler[0] : ''), r.fehler.length > 0);
            window.__bluewave.neuLaden();
        } catch (x) { meldung(x.message, true); ausfuehren.disabled = false; }
    } }, `Ausgewählte umbenennen`);
    return el('section.karte.glass-panel', el('h2', 'Aufräumen'),
        el('p.leise', 'Benennt Dateien nach dem Schema aus den Einstellungen – erst Vorschau, dann Freigabe. Nur zugeordnete Titel.'),
        !d.moeglich.filme || !d.moeglich.serien ? el('div.hinweis', `Nur lesend eingebunden: ${[!d.moeglich.filme ? 'Filme' : null, !d.moeglich.serien ? 'Serien' : null].filter(Boolean).join(', ')}. `
            + 'Zum Aufräumen in der .env MEDIEN_MOUNT_MODUS=rw setzen (bzw. in der Unraid-Vorlage auf „Read/Write“), sobald Plex nicht mehr parallel läuft.') : null,
        d.liste.length ? el('div', el('div.knoepfe', { style: { marginTop: 0, marginBottom: '12px' } }, ausfuehren, el('span.leise', `${d.liste.length} Vorschläge`)),
            el('table.tabelle', el('tr', el('th', ''), el('th', 'Bisher'), el('th', 'Neu')),
                d.liste.map((x) => {
                    const cb = el('input', { type: 'checkbox', checked: true, onchange: () => (cb.checked ? auswahlSet.add(x.datei_id) : auswahlSet.delete(x.datei_id)) });
                    return el('tr', el('td', cb), el('td.leise', { style: { fontSize: '0.82rem', wordBreak: 'break-all' } }, x.alt), el('td', { style: { fontSize: '0.82rem', wordBreak: 'break-all' } }, x.neu));
                }))) : el('div.hinweis.gut', 'Alles ist schon ordentlich benannt.'));
}

// ---------- Nutzer ----------
async function nutzer(r, app) {
    const d = await api('nutzer');
    const neu = { name: el('input.eingabe'), anzeige: el('input.eingabe'), pw: el('input.eingabe', { type: 'password', autocomplete: 'new-password' }), rolle: auswahl({ nutzer: 'Nutzer', admin: 'Admin' }, 'nutzer') };
    return el('div',
        el('section.karte.glass-panel', el('h2', 'Familie'),
            el('table.tabelle', el('tr', el('th', 'Name'), el('th', 'Benutzername'), el('th', 'Rolle'), el('th', 'Geräte'), el('th', 'Zuletzt'), el('th', '')),
                d.nutzer.map((n) => el('tr',
                    el('td', el('b', n.anzeigename), n.aktiv ? null : el('span.schlecht', ' (gesperrt)')),
                    el('td.leise', n.benutzername),
                    el('td', n.id === app.konto.id ? n.rolle : auswahl({ nutzer: 'Nutzer', admin: 'Admin' }, n.rolle, { onchange: async (e) => { await api('nutzer/' + n.id, 'PUT', { rolle: e.target.value }); meldung('Gespeichert.'); } })),
                    el('td.leise', String(n.geraete)),
                    el('td.leise', n.letzter_login ? new Date(n.letzter_login.replace(' ', 'T')).toLocaleDateString('de-DE') : '–'),
                    el('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
                        el('button.icon-knopf', { title: 'Passwort setzen', onclick: async () => {
                            const pw = el('input.eingabe', { type: 'password', autocomplete: 'new-password' });
                            const ok = await dialog(`Neues Passwort für ${n.anzeigename}`, feld('Passwort', pw, 'Mindestens 8 Zeichen. Browser-Sitzungen werden abgemeldet, Fernseher bleiben gekoppelt.'),
                                [{ text: 'Abbrechen', wert: false }, { text: 'Setzen', haupt: true, aktion: async () => { try { await api('nutzer/' + n.id, 'PUT', { passwort: pw.value }); return true; } catch (x) { meldung(x.message, true); return false; } } }]);
                            if (ok) meldung('Passwort gesetzt.');
                        } }, icon('bearbeiten')),
                        n.id === app.konto.id ? null : el('button.icon-knopf', { title: n.aktiv ? 'Sperren' : 'Entsperren', onclick: async () => { await api('nutzer/' + n.id, 'PUT', { aktiv: !n.aktiv }); app.neuLaden(); } }, icon(n.aktiv ? 'schliessen' : 'haken')),
                        n.id === app.konto.id ? null : el('button.icon-knopf', { title: 'Löschen', onclick: async () => {
                            if (!(await bestaetigen('Nutzer löschen?', `${n.anzeigename} und der Fortschritt werden gelöscht.`, 'Löschen', true))) return;
                            await api('nutzer/' + n.id, 'DELETE');
                            app.neuLaden();
                        } }, icon('loeschen'))))))),
        el('section.karte.glass-panel', el('h2', 'Neues Familienmitglied'),
            el('div.feld-reihe', feld('Benutzername', neu.name), feld('Anzeigename', neu.anzeige), feld('Passwort', neu.pw, 'Mindestens 8 Zeichen'), feld('Rolle', neu.rolle)),
            el('div.knoepfe', el('button.knopf.haupt', { onclick: async () => {
                try {
                    await api('nutzer', 'POST', { benutzername: neu.name.value, anzeigename: neu.anzeige.value, passwort: neu.pw.value, rolle: neu.rolle.value });
                    meldung('Angelegt.');
                    app.neuLaden();
                } catch (x) { meldung(x.message, true); }
            } }, icon('plus'), 'Anlegen'))));
}

// ---------- Einstellungen ----------
async function einstellungen() {
    const { einstellungen: e } = await api('einstellungen');
    const f = {
        tmdb_schluessel: el('input.eingabe', { value: e.tmdb_schluessel, disabled: e.tmdb_aus_env, placeholder: 'API-Schlüssel (v3) oder Lese-Token (v4)' }),
        metadaten_sprache: auswahl({ 'de-DE': 'Deutsch', 'en-US': 'Englisch', 'fr-FR': 'Französisch', 'es-ES': 'Spanisch', 'it-IT': 'Italienisch' }, e.metadaten_sprache),
        scan_minuten: auswahl({ 0: 'Nur von Hand', 5: 'Alle 5 Minuten', 15: 'Alle 15 Minuten', 60: 'Stündlich', 360: 'Alle 6 Stunden', 1440: 'Täglich' }, e.scan_minuten),
        untertitel_auto: el('input', { type: 'checkbox', checked: e.untertitel_auto }),
        lokale_bilder: el('input', { type: 'checkbox', checked: e.lokale_bilder }),
        untertitel_sprachen: el('input.eingabe', { value: e.untertitel_sprachen }),
        opensubtitles_schluessel: el('input.eingabe', { value: e.opensubtitles_schluessel, disabled: e.opensubtitles_aus_env }),
        opensubtitles_benutzer: el('input.eingabe', { value: e.opensubtitles_benutzer, autocomplete: 'off' }),
        opensubtitles_passwort: el('input.eingabe', { type: 'password', value: e.opensubtitles_passwort, autocomplete: 'new-password' }),
        aufraeumen_film: el('input.eingabe', { value: e.aufraeumen_film }),
        aufraeumen_serie: el('input.eingabe', { value: e.aufraeumen_serie }),
    };
    const speichern = el('button.knopf.haupt', { onclick: async () => {
        const daten = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.type === 'checkbox' ? x.checked : x.value]));
        if (e.tmdb_aus_env) delete daten.tmdb_schluessel;
        try {
            await api('einstellungen', 'PUT', daten);
            meldung('Gespeichert.');
        } catch (x) { meldung(x.message, true); }
    } }, 'Speichern');
    return el('div',
        el('section.karte.glass-panel', el('h2', 'Metadaten'),
            feld('TMDB-Schlüssel', f.tmdb_schluessel, e.tmdb_aus_env ? 'Kommt aus der .env (TMDB_API_KEY).' : el('span', 'Kostenlos unter themoviedb.org → Einstellungen → API.')),
            el('div.feld-reihe', feld('Sprache der Texte', f.metadaten_sprache, 'Fehlt ein Text, wird Englisch genommen.'), feld('Ordner prüfen', f.scan_minuten, 'Neue Dateien werden automatisch eingelesen.')),
            el('label.schalter', { style: { marginTop: '14px' } }, f.lokale_bilder, 'Bilder aus den Medienordnern bevorzugen'),
            el('div.hilfe', 'poster/folder/cover.jpg, fanart/backdrop.jpg, logo/clearlogo.png, „Film-poster.jpg“, season01-poster.jpg, „Folge-thumb.jpg“ – wie bei Kodi, Plex und Jellyfin. Wird beim nächsten Scan übernommen.')),
        el('section.karte.glass-panel', el('h2', 'Untertitel'),
            el('label.schalter', f.untertitel_auto, 'Fehlende Untertitel automatisch von OpenSubtitles holen'),
            el('div.feld-reihe', { style: { marginTop: '14px' } },
                feld('Sprachen', f.untertitel_sprachen, 'ISO-Kürzel, z. B. „deu“ oder „deu,eng“. Bei Filmen mit deutscher Tonspur wird nichts geholt.'),
                feld('OpenSubtitles API-Schlüssel', f.opensubtitles_schluessel, 'Kostenlos unter opensubtitles.com → API Consumers.'),
                feld('OpenSubtitles Benutzer (optional)', f.opensubtitles_benutzer, 'Mit Anmeldung sind mehr Downloads am Tag möglich.'),
                feld('OpenSubtitles Passwort', f.opensubtitles_passwort))),
        el('section.karte.glass-panel', el('h2', 'Aufräum-Schema'),
            el('p.leise', 'Platzhalter: {titel} {jahr} {fassung} bzw. {serie} {staffel} {folge} {titel}. „{ - fassung}“ erscheint nur, wenn es eine besondere Fassung ist.'),
            feld('Filme', f.aufraeumen_film), feld('Serien', f.aufraeumen_serie)),
        el('div.knoepfe', speichern));
}

// ---------- System ----------
async function system() {
    const d = await api('system');
    const hw = d.hardware || {};
    const q = hw.quicksync || {};
    const ja = (t, b) => el('div.faehigkeit.' + (b ? 'ja' : 'nein'), icon(b ? 'haken' : 'schliessen'), t);
    const testErgebnis = el('div');
    const testZeigen = (t) => {
        if (!t) return testErgebnis.replaceChildren();
        testErgebnis.replaceChildren(el('table.tabelle', t.laeufe.map((l) => el('tr', el('td', l.name),
            el('td', { style: { textAlign: 'right' } }, l.ok ? el('b', `${String(l.echtzeit).replace('.', ',')}× Echtzeit · ${l.fps} fps`) : el('span.schlecht', l.fehler))))));
    };
    testZeigen(hw.test);
    return el('div',
        el('section.karte.glass-panel',
            el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                el('h2', { style: { margin: 0 } }, 'Transkodieren'), el('span.abzeichen' + (hw.aktiv && hw.aktiv !== 'software' ? '.hw' : ''), d.profile?.[hw.aktiv]?.name || '–')),
            el('p.leise', q.verfuegbar ? `Intel-Grafik ${q.geraet} · ${q.treiber || ''}` : `CPU mit ${hw.software?.threads || '?'} Threads`),
            (hw.warnungen || []).map((w) => el('div.hinweis', w)),
            el('div.faehigkeiten', q.verfuegbar
                ? [ja('HEVC 10-Bit dekodieren', q.dekodieren?.hevc10), ja('AV1 dekodieren', q.dekodieren?.av1), ja('H.264 kodieren', q.kodieren?.h264),
                    ja('HEVC kodieren', q.kodieren?.hevc), ja('AV1 kodieren', q.kodieren?.av1), ja('HDR-Tone-Mapping', q.tonemapping)]
                : [ja('H.264 (libx264)', hw.software?.h264), ja('HEVC (libx265)', hw.software?.hevc), ja('HDR-Tone-Mapping', hw.filter?.tonemapx || hw.filter?.zscale)]),
            el('div.knoepfe',
                el('button.knopf', { onclick: async (e) => { e.target.disabled = true; await api('system/hardware/erkennen', 'POST'); window.__bluewave.neuLaden(); } }, icon('neu'), 'Neu erkennen'),
                el('button.knopf.haupt', { onclick: async (e) => {
                    const b = e.currentTarget; b.disabled = true; b.textContent = 'Teste … (bis zu 1 Minute)';
                    try { testZeigen((await api('system/hardware/test', 'POST')).test); } catch (x) { meldung(x.message, true); }
                    b.disabled = false; b.textContent = 'Transkodierung testen';
                } }, 'Transkodierung testen')),
            testErgebnis,
            el('p.leise', { style: { fontSize: '0.85rem', marginTop: '12px' } }, `Das Profil stellst du in der Unraid-Vorlage bzw. in der .env ein (HWACCEL). Gerade laufen ${d.streams} Umwandlungen.`)),
        el('section.karte.glass-panel', el('h2', 'System'),
            el('table.tabelle',
                el('tr', el('td', 'Version'), el('td', d.version)),
                el('tr', el('td', 'Datenbank'), el('td', { class: d.datenbank.ok ? 'ok' : 'schlecht' }, d.datenbank.ok ? `${d.datenbank.version} · Schema ${d.datenbank.schema}` : d.datenbank.fehler)),
                el('tr', el('td', 'ffmpeg'), el('td', `${hw.ffmpeg?.version || '?'}${hw.ffmpeg?.jellyfin ? ' (jellyfin-ffmpeg)' : ''}`)),
                d.ordner.map((o) => el('tr', el('td', o.name), el('td', el('code', o.pfad), ' ', el('span', { class: o.da && o.lesbar ? 'ok' : 'schlecht' },
                    !o.da ? 'fehlt' : !o.lesbar ? 'nicht lesbar' : o.schreibbar ? 'lesen + schreiben' : 'nur lesen')))))));
}

// ---------- Diagnose: Zeitleisten der letzten Wiedergaben (Player + Server) ----------
const DIAG_NAMEN = {
    beginn: 'Abspielen geklickt', api_start_anfrage: 'Wiedergabe anfragen', api_start_antwort: 'Antwort: Wiedergabe', api_start_fehler: 'Fehler beim Start',
    start_entscheidung: 'Entscheidung', start_fehler: 'Fehler beim Start', strom_anfrage: 'Strom anfordern', strom_antwort: 'Strom: Antwort da',
    strom_erste_bytes: 'Strom: erste Daten', mse_bereit: 'Player bereit (Codec)', mse_erstes_bild_angehaengt: 'Erstes Bild im Puffer', strom_rate: 'Strom: Durchsatz',
    strom_vorrat_voll: 'Vorrat voll (Pause)', strom_ende: 'Strom zu Ende', strom_fehler: 'Strom-Fehler', strom_http_fehler: 'Strom: HTTP-Fehler', mse_fehler: 'MSE-Fehler',
    mse_speicher_voll: 'Browser-Speicher voll', remux_ffmpeg_gestartet: 'ffmpeg gestartet', remux_erste_bytes: 'ffmpeg: erste Daten', remux_stand: 'Server: Durchsatz',
    remux_ende: 'Server: Strom beendet', remux_alten_beendet: 'alten Strom beendet', remux_einfach_laden: 'einfacher Strom', hls_teil: 'HLS-Teil geladen',
    hls_teil_server: 'HLS-Teil (Server)', hls_fehler: 'HLS-Fehler', direkt_anfrage: 'Datei-Anfrage', untertitel_noch_nicht: 'Untertitel noch nicht fertig',
    video_loadstart: 'Video: lädt', video_loadedmetadata: 'Video: Metadaten', video_loadeddata: 'Video: erstes Bild', video_canplay: 'Video: spielbereit',
    video_playing: 'Video: läuft', video_waiting: 'Video: WARTET', warten_vorbei: 'Warten vorbei', video_pause: 'Pause', video_seeking: 'Spulen',
    video_seeked: 'Gespult', video_stalled: 'Video: Daten stocken', video_emptied: 'Video geleert', video_ended: 'Ende', video_fehler: 'VIDEO-FEHLER',
    stand: 'Stand', rueckfall_umwandeln: 'Rückfall: umwandeln', hls_neustart: 'Encoder neu gestartet', hls_ueberholt: 'alte Anfrage verworfen', ende: 'Player geschlossen', seite_verlassen: 'Seite verlassen',
};
const DIAG_SCHLECHT = /fehler|waiting|stalled|speicher_voll/i;
const diagSchlecht = (e) => DIAG_SCHLECHT.test(e.e) || (e.e === 'warten_vorbei' && e.d?.dauer_ms > 500)
    || (e.e === 'remux_ende' && (e.d?.ffmpeg_meldung || e.d?.grund === 'lesefehler'))
    || e.d?.anteil_warten_ffmpeg > 0.5 || e.d?.anteil_warten_senden > 0.5 || e.d?.warten_auf_netz_anteil > 0.5
    || (e.e === 'remux_erste_bytes' && e.d?.ms > 1500) || (e.e === 'api_start_antwort' && e.d?.dauer_ms > 1500);

function diagKurzUA(ua = '') {
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const o = /Web0S|webOS/.test(ua) ? 'LG webOS' : /Tizen/.test(ua) ? 'Samsung Tizen' : /AFT/.test(ua) ? 'Fire TV' : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${b}${o ? ' · ' + o : ''}`;
}

function diagDaten(d) {
    return Object.entries(d || {}).filter(([k, v]) => v !== null && v !== undefined && v !== '' && k !== 'ms')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ');
}

function diagAlsText(w) {
    const t0 = w.ereignisse[0]?.t || 0;
    return [`Wiedergabe ${w.k} · ${new Date(t0).toLocaleString('de-DE')} · ${w.info.konto || ''} · ${w.info.ua || ''}`,
        ...w.ereignisse.map((e) => `${('+' + ((e.t - t0) / 1000).toFixed(2) + 's').padStart(9)}  ${e.q.padEnd(6)}  ${(DIAG_NAMEN[e.e] || e.e).padEnd(26)}  ${diagDaten(e.d)}`)].join('\n');
}

async function diagnose() {
    const d = await api('diagnose?anzahl=30');
    const liste = el('div');
    const zeigen = (w) => {
        const t0 = w.ereignisse[0]?.t || 0;
        const antwort = w.ereignisse.find((e) => e.e === 'api_start_antwort');
        const ersteWiedergabe = w.ereignisse.find((e) => e.e === 'video_playing');
        const warten = w.ereignisse.filter((e) => e.e === 'warten_vorbei');
        const fehler = w.ereignisse.filter((e) => /fehler/i.test(e.e) || (e.e === 'remux_ende' && e.d?.ffmpeg_meldung)).length;
        const bisBild = ersteWiedergabe ? ((ersteWiedergabe.t - t0) / 1000).toFixed(1) + ' s bis Bild' : 'kein Bild';
        const modus = { direkt: 'Direct Play', remux: 'Direct Stream', hls: 'Umwandeln' }[antwort?.d.modus] || '–';
        return el('details.diag-wiedergabe',
            el('summary',
                el('b', antwort?.d.titel || `${w.info.art || ''} ${w.info.id || ''}`),
                el('span.leise', new Date(t0).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' })),
                el('span.chip', modus),
                el('span.chip' + (ersteWiedergabe && ersteWiedergabe.t - t0 > 3000 ? '.schlecht-chip' : ''), bisBild),
                warten.length ? el('span.chip.schlecht-chip', `${warten.length}× gewartet (${(warten.reduce((s, e) => s + (e.d.dauer_ms || 0), 0) / 1000).toFixed(1)} s)`) : null,
                fehler ? el('span.chip.schlecht-chip', `${fehler} Fehler`) : null,
                el('span.leise', `${w.info.konto || ''} · ${diagKurzUA(w.info.ua)}`)),
            el('div.knoepfe', { style: { margin: '10px 0' } },
                el('button.knopf.klein', { onclick: async () => {
                    try { await navigator.clipboard.writeText(diagAlsText(w)); meldung('Zeitleiste kopiert – einfach in den Chat einfügen.'); } catch { meldung('Kopieren ging nicht – Text markieren und kopieren.', true); }
                } }, icon('haken'), 'Als Text kopieren')),
            el('table.diag-tabelle', w.ereignisse.map((e) => el('tr' + (diagSchlecht(e) ? '.schlecht' : ''),
                el('td.zeit', '+' + ((e.t - t0) / 1000).toFixed(2) + ' s'),
                el('td', el('span.quelle.q-' + e.q, e.q === 'player' ? 'Player' : 'Server')),
                el('td', DIAG_NAMEN[e.e] || e.e),
                el('td.daten', diagDaten(e.d))))));
    };
    liste.append(...(d.wiedergaben.length ? d.wiedergaben.map(zeigen) : [el('p.leise', 'Noch nichts aufgezeichnet – spiel etwas ab, dann erscheint es hier.')]));
    return el('div',
        el('div.karte.glass-panel',
            el('h2', 'Wiedergabe-Diagnose'),
            el('p.leise', 'Jede Wiedergabe wird mit Zeitstempeln aufgezeichnet – im Player und auf dem Server. So sieht man, worauf gewartet wird: Antwort des Servers, ffmpeg (Platte), Netz oder Browser. Im Player zeigt die Taste I live, was passiert.'),
            el('div.knoepfe',
                el('a.knopf', { href: '#/verwaltung/diagnose', onclick: (e) => { e.preventDefault(); window.__bluewave.neuLaden(); } }, 'Aktualisieren'),
                el('button.knopf', { onclick: async () => {
                    if (!await bestaetigen('Protokoll leeren', 'Alle aufgezeichneten Wiedergaben löschen?', 'Leeren', true)) return;
                    await api('diagnose', 'DELETE');
                    window.__bluewave.neuLaden();
                } }, icon('loeschen'), 'Protokoll leeren'))),
        liste);
}
