// bluewave-nvprofil.exe – trägt NVIDIA Smooth Motion für das Wiedergabe-Programm des Clients (bluewave-mpv.exe) in die
// Treiber-Profile ein (NVAPI DRS, wie NVIDIA App bzw. Profile Inspector) und liest den Stand.
//   bluewave-nvprofil status <programm.exe>                       → JSON auf stdout (braucht keine Admin-Rechte)
//   bluewave-nvprofil setzen <programm.exe> <ergebnis.json> an apis balken log
//                                                                  → schreibt (braucht Admin-Rechte, der Client startet
//                                                                    es über die Windows-Abfrage), Ergebnis als JSON-Datei
// Einstellungs-IDs aus NVIDIA Profile Inspector (CustomSettingNames.xml): Smooth Motion - Enable 0xB0D384C0,
// Enabled APIs 0xB0CC0875 (7 = DX12+DX11+Vulkan), Debug Bars 0xB01B8B02, Debug Log Level 0xB053C379 (Logs in C:\NvPresent\).
// Funktions-IDs von nvapi_QueryInterface wie im öffentlichen NVAPI-SDK.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <wchar.h>
#ifdef _WIN32
#include <windows.h>
#endif

#define ID_SM_AN     0xB0D384C0u
#define ID_SM_APIS   0xB0CC0875u
#define ID_SM_BALKEN 0xB01B8B02u
#define ID_SM_LOG    0xB053C379u
#define PROFILNAME   L"Bluewave Wiedergabe"

typedef uint16_t US[2048];   // NvAPI_UnicodeString
typedef struct { uint32_t laenge; uint8_t daten[4096]; } Binaer;
typedef union { uint32_t u32; Binaer bin; US wsz; } Wert;
typedef struct {
  uint32_t version; US name; uint32_t id; uint32_t typ; uint32_t ort; uint32_t ist_vorgabe; uint32_t vorgabe_gueltig;
  Wert vorgabe; Wert aktuell;
} Setting;   // NVDRS_SETTING_V1
typedef struct { uint32_t version; uint32_t vordefiniert; US app; US name; US launcher; US datei_im_ordner; uint32_t bits; US kommandozeile; } Anwendung;   // NVDRS_APPLICATION_V4
typedef struct { uint32_t version; US name; uint32_t gpu; uint32_t vordefiniert; uint32_t apps; uint32_t settings; } Profil;   // NVDRS_PROFILE_V1

#define VER(t, v) ((uint32_t)sizeof(t) | ((uint32_t)(v) << 16))

typedef int (*f0)(void);
typedef int (*f_sitzung)(void **);
typedef int (*f_h)(void *);
typedef int (*f_app_suchen)(void *, US, void **, Anwendung *);
typedef int (*f_profil_suchen)(void *, US, void **);
typedef int (*f_profil_neu)(void *, Profil *, void **);
typedef int (*f_app_neu)(void *, void *, Anwendung *);
typedef int (*f_setzen)(void *, void *, Setting *);
typedef int (*f_lesen)(void *, void *, uint32_t, Setting *);

static struct {
  f0 init; f_sitzung sitzung; f_h sitzung_weg, laden, speichern; f_app_suchen app_suchen; f_profil_suchen profil_suchen;
  f_profil_neu profil_neu; f_app_neu app_neu; f_setzen setzen; f_lesen lesen;
} nv;

static void us_setzen(US z, const char *s) { memset(z, 0, sizeof(US)); for (int i = 0; s[i] && i < 2047; i++) z[i] = (uint16_t)(unsigned char)s[i]; }
static void us_w(US z, const wchar_t *s) { memset(z, 0, sizeof(US)); for (int i = 0; s[i] && i < 2047; i++) z[i] = (uint16_t)s[i]; }
static void us_text(const US z, char *aus, size_t n) { size_t i = 0; for (; i + 1 < n && z[i]; i++) aus[i] = z[i] < 128 && z[i] != '"' && z[i] != '\\' ? (char)z[i] : '?'; aus[i] = 0; }

