// Filmseite: Titelbild, Abspielen/Weiterschauen, Fassungen, Technik, Besetzung, Reihe, Universen
'use strict';
import { el, icon, bild, fsk, dauer, zeit, bytes, initialen, meldung, dialog, auswahl } from '../ui.js';
import { api } from '../api.js';
import { universumBereich } from './universum_teile.js';
import { bearbeitenDialog } from './bearbeiten_dialog.js';
import { universenDialog } from './universum_teile.js';

let letzterTitel = 'Film';
export const titel = () => letzterTitel + ' – Bluewave';

/** Poster für das Titelbild der Detailseite */
export function heroPoster(d) {
    return d.poster ? el('div.hero-poster', el('img', { src: d.poster, alt: d.titel || d.name || '' })) : null;
}

export function hero(d, knoepfe, extra = [], vor = []) {
    return el('section.hero.detail',
        el('div.hg', { style: d.hintergrund ? { backgroundImage: `url("${d.hintergrund}")` } : {} }),
        el('div.inhalt.mit-poster', heroPoster(d), el('div.hero-text', vor,
            d.logo ? el('img.logo', { src: d.logo, alt: d.titel || d.name }) : el('h1.gross', d.titel || d.name),
            extra, knoepfe)));
}

export function besetzung(liste) {
    if (!liste?.length) return null;
    const spur = el('div.besetzung-spur', liste.slice(0, 20).map((p) => {
        const foto = el('div.foto', initialen(p.name));
        if (p.bild_url) {
            const i = el('img', { src: p.bild_url, alt: p.name, loading: 'lazy' });
            i.addEventListener('load', () => foto.replaceChildren(i), { once: true });
        }
        // Klick sucht alles mit dieser Person
        return el('a.person-gross', { href: '#/suche?q=' + encodeURIComponent(p.name) + '&fokus=0', title: `Alles mit ${p.name}` }, foto, el('b', p.name), el('div.rolle', p.rolle));
    }));
    const blaettern = (r) => spur.scrollBy({ left: r * spur.clientWidth * 0.8, behavior: 'smooth' });
    return el('section.abschnitt',
        el('div.abschnitt-zeile', el('h2', 'Besetzung'),
            el('div.blaetter', el('button.mini-knopf', { 'aria-label': 'Zurück', onclick: () => blaettern(-1) }, icon('links')),
                el('button.mini-knopf', { 'aria-label': 'Weiter', onclick: () => blaettern(1) }, icon('rechts')))),
        spur);
}

