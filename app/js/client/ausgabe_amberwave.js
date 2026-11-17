// Übernommen aus Amberwave (Einstellungen › Ausgabe) von werkzeug/amberwave_ausgabe_port.py – Änderungen dort mitpflegen.
// pl: Zustand der Ausgabe im Bluewave-Client (client/ausgabe.js) – Format, Anlauf und Aussetzer aus den Engine-Meldungen.
import { h, icon, toast } from './aw_ui.js';
import { t, tn, zahl, locale } from './aw_i18n.js';
import { nativ, istAsio } from './nativ.js';
import { symbolSvg, symbolVon, ausgangName, ausgangUnter } from './ausgaenge.js';
import { ausgaengeFenster } from './ausgaenge_fenster.js';

const segment = (optionen, wert, attr = '') => `<div class="segment" role="radiogroup" ${attr}>${optionen.map(([w, tx]) => `<button type="button" role="radio" data-w="${h(w)}" aria-checked="${String(w) === String(wert)}">${h(tx)}</button>`).join('')}</div>`;
const zeile = (k, name, hinweis, regler, extra = '') => `<div class="einst-zeile" data-k="${h(k)}" ${extra}><div class="einst-text"><span class="einst-name">${name}</span>${hinweis ? `<p>${hinweis}</p>` : ''}</div><div class="einst-regler">${regler}</div></div>`;
const karte = (titel, inhalt, rechts = '', attr = '') => `<div class="einst-karte" ${attr}>${titel ? `<h2><span>${h(titel)}</span>${rechts}</h2>` : ''}${inhalt}</div>`;
const AUFSCHLAG_STUFEN = [[0, t('Keine')], [100, '100 ms'], [250, t('250 ms (Standard)')], [500, '500 ms'], [750, '750 ms'], [1000, '1 s'], [1500, `${zahl(1.5)} s`], [2000, '2 s'], [2500, `${zahl(2.5)} s`], [3000, '3 s'], [4000, '4 s'], [5000, '5 s']];

// ---------- Windows-Ausgabe: Signalweg als Bühne, Geräte gruppiert, Einstellungen darunter ----------
const khz = (r) => `${(Math.round(r / 100) / 10).toLocaleString(locale, { maximumFractionDigits: 1 })} kHz`;
const istAsioId = (id) => String(id || '').startsWith('asio:');
const kanalText = (k) => (k >= 8 ? '7.1' : k >= 6 ? '5.1' : k === 4 ? t('Quadro') : t('{n} Kanäle', { n: k || 2 }));
const BUEHNE_ICON = {
  datei: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="10" cy="15" r="2"/><path d="M12 15V9.5l3 1"/>',
  engine: '<path d="M3 12h3l2-5 4 10 3-7 2 2h4"/>',
  treiber: '<rect x="2" y="7" width="20" height="10" rx="2.5"/><circle cx="12" cy="12" r="2.4"/><circle cx="17" cy="12" r="1.6"/><path d="M5 10.5h3M5 13.5h3"/>',
  mixer: '<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1"/><rect x="10" y="7" width="4" height="3" rx="1"/><rect x="16" y="11" width="4" height="3" rx="1"/>',
  schild: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12.2 2.2 2.2 4.3-4.6"/>',
  pfeil: '<path d="m9 6 6 6-6 6"/>',
};
const ICON_GERAET = {
  interface: '<rect x="2" y="7" width="20" height="10" rx="2.5"/><circle cx="12" cy="12" r="2.4"/><circle cx="17" cy="12" r="1.6"/><path d="M5 10.5h3M5 13.5h3"/>',
  lautsprecher: '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><circle cx="12" cy="14.5" r="3.6"/><circle cx="12" cy="7" r="1.6"/>',
  receiver: '<rect x="2" y="6" width="20" height="11" rx="2"/><path d="M6 20h12M8 9.5h8M8 12.5h5"/>',
  kopfhoerer: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  windows: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};
