// Serienseite: Titelbild, Weiterschauen, Episodenreihenfolge, Staffeln, Folgen
'use strict';
import { el, icon, bild, fsk, meldung, auswahl } from '../ui.js';
import { api } from '../api.js';
import { besetzung, tmdbZuordnen } from './film.js';
import { universumBereich, universenDialog } from './universum_teile.js';
import { bearbeitenDialog } from './bearbeiten_dialog.js';
import { heroPoster } from './film.js';

let letzterTitel = 'Serie';
export const titel = () => letzterTitel + ' – Bluewave';

const STATUS = { laufend: 'Läuft', beendet: 'Beendet', abgesetzt: 'Abgesetzt', geplant: 'Geplant' };

export async function zeigen(r, app) {
    const id = parseInt(r.teile[1], 10);
    const qp = new URLSearchParams();
    if (r.query.has('reihenfolge')) qp.set('reihenfolge', r.query.get('reihenfolge'));
    if (r.query.get('specials') === '1') qp.set('specials', '1');
    const q = qp.toString() ? '?' + qp : '';
    const d = await api('serie/' + id + q);
    letzterTitel = d.titel;
    const admin = app.konto.rolle === 'admin';
    const n = d.naechste;
    let staffelNr = parseInt(r.query.get('staffel') || '', 10);
    if (!d.staffeln.some((s) => s.nummer === staffelNr)) {
        // Staffel der nächsten Folge vorauswählen, sonst die erste reguläre
        const mitNaechster = n ? d.staffeln.find((s) => s.folgen.some((f) => f.id === n.id)) : null;
        staffelNr = (mitNaechster || d.staffeln.find((s) => s.nummer > 0) || d.staffeln[0])?.nummer ?? 1;
    }

    const knoepfe = el('div.knoepfe',
        n ? el('button.knopf.weiss', { onclick: () => app.abspielen({ art: 'folge', id: n.id }) }, icon('play'),
            n.modus === 'weiter' ? `${n.kennung} weiterschauen` : n.modus === 'naechste' ? `${n.kennung} abspielen` : 'Abspielen',
            n.modus === 'weiter' && n.fortschritt?.prozent ? el('span.linie', { style: { width: n.fortschritt.prozent + '%' } }) : null) : el('span.chip', 'Alles gesehen'),
        admin ? el('button.knopf', { onclick: () => bearbeiten() }, icon('bearbeiten'), 'Bearbeiten') : null);
    const bearbeiten = (bilder = false) => bearbeitenDialog('serie', id, { staffeln: d.staffeln, staffel: staffelNr, bilderStaffel: bilder, aktionen: [
        { text: 'Anderen TMDB-Eintrag zuordnen', icon: 'suche', fn: () => tmdbZuordnen('serie', id, d.originaltitel || d.titel, d.jahr) },
        { text: 'Universen', icon: 'universum', fn: () => universenDialog('serie', id, d.universen) },
    ] });
    const alleFolgen = d.staffeln.filter((s) => s.nummer > 0).flatMap((s) => s.folgen).filter((f) => f.vorhanden);
    const meta = el('div.meta', d.zeitraum ? el('span', d.zeitraum) : null, STATUS[d.status] ? [el('span.trenn'), el('span', STATUS[d.status])] : null,
        d.sender ? [el('span.trenn'), el('span', d.sender)] : null,
        alleFolgen.length ? [el('span.trenn'), el('span', `${alleFolgen.length} ${alleFolgen.length === 1 ? 'Folge' : 'Folgen'}`)] : null,
        fsk(d.freigabe),
        d.bewertung ? el('span.stern', '★ ' + String(d.bewertung).replace('.', ',')) : null);
    const u0 = d.universen[0];
    const vor = u0 ? el('a.universum-chip', { href: `#/universum/${u0.id}` }, icon('universum'), `${u0.name} · Nr. ${u0.nr} von ${u0.gesamt}`) : el('div.augenbraue', 'Serie');

    const weiterBox = n && n.modus !== 'start' ? el('div.weiter-box',
        el('div.bild', bild(n.standbild || d.hintergrund, ''),
            n.fortschritt?.prozent && n.modus === 'weiter' ? el('div.fortschritt', el('span', { style: { width: n.fortschritt.prozent + '%' } })) : null),
        el('small', n.modus === 'weiter' ? 'WEITERSCHAUEN' : 'ALS NÄCHSTES'),
        el('b', `${n.kennung} · ${n.titel}`),
        el('button.knopf.haupt', { onclick: () => app.abspielen({ art: 'folge', id: n.id }) }, icon('play'), n.modus === 'weiter' ? 'Weiterschauen' : 'Abspielen')) : null;

    const heroEl = el('section.hero.detail',
        el('div.hg', { style: d.hintergrund ? { backgroundImage: `url("${d.hintergrund}")` } : {} }),
        el('div.inhalt', { style: { maxWidth: '100%' } }, el('div.serie-hero-inhalt',
            heroPoster(d),
            el('div.links', vor, d.logo ? el('img.logo', { src: d.logo, alt: d.titel }) : el('h1.gross', d.titel), meta,
                d.beschreibung ? el('p.text', d.beschreibung) : null, el('div.chips', d.genres.map((g) => el('a.chip', { href: `#/serien?genre=${g.id}` }, g.name))), knoepfe),
            weiterBox)));

    // Episodenreihenfolge (z. B. Ausstrahlung vs. Netflix-Schnitt) als Umschalter
    let reihenfolgeWahl = null;
    if (d.reihenfolgen.length > 1) {
        reihenfolgeWahl = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            el('div.segment', d.reihenfolgen.map((x) => el('button' + ((x.id ?? null) === (d.reihenfolge ?? null) ? '.an' : ''), {
                title: x.id === d.reihenfolge_standard ? 'Standard' : '',
                onclick: () => { location.hash = `#/serie/${id}?reihenfolge=${x.id ?? ''}`; },
            }, x.name + (x.id === d.reihenfolge_standard ? ' ★' : '')))),
            admin && (d.reihenfolge ?? null) !== (d.reihenfolge_standard ?? null) ? el('button.knopf.klein', { onclick: async () => {
                await api(`serie/${id}/reihenfolge`, 'PUT', { reihenfolge_id: d.reihenfolge });
                meldung('Als Standard für alle gespeichert.');
                app.neuLaden();
            } }, 'Als Standard festlegen') : null);
    }

    const folgenEl = el('div.folgen');
    const tabs = el('div.staffel-cover');
    const staffelZeigen = () => {
        tabs.querySelectorAll('.staffel-karte').forEach((b) => b.classList.toggle('an', Number(b.dataset.nr) === staffelNr));
        const st = d.staffeln.find((s) => s.nummer === staffelNr);
        folgenEl.replaceChildren(...(st?.folgen || []).map((f) => folgeZeile(f, app, id, n)));
    };
    // Staffeln als Cover (wie bei Plex): Poster der Staffel, sonst das der Serie; Fortschritt darunter
    tabs.append(...d.staffeln.map((s) => {
        const da = s.folgen.filter((f) => f.vorhanden);
        const ges = da.filter((f) => f.fortschritt?.gesehen).length;
        const alle = da.length > 0 && ges === da.length;
        return el('button.staffel-karte', { 'data-nr': s.nummer, title: s.name, onclick: () => {
            staffelNr = s.nummer;
            staffelZeigen();
    // ausgeblendete Specials/Extras: kurz einblenden
    const specialsHinweis = d.specials_versteckt ? el('button.chip-gestrichelt', { style: { marginTop: '4px' }, onclick: () => {
        const p = new URLSearchParams(r.query);
        p.set('specials', '1');
        location.replace(`#/serie/${id}?${p}`);
    } }, icon('plus'), `Specials einblenden (${d.specials_versteckt})`) : null;
            history.replaceState(history.state, '', `#/serie/${id}?` + new URLSearchParams({ ...(d.reihenfolge !== null && d.reihenfolge !== undefined ? { reihenfolge: d.reihenfolge } : {}),
                ...(r.query.get('specials') === '1' ? { specials: '1' } : {}), staffel: s.nummer }));
            window.__bluewave.routeMerken?.();
        } },
            el('div.cover', bild(s.poster || d.poster, s.name) || el('div.ersatz', s.name),
                alle ? el('span.gesehen-haken.unten', icon('haken')) : null,
                ges && !alle ? el('div.fortschritt', el('span', { style: { width: Math.round(ges * 100 / da.length) + '%' } })) : null),
            el('b', s.name),
            el('span', `${s.folgen.length} ${s.folgen.length === 1 ? 'Folge' : 'Folgen'}` + (da.length < s.folgen.length ? ` · ${da.length} da` : '')));
    }));
    staffelZeigen();

    const staffelGesehen = el('button.knopf.klein', { onclick: async () => {
        const st = d.staffeln.find((s) => s.nummer === staffelNr);
        const alle = st.folgen.every((f) => f.fortschritt?.gesehen);
        for (const f of st.folgen) await api('wiedergabe/gesehen', 'POST', { art: 'folge', id: f.id, gesehen: !alle });
        meldung(alle ? 'Staffel als ungesehen markiert.' : 'Staffel als gesehen markiert.');
        app.neuLaden();
    } }, icon('haken'), 'Staffel gesehen');

    return el('div',
        heroEl,
        el('div.seite',
            el('section.abschnitt',
                el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } },
                    el('h2', { style: { margin: 0 } }, 'Folgen'), reihenfolgeWahl, el('div', { style: { marginLeft: 'auto' } }, staffelGesehen)),
                tabs, specialsHinweis, el('div', { style: { height: '14px' } }), folgenEl)),
        universumBereich(d.universen, 'serie', id, app),
        el('div.seite', besetzung(d.besetzung)),
        el('div', { style: { height: '40px' } }));
}

