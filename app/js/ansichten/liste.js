// Filme bzw. Serien: Kopf mit Zahlen, Filter-Pillen, Highlights (Filme), Poster-Raster
'use strict';
import { el, kachel, auswahl, bild } from '../ui.js';
import { api } from '../api.js';

export const titel = (r) => (r.name === 'serien' ? 'Serien' : 'Filme') + ' – Bluewave';

function highlight(f) {
    return el('a.highlight', { href: `#/film/${f.id}` },
        f.hintergrund ? el('img.hg', { src: f.hintergrund, alt: '', loading: 'lazy' }) : null,
        el('div.poster', bild(f.poster, f.titel)),
        el('div.text',
            el('div.augenbraue', { style: { marginBottom: '8px' } }, 'Neu hinzugefügt'),
            el('b', f.titel),
            el('div.z', f.zusatz || f.jahr || ''),
            f.technik?.length ? el('div.chips', f.technik.map((t) => el('span.tech' + (t.art === 'hdr' ? '.hdr' : ''), t.text))) : null));
}

export async function zeigen(r) {
    const serien = r.name === 'serien';
    const sort = r.query.get('sort') || 'titel';
    const genre = r.query.get('genre') || '';
    const filter = r.query.get('filter') || '';
    const q = new URLSearchParams({ sort });
    if (genre) q.set('genre', genre);
    if (filter && !serien) q.set('filter', filter);
    const d = await api((serien ? 'serien' : 'filme') + '?' + q);
    const liste = serien ? d.serien : d.filme;
    const setzen = (werte) => {
        const p = new URLSearchParams(r.query);
        for (const [k, v] of Object.entries(werte)) { if (v) p.set(k, v); else p.delete(k); }
        location.hash = '#/' + r.name + (p.toString() ? '?' + p : '');
    };
    const sortWahl = auswahl(serien ? { titel: 'Titel', neu: 'Zuletzt hinzugefügt', jahr: 'Jahr' } : { titel: 'Titel', neu: 'Zuletzt hinzugefügt', jahr: 'Jahr', bewertung: 'Bewertung' },
        sort, { 'aria-label': 'Sortierung', onchange: (e) => setzen({ sort: e.target.value }) });

    const pille = (text, an, werte) => el('button.pille' + (an ? '.an' : ''), { onclick: () => setzen(werte) }, text);
    const pillen = el('div.pillen',
        pille('Alle', !genre && !filter, { genre: '', filter: '' }),
        serien ? null : [pille('4K', filter === '4k', { filter: '4k', genre: '' }), pille('Ungesehen', filter === 'ungesehen', { filter: 'ungesehen', genre: '' }),
            pille('Reihen', filter === 'reihen', { filter: 'reihen', genre: '' })],
        d.genres.slice(0, 10).map((g) => pille(g.name, String(g.id) === genre, { genre: String(g.id), filter: '' })),
        d.genres.length > 10 ? auswahl({ '': 'Weitere Genres …', ...Object.fromEntries(d.genres.slice(10).map((g) => [g.id, `${g.name} (${g.anzahl})`])) }, genre,
            { 'aria-label': 'Genre', class: 'pille', onchange: (e) => setzen({ genre: e.target.value, filter: '' }) }) : null);

    const z = d.zahlen;
    const unterzeile = serien
        ? `${liste.length} ${liste.length === 1 ? 'Serie' : 'Serien'}`
        : z ? [`${z.gesamt} Filme`, z.uhd ? `${z.uhd} in 4K` : null, z.reihen ? `${z.reihen} Reihen` : null].filter(Boolean).join(' · ') : `${liste.length} Filme`;
    const zeigeHighlights = !serien && !genre && !filter && d.highlights?.length;
    return el('div.seite',
        el('div.bib-kopf',
            el('div', el('h1', serien ? 'Serien' : 'Filme'), el('p', unterzeile)),
            el('div.werkzeuge', { style: { marginLeft: 'auto' } }, sortWahl)),
        pillen,
        zeigeHighlights ? el('div.highlight-raster', d.highlights.map(highlight)) : null,
        liste.length ? el('div.raster', liste.map(kachel))
            : el('div.leer', el('h2', 'Nichts gefunden'), el('p', genre || filter ? 'Mit diesem Filter gibt es noch nichts.' : 'Die Bibliothek ist noch leer.')));
}