export function technikChips(liste) {
    return (liste || []).map((t) => el('span.tech' + (t.art === 'hdr' ? '.hdr' : ''), t.text));
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

    // Infokasten: Technik der gewählten Fassung
    const technik = el('dl');
    const technikZeigen = () => {
        const dat = fassung?.dateien[0];
        const zeilen = [
            d.originaltitel && d.originaltitel !== d.titel ? ['Originaltitel', d.originaltitel] : null,
            d.regie ? ['Regie', d.regie] : null,
            d.reihe ? ['Reihe', el('a', { href: `#/reihe/${d.reihe.id}` }, d.reihe.name)] : null,
        ];
        if (dat) {
            zeilen.push(['Bild', [fassung.dateien.map((x) => x.qualitaet).filter(Boolean).join(' / '), dat.hdr, dat.video_codec].filter(Boolean).join(' · ')],
                ['Ton', dat.ton.map((t) => `${t.sprache_name} ${t.text}${t.kommentar ? ' (Kommentar)' : ''}`).join(', ') || '–'],
                ['Untertitel', dat.untertitel.map((u) => u.sprache_name + (u.erzwungen ? ' (erzwungen)' : '') + (u.sdh ? ' (SDH)' : '')).join(', ') || '–'],
                ['Datei', `${dat.dateiname} · ${bytes(dat.groesse)}`]);
        } else zeilen.push(['Datei', 'Keine Datei vorhanden']);
        technik.replaceChildren(...zeilen.filter(Boolean).flatMap(([a, b]) => [el('dt', a), el('dd', b)]));
    };
    technikZeigen();

    // Fassungen als Karten
    const fassungKarten = d.fassungen.length ? el('div.fassung-karten', d.fassungen.map((f) => {
        const dat = f.dateien[0];
        const k = el('button.fassung-karte' + (f === fassung ? '.an' : ''), { onclick: () => {
            fassung = f;
            fassungKarten.querySelectorAll('.fassung-karte').forEach((x) => x.classList.toggle('an', x === k));
            technikZeigen();
        } },
            el('b', f.name, el('span.haken', icon('haken'))),
            el('div.z', [d.laufzeit_min && f.dateien[0]?.dauer_ms ? dauer(Math.round(f.dateien[0].dauer_ms / 60000)) : null, f.dateien.length > 1 ? `${f.dateien.length} Qualitäten` : null].filter(Boolean).join(' · ') || 'Fassung'),
            dat ? el('div.chips', f.dateien.map((x) => x.qualitaet).filter(Boolean).map((q) => el('span.tech', q)), dat.hdr ? el('span.tech.hdr', dat.hdr) : null) : null);
        return k;
    })) : null;

    const gesehenKnopf = el('button.knopf-kreis' + (fs?.gesehen ? '.an' : ''), { title: fs?.gesehen ? 'Als ungesehen markieren' : 'Als gesehen markieren', onclick: async () => {
        const neu = !(fs?.gesehen);
        await api('wiedergabe/gesehen', 'POST', { art: 'film', id, gesehen: neu });
        meldung(neu ? 'Als gesehen markiert.' : 'Als ungesehen markiert.');
        app.neuLaden();
    } }, icon('haken'));

    const knoepfe = el('div.knoepfe',
        d.fassungen.length ? el('button.knopf.weiss', { onclick: () => app.abspielen({ art: 'film', id, fassung_id: fassung?.id }) }, icon('play'),
            weiter ? `Weiterschauen ab ${zeit(fs.position_ms / 1000)}` : 'Abspielen',
            weiter ? el('span.linie', { style: { width: fs.prozent + '%' } }) : null) : el('span.chip', 'Datei fehlt'),
        weiter ? el('button.knopf', { onclick: () => app.abspielen({ art: 'film', id, fassung_id: fassung?.id, start_ms: 0 }) }, icon('zurueck10'), 'Von vorn') : null,
        gesehenKnopf,
        admin ? el('button.knopf-kreis', { title: 'Bearbeiten', 'aria-label': 'Bearbeiten', onclick: () => bearbeiten() }, icon('bearbeiten')) : null);
    const bearbeiten = (bilder = false) => bearbeitenDialog('film', id, { bilderStaffel: bilder, aktionen: [
        { text: 'Anderen TMDB-Eintrag zuordnen', icon: 'suche', fn: () => tmdbZuordnen('film', id, d.originaltitel || d.titel, d.jahr) },
        { text: 'Fassungen korrigieren', icon: 'film', fn: () => fassungKorrigieren(d, id) },
        { text: 'Universen', icon: 'universum', fn: () => universenDialog('film', id, d.universen) },
    ] });

    const metaTeile = [d.jahr, d.laufzeit_min ? dauer(d.laufzeit_min) : null, d.genres.slice(0, 2).map((g) => g.name).join(', ') || null].filter(Boolean);
    const meta = el('div.meta', metaTeile.flatMap((m, i) => (i ? [el('span.trenn'), el('span', String(m))] : [el('span', String(m))])),
        fsk(d.freigabe),
        d.bewertung ? el('span.stern', '★ ' + String(d.bewertung).replace('.', ',')) : null,
        technikChips(d.technik));

    const u0 = d.universen[0];
    const vor = u0 ? el('a.universum-chip', { href: `#/universum/${u0.id}` }, icon('universum'), `${u0.name} · Nr. ${u0.nr} von ${u0.gesamt}`) : null;
    const extra = [meta, d.tagline ? el('div.tagline', d.tagline) : null, d.beschreibung ? el('p.text', d.beschreibung) : null];

    const reihe = d.reihe && d.reihe.filme.length > 1 ? el('section.reihe-band',
        el('div.band-kopf', el('h2', d.reihe.name), el('span.leise', `${d.reihe.filme.length} Filme`),
            el('a', { href: `#/reihe/${d.reihe.id}` }, 'Zur Reihe')),
        el('div.reihe-teile', d.reihe.filme.map((t, i) => el('a.reihe-teil' + (t.id === id ? '.aktuell' : ''), { href: `#/film/${t.id}` },
            el('div.p', bild(t.poster, t.titel)),
            el('div', el('small', t.id === id ? `TEIL ${i + 1} · HIER` : `TEIL ${i + 1}`), el('b', t.titel),
                el('span', [t.jahr, t.fortschritt?.gesehen ? 'gesehen' : null].filter(Boolean).join(' · '))))))) : null;

    return el('div',
        hero(d, knoepfe, extra, vor),
        el('div.detail-raster',
            el('div',
                fassungKarten ? el('section.abschnitt', el('h2', d.fassungen.length > 1 ? 'Fassungen' : 'Fassung'), fassungKarten,
                    d.fassungen.length > 1 ? el('p.hinweis-leise', 'Die Qualität (4K, 1080p …) wählt Bluewave je nach Gerät und Verbindung selbst.') : null) : null,
                besetzung(d.besetzung)),
            el('aside',
                el('div.info-box',
                    el('div.chips', { style: { marginTop: 0 } }, d.genres.map((g) => el('a.chip', { href: `#/filme?genre=${g.id}` }, g.name))),
                    technik,
                    admin ? el('div.knoepfe', { style: { marginTop: '18px' } },
                        el('button.knopf.klein', { onclick: () => bearbeiten() }, icon('bearbeiten'), 'Bearbeiten'),
                        el('button.knopf.klein', { onclick: () => bearbeiten(true) }, icon('bild'), 'Bilder')) : null))),
        reihe,
        universumBereich(d.universen, 'film', id, app),
        el('div', { style: { height: '40px' } }));
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
