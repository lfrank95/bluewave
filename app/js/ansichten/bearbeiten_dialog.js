// Admin: Film oder Serie bearbeiten – Metadaten (gesperrt gegen TMDB), Bilder (TMDB-Auswahl, Link, z. B. ThePosterDB),
// Zuordnung, Fassungen, Universen
'use strict';
import { el, icon, meldung, auswahl, bestaetigen } from '../ui.js';
import { api } from '../api.js';

const FSK = { '': '–', 0: 'FSK 0', 6: 'FSK 6', 12: 'FSK 12', 16: 'FSK 16', 18: 'FSK 18' };
const STATUS = { laufend: 'Läuft', beendet: 'Beendet', abgesetzt: 'Abgesetzt', geplant: 'Geplant', unbekannt: 'Unbekannt' };
const FELDNAMEN = {
    titel: 'Titel', originaltitel: 'Originaltitel', sortiertitel: 'Sortiertitel', jahr: 'Jahr', erscheinungsdatum: 'Erscheinungsdatum',
    laufzeit_min: 'Laufzeit (Min.)', tagline: 'Tagline', beschreibung: 'Beschreibung', regie: 'Regie', freigabe: 'Altersfreigabe',
    bewertung: 'Bewertung (0–10)', genres: 'Genres', jahr_von: 'Von (Jahr)', jahr_bis: 'Bis (Jahr)', status: 'Status', sender: 'Sender / Dienst',
};

/**
 * @param art    'film' | 'serie'
 * @param id
 * @param extra  { staffeln?: [{nummer, name, poster}], staffel?: Nummer, aktionen: [{text, icon, fn}] }
 */