/** NVAPI laden: 0 = ok; sonst Fehlertext in f */
static int nv_laden(char *f, size_t fn) {
#ifdef _WIN32
  HMODULE m = LoadLibraryA("nvapi64.dll");
  if (!m) { snprintf(f, fn, "kein NVIDIA-Treiber (nvapi64.dll fehlt)"); return -1; }
  typedef void *(*fq)(uint32_t);
  fq q = (fq)(void *)GetProcAddress(m, "nvapi_QueryInterface");
  if (!q) { snprintf(f, fn, "nvapi_QueryInterface fehlt"); return -1; }
  nv.init = (f0)q(0x0150E828); nv.sitzung = (f_sitzung)q(0x0694D52E); nv.sitzung_weg = (f_h)q(0xDAD9CFF8);
  nv.laden = (f_h)q(0x375DBD6B); nv.speichern = (f_h)q(0xFCBC7E14); nv.app_suchen = (f_app_suchen)q(0xEEE566B2);
  nv.profil_suchen = (f_profil_suchen)q(0x7E4A9A0B); nv.profil_neu = (f_profil_neu)q(0xCC176068); nv.app_neu = (f_app_neu)q(0x4347A9DE);
  nv.setzen = (f_setzen)q(0x577DD202); nv.lesen = (f_lesen)q(0x73BF8338);
  if (!nv.init || !nv.sitzung || !nv.laden || !nv.app_suchen || !nv.lesen || !nv.setzen) { snprintf(f, fn, "NVAPI ohne Treiber-Profile"); return -1; }
  int r = nv.init();
  if (r != 0) { snprintf(f, fn, "NVAPI startet nicht (%d)", r); return -1; }
  return 0;
#else
  snprintf(f, fn, "kein NVIDIA-Treiber (nur unter Windows)");
  return -1;
#endif
}

static int lesen_u32(void *s, void *p, uint32_t id, uint32_t *wert, int *gesetzt) {
  Setting *x = calloc(1, sizeof *x);
  if (!x) return -1;
  x->version = VER(Setting, 1);
  int r = nv.lesen(s, p, id, x);
  if (r == 0) { *wert = x->aktuell.u32; *gesetzt = x->ort == 0; }   // 0 = im Profil selbst gesetzt
  free(x);
  return r;
}
static int setzen_u32(void *s, void *p, uint32_t id, uint32_t wert) {
  Setting *x = calloc(1, sizeof *x);
  if (!x) return -1;
  x->version = VER(Setting, 1); x->id = id; x->typ = 0; x->aktuell.u32 = wert;
  int r = nv.setzen(s, p, x);
  free(x);
  return r;
}

/** Profil des Programms finden (auch ein vorhandenes fremdes) bzw. anlegen. *neu = 1, wenn angelegt */
static int profil_holen(void *s, const char *exe, int anlegen, void **p, char *profilname, size_t pn, char *f, size_t fn) {
  Anwendung *a = calloc(1, sizeof *a);
  Profil *pr = calloc(1, sizeof *pr);
  if (!a || !pr) { free(a); free(pr); snprintf(f, fn, "kein Speicher"); return -1; }
  US name; us_setzen(name, exe);
  a->version = VER(Anwendung, 4);
  int r = nv.app_suchen(s, name, p, a);
  if (r == 0) { snprintf(profilname, pn, "(Programm-Profil)"); free(a); free(pr); return 0; }
  if (!anlegen) { free(a); free(pr); snprintf(f, fn, "kein Profil für %s", exe); return 1; }
  US pname; us_w(pname, PROFILNAME);
  r = nv.profil_suchen(s, pname, p);
  if (r != 0) {
    pr->version = VER(Profil, 1); us_w(pr->name, PROFILNAME);
    r = nv.profil_neu(s, pr, p);
    if (r != 0) { free(a); free(pr); snprintf(f, fn, "Profil anlegen ging nicht (%d%s)", r, r == -137 ? ", keine Admin-Rechte" : ""); return -1; }
  }
  memset(a, 0, sizeof *a);
  a->version = VER(Anwendung, 4); us_setzen(a->app, exe); us_w(a->name, L"Bluewave (mpv)");
  r = nv.app_neu(s, *p, a);
  free(a); free(pr);
  if (r != 0) { snprintf(f, fn, "Programm eintragen ging nicht (%d%s)", r, r == -137 ? ", keine Admin-Rechte" : ""); return -1; }
  us_text(pname, profilname, pn);
  return 0;
}

