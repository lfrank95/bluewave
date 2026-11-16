// Startseite: großes Titelbild, Weiterschauen als große Karten, Universums-Band, Neu, Universen
'use strict';
import { el, icon, kachel, bild, zeile, dauer } from '../ui.js';
import { api } from '../api.js';

export const titel = () => 'Bluewave';

function weiterKarte(x, app) {
    const a = el('a.weiter-karte', { href: x.art === 'film' ? `#/film/${x.id}` : `#/serie/${x.serie_id}`, title: x.titel },
        bild(x.bild, x.titel),
        el('div.unten', el('span.play', icon('play')),
            el('div', { style: { minWidth: 0 } }, el('b', x.titel),
                el('span.z', [x.untertitel, x.rest_min ? `noch ${dauer(x.rest_min)}` : null].filter(Boolean).join(' · ')))),
        x.prozent > 0 ? el('div.fortschritt', el('span', { style: { width: x.prozent + '%' } })) : null);
    a.addEventListener('click', (e) => {
        e.preventDefault();
        app.abspielen({ art: x.art, id: x.id });
    });
    return a;
}

function universumBand(b, app) {
    const n = b.naechstes;
    const poster = b.titel_liste.map((t, i) => el('a.kachel' + (t.gesehen ? '.gesehen-ab' : ''), { href: t.art === 'serie' ? `#/serie/${t.id}${t.staffel ? '?staffel=' + t.staffel : ''}` : `#/film/${t.id}`, title: t.titel },
        el('div.bild', bild(t.poster, t.titel) || el('div.ersatz', t.titel), el('span.nr-marke', String(i + 1)),
            t.gesehen ? el('span.gesehen-haken.unten', icon('haken')) : null)));
    return el('section.universum-band',
        el('div.links',
            el('div.augenbraue', 'Universum'),
            el('h2', b.name),
            el('p', [`${b.filme} ${b.filme === 1 ? 'Film' : 'Filme'}`, b.serien ? `${b.serien} ${b.serien === 1 ? 'Serie' : 'Serien'}` : null,
                `${b.gesehen} von ${b.eintraege} gesehen`].filter(Boolean).join(' · ')),
            el('div.knoepfe', { style: { marginTop: '20px' } },
                n ? el('button.knopf.haupt', { onclick: () => app.abspielen(n.art === 'serie' ? { art: 'folge', id: n.folge.id } : { art: 'film', id: n.id }) },
                    icon('play'), n.art === 'serie' ? `${n.titel} · ${n.folge.kennung}` : n.titel) : null,
                el('a.knopf', { href: `#/universum/${b.id}` }, 'Alle Titel'))),
        el('div.poster-reihe', poster));
}

export async function zeigen(r, app) {
    const d = await api('start');
    if (d.leer) {
        return el('div.seite', el('div.leer',
            el('h2', 'Noch ist die Bibliothek leer'),
            el('p', app.konto.rolle === 'admin'
                ? 'Trag in der Verwaltung deinen TMDB-Schlüssel ein und starte den ersten Scan – danach erscheinen hier deine Filme und Serien.'
                : 'Sobald der Admin Filme und Serien eingelesen hat, erscheinen sie hier.'),
            app.konto.rolle === 'admin' ? el('div.knoepfe', { style: { justifyContent: 'center' } }, el('a.knopf.haupt', { href: '#/verwaltung/bibliothek' }, 'Zur Verwaltung')) : null));
    }
    const teile = [];
    if (d.hero) {
        const h = d.hero;
        teile.push(el('section.hero',
            el('div.hg', { style: { backgroundImage: `url("${h.hintergrund}")` } }),
            el('div.inhalt',
                el('div.augenbraue', 'Neu in deiner Bibliothek'),
                h.logo ? el('img.logo', { src: h.logo, alt: h.titel }) : el('h1.gross', h.titel),
                el('div.meta', h.jahr ? el('span', h.jahr) : null, h.laufzeit_min ? el('span.trenn') : null, h.laufzeit_min ? el('span', dauer(h.laufzeit_min)) : null),
                h.text ? el('p.text', h.text) : null,
                el('div.knoepfe',
                    el('button.knopf.weiss', { onclick: () => app.abspielen({ art: 'film', id: h.id }) }, icon('play'), 'Abspielen'),
                    el('a.knopf', { href: `#/film/${h.id}` }, icon('info'), 'Mehr Infos')))));
    } else {
        teile.push(el('div', { style: { height: '20px' } }));
    }
    const weiter = [...d.weiterschauen, ...d.als_naechstes].slice(0, 6);
    if (weiter.length) {
        teile.push(el('section.abschnitt-weiter', el('h2', 'Weiterschauen'), el('div.weiter-raster', weiter.map((x) => weiterKarte(x, app)))));
    }
    if (d.universum_band) teile.push(universumBand(d.universum_band, app));
    teile.push(
        zeile('Neu bei den Filmen', d.neue_filme.map(kachel), { link: '#/filme?sort=neu' }),
        zeile('Neue Folgen', d.neue_serien.map(kachel), { link: '#/serien?sort=neu' }),
        zeile('Universen', d.universen.map(kachel), { link: '#/universen' }),
    );
    return el('div', teile);
}