const AUGE_ZU = '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 9 4.5 10 7a12.6 12.6 0 0 1-3 4M6.2 6.6C4.2 8 2.8 10 2 12c1 2.5 5 7 10 7a9.4 9.4 0 0 0 4.2-1"/>';
const AUGE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
function geraetArt(g) {
  if (!g || g.id === '') return 'windows';
  if (istAsioId(g.id)) return 'interface';
  const n = `${g.name || ''}`.toLowerCase();
  if (/hdmi|receiver|\bav\b|displayport|nvidia|amd high definition|intel.*display/.test(n)) return 'receiver';
  if (/kopfh|headphone|headset|dac|usb audio/.test(n)) return 'kopfhoerer';
  return 'lautsprecher';
}
const treiberName = (g) => (g ? g.eigener_name || String(g.name || '').replace(/^ASIO · /, '') || t('Windows-Standardgerät') : t('Windows-Standardgerät'));
/** Anzeigename: ASIO-Ausgang „Treiber · Ausgang“ nur, wo der Treiber nicht schon dasteht */
const geraetName = (g, mitTreiber = true) => (g?.ausgang ? (mitTreiber ? `${ausgangName(g.ausgang)} · ${treiberName(g)}` : ausgangName(g.ausgang)) : treiberName(g));

export function ausgabeZeichnen(inhalt, signal, pl) {
  if (!nativ) {
    inhalt.innerHTML = karte('', `<p class="einst-leer">${icon('computer', 22)}${t('Diese Einstellungen gibt es nur im Bluewave Windows-Client – dort wählst du Ausgabegerät, Exklusiv-Modus, ASIO und Abtastrate für diesen PC.')}</p>`);
    return;
  }
  const merkenGeht = typeof nativ.geraetMerken === 'function';
  let geraete = [], wahl = { geraet: '', exklusiv: false, rate: 0, aufschlag: 250 }, ausgeblendetZeigen = false, bearbeitet = null;
  inhalt.innerHTML = `
    <section class="aus-buehne" data-k="geraet" data-buehne aria-label="${h(t('Signalweg'))}"></section>
    <div class="einst-karte" data-k="geraete"><h2><span>${t('Ausgabegerät')}</span><span class="einst-chip" data-geraete-zahl></span></h2><div class="aus-geraete" data-geraete><div class="lade"></div></div></div>
    ${karte('', `
      ${zeile('modus', t('Modus'), '<span data-modus-text></span>', segment([['geteilt', t('Geteilt')], ['exklusiv', t('Exklusiv')]], 'geteilt', `data-modus aria-label="${h(t('Modus'))}"`))}
      ${zeile('rate', `<label for="en-rate">${t('Abtastrate am Gerät')}</label>`, t('„Folgt der Datei“ bleibt bitgenau, das Interface schaltet bei jedem Wechsel um. Fest: anderes wird linearphasig umgerechnet (Störungen unter −150 dB), Übergänge bleiben lückenlos.'), `<select id="en-rate" class="einst-feld" data-n-rate><option value="0">${t('Folgt der Datei')}</option>${[44100, 48000, 88200, 96000, 176400, 192000].map((r) => `<option value="${r}">${t('Fest {rate}', { rate: khz(r) })}</option>`).join('')}</select>`)}
      ${zeile('aufschlag', `<label for="en-aufschlag">${t('Pause nach dem Umschalten')}</label>`, t('Wie beim CD-Wechsel: lieber kurz Stille als ein abgeschnittener Anfang. Manche Interfaces geben ihren Ausgang nach einem Ratenwechsel erst spät frei. Gemerkt für dieses Gerät.') + ' <span class="aus-zeitleiste" data-zeitleiste></span>', `<select id="en-aufschlag" class="einst-feld" data-n-aufschlag>${AUFSCHLAG_STUFEN.map(([w, tx]) => `<option value="${w}">${tx}</option>`).join('')}</select>`)}
      ${zeile('asio', t('ASIO-Treiber'), t('Puffergröße und Taktquelle stellt das Treiberfenster des Herstellers ein.'), `<button type="button" class="btn btn-zweit btn-klein" data-n-asio>${t('Treiber-Einstellungen …')}</button>`, 'data-asio-zeile hidden')}
    `)}
    <p class="einst-fuss aus-fuss">${t('Bitgenau (exklusiv oder ASIO) heißt: Lautstärke 100 %, Lautstärke-Angleich aus und keine Effekte – sonst rechnet die Engine (64 Bit, mit Dither).')} Bluewave Windows-Client ${h(nativ.version || '')}.</p>`;
  const $ = (s) => inhalt.querySelector(s);
  const aktuell = () => geraete.find((g) => g.id === wahl.geraet) || (wahl.geraet === '' ? { id: '', name: t('Windows-Standardgerät') } : null);

  // ----- Bühne: Datei → Engine → Treiber/Windows → Ausgang (feste Maße; Umbruch je nach Platz macht das CSS) -----
  const buehne = () => {
    const f = pl.audio.format;
    const g = aktuell();
    const asio = f ? f.asio : istAsioId(wahl.geraet);
    const exkl = f ? f.exklusiv && !f.asio : wahl.exklusiv && !asio;
    const weg = asio ? 'asio' : exkl ? 'exklusiv' : 'geteilt';
    const bw = pl.bewertung() || { stufe: 'transparent', grund: '' };
    const tr = pl.track;
    const codec = (tr?.format?.codec || tr?.format?.datei || '').replace(/^pcm_.*/, 'PCM').toUpperCase();
    const gr = f ? f.geraet_rate || f.aus_rate : 0;
    const ms = f && f.latenz && gr ? `${zahl(Math.round(f.latenz / gr * 10000) / 10)} ms` : '';
    const status = !f ? { klasse: '', text: t('noch nichts abgespielt') }
      : bw.stufe === 'bitgenau' ? { klasse: 'gut', text: t('bitgenau') } : bw.stufe === 'transparent' ? { klasse: 'gut leise', text: t('klanglich unverändert') } : { klasse: 'warn', text: t('verändert') };
    const kopf = weg === 'asio'
      ? ['', 'ASIO', t('Direkt zum Treiber.'), t('Kein Windows-Mixer, kein Umrechnen, keine Systemklänge – jedes Sample kommt so am Wandler an, wie es in der Datei steht.')]
      : weg === 'exklusiv'
        ? ['klein', t('Exklusiv'), t('Bluewave hat das Gerät für sich.'), t('An der Windows-Mischung vorbei, die Abtastrate folgt der Datei. Andere Programme sind solange stumm.')]
        : ['klein leise', t('Geteilt'), t('Windows mischt mit.'), t('Andere Programme bleiben hörbar – dafür mischt und rechnet Windows. Für bitgenau „Exklusiv“ wählen oder ein ASIO-Gerät.')];
    const ic = (n, gr2 = 15) => `<svg width="${gr2}" height="${gr2}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BUEHNE_ICON[n] || n}</svg>`;
    const st = (art, titel, symbol, name, wert, det, extra = '') => `<div class="aus-st ${art}" ${extra}><span class="aus-st-zeile"><span class="aus-klein">${titel}</span>${symbol}</span><b title="${h(name)}">${h(name)}</b><span class="aus-st-wert">${wert ? h(wert) : ''}</span><span class="aus-st-det">${det}</span></div>`;
    const ver = (k, chip = '') => `<div class="aus-ver ${k}" aria-hidden="true">${ic('pfeil', 16)}${chip ? `<span class="aus-ver-chip">${h(chip)}</span>` : ''}</div>`;
    // Treiber bzw. Windows-Mixer
    const treiber = weg === 'asio'
      ? st('treiber', t('ASIO-Treiber'), ic('treiber'), g?.eigener_name || (f?.geraet || treiberName(g)).replace(/^ASIO · /, ''), ms ? t('Latenz {ms}', { ms }) : '', f ? '<i></i>' + t('läuft') : t('bereit'))
      : weg === 'exklusiv'
        ? st('treiber', t('WASAPI exklusiv'), ic('treiber'), t('Windows-Treiber'), '', t('direkt, ohne Mischung'))
        : st('mixer', t('Windows-Audio'), ic('mixer'), t('Mixer'), f && gr && Math.abs(gr - f.rate) > 1 ? `${khz(f.rate)} → ${khz(gr)}` : '', t('mischt Programme und Systemklänge dazu'));
    // Ausgang: ASIO-Ausgang mit Symbol und Kanälen, sonst das Windows-Gerät
    const ausgang = g?.ausgang
      ? st('ausgang', t('Ausgang'), `<span class="aus-st-sym">${symbolSvg(symbolVon(g.ausgang), 18)}</span>`, ausgangName(g.ausgang), gr ? khz(gr) : '', h(ausgangUnter(g.ausgang)))
      : st('ausgang', t('Ausgang'), `<span class="aus-st-sym">${ic(ICON_GERAET[geraetArt(g)], 18)}</span>`, geraetName(g, false), gr ? khz(gr) : '', g && g.id !== '' ? h(`${g.kanaele ? `${kanalText(g.kanaele)} · ` : ''}${asio ? 'ASIO' : 'WASAPI'}`) : t('folgt der Einstellung in Windows'));
    const format = f ? f.aus_format || '' : '';
    const genau = !!f && bw.stufe === 'bitgenau';
    const engineWert = !f ? '' : genau ? t('bitgenau') : format;
    const engineText = !f ? t('wartet auf den ersten Titel') : genau ? t('reicht unverändert durch') : h(bw.grund || t('rechnet in 64 Bit'));
    const umweg = weg !== 'geteilt'
      ? `<div class="aus-umweg">${ic('schild', 22)}<div><span><s>${t('Windows-Audio')}</s> <em>${t('umgangen')}</em></span><span>${t('kein Mixer, kein Umrechnen')}</span></div></div>`
      : `<div class="aus-umweg">${ic('mixer', 22)}<div><span><em>${t('Windows mischt')}</em></span><span>${t('für bitgenau: Exklusiv oder ASIO')}</span></div></div>`;
    const b = $('[data-buehne]');
    b.className = `aus-buehne ${weg}${f ? '' : ' ruhe'}${f && pl.audio.aussetzerZahl ? ' mit-aussetzern' : ''}`;
    b.innerHTML = `
      <div class="aus-kopf"><div class="aus-wort ${kopf[0]}">${kopf[1]}</div><div class="aus-kopf-tx"><b>${kopf[2]}</b><span>${kopf[3]}</span></div><span class="aus-status ${status.klasse}" title="${h(bw.grund || '')}"><i></i>${status.text}</span></div>
      <div class="aus-kette">
        ${st('datei', t('Datei'), ic('datei'), codec || (f ? 'PCM' : '—'), f ? `${f.bits} Bit · ${khz(f.rate)}` : '', f ? kanalText(f.kanaele) : t('noch nichts abgespielt'))}${ver('v1')}
        ${st('engine', 'Engine', ic('engine'), 'Bluewave', engineWert, engineText, genau && format ? `data-nach=" → ${h(format)}"` : '')}${ver('v2', f ? format : '—')}
        ${treiber}${ver('v3')}
        ${ausgang}
      </div>
      <div class="aus-leiste">${umweg}<div class="aus-werte">
        <div><small>${t('Abtastrate')}</small><b>${gr ? khz(gr) : '—'}</b><span>${!f ? '&nbsp;' : f.umgerechnet ? t('fest, umgerechnet') : weg === 'geteilt' ? t('Mischrate von Windows') : t('folgt der Datei')}</span></div>
        <div><small>${t('Format am Gerät')}</small><b>${f ? h(format || '—') : '—'}</b><span>${f ? `${kanalText(f.aus_kanaele)}${f.geraet_kanaele > f.aus_kanaele ? ` ${t('von {kanaele}', { kanaele: kanalText(f.geraet_kanaele) })}` : ''}` : '&nbsp;'}</span></div>
        <div><small>${t('Latenz')}</small><b>${ms || '—'}</b><span>${f?.asio ? t('laut Treiber') : t('nur bei ASIO')}</span></div>
        <div><small>${t('Aussetzer')}</small><b class="${(pl.audio.aussetzerZahl || 0) ? 'warn' : 'gut'}">${f ? pl.audio.aussetzerZahl || 0 : '—'}</b><span>${t('seit dem Öffnen')}</span></div>
      </div></div>`;
  };

  // ----- Geräteliste: ASIO zuerst, ausgeblendete gesammelt -----
  const liste = () => {
    const box = $('[data-geraete]');
    const alle = [{ id: '', name: t('Windows-Standardgerät'), standard: false, virtuell: true }, ...geraete];
    const sichtbar = (g) => !g.aus || g.id === wahl.geraet || (g.treiber && g.treiber === String(wahl.geraet || '').split('#')[0]) || ausgeblendetZeigen;
    const gewTreiber = String(wahl.geraet || '').split('#')[0];
    const aus = alle.filter((g) => g.aus && g.id !== wahl.geraet && !(g.treiber && g.treiber === gewTreiber));
    const zahlG = new Set(geraete.map((g) => g.treiber || g.id)).size;
    const zahlAus = new Set(aus.map((g) => g.treiber || g.id)).size;
    $('[data-geraete-zahl]').textContent = tn(zahlG, '{n} Gerät', '{n} Geräte') + (zahlAus ? ` · ${t('{n} ausgeblendet', { n: zahlAus })}` : '');
    const zeileG = (g) => {
      const an = g.id === wahl.geraet;
      const asio = istAsioId(g.id);
      const marken = [asio ? '<span class="aus-marke asio">ASIO</span>' : '', asio ? `<span class="aus-marke gut">${t('bitgenau')}</span>` : '', g.standard ? `<span class="aus-marke">${t('Windows-Standard')}</span>` : '', !asio && g.kanaele > 2 ? `<span class="aus-marke">${kanalText(g.kanaele)}</span>` : ''].join('');
      const unter = g.virtuell ? t('folgt der Einstellung in Windows') : g.eigener_name ? t('erkannt als „{name}“', { name: h(g.name) }) : asio ? t('an Windows vorbei · immer exklusiv') : g.kanaele ? `${kanalText(g.kanaele)} · WASAPI` : 'WASAPI';
      const name = bearbeitet === g.id
        ? `<div class="aus-g-name"><input class="einst-feld aus-g-feld" data-name-feld value="${h(g.eigener_name || g.name)}" maxlength="80" aria-label="${h(t('Gerätename'))}" placeholder="${h(g.name)}"><span>${t('Enter speichert · leer = wieder „{name}“', { name: h(g.name) })}</span></div>`
        : `<button type="button" class="aus-g-name" data-waehlen aria-pressed="${an}"><b>${h(geraetName(g))}</b><span>${unter}</span></button>`;
      const werkzeug = merkenGeht && !g.virtuell ? `<span class="aus-g-wz">
          <button type="button" class="stift" data-umbenennen aria-label="${h(t('Umbenennen'))}" title="${h(t('Umbenennen'))}">${icon('stift', 15)}</button>
          <button type="button" class="stift" data-ausblenden aria-label="${g.aus ? t('Einblenden') : t('Ausblenden')}" title="${an ? t('Das gewählte Gerät bleibt sichtbar') : g.aus ? t('Einblenden') : t('Ausblenden')}" ${an && !g.aus ? 'disabled' : ''}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${g.aus ? AUGE : AUGE_ZU}</svg></button></span>` : '';
      return `<div class="aus-g${an ? ' an' : ''}${g.aus ? ' aus' : ''}" data-geraet-id="${h(g.id)}">
        <svg class="aus-g-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ICON_GERAET[geraetArt(g)]}</svg>
        ${name}${marken ? `<span class="aus-marken">${marken}</span>` : ''}${werkzeug}${an ? `<span class="aus-haken">${icon('haken', 13)}</span>` : ''}</div>`;
    };
    // ASIO: je Treiber eine Karte mit seinen Ausgängen (ältere Clients liefern nur den Treiber – dann eine Zeile wie bisher)
    const treiberKarte = (gs) => {
      const tk = gs[0];
      const an = gs.some((g) => g.id === wahl.geraet);
      const n = gs.length;
      const name = bearbeitet === tk.treiber
        ? `<div class="aus-g-name"><input class="einst-feld aus-g-feld" data-name-feld value="${h(tk.eigener_name || tk.name.replace(/^ASIO · /, ''))}" maxlength="80" aria-label="${h(t('Gerätename'))}" placeholder="${h(tk.name.replace(/^ASIO · /, ''))}"><span>${t('Enter speichert · leer = wieder „{name}“', { name: h(tk.name.replace(/^ASIO · /, '')) })}</span></div>`
        : `<div class="aus-g-name"><b>${h(treiberName(tk))}</b><span>${tk.eigener_name ? `${t('erkannt als „{name}“', { name: h(tk.name.replace(/^ASIO · /, '')) })} · ` : ''}${tn(n, '{n} Ausgang eingerichtet', '{n} Ausgänge eingerichtet')}</span></div>`;
      const werkzeug = merkenGeht ? `<span class="aus-g-wz">
          <button type="button" class="stift" data-umbenennen aria-label="${h(t('Umbenennen'))}" title="${h(t('Umbenennen'))}">${icon('stift', 15)}</button>
          <button type="button" class="stift" data-ausblenden aria-label="${tk.aus ? t('Einblenden') : t('Ausblenden')}" title="${an ? t('Das gewählte Gerät bleibt sichtbar') : tk.aus ? t('Einblenden') : t('Ausblenden')}" ${an && !tk.aus ? 'disabled' : ''}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${tk.aus ? AUGE : AUGE_ZU}</svg></button></span>` : '';
      const busse = gs.map((g) => {
        const gw = g.id === wahl.geraet;
        return `<div class="aus-bus${gw ? ' an' : ''}" data-geraet-id="${h(g.id)}">
          <span class="aus-bus-sym">${symbolSvg(symbolVon(g.ausgang), 24)}</span>
          <button type="button" class="aus-g-name" data-waehlen aria-pressed="${gw}"><b>${h(ausgangName(g.ausgang))}</b><span>${h(ausgangUnter(g.ausgang))}</span></button>
          ${gw ? `<span class="aus-haken">${icon('haken', 13)}</span>` : ''}</div>`;
      }).join('');
      return `<div class="aus-treiber${an ? ' an' : ''}${tk.aus ? ' aus' : ''}" data-geraet-id="${h(tk.treiber)}">
        <div class="aus-treiber-kopf">
          <svg class="aus-g-icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ICON_GERAET.interface}</svg>
          ${name}<span class="aus-marken"><span class="aus-marke asio">ASIO</span><span class="aus-marke gut">${t('bitgenau')}</span></span>${werkzeug}
          ${nativ.ausgaengeLesen ? `<button type="button" class="btn btn-zweit btn-klein aus-routing" data-routing><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>${t('Ausgänge & Lautsprecher …')}</button>` : ''}
        </div>
        <div class="aus-busse">${busse}</div></div>`;
    };
    const asioAlle = alle.filter((g) => istAsioId(g.id) && sichtbar(g));
    const gruppen = [];
    for (const g of asioAlle) {
      if (!g.treiber) { gruppen.push({ alt: g }); continue; }
      const gr = gruppen.find((x) => x.treiber === g.treiber);
      if (gr) gr.gs.push(g); else gruppen.push({ treiber: g.treiber, gs: [g] });
    }
    // alle Ausgänge eines Treibers bleiben sichtbar, wenn einer davon gewählt ist
    for (const gr of gruppen) if (gr.treiber) gr.gs = alle.filter((g) => g.treiber === gr.treiber);
    const asioHtml = gruppen.map((gr) => (gr.alt ? `<div class="aus-raster">${zeileG(gr.alt)}</div>` : treiberKarte(gr.gs))).join('');
    const winG = alle.filter((g) => !istAsioId(g.id) && sichtbar(g));
    box.innerHTML = `${gruppen.length ? `<div class="aus-gruppe asio">${t('ASIO · an Windows vorbei')}</div>${asioHtml}` : ''}
      <div class="aus-gruppe">${t('Windows (WASAPI)')}</div><div class="aus-raster">${winG.map(zeileG).join('')}</div>
      ${zahlAus ? `<button type="button" class="aus-ausgeblendet" data-ausgeblendet-zeigen><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ausgeblendetZeigen ? AUGE : AUGE_ZU}</svg>${tn(zahlAus, '{n} Gerät ausgeblendet', '{n} Geräte ausgeblendet')} · <b>${ausgeblendetZeigen ? t('wieder verbergen') : t('anzeigen')}</b></button>` : ''}`;
    box.querySelectorAll('[data-waehlen]').forEach((b) => b.addEventListener('click', () => geraetWaehlen(b.closest('[data-geraet-id]').dataset.geraetId)));
    box.querySelectorAll('[data-routing]').forEach((b) => b.addEventListener('click', () => {
      const t = b.closest('[data-geraet-id]').dataset.geraetId;
      const g = geraete.find((x) => x.treiber === t);
      ausgaengeFenster({ treiber: t, name: treiberName(g), aktiv: istAsioId(wahl.geraet) && wahl.geraet.split('#')[0] === t ? wahl.geraet.split('#')[1] : '', player: pl, nachher: () => { pl?.ausgangBassLaden?.(); neuLaden(); } });
    }));
    box.querySelector('[data-ausgeblendet-zeigen]')?.addEventListener('click', () => { ausgeblendetZeigen = !ausgeblendetZeigen; liste(); });
    box.querySelectorAll('[data-ausblenden]').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('[data-geraet-id]').dataset.geraetId;
      const gs = geraete.filter((x) => x.id === id || x.treiber === id);
      if (!gs.length) return;
      const aus = !gs[0].aus;
      for (const g of gs) g.aus = aus;
      nativ.geraetMerken({ id, aus });
      toast(aus ? t('„{name}“ ausgeblendet', { name: treiberName(gs[0]) }) : t('„{name}“ wieder eingeblendet', { name: treiberName(gs[0]) }));
      liste();
    }));
    box.querySelectorAll('[data-umbenennen]').forEach((b) => b.addEventListener('click', () => { bearbeitet = b.closest('[data-geraet-id]').dataset.geraetId; liste(); }));
    const feld = box.querySelector('[data-name-feld]');
    if (feld) {
      feld.focus(); feld.select();
      let fertig = false;
      const ende = (ok) => {
        if (fertig) return; fertig = true;
        const id = bearbeitet;
        const gs = geraete.filter((x) => x.id === id || x.treiber === id);
        const g = gs[0];
        bearbeitet = null;
        if (ok && g) {
          const neu = feld.value.trim();
          const erkannt = String(g.name || '').replace(/^ASIO · /, '');
          const name = neu === g.name || neu === erkannt ? '' : neu;
          if (name !== (g.eigener_name || '')) { for (const x of gs) x.eigener_name = name; nativ.geraetMerken({ id, name }); toast(name ? t('Gerätename gespeichert') : t('Gerätename wieder automatisch'), 'gut'); }
        }
        liste(); buehne();
      };
      feld.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ende(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ende(false); } });
      feld.addEventListener('blur', () => ende(true));
    }
  };

  // ----- Einstellungen -----
  const modus = $('[data-modus]');
  const rate = $('[data-n-rate]');
  const aufschlag = $('[data-n-aufschlag]');
  const reglerZeigen = () => {
    const asio = istAsioId(wahl.geraet);
    modus.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.w === (wahl.exklusiv || asio ? 'exklusiv' : 'geteilt'))); b.disabled = asio; });
    $('[data-modus-text]').textContent = asio ? t('ASIO geht an Windows vorbei und ist immer exklusiv.') : t('Exklusiv: bitgenau, Bluewave belegt das Gerät allein. Geteilt: andere Programme bleiben hörbar.');
    $('[data-asio-zeile]').hidden = !asio;
    rate.value = String(wahl.rate || 0);
    aufschlag.value = String(wahl.aufschlag ?? 250);
    if (!aufschlag.value) aufschlag.value = '250';
  };
  const zeitleiste = () => {
    const a = pl.audio.anlaufLetzt;
    const el = $('[data-zeitleiste]');
    if (!a) { el.innerHTML = ''; return; }
    const gesamt = Math.max(1, a.ms + a.aufschlag);
    el.innerHTML = `<span class="aus-balken" role="img" aria-label="${h(t('Zuletzt {ms} ms bis bereit, dann {pause} ms Pause', { ms: a.ms, pause: a.aufschlag }))}"><i style="width:${Math.round(a.ms / gesamt * 100)}%"></i><i style="width:${Math.round(a.aufschlag / gesamt * 100)}%"></i></span><span>${t('zuletzt <b>{ms} ms</b> bis bereit ({art}) + <b class="akzent">{pause}</b> Pause', { ms: a.ms, art: a.zeitueber ? t('kein stabiler Takt gemeldet') : t('gemessen'), pause: a.aufschlag >= 1000 ? `${zahl(a.aufschlag / 1000)} s` : `${a.aufschlag} ms` })}</span>`;
  };
  const speichern = (werte, meldung = t('Übernommen')) => {
    wahl = { ...wahl, ...werte };
    pl.nativAusgabeSetzen({ geraet: wahl.geraet, exklusiv: wahl.exklusiv, rate: wahl.rate, aufschlag: wahl.aufschlag });
    reglerZeigen(); buehne();
    if (meldung) toast(meldung);
  };
  const geraetWaehlen = async (id) => {
    if (id === wahl.geraet) return;
    wahl = { ...wahl, geraet: id };
    pl.nativAusgabeSetzen({ geraet: id, exklusiv: wahl.exklusiv, rate: wahl.rate });   // Pause: die gemerkte des Geräts
    await new Promise((r) => setTimeout(r, 150));
    try { const w = await nativ.ausgabeLesen(); wahl = { ...wahl, ...w }; pl.nativAusgabe = { ...pl.nativAusgabe, ...w }; } catch (e) { /* egal */ }
    reglerZeigen(); liste(); buehne();
    toast(t('Ausgabe: {name}', { name: geraetName(aktuell()) }));
  };
  modus.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) speichern({ exklusiv: b.dataset.w === 'exklusiv' }); }));
  rate.addEventListener('change', () => speichern({ rate: Number(rate.value) || 0 }));
  aufschlag.addEventListener('change', () => speichern({ aufschlag: Number(aufschlag.value) }));
  $('[data-n-asio]').addEventListener('click', () => nativ.senden({ c: 'asio_einstellungen' }));
  pl.audio.addEventListener('nativformat', () => { buehne(); zeitleiste(); }, { signal });
  const auffrischen = setInterval(() => { if (!inhalt.isConnected) { clearInterval(auffrischen); return; } buehne(); }, 2000);
  signal?.addEventListener('abort', () => clearInterval(auffrischen));

  const neuLaden = () => Promise.all([nativ.geraete(), nativ.ausgabeLesen()]).then(([l, w]) => {
    geraete = l || []; wahl = { ...wahl, ...(w || {}) };
    // gemerkt noch ohne Ausgang (älterer Client-Stand): gilt als erster Ausgang des Treibers
    if (istAsioId(wahl.geraet) && !wahl.geraet.includes('#')) { const b = geraete.find((g) => g.treiber === wahl.geraet); if (b) wahl.geraet = b.id; }
    pl.nativAusgabe = { ...pl.nativAusgabe, ...(w || {}) };
    pl.nativGeraete = geraete;
    // ASIO zuerst (Ausgänge eines Treibers in ihrer Reihenfolge), dann Windows-Standard, dann nach Name
    geraete.sort((a, b) => (istAsioId(b.id) - istAsioId(a.id)) || (a.treiber && a.treiber === b.treiber ? 0 : (b.standard - a.standard) || treiberName(a).localeCompare(treiberName(b), locale)));
    reglerZeigen(); liste(); buehne();
  }).catch(() => { $('[data-geraete]').innerHTML = `<p class="einst-karten-hinweis">${t('Geräteliste nicht verfügbar.')}</p>`; });
  buehne(); zeitleiste();
  neuLaden();
}