function folgeZeile(f, app, serieId, naechste) {
    const fs = f.fortschritt;
    const haken = el('button.icon-knopf' + (fs?.gesehen ? '.an' : ''), { title: fs?.gesehen ? 'Als ungesehen markieren' : 'Als gesehen markieren', onclick: async (e) => {
        e.stopPropagation();
        const neu = !haken.classList.contains('an');
        await api('wiedergabe/gesehen', 'POST', { art: 'folge', id: f.id, gesehen: neu });
        haken.classList.toggle('an', neu);
    } }, icon('haken'));
    const aktuell = naechste && naechste.id === f.id;
    const zeile = el('div.folge' + (f.vorhanden ? '' : '.fehlt') + (aktuell ? '.aktuell' : ''),
        el('div.bild', bild(f.standbild, ''), el('span.marke-klein.nr', String(f.nummer)),
            fs && !fs.gesehen && fs.prozent > 1 ? el('div.fortschritt', el('span', { style: { width: fs.prozent + '%' } })) : null),
        el('div',
            el('h3', `${f.nummer}. ${f.titel}`, f.laufzeit_min ? el('span', `${f.laufzeit_min} Min.`) : null),
            aktuell ? el('div.status', naechste.modus === 'weiter' ? 'Hier geht es weiter' : 'Als Nächstes') : null,
            f.beschreibung ? el('div.text', f.beschreibung) : null,
            el('div.klein-meta', [f.laufzeit_min ? f.laufzeit_min + ' Min.' : null, f.erstausstrahlung ? new Date(f.erstausstrahlung).toLocaleDateString('de-DE') : null,
                f.qualitaet, f.vorhanden ? null : 'nicht vorhanden'].filter(Boolean).join(' · '))),
        f.vorhanden ? el('div.aktionen', haken) : null);
    if (f.vorhanden) zeile.addEventListener('click', () => app.abspielen({ art: 'folge', id: f.id, serie_id: serieId }));
    return zeile;
}
