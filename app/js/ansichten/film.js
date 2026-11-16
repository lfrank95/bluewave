// Filmseite: Titelbild, Abspielen/Weiterschauen, Fassungen, Technik, Besetzung, Reihe, Universen
'use strict';
import { el, icon, kachel, zeile, dauer, zeit, bytes, initialen, bild, meldung, dialog, feld, auswahl } from '../ui.js';
import { api } from '../api.js';

let letzterTitel = 'Film';
export const titel = () => letzterTitel + ' – Bluewave';

export function hero(d, knoepfe, extra = []) {
    return el('section.hero',
        el('div.hg', { style: d.hintergrund ? { backgroundImage: `url("${d.hintergrund}")` } : {} }),
        el('div.inhalt',
            d.logo ? el('img.logo', { src: d.logo, alt: d.titel || d.name }) : el('h1.gross', d.titel || d.name),
            extra, knoepfe));
}

export function besetzung(liste) {
    if (!liste?.length) return null;
    return el('section.abschnitt', el('h2', 'Besetzung'),
        el('div.besetzung', liste.map((p) => el('div.person', el('div.foto', bild(p.bild_url, p.name) || initialen(p.name)), el('b', p.name), el('div.rolle', p.rolle)))));
}

export async function tmdbZuordnen(art, id, vorschlag, jahr) {
    const q = el('input.eingabe', { value: vorschlag || '' });
    const j = el('input.eingabe', { value: jahr || '', inputmode: 'numeric', style: { width: '110px' } });
    const ergebnis = el('div', { style: { marginTop: '12px' } });
    const suchen = async () => {
        ergebnis.replaceChildren(el('p.leise', 'Suche …'));
        try {
            const p = new URLSearchParams({ art, q: q.value });
            if (j.value) p.set('jahr', j.value);
            const d = await api('tmdb/suche?' + p);
            ergebnis.replaceChildren(...(d.treffer.length ? d.treffer.map((t) => el('div.liste-eintrag',
                t.poster ? el('img', { src: t.poster, alt: '' }) : el('img'),
                el('div.mitte', el('b', `${t.titel}${t.jahr ? ' (' + t.jahr + ')' : ''}`), el('span', t.beschreibung || t.original)),
                el('button.knopf.klein.haupt', { onclick: async (e) => {
                    e.target.disabled = true;
                    e.target.textContent = 'Übernehme …';
                    try {
                        await api(`${art}/${id}/zuordnen`, 'POST', { tmdb_id: t.tmdb_id });
                        document.querySelector('.dialog-hg')?.remove();
                        meldung('Zugeordnet.');
                        window.__bluewave.neuLaden();
                    } catch (x) { meldung(x.message, true); e.target.disabled = false; e.target.textContent = 'Übernehmen'; }
                } }, 'Übernehmen'))) : [el('p.leise', 'Keine Treffer.')]));
        } catch (x) { ergebnis.replaceChildren(el('p.schlecht', x.message)); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') suchen(); });
    setTimeout(suchen);
    await dialog('Bei TMDB zuordnen', el('div', el('div', { style: { display: 'flex', gap: '10px' } }, q, j, el('button.knopf', { onclick: suchen }, icon('suche'))), ergebnis), [{ text: 'Schließen', wert: null }]);
}

export async function zeigen(r, app) {
    const id = parseInt(r.teile[1], 10);
    const d = await api('film/' + id);
    letzterTitel = d.titel;
    const admin = app.konto.rolle === 'admin';
    let fassung = d.fassungen.find((f) => f.standard) || d.fassungen[0];
    const fs = d.fortschritt;
    const weiter = fs && !fs.gesehen && fs.position_ms > 30000;

    const technik = el('div.technik');
    const technikZeigen = () => {
        const dat = fassung?.dateien[0];
        if (!dat) { technik.replaceChildren(el('p.leise', 'Keine Datei vorhanden.')); return; }
        const zeilen = [
            ['Bild', [fassung.dateien.map((x) => x.qualitaet).filter(Boolean).join(' / '), dat.hdr, dat.video_codec].filter(Boolean).join(' · ')],
            ['Ton', dat.ton.map((t) => `${t.sprache_name} ${t.text}${t.kommentar ? ' (Kommentar)' : ''}`).join(', ') || '–'],
            ['Untertitel', dat.untertitel.map((u) => u.sprache_name + (u.erzwungen ? ' (erzwungen)' : '') + (u.sdh ? ' (SDH)' : '')).join(', ') || '–'],
            ['Datei', `${dat.dateiname} · ${bytes(dat.groesse)}`],
        ];
        technik.replaceChildren(...zeilen.map(([a, b]) => el('div.zeile-t', el('b', a), el('span', b))));
    };
    technikZeigen();

    const fassungsWahl = d.fassungen.length > 1 ? el('div.fassungs-wahl', d.fassungen.map((f) => {
        const b = el('button', { class: f === fassung ? 'aktiv' : '', onclick: () => {
            fassung = f;
            fassungsWahl.querySelectorAll('button').forEach((x) => x.classList.remove('aktiv'));
            b.classList.add('aktiv');
            technikZeigen();
        } }, f.name);
        return b;
    })) : null;

    const gesehenKnopf = el('button.knopf' + (fs?.gesehen ? '.haupt' : ''), { title: 'Als gesehen markieren', onclick: async () => {
        const neu = !(fs?.gesehen);
        await api('wiedergabe/gesehen', 'POST', { art: 'film', id, gesehen: neu });
        meldung(neu ? 'Als gesehen markiert.' : 'Als ungesehen markiert.');
        app.neuLaden();
    } }, icon('haken'), fs?.gesehen ? 'Gesehen' : 'Als gesehen markieren');

    const knoepfe = el('div.knoepfe',
        d.fassungen.length ? el('button.knopf.weiss', { onclick: () => app.abspielen({ art: 'film', id, fassung_id: fassung?.id }) }, icon('play'),
            weiter ? `Weiterschauen ab ${zeit(fs.position_ms / 1000)}` : 'Abspielen') : el('span.chip', 'Datei fehlt'),
        weiter ? el('button.knopf', { onclick: () => app.abspielen({ art: 'film', id, fassung_id: fassung?.id, start_ms: 0 }) }, icon('zurueck10'), 'Von vorn') : null,
        gesehenKnopf);

    const metaTeile = [d.jahr, d.laufzeit_min ? dauer(d.laufzeit_min) : null].filter(Boolean);
    const meta = el('div.meta', metaTeile.flatMap((m, i) => (i ? [el('span.trenn'), el('span', String(m))] : [el('span', String(m))])),
        d.freigabe ? el('span.freigabe', 'FSK ' + d.freigabe) : null,
        d.bewertung ? el('span.stern', '★ ' + String(d.bewertung).replace('.', ',')) : null);

    const extra = [meta, d.tagline ? el('div.tagline', d.tagline) : null,
        el('div.chips', d.genres.map((g) => el('a.chip', { href: `#/filme?genre=${g.id}` }, g.name)),
            d.universen.map((u) => el('a.chip.akzent', { href: `#/universum/${u.id}` }, icon('universum'), u.name)))];

    const seite = el('div',
        hero(d, knoepfe, extra),
        el('div.detail-raster',
            el('div',
                d.beschreibung ? el('section.abschnitt', el('p.beschreibung', d.beschreibung)) : null,
                fassungsWahl ? el('section.abschnitt', el('h2', 'Fassung'), fassungsWahl) : null,
                besetzung(d.besetzung)),
            el('aside',
                el('div.infos.glass-panel',
                    el('dl',
                        d.originaltitel && d.originaltitel !== d.titel ? [el('dt', 'Originaltitel'), el('dd', d.originaltitel)] : null,
                        d.regie ? [el('dt', 'Regie'), el('dd', d.regie)] : null,
                        d.reihe ? [el('dt', 'Reihe'), el('dd', el('a', { href: `#/reihe/${d.reihe.id}` }, d.reihe.name))] : null),
                    technik,
                    admin ? el('div.knoepfe', { style: { marginTop: '16px' } },
                        el('button.knopf.klein', { onclick: () => tmdbZuordnen('film', id, d.originaltitel || d.titel, d.jahr) }, icon('bearbeiten'), 'TMDB-Zuordnung'),
                        el('button.knopf.klein', { onclick: () => fassungKorrigieren(d, id) }, icon('film'), 'Fassungen')) : null))),
        d.reihe && d.reihe.filme.length > 1 ? zeile(d.reihe.name, d.reihe.filme.map(kachel), { link: `#/reihe/${d.reihe.id}` }) : null);
    return seite;
}

async function fassungKorrigieren(d, filmId) {
    const ARTEN = { kino: 'Kinofassung', extended: 'Extended Edition', directors_cut: "Director's Cut", unrated: 'Unrated', imax: 'IMAX', remastered: 'Remastered', sonstige: 'Andere (Name angeben)' };
    const zeilen = d.fassungen.flatMap((f) => f.dateien.map((dat) => {
        const art = auswahl(ARTEN, f.art);
        const name = el('input.eingabe', { value: f.art === 'sonstige' ? f.name : '', placeholder: 'Name (nur bei „Andere“)' });
        const speichern = el('button.knopf.klein', { onclick: async () => {
            try {
                await api(`film/${filmId}/fassung`, 'PUT', { datei_id: dat.id, art: art.value, name: name.value });
                meldung('Gespeichert.');
            } catch (x) { meldung(x.message, true); }
        } }, 'Speichern');
        return el('div.karte.glass-panel', el('b', dat.dateiname), el('div.leise', [dat.qualitaet, dat.hdr].filter(Boolean).join(' · ')),
            el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } }, art, name, speichern));
    }));
    await dialog('Fassungen der Dateien', el('div', el('p.leise', 'Fassung (Kino, Extended …) und Qualität sind getrennt: Dateien derselben Fassung sind Qualitätsstufen.'), zeilen),
        [{ text: 'Fertig', wert: null }]);
    window.__bluewave.neuLaden();
}
