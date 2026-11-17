// Profil: Name, Passwort, Wiedergabe-Einstellungen, Geräte, Fernseher koppeln
'use strict';
import { el, icon, meldung, feld, auswahl, bestaetigen } from '../ui.js';
import { api } from '../api.js';

export const titel = () => 'Profil – Bluewave';

const SPRACHEN = { deu: 'Deutsch', eng: 'Englisch', fra: 'Französisch', spa: 'Spanisch', ita: 'Italienisch', jpn: 'Japanisch', nld: 'Niederländisch', tur: 'Türkisch', pol: 'Polnisch' };

export async function zeigen(r, app) {
    const ich = await api('ich');
    const e = ich.einstellungen;
    const w = {
        tonsprache: auswahl(SPRACHEN, e.tonsprache),
        untertitel: auswahl({ aus: 'Aus', erzwungen: 'Nur erzwungene (bzw. volle bei fremder Tonsprache)', immer: 'Immer' }, e.untertitel),
        untertitelsprache: auswahl(SPRACHEN, e.untertitelsprache),
        autoplay: auswahl({ countdown: 'Mit Countdown', sofort: 'Sofort weiter', aus: 'Aus' }, e.autoplay),
        countdown_s: el('input.eingabe', { type: 'number', min: 3, max: 30, value: e.countdown_s }),
        intro: auswahl({ knopf: 'Knopf „Intro überspringen“ zeigen', automatisch: 'Automatisch überspringen' }, e.intro),
        qualitaet_heim: auswahl({ original: 'Original', 1080: 'Bis 1080p', 720: 'Bis 720p' }, e.qualitaet_heim),
        qualitaet_unterwegs: auswahl({ original: 'Original (braucht viel Upload)', 1080: 'Bis 1080p (10 Mbit/s)', 720: 'Bis 720p (4 Mbit/s)', 480: 'Bis 480p (1,5 Mbit/s)' }, e.qualitaet_unterwegs),
        specials: auswahl({ zeigen: 'Anzeigen', ausblenden: 'Ausblenden' }, e.specials || 'zeigen'),
        aufloesung: auswahl({ geraet: 'Nicht über die Auflösung des Bildschirms', egal: 'Auflösung des Geräts ignorieren (Fernseher)' }, e.aufloesung || 'geraet'),
        nachtmodus: auswahl({ aus: 'Aus – Ton bleibt unverändert', leicht: 'Leicht', stark: 'Stark' }, e.nachtmodus),
        dialog_db: auswahl({ 0: 'Aus', 2: '+2 dB', 4: '+4 dB', 6: '+6 dB' }, e.dialog_db),
    };
    const speichern = el('button.knopf.haupt', { onclick: async () => {
        const daten = Object.fromEntries(Object.entries(w).map(([k, x]) => [k, x.value]));
        try {
            const r = await api('ich/einstellungen', 'PUT', daten);
            app.konto.einstellungen = r.einstellungen;
            meldung('Gespeichert.');
        } catch (x) { meldung(x.message, true); }
    } }, 'Speichern');

    const name = el('input.eingabe', { value: ich.anzeigename });
    const pwAlt = el('input.eingabe', { type: 'password', autocomplete: 'current-password' });
    const pwNeu = el('input.eingabe', { type: 'password', autocomplete: 'new-password' });

    const geraeteEl = el('div');
    const geraeteLaden = async () => {
        const d = await api('ich/geraete');
        geraeteEl.replaceChildren(el('table.tabelle', el('tr', el('th', 'Gerät'), el('th', 'Zuletzt'), el('th', '')),
            d.geraete.map((g) => el('tr',
                el('td', g.art === 'geraet' ? (g.geraetename || 'Gerät') + ' (fest angemeldet)' : 'Browser', g.dieses ? el('span.leise', ' · dieses') : null),
                el('td', new Date(g.zuletzt_am.replace(' ', 'T')).toLocaleString('de-DE')),
                el('td', g.dieses ? null : el('button.icon-knopf', { title: 'Abmelden', onclick: async () => {
                    if (!(await bestaetigen('Gerät abmelden?', 'Das Gerät muss sich danach neu anmelden.', 'Abmelden', true))) return;
                    await api('ich/geraete/' + g.id, 'DELETE');
                    geraeteLaden();
                } }, icon('loeschen')))))));
    };
    geraeteLaden();

    const code = el('input.eingabe', { inputmode: 'numeric', maxlength: 7, placeholder: '123456', style: { width: '140px', fontSize: '1.3rem', letterSpacing: '0.2em' } });

    return el('div.seite', { style: { maxWidth: '900px' } },
        el('div.seiten-kopf', el('h1', 'Profil')),
        el('section.karte.glass-panel', el('h2', 'Wiedergabe'),
            el('div.feld-reihe',
                feld('Bevorzugte Tonspur', w.tonsprache),
                feld('Untertitel', w.untertitel),
                feld('Untertitel-Sprache', w.untertitelsprache),
                feld('Intro', w.intro),
                feld('Nächste Folge', w.autoplay),
                feld('Countdown (Sekunden)', w.countdown_s),
                feld('Qualität zuhause', w.qualitaet_heim),
                feld('Qualität unterwegs', w.qualitaet_unterwegs, 'Gilt, wenn du über den Tunnel schaust.'),
                feld('Specials / Extras bei Serien', w.specials, 'Staffel 0 (Specials, Making-of, Extras). Je Serie lässt sich das im Bearbeiten-Dialog abweichend festlegen.'),
                feld('Bildschirm-Auflösung', w.aufloesung, 'Fernseher (LG, Samsung, Fire TV, Android TV) und gekoppelte Geräte bekommen ohnehin die volle Auflösung – manche Browser melden 4K-Fernseher als 1080p.'),
                feld('Nachtmodus', w.nachtmodus, 'Standard aus: Ohne Nachtmodus wird der Ton nicht angefasst.'),
                feld('Dialog-Anhebung', w.dialog_db, 'Hebt Stimmen an (Mitte/Center). Auch im Player umschaltbar.')),
            el('div.knoepfe', speichern)),
        el('section.karte.glass-panel', el('h2', 'Fernseher koppeln'),
            el('p.leise', 'Zeigt dein Fernseher einen 6-stelligen Code? Hier eingeben – der Fernseher bleibt dann fest mit deinem Konto angemeldet.'),
            el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, code,
                el('button.knopf.haupt', { onclick: async () => {
                    try {
                        const r = await api('kopplung/bestaetigen', 'POST', { code: code.value });
                        meldung(`${r.geraet} ist jetzt angemeldet.`);
                        code.value = '';
                        geraeteLaden();
                    } catch (x) { meldung(x.message, true); }
                } }, 'Koppeln'))),
        el('section.karte.glass-panel', el('h2', 'Geräte'), geraeteEl),
        el('section.karte.glass-panel', el('h2', 'Konto'),
            el('div.feld-reihe',
                el('div', feld('Anzeigename', name), el('button.knopf.klein', { onclick: async () => {
                    await api('ich/profil', 'PUT', { anzeigename: name.value });
                    app.konto.anzeigename = name.value;
                    meldung('Gespeichert.');
                } }, 'Namen speichern')),
                el('div', feld('Bisheriges Passwort', pwAlt), feld('Neues Passwort', pwNeu), el('button.knopf.klein', { onclick: async () => {
                    try {
                        await api('ich/passwort', 'POST', { alt: pwAlt.value, neu: pwNeu.value });
                        pwAlt.value = pwNeu.value = '';
                        meldung('Passwort geändert.');
                    } catch (x) { meldung(x.message, true); }
                } }, 'Passwort ändern'))),
            el('p.leise', { style: { marginTop: '14px', fontSize: '0.85rem' } }, `Bluewave ${ich.version} · ${ich.heimnetz ? 'im Heimnetz' : 'unterwegs'}`)));
}
