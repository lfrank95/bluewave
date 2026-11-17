// Ersatz für Amberwaves i18n.js in der übernommenen Ausgabe-Sektion: Bluewave spricht Deutsch, metrisch, EUR.
export const sprache = 'de';
export const locale = 'de-DE';
export const region = { zeitformat: '24', datumsformat: 'dmy', waehrung: 'EUR', land: 'DE', zeitzone: '', einheiten: 'metrisch' };
export function t(de, p) {
    let s = de;
    if (p) for (const k in p) s = s.split(`{${k}}`).join(String(p[k]));
    return s;
}
export const zahl = (v, nachkomma) => Number(v).toLocaleString(locale, nachkomma == null ? undefined : { minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma });
export const tn = (n, eins, viele, p) => t(n === 1 ? eins : viele, { n: zahl(n), ...p });