export async function bearbeitenDialog(art, id, extra = {}) {
    let d = await api(`${art}/${id}/bearbeiten`);
    let geaendert = false;
    const anfang = JSON.stringify(d.werte);
    const zurueck = new Set();

    // ---------- Reiter „Allgemein“ ----------
    const eingaben = {};
    const feldKopf = (name) => {
        const gesperrt = d.gesperrt.includes(name);
        return el('label.bearb-label', FELDNAMEN[name],
            gesperrt ? el('span.sperre', { title: 'Von Hand geändert – TMDB überschreibt das nicht' }, icon('schloss')) : null,
            gesperrt ? el('button.zuruecksetzen', { type: 'button', title: 'Auf den TMDB-Wert zurücksetzen', onclick: (e) => {
                e.preventDefault();
                zurueck.add(name);
                e.currentTarget.closest('.bearb-feld').classList.add('wird-zurueckgesetzt');
                e.currentTarget.replaceWith(el('span.leise', { style: { fontSize: '0.75rem' } }, 'wird zurückgesetzt'));
            } }, icon('zurueck'), 'TMDB') : null);
    };
    const feld = (name, eingabe, breit = false) => {
        eingaben[name] = eingabe;
        eingabe.addEventListener('input', () => { zurueck.delete(name); eingabe.closest('.bearb-feld')?.classList.remove('wird-zurueckgesetzt'); });
        return el('div.bearb-feld' + (breit ? '.breit' : ''), feldKopf(name), eingabe);
    };
    const text = (name, extraAttr = {}) => el('input.eingabe', { value: d.werte[name] ?? '', ...extraAttr });
    const zahl = (name, attr = {}) => el('input.eingabe', { type: 'number', value: d.werte[name] ?? '', ...attr });

    // Genres als Chips mit Vorschlägen
    let genres = [...(d.werte.genres || [])];
    const genreChips = el('div.genre-chips');
    const genreListe = el('datalist', { id: 'bw-genres' }, d.alle_genres.map((g) => el('option', { value: g })));
    const genreEingabe = el('input.eingabe', { list: 'bw-genres', placeholder: 'Genre hinzufügen …' });
    const genresZeigen = () => genreChips.replaceChildren(...genres.map((g) => el('span.chip', g,
        el('button.chip-x', { type: 'button', 'aria-label': `${g} entfernen`, onclick: () => { genres = genres.filter((x) => x !== g); genresZeigen(); genreEingabe.dispatchEvent(new Event('input')); } }, icon('schliessen')))));
    genreEingabe.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const g = genreEingabe.value.trim();
            if (g && !genres.includes(g)) { genres.push(g); genresZeigen(); }
            genreEingabe.value = '';
        }
    });
    genreEingabe.addEventListener('change', () => {
        const g = genreEingabe.value.trim();
        if (g && d.alle_genres.includes(g) && !genres.includes(g)) { genres.push(g); genresZeigen(); genreEingabe.value = ''; }
    });
    genresZeigen();
    const genreFeld = el('div.bearb-feld.breit', feldKopf('genres'), genreChips, genreEingabe, genreListe);
    genreEingabe.addEventListener('input', () => zurueck.delete('genres'));

    const beschreibung = el('textarea.eingabe', { rows: 6 }, d.werte.beschreibung ?? '');
    const specials = art === 'serie' ? auswahl({ standard: 'Wie in den Profil-Einstellungen', zeigen: 'Immer anzeigen', ausblenden: 'Ausblenden' }, d.specials || 'standard') : null;
    const fsk = auswahl(FSK, d.werte.freigabe ?? '');
    const allgemein = el('div.bearb-raster',
        feld('titel', text('titel'), true),
        feld('originaltitel', text('originaltitel')),
        feld('sortiertitel', text('sortiertitel', { placeholder: 'automatisch (ohne Der/Die/The …)' })),
        art === 'film' ? [
            feld('erscheinungsdatum', text('erscheinungsdatum', { type: 'date' })),
            feld('jahr', zahl('jahr', { min: 1870, max: 2200 })),
            feld('laufzeit_min', zahl('laufzeit_min', { min: 0, max: 2000 })),
            feld('regie', text('regie')),
            feld('tagline', text('tagline'), true),
        ] : [
            feld('jahr_von', zahl('jahr_von', { min: 1870, max: 2200 })),
            feld('jahr_bis', zahl('jahr_bis', { min: 1870, max: 2200 })),
            feld('status', auswahl(STATUS, d.werte.status || 'unbekannt')),
            feld('sender', text('sender')),
        ],
        feld('freigabe', fsk),
        feld('bewertung', el('input.eingabe', { type: 'number', step: '0.1', min: 0, max: 10, value: d.werte.bewertung ?? '' })),
        genreFeld,
        feld('beschreibung', beschreibung, true),
        specials ? el('div.bearb-feld.breit', el('label.bearb-label', 'Specials / Extras (Staffel 0)'), specials,
            el('p.hinweis-leise', 'Ausgeblendete Specials lassen sich auf der Serienseite trotzdem kurz einblenden.')) : null,
        el('p.hinweis-leise.breit', 'Geänderte Felder bekommen ein Schloss: TMDB-Abgleiche überschreiben sie nicht mehr. „TMDB“ daneben holt den ursprünglichen Wert zurück.'));

    const sammeln = () => {
        const neu = {};
        for (const [name, e] of Object.entries(eingaben)) {
            let w = e.value;
            if (['jahr', 'jahr_von', 'jahr_bis', 'laufzeit_min'].includes(name)) w = w === '' ? null : Number(w);
            else if (name === 'bewertung') w = w === '' ? null : Number(w);
            else w = w.trim() === '' ? null : w.trim();
            const alt = d.werte[name] ?? null;
            if (String(w ?? '') !== String(alt ?? '') && !zurueck.has(name)) neu[name] = w;
        }
        if (JSON.stringify([...genres].sort()) !== JSON.stringify([...(d.werte.genres || [])].sort()) && !zurueck.has('genres')) neu.genres = genres;
        return neu;
    };

    // ---------- Reiter „Bilder“ ----------
    const bilder = el('div.bearb-bilder');
    let bilderGeladen = false;
    const ziele = [
        { typ: 'poster', art, staffel: 0, name: 'Poster', format: 'hoch' },
        { typ: 'hintergrund', art, staffel: 0, name: 'Hintergrund', format: 'quer' },
        { typ: 'logo', art, staffel: 0, name: 'Logo', format: 'logo' },
        ...(art === 'serie' ? (extra.staffeln || []).map((s) => ({ typ: 'poster', art: 'staffel', staffel: s.nummer, name: s.name, format: 'hoch', poster: s.poster })) : []),
    ];
    const zielWahl = el('select', { 'aria-label': 'Bild' }, ziele.map((z, i) => el('option', { value: i }, z.art === 'staffel' ? `Staffel-Poster: ${z.name}` : z.name)));
    if (extra.staffel !== undefined && art === 'serie') {
        const i = ziele.findIndex((z) => z.art === 'staffel' && z.staffel === extra.staffel);
        if (i >= 0 && extra.bilderStaffel) zielWahl.value = String(i);
    }
    const bildBereich = el('div.bild-bereich');
    const setzen = async (z, url, knopf) => {
        if (knopf) knopf.classList.add('laedt');
        try {
            const r = await api('poster', 'POST', { art: z.art, id, staffel: z.staffel, typ: z.typ, url });
            geaendert = true;
            meldung(r.hinweis || `${z.name} gespeichert` + (r.datei ? ': ' + r.datei.split('/').pop() : '.'), !!r.hinweis);
            d = await api(`${art}/${id}/bearbeiten`);
            if (z.art === 'staffel') z.poster = r.poster;
            bildZeigen();
        } catch (x) {
            meldung(x.message, true);
        } finally {
            knopf?.classList.remove('laedt');
        }
    };
    const bildZeigen = async () => {
        const z = ziele[Number(zielWahl.value)];
        const aktuell = z.art === 'staffel' ? z.poster : d.bilder[z.typ];
        const eigen = z.art !== 'staffel' && d.bilder.eigen.includes(z.typ);
        const dateiname = z.art === 'staffel' ? (z.staffel === 0 ? 'season-specials-poster.jpg' : `season${String(z.staffel).padStart(2, '0')}-poster.jpg`)
            : art === 'film' ? `…-${{ poster: 'poster', hintergrund: 'fanart', logo: 'clearlogo' }[z.typ]}.jpg` : `${{ poster: 'poster', hintergrund: 'fanart', logo: 'clearlogo' }[z.typ]}.jpg`;
        const link = el('input.eingabe', { type: 'url', placeholder: 'Link einfügen – z. B. von ThePosterDB oder fanart.tv', spellcheck: 'false' });
        const linkKnopf = el('button.knopf.haupt', { type: 'button', onclick: (e) => link.value.trim() && setzen(z, link.value.trim(), e.currentTarget) }, 'Übernehmen');
        link.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); linkKnopf.click(); } });
        const raster = el('div.tmdb-bilder.' + z.format, el('p.leise', 'Lade Auswahl von TMDB …'));
        bildBereich.replaceChildren(
            el('div.bild-aktuell',
                el('div.vorschau.' + z.format, aktuell ? el('img', { src: aktuell, alt: '' }) : el('span', 'kein Bild')),
                el('div',
                    el('b', z.art === 'staffel' ? `Poster · ${z.name}` : z.name),
                    el('div.leise', { style: { fontSize: '0.85rem', margin: '4px 0 12px' } }, eigen ? 'Eigenes Bild – hat Vorrang vor TMDB' : 'Von TMDB bzw. aus dem Ordner'),
                    el('div.link-zeile', link, linkKnopf),
                    el('p.hinweis-leise', 'Wird in den Medienordner gelegt als ', el('code.poster-datei', dateiname), '.'),
                    eigen ? el('button.knopf.klein', { type: 'button', onclick: async () => {
                        if (!await bestaetigen('Eigenes Bild entfernen', 'Das eigene Bild wandert in die Sicherungen, danach gilt wieder TMDB bzw. das Ordnerbild.', 'Entfernen')) return;
                        await api('poster', 'DELETE', { art: z.art, id, staffel: z.staffel, typ: z.typ });
                        geaendert = true;
                        d = await api(`${art}/${id}/bearbeiten`);
                        bildZeigen();
                    } }, icon('zurueck'), 'Eigenes Bild entfernen') : null)),
            el('h4', 'Von TMDB'),
            raster);
        try {
            const q = z.art === 'staffel' ? `?staffel=${z.staffel}` : '';
            const auswahlTmdb = await api(`${art}/${id}/bilder${q}`);
            const liste = auswahlTmdb[z.typ] || [];
            raster.replaceChildren(...(liste.length ? liste.map((b) => el('button.tmdb-bild', { type: 'button', title: [b.sprache ? b.sprache.toUpperCase() : 'ohne Text', b.breite && `${b.breite}×${b.hoehe}`].filter(Boolean).join(' · '),
                onclick: (e) => setzen(z, b.gross, e.currentTarget) },
                el('img', { src: b.klein, alt: '', loading: 'lazy' }), b.sprache ? el('span.sprache', b.sprache.toUpperCase()) : null))
                : [el('p.leise', d.tmdb_id ? 'TMDB hat dafür keine Bilder.' : 'Nicht mit TMDB verknüpft.')]));
        } catch (x) {
            raster.replaceChildren(el('p.schlecht', x.message));
        }
    };
    zielWahl.addEventListener('change', bildZeigen);
    bilder.append(el('div.feld', el('label', 'Bild'), zielWahl), bildBereich, el('p.hinweis-leise', 'Bilder werden sofort übernommen.'));

    // ---------- Reiter „Mehr“ ----------
    const mehr = el('div.bearb-mehr',
        el('p.leise', d.tmdb_id ? `Verknüpft mit TMDB-Nr. ${d.tmdb_id}.` : 'Noch nicht mit TMDB verknüpft.'),
        (extra.aktionen || []).map((a) => el('button.knopf', { type: 'button', onclick: () => { schliessen(); a.fn(); } }, a.icon ? icon(a.icon) : null, a.text)));

    // ---------- Rahmen mit Reitern ----------
    const seiten = { allgemein, bilder, mehr };
    const reiterLeiste = el('div.segment.bearb-reiter');
    const reiter = (key, name) => {
        const b = el('button' + (key === 'allgemein' ? '.an' : ''), { type: 'button', onclick: () => {
            reiterLeiste.querySelectorAll('button').forEach((x) => x.classList.toggle('an', x === b));
            for (const [k, s] of Object.entries(seiten)) s.hidden = k !== key;
            if (key === 'bilder' && !bilderGeladen) { bilderGeladen = true; bildZeigen(); }
        } }, name);
        return b;
    };
    reiterLeiste.append(reiter('allgemein', 'Allgemein'), reiter('bilder', 'Bilder'), reiter('mehr', 'Zuordnung & mehr'));
    bilder.hidden = true;
    mehr.hidden = true;
    if (extra.bilderStaffel) reiterLeiste.children[1].click();

    const hg = el('div.dialog-hg');
    const speichernKnopf = el('button.knopf.haupt', { type: 'button', onclick: async () => {
        const felder = sammeln();
        const specialsNeu = specials && specials.value !== (d.specials || 'standard') ? specials.value : null;
        if (!Object.keys(felder).length && !zurueck.size && !specialsNeu) { schliessen(); return; }
        speichernKnopf.disabled = true;
        try {
            d = await api(`${art}/${id}/bearbeiten`, 'PUT', { felder, zuruecksetzen: [...zurueck], ...(specialsNeu ? { specials: specialsNeu } : {}) });
            geaendert = true;
            meldung('Gespeichert.');
            schliessen();
        } catch (x) {
            meldung(x.message, true);
            speichernKnopf.disabled = false;
        }
    } }, icon('haken'), 'Speichern');
    const fenster = el('div.dialog.bearb-dialog.glass-panel',
        el('div.bearb-kopf', el('h2', art === 'film' ? 'Film bearbeiten' : 'Serie bearbeiten'), el('span.leise', d.werte.titel),
            el('button.mini-knopf', { type: 'button', 'aria-label': 'Schließen', style: { marginLeft: 'auto' }, onclick: () => schliessen() }, icon('schliessen'))),
        reiterLeiste,
        el('div.bearb-inhalt', allgemein, bilder, mehr),
        el('div.knoepfe', el('button.knopf', { type: 'button', onclick: () => schliessen() }, 'Abbrechen'), speichernKnopf));
    hg.append(fenster);
    const taste = (e) => { if (e.key === 'Escape') schliessen(); };
    let zu = false;
    function schliessen() {
        if (zu) return;
        const ungespeichert = Object.keys(sammeln()).length > 0 && JSON.stringify(d.werte) === anfang;
        if (ungespeichert && !speichernKnopf.disabled && !confirm('Änderungen verwerfen?')) return;
        zu = true;
        hg.remove();
        document.removeEventListener('keydown', taste);
        if (geaendert) window.__bluewave.neuLaden();
    }
    document.addEventListener('keydown', taste);
    hg.addEventListener('click', (e) => { if (e.target === hg) schliessen(); });
    document.body.append(hg);
    eingaben.titel?.focus();
}
