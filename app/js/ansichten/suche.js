// Suche: großes Feld, Bester Treffer, Filme, Serien, Personen, Reihen, Universen, Folgen; zuletzt gesucht
'use strict';
import { el, icon, kachel, bild, fsk, dauer, initialen } from '../ui.js';
import { api } from '../api.js';
import { mehrfachAuswahl } from './mehrfach.js';
import { technikChips } from './film.js';

export const titel = (r) => (r.query.get('q') ? `„${r.query.get('q')}“ – ` : '') + 'Suche – Bluewave';

const VERLAUF = 'bluewave.suchverlauf';
function verlauf() {
    try { return JSON.parse(localStorage.getItem(VERLAUF) || '[]'); } catch { return []; }
}
function merken(q) {
    try {
        const l = [q, ...verlauf().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
        localStorage.setItem(VERLAUF, JSON.stringify(l));
    } catch { /* privat */ }
}

function besterTreffer(b, app) {
    const link = b.art === 'serie' ? `#/serie/${b.id}` : b.art === 'film' ? `#/film/${b.id}` : b.art === 'universum' ? `#/universum/${b.id}` : `#/reihe/${b.id}`;
    const art = { film: 'Film', serie: 'Serie', universum: 'Universum', reihe: 'Reihe' }[b.art];
    const spielen = b.art === 'film' ? { art: 'film', id: b.id } : b.art === 'serie' && b.naechste ? { art: 'folge', id: b.naechste.id } : null;
    return el('section.bester-treffer',
        b.hintergrund ? el('img.hg', { src: b.hintergrund, alt: '' }) : null,
        el('a.poster', { href: link }, bild(b.poster, b.titel)),
        el('div.text',
            el('div.augenbraue', 'Bester Treffer · ' + art),
            el('a', { href: link, class: 'titel-link' }, b.logo ? el('img.logo', { src: b.logo, alt: b.titel }) : el('h2', b.titel)),
            el('div.meta', [b.jahr || b.zusatz, b.laufzeit_min ? dauer(b.laufzeit_min) : null].filter(Boolean).flatMap((m, i) => (i ? [el('span.trenn'), el('span', String(m))] : [el('span', String(m))])),
                fsk(b.freigabe), technikChips(b.technik)),
            b.text ? el('p', b.text) : null,
            el('div.knoepfe',
                spielen ? el('button.knopf.weiss', { onclick: () => app.abspielen(spielen) }, icon('play'),
                    b.art === 'serie' ? `${b.naechste.kennung} abspielen` : b.fortschritt && !b.fortschritt.gesehen && b.fortschritt.prozent > 1 ? 'Weiterschauen' : 'Abspielen') : null,
                el('a.knopf', { href: link }, icon('info'), 'Details'))));
}

function personKarte(p, setzen) {
    const foto = el('div.foto', initialen(p.name));
    if (p.bild) {
        const i = el('img', { src: p.bild, alt: p.name, loading: 'lazy' });
        i.addEventListener('load', () => foto.replaceChildren(i), { once: true });
    }
    return el('button.person-karte', { onclick: () => setzen(p.name), title: `Alles mit ${p.name}` },
        foto, el('b', p.name), el('span', `${p.rolle === 'Regie' ? 'Regie · ' : ''}${p.anzahl} ${p.anzahl === 1 ? 'Titel' : 'Titel'}`));
}

function folgeZeile(f, app) {
    return el('button.folge-treffer', { onclick: () => app.abspielen({ art: 'folge', id: f.id }) },
        el('div.bild', bild(f.standbild, ''), el('span.play-klein', icon('play'))),
        el('div', el('b', f.titel), el('span', `${f.serie} · ${f.kennung}`)));
}

export async function zeigen(r, app) {
    let q = r.query.get('q') || '';
    const feld = el('input.such-gross', { type: 'search', value: q, placeholder: 'Titel, Schauspieler, Regie, Reihe …', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Suchen' });
    const ergebnis = el('div.such-ergebnis');
    let nr = 0;
    let erster = null;

    const setzen = (wert) => {
        feld.value = wert;
        eingabe();
        feld.focus();
    };

    const leerZeigen = () => {
        const l = verlauf();
        ergebnis.replaceChildren(l.length ? el('section.abschnitt',
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, el('h2', { style: { margin: 0 } }, 'Zuletzt gesucht'),
                el('button.knopf.klein', { style: { marginLeft: 'auto' }, onclick: () => { try { localStorage.removeItem(VERLAUF); } catch { /* */ } leerZeigen(); } }, 'Leeren')),
            el('div.chips', { style: { marginTop: '14px' } }, l.map((x) => el('button.chip', { onclick: () => setzen(x) }, icon('suche'), x))))
            : el('p.leise', { style: { marginTop: '24px' } }, 'Tipp: Groß/Klein, Umlaute, Bindestriche und kleine Tippfehler sind egal – „spiderman“ findet „Spider-Man“, „ringe herr“ den „Herrn der Ringe“, auch Schauspieler und Regie werden gefunden.'));
    };

    const suchen = async (wort) => {
        const meine = ++nr;
        if (wort.length < 2) { erster = null; leerZeigen(); return; }
        ergebnis.classList.add('laedt');
        let d;
        try {
            d = await api('suche?q=' + encodeURIComponent(wort));
        } catch (x) {
            if (meine === nr) ergebnis.replaceChildren(el('p.schlecht', x.message));
            return;
        } finally {
            if (meine === nr) ergebnis.classList.remove('laedt');
        }
        if (meine !== nr) return; // inzwischen weitergetippt
        const teile = [];
        erster = d.beste ? (d.beste.art === 'serie' ? `#/serie/${d.beste.id}` : d.beste.art === 'film' ? `#/film/${d.beste.id}` : `#/${d.beste.art}/${d.beste.id}`)
            : d.filme[0] ? `#/film/${d.filme[0].id}` : d.serien[0] ? `#/serie/${d.serien[0].id}` : null;
        if (d.beste) teile.push(besterTreffer(d.beste, app));
        // Mehrfachauswahl über Filme, Serien und Reihen
        const gruppen = [['Filme', d.filme], ['Serien', d.serien], ['Reihen', d.reihen]].filter(([, l]) => l.length).map(([n, l]) => [n, l, el('div.raster', l.map(kachel))]);
        const wahl = gruppen.length ? mehrfachAuswahl(gruppen.map((g) => g[2]), gruppen.map((g) => g[1]), app) : null;
        const gesamt = d.filme.length + d.serien.length + d.reihen.length + d.universen.length + d.personen.length + d.folgen.length;
        teile.push(el('div.such-kopf', el('span.leise', gesamt ? `${gesamt} Treffer${d.jahr ? ' · Jahr ' + d.jahr : ''}` : ''), wahl?.knopf));
        if (d.personen.length) {
            teile.push(el('section.abschnitt', el('h2', 'Personen'), el('div.personen-spur', d.personen.map((p) => personKarte(p, setzen)))));
        }
        for (const [n, l, raster] of gruppen) {
            teile.push(el('section.abschnitt', el('h2', n, el('span.zahl-klein', String(l.length))), raster));
        }
        if (d.universen.length) teile.push(el('section.abschnitt', el('h2', 'Universen'), el('div.raster', d.universen.map(kachel))));
        if (d.folgen.length) teile.push(el('section.abschnitt', el('h2', 'Folgen'), el('div.folgen-treffer', d.folgen.map((f) => folgeZeile(f, app)))));
        if (!gesamt) {
            teile.push(el('div.leer', el('h2', 'Nichts gefunden'), el('p', `Zu „${wort}“ gibt es nichts in deiner Bibliothek.`)));
        } else merken(wort);
        ergebnis.replaceChildren(...teile);
    };

    let timer = null;
    const eingabe = () => {
        q = feld.value.trim();
        // Adresse mitführen, ohne neuen Verlaufseintrag pro Tastendruck
        history.replaceState(history.state, '', '#/suche' + (q ? '?q=' + encodeURIComponent(q) : ''));
        window.__bluewave.routeMerken?.();
        clearTimeout(timer);
        timer = setTimeout(() => suchen(q), 180);
    };
    feld.addEventListener('input', eingabe);
    feld.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(timer);
            if (erster) location.hash = erster;
            else suchen(feld.value.trim());
        } else if (e.key === 'Escape' && feld.value) {
            e.preventDefault();
            setzen('');
        }
    });
    suchen(q);
    const vorbelegt = r.query.get('fokus') !== '0';
    setTimeout(() => {
        // Text aus dem Kopf-Suchfeld übernehmen (dort wurde bis eben weitergetippt)
        const kopf = app.kopfSuche;
        if (kopf && kopf.value) {
            feld.value = kopf.value;
            kopf.value = '';
            eingabe();
        }
        document.querySelector('.kopf')?.classList.add('auf-suche');
        if (vorbelegt || kopf === document.activeElement) { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length); }
    });
    return el('div.seite.such-seite',
        el('label.such-box', icon('suche'), feld,
            el('button.such-leeren', { type: 'button', 'aria-label': 'Leeren', onclick: () => setzen('') }, icon('schliessen'))),
        ergebnis);
}
