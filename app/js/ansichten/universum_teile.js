// Universums-Bausteine für die Detailseiten: Bereich mit Position, Nachbarn, „Danach“ und Zuordnungs-Dialog
'use strict';
import { el, icon, bild, meldung, dialog } from '../ui.js';
import { api } from '../api.js';

const link = (t) => (t.art === 'serie' ? `#/serie/${t.id}${t.staffel ? '?staffel=' + t.staffel : ''}` : `#/film/${t.id}`);

/** Bereich „Teil eines Universums“ – ein Block für das erste Universum, die weiteren als „Auch in“ */
export function universumBereich(liste, art, id, app) {
    const admin = app.konto.rolle === 'admin';
    const bearbeiten = admin ? el('button.chip-gestrichelt', { onclick: () => universenDialog(art, id, liste) }, icon('bearbeiten'), 'Universen bearbeiten') : null;
    if (!liste?.length) {
        return admin ? el('section.universum-bereich', { style: { padding: '18px 22px' } },
            el('div.kopfzeile', el('div.symbol', icon('universum')),
                el('div', el('small', 'UNIVERSUM'), el('div.leise', 'Noch in keinem Universum.')), el('div', { style: { marginLeft: 'auto' } }, bearbeiten))) : null;
    }
    const u = liste[0];
    const prozent = u.gesamt ? Math.round((u.gesehen / u.gesamt) * 100) : 0;
    const nachbarn = el('div.nachbarn', u.nachbarn.map((t) => {
        const nr = u.nr + (u.nachbarn.indexOf(t) - u.nachbarn.findIndex((x) => x.aktuell));
        return el('a.nachbar' + (t.aktuell ? '.aktuell' : ''), { href: link(t) },
            el('small', t.aktuell ? `NR. ${nr} · HIER` : `NR. ${nr}`),
            el('div.bild', bild(t.hintergrund || t.poster, t.titel), el('b', t.titel),
                t.gesehen ? el('span.gesehen-haken', { style: { top: '10px', right: '10px', position: 'absolute', zIndex: 3 } }, icon('haken')) : null),
            el('div.z', [t.art === 'serie' ? 'Serie' : 'Film', t.jahr].filter(Boolean).join(' · ')));
    }));
    const danach = u.danach ? el('a.knopf', { href: link(u.danach) }, icon('weiter'), `Danach: ${u.danach.titel}`) : null;
    return el('section.universum-bereich',
        el('div.kopfzeile',
            el('div.symbol', icon('universum')),
            el('div', el('small', 'TEIL EINES UNIVERSUMS'), el('h2', el('a', { href: `#/universum/${u.id}`, style: { color: 'inherit' } }, u.name))),
            el('div.stand', el('b', `Nr. ${u.nr} `, el('span', `von ${u.gesamt}`)),
                el('div.balken-klein', el('span', { style: { width: prozent + '%' } })),
                el('div.leise', { style: { fontSize: '0.82rem', marginTop: '6px' } }, `${u.gesehen} von ${u.gesamt} gesehen`))),
        nachbarn,
        el('div.fusszeile',
            el('a.knopf.haupt', { href: `#/universum/${u.id}` }, icon('universum'), 'Ganzes Universum'),
            danach,
            el('div.auch', liste.length > 1 ? ['Auch in', liste.slice(1).map((x) => el('a.chip.akzent', { href: `#/universum/${x.id}` }, `${x.name} · Nr. ${x.nr}`))] : null, bearbeiten)));
}

/** Dialog: in welchen Universen steckt dieser Titel? */
export async function universenDialog(art, id, aktuell) {
    const d = await api('universen');
    const drin = new Set((aktuell || []).map((u) => u.id));
    const kaesten = d.universen.map((u) => {
        const cb = el('input', { type: 'checkbox', value: u.id, checked: drin.has(u.id) });
        return el('label.liste-eintrag', { style: { cursor: 'pointer' } }, cb,
            el('div.mitte', el('b', u.name), el('span', `${u.eintraege} Titel`)));
    });
    const neuName = el('input.eingabe', { placeholder: 'Neues Universum …' });
    const inhalt = el('div',
        kaesten.length ? el('div', kaesten) : el('p.leise', 'Es gibt noch keine Universen.'),
        el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px' } }, neuName),
        el('p.hinweis-leise', 'Neue Titel landen am Ende des Universums. Die Reihenfolge änderst du im Universum unter „Bearbeiten“.'));
    const ok = await dialog('Universen dieses Titels', inhalt, [
        { text: 'Abbrechen', wert: null },
        { text: 'Speichern', haupt: true, aktion: async () => {
            try {
                const ids = kaesten.map((k) => k.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.value));
                if (neuName.value.trim()) {
                    const n = await api('universen', 'POST', { name: neuName.value.trim() });
                    ids.push(n.id);
                }
                await api(`${art}/${id}/universen`, 'PUT', { ids });
                return true;
            } catch (x) { meldung(x.message, true); return false; }
        } },
    ]);
    if (ok) {
        meldung('Universen gespeichert.');
        window.__bluewave.neuLaden();
    }
}
