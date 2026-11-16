// Statusseite: Systemzustand, Hardware-Erkennung und Transkodiertest (nur im Heimnetz)
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, klasse, text) => {
    const e = document.createElement(tag);
    if (klasse) e.className = klasse;
    if (text !== undefined) e.textContent = text;
    return e;
};

async function api(pfad, methode = 'GET') {
    const r = await fetch('/api/v1/' + pfad, { method: methode, headers: methode === 'GET' ? {} : { 'X-Bluewave': '1' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.fehler || 'Fehler ' + r.status);
    return d;
}

function faehigkeit(name, ja) {
    const f = el('div', 'faehigkeit ' + (ja ? 'ja' : 'nein'));
    f.append(el('span', 'zeichen', ja ? '✓' : '–'), el('span', '', name));
    return f;
}

function zeigeHardware(hw, profile) {
    if (!hw) {
        $('hw-profil').textContent = 'noch nicht erkannt';
        return;
    }
    const aktiv = profile[hw.aktiv]?.name || hw.aktiv;
    $('hw-profil').textContent = aktiv;
    $('hw-profil').className = 'abzeichen' + (hw.aktiv !== 'software' ? ' hw' : '');
    const q = hw.quicksync || {};
    $('hw-geraet').textContent = q.verfuegbar
        ? `Intel-Grafik ${q.geraet} · ${q.treiber || 'Treiber unbekannt'}`
        : `CPU mit ${hw.software?.threads || '?'} Threads` + (hw.geraete?.length ? ` · Grafik: ${hw.geraete.map((g) => (g.hersteller || '?') + ' ' + g.pfad).join(', ')}` : '');

    const w = $('hw-warnungen');
    w.replaceChildren(...(hw.warnungen || []).map((t) => el('li', '', t)));

    const f = $('hw-faehigkeiten');
    if (q.verfuegbar) {
        f.replaceChildren(
            faehigkeit('HEVC 10-Bit dekodieren', q.dekodieren?.hevc10),
            faehigkeit('AV1 dekodieren', q.dekodieren?.av1),
            faehigkeit('VP9 dekodieren', q.dekodieren?.vp9),
            faehigkeit('H.264 kodieren', q.kodieren?.h264),
            faehigkeit('HEVC kodieren', q.kodieren?.hevc),
            faehigkeit('HEVC 10-Bit kodieren', q.kodieren?.hevc10),
            faehigkeit('AV1 kodieren', q.kodieren?.av1),
            faehigkeit('HDR-Tone-Mapping', q.tonemapping),
        );
    } else {
        f.replaceChildren(
            faehigkeit('H.264 (libx264)', hw.software?.h264),
            faehigkeit('HEVC (libx265)', hw.software?.hevc),
            faehigkeit('AV1 (SVT-AV1)', hw.software?.av1),
            faehigkeit('HDR-Tone-Mapping', hw.filter?.tonemapx || hw.filter?.zscale),
        );
    }
    zeigeTest(hw.test);
}

function zeigeTest(t) {
    const z = $('hw-test-ergebnis');
    if (!t) {
        z.replaceChildren();
        return;
    }
    const box = el('div', 'test');
    for (const l of t.laeufe) {
        const zeile = el('div', 'test-zeile' + (l.ok ? '' : ' fehler'));
        zeile.append(el('span', '', l.name), el('strong', '', l.ok ? `${String(l.echtzeit).replace('.', ',')}× Echtzeit · ${l.fps} fps` : l.fehler));
        box.append(zeile);
    }
    if (t.laeufe.every((l) => l.ok)) {
        const n = t.streams_4k;
        const anzahl = n === 0 ? 'unter einem Stream' : n === 1 ? 'etwa einen Stream' : `etwa ${n} gleichzeitige Streams`;
        box.append(el('p', 'leise', `Grobe Schätzung: ${anzahl} 4K → 1080p. Das Testbild entsteht auf der CPU – echte Filme laufen eher schneller.`));
    }
    z.replaceChildren(box);
}

function zeigeSystem(d) {
    const dl = $('system');
    const zeile = (n, wert, klasse) => {
        const dd = el('dd', klasse || '', wert);
        dl.append(el('dt', '', n), dd);
    };
    dl.replaceChildren();
    zeile('Version', d.version);
    zeile('Datenbank', d.datenbank.ok ? `verbunden · ${d.datenbank.version} · Schema ${d.datenbank.schema}` : d.datenbank.fehler, d.datenbank.ok ? 'ok' : 'schlecht');
    if (d.hardware?.ffmpeg) zeile('ffmpeg', `${d.hardware.ffmpeg.version || '?'}${d.hardware.ffmpeg.jellyfin ? ' (jellyfin-ffmpeg)' : ''}`);
    if (d.hardware?.zeit) zeile('Erkannt am', new Date(d.hardware.zeit).toLocaleString('de-DE'));

    const ul = $('ordner');
    ul.replaceChildren(...d.ordner.map((o) => {
        const li = el('li');
        const links = el('span');
        links.append(el('span', '', o.name + ' '), el('code', '', o.pfad));
        const status = !o.da ? ['fehlt', 'schlecht'] : !o.lesbar ? ['nicht lesbar', 'schlecht'] : [o.schreibbar ? 'lesen + schreiben' : 'nur lesen', 'ok'];
        li.append(links, el('span', status[1], status[0]));
        return li;
    }));
}

async function laden() {
    try {
        const d = await api('system');
        zeigeSystem(d);
        zeigeHardware(d.hardware, d.profile);
        window.__profile = d.profile;
    } catch (e) {
        $('hw-profil').textContent = 'Fehler';
        $('hw-warnungen').replaceChildren(el('li', '', e.message));
    }
}

async function mitKnopf(knopf, text, arbeit) {
    const alt = knopf.textContent;
    knopf.disabled = true;
    knopf.textContent = text;
    try {
        await arbeit();
    } catch (e) {
        $('hw-warnungen').append(el('li', '', e.message));
    } finally {
        knopf.disabled = false;
        knopf.textContent = alt;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (!$('transkodieren')) return;
    $('hw-erkennen').addEventListener('click', (ev) => mitKnopf(ev.currentTarget, 'Erkenne …', async () => {
        const d = await api('system/hardware/erkennen', 'POST');
        zeigeHardware(d.hardware, window.__profile || {});
    }));
    $('hw-test').addEventListener('click', (ev) => mitKnopf(ev.currentTarget, 'Teste … (bis zu 1 Minute)', async () => {
        const d = await api('system/hardware/test', 'POST');
        zeigeTest(d.test);
    }));
    laden();
});
