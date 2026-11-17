// Update über GitHub: neueste „client-v…“-Release wählen, Prüfsumme aus digest oder version.json (Code aus main.js)
'use strict';
const fs = require('fs');
const path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'client', 'main.js'), 'utf8');
const stueck = (von, bis) => main.slice(main.indexOf(von), main.indexOf(bis));
const code = stueck('function versionVergleich', 'let neueVersion') + stueck('const UPDATE_REPO', '/** Neueste Client-Version beim eigenen Server');
let fehler = 0;
const pruefe = (bed, text) => { console.log(`  ${bed ? 'ok' : 'FEHLER'}: ${text}`); if (!bed) fehler++; };
const h = 'a'.repeat(64), h2 = 'b'.repeat(64);
const rel = (tag, exe, extra = {}) => ({ tag_name: tag, draft: false, prerelease: true, assets: [{ name: `Bluewave-Windows-Client-${tag.slice(8)}.exe`, size: 99, browser_download_url: `https://github.com/lfrank95/bluewave/releases/download/${tag}/x.exe`, ...exe }, { name: 'version.json', browser_download_url: `https://github.com/v/${tag}` }], ...extra });

function lauf(antwort, vj) {
  const fetch = async (url) => (url.startsWith('https://api.github.com/')
    ? { ok: true, json: async () => antwort, url }
    : { ok: true, json: async () => vj[url] });
  const f = new Function('fetch', 'UA_ZUSATZ', 'einst', 'process', 'AbortSignal', `${code}; return { vonGithub, versionVergleich, UPDATE_REPO };`);
  return f(fetch, 'test', {}, { env: {} }, { timeout: () => null });
}
(async () => {
  const liste = [
    rel('client-v0.2.0-beta.9', { digest: `sha256:${h}` }),
    rel('client-v0.2.0-beta.12', {}),
    rel('client-v0.2.0-beta.13', {}, { draft: true }),
    { tag_name: 'v1.0.0', draft: false, assets: [] },
    rel('client-v0.2.0-beta.10', { digest: `sha256:${h}` }),
  ];
  const m = lauf(liste, { 'https://github.com/v/client-v0.2.0-beta.12': { version: '0.2.0-beta.12', sha256: h2 } });
  const g = await m.vonGithub();
  pruefe(m.UPDATE_REPO === 'lfrank95/bluewave', 'Repo lfrank95/bluewave');
  pruefe(g.version === '0.2.0-beta.12' && g.quelle === 'github', `neueste (ohne Entwurf, beta.12 vor beta.10/9): ${g.version}`);
  pruefe(g.pruefsumme === h2 && g.installer.includes('/releases/download/client-v0.2.0-beta.12/'), 'Prüfsumme aus version.json, Installer-Adresse');
  const m2 = lauf([rel('client-v0.2.0-beta.9', { digest: `sha256:${h}` })], {});
  pruefe((await m2.vonGithub()).pruefsumme === h, 'Prüfsumme aus digest');
  const m3 = lauf([rel('client-v0.2.0-beta.9', {})], { 'https://github.com/v/client-v0.2.0-beta.9': { version: '0.2.0-beta.8', sha256: h } });
  let wurf = null; try { await m3.vonGithub(); } catch (e) { wurf = e.message; }
  pruefe(/Prüfsumme/.test(wurf || ''), 'ohne passende Prüfsumme: kein Update');
  pruefe(await lauf([], {}).vonGithub() === null, 'keine Releases → nichts');
  console.log(fehler ? `${fehler} Fehler` : 'Update über GitHub: alles in Ordnung.');
  process.exit(fehler ? 1 : 0);
})();