static void status_json(FILE *o, const char *exe) {
  char f[200] = "", pn[200] = "";
  if (nv_laden(f, sizeof f) != 0) { fprintf(o, "{\"nvidia\":false,\"fehler\":\"%s\"}\n", f); return; }
  void *s = NULL, *p = NULL;
  if (nv.sitzung(&s) != 0 || nv.laden(s) != 0) { fprintf(o, "{\"nvidia\":true,\"fehler\":\"Treiber-Profile nicht lesbar\"}\n"); return; }
  int r = profil_holen(s, exe, 0, &p, pn, sizeof pn, f, sizeof f);
  if (r != 0) { fprintf(o, "{\"nvidia\":true,\"profil\":false,\"an\":false}\n"); nv.sitzung_weg(s); return; }
  uint32_t an = 0, apis = 7, balken = 0, log = 0; int g1 = 0, g2 = 0, g3 = 0, g4 = 0;
  int ra = lesen_u32(s, p, ID_SM_AN, &an, &g1);
  if (lesen_u32(s, p, ID_SM_APIS, &apis, &g2) != 0) apis = 7;   // nicht gesetzt = alle erlaubt
  lesen_u32(s, p, ID_SM_BALKEN, &balken, &g3);
  lesen_u32(s, p, ID_SM_LOG, &log, &g4);
  fprintf(o, "{\"nvidia\":true,\"profil\":true,\"name\":\"%s\",\"an\":%s,\"apis\":%u,\"balken\":%s,\"log\":%u%s}\n", pn, ra == 0 && an ? "true" : "false",
          apis, balken ? "true" : "false", log, ra == -160 ? ",\"fehler\":\"Treiber kennt Smooth Motion nicht (ab 571.86)\"" : "");
  nv.sitzung_weg(s);
}

static int setzen(const char *exe, const char *datei, uint32_t an, uint32_t apis, uint32_t balken, uint32_t log) {
  FILE *o = fopen(datei, "w");
  if (!o) return 2;
  char f[200] = "", pn[200] = "";
  if (nv_laden(f, sizeof f) != 0) { fprintf(o, "{\"ok\":false,\"fehler\":\"%s\"}\n", f); fclose(o); return 1; }
  void *s = NULL, *p = NULL;
  if (nv.sitzung(&s) != 0 || nv.laden(s) != 0) { fprintf(o, "{\"ok\":false,\"fehler\":\"Treiber-Profile nicht lesbar\"}\n"); fclose(o); return 1; }
  if (profil_holen(s, exe, 1, &p, pn, sizeof pn, f, sizeof f) != 0) { fprintf(o, "{\"ok\":false,\"fehler\":\"%s\"}\n", f); fclose(o); nv.sitzung_weg(s); return 1; }
  int r = setzen_u32(s, p, ID_SM_AN, an ? 1 : 0);
  if (r == 0) r = setzen_u32(s, p, ID_SM_APIS, apis & 7);
  if (r == 0) r = setzen_u32(s, p, ID_SM_BALKEN, balken ? 1 : 0);
  if (r == 0) r = setzen_u32(s, p, ID_SM_LOG, log > 3 ? 3 : log);
  if (r == 0) r = nv.speichern(s);
  if (r != 0) fprintf(o, "{\"ok\":false,\"fehler\":\"Speichern im Treiber ging nicht (%d%s)\"}\n", r, r == -137 ? ", keine Admin-Rechte" : r == -160 ? ", Treiber kennt Smooth Motion nicht" : "");
  else fprintf(o, "{\"ok\":true,\"profil\":\"%s\"}\n", pn);
  fclose(o);
  nv.sitzung_weg(s);
  return r == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc >= 3 && !strcmp(argv[1], "status")) { status_json(stdout, argv[2]); return 0; }
  if (argc >= 8 && !strcmp(argv[1], "setzen"))
    return setzen(argv[2], argv[3], (uint32_t)strtoul(argv[4], 0, 0), (uint32_t)strtoul(argv[5], 0, 0), (uint32_t)strtoul(argv[6], 0, 0), (uint32_t)strtoul(argv[7], 0, 0));
  fprintf(stderr, "bluewave-nvprofil status <programm.exe> | setzen <programm.exe> <ergebnis.json> an apis balken log\n");
  return 2;
}
