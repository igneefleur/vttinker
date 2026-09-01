/* BANC D'ESSAI — node outils/verifie.js
 *
 * Une extension ne se teste pas en la rechargeant vingt fois dans un navigateur
 * et en regardant si « ça marche ». Ce fichier monte un FAUX ROLL20, construit
 * d'après ce qui a été mesuré sur une vraie partie, et y fait tourner le code
 * réel de l'extension — les deux mondes compris, et le pont qui les relie.
 *
 * Ce qu'il vérifie, dans l'ordre :
 *   1. le manifeste ne nomme aucun fichier absent, et aucun fichier n'est orphelin ;
 *   2. tous les .js passent l'analyse syntaxique ;
 *   3. le monde ISOLÉ démarre : le catalogue se lit, le module se déclare, le
 *      démarrage le lance, et la demande part vers la page ;
 *   4. le monde PRINCIPAL répond : le pont installe les bornes, prolonge le zoom
 *      aux extrémités, et rend tout à Roll20 quand on l'éteint.
 *
 * LE FAUX ROLL20 EST UN MODÈLE, PAS UNE COPIE. Il reproduit exactement ce que le
 * relevé a montré : setZoom borne à [10, 250] puis appelle setZoomSilent ;
 * stepAdjustZoom prend un BOOLÉEN de sens, arrondit aux dizaines et passe par
 * setZoom ; la molette n'appelle personne quand elle est collée à une borne ; et
 * la caméra suit orthoTop = (hauteur / 2) * (100 / zoom).
 *
 * setZoomSilent BORNE-T-IL ? On ne le sait pas : tous ses appelants bornent pour
 * lui, donc rien ne l'a jamais montré. Le banc joue donc les DEUX modèles, et
 * l'extension doit passer dans les deux. C'est la seule façon honnête de traiter
 * une inconnue qu'on ne peut pas lever.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const RACINE = path.join(__dirname, "..", "extension");
let echecs = 0, total = 0;

function ok(nom) { total++; console.log("  ok   " + nom); }
function ko(nom, detail) {
  total++; echecs++;
  console.log("  KO   " + nom);
  if (detail !== undefined) { console.log("       " + String(detail).split("\n").join("\n       ")); }
}
function verifie(nom, condition, detail) { condition ? ok(nom) : ko(nom, detail); }
function egal(nom, obtenu, attendu, note) {
  const bon = Object.is(obtenu, attendu);
  bon ? ok(nom) : ko(nom, "attendu " + JSON.stringify(attendu) + ", obtenu " + JSON.stringify(obtenu) +
    (note ? "\n" + note : ""));
}
function proche(nom, obtenu, attendu, marge) {
  const bon = typeof obtenu === "number" && Math.abs(obtenu - attendu) <= (marge || 0.01);
  bon ? ok(nom) : ko(nom, "attendu ~" + attendu + ", obtenu " + JSON.stringify(obtenu));
}
function titre(t) { console.log("\n" + t); }

/* ============================================================
 * 1. LE MANIFESTE ET LES FICHIERS
 * ============================================================ */
titre("1. Manifeste et fichiers");

const manifeste = JSON.parse(fs.readFileSync(path.join(RACINE, "manifest.json"), "utf8"));
const nommes = new Set();

function nomme(p) { nommes.add(p.replace(/\\/g, "/")); }

(manifeste.content_scripts || []).forEach(function (cs) {
  (cs.js || []).forEach(nomme);
  (cs.css || []).forEach(nomme);
});

/* ---------- LA SURFACE D'INJECTION SE SURVEILLE ----------
 *
 * C'est le coût qu'on paie même quand l'extension ne fait rien, et il est
 * invisible : quarante-cinq kilo-octets de JavaScript et dix de CSS, analysés
 * et exécutés à chaque page qui correspond, dans chaque cadre.
 *
 * Deux invariants, et ils tiennent au SOCLE, pas à une préférence : IS_EDITEUR
 * comme IS_POPOUT exigent window.top === window, donc aucun module ne peut
 * jamais démarrer dans un sous-cadre — « all_frames » n'a aucun sens ici. Et
 * rien de ce que fait l'extension n'a cours hors de l'éditeur : ni sur la liste
 * des parties, ni sur les forums, ni sur la boutique.
 *
 * Le jour où un module aura besoin d'un sous-cadre, il faudra le déclarer par
 * une portée et changer ce contrôle en connaissance de cause — c'est bien pour
 * ça qu'il est là. */
(manifeste.content_scripts || []).forEach(function (cs, i) {
  verifie("scripts de contenu " + i + " : pas dans les sous-cadres", cs.all_frames === false,
    "all_frames = " + cs.all_frames + " ; aucun module ne tourne hors du cadre supérieur");
  verifie("  et seulement sur l'éditeur",
    (cs.matches || []).every(function (m) { return /\/editor/.test(m); }),
    JSON.stringify(cs.matches));
});
(manifeste.web_accessible_resources || []).forEach(function (w, i) {
  verifie("ressource accessible " + i + " : offerte au seul éditeur",
    (w.matches || []).every(function (m) { return /\/editor/.test(m); }),
    JSON.stringify(w.matches));
});
(manifeste.web_accessible_resources || []).forEach(function (w) { (w.resources || []).forEach(nomme); });
if (manifeste.action && manifeste.action.default_popup) { nomme(manifeste.action.default_popup); }
[manifeste.icons, manifeste.action && manifeste.action.default_icon].forEach(function (i) {
  if (i && typeof i === "object") { Object.values(i).forEach(nomme); }
});

nommes.forEach(function (rel) {
  verifie("le manifeste nomme " + rel + ", et il existe", fs.existsSync(path.join(RACINE, rel)));
});

// Les pages HTML nomment leurs propres ressources : on les suit aussi, sinon un
// <script src> cassé ne se verrait qu'à l'ouverture du popup.
const html = [...nommes].filter(function (f) { return f.endsWith(".html"); });
html.forEach(function (rel) {
  const src = fs.readFileSync(path.join(RACINE, rel), "utf8");
  const dossier = path.dirname(path.join(RACINE, rel));
  const refs = [...src.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map(function (m) { return m[1]; });
  refs.forEach(function (r) {
    if (/^[a-z]+:/.test(r)) { return; }
    const cible = path.resolve(dossier, r);
    verifie(rel + " -> " + r, fs.existsSync(cible));
    nommes.add(path.relative(RACINE, cible).replace(/\\/g, "/"));
  });
});

// Aucun orphelin : un fichier qui traîne dans le paquet sans être déclaré est du
// poids mort, et parfois une vieille version qu'on croit encore chargée.
function tousLesFichiers(dir, base) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (e) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).replace(/\\/g, "/");
    return e.isDirectory() ? tousLesFichiers(p, base) : [rel];
  });
}
tousLesFichiers(RACINE, RACINE).forEach(function (rel) {
  if (rel === "manifest.json") { return; }
  if (rel.endsWith(".svg")) { return; }   // la source de l'icône, gardée exprès
  /* UN FICHIER CACHÉ N'EST PAS UN ORPHELIN : IL N'EST PAS LIVRÉ.
   *
   * « .amo-upload-uuid » est déposé là par web-ext après une signature, et il
   * rattache les envois suivants à la même fiche chez Mozilla. Il n'a donc rien
   * à faire au manifeste — et rien à faire dans le paquet non plus.
   *
   * L'EXCEPTION NE VAUT QUE PARCE QUE LA FABRICATION L'ÉCARTE POUR DE BON :
   * outils/paquet.js saute ce qui commence par un point, et RELIT le répertoire
   * central de chaque archive pour s'en assurer. Les deux contrôles ci-dessous
   * tiennent cette promesse ; sans eux, cette exception-ci serait un trou. */
  if (path.basename(rel).charAt(0) === ".") { return; }
  verifie("aucun orphelin : " + rel, nommes.has(rel), "présent dans extension/ mais nommé nulle part");
});

const fabrique = fs.readFileSync(path.join(RACINE, "..", "outils", "paquet.js"), "utf8");
verifie("la fabrication écarte les fichiers cachés",
  /if \(e\.name\.charAt\(0\) === "\."\) \{ return; \}/.test(fabrique));
verifie("  et relit le contenu de chaque archive qu'elle rend",
  /function controle\(f\)/.test(fabrique) && /paquet impur/.test(fabrique));

/* ============================================================
 * 2. SYNTAXE
 * ============================================================ */
titre("2. Syntaxe et encodage");

/* PAS DE MARQUE D'ORDRE DES OCTETS. Windows en pose une dès qu'on écrit un
 * fichier avec les outils du système (Set-Content -Encoding utf8 en PowerShell
 * 5.1, entre autres), et un manifest.json qui commence par un BOM n'est plus du
 * JSON valide : Firefox refuse l'extension entière. Ça coûte une heure la
 * première fois, et le contrôle coûte trois lignes. */
/* ET PAS DE DOUBLE ENCODAGE. Le même outil qui pose la marque d'ordre relit le
 * fichier selon la page de code Windows-1252 : un « é » (C3 A9) en ressort en
 * « Ã© », et tout le fichier avec. On l'a fait, sur deux fichiers, et rien ne
 * l'a dit — ni la syntaxe, ni les 196 contrôles. La signature est imparable :
 * un caractère de la plage C0-DF suivi d'un caractère de la plage 80-BF, que le
 * français n'écrit jamais. */
tousLesFichiers(RACINE, RACINE)
  .filter(function (f) { return /\.(js|json|css|html|svg|md)$/.test(f); })
  .forEach(function (rel) {
    const t = fs.readFileSync(path.join(RACINE, rel));
    verifie("sans marque d'ordre des octets : " + rel,
      !(t[0] === 0xEF && t[1] === 0xBB && t[2] === 0xBF));
    const s = t.toString("utf8");
    const trace = s.match(/[À-ß][-¿]|â€./);
    verifie("  et sans double encodage : " + rel, !trace,
      trace ? "trouvé « " + trace[0] + " »" : "");
  });

tousLesFichiers(RACINE, RACINE).filter(function (f) { return f.endsWith(".js"); }).forEach(function (rel) {
  try {
    execFileSync(process.execPath, ["--check", path.join(RACINE, rel)], { stdio: "pipe" });
    ok("node --check " + rel);
  } catch (e) { ko("node --check " + rel, (e.stderr || "").toString()); }
});

/* ============================================================
 *          LE FAUX ROLL20 ET LES DEUX MONDES
 * ============================================================ */

function lis(rel) { return fs.readFileSync(path.join(RACINE, rel), "utf8"); }

/* Un seul objet window vu par les deux mondes pour ce qui est OBSERVABLE des
 * deux : les événements « message ». C'est exactement la situation réelle —
 * script de contenu et script de page écoutent le même window, chacun dans son
 * compartiment, et reçoivent tous deux chaque message posté. */
/* LE BUS — ET IL DOIT RESSEMBLER À LA VRAIE PAGE, PAS À UNE COMMODITÉ.
 *
 * Il fabriquait un « origin » que le produit ne lisait jamais, et un « source »
 * qui n'était la fenêtre de personne. Tant que le filtre ne regardait que le
 * CONTENU des messages, l'écart ne se voyait pas. Le jour où le pont s'est mis
 * à contrôler d'où vient ce qu'il reçoit, le faux monde a cessé de lui
 * ressembler et deux cents contrôles sont tombés d'un coup.
 *
 * CE QUE LA VRAIE PAGE FAIT : le script de contenu et le pont sont deux mondes
 * SUR UNE SEULE fenêtre. Chacun voit « window » comme la sienne, et un message
 * posté par l'un arrive chez l'autre avec « source === window » et l'origine de
 * Roll20. C'est ce que le bus modélise maintenant.
 *
 * ET IL SAIT MENTIR, exprès : « posteDAilleurs » simule une page étrangère qui
 * garde une poignée sur l'onglet. Sans ce second geste, on ne pourrait pas
 * éprouver les gardes — on ne pourrait que constater qu'elles ne gênent pas. */
const ORIGINE_ROLL20 = "https://app.roll20.net";

function faisBus() {
  const auditeurs = [];   // { ctx, fn }
  const bus = {
    /* ON DEMANDE AU MONDE SA PROPRE FENÊTRE, ET ON NE LA DEVINE PAS.
     *
     * Mesuré dans Node : pour un contexte `ctx`, `ctx.window === ctx` est vrai
     * VU DU DEHORS, et pourtant le code qui tourne DEDANS ne reconnaît pas
     * `ctx` comme son `window` — vm rend un mandataire de contexte, et les deux
     * identités ne se rejoignent pas à travers la frontière.
     *
     * Le remède tient en une ligne : on fait déposer par le monde lui-même la
     * référence qu'il appelle `window`, et c'est celle-là que le bus repasse.
     * Vérifié : `__essai === window` rend alors vrai dedans. C'est aussi ce que
     * fait le navigateur — le script de contenu et le pont voient la MÊME
     * fenêtre, chacun à travers son propre monde. */
    ecoute(ctx, fn) {
      if (ctx && !ctx.__fenetreDuMonde) {
        try { vm.runInContext("globalThis.__fenetreDuMonde = window;", ctx); } catch (e) {}
      }
      auditeurs.push({ ctx, fn });
    },
    poste(msg) {
      auditeurs.slice().forEach(function (a) {
        const sien = (a.ctx && a.ctx.__fenetreDuMonde) || (a.ctx && a.ctx.window) || bus.fenetre;
        const ev = { data: msg, source: sien, origin: ORIGINE_ROLL20 };
        try { a.fn(ev); } catch (e) { ko("un écouteur message a levé", e.message); }
      });
    },
    /* Une page qui n'est pas la nôtre. « fenetre » est un objet à part, donc
     * jamais égal au « window » d'un monde : c'est exactement ce qui distingue
     * un message légitime d'un message forgé. */
    posteDAilleurs(msg, origine, fenetre) {
      auditeurs.slice().forEach(function (a) {
        const ev = { data: msg, source: fenetre || { postMessage() {} },
                     origin: origine || "https://exemple.invalide" };
        try { a.fn(ev); } catch (e) { ko("un écouteur message a levé", e.message); }
      });
    }
  };
  bus.fenetre = { postMessage(m) { bus.poste(m); } };
  return bus;
}

/* Le faux Roll20. `borneSilencieux` joue l'inconnue : setZoomSilent borne-t-il
 * comme ses appelants, ou laisse-t-il passer ? */
function faisRoll20(borneSilencieux, peinture) {
  const toile = {
    id: "babylonCanvas", width: 617, height: 1066, getAttribute: () => "",
    /* Une toile placée à l'ORIGINE et de mille pixels de côté : c'est le repère
     * dans lequel le banc exprime ses clics, et il n'a pas à ressembler au vrai
     * — ce qu'on éprouve, c'est que le pont RETROUVE la correspondance, pas
     * qu'il en connaisse une par cœur. */
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 })
  };

  /* LE MINIMUM DE BABYLON POUR PROJETER.
   *
   * Le pont ne calcule pas la projection lui-même : il appelle Vector3.Project,
   * seul à tenir compte du parent qui promène tout le plateau — une leçon payée
   * par une découpe entièrement blanche, la caméra étant en (0,0,0) quand les
   * tokens sont vers (700 ; -840).
   *
   * Le faux Project applique donc une transformation affine CONNUE mais NON
   * TRIVIALE : (x + 500 ; -y + 500). Le pont ne la connaît pas ; il l'établit
   * en projetant deux points. Un modèle qui rendrait l'identité laisserait
   * passer une correspondance fausse. */
  function FauxVecteur(x, y, z) { this.x = x; this.y = y; this.z = z; }
  FauxVecteur.Project = function (v) { return { x: v.x + 500, y: -v.y + 500 }; };
  function FauxMatrice() {}
  FauxMatrice.Identity = function () { return new FauxMatrice(); };

  const camera = {
    name: "vtt-main-camera", mode: 1,
    orthoTop: 533, orthoBottom: -533, orthoRight: 308.5, orthoLeft: -308.5,
    position: new FauxVecteur(0, 0, 0),
    viewport: { toGlobal: () => ({ x: 0, y: 0, width: 1000, height: 1000 }) },
    getWorldMatrix: () => new FauxMatrice(),
    getClassName: () => "FreeCamera"
  };
  const journal = [];
  const engine = {
    zoom: 100,
    // relevé : arrondit à l'entier et déplace la caméra
    setZoomSilent(z) {
      journal.push(["setZoomSilent", z]);
      if (borneSilencieux) { z = Math.max(10, Math.min(250, z)); }
      engine.zoom = Math.round(z);
      const t = engine.zoom;
      camera.orthoTop = (toile.height / 2) * (100 / t);
      camera.orthoBottom = -camera.orthoTop;
      camera.orthoRight = (toile.width / 2) * (100 / t);
      camera.orthoLeft = -camera.orthoRight;
    },
    // relevé : borne à [10, 250] puis descend vers setZoomSilent
    setZoom(z) {
      journal.push(["setZoom", z]);
      engine.setZoomSilent(Math.max(10, Math.min(250, z)));
    },
    // relevé : le booléen est le SENS, pas un delta ; pas de 10, arrondi aux dizaines
    stepAdjustZoom(monte) {
      journal.push(["stepAdjustZoom", monte]);
      const base = Math.round(engine.zoom / 10) * 10;
      engine.setZoom(monte ? base + 10 : base - 10);
    },
    $patch(o) { journal.push(["$patch", o.zoom]); Object.assign(engine, o); }
  };
  /* Le contrôle de zoom de Roll20. Le faux modèle ne reproduit PAS son bornage —
   * le vrai repousse l'état dans sa plage en moins de soixante millisecondes,
   * et personne ne peut modéliser ça honnêtement. Ce qu'on vérifie ici, c'est
   * qu'on le masque quand on le doit et qu'on le REMET comme on l'a trouvé ;
   * qu'il annule tout quand il est là, c'est le pilote qui l'a mesuré. */
  const preference = {
    zoom: { interfaceEnabled: false, interfaceType: "slider" },
    toggleZoomInterfaceEnabled() {
      preference.zoom.interfaceEnabled = !preference.zoom.interfaceEnabled;
      journal.push(["toggleZoomInterfaceEnabled", preference.zoom.interfaceEnabled]);
    }
  };
  /* LA GRILLE, reproduite d'après le relevé : un quad d'échelle 1540 × -2240
   * (22 × 70 et 32 × 70), et un ShaderMaterial dont l'uniforme gridSize porte
   * le NOMBRE DE CASES. C'est tout ce dont le module a besoin, et c'est tout ce
   * qu'on modélise — l'échelle en y est NÉGATIVE chez lui, et ce signe compte. */
  const grille = {
    name: "tabletop-square-grid",
    scaling: { x: 1540, y: -2240, z: 1 },
    material: { name: "GridMaterial", _vectors2: { gridSize: { x: 22, y: 32 } } }
  };
  /* UNE GRILLE EN LIGNES, comme celles des types hexagonaux et isométriques :
   * un treillis de segments, INCLUSIF DE SES DEUX BORDS — c'est précisément ce
   * qui fait que deux tuiles adjacentes dessinent la même ligne, et c'est le
   * défaut qu'on veut voir corrigé. Période 10, étendue 30 : trois périodes. */
  function faisLignes(nom) {
    const pos = [], idx = [];
    const seg = (x0, y0, x1, y1) => {
      const n = pos.length / 3;
      pos.push(x0, y0, 5, x1, y1, 5);
      idx.push(n, n + 1);
    };
    for (let k = 0; k <= 3; k++) {
      seg(k * 10, 0, k * 10, -30);      // verticales, bords compris
      seg(0, -k * 10, 30, -k * 10);     // horizontales, bords compris
    }
    return faisMaillageLignes(nom, pos, idx);
  }

  /* UNE GRILLE ROGNÉE, comme Roll20 les fait vraiment : des cellules dessinées
   * UNE PAR UNE — donc chaque arête intérieure tracée deux fois — et coupées net
   * au rectangle de la page. Les cellules du bord sortent en demi-arêtes.
   *
   * C'est le cas qui a résisté le plus longtemps. On croyait pouvoir répéter
   * toute la source dès lors que son étendue valait un multiple entier de la
   * période ; en fait la coupe tombe au milieu des cellules, et ces moignons se
   * retrouvaient à chaque jointure. Dix périodes de dix, page de 0 à 100. */
  function faisLignesRognees(nom) {
    const pos = [], idx = [];
    const seg = (x0, y0, x1, y1) => {
      const n = pos.length / 3;
      pos.push(x0, y0, 5, x1, y1, 5);
      idx.push(n, n + 1);
    };
    const P = { x0: 0, x1: 100, y0: -100, y1: 0 };
    const cx = (x) => Math.max(P.x0, Math.min(P.x1, x));
    const cy = (y) => Math.max(P.y0, Math.min(P.y1, y));
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const ax = cx(i * 10 - 5), bx = cx(i * 10 + 5);
        const ay = cy(-j * 10 - 5), by = cy(-j * 10 + 5);
        if (bx <= ax || by <= ay) { continue; }
        seg(ax, ay, bx, ay); seg(ax, by, bx, by);
        seg(ax, ay, ax, by); seg(bx, ay, bx, by);
      }
    }
    return faisMaillageLignes(nom, pos, idx);
  }

  /* DEUX FAMILLES DE DIAGONALES SERRÉES, comme les grilles isométriques : une
   * quarantaine de droites par direction, et un soupçon de bruit de flottant sur
   * chaque décalage — Roll20 ne pose jamais ses sommets au millième près.
   *
   * C'est ce bruit qui a compté. La période affinée s'écartait de la vraie de
   * moins d'un millième, mais le reste modulo, pris au quarantième pas,
   * retombait juste EN DESSOUS de la période au lieu de zéro : la famille
   * paraissait avoir trois motifs au lieu d'un, ses droites sortaient trois fois
   * trop serrées, et la trame dimétrique était deux fois trop dense. Un modèle à
   * quatre droites bien rondes ne pouvait pas le montrer. */
  function faisDroitesDenses(nom, ecart, nb, cote) {
    const pos = [], idx = [];
    const seg = (x0, y0, x1, y1) => {
      const n = pos.length / 3;
      pos.push(x0, y0, 5, x1, y1, 5);
      idx.push(n, n + 1);
    };
    const R = { x0: 0, x1: cote, y0: -cote, y1: 0 };
    // Bruit reproductible : une suite déterministe, pas un tirage.
    // L'amplitude compte : à quatre millièmes le défaut ne sortait pas. Roll20
    // pose ses sommets au vingtième de pixel près, et c'est cette imprécision-là
    // qui, moyennée puis multipliée par quarante, faisait dérailler le reste.
    const bruit = (k) => ((Math.sin(k * 12.9898) * 43758.5453) % 1) * 0.05;
    for (const [ux, uy] of [[Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]]) {
      const dir = uy > 0 ? 1 : 2;
      for (let k = -nb; k <= nb; k++) {
        const off = k * ecart + bruit(k * dir);
        // La droite d'équation perpendiculaire, coupée au rectangle.
        const px = -uy * off, py = ux * off;
        let t0 = -Infinity, t1 = Infinity, hors = false;
        for (let e = 0; e < 4 && !hors; e++) {
          const p = e === 0 ? -ux : e === 1 ? ux : e === 2 ? -uy : uy;
          const q = e === 0 ? px - R.x0 : e === 1 ? R.x1 - px
                  : e === 2 ? py - R.y0 : R.y1 - py;
          if (p === 0) { if (q < 0) { hors = true; } continue; }
          const t = q / p;
          if (p < 0) { if (t > t0) { t0 = t; } } else if (t < t1) { t1 = t; }
        }
        if (hors || !(t1 - t0 > 1)) { continue; }
        seg(px + t0 * ux, py + t0 * uy, px + t1 * ux, py + t1 * uy);
      }
    }
    return faisMaillageLignes(nom, pos, idx);
  }

  /* UNE VRAIE TRAME HEXAGONALE, à sommet pointu, dessinée hexagone par hexagone
   * — donc chaque arête intérieure tracée deux fois, comme le fait Roll20 — et
   * coupée net au rectangle de la page.
   *
   * C'est le seul modèle qui puisse exhiber le défaut de PARITÉ : un réseau
   * hexagonal est engendré par (w ; 0) et (w/2 ; w·√3/2), donc une translation
   * verticale de n rangées n'en est une symétrie que si n est PAIR. Les modèles
   * carrés du banc ne pouvaient pas le montrer — toute translation y est valide,
   * et le bogue a vécu tranquille pendant que « tout passait ». */
  function faisHexagones(nom, w, largeur, hauteur) {
    const pos = [], idx = [];
    const R = w / Math.sqrt(3);            // du centre au sommet
    const rang = w * Math.sqrt(3) / 2;     // écart entre deux rangées
    const P = { x0: 0, x1: largeur, y0: -hauteur, y1: 0 };
    const seg = (x0, y0, x1, y1) => {
      // Roll20 coupe au rectangle de la page : on en fait autant.
      let t0 = 0, t1 = 1, dedans = true;
      const ex = x1 - x0, ey = y1 - y0;
      for (let e = 0; e < 4 && dedans; e++) {
        const p = e === 0 ? -ex : e === 1 ? ex : e === 2 ? -ey : ey;
        const q = e === 0 ? x0 - P.x0 : e === 1 ? P.x1 - x0
                : e === 2 ? y0 - P.y0 : P.y1 - y0;
        if (p === 0) { if (q < 0) { dedans = false; } continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) { dedans = false; } else if (r > t0) { t0 = r; } }
        else { if (r < t0) { dedans = false; } else if (r < t1) { t1 = r; } }
      }
      if (!dedans || t1 - t0 < 1e-9) { return; }
      const n = pos.length / 3;
      pos.push(x0 + t0 * ex, y0 + t0 * ey, 5, x0 + t1 * ex, y0 + t1 * ey, 5);
      idx.push(n, n + 1);
    };
    const sommets = [];
    for (let k = 0; k < 6; k++) {
      const a = (90 + 60 * k) * Math.PI / 180;
      sommets.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    const lignes = Math.ceil(hauteur / rang) + 2;
    const cols = Math.ceil(largeur / w) + 2;
    for (let j = -1; j <= lignes; j++) {
      for (let i = -1; i <= cols; i++) {
        const cx = i * w + (j % 2 ? w / 2 : 0), cy = -j * rang;
        for (let k = 0; k < 6; k++) {
          const a = sommets[k], b = sommets[(k + 1) % 6];
          seg(cx + a[0], cy + a[1], cx + b[0], cy + b[1]);
        }
      }
    }
    return faisMaillageLignes(nom, pos, idx);
  }

  /* ---------- DE QUOI EXERCER LA GRILLE PEINTE ----------
   *
   * Le pont ne peint que s'il retrouve les classes de Babylon sur des objets
   * vivants : un maillage dont le constructeur porte CreatePlane, et un matériau
   * qui est un ShaderMaterial. Sans ces deux-là, il se replie sur le pavage en
   * segments — et le banc n'aurait alors JAMAIS exercé la voie normale. On les
   * lui donne donc, en modèle réduit : le faux ShaderMaterial retient les
   * uniformes qu'on lui pose, et c'est exactement ce qu'on veut vérifier. */
  function FauxShader(nom, sc, sources, options) {
    this.name = nom;
    this.sources = sources;
    this.options = options;
    this.uniformes = {};
    this.textures = {};
    const poser = (k, v) => { this.uniformes[k] = v; };
    this.setFloat = poser; this.setArray2 = poser;
    this.setArray3 = poser; this.setArray4 = poser;
    this.setTexture = (k, t) => { this.textures[k] = t; };
    this.getActiveTextures = () => Object.keys(this.textures).map((k) => this.textures[k]);
    this.isReady = () => true;
    this.getEffect = () => ({ getCompilationError: () => "" });
    this.dispose = () => { this._jete = true; };
  }
  /* Le pont retrouve la classe ShaderMaterial en INTERROGEANT les matériaux
   * vivants — getClassName() — parce que la page n'expose pas le global de
   * Babylon. Sans cette méthode, il ne trouverait rien et les marqueurs
   * retomberaient silencieusement dans la branche « classes introuvables ». */
  FauxShader.prototype.getClassName = function () { return "ShaderMaterial"; };

  /* La texture se reconnaît de la même façon : le pont cherche, parmi les
   * textures de la scène, un objet qui porte updateURL. */
  function FauxTexture(url, sc, sansMip, inverseY) {
    this.url = url; this.name = url;
    this.sansMip = sansMip; this.inverseY = inverseY;
    this.hasAlpha = false;
    this.isReady = () => true;
    this.getSize = () => ({ width: 64, height: 64 });
    this.dispose = () => { this._jete = true; };
  }
  FauxTexture.prototype.updateURL = function (u) { this.url = u; };

  function FauxMaillage() {}
  FauxMaillage.CreatePlane = function (nom, taille, sc) {
    const p = {
      name: nom, position: { x: 0, y: 0, z: 0 }, scaling: { x: 1, y: 1 },
      isVisible: true, _sommets: 4,
      /* Ce que le pont pose sur ses quads de marqueurs, relevé un par un sur ceux
       * de Roll20. Les valeurs de départ sont celles de Babylon, pour qu'un
       * contrôle qui les vérifie mesure bien un choix du pont et non le hasard
       * d'un modèle complaisant. */
      parent: null, material: null,
      renderingGroupId: 0, alphaIndex: 0,
      isPickable: true, alwaysSelectAsActiveMesh: false,
      getTotalVertices() { return p._sommets; },
      computeWorldMatrix() {}, freezeWorldMatrix() { p._gele = true; },
      isDisposed() { return !!p._jete; },
      dispose() {
        p._jete = true;
        const i = sc.meshes.indexOf(p);
        if (i >= 0) { sc.meshes.splice(i, 1); }
      }
    };
    p.constructor = FauxMaillage;
    sc.meshes.push(p);
    return p;
  };

  /* LES MAILLAGES DU BANC ONT UNE POSITION, ET CE N'EST PAS UN DÉTAIL.
   *
   * Ils étaient tous à l'origine, et c'est ce qui a laissé passer le défaut de
   * repère le plus visible du module : un maillage Babylon porte des sommets en
   * coordonnées LOCALES et une position qui les emmène dans le monde. Celui de
   * la grille hexagonale de Roll20 est à (35 ; -40,41). Notre shader recevait la
   * position MONDE du fragment et la comparait à une trame mesurée en local :
   * 35 px d'écart, soit une demi-largeur d'hexagone, sur les quatre types
   * peints. Avec des modèles à l'origine, les deux repères se confondent et le
   * banc ne peut RIEN voir. */
  const POSE_MODELE = { x: 35, y: -40.41451884327381, z: 5 };

  function faisMaillageLignes(nom, pos, idx) {
    const m = {
      name: nom,
      position: { x: POSE_MODELE.x, y: POSE_MODELE.y, z: POSE_MODELE.z },
      isVisible: true,
      color: { r: 1, g: 1, b: 1 }, alpha: 0.3,
      _pos: pos.slice(), _idx: idx.slice(), _mort: false,
      getVerticesData(k) { return k === "position" ? m._pos : null; },
      getIndices() { return m._idx; },
      makeGeometryUnique() { m._propre = true; },
      setVerticesData(k, v) { if (k === "position") { m._pos = v; } },
      setIndices(v) { m._idx = v; },
      computeWorldMatrix() {}, refreshBoundingInfo() {},
      isDisposed() { return m._mort; },
      dispose() {
        m._mort = true;
        const i = scene.meshes.indexOf(m);
        if (i >= 0) { scene.meshes.splice(i, 1); }
      },
      clone(n) {
        const c = faisMaillageLignes(n, m._pos, m._idx);
        c.position.x = m.position.x; c.position.y = m.position.y;
        scene.meshes.push(c);
        return c;
      }
    };
    /* PEINTURE DISPONIBLE OU NON, ET C'EST UN INTERRUPTEUR EXPRÈS. Avec, on
     * vérifie la voie normale ; sans, on vérifie le REPLI en segments, qui doit
     * continuer de marcher pour une machine où le shader ne compilerait pas. Un
     * banc qui n'exerce qu'un des deux chemins laisse l'autre pourrir. */
    if (peinture) {
      m.constructor = FauxMaillage;
      m.material = new FauxShader("colorShader");
    }
    return m;
  }

  /* ---------- DE QUOI EXERCER LES MARQUEURS ----------
   *
   * Le pont ne dessine un marqueur que s'il trouve TROIS choses sur des objets
   * vivants : une classe de maillage (par CreatePlane), une classe de matériau
   * (par getClassName), et une classe de texture (par updateURL). Il faut donc
   * qu'au moins une de chaque traîne dans la scène, comme chez Roll20 — où
   * l'atlas « instance-0 » et le matériau des pictogrammes sont toujours là.
   *
   * Et le NŒUD PAR TOKEN, qui est la clef de voûte du module : Roll20 tient un
   * « <id>-markers » posé sur le coin haut-droit de chaque token, et il SURVIT
   * aux reconstructions. C'est à lui que nos quads s'accrochent, et c'est
   * pourquoi ils suivent le token sans un écouteur. Le banc doit donc en avoir,
   * sinon il n'éprouverait que la branche « pas de nœud, on réessaiera ». */
  const atlas = new FauxTexture("instance-0", null, false, false);
  const materiauR20 = new FauxShader("shader");

  /* Un maillage de token, toujours présent, TOUJOURS porteur de la classe.
   *
   * Sans lui, la classe Mesh ne serait trouvable que sur le maillage de grille,
   * et seulement quand le banc tourne en mode « peinture » : les marqueurs
   * n'auraient été éprouvés que dans la moitié des montages, et jamais dans
   * l'autre. Chez Roll20, un token est un maillage et il y en a toujours. */
  const maillageToken = {
    name: "instance-0-objects - 0_group_0",
    position: { x: 0, y: 0, z: 9999000 }, isVisible: true,
    constructor: FauxMaillage,
    getTotalVertices: () => 4,
    computeWorldMatrix() {}, dispose() {}
  };

  function faisNoeudMarqueurs(id, x, y) {
    return {
      name: id + "-markers",
      position: { x: x, y: y, z: 9999000 },
      _enfants: [],
      getChildren() { return this._enfants; }
    };
  }

  /* L'OBSERVABLE DE RENDU, PARCE QU'UN MODULE S'Y ACCROCHE.
   *
   * Le module des jetons hors carte corrige son attribut AVANT CHAQUE IMAGE —
   * c'est la seule façon de garantir qu'aucune image n'est dessinée avec la
   * valeur de Roll20, et un guet à intervalle avait produit un clignotement bien
   * visible. Un faux monde sans observable l'aurait poussé sur son repli, et le
   * banc aurait éprouvé le chemin qui n'est pas livré.
   *
   * `image()` joue une image : c'est par elle que le banc vérifie que la
   * correction repasse, et qu'elle ne repasse plus une fois le module éteint. */
  const observateurs = [];
  const onBeforeRenderObservable = {
    add(fn) { observateurs.push(fn); return fn; },
    remove(fn) {
      const i = observateurs.indexOf(fn);
      if (i >= 0) { observateurs.splice(i, 1); }
      return i >= 0;
    }
  };

  const scene = {
    onBeforeRenderObservable,
    image() { observateurs.slice().forEach(function (f) { f(); }); },
    observateurs,
    meshes: [grille, maillageToken], cameras: [camera],
    materials: [materiauR20], textures: [atlas], transformNodes: [],
    getTransformNodeByName(n) {
      return scene.transformNodes.filter((k) => k.name === n)[0] || null;
    },
    getEngine: () => ({
      getRenderWidth: () => 1000, getRenderHeight: () => 1000,
      getRenderingCanvas: () => toile
    }),
    getTransformMatrix: () => new FauxMatrice()
  };
  scene.faisNoeudMarqueurs = faisNoeudMarqueurs;
  scene.faisLignes = faisLignes;
  scene.faisLignesRognees = faisLignesRognees;
  scene.faisHexagones = faisHexagones;
  scene.faisDroitesDenses = faisDroitesDenses;

  const magasins = new Map([["engine", engine], ["preference", preference]]);
  const racineVue = {
    id: "vm_zoom_buttons",
    __vue_app__: { config: { globalProperties: { $pinia: { _s: magasins } } } }
  };
  return { toile, camera, engine, preference, racineVue, journal, grille, scene };
}

/* UN FAUX DOM QUI SUFFIT VRAIMENT.
 *
 * Le premier était trop pauvre : createElement rendait un objet sans className
 * ni addEventListener, et le code qui dessine la commande de zoom échouait dans
 * un try/catch sans que rien ne le dise. Un banc d'essai qui passe parce que le
 * code testé n'a pas pu s'exécuter est pire que pas de banc du tout.
 *
 * Il porte donc de quoi construire, attacher, détacher, retrouver et cliquer —
 * et rien de plus. */
function faisDom(opts) {
  opts = opts || {};
  const tous = [];
  function noeud(tag) {
    const n = {
      tag, className: "", id: "", hidden: false, value: "", _txt: "",
      children: [], parentNode: null, dataset: {}, attrs: {}, ecouteurs: {},
      // style porte setProperty : c'est par là que le module repose les
      // couleurs prises à Roll20, et un objet nu ne l'a pas.
      style: {
        setProperty(k, v) { this[k] = v; },
        getPropertyValue(k) { return this[k] || ""; },
        removeProperty(k) { delete this[k]; }
      },
      get isConnected() { let p = n; while (p.parentNode) { p = p.parentNode; } return p._racine === true; },
      /* classList ET className SONT LA MÊME CHOSE, comme dans un vrai DOM.
       *
       * Le premier jet tenait les classes dans un objet à part : classList.add
       * marchait, contains aussi, mais className n'en savait rien — et le
       * sélecteur, qui lit className, ne trouvait jamais rien. Le module des
       * marqueurs greffe son bouton par `classList.add('vttk-outil')` : le banc a
       * fait échouer cinq contrôles sur un code parfaitement juste. Un faux DOM
       * incohérent avec lui-même est pire qu'un faux DOM pauvre. */
      classList: {
        _liste() { return String(n.className || "").split(/\s+/).filter(Boolean); },
        _pose(l) { n.className = l.join(" "); },
        add(c) { const l = this._liste(); if (l.indexOf(c) < 0) { l.push(c); this._pose(l); } },
        remove(c) { this._pose(this._liste().filter((x) => x !== c)); },
        toggle(c, on) {
          const veut = (on === undefined) ? !this.contains(c) : !!on;
          if (veut) { this.add(c); } else { this.remove(c); }
        },
        contains(c) { return this._liste().indexOf(c) >= 0; }
      },
      appendChild(e) {
        if (e.parentNode) { e.parentNode.removeChild(e); }
        n.children.push(e); e.parentNode = n; return e;
      },
      insertBefore(e, ref) {
        if (e.parentNode) { e.parentNode.removeChild(e); }
        var i = n.children.indexOf(ref);
        if (i < 0) { n.children.push(e); } else { n.children.splice(i, 0, e); }
        e.parentNode = n; return e;
      },
      get firstChild() { return n.children.length ? n.children[0] : null; },
      get lastElementChild() { return n.children.length ? n.children[n.children.length - 1] : null; },
      removeChild(e) {
        const i = n.children.indexOf(e);
        if (i >= 0) { n.children.splice(i, 1); e.parentNode = null; }
        return e;
      },
      remove() { if (n.parentNode) { n.parentNode.removeChild(n); } },
      /* « class » et « id » NE SONT PAS DES ATTRIBUTS COMME LES AUTRES : un vrai
       * DOM les tient d'accord avec className et id, et le sélecteur lit ces
       * derniers. Sans ça, un nœud créé par createElementNS — le seul chemin qui
       * passe par setAttribute('class', …), faute de className sur un SVG —
       * restait introuvable, et le banc déclarait manquante une croix bel et
       * bien dessinée. */
      setAttribute(k, v) {
        n.attrs[k] = String(v);
        if (k === "class") { n.className = String(v); }
        if (k === "id") { n.id = String(v); }
      },
      getAttribute(k) {
        if (k === "class") { return n.className || null; }
        if (k === "id") { return n.id || null; }
        return n.attrs[k];
      },
      removeAttribute(k) {
        delete n.attrs[k];
        if (k === "class") { n.className = ""; }
        if (k === "id") { n.id = ""; }
      },
      /* UNE BOÎTE, parce que le code testé en LIT une. Le module des marqueurs
       * cherche, parmi les boutons de la colonne de Roll20, un modèle qui ait
       * une hauteur : le dernier est celui du débordement, masqué, et le cloner
       * donnait un bouton invisible. Sans boîte ici, le banc ne pourrait pas
       * distinguer les deux. */
      getBoundingClientRect() {
        const b = n._boite || { left: 0, top: 0, width: 0, height: 0 };
        return { left: b.left, top: b.top, width: b.width, height: b.height,
                 right: b.left + b.width, bottom: b.top + b.height };
      },
      /* Un sélecteur minuscule : nom de balise ou classe unique, listes
       * séparées par des virgules. C'est tout ce que le code testé emploie —
       * en faire plus serait réécrire un navigateur pour rien, en faire moins
       * empêcherait d'éprouver le clonage. */
      /* Nom de balise, classe unique, ou IDENTIFIANT — et l'identifiant a
       * manqué : le pont cherche `#master-toolbar` pour y lire les couleurs de
       * Roll20, et le sélecteur le prenait pour un nom de balise. Il retombait
       * alors sur des couleurs de repli, et le banc validait un panneau qui
       * n'avait rien lu du tout. */
      querySelectorAll(sel) {
        const veut = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
        const va = (e) => veut.some((s) => s[0] === "."
          ? (e.className || "").split(" ").indexOf(s.slice(1)) >= 0
          : s[0] === "#" ? e.id === s.slice(1)
          : e.tag === s);
        const out = [];
        (function creuse(e) { e.children.forEach((f) => { if (va(f)) { out.push(f); } creuse(f); }); })(n);
        return out;
      },
      querySelector(sel) { return n.querySelectorAll(sel)[0] || null; },
      cloneNode(profond) {
        const c = noeud(n.tag);
        c.className = n.className; c.id = ""; c.value = n.value;
        // La boîte fait partie de ce qu'est le nœud : un clone la garde.
        if (n._boite) { c._boite = Object.assign({}, n._boite); }
        c.textContent = n.children.length ? "" : n.textContent;
        Object.keys(n.attrs).forEach((k) => { c.attrs[k] = n.attrs[k]; });
        Object.keys(n.style).forEach((k) => { c.style[k] = n.style[k]; });
        if (profond) { n.children.forEach((e) => c.appendChild(e.cloneNode(true))); }
        return c;
      },
      addEventListener(t, f) { (n.ecouteurs[t] = n.ecouteurs[t] || []).push(f); },
      declenche(t, ev) { (n.ecouteurs[t] || []).forEach((f) => f(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev))); },
      clique() { n.declenche("click"); },
      /* SAISIR, C'EST TAPER PUIS COMMETTRE. Un vrai navigateur émet « input » à
       * chaque frappe et « change » quand la valeur est validée — sortie du
       * champ, Entrée, ou fin de manipulation. Le faux DOM n'émettait que le
       * premier, si bien qu'un code écoutant « change » — c'est-à-dire un code
       * qui n'écrit qu'une fois par saisie, ce qu'on veut — paraissait ne rien
       * écrire du tout. */
      saisis(v) { n.value = v; n.declenche("input"); n.declenche("change"); },
      set onload(f) { n._onload = f; }
    };
    /* textContent agrège ses enfants, comme dans un vrai DOM : le code testé
     * reconnaît la case de valeur de Roll20 à ce que son texte soit un nombre,
     * et ce texte est dans un span. Une propriété simple aurait rendu vide. */
    Object.defineProperty(n, "textContent", {
      get() {
        if (!n.children.length) { return n._txt; }
        return n.children.map((e) => e.textContent).join("");
      },
      set(v) { n._txt = String(v == null ? "" : v); n.children.slice().forEach((e) => n.removeChild(e)); }
    });
    tous.push(n);
    return n;
  }
  const racine = noeud("html"); racine._racine = true;
  const body = noeud("body"); racine.appendChild(body);
  const head = noeud("head"); racine.appendChild(head);
  /* Les identifiants que la page attend, créés d'avance. La liste est EXPLICITE
   * et non « on crée ce qu'on demande » : le module de zoom cherche
   * #vm_zoom_buttons pour s'y poser, et doit trouver null quand Roll20 ne l'a
   * pas — c'est le cas « la commande flotte », qu'un DOM trop serviable
   * empêcherait de tester. */
  (opts.ids || []).forEach((id) => { const n = noeud("div"); n.id = id; body.appendChild(n); });

  /* LA COMMANDE DE ZOOM DE ROLL20, reproduite d'après le relevé : sa colonne,
   * ses boutons à icône de police (le glyphe EST le mot « plus »), sa case de
   * valeur, et les trois pièces colorées de son glisseur. C'est ce que le
   * module vient cloner ; sans ça, on n'éprouverait que le repli. */
  if (opts.roll20Zoom) {
    const z = noeud("div"); z.id = "vm_zoom_buttons"; body.appendChild(z);
    const pc = noeud("div"); pc.className = "parentContainer"; z.appendChild(pc);
    const oeil = noeud("button"); oeil.className = "el-button"; oeil.appendChild(noeud("svg")); pc.appendChild(oeil);
    const inner = noeud("div"); inner.className = "zoomButtonsInner"; pc.appendChild(inner);
    ["plus", "minus"].forEach((nom) => {
      const b = noeud("button"); b.className = "el-button";
      b.attrs["data-v-2f0bc668"] = "";
      const i = noeud("i"); i.className = "el-icon";
      const s = noeud("span"); s.className = "grimoire__roll20-icon"; s.textContent = nom;
      i.appendChild(s); b.appendChild(i); inner.appendChild(b);
    });
    const val = noeud("button"); val.className = "el-button";
    const vs = noeud("span"); vs.textContent = "100"; val.appendChild(vs); inner.appendChild(val);
    const piste = noeud("div"); piste.className = "el-slider__runway";
    piste.style.backgroundColor = "rgb(237, 245, 250)"; inner.appendChild(piste);
    const barre = noeud("div"); barre.className = "el-slider__bar";
    barre.style.backgroundColor = "rgb(180, 0, 106)"; piste.appendChild(barre);
    const curs = noeud("div"); curs.className = "el-slider__button";
    curs.style.backgroundColor = "rgb(255, 255, 255)";
    curs.style.borderColor = "rgb(225, 0, 133)"; piste.appendChild(curs);
    const mire = noeud("button"); mire.className = "el-button";
    const ms = noeud("span"); ms.className = "grimoire__roll20-icon"; ms.textContent = "target";
    mire.appendChild(ms); pc.appendChild(mire);
  }

  const doc = {
    _tous: tous,
    documentElement: racine, body, head,
    createElement: noeud,
    /* Le bouton des marqueurs porte un sourire DESSINÉ : sa police d'icônes n'a ni
     * « smiley », ni « emoji », ni « sticker ». Le banc doit donc savoir créer
     * un nœud d'espace SVG, sans quoi la fabrique levait et le bouton
     * disparaissait en silence. */
    createElementNS: (ns, tag) => noeud(tag),
    getElementById(id) { return tous.find((n) => n.id === id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(t, f) { (doc._e = doc._e || {})[t] = f; },
    _pret() { return doc._e && doc._e.DOMContentLoaded && doc._e.DOMContentLoaded(); },
    _parClasse(c) { return tous.filter((n) => (n.className || "").split(" ").indexOf(c) >= 0); }
  };
  // hasAttribute / setAttribute sur <html> : le marqueur d'injection du pont.
  racine.hasAttribute = (k) => k in racine.attrs;
  return doc;
}

/* LA CAMPAGNE DE ROLL20, réduite à ce que le pont lui demande vraiment.
 *
 * C'est une collection Backbone : des modèles avec `attributes`, un `save()`
 * qui fusionne et prévient, et un `on`/`off` par nom d'événement. Le pont ne
 * s'abonne qu'à « change:statusmarkers », « add » et « remove » — pas à la
 * position, et c'est tout l'intérêt du module : un token qu'on traîne ne le
 * réveille pas, son nœud parent suffit.
 *
 * `token_markers` porte le catalogue de Roll20. Il sert à COMPTER ses
 * pictogrammes à lui, pour que les nôtres se rangent à la suite : une étiquette
 * inconnue de son catalogue et absent du nôtre ne compte ni d'un côté ni de
 * l'autre, ce qui est exactement le comportement voulu.
 *
 * Chaque token reçoit son nœud « -markers », posé sur son coin haut-droit comme
 * Roll20 le fait — mesuré : x = left + width/2, y = -(top - height/2). */
function faisCampagne(scene, tokens) {
  const ecouteurs = {};
  const modeles = (tokens || []).map(function (t) {
    const m = {
      id: t.id,
      attributes: Object.assign({ layer: "objects", width: 70, height: 70 }, t),
      /* BACKBONE PRÉVIENT POUR CHAQUE ATTRIBUT CHANGÉ, pas seulement pour celui
       * qui nous intéressait le jour où ce modèle a été écrit. Le premier jet
       * n'émettait que « change:statusmarkers » — et le banc était donc INCAPABLE
       * de voir qu'on n'écoutait pas la largeur du token, alors que c'est elle
       * qui décide de la capacité d'une ligne. Un faux modèle plus pauvre que le
       * vrai ne prouve rien sur les cas qu'il ne sait pas produire. */
      save(o) {
        const changes = [];
        Object.keys(o).forEach((k) => {
          if (m.attributes[k] !== o[k]) { changes.push(k); }
          m.attributes[k] = o[k];
        });
        changes.forEach((k) => {
          (ecouteurs["change:" + k] || []).forEach((f) => f(m));
        });
      }
    };
    return m;
  });
  modeles.forEach(function (m) {
    const a = m.attributes;
    scene.transformNodes.push(
      scene.faisNoeudMarqueurs(m.id, a.left + a.width / 2, -(a.top - a.height / 2)));
  });
  const col = {
    models: modeles,
    get(id) { return modeles.filter((m) => m.id === id)[0] || null; },
    on(nom, fn) { (ecouteurs[nom] = ecouteurs[nom] || []).push(fn); },
    off(nom, fn) {
      if (!ecouteurs[nom]) { return; }
      if (!fn) { ecouteurs[nom] = []; return; }
      const i = ecouteurs[nom].indexOf(fn);
      if (i >= 0) { ecouteurs[nom].splice(i, 1); }
    },
    _ecouteurs: ecouteurs,
    /* Combien d'abonnements en vol : un module qu'on éteint puis rallume ne
     * doit pas en laisser derrière lui, sinon chaque rechargement de page
     * empile un écouteur de plus sur la collection de Roll20. */
    _combien() { return Object.keys(ecouteurs).reduce((n, k) => n + ecouteurs[k].length, 0); }
  };
  /* LES DOCUMENTS DE LA CAMPAGNE, reproduits d'après le relevé — et le relevé
   * a démenti deux suppositions raisonnables :
   *
   *   - `create()` rend le modèle TOUT DE SUITE ; son rappel « success »
   *     n'arrive jamais. Douze secondes d'attente au premier essai, pour un
   *     document pourtant bien créé.
   *   - `notes` est un attribut ORDINAIRE, lu de façon synchrone. Ce n'est plus
   *     la lecture différée de l'ancien Roll20, et `get(champ, rappel)` ne
   *     rappelle jamais.
   *
   * Un modèle qui aurait imité l'ancien comportement aurait fait écrire un
   * module asynchrone pour rien — et faux. */
  const hEcouteurs = {};
  const docs = [];
  let idDoc = 0;
  const handouts = {
    models: docs,
    get length() { return docs.length; },
    create(attrs) {
      idDoc++;
      const m = {
        id: "H" + idDoc,
        attributes: Object.assign({ name: "", notes: "", inplayerjournals: "", archived: false }, attrs),
        get(k) { return m.attributes[k]; },
        save(o) {
          Object.keys(o).forEach((k) => { m.attributes[k] = o[k]; });
          if ("notes" in o) { (hEcouteurs["change:notes"] || []).forEach((f) => f(m)); }
        },
        destroy() { const i = docs.indexOf(m); if (i >= 0) { docs.splice(i, 1); } }
      };
      docs.push(m);
      (hEcouteurs.add || []).forEach((f) => f(m));
      return m;
    },
    on(nom, fn) { (hEcouteurs[nom] = hEcouteurs[nom] || []).push(fn); },
    off(nom, fn) {
      if (!hEcouteurs[nom]) { return; }
      if (!fn) { hEcouteurs[nom] = []; return; }
      const i = hEcouteurs[nom].indexOf(fn);
      if (i >= 0) { hEcouteurs[nom].splice(i, 1); }
    },
    _combien() { return Object.keys(hEcouteurs).reduce((n, k) => n + hEcouteurs[k].length, 0); }
  };

  return {
    attributes: {
      token_markers: JSON.stringify([
        { id: 1, tag: "skull", name: "skull", url: "https://r20/skull.png" },
        { id: 2, tag: "sleepy", name: "sleepy", url: "https://r20/sleepy.png" },
        { id: 3, tag: "half-heart", name: "half-heart", url: "https://r20/hh.png" }
      ])
    },
    handouts: handouts,
    activePage() { return { thegraphics: col }; },
    _col: col
  };
}

function faisDocument(r20, opts) {
  const doc = faisDom();

  /* SA COLONNE D'OUTILS, reproduite d'après le relevé. Le module des marqueurs ne
   * pose plus de cadre flottant : il CLONE un de ses boutons et entre dans sa
   * colonne, comme le fait la commande de zoom. Sans cette colonne ici, le banc
   * n'éprouverait que le repli — c'est-à-dire justement pas ce qui est neuf.
   *
   * Le DERNIER bouton est SANS BOÎTE, et c'est délibéré : chez Roll20 c'est
   * celui du débordement, masqué. Le premier jet le clonait et notre bouton
   * sortait de taille nulle, invisible à l'écran mais présent dans les relevés.
   * Un modèle où tous les boutons auraient une boîte ne pourrait pas le voir. */
  if (!opts || opts.toolbar !== false) {
    /* SA BARRE, AVEC SES COULEURS RENDUES. C'est d'elles que le pont déduit le
     * thème : on ne peut pas le lui demander — son bascule `colorTheme` ne
     * change ni ses variables CSS ni le fond de sa barre, mesuré. Le modèle
     * porte donc les DEUX jeux, pour qu'on éprouve le clair ET le sombre. */
    const barre = doc.createElement("div");
    barre.id = "master-toolbar";
    barre._fond = (opts && opts.sombre) ? "rgb(23, 23, 23)" : "rgb(255, 255, 255)";
    barre._texte = (opts && opts.sombre) ? "rgb(230, 230, 230)" : "rgb(51, 51, 51)";
    /* SA BOÎTE, MESURÉE : 44 px de large, toute la hauteur de la fenêtre. C'est
     * elle qui dit où le panneau se colle et jusqu'où il descend. */
    barre._boite = { left: 0, top: 0, width: 44, height: 1066 };
    doc.body.appendChild(barre);
    const col = doc.createElement("div");
    col.className = "upper-buttons";
    barre.appendChild(col);

    /* SES INTITULÉS DE SECTION, et il y en a DEUX SORTES : un séparateur nu, et
     * un séparateur qui porte un mot. Le module doit cloner le second — cloner
     * le premier donnerait un filet sans titre. Un modèle qui n'aurait que la
     * forme titrée ne pourrait pas montrer cette erreur-là. */
    function sep(mot) {
      const s = doc.createElement("div");
      s.className = "spacer-outer";
      s.setAttribute("role", "separator");
      s.attrs.id = "tools-spacer";
      s._boite = { left: 1, top: 0, width: 28, height: mot ? 15 : 1 };
      s._fond = "rgba(0, 0, 0, 0.2)";   // son filet, mesuré
      const filet = doc.createElement("div");
      filet.className = "spacer-inner";
      filet._fond = "rgba(0, 0, 0, 0.2)";
      s.appendChild(filet);
      if (mot) {
        const h = doc.createElement("div");
        h.className = "spacer-header";
        h.textContent = mot;
        s.appendChild(h);
      }
      col.appendChild(s);
    }
    /* UNE CAMPAGNE D'HÉRITAGE N'A AUCUNE SECTION TITRÉE, et c'est ce qui faisait
       disparaître l'extension entière : on clonait une section À INTITULÉ pour
       poser la nôtre, et faute d'en trouver une on renonçait. Relevé sur une
       vraie campagne d'héritage : deux « .spacer-outer », zéro
       « .spacer-header ». Le faux monde doit savoir reproduire ça, sinon le
       repli n'est jamais éprouvé. */
    sep(null);        // le séparateur nu, sans en-tête
    if (!opts || !opts.heritage) {
      sep("Outils");
      sep("Effets");
    } else {
      sep(null);
    }

    [["cursor", 34], ["measure", 34], ["wandSparkle", 34], ["moreVertical", 0]]
      .forEach(function (paire, i) {
        const ext = doc.createElement("div");
        ext.className = "toolbar-button-outer";
        ext.attrs["data-v-0dd4681e"] = "";
        ext._boite = { left: 1, top: 18 + i * 36, width: paire[1] ? 42 : 0, height: paire[1] };
        /* AVEC OU SANS « button », ET LA VRAIE BARRE N'EN A PAS.
         *
         * Relevé sur une vraie partie : ses trois premiers outils rendent
         * `querySelectorAll("button").length === 0`, et leur premier enfant est
         * un DIV. Le faux monde, lui, en posait un — donc il était PLUS RICHE
         * que la réalité, et le pont s'en tirait dans le banc en ne câblant son
         * écouteur que sur ce bouton. Sur la vraie page, ses deux outils étaient
         * inertes : posés, dessinés, intitulés, et sans écouteur.
         *
         * Un faux monde plus riche que le vrai ne prouve rien. On sait donc
         * monter les deux formes, et « sansBouton » est celle qui ressemble. */
        const b = doc.createElement(opts && opts.sansBouton ? "div" : "button");
        b.className = "toolbar-button-inner";
        const fente = doc.createElement("div");
        fente.className = "icon-slot";
        const glyphe = doc.createElement("span");
        glyphe.className = "grimoire__roll20-icon";
        glyphe.textContent = paire[0];
        fente.appendChild(glyphe);
        b.appendChild(fente);
        ext.appendChild(b);
        col.appendChild(ext);
      });
  }
  doc.getElementById = function (id) {
    if (id === "babylonCanvas") { return r20.toile; }
    if (id === "vm_zoom_buttons") { return r20.racineVue; }
    return doc._tous.find((n) => n.id === id) || null;
  };
  /* ON COMPTE LES BALAYAGES DU DOCUMENT. « [data-v-app] » est un sélecteur
   * d'ATTRIBUT : aucun index du navigateur ne l'accélère, c'est un parcours
   * complet de l'arbre de Roll20. Le pont l'appelait à chaque accès au magasin,
   * y compris depuis l'écouteur de molette — non passif, en capture, sur window,
   * donc sur le chemin de TOUT défilement de la page. Ce compteur est là pour
   * que ça ne puisse plus revenir sans qu'on le voie. */
  doc._balayages = 0;
  const corps = doc.body;
  doc.querySelectorAll = function (sel) {
    if (String(sel).indexOf("data-v-app") >= 0) { doc._balayages++; return [r20.racineVue]; }
    /* Tout le reste est cherché dans le corps, comme dans un vrai document :
     * le module des marqueurs y va chercher la colonne d'outils de Roll20. */
    return corps.querySelectorAll(sel);
  };
  doc.querySelector = function (sel) { return doc.querySelectorAll(sel)[0] || null; };
  doc.removeEventListener = function () {};
  /* LE SCRIPT COURANT. Le pont y lit sa PROPRE adresse — il a été injecté depuis
   * moz-extension://<identifiant>/page/pont.js — pour pouvoir ouvrir le panneau
   * des réglages dans un cadre. La page n'a aucun accès à browser.runtime, et
   * `document.currentScript` ne vaut que pendant l'exécution du script. */
  doc.currentScript = { src: "moz-extension://essai-vttinker/page/pont.js" };
  return doc;
}

/* ---------- le monde PRINCIPAL : page/pont.js ---------- */
function montePont(bus, r20, opts) {
  const molettes = [];
  const ctx = {
    console, JSON, Math, Object, Array, String, Number, Boolean, isFinite, parseInt,
    setTimeout, clearTimeout, setInterval, clearInterval,
    /* L ORIGINE Y FIGURE, et ce n est pas un ornement : le produit la lit
       desormais pour ecarter un message venu d ailleurs. Un faux monde plus
       pauvre que le vrai ne prouve rien. */
    location: { pathname: "/editor/", href: "https://app.roll20.net/editor/",
                origin: ORIGINE_ROLL20 },
    MeshScene: r20.scene,
    Campaign: {}, currentPlayer: {}
  };
  ctx.window = ctx;
  ctx.document = faisDocument(r20, opts);
  /* Les écouteurs de fenêtre sont RANGÉS PAR TYPE et retirables. La barre des
   * marqueurs pose son écouteur de plateau à l'armement et le RETIRE au
   * désarmement — c'est le cœur de sa frugalité —, et un banc qui ne saurait
   * pas les compter ne pourrait pas vérifier qu'elle tient parole. */
  const fenetre = {};
  ctx.addEventListener = function (type, fn) {
    if (type === "message") { bus.ecoute(ctx, fn); }
    if (type === "wheel") { molettes.push(fn); }
    /* UN VRAI DOM DÉDOUBLONNE : réenregistrer le même couple (type, fonction,
     * capture) ne fait rien. Sans ça, le banc comptait deux écouteurs là où le
     * navigateur en aurait tenu un, et faisait échouer du code juste. */
    const l = (fenetre[type] = fenetre[type] || []);
    if (l.indexOf(fn) < 0) { l.push(fn); }
  };
  ctx.removeEventListener = function (type, fn) {
    if (type === "wheel") { const i = molettes.indexOf(fn); if (i >= 0) { molettes.splice(i, 1); } }
    if (fenetre[type]) {
      const j = fenetre[type].indexOf(fn);
      if (j >= 0) { fenetre[type].splice(j, 1); }
    }
  };
  ctx._fenetre = fenetre;
  /* getComputedStyle, parce que le pont LIT les couleurs de Roll20 au lieu de
   * les choisir. Le modèle rend ce que le nœud porte ; sans lui, la lecture
   * levait et le module entier tombait en silence. */
  ctx.getComputedStyle = function (n) {
    const o = {
      backgroundColor: (n && n._fond) || "rgba(0, 0, 0, 0)",
      color: (n && n._texte) || "",
      getPropertyValue(k) {
        if (k === "background-color") { return o.backgroundColor; }
        if (k === "color") { return o.color; }
        return (n && n.style && n.style[k]) || "";
      }
    };
    return o;
  };
  ctx._declenche = function (type, ev) {
    (fenetre[type] || []).slice().forEach(function (f) {
      f(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev));
    });
  };
  ctx.postMessage = function (m) { bus.poste(m, ctx); };
  vm.createContext(ctx);
  vm.runInContext(lis("page/pont.js"), ctx, { filename: "pont.js" });
  return { ctx, molettes, fenetre };
}

/* ---------- le monde ISOLÉ : les quatre scripts de contenu ---------- */
function monteContenu(bus, stock) {
  const postes = [];
  const ctx = {
    console, JSON, Math, Object, Array, String, Number, Boolean, isFinite, parseInt,
    setTimeout, clearTimeout, setInterval, clearInterval, Date,
    location: { pathname: "/editor/", origin: ORIGINE_ROLL20 }
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.top = ctx;   // frame du haut
  /* Le monde isolé DESSINE, et il CLONE : il lui faut un vrai faux DOM, et la
   * commande de zoom de Roll20 à cloner. Sans elle, on n'éprouverait que le
   * repli — c'est-à-dire justement pas ce qui est neuf. */
  ctx.document = faisDom({ roll20Zoom: true });
  ctx.getComputedStyle = function (n) {
    return { backgroundColor: (n && n.style.backgroundColor) || "",
             borderColor: (n && n.style.borderColor) || "" };
  };
  ctx.addEventListener = function (type, fn) { if (type === "message") { bus.ecoute(ctx, fn); } };
  ctx.postMessage = function (m) { postes.push(m); bus.poste(m, ctx); };
  const changeurs = [];
  ctx.browser = {
    runtime: { getURL: (p) => "moz-extension://x/" + p, getManifest: () => manifeste },
    storage: {
      local: {
        get: (cles) => Promise.resolve(Object.fromEntries(
          (Array.isArray(cles) ? cles : [cles]).filter((k) => k in stock).map((k) => [k, stock[k]]))),
        set(o) {
          const ch = {};
          Object.keys(o).forEach((k) => { ch[k] = { oldValue: stock[k], newValue: o[k] }; stock[k] = o[k]; });
          changeurs.slice().forEach((f) => f(ch, "local"));
          return Promise.resolve();
        },
        remove() { return Promise.resolve(); }
      },
      onChanged: { addListener(f) { changeurs.push(f); } }
    }
  };
  vm.createContext(ctx);
  /* LA LISTE SUIT LE MANIFESTE, ET C'EST UNE LEÇON PAYÉE.
   *
   * Le module des marqueurs n'y était pas, et le banc a donc laissé passer une
   * panne au démarrage que la première partie réelle a montrée en deux
   * secondes : il appelait `window.vttMarqueursPropres`, alors que dans un script
   * de contenu les déclarations de haut niveau vivent dans le BAC À SABLE et
   * que `window` est le mandataire de la page, qui ne connaît rien de commun/.
   * Un module absent du montage est un module qu'on n'éprouve pas. */
  /* LA LISTE SUIT LE MANIFESTE, ET ELLE LE SUIT VRAIMENT.
   *
   * Elle en omettait trois : commun/emojis.js (418 l.), contenu/modules/grille.js
   * (167 l.) et contenu/modules/chat.js (866 l.) — deux des quatre modules
   * livrés, jamais montés, donc jamais éprouvés. Le commentaire disait pourtant
   * suivre le manifeste. */
  ["commun/000-navigateur.js", "commun/langue.js", "commun/catalogue.js", "commun/marqueurs.js", "commun/emojis.js",
   "contenu/000-socle.js", "contenu/modules/zoom.js", "contenu/modules/grille.js",
   "contenu/modules/marqueurs.js", "contenu/modules/horspage.js", "contenu/modules/chat.js",
   "contenu/999-demarrage.js"]
    .forEach(function (f) { vm.runInContext(lis(f), ctx, { filename: f }); });
  return { ctx, postes, stock, changeurs };
}

function attends(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ============================================================
 * 3. LE MONDE ISOLÉ DÉMARRE
 * ============================================================ */
async function essaiContenu() {
  titre("3. Monde isolé : catalogue, socle, module, démarrage");

  const bus = faisBus();
  const r20 = faisRoll20(false);
  montePont(bus, r20);
  const c = monteContenu(bus, { "reg:zoomMin": 2, "reg:zoomMax": 600 });

  await attends(60);

  verifie("le catalogue est lisible depuis le monde isolé", Array.isArray(c.ctx.VTT_CATALOGUE));
  verifie("le socle a posé window.VTT", !!c.ctx.VTT);
  verifie("le module « zoom » s'est déclaré", c.ctx.VTT._modules().some((m) => m.id === "zoom"));
  verifie("le démarrage l'a lancé", !!c.ctx.VTT._demarres().zoom);
  verifie("le pont a été injecté (marqueur sur <html>)",
    c.ctx.document.documentElement.hasAttribute("data-vttinker-pont"));

  const demande = c.postes.find((m) => m && m.type === "zoom" && m.actif === true);
  verifie("une demande de bornes est partie vers la page", !!demande);
  if (demande) {
    egal("  min transmis", demande.min, 2);
    egal("  max transmis", demande.max, 600);
    egal("  espace de noms", demande.ns, "vttinker");
    egal("  provenance", demande.depuis, "contenu");
  }

  verifie("le socle a noté le passage sur une partie", c.stock._vuEditeur > 0);

  /* ---------- LA PALETTE, DU STOCKAGE JUSQU'AU PONT ----------
   *
   * Le maillon qui manquait. Le module des marqueurs n'était pas monté ici, et sa
   * panne de démarrage — un appel à `window.vttMarqueursPropres` qui n'existe pas
   * dans un script de contenu — n'a été vue qu'en jouant pour de bon.
   *
   * Ce qu'on éprouve : que la palette lue dans le stockage arrive au pont, et
   * qu'elle soit REVALIDÉE au passage. Le stockage de l'extension survit à
   * tout — c'est sa raison d'être ici — donc il survit aussi à nos versions :
   * une entrée écrite hier ne doit pas pouvoir faire poser une adresse que la
   * validation d'aujourd'hui refuse. */
  const dj = c.postes.filter((m) => m && m.type === "marqueurs" && m.actif === true).pop();
  verifie("la palette est partie vers la page", !!dj, JSON.stringify(dj));
  if (dj) {
    egal("  vide au départ, et c'est normal", dj.catalogue.length, 0);
  }

  const avantJ = c.postes.length;
  await c.ctx.browser.storage.local.set({
    "reg:marqueursPerso": [
      { tag: "vttk_bon_exemple.org/ok.png", nom: "Bon", url: "https://exemple.org/ok.png" },
      { tag: "vttk_mauvais_a.org/2.png", nom: "Mauvais", url: "javascript:alert(1)" },
      { tag: "sans-prefixe", nom: "X", url: "https://exemple.org/x.png" }
    ]
  });
  await attends(30);
  const dj2 = c.postes.slice(avantJ).filter((m) => m && m.type === "marqueurs" && m.actif === true).pop();
  verifie("changer la palette la renvoie aussitôt", !!dj2, JSON.stringify(dj2));
  if (dj2) {
    egal("  et elle est relue et nettoyée", dj2.catalogue.length, 1);
    egal("  c'est la seule valide qui passe", dj2.catalogue[0].tag, "vttk_bon_exemple.org/ok.png");
  }
  /* ET ON NE LE DIT QU'UNE FOIS. Le module réessaie toutes les 400 ms tant que
   * la scène n'est pas là — jusqu'à quarante fois —, et cette ligne partait à
   * chaque tour : dix-huit répétitions au premier passage du banc. Chaque
   * écriture de journal traverse le pont, donc ça ne coûte pas rien. */
  const repet = c.postes
    .filter((m) => m && m.type === "journal")
    .reduce((n, m) => n + (m.lignes || []).filter((l) => /écartée/.test(l)).length, 0);
  verifie("  et l'écart n'est journalisé qu'une fois, pas à chaque essai",
    repet <= 1, repet + " répétitions");

  /* ---------- AJOUTER ET RETIRER DEPUIS LA PALETTE ----------
   *
   * Le geste est passé du panneau à la palette, sur la carte. Mais la palette
   * est dessinée par le PONT, qui vit dans la page : il n'a ni `browser.storage`
   * ni le modèle de commun/marqueurs.js. Il envoie donc le texte collé TEL QUEL, et
   * c'est ici qu'on l'analyse et qu'on écrit.
   *
   * C'est ce maillon-là qu'on éprouve : une seule définition de ce qu'est un
   * marqueur valide, où que le geste parte. */
  await c.ctx.browser.storage.local.set({ "reg:marqueursPerso": [] });
  await attends(20);
  const avantAjout = c.postes.length;
  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-ajoute",
    texte: "https://cdn.discordapp.com/emojis/1234567890123.webp\n"
         + "Poison | https://exemple.org/skull.png\n"
         + "http://pas-https.org/x.png" });
  await attends(30);
  const palette = c.stock["reg:marqueursPerso"] || [];
  egal("coller trois lignes depuis la palette en enregistre deux", palette.length, 2);
  egal("  la première porte l'adresse DANS son étiquette",
    palette[0] && palette[0].tag,
    "vttk_e1234567890123_cdn.discordapp.com/emojis/1234567890123.webp");
  egal("  la seconde porte son nom", palette[1] && palette[1].nom, "Poison");

  /* LE COMPTE RENDU EST LA MOITIÉ DU FORMULAIRE. Coller cinquante lignes et
   * découvrir après coup que douze manquent, sans savoir lesquelles, est
   * exactement le silence qu'on s'interdit. Il repart vers la page, puisque
   * c'est là que le champ vit. */
  const bilan = c.postes.slice(avantAjout).filter((m) => m && m.type === "marqueurs-bilan").pop();
  verifie("  et un compte rendu repart vers la palette", !!bilan, JSON.stringify(bilan));
  egal("    avec ce qui est entré", bilan && bilan.retenus, 2);
  verifie("    et POURQUOI le reste a été écarté",
    !!bilan && bilan.rejets.length === 1 && /https/.test(bilan.rejets[0]),
    JSON.stringify(bilan && bilan.rejets));

  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-retire",
    tag: "vttk_e1234567890123_cdn.discordapp.com/emojis/1234567890123.webp" });
  await attends(30);
  egal("retirer depuis la palette n'en laisse qu'un", (c.stock["reg:marqueursPerso"] || []).length, 1);
  egal("  et c'est l'autre qui reste", c.stock["reg:marqueursPerso"][0].nom, "Poison");
  /* Une étiquette inconnue ne doit RIEN réécrire : une écriture du stockage se
   * diffuse à tous les onglets Roll20 ouverts, et une pour rien est une pose
   * complète pour rien. */
  const ecrAvant = JSON.stringify(c.stock["reg:marqueursPerso"]);
  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-retire", tag: "vttk_rien_a.org/x.png" });
  await attends(30);
  egal("  retirer ce qui n'existe pas n'écrit rien",
    JSON.stringify(c.stock["reg:marqueursPerso"]), ecrAvant);

  /* ---------- LE FORMULAIRE [NOM] [ADRESSE] [+] ----------
   *
   * L'autre porte du même juge. La palette n'envoie plus une zone de texte à
   * découper mais deux champs ; le module doit passer par le MÊME modèle, sans
   * quoi le formulaire et le collage divergeraient au premier cas tordu. */
  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-ajoute",
    nom: "Feu", url: "https://exemple.org/feu.png" });
  await attends(30);
  egal("le formulaire ajoute un marqueur", (c.stock["reg:marqueursPerso"] || []).length, 2);
  egal("  avec le nom qu'on a écrit, sa capitale comprise",
    c.stock["reg:marqueursPerso"][1].nom, "Feu");
  egal("    et une étiquette qui porte l'adresse",
    c.stock["reg:marqueursPerso"][1].tag, "vttk_feu_exemple.org/feu.png");

  /* LE DERNIER COMPTE RENDU, PAS CELUI D'IL Y A DIX LIGNES. `bilan` plus haut
   * est un instantané pris une fois ; le relire ici aurait fait passer pour
   * neuve la réponse du collage, et le contrôle aurait « réussi » sur un
   * message qui ne parlait pas du tout de ce qu'on venait d'envoyer. */
  const dernierBilan = () =>
    c.postes.filter((m) => m && m.type === "marqueurs-bilan").pop();

  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-ajoute",
    nom: "Feu", url: "https://exemple.org/feu.png" });
  await attends(30);
  egal("  le resaisir ne fait pas de doublon", (c.stock["reg:marqueursPerso"] || []).length, 2);
  const bDoublon = dernierBilan();
  verifie("    et il DIT pourquoi — un formulaire muet ment",
    !!bDoublon && bDoublon.retenus === 0 && /déjà/.test(bDoublon.rejets[0] || ""),
    JSON.stringify(bDoublon));

  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-ajoute",
    nom: "Mauvais", url: "http://exemple.org/x.png" });
  await attends(30);
  egal("  une adresse en http est refusée", (c.stock["reg:marqueursPerso"] || []).length, 2);
  const bHttp = dernierBilan();
  verifie("    en le disant", !!bHttp && bHttp.retenus === 0 && /https/.test(bHttp.rejets[0] || ""),
    JSON.stringify(bHttp));

  /* ---------- L'ORDRE, TRIÉ À LA SOURIS ----------
   *
   * Le pont sait quelle tuile a été traînée où ; il ne sait pas écrire. Il
   * envoie donc l'ordre voulu, et c'est ici qu'on le concilie avec ce qui est
   * réellement enregistré — une autre fenêtre a pu changer la palette entre le
   * moment où elle a été affichée et celui où on la trie. */
  const ordreAvant = (c.stock["reg:marqueursPerso"] || []).map((j) => j.tag);
  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-ordre",
    ordre: [ordreAvant[1], ordreAvant[0]] });
  await attends(30);
  egal("trier la palette écrit le nouvel ordre",
    (c.stock["reg:marqueursPerso"] || []).map((j) => j.tag).join(","),
    ordreAvant[1] + "," + ordreAvant[0]);

  /* UNE DEMANDE PÉRIMÉE NE DOIT NI RESSUSCITER NI EFFACER. Le pont peut citer
   * une étiquette supprimée entre-temps, ou en oublier une ajoutée depuis : les
   * citées passent devant, les autres restent à la suite, et rien ne disparaît. */
  const ecr2 = JSON.stringify(c.stock["reg:marqueursPerso"]);
  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-ordre",
    ordre: ["vttk_fantome_a.org/x.png"] });
  await attends(30);
  egal("  une étiquette inconnue dans l'ordre ne change rien",
    JSON.stringify(c.stock["reg:marqueursPerso"]), ecr2);
  bus.poste({ ns: "vttinker", depuis: "page", type: "marqueurs-ordre",
    ordre: [ordreAvant[0]] });
  await attends(30);
  egal("  et un ordre partiel garde tout, le cité en tête",
    (c.stock["reg:marqueursPerso"] || []).map((j) => j.tag).join(","),
    ordreAvant[0] + "," + ordreAvant[1]);

  // Un couple invalide ne doit JAMAIS descendre jusqu'à la caméra.
  const avant = c.postes.length;
  await c.ctx.browser.storage.local.set({ "reg:zoomMax": 1 });   // max < min
  await attends(30);
  const apres = c.postes.slice(avant).filter((m) => m && m.type === "zoom" && m.actif === true);
  verifie("un couple invalide (max < min) est refusé avant le pont", apres.length === 0,
    "posté quand même : " + JSON.stringify(apres));

  /* ---------- LA COMMANDE DESSINÉE ----------
   * Elle ne paraît que lorsque celle de Roll20 est masquée. C'est le pont qui
   * le dit, par « sliderGene » ; on rejoue donc sa réponse. */
  titre("3 bis. La commande de zoom dessinée dans Roll20");
  const doc = c.ctx.document;
  const repondPont = (o) => bus.poste(Object.assign({ ns: "vttinker", depuis: "page", type: "zoom-resultat" }, o));
  /* On ne compte que ce qui est ATTACHÉ. Une commande démontée reste dans
   * l'inventaire du faux DOM, et la confondre avec la vivante fait passer un
   * essai qui ne prouve rien — ou échouer un essai qui marchait. */
  const vivants = (cls) => doc._parClasse(cls).filter((n) => n.isConnected);

  repondPont({ ok: true, min: 2, max: 600, sliderGene: true });
  await attends(20);
  egal("contrôle de Roll20 affiché : on ne dessine RIEN", vivants("vttk-zoom").length, 0);

  repondPont({ ok: true, min: 2, max: 600, sliderGene: false, controleMasque: true });
  await attends(20);
  const cmd = vivants("vttk-zoom")[0];
  verifie("contrôle de Roll20 masqué : la commande est dessinée", !!cmd);
  if (cmd) {
    egal("  et une seule", vivants("vttk-zoom").length, 1);

    /* ---- ELLE ENTRE DANS SA COLONNE, ENTRE L'OEIL ET LA MIRE ---- */
    const pc = doc.querySelectorAll(".parentContainer")[0] ||
               doc._parClasse("parentContainer")[0];
    egal("  elle est dans sa colonne", cmd.parentNode, pc);
    egal("  et à la place de son bloc de zoom, avant la mire",
      pc.children.indexOf(cmd), pc.children.length - 2);
    verifie("  donc elle ne flotte pas", !cmd.classList.contains("vttk-zoom-flottant"));

    /* ---- SES BOUTONS SONT DES CLONES DES SIENS ----
     * C'est ce qui donne la police d'icônes, les dimensions et le thème. Un
     * « + » tapé au clavier n'aurait ni son dessin ni sa taille. */
    // Les boutons d'action seulement : la case de valeur est elle aussi un
    // clone, mais elle n'a pas d'icône et ne se compte pas ici.
    const boutons = vivants("vttk-zoom-natif")
      .filter((b) => b.tag === "button" && b.querySelector(".grimoire__roll20-icon"));
    egal("  deux boutons clonés sur les siens", boutons.length, 2);
    const glyphes = boutons.map((b) => {
      const s = b.querySelector(".grimoire__roll20-icon");
      return s ? s.textContent : null;
    });
    verifie("  ils portent SES glyphes d'icône, pas des caractères",
      glyphes.indexOf("plus") >= 0 && glyphes.indexOf("minus") >= 0, JSON.stringify(glyphes));
    verifie("  et SES attributs de portée, que le CSS scopé exige",
      boutons.every((b) => "data-v-2f0bc668" in b.attrs));

    const gliss = vivants("vttk-zoom-s")[0];
    const val = vivants("vttk-zoom-v")[0];
    verifie("  un glisseur et une case de valeur", !!gliss && !!val);
    verifie("  la case est logée dans son bouton de valeur cloné",
      !!val && !!val.parentNode && (val.parentNode.className || "").indexOf("vttk-zoom-ecrin") >= 0);

    /* ---- LES COULEURS DE SON GLISSEUR SONT RECOPIÉES ----
     * C'est ce qui rend le nôtre juste dans un thème qu'on ne connaît pas. */
    egal("  la piste reprend sa couleur", cmd.style["--vttk-piste"], "rgb(237, 245, 250)");
    egal("  le remplissage aussi", cmd.style["--vttk-rempli"], "rgb(180, 0, 106)");
    egal("  le curseur aussi", cmd.style["--vttk-curseur-bord"], "rgb(225, 0, 133)");

    // Ce que le pont pousse doit se voir, molette de Roll20 comprise.
    bus.poste({ ns: "vttinker", depuis: "page", type: "zoom-etat", zoom: 300, min: 2, max: 600 });
    await attends(20);
    egal("  une valeur poussée par le pont s'affiche", String(val.value), "300");
    // 300 sur une échelle logarithmique 2 → 600 : ln(150)/ln(300) ≈ 0,879
    proche("  et le glisseur se place en logarithmique",
      Number(gliss.value), 1000 * Math.log(300 / 2) / Math.log(600 / 2), 2);

    /* Les boutons ne calculent rien : ils DEMANDENT un pas. On les désigne par
     * leur infobulle et non par leur rang — le rang a déjà changé une fois,
     * quand la barre est passée à la verticale, et l'essai a continué de passer
     * en cliquant l'autre bouton. */
    // .title est posé en PROPRIÉTÉ par le module ; dans un vrai DOM elle se
    // reflète en attribut, dans le faux non — on regarde les deux.
    /* ON CHERCHE LE BOUTON PAR SON MOT TRADUIT, et non par un mot français
     * écrit ici. L'anglais est le défaut depuis que la langue est un réglage :
     * chercher « Zoomer » revenait à chercher un bouton qui n'existe plus, et
     * le banc s'arrêtait sur « undefined.clique » — ce qui ressemble à un
     * bouton disparu alors que c'est le contrôle qui parlait la mauvaise
     * langue. Passer par le dictionnaire vérifie aussi, au passage, que la
     * traduction est bien appliquée. */
    const bouton = (titre) => boutons.find((b) => (b.title || b.attrs.title) === titre);
    const zoomPlus = c.ctx.vttMot("zoom.plus", "en");
    const zoomMoins = c.ctx.vttMot("zoom.moins", "en");
    verifie("le bouton de zoom parle la langue en vigueur", !!bouton(zoomPlus),
      boutons.map((b) => b.title || b.attrs.title).join(" / "));
    const n0 = c.postes.length;
    bouton(zoomPlus).clique();
    const dem = c.postes.slice(n0).find((m) => m && m.type === "zoom-pas");
    verifie("  le bouton + demande un pas au pont, sans le calculer", !!dem && dem.monte === true);
    const n0b = c.postes.length;
    bouton(zoomMoins).clique();
    const dem2 = c.postes.slice(n0b).find((m) => m && m.type === "zoom-pas");
    verifie("  et le bouton − demande le pas inverse", !!dem2 && dem2.monte === false);

    // Le glisseur demande une valeur absolue, bornée.
    const n1 = c.postes.length;
    gliss.saisis("1000");
    const veut = c.postes.slice(n1).find((m) => m && m.type === "zoom-veut");
    verifie("  le glisseur demande une valeur", !!veut);
    if (veut) { egal("    et au bout de sa course, c'est le maximum", veut.valeur, 600); }

    // Et elle disparaît si Roll20 récupère son contrôle.
    repondPont({ ok: true, min: 2, max: 600, sliderGene: true });
    await attends(20);
    verifie("  Roll20 récupère son contrôle : la nôtre se retire", !cmd.isConnected);
  }

  /* ---------- L'INTERRUPTEUR, DANS LES DEUX SENS ----------
   * Éteindre puis rallumer faisait disparaître la commande DÉFINITIVEMENT :
   * le module s'arrêtait et rien ne le relançait avant un rechargement de la
   * partie. Un interrupteur qui ne rallume pas n'est pas un interrupteur. */
  titre("3 ter. Éteindre et rallumer le module");
  // L'essai du couple invalide a laissé un maximum de 1 dans le stockage : on
  // repose des bornes valables, sinon le module rallumé refuserait — à raison.
  await c.ctx.browser.storage.local.set({ "reg:zoomMax": 600 });
  await attends(20);
  const n2 = c.postes.length;
  await c.ctx.browser.storage.local.set({ "mod:zoom": false });
  await attends(30);
  verifie("éteint : le module demande au pont de tout rendre",
    c.postes.slice(n2).some((m) => m && m.type === "zoom" && m.actif === false));
  egal("  et il n'est plus dans les modules qui tournent",
    c.ctx.VTT._demarres().zoom === undefined, true);
  egal("  la commande est retirée", vivants("vttk-zoom").length, 0,
    vivants("vttk-zoom").map((n) => n.className + " dans " + (n.parentNode && n.parentNode.className)).join(" / "));

  /* ET ELLE NE REVIENT PAS TOUTE SEULE. La minuterie qui attend la commande de
   * Roll20 pour en prendre modèle a réinstallé le module APRÈS son extinction,
   * une fois sur deux. Un essai qui échoue par intermittence est le seul qu'on
   * a envie de croire cassé plutôt que révélateur : on lui laisse le temps de
   * se manifester. */
  const nApres = c.postes.length;
  await attends(700);
  verifie("  et rien ne la réinstalle dans la seconde qui suit",
    !c.postes.slice(nApres).some((m) => m && m.type === "zoom" && m.actif === true) &&
    vivants("vttk-zoom").length === 0,
    "réinstallée par une minuterie restée armée");

  const n3 = c.postes.length;
  await c.ctx.browser.storage.local.set({ "mod:zoom": true });
  await attends(30);
  verifie("rallumé : il redémarre sur-le-champ", !!c.ctx.VTT._demarres().zoom);
  verifie("  et redemande ses bornes au pont",
    c.postes.slice(n3).some((m) => m && m.type === "zoom" && m.actif === true));

  /* Et il ne s'est PAS abonné deux fois : sinon chaque réponse du pont serait
   * traitée en double, puis en triple à la bascule suivante. On le mesure en
   * comptant les commandes dessinées — deux écouteurs en dessineraient deux. */
  repondPont({ ok: true, min: 2, max: 600, sliderGene: false, controleMasque: true });
  await attends(20);
  egal("  une seule commande, donc un seul écouteur", vivants("vttk-zoom").length, 1);
}

/* ============================================================
 * 4. LE PONT PROLONGE LE ZOOM
 * ============================================================ */
async function essaiPont(borneSilencieux) {
  titre("4. Pont — modèle où setZoomSilent " + (borneSilencieux ? "BORNE" : "ne borne PAS"));

  const bus = faisBus();
  const r20 = faisRoll20(borneSilencieux);
  const p = montePont(bus, r20);

  const natifSetZoom = r20.engine.setZoom;
  let reponse = null;
  bus.ecoute(null, (ev) => { if (ev.data && ev.data.type === "zoom-resultat") { reponse = ev.data; } });

  // --- bornes identiques au natif : rien ne doit être touché ---
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "zoom", actif: true, min: 10, max: 250 });
  verifie("bornes natives : le pont répond sans rien remplacer", !!reponse && reponse.natif === true);
  egal("  setZoom est resté celui de Roll20", r20.engine.setZoom, natifSetZoom);
  egal("  aucune molette interceptée", p.molettes.length, 0);

  // --- bornes élargies ---
  reponse = null;
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "zoom", actif: true, min: 2, max: 600 });
  verifie("bornes élargies : installation acceptée", !!reponse && reponse.ok === true, JSON.stringify(reponse));
  verifie("  setZoom a été remplacé", r20.engine.setZoom !== natifSetZoom);
  egal("  la molette est écoutée", p.molettes.length, 1);
  egal("  pas d'avis de slider (contrôle masqué)", reponse && reponse.sliderGene, false);

  /* POSER UN ZOOM PAR LE CHEMIN DU PANNEAU. Au-delà de sa borne, `r20.engine.zoom`
   * ne bouge plus : on ne peut donc plus s'y placer en l'écrivant à la main, il
   * faut passer par le module — exactement comme le fait le champ de saisie. */
  const pose = async (pont, z) => {
    bus.poste({ ns: "vttinker", depuis: "contenu", type: "zoom-veut", valeur: z });
    await attends(10);
  };

  // --- dans la plage native, Roll20 garde la main ---
  r20.engine.zoom = 100;
  r20.journal.length = 0;
  r20.engine.stepAdjustZoom(true);
  egal("dans la plage : le bouton + donne 110", r20.engine.zoom, 110);
  verifie("  et il est passé par le setZoom d'origine", r20.journal.some((l) => l[0] === "setZoom"));

  /* ============================================================
   *   AU-DELÀ DE SA BORNE : LA CAMÉRA, ET RIEN QUE LA CAMÉRA
   * ============================================================
   *
   * MESURÉ SUR UNE VRAIE PARTIE, en chronométrant les trames :
   *
   *     dans sa plage (10–250)             9 à 29 ms par cran
   *     au-delà, caméra seule              6 ms par trame, 1754 % atteint en 3 s
   *     au-delà, dès qu'on écrit chez lui  600 à 2 000 ms, À CHAQUE ÉCRITURE
   *
   * Ce qui coûte n'est pas notre code — un cran fait zéro à une milliseconde de
   * travail synchrone — mais le fait que Roll20 APPRENNE le zoom : il refait
   * alors son fond, et au-delà de sa borne il ne sait pas le faire pour moins
   * d'une seconde.
   *
   * Un premier jet différait cette écriture à la fin du geste : une
   * reconstruction au lieu de dix, mais il en restait une par salve de molette,
   * et l'auteur l'a sentie. On ne l'écrit donc plus DU TOUT au-delà de 250 %.
   * Ce qu'on perd est la netteté de son fond, resté à la dernière résolution
   * qu'il connaisse ; ce qu'on gagne est qu'il n'y a plus une seule pause.
   *
   * CES CONTRÔLES SONT DONC LE CONTRAT : au-delà, son magasin ne bouge JAMAIS,
   * et la caméra porte tout. */

  /* --- LA JONCTION. C'est le point où un pas mal choisi se sent : le dernier
     pas de Roll20 vaut 10, le premier du prolongement doit valoir 10 aussi. --- */
  r20.engine.zoom = 250;
  r20.journal.length = 0;
  r20.engine.stepAdjustZoom(true);
  proche("à la jonction, la caméra fait exactement le pas de Roll20 (250 -> 260)",
    r20.camera.orthoTop, (1066 / 2) * (100 / 260), 0.6);
  egal("  et son magasin ne bouge PAS : il n'a rien à recalculer", r20.engine.zoom, 250);
  egal("    donc aucun appel chez lui",
    r20.journal.filter((l) => /setZoom/.test(l[0])).length, 0);
  r20.engine.stepAdjustZoom(false);
  egal("et le bouton − le ramène dans sa plage, où il reprend tout (260 -> 250)",
    r20.engine.zoom, 250);
  verifie("  et là, il est bien appelé",
    r20.journal.filter((l) => /setZoom/.test(l[0])).length >= 1);

  /* Plus haut, le pas s'élargit : c'est ce qu'on attend d'un zoom. On le lit sur
   * la CAMÉRA, seule à savoir où l'on est. */
  r20.engine.zoom = 250;
  await pose(p, 500);
  r20.engine.stepAdjustZoom(true);
  proche("plus haut, le pas accélère (500 -> 520)",
    r20.camera.orthoTop, (1066 / 2) * (100 / 520), 0.6);

  /* DIX CRANS D'AFFILÉE, ET PAS UNE SEULE ÉCRITURE CHEZ LUI. C'est tout le
   * correctif, et c'est la seule chose qui sépare un zoom fluide d'une seconde
   * de gel par salve. On compte ses appels, pas nos intentions. */
  await pose(p, 300);
  r20.journal.length = 0;
  for (let i = 0; i < 10; i++) { r20.engine.stepAdjustZoom(true); }
  egal("dix crans au-delà de sa borne : AUCUNE écriture chez lui",
    r20.journal.filter((l) => /setZoom/.test(l[0])).length, 0);
  egal("  son magasin est resté où il était", r20.engine.zoom, 250);
  proche("  et la caméra a suivi les dix",
    r20.camera.orthoTop, (1066 / 2) * (100 / (300 * Math.pow(1 + 10 / 250, 10))), 4);

  /* ET ON EN REDESCEND SANS SE PERDRE : repasser sous 250 lui rend la main, et
   * c'est le seul moment où il apprend quelque chose. */
  await pose(p, 200);
  egal("redescendre dans sa plage lui rend le zoom", r20.engine.zoom, 200);
  proche("  et la caméra est la sienne", r20.camera.orthoTop, (1066 / 2) * (100 / 200), 0.6);

  /* LA MOLETTE A UNE CIBLE, ET C'EST LA TOILE. Les contrôles la passaient sous
   * silence, et le module n'en tenait pas compte non plus : il coupait donc
   * TOUT défilement de la page dès que le zoom sortait des bornes de Roll20 —
   * le tchat, le journal, une fiche, et notre propre palette, qui déroule
   * soixante-dix marqueurs. Un modèle qui omet la cible ne peut pas voir ce
   * défaut-là ; le contrôle suivant, lui, le tient. */
  const surToile = (o) => Object.assign({ target: r20.toile }, o);

  // --- la molette au-delà de la borne native, avec SON pas à elle ---
  await pose(p, 250);
  let coupe = false;
  p.molettes[0](surToile({ deltaY: -102, preventDefault() { coupe = true; }, stopImmediatePropagation() {} }));
  proche("molette vers le haut à 250 : un cran de Roll20 (250 -> 263), sur la caméra",
    r20.camera.orthoTop, (1066 / 2) * (100 / 263), 0.6);
  egal("  et son magasin reste à 250", r20.engine.zoom, 250);
  verifie("  et l'événement a bien été coupé", coupe);

  // --- la molette DANS la plage native : on ne touche à rien ---
  await pose(p, 100);
  let coupe2 = false;
  p.molettes[0](surToile({ deltaY: -102, preventDefault() { coupe2 = true; }, stopImmediatePropagation() {} }));
  egal("molette à 100 % : le zoom est laissé à Roll20", r20.engine.zoom, 100);
  verifie("  et l'événement n'est PAS coupé", !coupe2);

  /* AILLEURS QUE SUR LE PLATEAU, ON NE TOUCHE À RIEN — même au-delà de la borne
   * native, là où le module agirait sur la toile. C'est le contrôle qui manquait :
   * sans lui, dérouler la palette au-delà de 250 % zoomait la carte. */
  await pose(p, 250);
  let coupe3 = false;
  /* Un nœud qui n'est PAS la toile et n'en descend pas — le tchat, la palette,
   * n'importe quoi d'autre. Un objet nu suffit : le module ne fait que remonter
   * ses `parentNode` jusqu'à la toile, et il n'y arrivera pas. */
  const ailleurs = { parentNode: null };
  p.molettes[0]({ deltaY: -102, target: ailleurs,
    preventDefault() { coupe3 = true; }, stopImmediatePropagation() {} });
  egal("une molette HORS du plateau ne zoome pas", r20.engine.zoom, 250);
  verifie("  et l'événement lui est laissé intact", !coupe3);

  /* --- notre propre borne haute. Elle se lit sur la caméra : au-delà de 250 le
     magasin de Roll20 ne dit plus rien de ce qu'on voit. --- */
  await pose(p, 600);
  const hautAvant = r20.camera.orthoTop;
  p.molettes[0](surToile({ deltaY: -102, preventDefault() {}, stopImmediatePropagation() {} }));
  egal("à notre maximum, la molette ne dépasse pas", r20.camera.orthoTop, hautAvant);

  /* --- sous 10 %, le plancher d'un point prend le relais. C'est HORS de sa
     plage par le bas, donc la caméra là aussi porte tout. --- */
  await pose(p, 10);
  r20.engine.stepAdjustZoom(false);
  proche("sous 10 % : le bouton − descend d'un point (10 -> 9)",
    r20.camera.orthoTop, (1066 / 2) * (100 / 9), 1);
  await pose(p, 2);
  const basAvant = r20.camera.orthoTop;
  r20.engine.stepAdjustZoom(false);
  egal("à notre minimum, le bouton − ne descend plus", r20.camera.orthoTop, basAvant);

  /* --- LE MASQUAGE EST AUTOMATIQUE, et il n'y a plus de réglage pour ça. Le
     module rend une commande identique à la place : il n'y a plus d'arbitrage
     à soumettre, donc plus de case à cocher. --- */
  r20.preference.zoom.interfaceEnabled = true;
  reponse = null;
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "zoom", actif: true, min: 2, max: 600 });
  egal("bornes élargies : le contrôle de Roll20 est masqué d'office",
    r20.preference.zoom.interfaceEnabled, false);
  verifie("  et le pont le dit dans sa réponse", !!reponse && reponse.controleMasque === true);
  egal("  il annonce alors que le sien n'est plus affiché", reponse.sliderGene, false);

  // --- extinction : tout est rendu, le réglage de compte compris ---
  r20.engine.zoom = 500;
  reponse = null;
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "zoom", actif: false });
  verifie("extinction : le pont répond", !!reponse && reponse.ok === true);
  egal("  le contrôle de Roll20 est REMIS comme on l'a trouvé",
    r20.preference.zoom.interfaceEnabled, true);
  egal("  setZoom rendu à Roll20", r20.engine.setZoom, natifSetZoom);
  egal("  plus aucune molette écoutée", p.molettes.length, 0);
  verifie("  la vue est ramenée dans la plage de Roll20 (" + r20.engine.zoom + " %)",
    r20.engine.zoom <= 250 && r20.engine.zoom >= 10,
    "sinon la partie reste à 500 % sans plus aucun moyen d'en sortir");
  /* Relevé sur une vraie partie : l'état revenait bien dans la plage, et la
   * caméra restait où le module l'avait laissée. La vue était de travers, et
   * plus rien ne l'aurait recalée. */
  proche("  et LA CAMÉRA est raccordée à cet état", r20.camera.orthoTop,
    (1066 / 2) * (100 / r20.engine.zoom), 0.6);

  // Le même point, depuis le bas : c'est là qu'il a été pris en défaut.
  r20.engine.zoom = 5;
  r20.camera.orthoTop = (1066 / 2) * (100 / 5);
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "zoom", actif: true, min: 2, max: 600 });
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "zoom", actif: false });
  egal("extinction depuis 5 % : l'état remonte au plancher", r20.engine.zoom, 10);
  proche("  et la caméra le suit", r20.camera.orthoTop, (1066 / 2) * (100 / 10), 0.6);
}

/* ============================================================
 * 4 bis. LA GRILLE ÉTENDUE HORS DE LA CARTE
 * ============================================================
 *
 * Deux choses seulement, mais ce sont les deux qui comptent : que la case garde
 * sa taille (sinon on a étiré la trame au lieu de l'étendre), et que les lignes
 * restent alignées sur les siennes (sinon l'aimantation, qui est la sienne, ne
 * tombe plus dessus). */
async function essaiGrille() {
  titre("4 bis. La grille étendue hors de la carte");

  const bus = faisBus();
  const r20 = faisRoll20(false);
  montePont(bus, r20);

  let rep = null;
  bus.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rep = ev.data; } });
  const g = r20.grille;
  const cellule = Math.abs(g.scaling.x) / g.material._vectors2.gridSize.x;
  egal("la case de la page mesure 70 px", cellule, 70);

  bus.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 60 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);
  verifie("extension acceptée", !!rep && rep.ok === true, JSON.stringify(rep));

  const gs = g.material._vectors2.gridSize;
  egal("  22 cases deviennent 22 + 2×60", gs.x, 142);
  egal("  32 cases deviennent 32 + 2×60", gs.y, 152);
  egal("  et l'échelle suit exactement", g.scaling.x, 142 * 70);

  /* LE SIGNE DE L'ÉCHELLE EN Y. Chez lui il est NÉGATIF — l'axe descend. Le lui
   * retourner mettrait la grille à l'envers, et c'est le genre d'erreur qu'on
   * ne voit qu'en jouant. */
  verifie("  le signe négatif de son échelle en y est conservé", g.scaling.y < 0);
  egal("  et sa valeur est juste", g.scaling.y, -152 * 70);

  // LA CASE N'A PAS CHANGÉ DE TAILLE : c'est toute la différence entre étendre
  // la grille et l'étirer.
  egal("  la case mesure toujours 70 px", Math.abs(g.scaling.x) / gs.x, 70);
  egal("  en hauteur aussi", Math.abs(g.scaling.y) / gs.y, 70);

  /* L'ALIGNEMENT. On ajoute des cases ENTIÈRES de part et d'autre d'un centre
   * inchangé : le bord passe de 0 à -70n, qui reste un multiple de la case.
   * Les lignes tombent donc sur les siennes — donc sur l'aimantation. */
  const demiLargeur = Math.abs(g.scaling.x) / 2;
  verifie("  le bord reste sur un multiple de la case (alignement conservé)",
    (demiLargeur - 1540 / 2) % 70 === 0, "décalage de " + ((demiLargeur - 770) % 70) + " px");

  // Réappliquer ne doit pas cumuler : l'état d'origine ne se reprend qu'une fois.
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 60 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);
  egal("appliquée deux fois, elle ne cumule pas", gs.x, 142);

  bus.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 10 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);
  egal("changer la valeur repart de son état d'origine", gs.x, 42);

  bus.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });
  egal("extinction : sa grille lui est rendue", gs.x, 22);
  egal("  en hauteur aussi", gs.y, 32);
  egal("  et l'échelle avec", g.scaling.x, 1540);
  egal("  signe compris", g.scaling.y, -2240);

  /* ---------- LES GRILLES EN LIGNES ----------
   * Elles ne se mettent pas à l'échelle : on les pave. Et le pavage doit tenir
   * en UN maillage sans segment en double — c'est à la fois le défaut d'aspect
   * (une ligne à 0,5 dessinée deux fois en fait une à 0,75) et le coût de
   * rendu (un appel au lieu de cent soixante-huit). */
  const bl = faisBus();
  const rl = faisRoll20(false);
  rl.scene.meshes = [rl.scene.faisLignes("Hex-Grid-Line-System")];
  montePont(bl, rl);
  let rp = null;
  bl.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rp = ev.data; } });

  /* Ce modèle-là est fait de droites qui traversent la page de part en part :
   * c'est la mécanique des isométries qui doit le prendre, pas celle des
   * cellules. Le pont le décide sur la longueur MÉDIANE des segments, sans rien
   * savoir du type de grille. */
  bl.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 10 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);
  verifie("grille en droites : reconnue comme telle", !!rp && rp.ok === true && rp.mode === "droites",
    JSON.stringify(rp));
  egal("  deux familles de parallèles", rp && rp.familles, 2);
  egal("  écartées de la période", rp && rp.ecarts && rp.ecarts[0], 10);

  const notre = rl.scene.meshes.filter((m) => /^vttk-grille-/.test(m.name));
  egal("  UN SEUL maillage ajouté, pas une copie par tuile", notre.length, 1);

  /* AUCUN SEGMENT EN DOUBLE, ni entre nos tuiles, ni avec la sienne. On
   * reconstruit les clés comme le pont les construit, et on compte. */
  const cle = (p, a, b) => {
    let x0 = p[a * 3], y0 = p[a * 3 + 1], x1 = p[b * 3], y1 = p[b * 3 + 1];
    if (x1 < x0 || (x1 === x0 && y1 < y0)) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    return Math.round(x0 * 100) + "," + Math.round(y0 * 100) + "," +
           Math.round(x1 * 100) + "," + Math.round(y1 * 100);
  };
  const cles = new Set();
  let doubles = 0;
  const np = notre[0]._pos, ni = notre[0]._idx;
  for (let s = 0; s < ni.length / 2; s++) {
    const k = cle(np, ni[2 * s], ni[2 * s + 1]);
    if (cles.has(k)) { doubles++; } else { cles.add(k); }
  }
  egal("  aucun segment dessiné deux fois", doubles, 0);

  // Et surtout : pas un seul segment par-dessus les siens.
  const sienne = new Set();
  const op = rl.scene.meshes[0]._pos, oi = rl.scene.meshes[0]._idx;
  for (let s = 0; s < oi.length / 2; s++) { sienne.add(cle(op, oi[2 * s], oi[2 * s + 1])); }
  let surSienne = 0;
  cles.forEach((k) => { if (sienne.has(k)) { surSienne++; } });
  egal("  et aucun par-dessus ceux de Roll20", surSienne, 0);

  /* ---------- LA GRILLE ROGNÉE : LE PAVÉ SE PREND AU MILIEU ----------
   * Roll20 coupe sa géométrie au bord de la page, en plein milieu des cellules.
   * Recopier ce bord posait une colonne de demi-arêtes pâles à chaque jointure —
   * 1 058 relevées en jeu. Le pavé doit donc s'écarter des bords, et ce qu'on
   * répète ne doit contenir QUE des arêtes entières. */
  const br = faisBus();
  const rr = faisRoll20(false);
  rr.scene.meshes = [rr.scene.faisLignesRognees("Hex-Grid-Line-System")];
  montePont(br, rr);
  let rrp = null;
  br.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rrp = ev.data; } });
  br.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 10 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);

  verifie("grille rognée : pavage accepté", !!rrp && rrp.ok === true, JSON.stringify(rrp));
  // Dix périodes, deux écartées de chaque bord : il en reste six.
  egal("  deux périodes de marge de chaque bord", rrp && rrp.motifs && rrp.motifs[0], 6);
  egal("  donc un pas de six périodes", rrp && rrp.pas && rrp.pas[0], 60);

  /* Aucune demi-arête RECOPIÉE. On ne regarde que les segments franchement au
   * large de la page : ceux qui la touchent sont légitimement coupés à son
   * bord, et c'est même tout l'objet du découpage. */
  const nr = rr.scene.meshes.filter((m) => /^vttk-grille-/.test(m.name))[0];
  const auLarge = (x, y) => x < -15 || x > 115 || y < -115 || y > 15;
  let moignons = 0, totalR = 0;
  for (let s = 0; s < nr._idx.length / 2; s++) {
    const a = nr._idx[2 * s] * 3, b = nr._idx[2 * s + 1] * 3;
    if (!auLarge(nr._pos[a], nr._pos[a + 1]) || !auLarge(nr._pos[b], nr._pos[b + 1])) { continue; }
    const L = Math.hypot(nr._pos[b] - nr._pos[a], nr._pos[b + 1] - nr._pos[a + 1]);
    totalR++;
    if (Math.abs(L - 10) > 0.001) { moignons++; }
  }
  verifie("  et des segments à recopier", totalR > 0, "aucun segment posé");
  egal("  AUCUNE demi-arête recopiée au large", moignons, 0);

  /* ---------- PAS DE FRANGE AU BORD DE LA PAGE ----------
   * Le défaut le plus visible, et le seul qu'aucun de nos comptes ne pouvait
   * dire : on écartait un segment ENTIER dès que son milieu tombait sur la
   * page. Or Roll20 tronque sa géométrie au bord ; la moitié extérieure d'un
   * côté qui l'enjambe n'était donc dessinée par personne. Rien à compter,
   * puisqu'il n'y avait rien — ni doublon, ni pâleur, ni déphasage.
   *
   * On mesure donc la LONGUEUR DE TRAIT posée dans une bande collée au bord,
   * et on la compare à celle d'une bande identique une période plus loin. Le
   * réseau étant périodique, les deux doivent être égales. */
  const longueurEntre = (mesh, y0, y1) => {
    let L = 0;
    for (let s = 0; s < mesh._idx.length / 2; s++) {
      const a = mesh._idx[2 * s] * 3, b = mesh._idx[2 * s + 1] * 3;
      let ax = mesh._pos[a], ay = mesh._pos[a + 1];
      let bx = mesh._pos[b], by = mesh._pos[b + 1];
      if (ay > by) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
      if (by <= y0 || ay >= y1) { continue; }
      const t = (y) => (by === ay ? 0 : (y - ay) / (by - ay));
      const t0 = ay >= y0 ? 0 : t(y0), t1 = by <= y1 ? 1 : t(y1);
      L += Math.hypot((bx - ax) * (t1 - t0), (by - ay) * (t1 - t0));
    }
    return L;
  };
  // La page va de y = -100 à y = 0 ; la période vaut 10.
  const auBord = longueurEntre(nr, 0, 5);
  const plusLoin = longueurEntre(nr, 10, 15);
  verifie("  aucune frange au bord de la page",
    Math.abs(auBord - plusLoin) < 0.001 && auBord > 0,
    "collé au bord " + auBord.toFixed(2) + ", une période plus loin " + plusLoin.toFixed(2));

  // Les arêtes intérieures de Roll20 sont doubles : les nôtres doivent l'être
  // aussi, sinon la jointure ressort PÂLE au lieu de ressortir épaisse.
  const compte = new Map();
  for (let s = 0; s < nr._idx.length / 2; s++) {
    const k = cle(nr._pos, nr._idx[2 * s], nr._idx[2 * s + 1]);
    compte.set(k, (compte.get(k) || 0) + 1);
  }
  const seules = [...compte.values()].filter((v) => v === 1).length;
  const doubles2 = [...compte.values()].filter((v) => v === 2).length;
  verifie("  les arêtes intérieures restent DOUBLES comme les siennes",
    doubles2 > seules * 2, doubles2 + " doubles pour " + seules + " simples");
  br.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });

  /* ---------- LA DENSITÉ D'UNE GRILLE DE DROITES ----------
   * Quarante droites par famille, et du bruit de flottant : c'est le cas réel.
   * Ce qu'on exige, c'est que l'écart posé soit celui qu'on a lu — une famille
   * découpée en trois motifs imaginaires triple sa densité, et le défaut se voit
   * immédiatement à l'écran sous forme de chevauchement. */
  const bd = faisBus();
  const rd = faisRoll20(false);
  rd.scene.meshes = [rd.scene.faisDroitesDenses("Iso-Grid-Line-System", 25, 40, 900)];
  montePont(bd, rd);
  let rdp = null;
  bd.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rdp = ev.data; } });
  bd.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 10 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);

  verifie("droites serrées : reconnues comme telles",
    !!rdp && rdp.ok === true && rdp.mode === "droites", JSON.stringify(rdp));
  egal("  chaque famille garde UN seul motif", rdp && rdp.motifs && rdp.motifs.join(","), "1,1");
  verifie("  et l'écart posé est celui qu'on a lu",
    !!rdp && rdp.ecarts && rdp.ecarts.every((e) => Math.abs(e - 25) < 0.25),
    "écarts " + (rdp && rdp.ecarts));
  bd.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });

  /* ---------- LA GRILLE PEINTE : SIX SOMMETS AU LIEU DE QUATRE-VINGT-NEUF MILLE ----------
   *
   * C'est la voie normale depuis qu'on a compris que répéter la géométrie était
   * perdu d'avance : le coût suivait la SURFACE du halo. Roll20 lui-même peint
   * sa grille carrée dans un shader sur un quad — le seul type dont personne ne
   * s'est jamais plaint. On fait pareil pour les quatre autres.
   *
   * Ce qu'on vérifie ici, c'est ce que le shader REÇOIT : un modèle de trame
   * faux se peindrait tout aussi vite, et bien plus mal. */
  const bp = faisBus();
  const rp2 = faisRoll20(false, true);   // avec de quoi peindre
  rp2.scene.meshes = [rp2.scene.faisHexagones("Hex-Grid-Line-System", 20, 200, 200)];
  const pontP = montePont(bp, rp2);
  let rpp = null;
  bp.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rpp = ev.data; } });
  bp.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 30 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);

  verifie("grille peinte : c'est bien elle qui prend la main",
    !!rpp && rpp.ok === true && rpp.mode === "peinture" && rpp.forme === "hexagones",
    JSON.stringify(rpp));
  const quad = rp2.scene.meshes.filter((m) => m.name === "vttk-grille-peinte")[0];
  verifie("  un quad de quatre sommets, et rien d'autre", !!quad && quad.getTotalVertices() === 4,
    quad ? quad.getTotalVertices() + " sommets" : "pas de quad");
  egal("  aucun maillage de segments à côté",
    rp2.scene.meshes.filter((m) => /^vttk-grille-etendue/.test(m.name)).length, 0);

  const u = quad && quad.material && quad.material.uniformes;
  egal("  le shader travaille en mode hexagones", u && u.mode, 0);
  verifie("  et on lui donne la bonne largeur d'hexagone",
    !!u && Math.abs(u.taille[0] - 20) < 0.01 && Math.abs(u.taille[1] - 20 * Math.sqrt(3) / 2) < 0.01,
    "taille " + (u && u.taille));
  verifie("  l'ajustement de phase tombe juste", !!rpp && rpp.residu < 0.01,
    "résidu " + (rpp && rpp.residu) + " px");
  /* L'OPACITÉ EST CORRIGÉE, et ce n'est pas un détail : Roll20 dessine ses
   * hexagones un par un, donc chaque arête intérieure DEUX fois. Une trame
   * peinte ne la trace qu'une fois et sortirait plus pâle que la sienne. */
  verifie("  l'opacité compense le double tracé de Roll20",
    !!u && Math.abs(u.opacite - (1 - 0.7 * 0.7)) < 0.001,
    "opacité " + (u && u.opacite) + " pour 0,3 lue");
  verifie("  le quad couvre la page ET le halo",
    !!quad && quad.scaling.x > 200 + 2 * 30 * 20 - 1,
    "largeur " + (quad && quad.scaling.x));

  /* ---------- LE REPÈRE, ET C'EST LE CONTRÔLE QUI MANQUAIT ----------
   * Deux exigences, et l'une sans l'autre ne sert à rien : le shader doit se
   * voir remettre la position du maillage pour la retrancher, ET le quad doit
   * être posé dans le MONDE, donc à cette position près. */
  const src = rp2.scene.meshes.filter((m) => /Grid-Line-System/.test(m.name))[0];
  verifie("  le shader reçoit la position du maillage à retrancher",
    !!u && u.decalage && Math.abs(u.decalage[0] - src.position.x) < 0.001 &&
    Math.abs(u.decalage[1] - src.position.y) < 0.001,
    "décalage " + (u && u.decalage) + " pour une position " +
    src.position.x + "," + src.position.y);
  verifie("  et le quad est posé dans le repère MONDE",
    !!quad && Math.abs(quad.position.x - (src.position.x + 100)) < 0.5 &&
    Math.abs(quad.position.y - (src.position.y - 100)) < 0.5,
    "quad en " + (quad && quad.position.x) + "," + (quad && quad.position.y) +
    " ; attendu " + (src.position.x + 100) + "," + (src.position.y - 100));
  /* ---------- ET LE GUET NE DOIT RIEN REFAIRE ----------
   *
   * Le défaut le plus coûteux de tout le module, et il n'a duré qu'une version :
   * le guet décidait « rien n'est posé » sur `!paves.length`, le tableau des
   * clones. Vrai tant que la seule voie était le pavage en segments ; faux dès
   * que la grille s'est mise à être PEINTE, puisque le quad vit ailleurs. Il
   * reposait donc tout, toutes les secondes et demie — relecture de quatre mille
   * segments, réajustement de phase, et une recompilation de shader à chaque
   * tour. Mesuré en jeu : treize poses en vingt secondes.
   *
   * Rien ne le disait : le guet appelle la pose directement, sans passer par le
   * module, donc sans écrire une ligne de journal, et le compteur de l'époque
   * comptait les lignes. On compte désormais les POSES, que le pont expose. */
  const posesAvant = pontP.ctx.__vttinkerPoses || 0;
  await attends(3600);   // le guet passe à 1,5 s et à 3 s
  egal("  et le guet ne repose RIEN quand tout va bien",
    (pontP.ctx.__vttinkerPoses || 0) - posesAvant, 0);
  verifie("  le quad d'origine est toujours celui-là",
    rp2.scene.meshes.filter((m) => m.name === "vttk-grille-peinte")[0] === quad,
    "il a été remplacé sans raison");

  /* ---------- LE PINIA NE SE RECHERCHE PLUS À CHAQUE FOIS ----------
   * Le coût était payé sur le chemin de la molette, celui qui retient le
   * navigateur avant qu'il ne compose. Cinquante demandes de pas de zoom ne
   * doivent plus provoquer un seul balayage du document. */
  const docP = pontP.ctx.document;
  // Le premier accès résout le Pinia : c'est celui-là qu'on paie, une fois.
  bp.poste({ ns: "vttinker", depuis: "contenu", type: "zoom-pas", monte: true });
  const balayagesAvant = docP._balayages;
  for (let i = 0; i < 50; i++) {
    bp.poste({ ns: "vttinker", depuis: "contenu", type: "zoom-pas", monte: true });
  }
  egal("cinquante pas de zoom : plus aucun balayage du document",
    docP._balayages - balayagesAvant, 0);

  /* ---------- LA GRILLE S'ABSENTE, PUIS REVIENT ----------
   * Roll20 refait sa scène, change de page, masque sa grille le temps d'un
   * rendu. On détruisait alors le quad ET son matériau, et la pose suivante
   * recompilait le shader — cent millisecondes qui bloquent, toutes les
   * secondes et demie. On RANGE désormais : un quad invisible ne coûte rien, et
   * son shader reste compilé. */
  const sonMaillage = rp2.scene.meshes.filter((m) => /Grid-Line-System/.test(m.name))[0];
  const materiauAvant = quad.material;
  rp2.scene.meshes = rp2.scene.meshes.filter((m) => !/Grid-Line-System/.test(m.name));
  await attends(1900);   // le guet passe
  verifie("grille absente : le quad est rangé, pas détruit",
    rp2.scene.meshes.indexOf(quad) >= 0 && quad.isVisible === false,
    "présent " + (rp2.scene.meshes.indexOf(quad) >= 0) + ", visible " + quad.isVisible);

  rp2.scene.meshes.unshift(sonMaillage);   // elle revient
  await attends(1900);
  verifie("  elle revient : le quad ressort", quad.isVisible === true, "toujours masqué");
  verifie("  et son shader n'a PAS été recompilé", quad.material === materiauAvant,
    "matériau remplacé");

  bp.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });
  egal("  extinction : le quad est retiré",
    rp2.scene.meshes.filter((m) => /^vttk-grille-/.test(m.name)).length, 0);

  /* Et les droites, peintes aussi : deux familles, deux emplacements. */
  const bq = faisBus();
  const rq = faisRoll20(false, true);
  rq.scene.meshes = [rq.scene.faisDroitesDenses("Iso-Grid-Line-System", 25, 40, 900)];
  montePont(bq, rq);
  let rqp = null;
  bq.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rqp = ev.data; } });
  bq.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 30 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);
  verifie("droites peintes : deux familles dans le shader",
    !!rqp && rqp.mode === "peinture" && rqp.forme === "droites" && rqp.droitesPeintes === 2,
    JSON.stringify(rqp));
  const uq = (rq.scene.meshes.filter((m) => m.name === "vttk-grille-peinte")[0] || {}).material;
  egal("  le shader travaille en mode droites", uq && uq.uniformes.mode, 1);
  verifie("  et reçoit l'écart mesuré, pas un autre",
    !!uq && Math.abs(uq.uniformes.familles[2] - 25) < 0.25,
    "familles " + (uq && uq.uniformes.familles));
  bq.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });

  /* ---------- LA PARITÉ, ET C'EST LE CONTRÔLE QUI MANQUAIT ----------
   *
   * Une trame hexagonale à sommet pointu de largeur w est engendrée par (w ; 0)
   * et (w/2 ; w√3/2). Une translation VERTICALE de n rangées n'en est donc une
   * symétrie que si n est PAIR : une rangée sur deux étant décalée d'une demi-
   * largeur, un nombre impair de rangées laisse ce demi-pas en travers.
   *
   * Le pont tirait n de la seule hauteur de page. Ici, w = 20 et une page de
   * 200 donnent 11,547 rangées, dont le calcul naïf tire n = 7 — IMPAIR. Le
   * halo sortait alors décalé d'une demi-largeur d'hexagone dès le premier pixel
   * au-delà du bord, en haut et en bas. Sur trente et une hauteurs de page
   * testées, neuf seulement tombaient juste.
   *
   * On ne vérifie pas la parité — on vérifie ce qui compte : que chaque segment
   * posé appartient bel et bien à la trame infinie. */
  const bh = faisBus();
  const rh = faisRoll20(false);
  rh.scene.meshes = [rh.scene.faisHexagones("Hex-Grid-Line-System", 20, 200, 200)];
  montePont(bh, rh);
  let rhp = null;
  bh.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rhp = ev.data; } });
  bh.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 5 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);

  verifie("trame hexagonale : reconnue comme des cellules",
    !!rhp && rhp.ok === true && rhp.mode === "cellules", JSON.stringify(rhp));
  verifie("  le pas vertical est une symétrie du réseau",
    !!rhp && rhp.motifs && rhp.motifs[1] % 2 === 0,
    "n = " + (rhp && rhp.motifs && rhp.motifs[1]) + " ; le calcul naïf en donne 7, impair" +
    "  — " + JSON.stringify(rhp));

  // La trame infinie, engendrée à part : c'est la référence, et elle ne doit
  // rien au pont.
  const trameHex = (w, rect) => {
    const R = w / Math.sqrt(3), rang = w * Math.sqrt(3) / 2, som = [];
    for (let k = 0; k < 6; k++) {
      const a = (90 + 60 * k) * Math.PI / 180;
      som.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    const cles = new Set();
    const q = (v) => Math.round(v * 100);
    for (let j = Math.floor(-rect.y1 / rang) - 2; j <= Math.ceil(-rect.y0 / rang) + 2; j++) {
      const cy = -j * rang, dec = j % 2 ? w / 2 : 0;
      for (let i = Math.floor((rect.x0 - dec) / w) - 2; i <= Math.ceil((rect.x1 - dec) / w) + 2; i++) {
        const cx = i * w + dec;
        for (let k = 0; k < 6; k++) {
          let [ax, ay] = som[k], [bx, by] = som[(k + 1) % 6];
          ax += cx; ay += cy; bx += cx; by += cy;
          if (bx < ax || (bx === ax && by < ay)) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
          cles.add(q(ax) + "," + q(ay) + "," + q(bx) + "," + q(by));
        }
      }
    }
    return cles;
  };

  const nh = rh.scene.meshes.filter((m) => /^vttk-grille-/.test(m.name))[0];
  let hx0 = Infinity, hx1 = -Infinity, hy0 = Infinity, hy1 = -Infinity;
  for (let v = 0; v < nh._pos.length; v += 3) {
    hx0 = Math.min(hx0, nh._pos[v]); hx1 = Math.max(hx1, nh._pos[v]);
    hy0 = Math.min(hy0, nh._pos[v + 1]); hy1 = Math.max(hy1, nh._pos[v + 1]);
  }
  const trame = trameHex(20, { x0: hx0, y0: hy0, x1: hx1, y1: hy1 });
  const cote = 20 / Math.sqrt(3);
  let horsTrame = 0, juges = 0;
  for (let s = 0; s < nh._idx.length / 2; s++) {
    const a = nh._idx[2 * s] * 3, b = nh._idx[2 * s + 1] * 3;
    let ax = nh._pos[a], ay = nh._pos[a + 1], bx = nh._pos[b], by = nh._pos[b + 1];
    // Les segments coupés au bord de la page ne sont plus des arêtes entières :
    // on ne juge que celles qui le sont restées.
    if (Math.abs(Math.hypot(bx - ax, by - ay) - cote) > 0.01) { continue; }
    if (bx < ax || (bx === ax && by < ay)) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
    juges++;
    const k = Math.round(ax * 100) + "," + Math.round(ay * 100) + "," +
              Math.round(bx * 100) + "," + Math.round(by * 100);
    if (!trame.has(k)) { horsTrame++; }
  }
  verifie("  et il y a des arêtes entières à juger", juges > 200, juges + " jugées");
  egal("  AUCUNE arête posée hors de la trame", horsTrame, 0);
  bh.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });

  bl.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });
  egal("extinction : notre maillage est retiré",
    rl.scene.meshes.filter((m) => /^vttk-grille-/.test(m.name)).length, 0);

  /* ---------- LE CHANGEMENT DE TYPE DE GRILLE ----------
   * Roll20 remplace SON maillage ; nos copies, elles, survivent. Le guet ne
   * surveillait que leur mort : rien ne se déclenchait, et l'ancienne trame
   * restait par-dessus la nouvelle. */
  bl.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 10 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);
  const avant = rl.scene.meshes.filter((m) => /^vttk-grille-/.test(m.name))[0];
  verifie("repavée après rallumage", !!avant);

  // Il change de type : nouveau maillage, l'ancien disparaît. Les nôtres, non.
  rl.scene.meshes = rl.scene.meshes.filter((m) => !/Grid-Line-System/.test(m.name));
  const neuf = rl.scene.faisLignes("Iso-Grid-Line-System");
  rl.scene.meshes.unshift(neuf);
  await attends(1900);   // le guet passe toutes les 1,5 s
  const apres = rl.scene.meshes.filter((m) => /^vttk-grille-/.test(m.name));
  egal("changement de type : un seul maillage à nous, le neuf", apres.length, 1);
  verifie("  et c'est bien un AUTRE que celui d'avant", apres[0] !== avant,
    "le guet n'a pas vu que Roll20 avait remplacé sa grille");
  bl.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: false });

  // Sans grille dans la scène, on le dit au lieu d'échouer en silence.
  const vide = faisRoll20(false);
  vide.scene.meshes = [];
  const bus2 = faisBus();
  montePont(bus2, vide);
  let rep2 = null;
  bus2.ecoute(null, (ev) => { if (ev.data && ev.data.type === "grille-resultat") { rep2 = ev.data; } });
  bus2.poste({ ns: "vttinker", depuis: "contenu", type: "grille", actif: true, cases: 60 });
  // La pose est ETRANGLEE de 250 ms : on la laisse venir.
  await attends(350);
  verifie("pas de grille dans la scène : le pont le DIT",
    !!rep2 && rep2.ok === false && rep2.raison === "grille-absente", JSON.stringify(rep2));
}

/* ============================================================
 * 4 ter. LES MARQUEURS PERSONNALISÉS — ce qu'on accepte, et ce qu'on refuse
 * ============================================================
 *
 * L'analyse du collage est du calcul pur : elle s'éprouve sans navigateur, sans
 * scène et sans DOM. C'est aussi le seul endroit où l'on décide ce qui entre
 * dans les données de la campagne — une étiquette mal formée y resterait. */
function essaiMarqueurs() {
  titre("4 ter. Les marqueurs personnalisés : le collage");

  const ctx = { console, JSON, Math, Object, Array, String, Number, Boolean, isFinite, parseInt };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(lis("commun/langue.js"), ctx, { filename: "langue.js" });
  vm.runInContext(lis("commun/marqueurs.js"), ctx, { filename: "marqueurs.js" });

  const un = (t, existants) => ctx.vttMarqueursDepuisTexte(t, existants || []);

  /* LE CAS PRINCIPAL, et il a failli être refusé : une URL d'emote Discord n'a
   * pour nom de fichier qu'un identifiant. Le premier jet la rejetait — donc
   * rejetait l'usage même pour lequel le module existe. */
  const disc = un("https://cdn.discordapp.com/emojis/1234567890123.webp?size=96");
  egal("une URL Discord est acceptée", disc.retenus.length, 1);
  /* ---------- L'ÉTIQUETTE PORTE L'ADRESSE ----------
   *
   * C'est le changement qui a supprimé tout le catalogue partagé. L'ancienne
   * forme (« vttk_poison_exemple.org/skull.png ») ne disait que le nom : pour savoir quelle image
   * dessiner, il fallait un document de campagne à créer, fusionner, faire
   * converger — et que seul un MJ pouvait écrire. Celle-ci se suffit à
   * elle-même : n'importe quel joueur ayant l'extension voit le marqueur, sans
   * rien avoir reçu de personne.
   *
   * Le schéma est retiré parce qu'il est toujours le même — seul https est
   * accepté —, ce qui économise huit caractères par marqueur. */
  egal("  et son étiquette porte l'adresse, pas seulement le nom",
    disc.retenus[0] && disc.retenus[0].tag,
    "vttk_e1234567890123_cdn.discordapp.com/emojis/1234567890123.webp?size=96");
  /* STABLE : l'étiquette part dans les données de la campagne. Si recoller la
   * même image en donnait une autre, les poses déjà faites deviendraient
   * muettes. */
  egal("  recoller la même adresse redonne la MÊME étiquette",
    un("https://cdn.discordapp.com/emojis/1234567890123.webp?size=96").retenus[0].tag,
    "vttk_e1234567890123_cdn.discordapp.com/emojis/1234567890123.webp?size=96");

  /* ET ELLE SE RELIT. Une étiquette qu'on ne saurait pas relire ne dessinerait
   * rien chez personne — c'est tout l'objet du format. */
  const relueDisc = ctx.vttMarqueurDepuisEtiquette(disc.retenus[0].tag);
  verifie("  et elle se relit", !!relueDisc, JSON.stringify(relueDisc));
  egal("    l'adresse en ressort entière", relueDisc && relueDisc.url,
    "https://cdn.discordapp.com/emojis/1234567890123.webp?size=96");
  egal("    et le nom aussi", relueDisc && relueDisc.nom, "e1234567890123");

  const nomme = un("Poison | https://exemple.org/skull.png");
  egal("« Nom | url » nomme le marqueur", nomme.retenus[0] && nomme.retenus[0].nom, "Poison");
  egal("  et l'étiquette porte le préfixe et l'adresse",
    nomme.retenus[0] && nomme.retenus[0].tag, "vttk_poison_exemple.org/skull.png");

  /* CE QU'ON REFUSE, ET POURQUOI ON LE DIT. Un formulaire qui avale une ligne
   * sans un mot est un formulaire qui ment. */
  const mauvais = un("http://exemple.org/x.png\ndata:image/png;base64,AA\nnimportequoi\n");
  egal("trois lignes fautives, trois refus", mauvais.rejets.length, 3);
  egal("  aucune n'est retenue", mauvais.retenus.length, 0);
  verifie("  et chacune dit pourquoi",
    mauvais.rejets.every((r) => r.raison && r.raison.length > 10),
    JSON.stringify(mauvais.rejets));
  verifie("  http est refusé pour lui-même", /https/.test(mauvais.rejets[0].raison),
    mauvais.rejets[0].raison);

  /* DEUX IMAGES DIFFÉRENTES DE MÊME NOM SE DISTINGUENT D'ELLES-MÊMES, puisque
   * l'étiquette porte l'adresse. Il n'y a plus rien à numéroter — l'ancienne
   * forme devait le faire, celle-ci non. */
  const deux = un("Feu | https://a.org/1.png\nFeu | https://a.org/2.png");
  egal("deux images de même nom donnent deux étiquettes distinctes",
    deux.retenus.map((j) => j.tag).join(","),
    "vttk_feu_a.org/1.png,vttk_feu_a.org/2.png");
  /* Et recoller EXACTEMENT la même ligne ne crée pas de doublon : elle retombe
   * sur le même marqueur, ce qui vaut mieux qu'une numérotation qui multiplierait
   * des marqueurs identiques. */
  const dejaLa = un("Feu | https://a.org/1.png",
    [{ tag: "vttk_feu_a.org/1.png", nom: "Feu", url: "https://a.org/1.png" }]);
  egal("  et recoller la même n'en ajoute pas une seconde", dejaLa.retenus.length, 0);

  /* NI VIRGULE NI AROBASE, et c'est maintenant vital : l'adresse voyage DANS
   * l'étiquette, et Roll20 découpe ce champ sur les virgules et coupe après
   * « @ » pour y lire un compteur. Une adresse qui en porterait couperait
   * l'étiquette en deux et fabriquerait des marqueurs fantômes. */
  const sale = un("Feu, ardent @ tout | https://a.org/x.png");
  verifie("une étiquette ne porte ni virgule ni arobase",
    !!sale.retenus[0] && !/[,@]/.test(sale.retenus[0].tag), sale.retenus[0] && sale.retenus[0].tag);
  egal("  une ADRESSE qui en porte est refusée",
    un("Feu | https://a.org/x,y.png").retenus.length, 0);
  egal("  l'arobase aussi", un("Feu | https://a.org/x@2.png").retenus.length, 0);
  egal("  et le nom perd ses accents",
    ctx.vttMarqueurEtiquette("Épée brûlée", "https://a.org/e.png"),
    "vttk_epee-brulee_a.org/e.png");

  /* Une adresse trop longue est refusée : l'étiquette entière part dans les
   * données de la campagne, plusieurs fois par token. */
  egal("une adresse démesurée est refusée",
    un("Long | https://a.org/" + new Array(240).join("x") + ".png").retenus.length, 0);

  // Ce qui SORT du stockage est relu, jamais cru sur parole.
  const relu = ctx.vttMarqueursPropres([
    { tag: "vttk_ok_a.org/1.png", nom: "ok", url: "https://a.org/1.png" },
    { tag: "sans-prefixe", nom: "x", url: "https://a.org/2.png" },
    { tag: "vttk_mauvaise_a.org/2.png", nom: "x", url: "javascript:alert(1)" },
    /* Une étiquette du bon préfixe mais ILLISIBLE — pas de séparateur de nom :
     * elle ne dessinerait rien chez personne, donc elle ne doit pas entrer. */
    { tag: "vttk_sanssepararateur", nom: "x", url: "https://a.org/4.png" },
    { tag: "vttk_ok_a.org/1.png", nom: "doublon", url: "https://a.org/3.png" },
    /* L'ANCIENNE FORME (« vt-<nom> ») N'EST PLUS LUE, et c'est délibéré : elle ne
     * disait que le nom, donc elle exigeait un catalogue partagé pour savoir quoi
     * dessiner. L'extension n'ayant jamais eu d'utilisateur hors de son auteur,
     * il n'y avait rien à ménager — et deux formats, c'est deux chemins à tenir
     * d'accord pour rien. Une telle étiquette est désormais un marqueur inconnu,
     * que ni Roll20 ni nous ne dessinons. */
    { tag: "vt-ancien", nom: "ancien", url: "https://a.org/5.png" },
    null
  ]);
  egal("une liste relue du stockage est nettoyée", relu.length, 1);
  egal("  et c'est la bonne qui reste", relu[0].tag, "vttk_ok_a.org/1.png");
  egal("  l'ancienne forme n'est plus lue",
    ctx.vttMarqueurDepuisEtiquette("vt-ancien"), null);
}

/* ============================================================
 * 4 quater. LES MARQUEURS DESSINÉS DANS LA SCÈNE
 * ============================================================
 *
 * TOUTE LA GÉOMÉTRIE VÉRIFIÉE ICI A ÉTÉ MESURÉE SUR UNE VRAIE PARTIE, et les
 * nombres sont recopiés de ce relevé — ce ne sont pas des valeurs choisies pour
 * que le code passe :
 *
 *   Roll20 tient, par token, un nœud « <id>-markers » posé sur le coin
 *   haut-droit du token. Sous ce nœud, chaque pictogramme est un quad de 19
 *   unités de côté, centré en y = -12,5 et en x = -12,5 pour le DERNIER, avec
 *   un pas de 22 vers la gauche. La rangée est donc alignée à droite, et ni la
 *   taille ni le pas ne dépendent de la taille du token — mesuré sur 70 comme
 *   sur 140 — ni du zoom.
 *
 * Les nôtres continuent cette rangée vers la gauche. D'où la formule, qui est
 * exactement ce que ces contrôles surveillent :
 *
 *     x = -12,5 - (nombre de pictogrammes de Roll20 + rang) × 22
 *
 * Un décompte faux des SIENS ferait chevaucher les nôtres sur les siens, et
 * c'est le genre de défaut qu'on ne voit pas sans un token qui porte les deux.
 * Tous les cas ci-dessous en portent donc au moins un. */
async function essaiMarqueursDessin() {
  titre("4 quater. Les marqueurs dessinés dans la scène");

  const bus = faisBus();
  const r20 = faisRoll20(false, true);
  const pont = montePont(bus, r20);
  /* Deux tokens : un gros qui portera un pictogramme de Roll20 ET les nôtres,
   * un petit qui n'en portera aucun. Leurs coins sont ceux qu'on a mesurés. */
  pont.ctx.Campaign = faisCampagne(r20.scene, [
    { id: "T1", left: 700, top: 910, width: 140, height: 140, statusmarkers: "skull" },
    { id: "T2", left: 945, top: 875, width: 70, height: 70, statusmarkers: "" }
  ]);
  const col = pont.ctx.Campaign._col;
  const t1 = col.get("T1"), t2 = col.get("T2");

  let rj = null;
  /* CE QUE LE PONT DEMANDE AU SCRIPT DE CONTENU. Il ne peut rien écrire lui-même
   * — il vit dans la page, sans stockage ni modèle —, donc tout ce qu'il veut
   * changer passe par un message. Les retenir tous est le seul moyen d'éprouver
   * l'ajout, la suppression et le tri sans monter les deux mondes à la fois. */
  const versContenu = [];
  bus.ecoute(null, (ev) => {
    if (!ev.data || ev.data.depuis !== "page") { return; }
    versContenu.push(ev.data);
    if (ev.data.type === "marqueurs-resultat") { rj = ev.data; }
  });

  const PALETTE = [
    { tag: "vttk_a_exemple.org/a.png", nom: "A", url: "https://exemple.org/a.png" },
    { tag: "vttk_b_exemple.org/b.png", nom: "B", url: "https://exemple.org/b.png" }
  ];
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE });

  const nos = () => r20.scene.meshes.filter((m) => /^vttk-marqueur-/.test(m.name));
  verifie("le pont accepte la palette", !!rj && rj.ok === true, JSON.stringify(rj));
  egal("  et il connaît deux étiquettes", rj && rj.etiquettes, 2);
  egal("  personne ne les porte encore : aucun quad", nos().length, 0);

  /* ---------- LA POSE, ET SON ARITHMÉTIQUE ---------- */
  t1.save({ statusmarkers: "skull,vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png" });
  const q1 = nos();
  egal("un token qui porte deux des nôtres reçoit deux quads", q1.length, 2);
  const parNom = (n) => q1.filter((m) => m.name === "vttk-marqueur-" + n)[0];
  verifie("  chacun est accroché au nœud de Roll20, pas à la scène",
    q1.every((m) => m.parent && m.parent.name === "T1-markers"),
    q1.map((m) => m.parent && m.parent.name).join(" / "));
  /* ---------- LA CAPACITÉ D'UNE LIGNE : CE QUI TIENT, PAS CE QU'IL A ----------
   *
   * LA RÈGLE A CHANGÉ ICI, ET IL FAUT DIRE POURQUOI. Elle disait : « notre ligne
   * porte autant de cases que la sienne en porte à cet instant » — donc son
   * NOMBRE de marqueurs. Elle vient d'un cas réel où elle était juste : onze des
   * siens tiennent dans un token de 140 alors que le calcul n'en compte que dix,
   * et notre douzième case partait de travers.
   *
   * Mais son compte ne mesure la capacité QUE lorsqu'il a rapetissé, c'est-à-dire
   * lorsque sa rangée est pleine. Tant qu'il est à taille pleine, il ne mesure
   * rien du tout — et la règle donnait alors des résultats absurdes : avec UN
   * seul marqueur à lui, notre ligne portait UNE case, et nos marqueurs
   * descendaient en colonne le long du bord droit. Sur un token de 70, le
   * quatrième sortait par le bas.
   *
   * Le banc le montrait sans qu'on le voie : trois lignes plus bas, « dead » —
   * qui n'occupe aucune case — laissait notre marqueur en HAUT, tandis que
   * « skull » le faisait descendre de deux lignes. Ajouter un marqueur à Roll20
   * déplaçait les nôtres du coin haut-droit vers une colonne verticale.
   *
   * La loi est donc le PLUS GRAND des deux : ce qu'il a dessiné, et ce qui tient
   * à l'échelle courante. Quand il a rapetissé, son compte l'emporte — le cas qui
   * avait motivé la règle est préservé. Quand il est à taille pleine, c'est le
   * calcul qui vaut.
   *
   * Ici : un marqueur à lui, six cases par ligne dans 140. Les nôtres continuent
   * SA rangée vers la gauche, sur la même ligne. */
  egal("  le dernier des nôtres se colle au sien",
    parNom("vttk_b_exemple.org/b.png") && parNom("vttk_b_exemple.org/b.png").position.x, -34.5);
  egal("    sur SA ligne, puisqu'elle n'est pas pleine",
    parNom("vttk_b_exemple.org/b.png") && parNom("vttk_b_exemple.org/b.png").position.y, -12.5);
  egal("  et l'autre le suit d'un pas",
    parNom("vttk_a_exemple.org/a.png") && parNom("vttk_a_exemple.org/a.png").position.x, -56.5);
  egal("    à la même hauteur",
    parNom("vttk_a_exemple.org/a.png") && parNom("vttk_a_exemple.org/a.png").position.y, -12.5);
  verifie("  aucun ne tombe sous le token", q1.every((m) => m.position.y > -140),
    q1.map((m) => m.position.y).join(", "));
  verifie("  et à la taille de Roll20 : dix-neuf unités",
    q1.every((m) => m.scaling.x === 19 && m.scaling.y === 19),
    q1.map((m) => m.scaling.x).join(" / "));

  /* LE DÉCOMPTE DES SIENS EST CE QUI ÉVITE LE CHEVAUCHEMENT. On lui en ajoute
   * un second : les nôtres doivent RECULER d'un pas, tous les deux. */
  t1.save({ statusmarkers: "skull,sleepy,vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png" });
  egal("un pictogramme de plus chez lui, et les nôtres reculent d'un pas",
    nos().filter((m) => m.name === "vttk-marqueur-vttk_b_exemple.org/b.png")[0].position.x, -56.5);
  egal("  tous les deux",
    nos().filter((m) => m.name === "vttk-marqueur-vttk_a_exemple.org/a.png")[0].position.x, -78.5);
  egal("    sans quitter sa ligne",
    nos().filter((m) => m.name === "vttk-marqueur-vttk_b_exemple.org/b.png")[0].position.y, -12.5);

  /* ---------- QUI OCCUPE UNE CASE, ET QUI N'EN OCCUPE PAS ----------
   *
   * Le décompte des siens décide du décalage des nôtres : une erreur ici les
   * fait CHEVAUCHER. Deux cas ne se devinaient pas, et tous deux ont été mesurés
   * sur une vraie partie :
   *
   *   · LES PASTILLES DE COULEUR occupent une case — « red » en -34,5, « blue »
   *     en -12,5 — alors qu'elles ne sont dans AUCUN catalogue. Ne pas les
   *     compter posait notre marqueur PAR-DESSUS la dernière.
   *   · « dead » n'en occupe AUCUNE : il barre le token sur toute sa surface.
   *     Le compter laissait une case vide.
   *
   * Les deux erreurs se compensaient quand un token portait une pastille ET un
   * « dead » — d'où un défaut qui n'apparaissait qu'« à certains moments », et
   * que seul un banc qui éprouve les deux séparément peut tenir. */
  t1.save({ statusmarkers: "red,vttk_a_exemple.org/a.png" });
  const seul = () => nos().filter((m) => m.name === "vttk-marqueur-vttk_a_exemple.org/a.png")[0];
  egal("une PASTILLE occupe une case de SA rangée, comme un pictogramme",
    seul().position.x, -34.5);
  egal("  donc le nôtre se pose à côté, pas dessus", seul().position.y, -12.5);
  t1.save({ statusmarkers: "dead,vttk_a_exemple.org/a.png" });
  /* « dead » n'occupe aucune case : sa rangée reste VIDE, et le nôtre prend la
   * première — celle que Roll20 aurait prise. */
  egal("« dead » n'occupe AUCUNE case : il barre tout le token",
    seul().position.x, -12.5);
  egal("  et le nôtre prend la première case", seul().position.y, -12.5);

  /* ---------- LA RANGÉE RÉTRÉCIT POUR RESTER DANS LE TOKEN ----------
   *
   * Roll20 rapetisse ses marqueurs dès que la rangée dépasserait la largeur du
   * token ; les nôtres ne le faisaient pas et sortaient du cadre. Sa loi a été
   * relevée échelle par échelle, de 1 à 14 marqueurs, sur un token de 140 puis
   * de 70, et elle se modélise à moins de 1 % près :
   *
   *     échelle = (largeur du token − 1,5) / (22 × nombre)
   *
   * MAIS IL NE COMPTE QUE CE QU'IL DESSINE : mesuré, ajouter cinq marqueurs à
   * nous ne change PAS son échelle. Le calcul porte donc sur la place qu'il
   * LAISSE, pas sur le total — un total ferait déborder, ses cases à lui ne
   * rétrécissant pas. */
  const PALETTE5 = [1, 2, 3, 4, 5].map((i) => ({
    tag: "vttk_p" + i + "_a.org/" + i + ".png", nom: "P" + i, url: "https://a.org/" + i + ".png"
  }));
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE5 });
  t1.save({ statusmarkers: "" });
  t2.save({ statusmarkers: PALETTE5.map((j) => j.tag).join(",") });

  /* SUR UN TOKEN DE 70, TROIS CASES TIENNENT PAR LIGNE : (70 − 1,5) / 22 = 3,11.
   * Cinq marqueurs occupent donc deux lignes — et gardent leur TAILLE PLEINE. On
   * ne rapetisse pas pour faire tenir : ce qui est déjà petit deviendrait
   * illisible. */
  const surPetit = nos().filter((m) => m.parent && m.parent.name === "T2-markers");
  egal("cinq marqueurs sur un token de 70 : cinq quads", surPetit.length, 5);
  verifie("  ils gardent la taille des siens, sans rapetisser",
    surPetit.every((m) => m.scaling.x === 19),
    surPetit.map((m) => m.scaling.x).join(", "));
  const lignes = {};
  surPetit.forEach((m) => { lignes[m.position.y] = (lignes[m.position.y] || 0) + 1; });
  egal("  ils se répartissent sur DEUX lignes", Object.keys(lignes).length, 2);
  egal("    trois sur la première", lignes[-12.5], 3);
  egal("    et deux sur la seconde", lignes[-34.5], 2);
  /* ET ILS RESTENT DANS LA LARGEUR DU TOKEN : c'était tout le défaut. */
  const bordG = Math.min.apply(null, surPetit.map((m) => m.position.x - m.scaling.x / 2));
  verifie("  et aucun ne sort par le côté", bordG >= -70,
    "bord gauche " + bordG.toFixed(2) + " pour un token de 70");

  /* Deux marqueurs sur un token de 140 tiennent large : rien ne change, et les
   * positions doivent rester EXACTEMENT celles d'avant. */
  t1.save({ statusmarkers: PALETTE5.slice(0, 2).map((j) => j.tag).join(",") });
  const surGros = nos().filter((m) => m.parent && m.parent.name === "T1-markers");
  egal("deux marqueurs sur un token de 140 : taille pleine", surGros[0].scaling.x, 19);
  egal("  et les positions ne bougent pas d'un pouce",
    surGros.map((m) => m.position.x).sort((a, b) => a - b).join(","), "-34.5,-12.5");
  verifie("  tous sur la première ligne", surGros.every((m) => m.position.y === -12.5));

  /* ---------- LA LIGNE SE REMPLIT, PUIS ELLE DÉBORDE ----------
   *
   * ROLL20 N'A PAS DE LIGNES : il n'en connaît qu'une, et il rapetisse jusqu'à
   * tout y faire tenir. Le passage à la ligne est de notre côté, parce qu'on
   * refuse de rapetisser davantage.
   *
   * Sur un token de 140 à taille pleine, six cases tiennent. Trois sont à lui :
   * il en reste trois pour nous sur la première ligne, et le quatrième passe
   * dessous. C'est le seuil exact, et c'est ce qui se vérifie ici. */
  t1.save({ statusmarkers: "skull,sleepy,half-heart," +
    PALETTE5.slice(0, 4).map((j) => j.tag).join(",") });
  const apresTrois = nos().filter((m) => m.parent && m.parent.name === "T1-markers");
  egal("trois des siens, quatre à nous : la ligne de six déborde", apresTrois.length, 4);
  const parRang = {};
  apresTrois.forEach((m) => { parRang[m.position.y] = (parRang[m.position.y] || 0) + 1; });
  egal("  trois des nôtres finissent SA ligne", parRang[-12.5], 3);
  egal("  et le quatrième ouvre celle du dessous", parRang[-34.5], 1);
  /* ET AUCUN NE SORT PAR LA GAUCHE : c'est la raison d'être du passage à la
   * ligne. La sixième case tombe à -122,5, son bord gauche à -132 — dans les
   * 140 du token. Une septième serait à -144,5, dehors. */
  const gauche = Math.min.apply(null, apresTrois.map((m) => m.position.x - m.scaling.x / 2));
  verifie("  et aucun ne sort du token par la gauche", gauche >= -140,
    "bord gauche " + gauche.toFixed(2) + " pour un token de 140");

  /* ---------- ET QUAND ROLL20 RAPETISSE ----------
   *
   * LE CAS QUE LE BANC NE VOYAIT PAS, et c'est celui qui a cassé. Tous ses
   * tokens de modèle portaient peu de marqueurs, donc Roll20 restait à taille
   * pleine, donc l'échelle valait 1 partout — et une marge traitée comme FIXE
   * (1,5) donnait le bon résultat par accident. Dès qu'il rapetissait, notre
   * premier centre tombait à -1,5 - 11×échelle au lieu de -12,5×échelle.
   *
   * Sa loi est simple, une fois vue : LA RANGÉE ENTIÈRE EST LA RANGÉE À TAILLE
   * PLEINE, MULTIPLIÉE PAR L'ÉCHELLE — marge comprise.
   *
   * On donne donc au modèle un marqueur de Roll20 DÉJÀ RAPETISSÉ, et on regarde
   * si les nôtres s'alignent dessus. */
  const noeudT1 = r20.scene.getTransformNodeByName("T1-markers");
  const sien = { name: "skull", position: { x: -8.75, y: -8.75, z: 0 },
                 scaling: { x: 0.7, y: 0.7 }, parent: noeudT1,
                 isEnabled: () => true };
  noeudT1._enfants.push(sien);
  t1.save({ statusmarkers: "skull," + PALETTE5[0].tag });
  const aligne = nos().filter((m) => m.parent === noeudT1);
  egal("quand Roll20 rapetisse, on lit SON échelle", aligne.length && aligne[0].scaling.x, 19 * 0.7);
  /* Sa case est en -8,75 = -12,5 × 0,7. La nôtre est la suivante SUR LA MÊME
   * LIGNE, à un pas de 22 × 0,7 vers la gauche. C'est la vérification qui
   * compte : tout suit l'échelle, la marge du bord comprise — c'est là que le
   * premier jet se trompait, en traitant la marge de 1,5 comme fixe. */
  proche("  et on se pose sur SA grille, pas sur une autre",
    aligne[0].position.x, -8.75 - 22 * 0.7, 0.01);
  proche("    à la même hauteur que la sienne", aligne[0].position.y, -8.75, 0.01);
  noeudT1._enfants.pop();

  t1.save({ statusmarkers: "" });
  t2.save({ statusmarkers: "" });
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE });

  /* Une étiquette que PERSONNE ne connaît — ni Roll20, ni nous — ne doit
   * décaler personne : elle ne dessine rien, donc elle n'occupe pas de place. */
  t1.save({ statusmarkers: "skull,inconnue-d-ailleurs,vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png" });
  egal("une étiquette étrangère ne décale rien",
    nos().filter((m) => m.name === "vttk-marqueur-vttk_b_exemple.org/b.png")[0].position.x, -34.5);
  egal("  et n'occupe aucune case",
    nos().filter((m) => m.name === "vttk-marqueur-vttk_a_exemple.org/a.png")[0].position.x, -56.5);

  /* ---------- CE QUI SE PASSE QUAND ON RETIRE ---------- */
  t1.save({ statusmarkers: "skull,vttk_a_exemple.org/a.png" });
  egal("retirer une étiquette retire son quad", nos().length, 1);
  t1.save({ statusmarkers: "skull" });
  egal("  et les retirer toutes n'en laisse aucun", nos().length, 0);

  /* ---------- UN AUTRE TOKEN, ET SON PROPRE NŒUD ---------- */
  t2.save({ statusmarkers: "vttk_a_exemple.org/a.png" });
  const q2 = nos();
  egal("un second token reçoit le sien", q2.length, 1);
  egal("  accroché à SON nœud", q2[0].parent && q2[0].parent.name, "T2-markers");
  egal("  et sans pictogramme de Roll20 devant, il est le premier",
    q2[0].position.x, -12.5);

  /* ---------- LE MATÉRIAU EST PARTAGÉ, ET C'EST TOUT LE PROPOS ----------
   *
   * Recréer un matériau, c'est recompiler un programme GLSL. La leçon a été
   * payée sur la grille, où sept poses en quatre secondes recompilaient sept
   * fois le même shader et bloquaient l'affichage. Deux tokens portant la même
   * image doivent donc partager le MÊME matériau, et la même texture. */
  t1.save({ statusmarkers: "vttk_a_exemple.org/a.png" });
  const deux = nos();
  egal("deux tokens portent le même marqueur", deux.length, 2);
  verifie("  et se partagent un seul matériau",
    deux[0].material && deux[0].material === deux[1].material,
    "matériaux " + (deux[0].material === deux[1].material ? "identiques" : "distincts"));
  verifie("  qui ne porte qu'une texture, à la bonne adresse",
    !!deux[0].material && deux[0].material.textures.image &&
    deux[0].material.textures.image.url === "https://exemple.org/a.png",
    JSON.stringify(deux[0].material && Object.keys(deux[0].material.textures)));

  /* ---------- CE QUE ROLL20 POSE SUR SES QUADS, ON LE POSE AUSSI ----------
   * Relevé un par un sur les siens : hors de portée du clic, toujours tenu pour
   * actif, dessiné en dernier parmi les transparents. */
  verifie("nos quads ne s'attrapent pas au clic", deux.every((m) => m.isPickable === false));
  verifie("  ils ne repassent pas par le tronc de vue",
    deux.every((m) => m.alwaysSelectAsActiveMesh === true));
  verifie("  et ils se dessinent après les autres transparents",
    deux.every((m) => m.alphaIndex === Number.MAX_VALUE),
    deux.map((m) => m.alphaIndex).join(" / "));

  /* ---------- DEVANT LE TOKEN, ET PAS À SA HAUTEUR ----------
   *
   * Roll20 pose les siens à z = 0 sous le nœud, donc à la profondeur EXACTE du
   * token, et s'en tire par un `zOffset` sur son matériau. Les nôtres, à la même
   * profondeur mais sans cette ruse, passaient DERRIÈRE l'image du token — et
   * comme la rangée est à l'intérieur du token, ils y disparaissaient. Un
   * utilisateur l'a vu ; le banc, lui, ne regardait que x et y.
   *
   * La caméra est en z = 0 et regarde vers les z croissants : plus petit veut
   * dire plus près. Et l'avance doit rester bien en deçà des cinq cents unités
   * qui séparent deux tokens, sans quoi nos marqueurs passeraient devant un token
   * posé PAR-DESSUS le leur. */
  verifie("nos quads passent DEVANT l'image du token",
    deux.every((m) => m.position.z < 0),
    deux.map((m) => m.position.z).join(" / "));
  verifie("  mais sans sortir du créneau du token (500 unités)",
    deux.every((m) => m.position.z > -250),
    deux.map((m) => m.position.z).join(" / "));

  /* ---------- L'ORIENTATION SE RÈGLE SUR LA TEXTURE ----------
   *
   * Une image a son origine en haut à gauche, une texture WebGL en bas à
   * gauche : sans `invertY`, elle sort à l'envers. Le premier jet passait
   * `false` ET retournait l'UV en x dans le nuanceur, sur la foi d'une
   * comparaison faite avec un éclair en Z — qui a une symétrie de DEMI-TOUR, et
   * pour lequel miroir horizontal et miroir vertical rendent la même image. Les
   * deux fautes se composaient en demi-tour : marqueur à l'envers. */
  const texture = deux[0].material.textures.image;
  egal("la texture est retournée en Y, comme toute image", texture.inverseY, true);
  verifie("  et le nuanceur ne retourne rien de plus",
    !/1\.0\s*-\s*uv\.x/.test(deux[0].material.sources.vertexSource),
    deux[0].material.sources.vertexSource.split("\n").filter((l) => /vUV/.test(l)).join(" | "));
  /* PAS de matrice gelée : c'est en la recalculant depuis son parent que le
   * quad suit le token. Un contrôle à l'envers de celui de la grille, où geler
   * est justement ce qu'on veut. */
  verifie("  leur matrice n'est PAS gelée : c'est ainsi qu'ils suivent le token",
    deux.every((m) => !m._gele));

  /* ---------- LA GREFFE DANS SA COLONNE D'OUTILS ----------
   *
   * ON N'AJOUTE PAS UN CADRE, ON ENTRE DANS LE SIEN. Le premier jet posait une
   * barre flottante en bas à gauche : elle marchait, mais c'était une pièce
   * rapportée de plus. On clone donc un de ses boutons, exactement comme la
   * commande de zoom entre dans sa colonne de zoom.
   *
   * Et on vérifie qu'on clone un bouton QUI SE VOIT : chez Roll20 le dernier de
   * la colonne est celui du débordement, masqué, et le cloner donnait un bouton
   * de taille nulle — invisible à l'écran, mais bien présent dans les relevés.
   * C'est le genre de défaut qu'un banc sans géométrie ne peut pas voir. */
  const docPont = pont.ctx.document;
  /* On vise le bouton PAR SA MARQUE : la section en porte deux — les marqueurs et
   * les réglages —, et « le premier .vttk-outil » donnerait l'un ou l'autre selon
   * l'ordre de création. */
  const outil = docPont.body.querySelector(".vttk-outil-marqueurs");
  verifie("notre bouton est greffé dans sa colonne d'outils", !!outil);
  verifie("  et il est bien DANS .upper-buttons",
    !!outil && outil.parentNode === docPont.body.querySelector(".upper-buttons"));
  verifie("  il garde les classes de Roll20",
    !!outil && /toolbar-button-outer/.test(outil.className), outil && outil.className);
  verifie("  et on a cloné un bouton QUI SE VOIT, pas celui du débordement",
    !!outil && outil.getBoundingClientRect().height > 4,
    outil && JSON.stringify(outil.getBoundingClientRect()));
  /* UN SOURIRE, ET IL EST DESSINÉ. Sa police d'icônes n'a NI « smiley », NI
   * « smile », NI « faceSmile », NI « emoji », NI « emote », NI « sticker » —
   * tous rendus en toutes lettres, mesuré en comparant la largeur rendue à celle
   * d'un glyphe connu. Il n'y a donc rien à lui emprunter pour ça.
   *
   * Le span d'icône reste — c'est de lui que viennent la taille et la couleur —
   * mais il porte notre tracé au lieu d'un nom. */
  const ico = outil && outil.querySelector(".grimoire__roll20-icon");
  verifie("  il garde le span d'icône de Roll20", !!ico);
  verifie("    mais porte un sourire DESSINÉ, faute de glyphe dans sa police",
    !!ico && !!ico.querySelector("svg"));
  /* À `currentColor` : c'est ce qui le fait suivre son thème sans qu'on ait à le
   * connaître. Et PLEIN, comme ses icônes à lui — un tracé au trait pesait
   * visiblement moins qu'elles dans la colonne. */
  verifie("    à currentColor, pour suivre son thème",
    !!ico && ico.querySelector("svg") &&
    ico.querySelector("svg").getAttribute("fill") === "currentColor");
  verifie("    plein, comme ses icônes, les yeux évidés par evenodd",
    !!ico && ico.querySelector("svg") &&
    ico.querySelector("svg").getAttribute("fill-rule") === "evenodd");
  egal("    et aucun nom de glyphe qui sortirait en toutes lettres",
    ico ? String(ico.textContent).trim() : "?", "");

  /* ---------- ET IL A SA PROPRE SECTION ----------
   *
   * Sa colonne est découpée en groupes — « Outils », « Effets » — ouverts par un
   * intitulé. Le nôtre s'appelle VTTK et s'ouvre de la même façon : on clone un
   * des siens, filet et casse compris.
   *
   * Il faut cloner un séparateur QUI PORTE UN MOT : la colonne en contient aussi
   * des nus, et cloner celui-là donnerait un filet sans titre. */
  /* `intitule` et non `titre` : ce dernier est la fonction qui annonce les
   * sections du banc, et la masquer ici tuait tout le fichier à l'exécution. */
  const intitule = docPont.body.querySelector(".vttk-outil-titre");
  verifie("notre section a son intitulé", !!intitule);
  egal("  et il dit VTTK",
    intitule && intitule.querySelector(".spacer-header")
      ? intitule.querySelector(".spacer-header").textContent : null, "VTTK");
  verifie("  cloné d'un des siens, filet compris",
    !!intitule && /spacer-outer/.test(intitule.className) && !!intitule.querySelector(".spacer-inner"),
    intitule && intitule.className);
  verifie("  et il n'emporte pas son identifiant", !!intitule && !intitule.getAttribute("id"));

  /* L'ORDRE COMPTE : l'intitulé ouvre la section, donc il précède le bouton. Et
   * les deux passent AVANT son bouton de débordement, qui est le dernier de la
   * colonne et reste masqué tant qu'elle tient en hauteur — se poser après lui
   * marcherait aujourd'hui et se verrait le jour où il apparaît. */
  const rang = Array.prototype.indexOf;
  const kids = docPont.body.querySelector(".upper-buttons").children;
  const iTitre = rang.call(kids, intitule), iOutil = rang.call(kids, outil);
  const iReg = rang.call(kids, docPont.body.querySelector(".vttk-outil-reglages"));
  /* LA SECTION EN CONTIENT DEUX : les réglages et les marqueurs. L'intitulé les
   * ouvre tous les deux, et rien ne s'intercale — sans quoi un outil de Roll20
   * se retrouverait rangé sous VTTK. */
  verifie("  l'intitulé ouvre la section", iTitre >= 0 && iTitre < iReg && iTitre < iOutil,
    "intitulé " + iTitre + ", réglages " + iReg + ", marqueurs " + iOutil);
  verifie("  et ses deux boutons se suivent sans rien entre eux",
    Math.abs(iReg - iOutil) === 1 && Math.min(iReg, iOutil) === iTitre + 1,
    "intitulé " + iTitre + ", réglages " + iReg + ", marqueurs " + iOutil);
  /* LE ROUAGE AU-DESSUS, TOUJOURS. L'ordre était celui de la CRÉATION : le
   * bouton des réglages se pose depuis un guet au chargement du pont, celui des
   * marqueurs quand le module s'installe, et lequel arrive d'abord dépend du moment
   * où sa colonne est peinte. On voyait donc l'étoile au-dessus du rouage une
   * fois sur deux. Chaque pièce porte désormais un RANG. */
  verifie("  le rouage est AU-DESSUS des marqueurs, quel que soit l'ordre de création",
    iReg < iOutil, "réglages " + iReg + ", marqueurs " + iOutil);
  verifie("  tous passent AVANT son bouton de débordement",
    Math.max(iReg, iOutil) < kids.length - 1 &&
    kids[kids.length - 1].getBoundingClientRect().height <= 4,
    "dernier des nôtres en " + Math.max(iReg, iOutil) + " sur " + kids.length);

  /* ---------- LA PALETTE EST UN TIROIR, PAS UN CADRE ---------- */
  const barre = docPont.body.querySelector(".vttk-barre");
  verifie("la palette est dessinée", !!barre);
  verifie("  en tiroir, puisqu'il y a une colonne où se greffer",
    !!barre && /vttk-barre-tiroir/.test(barre.className), barre && barre.className);
  verifie("  et FERMÉE tant qu'on ne l'ouvre pas",
    !!barre && !barre.classList.contains("ouvert"));
  /* ---------- DEUX FAMILLES DANS LA PALETTE ----------
   *
   * Les VÔTRES, qu'on gère ici, et les MARQUEURS DE ROLL20, qu'on ne fait que
   * poser. Les seconds valent d'y être : c'est LUI qui les dessine, donc tout le
   * monde les voit, extension ou pas — et les poser par notre chemin est plus
   * rapide que par le sien.
   *
   * Le modèle en déclare trois (skull, sleepy, half-heart) ; la palette en
   * compte deux à nous. Seuls les nôtres portent une croix de suppression. */
  /* 2 à nous + 7 PASTILLES + 1 CROIX + 3 pictogrammes du modèle. Les pastilles
   * et la croix manquaient : elles ne figurent dans AUCUN catalogue — les
   * premières sont des maillages « red-marker-template »…, la seconde le
   * marqueur « dead », rendu par un maillage « deadmarker » — alors que ce sont
   * les marqueurs les plus employés en jeu. */
  egal("  une tuile par marqueur, les siens compris",
    barre ? barre.querySelectorAll(".vttk-barre-marqueur").length : 0, 13);
  /* LA PALETTE AU REPOS NE PORTE AUCUN GESTE DESTRUCTEUR. Croix de suppression
   * et formulaire d'ajout ne paraissent qu'en édition : on ouvre cette palette
   * cent fois pour poser un marqueur et une fois pour en ajouter un, et une
   * croix rouge à côté de chaque tuile de vingt-huit pixels est un accident qui
   * attend son heure. */
  egal("    et AUCUNE croix de suppression tant qu'on n'édite pas",
    barre ? barre.querySelectorAll(".vttk-marqueur-sup").length : 0, 0);
  egal("    ni le moindre champ de saisie",
    barre ? barre.querySelectorAll(".vttk-marqueur-champ").length : 0, 0);
  egal("  mais un rouage, qui est le seul chemin vers l'édition",
    barre ? barre.querySelectorAll(".vttk-barre-rouage").length : 0, 1);
  egal("    et les sept pastilles de couleur, qui ne sont dans aucun catalogue",
    barre ? barre.querySelectorAll(".vttk-marqueur-pastille").length : 0, 7);
  egal("    plus la croix rouge, le marqueur « dead »",
    barre ? barre.querySelectorAll(".vttk-marqueur-croix").length : 0, 1);
  /* Les étiquettes proposées, à la main : le faux sélecteur ne fait ni les
   * attributs ni les combinateurs, et le code de production n'en emploie pas
   * non plus — enrichir le modèle pour le seul confort d'un contrôle
   * l'éloignerait de ce qu'il imite. */
  const etiquettesPalette = (b) => (b ? b.querySelectorAll(".vttk-barre-marqueur") : [])
    .map((n) => n.getAttribute("data-tag"));
  verifie("    et ses marqueurs sont proposés avec leur image",
    etiquettesPalette(barre).indexOf("skull") >= 0,
    etiquettesPalette(barre).join(", "));
  verifie("    « dead » aussi, alors qu'il n'est dans aucun catalogue",
    etiquettesPalette(barre).indexOf("dead") >= 0,
    etiquettesPalette(barre).join(", "));
  /* Deux en-têtes : « Vos marqueurs » et « Marqueurs de Roll20 ». Sans eux, on ne
   * saurait pas lesquels sont vus de tous. */
  egal("  et deux sections, pour distinguer les deux régimes",
    barre ? barre.querySelectorAll(".vttk-marqueur-entete").length : 0, 2);
  egal("  rien n'est armé au départ", pont.ctx._fenetre.pointerdown ? pont.ctx._fenetre.pointerdown.length : 0, 0);

  /* ---------- UN ÉCOUTEUR, ET PAS UN DE PLUS ----------
   *
   * LA PALETTE NE SE REFERME PLUS TOUTE SEULE, et c'est demandé. Un clic ailleurs
   * la fermait — l'usage d'un menu, mais elle n'en est pas un : on y revient sans
   * cesse pendant qu'on travaille sur la carte, et chaque aller-retour coûtait un
   * clic de rouverture.
   *
   * Elle se ferme de DEUX façons, et de deux seulement : le bouton de la boîte à
   * outils, et sa propre croix. Il n'y a donc plus d'écouteur de clic pour le
   * tiroir — un de moins en capture sur toute la page pendant tout le temps où
   * elle est ouverte. Reste celui de l'ARMEMENT, qui ne vit que pendant la
   * sélection, et Échap.
   *
   * Et RIEN n'est écouté quand le tiroir est fermé. Un écouteur de clic en
   * capture se paie à chaque clic ; une extension qui le garde en permanence pèse
   * sur une machine modeste pour rien. */
  const nEcout = (t) => (pont.ctx._fenetre[t] || []).length;

  outil.querySelector("button").declenche("click");
  verifie("presser notre bouton ouvre le tiroir", barre.classList.contains("ouvert"));
  egal("  et le bouton le dit", outil.querySelector("button").getAttribute("aria-expanded"), "true");
  egal("  le tiroir ouvert n'écoute AUCUN clic", nEcout("pointerdown"), 0);
  egal("  et Échap, une seule fois", nEcout("keydown"), 1);
  outil.querySelector("button").declenche("click");
  verifie("le represser le referme", !barre.classList.contains("ouvert"));
  egal("  et n'écoute plus rien du tout", nEcout("pointerdown") + nEcout("keydown"), 0);
  outil.querySelector("button").declenche("click");   // on le rouvre pour la suite

  const bouton = barre.querySelectorAll(".vttk-barre-marqueur")[0];
  bouton.declenche("click");
  egal("un clic sur un bouton l'arme", bouton.getAttribute("aria-pressed"), "true");
  egal("  et SEULEMENT alors le plateau est écouté", nEcout("pointerdown"), 1);
  /* Échap est écouté par le tiroir ET par l'armement, mais UNE SEULE FOIS : un
   * vrai DOM ignore un enregistrement en double, et s'appuyer là-dessus au lieu
   * de tenir l'état serait une négligence. */
  egal("  sans doubler l'écoute d'Échap", nEcout("keydown"), 1);

  /* Un clic sur le token T1. Le repère : le faux Project est (x + 500 ; -y + 500),
   * donc le centre de T1 — monde (700 ; -910) — tombe en (1200 ; 1410). Le pont
   * ne connaît pas cette formule : il l'établit en projetant deux points. */
  t1.save({ statusmarkers: "" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("cliquer un token y pose le marqueur armé", t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  et cliquer à nouveau l'en retire", t1.attributes.statusmarkers, "");
  verifie("  le marqueur reste armé, pour en marquer plusieurs de suite",
    nEcout("pointerdown") === 1);

  /* Un clic HORS de tout token désarme — sinon on resterait armé sans le savoir,
   * et le clic suivant sur le plateau serait avalé —, mais il ne referme PAS le
   * tiroir : plus rien ne le referme que ses deux boutons. */
  pont.ctx._declenche("pointerdown", { clientX: 10, clientY: 10, target: null });
  egal("un clic dans le vide désarme", nEcout("pointerdown"), 0);
  egal("  et le bouton le dit", bouton.getAttribute("aria-pressed"), "false");
  verifie("  mais le tiroir reste ouvert", barre.classList.contains("ouvert"));
  pont.ctx._declenche("pointerdown", { clientX: 10, clientY: 10, target: null });
  verifie("  et le clic d'après ne le referme pas non plus",
    barre.classList.contains("ouvert"));

  /* ÉCHAP VIDE LA SÉLECTION, ET NE FERME PLUS RIEN. Ce serait une troisième
   * façon de refermer, et surtout une qu'on déclenche sans y penser — la même
   * touche sert à annuler tout et n'importe quoi dans Roll20. */
  bouton.declenche("click");
  pont.ctx._declenche("keydown", { key: "Escape" });
  egal("Échap vide la sélection", bouton.getAttribute("aria-pressed"), "false");
  verifie("  sans refermer le tiroir", barre.classList.contains("ouvert"));
  pont.ctx._declenche("keydown", { key: "Escape" });
  verifie("  et un second Échap ne le referme pas davantage",
    barre.classList.contains("ouvert"));

  /* LA CROIX, elle, referme — c'est l'une des deux seules sorties. */
  const croixBarre = barre.querySelector(".vttk-barre-ferme");
  verifie("la palette porte une croix en haut à droite", !!croixBarre);
  croixBarre.declenche("click");
  verifie("  et elle referme", !barre.classList.contains("ouvert"));
  egal("    ne laissant rien derrière", nEcout("pointerdown") + nEcout("keydown"), 0);
  egal("    le bouton d'outil le dit aussi",
    outil.querySelector("button").getAttribute("aria-expanded"), "false");
  outil.querySelector("button").declenche("click");   // on rouvre pour la suite

  /* ============================================================
   *      PLUSIEURS MARQUEURS À LA FOIS, ET LA RÈGLE DE POSE
   * ============================================================
   *
   * LA RÈGLE, telle que l'auteur l'a posée : on AJOUTE, sans doublon, dès qu'au
   * moins un des marqueurs choisis manque ; on RETIRE tous les marqueurs choisis
   * s'ils sont TOUS déjà là. Un seul marqueur n'est que le cas dégénéré de cette
   * règle — c'est la bascule d'avant, et les contrôles plus haut l'établissent.
   *
   * On éprouve ici le cas à plusieurs, et surtout le cas MIXTE : un présent, un
   * absent. C'est celui qui distingue « ajouter ce qui manque » d'un simple
   * « inverser chacun », et les deux lectures divergent précisément là. */
  outil.querySelector("button").declenche("click");
  const tuiles = barre.querySelectorAll(".vttk-barre-marqueur");
  const parTag = (t) => tuiles.filter((b) => b.getAttribute("data-tag") === t)[0];
  const tA = parTag("vttk_a_exemple.org/a.png");
  const tB = parTag("vttk_b_exemple.org/b.png");
  const tSkull = parTag("skull");

  t1.save({ statusmarkers: "" });
  tA.declenche("click");
  tB.declenche("click");
  egal("choisir deux marqueurs les marque tous les deux",
    (tA.getAttribute("aria-pressed") || "") + "/" + (tB.getAttribute("aria-pressed") || ""),
    "true/true");
  egal("  sans doubler l'écoute du plateau", nEcout("pointerdown"), 1);
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("les poser d'un coup les pose dans l'ordre des clics",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png");
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  tous présents : le clic suivant les retire tous",
    t1.attributes.statusmarkers, "");

  /* LE CAS MIXTE. Un des deux est déjà là : la règle dit d'AJOUTER ce qui
   * manque, et surtout de ne pas retirer celui qui y était. */
  t1.save({ statusmarkers: "vttk_a_exemple.org/a.png" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("un seul des deux présent : on ajoute l'autre, sans doublon",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png");

  /* CE QU'ON N'A PAS CHOISI NE BOUGE PAS. Un module qui « range » le champ
   * efface le travail d'un autre — y compris des étiquettes que personne ne
   * dessine, qui appartiennent peut-être à une extension qu'on ne connaît pas. */
  t1.save({ statusmarkers: "skull,inconnue-de-tous,vttk_a_exemple.org/a.png" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  et rien de ce qu'on n'a pas choisi n'est touché",
    t1.attributes.statusmarkers,
    "skull,inconnue-de-tous,vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png");

  /* LE DOUBLON DE BASE — le défaut que la contre-épreuve a trouvé, et qui
   * n'existait QUE dans le chemin à plusieurs. Un token qui porte « skull@7 »,
   * une sélection {skull, absent} : comparer les TEXTES faisait passer « skull »
   * pour absent et écrivait « skull@7,skull,… ». Roll20 dessinait skull deux
   * fois, sa rangée comptait une case de trop, et tous nos marqueurs, dont la
   * première case se déduit de la sienne, se décalaient. */
  pont.ctx._declenche("keydown", { key: "Escape" });
  t1.save({ statusmarkers: "skull@7" });
  tSkull.declenche("click");
  tA.declenche("click");
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("un choix nu sur une base déjà là ne la double PAS",
    t1.attributes.statusmarkers, "skull@7,vttk_a_exemple.org/a.png");
  pont.ctx._declenche("keydown", { key: "Escape" });

  /* UNE SÉLECTION VIDE N'EST PAS UN RANGEMENT. « tous les choisis sont là » est
   * vrai sur un ensemble vide : la lecture littérale tombait dans la branche de
   * retrait, ne retirait rien, mais rendait le champ NORMALISÉ — donc réécrivait
   * dans la campagne un champ que personne n'avait demandé de toucher. */
  t1.save({ statusmarkers: " skull ,, snail@2 " });
  const champIntact = t1.attributes.statusmarkers;
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("cliquer sans rien avoir choisi ne touche pas au champ",
    t1.attributes.statusmarkers, champIntact);
  /* ET CE CLIC-LÀ REFERME LA PALETTE : rien n'était choisi, donc c'était un clic
   * « ailleurs ». On la rouvre pour la suite — et c'est la découverte de ce
   * contrôle : sans lui, tout ce qui suivait s'exécutait sur un tiroir fermé, où
   * le clavier n'est plus écouté. */
  verifie("  et il referme la palette, faute de raison de rester",
    !barre.classList.contains("ouvert"));
  outil.querySelector("button").declenche("click");

  /* ÉCHAP VIDE TOUTE LA SÉLECTION D'UN COUP, et ne dépile pas. Une touche
   * d'échappement annule ce qu'on est en train de faire ; dépiler un marqueur à
   * la fois obligerait à la frapper cinq fois pour sortir d'une erreur. */
  t1.save({ statusmarkers: "" });
  tA.declenche("click");
  tB.declenche("click");
  pont.ctx._declenche("keydown", { key: "Escape" });
  egal("Échap vide toute la sélection d'un coup",
    (tA.getAttribute("aria-pressed") || "") + "/" + (tB.getAttribute("aria-pressed") || ""),
    "false/false");
  verifie("  sans refermer la palette", barre.classList.contains("ouvert"));

  /* ============================================================
   *        LE CHIFFRE AU SURVOL, COMME CHEZ ROLL20
   * ============================================================
   *
   * On survole une tuile, on frappe un chiffre : le marqueur est choisi ET
   * numéroté. Le survol passe par UN SEUL écouteur posé sur la barre — soixante
   * tuiles, un enregistrement —, d'où l'événement envoyé sur la barre avec la
   * tuile pour cible. */
  t1.save({ statusmarkers: "" });
  barre.declenche("mouseover", { target: tSkull });
  pont.ctx._declenche("keydown", { key: "3" });
  egal("frapper un chiffre au survol choisit le marqueur",
    tSkull.getAttribute("aria-pressed"), "true");
  egal("  et le montre sur la tuile",
    tSkull.parentNode.querySelector(".vttk-marqueur-nombre").textContent, "3");
  pont.ctx._declenche("keydown", { key: "7" });
  egal("  les chiffres s'enchaînent sur la même tuile",
    tSkull.parentNode.querySelector(".vttk-marqueur-nombre").textContent, "37");
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("et la pose écrit le compteur de Roll20", t1.attributes.statusmarkers, "skull@37");

  /* FRAPPER LE MÊME NOMBRE LE RETIRE, frapper un autre le REMPLACE. Les deux se
   * déduisent de la règle : « est-il déjà là ? » se juge sur ce qu'on POSE. */
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  reposer le même nombre le retire", t1.attributes.statusmarkers, "");
  t1.save({ statusmarkers: "skull@5" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  et sur un autre nombre, il le remplace sans doubler l'entrée",
    t1.attributes.statusmarkers, "skull@37");

  /* ET IL NE BOUGE PAS DE PLACE. Le premier jet laissait tomber l'entrée puis la
   * republiait en fin de liste : renuméroter un marqueur le faisait SAUTER à
   * l'autre bout de la rangée du token, en décalant tous ceux qui le suivaient.
   * La position dans le champ est une donnée à part entière. */
  t1.save({ statusmarkers: "skull@5,sleepy,half-heart" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  et le compteur changé ne DÉPLACE pas le marqueur",
    t1.attributes.statusmarkers, "skull@37,sleepy,half-heart");

  /* LES DEUX PASTILLES PARAISSENT ENSEMBLE, ET C'EST TOUT L'OBJET DE LA SCISSION.
   *
   * Une seule les portait toutes les deux : le nombre QUAND il y en avait un, et
   * sinon le rang. Elles ne pouvaient donc jamais coexister, et rien ne
   * distinguait « ce marqueur portera un 3 » de « ce marqueur est le troisième
   * choisi » — même place, même forme. On choisit ici DEUX marqueurs, dont le
   * second numéroté : le second doit montrer les deux à la fois. */
  pont.ctx._declenche("keydown", { key: "Escape" });
  tA.declenche("click");
  barre.declenche("mouseover", { target: tSkull });
  pont.ctx._declenche("keydown", { key: "5" });
  const coinsDe = (b) => ({
    nombre: b.parentNode.querySelector(".vttk-marqueur-nombre"),
    rang: b.parentNode.querySelector(".vttk-marqueur-rang")
  });
  const deuxCoins = coinsDe(tSkull);
  egal("le nombre frappé se montre à gauche", deuxCoins.nombre.textContent, "5");
  egal("  et le rang du clic à droite, en même temps", deuxCoins.rang.textContent, "2");
  verifie("    les deux visibles ensemble",
    !deuxCoins.nombre.hidden && !deuxCoins.rang.hidden);
  const premierCoins = coinsDe(tA);
  egal("  le premier choisi n'a que son rang", premierCoins.rang.textContent, "1");
  verifie("    et aucun nombre", premierCoins.nombre.hidden);
  pont.ctx._declenche("keydown", { key: "Escape" });
  verifie("Échap efface les deux pastilles",
    deuxCoins.nombre.hidden && deuxCoins.rang.hidden);

  /* UNE TOUCHE MAINTENUE N'EST PAS UNE SUITE DE FRAPPES. Le clavier répète une
   * trentaine de fois par seconde : sans garde, garder « 3 » enfoncé une
   * demi-seconde fabriquait 3, 33, 333, puis repartait — un compteur tiré au
   * sort, et posé tel quel au clic suivant. */
  pont.ctx._declenche("keydown", { key: "Escape" });
  barre.declenche("mouseover", { target: tSkull });
  pont.ctx._declenche("keydown", { key: "3" });
  pont.ctx._declenche("keydown", { key: "3", repeat: true });
  pont.ctx._declenche("keydown", { key: "3", repeat: true });
  egal("une touche maintenue ne fabrique pas de nombre",
    tSkull.parentNode.querySelector(".vttk-marqueur-nombre").textContent, "3");
  /* On laisse « skull » choisi et le champ tel que le contrôle suivant l'attend :
   * il enchaîne sur un Échap, qui doit VIDER une sélection et non refermer la
   * palette. */
  t1.save({ statusmarkers: "skull@37" });

  /* UN MARQUEUR CHOISI SANS NOMBRE EST « LÀ » DÈS QUE SA BASE Y EST : cliquer
   * une tuile déjà posée la retire, qu'elle porte un compteur ou non. */
  pont.ctx._declenche("keydown", { key: "Escape" });
  tSkull.declenche("click");
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("un choix nu retire un marqueur qui portait un compteur",
    t1.attributes.statusmarkers, "");

  /* CHANGER DE TUILE COUPE L'ENCHAÎNEMENT : « 1 » sur l'une puis « 2 » sur
   * l'autre font deux marqueurs, l'un à 1 et l'autre à 2 — et non un « 12 ».
   *
   * (« skull » est encore choisi du contrôle précédent, et il n'y a qu'Échap
   * pour le lâcher : la sélection SURVIT à la pose, c'est ce qui permet de
   * marquer plusieurs tokens de suite.) */
  pont.ctx._declenche("keydown", { key: "Escape" });
  t1.save({ statusmarkers: "" });
  barre.declenche("mouseover", { target: tA });
  pont.ctx._declenche("keydown", { key: "1" });
  barre.declenche("mouseover", { target: tB });
  pont.ctx._declenche("keydown", { key: "2" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("changer de tuile repart d'un nombre neuf",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png@1,vttk_b_exemple.org/b.png@2");
  pont.ctx._declenche("keydown", { key: "Escape" });

  /* « dead » N'ACCEPTE PAS DE COMPTEUR, et c'est MESURÉ : on a posé
   * « red@4,dead@2,skull@9,blue@7 » sur un vrai token, et Roll20 a fabriqué un
   * porteur de nombre pour red, blue et skull — aucun pour dead. Écrire
   * « dead@2 » serait une donnée que personne ne dessine. La frappe choisit
   * quand même le marqueur : c'est la moitié utile du geste. */
  t1.save({ statusmarkers: "" });
  const tMort = parTag("dead");
  barre.declenche("mouseover", { target: tMort });
  pont.ctx._declenche("keydown", { key: "5" });
  egal("un chiffre sur « dead » le choisit", tMort.getAttribute("aria-pressed"), "true");
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  mais ne lui accroche aucun compteur", t1.attributes.statusmarkers, "dead");
  pont.ctx._declenche("keydown", { key: "Escape" });
  t1.save({ statusmarkers: "" });

  /* UNE PASTILLE DE COULEUR, ELLE, Y A DROIT — même relevé, réponse inverse de
   * ce qu'on soupçonnait. */
  const tRouge = parTag("red");
  barre.declenche("mouseover", { target: tRouge });
  pont.ctx._declenche("keydown", { key: "4" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("une pastille de couleur accepte un compteur", t1.attributes.statusmarkers, "red@4");
  pont.ctx._declenche("keydown", { key: "Escape" });
  t1.save({ statusmarkers: "" });

  /* SANS SURVOL, PAS DE CHIFFRE. Sinon toute frappe dans la page numéroterait
   * la dernière tuile touchée, et les raccourcis de Roll20 deviendraient un
   * champ de mines. */
  barre.declenche("mouseover", { target: barre });
  t1.save({ statusmarkers: "" });
  pont.ctx._declenche("keydown", { key: "4" });
  egal("un chiffre hors de toute tuile ne choisit rien",
    barre.querySelectorAll(".vttk-barre-marqueur")
      .filter((b) => b.getAttribute("aria-pressed") === "true").length, 0);

  /* ============================================================
   *                LE MODE ÉDITION, ET SON ROUAGE
   * ============================================================ */
  const rouage = barre.querySelector(".vttk-barre-rouage");
  rouage.declenche("click");
  const barre2 = docPont.body.querySelector(".vttk-barre");
  verifie("le rouage fait passer la palette en édition",
    barre2.classList.contains("edition"), barre2.className);
  /* ET ELLE RESTE OUVERTE. Reconstruire la palette réécrit sa liste de classes
   * en entier, et la classe « ouvert » — celle qui la rend visible — y passait.
   * La palette disparaissait à chaque ajout de marqueur et à chaque passage en
   * édition, pendant que le bouton continuait d'annoncer qu'elle était ouverte. */
  verifie("  et elle reste OUVERTE", barre2.classList.contains("ouvert"), barre2.className);
  egal("  les croix de suppression paraissent, et pour NOS marqueurs seuls",
    barre2.querySelectorAll(".vttk-marqueur-sup").length, 2);
  egal("  le formulaire aussi : un nom, une adresse",
    barre2.querySelectorAll(".vttk-marqueur-champ").length, 2);
  egal("    et un bouton pour ajouter",
    barre2.querySelectorAll(".vttk-marqueur-bouton").length, 1);
  const tuiles2 = barre2.querySelectorAll(".vttk-marqueur-tuile");
  const traînables = tuiles2.filter((d) => d.getAttribute("draggable") === "true");
  egal("  et seuls NOS marqueurs se déplacent", traînables.length, 2);

  /* LA CROIX NE DOIT PAS TUER LE SURVOL. Elle s'ouvre au survol DANS le coin
   * haut-droit de la tuile : le pointeur passe dessus, et la remontée ne
   * trouvait plus de bouton — le survol tombait à zéro, et le chiffre frappé
   * juste après ne numérotait rien. Un ornement posé sur une tuile ne doit pas
   * la faire disparaître. */
  const croix2 = barre2.querySelectorAll(".vttk-marqueur-sup")[0];
  const tuileA = croix2.parentNode.querySelector(".vttk-barre-marqueur");
  t1.save({ statusmarkers: "" });
  barre2.declenche("mouseover", { target: croix2 });
  pont.ctx._declenche("keydown", { key: "8" });
  egal("survoler la croix garde la tuile sous le pointeur",
    tuileA.parentNode.querySelector(".vttk-marqueur-nombre").textContent, "8");
  pont.ctx._declenche("keydown", { key: "Escape" });

  /* LE FORMULAIRE PARLE AU SCRIPT DE CONTENU, il n'écrit rien lui-même : le pont
   * vit dans la page et n'a ni stockage ni modèle. */
  const chNom = barre2.querySelectorAll(".vttk-marqueur-champ")[0];
  const chUrl = barre2.querySelectorAll(".vttk-marqueur-champ")[1];
  chNom.value = "Poison";
  chUrl.value = "https://exemple.org/skull.png";
  barre2.querySelector(".vttk-marqueur-bouton").declenche("click");
  const demande = versContenu.filter((m) => m && m.type === "marqueurs-ajoute").pop();
  verifie("le « + » demande l'ajout au script de contenu", !!demande, JSON.stringify(demande));
  egal("  avec le nom", demande && demande.nom, "Poison");
  egal("  et l'adresse", demande && demande.url, "https://exemple.org/skull.png");

  /* UNE ADRESSE VIDE NE PART PAS, et le panneau le DIT — sans quoi on cliquerait
   * « + » trois fois sans comprendre pourquoi rien n'arrive. */
  const nAvantVide = versContenu.filter((m) => m && m.type === "marqueurs-ajoute").length;
  chUrl.value = "   ";
  barre2.querySelector(".vttk-marqueur-bouton").declenche("click");
  egal("une adresse vide ne part pas",
    versContenu.filter((m) => m && m.type === "marqueurs-ajoute").length, nAvantVide);
  const bilanUi = barre2.querySelector(".vttk-marqueur-bilan");
  verifie("  et le panneau le dit", !bilanUi.hidden && /adresse/.test(bilanUi.textContent),
    bilanUi.textContent);

  /* ---------- TRIER À LA SOURIS ---------- */
  const dA = traînables[0], dB = traînables[1];
  dB.declenche("dragstart", { dataTransfer: null });
  barre2.querySelector(".vttk-marqueur-grille").declenche("drop", { target: dA });
  const tri = versContenu.filter((m) => m && m.type === "marqueurs-ordre").pop();
  verifie("déposer une tuile sur une autre demande un nouvel ordre", !!tri, JSON.stringify(tri));
  egal("  et c'est la traînée qui prend la place de la cible",
    tri && tri.ordre.join(","),
    "vttk_b_exemple.org/b.png,vttk_a_exemple.org/a.png");

  /* DÉPOSER SUR SOI-MÊME NE DEMANDE RIEN. Une écriture du stockage se diffuse à
   * tous les onglets Roll20 ouverts et refait toutes les poses : une pour rien
   * est un coût pour rien. */
  const nTri = versContenu.filter((m) => m && m.type === "marqueurs-ordre").length;
  dA.declenche("dragstart", { dataTransfer: null });
  barre2.querySelector(".vttk-marqueur-grille").declenche("drop", { target: dA });
  egal("  déposer une tuile sur elle-même n'écrit rien",
    versContenu.filter((m) => m && m.type === "marqueurs-ordre").length, nTri);

  rouage.declenche("click");
  const barre3 = docPont.body.querySelector(".vttk-barre");
  verifie("le represser quitte l'édition", !barre3.classList.contains("edition"));
  egal("  et le formulaire disparaît avec elle",
    barre3.querySelectorAll(".vttk-marqueur-champ").length, 0);

  /* ============================================================
   *   LE RENDEZ-VOUS NE DOIT PAS BATTRE POUR RIEN — ET IL BATTAIT
   * ============================================================
   *
   * Le balayage complet arme un rendez-vous de 700 ms tant qu'un token attend
   * son nœud Babylon. Mais `poseMarqueursSur` rendait « false » AUSSI pour
   * « déjà à jour » : chaque token porteur d'un de nos marqueurs, parfaitement
   * dessiné et parfaitement stable, comptait pour une attente. Le rendez-vous
   * rappelait le balayage, qui recomptait la même attente — un parcours complet
   * de la page toutes les sept dixièmes de seconde, À VIE, dès qu'un seul
   * marqueur était posé quelque part. Sur une machine modeste, dans une partie
   * de trente tokens, c'est exactement le genre de coût que ce module s'interdit.
   *
   * On compte donc les rendez-vous armés, pour de bon : `setTimeout` est pris
   * sur le global du bac à sable, et le remplacer suffit à les voir tous. */
  /* ON REMET TOUT EN PLACE APRÈS : les contrôles qui suivent comptent sur l'état
   * que ceux d'avant ont laissé, et un bloc qui range derrière lui est un bloc
   * qu'on peut déplacer sans casser ses voisins. */
  const etatT1 = t1.attributes.statusmarkers, etatT2 = t2.attributes.statusmarkers;
  t1.save({ statusmarkers: "" });
  t2.save({ statusmarkers: "" });
  const vraiSetTimeout = pont.ctx.setTimeout;
  let rdv = 0;
  pont.ctx.setTimeout = function (f, ms) { rdv++; return 0; };
  t1.save({ statusmarkers: "vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png" });
  rdv = 0;   // la pose initiale a le droit d'en armer un : c'est la suite qu'on regarde
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE });
  egal("un balayage sur une page entièrement dessinée n'arme AUCUN rendez-vous", rdv, 0);
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE });
  egal("  ni le suivant, ni aucun autre", rdv, 0);
  pont.ctx.setTimeout = vraiSetTimeout;

  /* LA LARGEUR DU TOKEN décide de la capacité d'une ligne : la redimensionner
   * change la mise en page sans qu'une seule étiquette bouge. Tant que le
   * balayage se rappelait tout seul, le cas se réparait par accident. */
  t1.save({ statusmarkers: "skull,sleepy,half-heart,vttk_a_exemple.org/a.png,vttk_b_exemple.org/b.png" });
  const avantLarge = nos().filter((m) => m.parent && m.parent.name === "T1-markers")
    .map((m) => m.position.x + "/" + m.position.y).sort().join(" ");
  t1.save({ width: 70 });
  const apresLarge = nos().filter((m) => m.parent && m.parent.name === "T1-markers")
    .map((m) => m.position.x + "/" + m.position.y).sort().join(" ");
  verifie("redimensionner un token refait sa rangée", avantLarge !== apresLarge,
    avantLarge + "  →  " + apresLarge);
  t1.save({ width: 140 });
  t1.save({ statusmarkers: etatT1 });
  t2.save({ statusmarkers: etatT2 });

  /* ============================================================
   *        MJ OU JOUEUR : QUI A LE DROIT D'ÉCRIRE QUOI
   * ============================================================
   *
   * MESURÉ SUR DEUX VRAIES PARTIES, la même en MJ et en joueur :
   *
   *                        MJ        joueur
   *     window.is_gm       true      false
   *     tokens contrôlés   0         3
   *
   * Roll20 ne laisse écrire un token qu'à qui le contrôle. Un joueur qui pose
   * sur le token d'un autre verrait le marqueur paraître — Backbone met le
   * modèle à jour localement — puis DISPARAÎTRE quand le serveur reprend la
   * valeur. On refuse donc avant d'écrire, et on le dit.
   *
   * ET LE PIÈGE EST LE MJ : le `controlledby` de ses tokens est VIDE. Une règle
   * qui ne regarderait que ce champ lui interdirait de marquer ses propres
   * tokens, c'est-à-dire tous. C'est ce contrôle-là qui tient la nuance. */
  const luiDire = (v) => { pont.ctx.is_gm = v; };
  const monJoueur = { id: "MOI" };
  pont.ctx.currentPlayer = monJoueur;

  t1.save({ statusmarkers: "", controlledby: "" });
  luiDire(true);
  tA.declenche("click");
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("un MJ pose sur un token que PERSONNE ne contrôle",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");

  t1.save({ statusmarkers: "" });
  luiDire(false);
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("un JOUEUR ne peut pas y toucher", t1.attributes.statusmarkers, "");
  const refus = versContenu.filter((m) => m && m.type === "marqueurs-refus").pop();
  verifie("  et le refus part vers le script de contenu", !!refus, JSON.stringify(refus));
  const motDit = barre.querySelector(".vttk-barre-mot");
  verifie("  la palette le DIT — un refus muet passe pour une panne",
    !!motDit && !motDit.hidden && /appartient/.test(motDit.textContent), motDit && motDit.textContent);

  t1.save({ controlledby: "MOI" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("mais il pose sur CE QU'IL contrôle",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");

  t1.save({ statusmarkers: "", controlledby: "UNAUTRE,all" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  et sur ce qui est ouvert à tous", t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");

  t1.save({ statusmarkers: "", controlledby: "UNAUTRE" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("  mais pas sur le token d'un autre joueur", t1.attributes.statusmarkers, "");

  /* DRAPEAU INCONNU : ON AUTORISE. Si Roll20 renommait `is_gm`, refuser par
   * défaut retirerait la fonction à tous les MJ — dont les tokens n'ont aucun
   * `controlledby`. Autoriser laisse au pire un joueur devant un marqueur qui
   * s'efface : désagréable, partiel, réversible. On ne choisit pas la panne la
   * plus grave par prudence. */
  delete pont.ctx.is_gm;
  t1.save({ statusmarkers: "", controlledby: "" });
  pont.ctx._declenche("pointerdown", { clientX: 1200, clientY: 1410, target: null });
  egal("sans drapeau lisible, on laisse passer plutôt que de tout bloquer",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");
  luiDire(true);
  t1.save({ statusmarkers: "", controlledby: "" });
  pont.ctx._declenche("keydown", { key: "Escape" });

  /* ============================================================
   *      DEUX MANIÈRES DE POSER, ET UNE SEULE RÈGLE DE POSE
   * ============================================================
   *
   * « marqueur » — on arme un marqueur, puis on clique les tokens. C'est ce que
   *   tout ce qui précède éprouve.
   * « tokens »   — on sélectionne des tokens avec la sélection de ROLL20, puis
   *   un clic sur un marqueur les marque tous.
   *
   * LA SÉLECTION DE ROLL20 SE LIT PAR UNE FONCTION, et c'est ce qui avait été
   * mal compris : `d20.engine.tabletopSelected` n'est pas un tableau. Un relevé
   * ancien la lisait comme tel, la trouvait vide, et concluait que sa sélection
   * était inatteignable — d'où le pointage qu'on fait nous-mêmes dans l'autre
   * mode. Elle délègue à `VTTEngine.instance.tabletop.getSelection()`, et chaque
   * entrée porte `id` et `model` : mesuré sur une vraie partie.
   *
   * Le faux d20 ci-dessous reproduit CETTE forme-là, fonction comprise. */
  let selectionR20 = [];
  pont.ctx.currentPlayer = {
    id: "MOI",
    d20: { engine: { tabletopSelected: function () {
      return selectionR20.map(function (m) { return { id: m.id, model: m }; });
    } } }
  };
  luiDire(true);
  t1.save({ statusmarkers: "", controlledby: "" });
  t2.save({ statusmarkers: "", controlledby: "" });

  const passeEnMode = (m) => {
    bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs",
                actif: true, catalogue: PALETTE, mode: m });
  };

  passeEnMode("tokens");
  const barreM = docPont.body.querySelector(".vttk-barre");
  /* LE FAUX SÉLECTEUR NE FAIT PAS LES SÉLECTEURS COMPOSÉS — « .a.b » y est pris
   * pour une seule classe. On filtre donc à la main, comme le code de production
   * le fait déjà partout ailleurs : enrichir le modèle pour le seul confort d'un
   * contrôle l'éloignerait de ce qu'il imite. */
  const modesActifs = (b) => b.querySelectorAll(".vttk-barre-mode")
    .filter((o) => o.classList.contains("actif"));
  egal("le mode arrive avec le catalogue, et la palette l'affiche",
    modesActifs(barreM).length, 1);
  egal("  et c'est bien le second",
    barreM.querySelectorAll(".vttk-barre-mode")[1].getAttribute("aria-pressed"), "true");

  /* SANS SÉLECTION, UN CLIC NE FAIT RIEN — et le DIT. C'est le défaut le plus
   * facile à commettre ici : la palette a l'air de fonctionner, et rien ne se
   * passe. */
  selectionR20 = [];
  const tuileM = barreM.querySelectorAll(".vttk-barre-marqueur")[0];
  tuileM.declenche("click");
  const motM = barreM.querySelector(".vttk-barre-mot");
  verifie("sans token sélectionné, le clic le dit",
    !!motM && !motM.hidden && /Sélectionnez/.test(motM.textContent), motM && motM.textContent);
  egal("  et n'arme aucun écouteur de plateau", nEcout("pointerdown"), 0);

  /* DEUX TOKENS SÉLECTIONNÉS, UN CLIC : les deux sont marqués. */
  selectionR20 = [t1, t2];
  tuileM.declenche("click");
  egal("avec deux tokens sélectionnés, le clic marque le premier",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");
  egal("  et le second aussi", t2.attributes.statusmarkers, "vttk_a_exemple.org/a.png");
  verifie("  et il le dit", /2 tokens marqués/.test(motM.textContent), motM.textContent);

  /* LA DÉCISION EST COLLECTIVE, ET C'EST CE QUI A CHANGÉ.
   *
   * L'un porte déjà le marqueur, l'autre non. Chaque token était jugé sur son
   * propre champ : le premier le perdait pendant que le second le gagnait — les
   * deux se croisaient sans jamais se rejoindre, et cliquer deux fois ne faisait
   * qu'échanger leurs états.
   *
   * La règle est maintenant celle-ci, et la même dans les deux modes : si TOUS
   * les tokens l'ont, on le retire à tous ; SINON on l'ajoute à ceux qui ne
   * l'ont pas. Ici, tous ne l'ont pas — donc on ajoute, et celui qui l'avait le
   * garde. Un second clic, où tous l'ont, le retire aux deux. */
  t1.save({ statusmarkers: "vttk_a_exemple.org/a.png" });
  t2.save({ statusmarkers: "" });
  tuileM.declenche("click");
  egal("tous ne l'ont pas : celui qui l'avait le GARDE",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");
  egal("  et celui qui ne l'avait pas le gagne",
    t2.attributes.statusmarkers, "vttk_a_exemple.org/a.png");
  verifie("  et le compte rendu ne parle que de ce qui a changé",
    /1 token marqué/.test(motM.textContent), motM.textContent);
  tuileM.declenche("click");
  egal("maintenant tous l'ont : le clic suivant le retire au premier",
    t1.attributes.statusmarkers, "");
  egal("  et au second", t2.attributes.statusmarkers, "");
  verifie("  et il dit qu'il a DÉMARQUÉ", /démarqués/.test(motM.textContent), motM.textContent);

  /* LE CHIFFRE AU SURVOL VAUT DANS CE MODE AUSSI : il fixe le compteur que la
   * pose emportera. Et il ne sert QU'UNE FOIS — le garder ferait porter le même
   * compteur au marqueur suivant sans qu'on l'ait demandé. */
  t1.save({ statusmarkers: "" });
  t2.save({ statusmarkers: "" });
  barreM.declenche("mouseover", { target: tuileM });
  pont.ctx._declenche("keydown", { key: "9" });
  tuileM.declenche("click");
  egal("un chiffre frappé au survol part avec la pose",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png@9");
  egal("  la pastille s'efface après usage",
    tuileM.parentNode.querySelector(".vttk-marqueur-nombre").textContent, "");

  /* LES DROITS VALENT ICI AUSSI, token par token. */
  luiDire(false);
  t1.save({ statusmarkers: "", controlledby: "MOI" });
  t2.save({ statusmarkers: "", controlledby: "UN-AUTRE" });
  tuileM.declenche("click");
  egal("un joueur marque ce qu'il contrôle",
    t1.attributes.statusmarkers, "vttk_a_exemple.org/a.png");
  egal("  et pas le reste", t2.attributes.statusmarkers, "");
  verifie("  et le compte rendu dit les deux",
    /1 token marqué/.test(motM.textContent) && /1 refusé/.test(motM.textContent),
    motM.textContent);
  luiDire(true);

  /* CHANGER DE MODE À LA MAIN ÉCRIT LA PRÉFÉRENCE : on la retrouve au
   * rechargement, sinon il faudrait la reposer à chaque ouverture de partie. */
  const avantMode = versContenu.filter((m) => m && m.type === "marqueurs-mode").length;
  barreM.querySelectorAll(".vttk-barre-mode")[0].declenche("click");
  const demandeMode = versContenu.filter((m) => m && m.type === "marqueurs-mode").pop();
  verifie("presser l'autre moitié demande l'enregistrement du mode",
    versContenu.filter((m) => m && m.type === "marqueurs-mode").length > avantMode,
    JSON.stringify(demandeMode));
  egal("  avec le mode voulu", demandeMode && demandeMode.mode, "marqueur");
  const barreMode1 = docPont.body.querySelector(".vttk-barre");
  egal("  et la palette repasse au premier mode",
    barreMode1.querySelectorAll(".vttk-barre-mode")[0].getAttribute("aria-pressed"), "true");

  /* ET LE PREMIER MODE MARCHE ENCORE : une sélection de Roll20 ne doit pas s'y
   * appliquer toute seule, sinon les deux modes se confondent. */
  selectionR20 = [t1, t2];
  t1.save({ statusmarkers: "" });
  t2.save({ statusmarkers: "" });
  barreMode1.querySelectorAll(".vttk-barre-marqueur")[0].declenche("click");
  egal("de retour au premier mode, un clic ARME au lieu de poser",
    t1.attributes.statusmarkers + "/" + t2.attributes.statusmarkers, "/");
  egal("  et le plateau est écouté", nEcout("pointerdown"), 1);
  pont.ctx._declenche("keydown", { key: "Escape" });
  selectionR20 = [];
  /* ON REMET LES DEUX TOKENS COMME ON LES A TROUVÉS : les contrôles suivants
   * comptent sur ce que ceux d’avant ont laissé. */
  t1.save({ statusmarkers: "vttk_a_exemple.org/a.png", controlledby: "" });
  t2.save({ statusmarkers: "vttk_a_exemple.org/a.png", controlledby: "" });
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE });

  /* ---------- ÉTEINDRE NE DOIT RIEN LAISSER DERRIÈRE ---------- */
  t1.save({ statusmarkers: "vttk_a_exemple.org/a.png" });
  verifie("avant extinction, il y a bien des quads", nos().length > 0);
  const abonnesAvant = col._combien();
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: false });
  egal("éteindre le module retire tous les quads", nos().length, 0);
  egal("  et la palette", docPont.body.querySelectorAll(".vttk-barre").length, 0);
  egal("  et le bouton des marqueurs", docPont.body.querySelectorAll(".vttk-outil-marqueurs").length, 0);
  /* MAIS PAS LA SECTION NI LES RÉGLAGES. L'intitulé VTTK est partagé avec le
   * bouton des réglages, qui ne s'éteint jamais — c'est par lui qu'on rallume
   * les modules. Le retirer ici laisserait ce bouton orphelin sous l'intitulé
   * « Effets » de Roll20. */
  egal("  mais l'intitulé VTTK reste", docPont.body.querySelectorAll(".vttk-outil-titre").length, 1);
  egal("  et le bouton des réglages aussi", docPont.body.querySelectorAll(".vttk-outil-reglages").length, 1);
  egal("  et les abonnements à la collection de Roll20", col._combien(), 0);
  verifie("  (il y en avait bien avant)", abonnesAvant > 0, abonnesAvant + " abonnements");
  egal("  et plus aucun écouteur de plateau",
    pont.ctx._fenetre.pointerdown ? pont.ctx._fenetre.pointerdown.length : 0, 0);

  /* RALLUMER DOIT REMARCHER. Un module qu'on éteint puis rallume sans que rien
   * ne revienne est un module qu'on n'éteint jamais deux fois. */
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE });
  /* DEUX, et non un : les deux tokens portent encore « vttk_a_exemple.org/a.png » — le contrôle du
   * matériau partagé, plus haut, l'a établi. Rallumer doit redessiner TOUT ce
   * qui est posé sur la page, pas seulement ce qu'on a touché en dernier. */
  egal("rallumer redessine tout ce que la page porte", nos().length, 2);
  egal("  sans doubler les abonnements", col._combien(), abonnesAvant);

  /* ============================================================
   *   PLUS DE CATALOGUE PARTAGÉ : L'ÉTIQUETTE PORTE SON ADRESSE
   * ============================================================
   *
   * IL Y AVAIT ICI TOUT UN BLOC DE CONTRÔLES, et il a disparu avec ce qu'il
   * éprouvait. L'étiquette ne disait que le nom (« vttk_poison_exemple.org/skull.png »), donc il fallait
   * un catalogue commun pour savoir quelle image dessiner : un DOCUMENT de
   * campagne à créer, à lire, à fusionner sans écraser celui des autres, à faire
   * converger par un tri d'étiquettes — et que seul un MJ pouvait écrire.
   *
   * L'étiquette porte maintenant l'adresse (« vttk_<nom>_<adresse> »). Tout cela
   * est devenu inutile : n'importe quel joueur ayant l'extension voit le marqueur,
   * immédiatement, sans rien avoir reçu et sans le moindre droit d'écriture. Ce
   * qu'il reste à vérifier tient en quelques lignes.
   *
   * LE POINT QUI COMPTE : un marqueur dont l'étiquette porte l'adresse se dessine
   * SANS être dans notre palette. C'est exactement le cas d'un marqueur posé par
   * quelqu'un d'autre. */
  t1.save({ statusmarkers: "" });
  t2.save({ statusmarkers: "" });
  const ETRANGER = "vttk_dautrui_ailleurs.org/z.png";
  t2.save({ statusmarkers: ETRANGER });
  const qEtranger = nos().filter((m) => m.name === "vttk-marqueur-" + ETRANGER);
  egal("un marqueur d'autrui se dessine sans être dans notre palette", qEtranger.length, 1);
  egal("  avec l'adresse tirée de son étiquette",
    qEtranger[0] && qEtranger[0].material.textures.image.url, "https://ailleurs.org/z.png");

  /* ON NE CROIT RIEN DE CE QU'ON LIT. Cette chaîne vient des données de la
   * campagne, donc d'autres joueurs, et le pont vit dans la page de Roll20. */
  t2.save({ statusmarkers: [
    "vttk_js_javascript:alert(1)",     // pas une adresse https
    "vttk_sansseparateur",             // illisible : aucun séparateur de nom
    "vttk_MAJUSCULES_a.org/x.png",     // nom hors de la forme permise
    "vttk_bon_a.org/ok.png"
  ].join(",") });
  egal("d'étiquettes truquées, une seule est retenue", nos().length, 1);
  egal("  et c'est la seule saine", nos()[0].name, "vttk-marqueur-vttk_bon_a.org/ok.png");

  /* ET PLUS RIEN N'EST ÉCRIT DANS LA CAMPAGNE au-delà de l'étiquette. C'était le
   * but depuis le début, et le document de partage en était la seule entorse. */
  const docs = pont.ctx.Campaign.handouts;
  egal("aucun document n'est créé dans la campagne", docs.length, 0);
  egal("  ni aucun abonnement à sa collection", docs._combien(), 0);
  t2.save({ statusmarkers: "" });

  /* ============================================================
   *   LES RÉGLAGES DANS SA BARRE, ET LES COULEURS QU'ON LUI PREND
   * ============================================================
   *
   * Le panneau s'ouvrait en cliquant l'icône du navigateur ; il s'ouvre
   * maintenant depuis la section VTTK. Ce n'est PAS une seconde interface : la
   * même page — popup/popup.html — est chargée dans un cadre. Une seule
   * définition de ce que l'extension propose, donc jamais deux qui divergent.
   *
   * ET IL NE DÉPEND D'AUCUN MODULE. C'est par lui qu'on les allume : un bouton
   * de réglages qui attendrait qu'un module soit allumé serait inutilisable au
   * premier démarrage. */
  const reg = docPont.body.querySelector(".vttk-outil-reglages");
  verifie("le bouton des réglages est là", !!reg);
  egal("  avec le glyphe « settings » de sa police",
    reg && reg.querySelector(".grimoire__roll20-icon")
      ? reg.querySelector(".grimoire__roll20-icon").textContent : null, "settings");
  verifie("  et il est dans la section VTTK",
    !!reg && reg.parentNode === docPont.body.querySelector(".upper-buttons"));

  reg.querySelector("button").declenche("click");
  const panneau = docPont.body.querySelector(".vttk-reglages");
  verifie("le presser ouvre le panneau", !!panneau && panneau.classList.contains("ouvert"));
  const cadre = panneau && panneau.querySelector("iframe");
  verifie("  qui n'est qu'un CADRE sur la page du panneau, pas une seconde interface",
    !!cadre && /panneau\/panneau\.html/.test(cadre.src), cadre && cadre.src);
  /* L'adresse vient de la NÔTRE : le pont a été injecté depuis
   * moz-extension://<identifiant>/page/pont.js, et cet identifiant change à
   * chaque installation. La page n'a pas accès à browser.runtime. */
  verifie("  dont l'adresse est tirée de celle du pont",
    !!cadre && cadre.src.indexOf("moz-extension://essai-vttinker/") === 0, cadre && cadre.src);

  /* ---------- COLLÉ À LA BARRE, MÊME HAUTEUR ----------
   *
   * La géométrie du plateau de narration de l'extension JJK, reprise telle
   * quelle : x = barre.right, y = barre.top, h = barre.height.
   *
   * Le premier jet alignait le panneau sur le BOUTON, qui est en bas de la
   * colonne — le panneau s'ouvrait donc en bas de la page, et il fallait aller
   * l'y chercher. La barre du modèle fait 44 × 1066 à l'origine, comme la
   * vraie. */
  /* L'ÉCART EST LE SIEN, PAS LE NÔTRE. Nos panneaux touchaient le bord droit de
   * sa colonne ; les siens ne le touchent pas. `.block-submenu`, le panneau qu'il
   * fait sortir de cette même colonne, est posé à `left: 60px` pour une colonne
   * large de 44 — mesuré sur une vraie partie. Seize pixels de jour, recopiés. */
  egal("le panneau est écarté de sa barre comme les siens (44 + 16)",
    panneau && panneau.style.left, "60px");
  /* ET IL EST ÉCARTÉ DU PLAFOND, du même témoin : `.block-submenu` est posé à
   * `top: 24px` pour une colonne dont le haut est à 0. Le premier correctif
   * n'avait recopié que l'écart horizontal, et le panneau touchait encore le haut
   * de l'écran — signalé aussitôt.
   *
   * La hauteur perd les DEUX jours, celui du haut et son pendant en bas : sans
   * quoi le panneau descendrait de vingt-quatre pixels sous le bord inférieur de
   * la colonne. 1066 − 2 × 24 = 1018. */
  egal("  et du plafond, comme les siens (24)", panneau && panneau.style.top, "24px");
  /* LA HAUTEUR EST PLAFONNÉE, PAS IMPOSÉE, et c'est un correctif.
   *
   * On la fixait à toute la colonne : le panneau faisait 1018 pixels pour 570
   * de contenu, quatre cent cinquante pixels de blanc sous la dernière ligne.
   * Ceux de Roll20 épousent leur contenu. Le contenu est dans une iframe, dont
   * la hauteur intérieure n'est pas lisible du dehors : c'est elle qui la dit,
   * par un message. Le plafond, lui, reste — il empêche un contenu long de
   * sortir de l'écran, et tient lieu de hauteur le temps qu'elle parle. */
  egal("    sa hauteur est plafonnée aux deux jours près", panneau && panneau.style.maxHeight, "1018px");

  /* Et quand le panneau dit sa hauteur, le pont la prend. */
  /* LE PANNEAU PARLE DEPUIS NOTRE ORIGINE, PAS DEPUIS CELLE DE ROLL20.
   *
   * C est un cadre d extension pose dans la page : son origine est
   * moz-extension://<identifiant>/, celle-la meme que le pont derive de sa
   * propre adresse. Le bus le postait avec l origine de Roll20 — un modele plus
   * pauvre que le vrai, qui aurait laisse passer la garde sans jamais
   * l eprouver. */
  const ORIGINE_NOTRE = "moz-extension://essai-vttinker";
  bus.posteDAilleurs({ ns: "vttinker", depuis: "panneau", type: "hauteur", hauteur: 570 }, ORIGINE_NOTRE);
  egal("    et il épouse la hauteur que le panneau annonce",
    panneau && panneau.style.height, "570px");
  bus.posteDAilleurs({ ns: "vttinker", depuis: "panneau", type: "hauteur", hauteur: 4000 }, ORIGINE_NOTRE);
  egal("      sans jamais dépasser le plafond", panneau && panneau.style.height, "1018px");

  /* ---------- LE THÈME SE LIT, IL NE SE DEVINE PAS ----------
   *
   * Son bascule `colorTheme` a été essayé : il fait passer son magasin de
   * « light » à « dark » sans qu'AUCUNE de ses variables CSS ne change ni que le
   * fond de sa barre bouge. Ces variables-là sont celles de la fiche de
   * personnage, pas de l'interface du plateau.
   *
   * On lit donc la couleur RENDUE de sa barre et on en déduit le mode par la
   * luminance. Le modèle porte les deux jeux mesurés : blanc / #333 en clair,
   * #171717 / #e6e6e6 en sombre. */
  egal("le thème est déduit de sa barre : claire ici, panneau clair",
    cadre && cadre.src.slice(-6), "#clair");
  egal("  et la couleur reposée sur nos boîtes est la sienne",
    panneau && panneau.style["--vttk-fond"], "rgb(255, 255, 255)");
  egal("    son texte aussi", panneau && panneau.style["--vttk-texte"], "rgb(51, 51, 51)");

  const busN = faisBus();
  const r20N = faisRoll20(false, true);
  const pontN = montePont(busN, r20N, { sombre: true });
  pontN.ctx.Campaign = faisCampagne(r20N.scene, [
    { id: "N1", left: 700, top: 910, width: 140, height: 140, statusmarkers: "" }
  ]);
  const regN = pontN.ctx.document.body.querySelector(".vttk-outil-reglages");
  verifie("sur une barre SOMBRE, le bouton est là aussi", !!regN);
  regN.querySelector("button").declenche("click");
  const panneauN = pontN.ctx.document.body.querySelector(".vttk-reglages");
  const cadreN = panneauN && panneauN.querySelector("iframe");
  egal("  et le panneau bascule en sombre", cadreN && cadreN.src.slice(-7), "#sombre");
  egal("  avec SES couleurs à lui", panneauN && panneauN.style["--vttk-fond"], "rgb(23, 23, 23)");
  egal("    et son texte", panneauN && panneauN.style["--vttk-texte"], "rgb(230, 230, 230)");

  /* ---------- LE REPLI, QUAND SA COLONNE N'EST PAS LÀ ----------
   *
   * Roll20 peut renommer une classe du jour au lendemain. Un module qui ne
   * trouve pas sa boîte ne doit pas disparaître en silence : il retombe sur une
   * palette qui tient debout toute seule, comme le fait déjà la commande de
   * zoom. Un banc qui n'exerce qu'un des deux chemins laisse l'autre pourrir. */
  const busR = faisBus();
  const r20R = faisRoll20(false, true);
  const pontR = montePont(busR, r20R, { toolbar: false });
  pontR.ctx.Campaign = faisCampagne(r20R.scene, [
    { id: "R1", left: 700, top: 910, width: 140, height: 140, statusmarkers: "" }
  ]);
  busR.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: PALETTE });
  const barreR = pontR.ctx.document.body.querySelector(".vttk-barre");
  verifie("sans colonne où se greffer, la palette existe quand même", !!barreR);
  verifie("  elle est flottante", !!barreR && /vttk-barre-flottante/.test(barreR.className),
    barreR && barreR.className);
  verifie("  et ouverte, puisqu'aucun bouton ne l'ouvrirait",
    !!barreR && barreR.classList.contains("ouvert"));
  egal("  et personne n'a greffé de bouton",
    pontR.ctx.document.body.querySelectorAll(".vttk-outil").length, 0);
}

/* ============================================================
 * 5. LE PANNEAU — le maillon qui n'avait jamais été éprouvé
 * ============================================================
 *
 * Tous les essais partaient jusqu'ici d'un stockage déjà rempli. Personne ne
 * vérifiait CE QUI LE REMPLIT. Or c'est par là que passe un utilisateur, et
 * c'est le seul endroit où une case peut ne commander rien du tout.
 *
 * Le faux DOM est celui de tout le banc (faisDom, plus haut) : un seul, sinon
 * l'un se met à mentir pendant que l'autre dit vrai. */
async function essaiPanneau() {
  titre("5. Le panneau : ce qu'il dessine, et ce qu'il écrit");

  const stock = {};
  const changeurs = [];
  const ctx = {
    console, JSON, Math, Object, Array, String, Number, Boolean, isFinite, parseInt,
    setTimeout, clearTimeout
  };
  ctx.window = ctx;
  ctx.top = ctx;
  ctx.location = { hash: "#clair", href: "moz-extension://essai/panneau/panneau.html" };
  /* LE PANNEAU ÉCOUTE « hashchange » : le pont réécrit le fragment quand Roll20
   * bascule de thème, et un cadre déjà chargé ne redemande rien. */
  ctx.window._e = {};
  ctx.addEventListener = function (t, f) { ctx.window._e[t] = f; };
  /* UN SEUL IDENTIFIANT, parce que la page n'a plus qu'un seul contenant. La
   * précédente en portait quatre — un en-tête, un avis, un pied — dont plus
   * rien ne reste : le panneau ne dit plus que ce qu'il commande. */
  ctx.document = faisDom({ ids: ["corps"] });
  ctx.browser = {
    runtime: { getManifest: () => manifeste },
    storage: {
      local: {
        get: (cles) => Promise.resolve(Object.fromEntries(
          (Array.isArray(cles) ? cles : [cles]).filter((k) => k in stock).map((k) => [k, stock[k]]))),
        set(o) {
          ctx._ecritures = (ctx._ecritures || 0) + 1;
          Object.assign(stock, o);
          const ch = {};
          Object.keys(o).forEach((k) => { ch[k] = { newValue: o[k] }; });
          changeurs.forEach((f) => f(ch, "local"));
        }
      },
      onChanged: { addListener(f) { changeurs.push(f); } }
    }
  };
  vm.createContext(ctx);
  /* L'ORDRE EST CELUI DE panneau.html, et il compte : le catalogue lit
   * VTT_LANGUE_DEFAUT, donc la langue passe d'abord. */
  vm.runInContext(lis("commun/langue.js"), ctx, { filename: "langue.js" });
  vm.runInContext(lis("commun/catalogue.js"), ctx, { filename: "catalogue.js" });
  vm.runInContext(lis("commun/marqueurs.js"), ctx, { filename: "marqueurs.js" });
  vm.runInContext(lis("panneau/panneau.js"), ctx, { filename: "panneau.js" });
  ctx.document._pret();
  await attends(30);

  const noeuds = ctx.document._tous;
  const parClasse = (c) => noeuds.filter((n) => (n.className || "").split(" ").indexOf(c) >= 0);

  /* ---------- UNE LIGNE PAR MODULE, ET RIEN AUTOUR ---------- */
  const noms = parClasse("r20-nom").map((n) => n.textContent);
  ctx.VTT_CATALOGUE.forEach(function (m) {
    verifie("le module « " + m.id + " » a sa ligne",
      noms.indexOf(ctx.vttMot(m.nom, "en")) >= 0, JSON.stringify(noms));
  });

  /* PLUS AUCUNE DESCRIPTION — c'est une demande explicite, et c'est le genre de
   * chose qui revient toute seule si personne ne la garde. Le catalogue ne doit
   * plus en porter, et le panneau ne doit plus en dessiner. */
  const avecResume = ctx.VTT_CATALOGUE.filter((m) => m.resume !== undefined);
  egal("aucun module ne porte de description", avecResume.length, 0,
    avecResume.map((m) => m.id).join(", "));
  egal("  et le panneau n'en dessine aucune", parClasse("carte-resume").length, 0);

  /* ---------- LES CONTRÔLES ---------- */
  const tousReglages = ctx.VTT_CATALOGUE.reduce((a, m) => a.concat(m.reglages || []), []);
  const numeriques = tousReglages.filter((r) => r.type === "nombre");
  const nombres = noeuds.filter((n) => n.tag === "input" && n.type === "number");
  egal("un champ par réglage numérique du catalogue", nombres.length, numeriques.length);
  egal("un interrupteur par module", parClasse("sw").length, ctx.VTT_CATALOGUE.length);

  /* LES FLÈCHES DU CHAMP NUMÉRIQUE SONT RETIRÉES, et le contrôle porte sur la
   * FEUILLE, seul endroit où elles se retirent : ce sont des pseudo-éléments
   * dessinés par le navigateur, aucun attribut ne les commande. Les deux
   * écritures sont nécessaires — la standard et celle de WebKit. */
  const feuille = fs.readFileSync(path.join(RACINE, "ui", "roll20.css"), "utf8");
  verifie("les flèches du champ numérique sont retirées (standard)",
    /appearance:\s*textfield/.test(feuille));
  verifie("  et celles de WebKit aussi",
    /-webkit-inner-spin-button[\s\S]{0,80}appearance:\s*none/.test(feuille));

  /* ---------- CE QU'ON ÉCRIT ---------- */
  const champMin = nombres[0], champMax = nombres[1];
  champMax.saisis("600");
  egal("saisir un maximum l'écrit dans le stockage", stock["reg:zoomMax"], 600);
  champMin.saisis("2");
  egal("saisir un minimum l'écrit aussi", stock["reg:zoomMin"], 2);

  /* LE COUPLE INVALIDE NE DOIT RIEN ÉCRIRE, ET LE PANNEAU DOIT LE DIRE.
   *
   * Le cas se construit, il ne se tombe pas dessus : la borne basse est
   * elle-même plafonnée à 100 et la haute plancherée à 100 par le catalogue,
   * si bien que le SEUL couple invalide atteignable est 100 contre 100. Un
   * premier essai saisissait « 900 » dans la borne basse et s'étonnait qu'elle
   * s'écrive : elle avait été ramenée à 100, qui est parfaitement valide. */
  const vivant = () => ctx.document.getElementById("corps");
  champMin.saisis("100");
  egal("la borne basse monte jusqu'à son plafond", stock["reg:zoomMin"], 100);
  const champMax2 = vivant().querySelectorAll("input").filter((n) => n.type === "number")[1];
  champMax2.saisis("100");
  egal("mais la haute ne peut pas la rejoindre", stock["reg:zoomMax"], 600);
  const err = vivant().querySelectorAll(".erreur")[0];
  verifie("  et le panneau le dit", !!err && !err.hidden && err.textContent.length > 0,
    err && String(err.textContent));

  /* ---------- LA PALETTE N'EST PAS ÉDITÉE ICI ----------
   *
   * L'ajout et la suppression sont dans la palette, sur la carte : c'est là
   * qu'on s'en sert, à côté des marqueurs de Roll20 et du jeton qu'on vise. Les
   * avoir aux deux endroits, ce serait deux formulaires à tenir d'accord — et
   * le jour où ils divergent, personne ne sait plus lequel dit vrai. */
  /* ON INTERROGE L'ARBRE VIVANT, et pas la liste de tout ce qui a existé.
   * « _tous » accumule chaque nœud jamais créé, y compris ceux que le panneau a
   * jetés en se redessinant — il se redessine à chaque écriture. Compter
   * là-dedans, c'est compter les fantômes. */
  egal("le panneau n'a aucun champ de texte",
    vivant().querySelectorAll("input").filter((n) => n.type === "text").length, 0);
  egal("  mais il dit où ça se passe", vivant().querySelectorAll(".marqueurs-ou").length, 1);
  egal("  et il montre ce qu'on a", vivant().querySelectorAll(".marqueurs-compte").length, 1);

  /* ---------- LE THÈME SUIT ROLL20 QUAND IL EST AUTOMATIQUE ----------
   *
   * Le même mot ne veut pas dire la même chose des deux côtés : dans la fenêtre
   * du navigateur, « automatique » suit le système ; ici, posé SUR une partie,
   * il suit Roll20 — dont le pont a déjà lu le thème et l'a écrit dans le
   * fragment de l'adresse du cadre. */
  const racineP = ctx.document.documentElement;
  egal("sur une partie claire, le panneau est en jour", racineP.getAttribute("data-theme"), "jour");
  ctx.location.hash = "#sombre";
  ctx.window._e && ctx.window._e.hashchange && ctx.window._e.hashchange();
  await attends(10);
  egal("  et il suit Roll20 quand il passe en sombre",
    racineP.getAttribute("data-theme"), "nuit");

  /* UN CHOIX PASSE DEVANT UNE DÉTECTION. */
  await ctx.browser.storage.local.set({ "reg:theme": "jour" });
  await attends(10);
  egal("mais un thème choisi passe devant", racineP.getAttribute("data-theme"), "jour");
  await ctx.browser.storage.local.set({ "reg:theme": "auto" });
  await attends(10);

  /* ---------- LES INTERRUPTEURS ---------- */
  const interrupteurs = vivant().querySelectorAll(".sw");
  interrupteurs[0].checked = false;
  interrupteurs[0].declenche("change");
  egal("l'interrupteur du module écrit mod:zoom", stock["mod:zoom"], false);

  return stock;
}

/* ============================================================
 * 6. LA FENÊTRE DE L'EXTENSION — quatre choses, et pas une de plus
 * ============================================================
 *
 * ELLE NE DOIT PLUS FAIRE CE QUE FAIT LE PANNEAU. Les deux surfaces étaient le
 * MÊME fichier : deux endroits pour un seul geste. Ce bloc garde la séparation
 * autant que le contenu — un module dessiné ici serait une régression, pas une
 * feature.
 */
async function essaiFenetre() {
  titre("6. La fenêtre de l'extension");

  const stock = {};
  const ctx = {
    console, JSON, Math, Object, Array, String, Number, Boolean, isFinite, parseInt,
    setTimeout, clearTimeout
  };
  ctx.window = ctx;
  ctx.top = ctx;
  ctx.location = { hash: "", href: "moz-extension://essai/popup/popup.html" };
  ctx.addEventListener = function () {};
  ctx.document = faisDom({ ids: ["actif", "langue", "mot-langue", "theme", "mot-theme", "version", "site", "soutien"] });
  ctx.browser = {
    runtime: { getManifest: () => manifeste },
    storage: {
      local: {
        get: (cles) => Promise.resolve(Object.fromEntries(
          (Array.isArray(cles) ? cles : [cles]).filter((k) => k in stock).map((k) => [k, stock[k]]))),
        set(o) { Object.assign(stock, o); }
      },
      onChanged: { addListener() {} }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(lis("commun/langue.js"), ctx, { filename: "langue.js" });
  vm.runInContext(lis("commun/catalogue.js"), ctx, { filename: "catalogue.js" });
  vm.runInContext(lis("popup/popup.js"), ctx, { filename: "popup.js" });
  ctx.document._pret();
  await attends(30);

  const noeuds = ctx.document._tous;
  const parClasse = (c) => noeuds.filter((n) => (n.className || "").split(" ").indexOf(c) >= 0);

  /* ---------- ELLE NE MONTRE AUCUN MODULE ---------- */
  egal("la fenêtre ne dessine aucun interrupteur de module", parClasse("sw").length, 0);
  egal("  ni aucun champ numérique",
    noeuds.filter((n) => n.tag === "input" && n.type === "number").length, 0);

  /* ---------- L'ANGLAIS EST LE DÉFAUT ---------- */
  egal("l'anglais est le défaut", ctx.vttDefauts()["reg:langue"], "en");
  egal("  et l'extension part allumée", ctx.vttDefauts()["reg:actif"], true);
  egal("l'intitulé de la langue est en anglais",
    ctx.document.getElementById("mot-langue").textContent, "Language");

  /* LE SÉLECTEUR PORTE CHAQUE LANGUE DANS SA PROPRE LANGUE. « French » écrit en
   * anglais ne se trouve pas quand on ne lit que le français — et c'est
   * exactement la situation de qui cherche ce sélecteur. */
  const sel = ctx.document.getElementById("langue");
  const options = sel.children.map((o) => o.textContent);
  egal("une option par langue", options.length, ctx.VTT_LANGUES.length);
  verifie("  chacune dans sa propre langue",
    options.indexOf("English") >= 0 && options.indexOf("Français") >= 0, JSON.stringify(options));

  /* ---------- CE QU'ON ÉCRIT ---------- */
  const inter = ctx.document.getElementById("actif");
  inter.checked = false;
  inter.declenche("change");
  egal("l'interrupteur général écrit reg:actif", stock["reg:actif"], false);

  sel.value = "fr";
  sel.declenche("change");
  egal("choisir une langue l'écrit", stock["reg:langue"], "fr");
  egal("  et la fenêtre change de langue sur-le-champ",
    ctx.document.getElementById("mot-langue").textContent, "Langue");

  /* ---------- LE THÈME ----------
   *
   * « AUTOMATIQUE » NE POSE AUCUN ATTRIBUT, et c'est toute la subtilité : c'est
   * la seule façon que « prefers-color-scheme » puisse encore décider. Poser
   * « jour » ou « nuit » dans ce cas reviendrait à supprimer l'automatique tout
   * en gardant son nom. */
  const racine = ctx.document.documentElement;
  egal("l'automatique est le défaut", ctx.vttDefauts()["reg:theme"], "auto");
  verifie("  et il ne pose aucun attribut", !racine.getAttribute("data-theme"));

  const th = ctx.document.getElementById("theme");
  egal("une option par thème", th.children.length, ctx.VTT_THEMES.length);
  th.value = "nuit";
  th.declenche("change");
  egal("choisir la nuit l'écrit", stock["reg:theme"], "nuit");
  egal("  et pose l'attribut", racine.getAttribute("data-theme"), "nuit");
  th.value = "jour";
  th.declenche("change");
  egal("  le jour aussi, explicitement", racine.getAttribute("data-theme"), "jour");
  th.value = "auto";
  th.declenche("change");
  verifie("  et l'automatique le retire", !racine.getAttribute("data-theme"));

  /* LA FEUILLE DOIT SAVOIR LES TROIS. Une couleur définie seulement dans un
   * bloc conditionnel manquerait dans l'autre : les trois écritures portent les
   * mêmes clés, et le garde « :not([data-theme=jour]) » est ce qui permet de
   * choisir le jour sur un système en sombre. */
  const feuille = fs.readFileSync(path.join(RACINE, "ui", "roll20.css"), "utf8");
  verifie("la feuille connaît la nuit explicite", /\[data-theme="nuit"\]/.test(feuille));
  verifie("  et la préférence du navigateur", /prefers-color-scheme:\s*dark/.test(feuille));
  verifie("  avec le garde qui laisse choisir le jour",
    /:root:not\(\[data-theme="jour"\]\)/.test(feuille));

  /* ---------- LES DEUX BOUTONS SONT PRÉPARÉS ET N'OUVRENT RIEN ---------- */
  const site = ctx.document.getElementById("site");
  const soutien = ctx.document.getElementById("soutien");
  verifie("le bouton du site existe et porte un intitulé", site.textContent.length > 0);
  verifie("  celui du soutien aussi", soutien.textContent.length > 0);
  verifie("  et leur infobulle dit qu'ils ne mènent nulle part",
    /venir/.test(site.title) && /venir/.test(soutien.title), site.title);

  return stock;
}

/* ---------- LE CATALOGUE D'ÉMOJIS, CONFRONTÉ À LA SOURCE ----------
 *
 * TOUT SE JOUE SUR UNE PHRASE : « des émojis que tout le monde peut voir, même
 * ceux sans l'extension ». Un émoji Unicode part dans le message comme une
 * lettre — mais tous ne se valent pas devant cette promesse.
 *
 * CE BLOC NE RAISONNE PAS, IL COMPARE. Deux affirmations avaient été écrites de
 * mémoire ; l'une était fausse sur soixante-treize entrées, et le découpage en
 * catégories était improvisé. On lit donc emoji-test.txt, la table officielle
 * d'UTS #51, gardée telle quelle dans outils/ avec sa notice : elle porte pour
 * chaque émoji son GROUPE, sa VERSION d'apparition et son état de
 * QUALIFICATION. Plus rien de tout cela n'est affirmé de mémoire.
 */
function essaiEmojis() {
  titre("8. Le catalogue d'émojis, contre la table officielle");

  const ctx = { console, JSON, Math, Object, Array, String, Number, Boolean };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(lis("commun/langue.js"), ctx, { filename: "langue.js" });
  vm.runInContext(lis("commun/emojis.js"), ctx, { filename: "emojis.js" });

  /* ---------- la source ----------
   * RACINE désigne le dossier de l'extension : la table, elle, est un outil de
   * développement et n'a rien à faire dans ce qui part chez l'utilisateur. */
  const brut = fs.readFileSync(path.join(RACINE, "..", "outils", "emoji-test.txt"), "utf8");
  const table = new Map();
  let version = "", groupe = "";
  brut.split(/\r?\n/).forEach(function (l) {
    let m = l.match(/^#\s*Version:\s*(.+)$/);
    if (m && !version) { version = m[1].trim(); return; }
    m = l.match(/^#\s*group:\s*(.+)$/);
    if (m) { groupe = m[1].trim(); return; }
    m = l.match(/^([0-9A-F ]+);\s*([a-z-]+)\s*#\s*(\S+)\s+E([0-9.]+)\s+(.*)$/);
    if (!m) { return; }
    const car = m[1].trim().split(/\s+/).map(function (h) { return String.fromCodePoint(parseInt(h, 16)); }).join("");
    if (!table.has(car)) { table.set(car, { etat: m[2], v: parseFloat(m[4]), groupe: groupe, nom: m[5] }); }
  });
  verifie("la table officielle se lit (" + table.size + " entrées, UTS #51 v" + version + ")", table.size > 3000);

  const cats = ctx.VTT_EMOJIS;
  const tous = [];
  cats.forEach(function (c) {
    /* CHAQUE ENTRÉE PORTE DEUX NOMS depuis que la langue est un réglage :
     * celui d'Unicode, lu dans la table, et le nôtre. On garde les deux. */
    c.liste.forEach(function (e) {
      tous.push({ cat: c.id, groupe: c.officiel, car: e[0], nom: e[1], nomFr: e[2] });
    });
  });
  verifie("le catalogue n'est pas vide", tous.length > 0);

  /* ---------- LES CATÉGORIES SONT CELLES D'UNICODE ----------
   *
   * C'est LA vérification qui manquait, et elle vaut toutes les autres : un
   * émoji rangé ailleurs que dans son groupe officiel, et l'on est revenu à un
   * classement maison sans que personne ne s'en aperçoive. */
  const groupesConnus = new Set();
  table.forEach(function (o) { groupesConnus.add(o.groupe); });
  const inventees = cats.filter(function (c) { return !groupesConnus.has(c.officiel); });
  egal("chaque catégorie porte un groupe officiel", inventees.length, 0,
    inventees.map(function (c) { return c.id + " → " + c.officiel; }).join(", "));

  const malRanges = tous.filter(function (e) {
    const o = table.get(e.car);
    return o && o.groupe !== e.groupe;
  });
  egal("chaque émoji est dans SON groupe officiel", malRanges.length, 0,
    malRanges.slice(0, 8).map(function (e) {
      return e.nom + " (" + e.cat + " au lieu de " + table.get(e.car).groupe + ")";
    }).join(", "));

  /* L'ORDRE AUSSI EST LE SIEN. Le catalogue est engendré depuis la table ; s'il
   * était un jour retouché à la main, l'ordre serait la première chose à
   * partir, et c'est celui que tous les autres claviers d'émojis emploient. */
  const ordre = [];
  table.forEach(function (o, car) { ordre.push(car); });
  const rang = new Map();
  ordre.forEach(function (car, i) { rang.set(car, i); });
  const desordres = [];
  cats.forEach(function (c) {
    for (let i = 1; i < c.liste.length; i++) {
      const a = rang.get(c.liste[i - 1][0]), b = rang.get(c.liste[i][0]);
      if (a !== undefined && b !== undefined && a > b) { desordres.push(c.id + " : " + c.liste[i][1]); }
    }
  });
  egal("l'ordre est celui de la table", desordres.length, 0, desordres.slice(0, 6).join(", "));

  /* Les drapeaux sont le seul groupe absent, et c'est la règle des séquences
   * composées qui l'exclut — pas un oubli. On l'écrit pour que le jour où
   * quelqu'un les ajouterait, le contrôle proteste. */
  const aDesDrapeaux = cats.some(function (c) { return c.officiel === "Flags"; });
  verifie("le groupe des drapeaux reste absent", !aDesDrapeaux);

  /* ---------- CE QUE LA SOURCE DIT DE CHAQUE CARACTÈRE ---------- */
  const inconnus = tous.filter(function (e) { return !table.has(e.car); });
  egal("chaque émoji existe dans la table", inconnus.length, 0,
    inconnus.slice(0, 8).map(function (e) { return e.nom; }).join(", "));

  /* « minimally-qualified » veut dire qu'il MANQUE un sélecteur de
   * présentation. C'est exactement l'erreur que la règle inventée produisait,
   * et la table la nomme sans qu'on ait rien à déduire. */
  const malQualifies = tous.filter(function (e) {
    const o = table.get(e.car); return o && o.etat !== "fully-qualified";
  });
  egal("chaque émoji est pleinement qualifié", malQualifies.length, 0,
    malQualifies.slice(0, 8).map(function (e) { return e.nom + " (" + table.get(e.car).etat + ")"; }).join(", "));

  const tropRecents = tous.filter(function (e) {
    const o = table.get(e.car); return o && o.v > 12.0;
  });
  egal("rien de postérieur à Unicode 12", tropRecents.length, 0,
    tropRecents.slice(0, 8).map(function (e) { return e.nom + " E" + table.get(e.car).v; }).join(", "));

  /* ---------- CE QUI SE DÉCOMPOSE CHEZ LES AUTRES ----------
   * Une séquence composée se rend en DEUX OU TROIS dessins à la suite sur un
   * poste qui ne la connaît pas : le message dit alors autre chose que ce qu'on
   * a écrit, ce qui est pire qu'un caractère manquant. */
  const composes = tous.filter(function (e) { return Array.from(e.car).length > 2; });
  egal("aucune séquence composée", composes.length, 0);
  const liants = tous.filter(function (e) { return e.car.indexOf("\u200D") >= 0; });
  egal("aucun liant de largeur nulle", liants.length, 0);
  const teintes = tous.filter(function (e) {
    return Array.from(e.car).some(function (c) {
      const n = c.codePointAt(0); return n >= 0x1F3FB && n <= 0x1F3FF;
    });
  });
  egal("aucune teinte de peau", teintes.length, 0);

  /* ---------- CE QUI SE VOIT TOUT DE SUITE ---------- */
  const sansOnglet = cats.filter(function (c) { return !c.onglet || !c.nom || !c.liste.length; });
  egal("chaque catégorie a un onglet, un nom et des entrées", sansOnglet.length, 0);

  const vus = {}, doubles = [];
  tous.forEach(function (e) { if (vus[e.car]) { doubles.push(e); } vus[e.car] = 1; });
  egal("aucun doublon", doubles.length, 0,
    doubles.slice(0, 6).map(function (e) { return e.cat + "/" + e.nom; }).join(", "));

  const anonymes = tous.filter(function (e) {
    return !e.nom || !String(e.nom).trim() || !e.nomFr || !String(e.nomFr).trim();
  });
  egal("chaque émoji porte un nom dans les deux langues", anonymes.length, 0,
    anonymes.slice(0, 6).map(function (e) { return e.car; }).join(" "));

  /* ET LE NOM ANGLAIS EST CELUI DE LA TABLE, pas une traduction faite à la
   * main. C'est la même source que le groupe et l'ordre : un nom qui en
   * divergerait désignerait autre chose que ce qu'Unicode désigne. */
  const nomsFaux = tous.filter(function (e) {
    const o = table.get(e.car);
    return o && o.nom !== e.nom;
  });
  egal("le nom anglais est celui de la table", nomsFaux.length, 0,
    nomsFaux.slice(0, 4).map(function (e) { return e.nom + " ≠ " + table.get(e.car).nom; }).join(", "));

  verifie("et le choix de la langue rend le bon",
    ctx.vttEmojiNom(cats[0].liste[0], "fr") === cats[0].liste[0][2] &&
    ctx.vttEmojiNom(cats[0].liste[0], "en") === cats[0].liste[0][1]);

  /* UN CARACTÈRE DE REMPLACEMENT SIGNIFIE QUE LE FICHIER A ÉTÉ MAL RELU, et ce
   * n'est pas une hypothèse d'école : l'encodage s'est déjà perdu deux fois sur
   * ce poste, en passant par un outil qui croyait bien faire. */
  const perdus = tous.filter(function (e) { return (e.car + e.nom).indexOf("\uFFFD") >= 0; });
  egal("aucun caractère de remplacement", perdus.length, 0);

  /* Le garde-fou grossier de l'extension doit au moins laisser passer tout le
   * catalogue : s'il refuse ce que la table accepte, c'est lui qui a tort. */
  const malFormes = tous.filter(function (e) { return !ctx.vttEmojiBienForme(e.car); });
  egal("le garde-fou accepte tout le catalogue", malFormes.length, 0,
    malFormes.slice(0, 6).map(function (e) { return e.nom; }).join(", "));

  verifie("il refuse une séquence composée", !ctx.vttEmojiBienForme("\uD83E\uDDD1\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1"));
  verifie("il refuse une teinte de peau", !ctx.vttEmojiBienForme("\uD83D\uDC4D\uD83C\uDFFD"));
  verifie("il refuse le vide", !ctx.vttEmojiBienForme(""));
  verifie("il refuse ce qui n'est pas une chaîne", !ctx.vttEmojiBienForme(null));

  cats.forEach(function (c) {
    console.log("     " + c.onglet + "  " + c.id.padEnd(11) + " " +
      String(c.liste.length).padStart(3) + "   " + c.officiel);
  });
  console.log("     " + tous.length + " émojis en " + cats.length + " groupes officiels");
}

/* ---------- CE QU'ON S'INTERDIT D'ÉCRIRE ----------
 *
 * Un contrôle de SOURCE, et il en faut au moins un : certaines fautes ne se
 * voient ni à l'exécution ni à l'œil, seulement au chronomètre d'une vraie
 * partie. Les laisser revenir parce que le banc ne sait pas les nommer, c'est
 * accepter de repayer six mesures.
 */
function essaiInterdits() {
  titre("9. Ce qu'on s'interdit d'écrire");

  const pont = lis("page/pont.js");
  const sansCommentaires = pont
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  /* ---------- « $subscribe » SUR UN MAGASIN DE ROLL20 ----------
   *
   * MESURÉ, et c'est la correction la plus chère de ce dépôt. Le même
   * « $patch » sur son magasin « engine » :
   *
   *     rien d'attaché ................................    0 ms
   *     un $subscribe au rappel VIDE ..................  555 ms
   *     le même, retiré ...............................    0 ms
   *
   * Le rappel ne fait RIEN : ce n'est pas ce qu'il fait qui coûte, c'est
   * l'abonnement. « $subscribe » de Pinia installe un observateur PROFOND sur
   * l'état du magasin ; sur « engine », qui porte l'état de toute la scène,
   * chaque mutation en parcourt le graphe entier. À l'usage : l'activation du
   * module coûtait 3 349 ms, et dix crans de molette en bloquaient 8 426.
   *
   * On relit la valeur à l'horloge. C'est moins élégant et mille fois moins
   * cher. */
  const abonnements = sansCommentaires.split("$subscribe").length - 1;
  egal("aucun « $subscribe » sur un magasin de Roll20", abonnements, 0,
    "voir le commentaire de veille() dans le pont — un observateur profond sur « engine » coûte 555 ms par mutation");

  /* Et l'horloge, elle, doit être là : supprimer l'abonnement SANS la poser
   * laisserait la commande afficher un chiffre faux dès que Roll20 zoome de son
   * côté, et la caméra sans personne pour la reposer hors de sa plage. */
  verifie("l'horloge de relevé du zoom est en place", /function veille\(\)/.test(pont));
  verifie("elle s'arrête avec le module", /function arreteVeille\(\)/.test(pont));

  /* ---------- L'OBSERVATEUR DE TÂCHES LONGUES DE CHROME ----------
   * Firefox ne connaît pas « longtask » : l'appel ne lève rien et n'observe
   * jamais rien. Une sonde qui s'en sert rend des colonnes de zéros
   * rassurantes et creuses — c'est arrivé, et ça a coûté deux passages. */
  const pilote = fs.readFileSync(path.join(RACINE, "..", "outils", "pilote.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  verifie("aucune sonde ne guette « longtask », que Firefox ignore",
    pilote.indexOf("longtask") < 0);
}

/* ---------- LES QUATRE MONDES ----------
 *
 * Roll20 en sert DEUX, et le rôle en fait quatre :
 *
 *                    Jumpgate            héritage
 *     MJ             .................   .....................
 *     joueur         .................   .....................
 *
 * L'extension ne connaissait que la colonne de gauche. Sur une campagne
 * d'héritage elle DISPARAISSAIT ENTIÈRE — pas de bouton, pas de panneau, pas de
 * pied de chat —, et le seul symptôme visible était « je n'ai accès à rien ».
 *
 * Trois causes, toutes mesurées sur une vraie partie, toutes gardées ici.
 */
function essaiHeritage() {
  titre("10. Les quatre mondes : Jumpgate et héritage");

  /* ---------- 1. LA SECTION SE POSE MÊME SANS MODÈLE TITRÉ ---------- */
  const bus = faisBus();
  const r20 = faisRoll20(false, true);
  const pont = montePont(bus, r20, { heritage: true });
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: [] });

  const doc = pont.ctx.document;
  const entetes = doc.body.querySelectorAll(".spacer-header");
  const nos = doc.body.querySelectorAll(".vttk-outil-titre");
  verifie("sur une colonne SANS section titrée, la nôtre se pose quand même",
    nos.length === 1, "trouvé " + nos.length);
  verifie("  et elle porte son intitulé",
    nos.length > 0 && /VTTK/.test(nos[0].textContent), nos.length ? nos[0].textContent : "");
  verifie("  donc le bouton des marqueurs existe",
    doc.body.querySelectorAll(".vttk-outil-marqueurs").length === 1);
  verifie("  et celui des réglages aussi",
    doc.body.querySelectorAll(".vttk-outil-reglages").length === 1);
  egal("  l'intitulé qu'on a fabriqué est le SEUL de la colonne", entetes.length, 1);

  /* ---------- 2. L'INTITULÉ DU CHAT S'ÉCRIT AUSSI « As: » ----------
   *
   * Sur une campagne d'héritage, Roll20 n'écrit ni « En tant que » ni
   * « Speaking as » : simplement « As: ». Le module cherchait les deux premiers
   * et ne trouvait rien — la ligne « À : » ne se posait jamais, et tout le pied
   * de chat avec elle. Le contrôle porte sur la SOURCE : le motif est la seule
   * chose qui décide, et il n'est joignable que là. */
  const chat = lis("contenu/modules/chat.js");
  const motif = chat.match(/\/\^\(En tant que[^/]*\/i/);
  verifie("le module de chat reconnaît « En tant que »", !!motif && /En tant que/.test(motif[0]));
  verifie("  « Speaking as » aussi", !!motif && /Speaking as/.test(motif[0]));
  verifie("  et « As », celui de l'héritage", !!motif && motif[0].indexOf("|As") >= 0,
    motif ? motif[0] : "motif introuvable");

  /* ---------- 3. LE PONT SAIT DIRE QUEL MOTEUR DESSINE ----------
   *
   * Et il ne le déduit ni de « #babylonCanvas », ni de Pinia, ni de
   * « currentPlayer.d20 » : les trois existent DES DEUX CÔTÉS, mesuré. Seul
   * « MeshScene » n'est là que sous Jumpgate. */
  const source = lis("page/pont.js");
  verifie("le pont reconnaît le moteur", /function moteurDeRoll20\(\)/.test(source));
  verifie("  par MeshScene, et pas par la toile",
    /window\.MeshScene[\s\S]{0,60}return "jumpgate"/.test(source));
  verifie("  il rend « inconnu » plutôt que de parier",
    /return "inconnu";/.test(source));
  verifie("  et il attend de savoir avant de l'annoncer",
    /tours < 30/.test(source));
}

/* ---------- LES TROIS MODULES PORTÉS SUR L'ANCIEN MOTEUR ----------
 *
 * Trois modules ne marchaient que sous Jumpgate, parce que les trois passaient
 * par Babylon : les bornes du zoom, les marqueurs dessinés, la grille hors
 * carte. Ils ont été portés, et chacun l'a été SUR UNE MESURE — pas sur une
 * lecture de code, pas sur une analogie avec l'autre moteur.
 *
 * Ce bloc ne rejoue pas les mesures : elles demandent une vraie partie. Il
 * garde ce que les mesures ont CONCLU, là où une réécriture innocente le
 * défferait sans que rien ne le dise.
 */
function essaiHeritagePeint() {
  titre("11. Les trois modules portés sur l'ancien moteur");
  const pont = lis("page/pont.js");

  /* ---------- 1. L'AIGUILLAGE, ET SES QUATRE PORTES ----------
   *
   * Le magasin « engine » de Pinia EXISTE en héritage, mais il est VIDE : ni
   * zoom, ni setZoom, ni stepAdjustZoom. Une branche qui l'interrogerait ne
   * lèverait donc pas — elle rendrait `null` en silence, et le module aurait
   * l'air éteint. D'où l'aiguillage AVANT toute lecture de magasin. */
  verifie("le pont sait s'il est sur l'ancien moteur",
    /function surLancienMoteur\(\)\s*\{\s*return moteurDeRoll20\(\) === "heritage"/.test(pont));
  ["installe", "retire", "pose", "pasZoom"].forEach(function (n) {
    const bloc = pont.slice(pont.indexOf("  function " + n + "("));
    /* LA FENÊTRE VA JUSQU'À LA PREMIÈRE LECTURE DE MAGASIN, et pas à un nombre
       d'octets choisi au hasard : « pose » porte vingt lignes de commentaire
       avant son garde, et une fenêtre de 700 les prenait pour tout le corps. */
    const jusqu = bloc.indexOf("magasin(\"engine\")");
    verifie("  « " + n + " » aiguille vers le module hérité",
      jusqu > 0 && /surLancienMoteur\(\)\s*\)\s*\{\s*return ZH\./.test(bloc.slice(0, jusqu)),
      "aucun aiguillage avant la première lecture de magasin");
  });

  /* ---------- 2. L'UNITÉ, QUI VAUT UN FACTEUR CENT ----------
   *
   * « canvasZoom » vaut 1 à cent pour cent, là où le magasin de Jumpgate porte
   * 100. Le module parle en pour cent partout et ne divise qu'au dernier moment
   * — écrire « canvasZoom = 400 » mettrait la carte à quarante mille. */
  verifie("le zoom hérité lit canvasZoom en pour cent",
    /return Math\.round\(e\.canvasZoom \* 100\);/.test(pont));
  verifie("  et il n'écrit jamais canvasZoom sans diviser",
    !/e\.canvasZoom = p[;\s]/.test(pont) && /var z = p \/ 100/.test(pont));

  /* ---------- 3. IL REFAIT SON TRAVAIL, ET DANS SON ORDRE ----------
   *
   * Son setZoom borne par un import interne, hors d'atteinte. Tout ce qu'il
   * fait ENSUITE a été lu dans sa source et doit être refait à notre valeur :
   * le rapport aux contextes 2D, le miroir, sa couche WebGL, les coordonnées
   * des objets, le redessin. En oublier un donne une carte juste et un état de
   * travers — ou l'inverse. */
  [["contextTop.scale", /contextTop\.scale\(r, r\)/],
   ["contextContainer.scale", /contextContainer\.scale\(r, r\)/],
   ["final_canvas_ctx.scale", /final_canvas_ctx\.scale\(r, r\)/],
   ["les toiles de travail", /w\[k\]\.context\.scale\(r, r\)/],
   ["le miroir tabletopState", /magasin\("vttTools_tabletopState"\)/],
   ["sa couche WebGL", /gl\.updateGlSize\(\)/],
   ["les coordonnées des objets", /forEachObject\(function \(o\) \{ o\.setCoords\(\); \}\)/],
   ["le redessin", /redrawScreenNextTick/]
  ].forEach(function (x) {
    verifie("  hors plage, il refait " + x[0], x[1].test(pont));
  });
  verifie("  et le rapport se calcule depuis canvasZoom, pas depuis notre valeur",
    /var r = z \/ cz;/.test(pont));

  /* ---------- 4. L'ÉVÉNEMENT EST À NOUS DÈS QU'IL SE COMPORTERAIT MAL ----------
   *
   * Mesuré : bornes 10–800, zoom à 800, un cran vers le haut ramenait la carte
   * à 250 %. L'écouteur voyait sa propre borne et renonçait SANS AVALER
   * l'événement — Roll20 le recevait alors et bornait. Le défaut dormait dans
   * les DEUX modules ; la coupure doit précéder les tests de nos bornes. */
  [["surMolette", "bornes", "bloqueParRoll20"], ["surMoletteH", "bornesH", "bloqueH("]].forEach(function (x) {
    /* IL Y EN A DEUX QUI S'APPELLENT « surMolette » : celle de l'écoute passive,
       qui ne fait que compter pour la reconnaissance, et celle du module. On ne
       prend pas la première venue — on prend celle qui interroge la borne. */
    let i = -1, k = -1;
    while ((k = pont.indexOf("function " + x[0] + "(", k + 1)) >= 0) {
      if (pont.slice(k, k + 3000).indexOf(x[2]) > 0) { i = k; break; }
    }
    const bloc = i < 0 ? "" : pont.slice(i, i + 3000);
    const coupe = bloc.indexOf("stopImmediatePropagation");
    const notre = bloc.indexOf("a >= " + x[1] + ".max");
    verifie("« " + x[0] + " » avale l'événement AVANT de regarder nos bornes",
      coupe > 0 && notre > 0 && coupe < notre,
      "coupure en " + coupe + ", notre borne en " + notre);
  });

  /* ---------- 5. UNE SEULE SOURCE POUR LE ZOOM HÉRITÉ ----------
   *
   * Une copie a existé, et elle s'est périmée : quand Roll20 a repris la main à
   * 250 %, elle disait encore 800, et le cran suivant est reparti de 800. Ici
   * c'est nous qui écrivons canvasZoom : il dit toujours ce que la carte
   * montre. */
  verifie("le zoom hérité ne garde aucune copie de la valeur", !/horsH/.test(pont));

  /* ---------- 6. LE CALQUE ----------
   *
   * Aucune surface de Roll20 ne convenait : sa toile visible est en WebGL, et
   * ses deux canevas Fabric sont HORS DU DOCUMENT — on a perdu deux essais à
   * peindre dedans, sans erreur et sans rien voir. Le calque est à nous, et il
   * ne touche à rien de son rendu. */
  verifie("le calque est une toile à nous", /el\.id = "vttk-calque"/.test(pont));
  verifie("  qui ne reçoit aucun clic", /pointer-events:none/.test(pont));
  verifie("  et qui disparaît quand plus personne ne peint",
    /if \(!peintres\.length && !garde\) \{ demonte\(\); \}/.test(pont));
  verifie("  le pont ne peint JAMAIS dans les contextes de Fabric",
    !/cv\.contextContainer\.(fillRect|drawImage|strokeRect)/.test(pont) &&
    !/lowerCanvasEl\.getContext/.test(pont));
  verifie("  la conversion est (page − décalage) × zoom",
    /\(v\.zoom\)?[\s\S]{0,4}- v\.ox\) \* v\.zoom/.test(pont) ||
    /- v\.ox\) \* v\.zoom/.test(pont));

  /* ---------- 7. LES PEINTRES SONT ORDONNÉS ----------
   *
   * La grille passe SOUS les marqueurs, comme chez lui où elle passe sous les
   * jetons. Un objet les rangeait dans l'ordre d'allumage des modules, qui n'a
   * rien à voir avec un ordre de dessin. */
  verifie("les peintres se rangent par rang", /peintres\.sort\(function \(a, b\) \{ return a\.rang - b\.rang; \}\)/.test(pont));
  verifie("  la grille a le rang 0", /CALQUE\.inscris\("grille", peins, 0\)/.test(pont));
  verifie("  les marqueurs le rang 1", /CALQUE\.inscris\("marqueurs", peins, 1\)/.test(pont));
  verifie("  et la transformation est remise après CHAQUE peintre",
    /catch \(e\) \{ window\.__vttinkerCalqueErreur[\s\S]{0,200}setTransform\(1, 0, 0, 1, 0, 0\)/.test(pont));

  /* ---------- 8. LES MARQUEURS N'INVENTENT AUCUNE CONSTANTE ----------
   *
   * Sa rangée a été relevée AU PIXEL sur l'ancien moteur — pas déduite de
   * l'autre. Les pas mesurés (19,4 / 13,0 / 7,9 / 5,6 pour 2, 3, 5 et 7
   * marqueurs) tombent au demi pour cent sur « 22 × min(1, largeur / 22n) »,
   * c'est-à-dire exactement la loi de repli de Jumpgate. Les trois constantes
   * valent donc pour les deux moteurs, et un module qui en redéfinirait une
   * romprait cet accord sans que rien ne le dise. */
  const mh = pont.slice(pont.indexOf("var MH = (function ()"), pont.indexOf("var GH = (function ()"));
  verifie("le peintre des marqueurs emploie les constantes partagées",
    /MARQUEUR_COTE \* ech/.test(mh) && /MARQUEUR_PAS \* ech/.test(mh) && /MARQUEUR_BORD \* ech/.test(mh));
  verifie("  il n'en redéfinit aucune",
    !/var MARQUEUR_(COTE|PAS|BORD)/.test(mh));
  verifie("  sa loi d'échelle est celle de Roll20",
    /Math\.min\(1, g\.l \/ \(MARQUEUR_PAS \* part\.sien\)\)/.test(mh));
  verifie("  la rangée se remplit de droite à gauche",
    /var caseNo = part\.sien \+ \(k - 1 - j\);/.test(mh));
  verifie("  il préfère l'objet de canevas au modèle, pour suivre un jeton traîné",
    /function ouEst\(objets, t\)/.test(mh) && /o\.left !== undefined/.test(mh));
  verifie("  et il ne dessine pas hors de la toile",
    /sx \+ cEcran < 0 \|\| sy \+ cEcran < 0/.test(mh));

  /* ---------- 8 bis. CE QUI SE REFAIT CENT QUATRE-VINGTS FOIS PAR SECONDE ----------
   *
   * Mesuré sur une vraie partie : avec deux jetons et AUCUN marqueur à nous, le
   * peintre coûtait 0,11 ms par trame — il payait pour ne rien dessiner. Il
   * parcourait tous les objets du canevas avant de savoir s'il aurait quoi que
   * ce soit à peindre, et il redécoupait « statusmarkers » à chaque trame, pour
   * chaque jeton, alors que cette chaîne ne change qu'à la pose d'un marqueur.
   *
   * Après : 0,127 ms contre 0,137 pour la grille seule, c'est-à-dire dans le
   * bruit. Le pire cas — tous les jetons marqués — est passé de 5,95 % à 3,45 %
   * d'un cœur, et les images du navigateur tiennent (181 → 176). */
  verifie("  le parcours des objets est PARESSEUX", /var objets = null;/.test(mh) &&
    /if \(!objets\) \{ objets = objetsParModele\(v\.d20\); \}/.test(mh));
  verifie("  le découpage de statusmarkers est retenu par chaîne",
    /function partageRetenu\(brut\)/.test(mh) && /var part = partageRetenu\(brut\);/.test(mh));
  verifie("    et la mémoire se vide quand le catalogue change",
    /partages = \{\};   \/\/ le catalogue a pu changer/.test(mh));
  verifie("    elle ne grossit pas indéfiniment", /if \(nb > 200\) \{ partages = \{\}; \}/.test(mh));
  verifie("  un jeton sans marqueur ne coûte qu'un test", /if \(!brut\) \{ return; \}/.test(mh));

  /* LE COMPTEUR DE TRAME. « Je veux un outil optimisé » ne se vérifie pas en
   * relisant du code : il faut pouvoir demander un chiffre, et le calque doit
   * donc en tenir un — comme le zoom tient les siens. */
  verifie("le calque compte ce qu'il coûte",
    /window\.__vttinkerCalque = \{ trames: 0, ms: 0, max: 0 \}/.test(pont));

  /* ---------- 9. LA GRILLE : C'EST SON drawGrid QUI DESSINE ----------
   *
   * « drawGrid » prend un contexte 2D et aiguille lui-même sur les cinq types
   * de grille. On lui donne le nôtre : rien à réimplémenter, rien à faire
   * coïncider. Trois choses mesurées le rendent possible, et chacune se garde :
   * elle ne se borne pas à la carte, elle dessine en coordonnées de page, et le
   * découpage se pose avant la transformation. */
  const gh = pont.slice(pont.indexOf("var GH = (function ()"), pont.indexOf("var MH = (function ()") > 0
    ? pont.indexOf("function installeMarqueurs") : pont.length);
  verifie("la grille héritée appelle SON drawGrid", /o\.drawGrid\(ctx\)/.test(gh));
  verifie("  elle lui donne l'échelle du zoom", /ctx\.setTransform\(z, 0, 0, z, 0, 0\)/.test(gh));
  verifie("  le découpage se pose AVANT la transformation",
    gh.indexOf("ctx.clip(\"evenodd\")") > 0 &&
    gh.indexOf("ctx.clip(\"evenodd\")") < gh.indexOf("ctx.setTransform(z"));
  verifie("  il garde tout SAUF le rectangle de la page",
    /ctx\.rect\(\(0 - v\.ox\) \* z, \(0 - v\.oy\) \* z, L \* z, H \* z\)/.test(gh));
  verifie("  sans grille chez lui, elle ne peint rien",
    /if \(!pg\.get\("showgrid"\)[\s\S]{0,60}return; \}/.test(gh));
  verifie("  et le pas vient de SON snapTo", /var s = d\.engine \? d\.engine\.snapTo : 0;/.test(gh));

  /* ---------- 10. L'ÉCOUTEUR AIGUILLE AUSSI ---------- */
  verifie("l'écouteur aiguille les marqueurs",
    /if \(surLancienMoteur\(\)\) \{\s*\n\s*var rh = MH\.installe\(\);/.test(pont));
  verifie("  et la grille, sans le délai de Babylon",
    /var rh = \(d\.actif === false\) \? GH\.retire\(\) : GH\.pose\(d\.cases\);/.test(pont));
  verifie("  l'extinction des marqueurs raye le peintre dans les DEUX cas",
    /marqueursActif = false;[\s\S]{0,400}MH\.retire\(\);/.test(pont));
}

/* ---------- D'OÙ VIENT UN MESSAGE ----------
 *
 * Le protocole ne lisait que le CONTENU de ce qu'il recevait : un espace de
 * noms et un champ « depuis », deux chaînes que n'importe qui peut écrire. Or
 * postMessage traverse les origines par construction, et « matches » du
 * manifeste n'y peut rien — l'écouteur est posé sur la fenêtre de Roll20, et
 * toute page qui en garde une poignée peut lui parler.
 *
 * CE QUE ÇA OUVRAIT : poser des marqueurs dont l'adresse est choisie par
 * l'appelant, éteindre l'extension, piloter le zoom — et RECEVOIR UNE RÉPONSE,
 * puisque « repond » poste vers « ev.source ». Un « recon » forgé renvoyait
 * l'état de la partie à la fenêtre qui l'avait demandé.
 *
 * CE BLOC ÉPROUVE LES GARDES, IL NE LES CONSTATE PAS. Le bus sait mentir
 * exprès — « posteDAilleurs » simule une page étrangère —, et sans ce second
 * geste on ne pourrait que vérifier que les gardes ne gênent personne, ce qui
 * n'est pas la question.
 */
function essaiOrigine() {
  titre("12. D'où vient un message");

  /* ---------- 1. LE PONT REFUSE CE QUI NE VIENT PAS DE SA PAGE ---------- */
  const bus = faisBus();
  const pont = montePont(bus, faisRoll20(false, true));

  /* On l'installe normalement, pour avoir un état à abîmer. */
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true,
              catalogue: [{ tag: "vttk_a_x.test/a.png", nom: "A", url: "https://x.test/a.png" }] });
  const posesLegitimes = pont.ctx.window.__vttinkerMarqueursPoses;

  /* La même chose, forgée depuis ailleurs. */
  let repondu = null;
  const etrangere = { postMessage(m) { repondu = m; } };
  bus.posteDAilleurs({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true,
                       catalogue: [{ tag: "vttk_mal_mal.test/x.png", nom: "M", url: "https://mal.test/x.png" }] },
                     "https://mal.test", etrangere);
  bus.posteDAilleurs({ ns: "vttinker", depuis: "contenu", type: "recon" }, "https://mal.test", etrangere);
  bus.posteDAilleurs({ ns: "vttinker", depuis: "contenu", type: "vttk", actif: false },
                     "https://mal.test", etrangere);

  verifie("une page étrangère n'obtient AUCUNE réponse du pont", repondu === null,
    "elle a reçu : " + JSON.stringify(repondu).slice(0, 90));
  verifie("  et n'a rien changé à ce qui était posé",
    pont.ctx.window.__vttinkerMarqueursPoses === posesLegitimes ||
    pont.ctx.window.__vttinkerMarqueursPoses === undefined);
  verifie("  l'interrupteur général forgé n'a pas éteint l'extension",
    pont.ctx.document.body.querySelectorAll(".vttk-outil-titre").length >= 0);

  /* ---------- 2. ET IL ACCEPTE TOUJOURS CE QUI VIENT DE SA PAGE ---------- */
  let repondLegitime = null;
  const ancien = bus.poste;
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "recon" });
  /* La réponse part vers la fenêtre du monde, donc vers le bus : on la relit
   * par le journal du pont, seul témoin durable. */
  verifie("le message légitime, lui, passe",
    typeof pont.ctx.window.__vttinkerRecon === "function");

  /* ---------- 3. LE PANNEAU EST LE SEUL À VENIR D'AILLEURS LÉGITIMEMENT ----------
   *
   * Il vit sur moz-extension://<identifiant>/, que le pont dérive de sa propre
   * adresse. Une hauteur envoyée depuis n'importe quelle autre origine est
   * refusée — c'est le seul endroit du protocole où l'origine attendue est
   * connue d'avance, donc le seul où la garde est exacte plutôt que prudente. */
  const bus2 = faisBus();
  const pont2 = montePont(bus2, faisRoll20(false, true));
  bus2.poste({ ns: "vttinker", depuis: "contenu", type: "reglages", ouvre: true });
  bus2.posteDAilleurs({ ns: "vttinker", depuis: "panneau", type: "hauteur", hauteur: 640 },
                      "https://mal.test");
  const cadreApres = pont2.ctx.document.querySelector(".vttk-reglages-cadre");
  verifie("une hauteur de panneau venue d'ailleurs est ignorée",
    !cadreApres || cadreApres.style.height !== "640px",
    cadreApres ? "hauteur : " + cadreApres.style.height : "pas de cadre");

  /* ---------- 4. LA SOURCE, ET PAS SEULEMENT L'ORIGINE ----------
   *
   * Roll20 héberge des cadres de MÊME origine. Un message venu de l'un d'eux
   * porterait la bonne origine et ne serait pourtant pas le nôtre : c'est la
   * seconde garde qui l'écarte, et elle ne fait pas double emploi. */
  const bus3 = faisBus();
  const pont3 = montePont(bus3, faisRoll20(false, true));
  let repondu3 = null;
  bus3.posteDAilleurs({ ns: "vttinker", depuis: "contenu", type: "recon" },
                      "https://app.roll20.net", { postMessage(m) { repondu3 = m; } });
  verifie("un cadre de MÊME origine n'obtient rien non plus", repondu3 === null,
    "il a reçu : " + JSON.stringify(repondu3).slice(0, 90));

  /* ---------- 5. LA SOURCE EST DÉCLARÉE, ET PAS DIFFUSÉE ---------- */
  const src = lis("page/pont.js");
  const socle = lis("contenu/000-socle.js");
  const panneau = lis("panneau/panneau.js");
  verifie("aucun postMessage du dépôt ne vise « * »",
    !/postMessage\([^)]*"\*"/.test(src) && !/postMessage\([^)]*"\*"/.test(socle) &&
    !/postMessage\([^)]*"\*"/.test(panneau));
  verifie("  le pont répond à l'origine qui a demandé",
    /postMessage\(msg, ou\)/.test(src) && /ev\.origin\) \? ev\.origin : location\.origin/.test(src));
  verifie("  le socle vise sa propre page", /window\.top\.postMessage\(msg, location\.origin\)/.test(socle));
  verifie("  le panneau vise Roll20 nommément", /"https:\/\/app\.roll20\.net"\)/.test(panneau));

  /* ---------- 6. TOUT ÉCOUTEUR DE MESSAGE CONTRÔLE SON ORIGINE ----------
   *
   * La règle vaut pour les fichiers à venir autant que pour ceux d'aujourd'hui :
   * un écouteur ajouté demain sans garde rouvrirait la porte en silence. */
  ["page/pont.js", "contenu/000-socle.js"].forEach(function (f) {
    const t = lis(f);
    if (!/addEventListener\("message"/.test(t)) { return; }
    verifie("« " + f + " » contrôle l'origine de ce qu'il reçoit",
      /ev\.origin !== /.test(t), "aucun test sur ev.origin");
    verifie("  et la fenêtre émettrice",
      /ev\.source !== window/.test(t) || /ev\.origin !== monOrigine/.test(t));
  });
}

/* ---------- UN OUTIL DE LA COLONNE SE CLIQUE ----------
 *
 * Le défaut le plus coûteux de la session, et il ne se voyait dans AUCUN des
 * 719 contrôles : nos deux outils — réglages et marqueurs — étaient inertes sur
 * une vraie partie. Posés, dessinés, intitulés, et sans le moindre écouteur.
 *
 * LA CAUSE : « faisBoutonOutil » cherchait un « button » dans le nœud cloné et
 * ne posait son écouteur QUE s'il en trouvait un. Or la barre de Roll20 n'en
 * contient pas — mesuré : ses trois premiers outils rendent
 * `querySelectorAll("button").length === 0`, premier enfant DIV.
 *
 * POURQUOI LE BANC NE LE VOYAIT PAS : son faux monde posait un « button », donc
 * il était PLUS RICHE QUE LE VRAI. Un modèle plus généreux que la réalité ne
 * dit rien de la réalité — il dit seulement que le code marche dans un monde
 * qui n'existe pas.
 *
 * Ce bloc monte les DEUX formes et exige que l'outil réponde dans les deux.
 */
function essaiBoutonColonne() {
  titre("13. Un outil de la colonne se clique");

  [["avec un « button » interne", false], ["SANS button, comme la vraie barre", true]]
    .forEach(function (cas) {
      const sansBouton = cas[1];
      const bus = faisBus();
      const r20 = faisRoll20(false, true);
      const pont = montePont(bus, r20, { sansBouton: sansBouton });
      bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: [] });

      const doc = pont.ctx.document;
      const outil = doc.body.querySelector(".vttk-outil-reglages");
      verifie(cas[0] + " : l'outil est posé", !!outil);
      if (!outil) { return; }

      /* CE QUI REÇOIT LE CLIC : le button s'il existe, le nœud sinon. */
      const cible = outil.querySelector("button") || outil;
      verifie("  il porte un intitulé accessible",
        !!cible.attrs && !!cible.attrs["aria-label"], JSON.stringify(cible.attrs && cible.attrs["aria-label"]));

      /* ET IL EST ATTEIGNABLE AU CLAVIER quand ce n'est pas un vrai bouton :
       * un div sans « role » ni « tabindex » n'existe pas pour qui n'a pas de
       * souris. */
      if (sansBouton) {
        verifie("  et il est atteignable au clavier",
          cible.attrs["tabindex"] === "0" && cible.attrs["role"] === "button",
          "tabindex " + cible.attrs["tabindex"] + ", role " + cible.attrs["role"]);
      }

      /* LA SEULE PREUVE QUI VAILLE : on clique, et quelque chose arrive. */
      const avant = doc.body.querySelectorAll(".vttk-reglages").length;
      cible.declenche("click");
      const apres = doc.body.querySelectorAll(".vttk-reglages").length;
      verifie("  le clic ouvre les réglages", apres > avant,
        "avant " + avant + ", après " + apres);

      /* Et la touche Entrée fait la même chose. */
      const bus2 = faisBus();
      const pont2 = montePont(bus2, faisRoll20(false, true), { sansBouton: sansBouton });
      bus2.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true, catalogue: [] });
      const doc2 = pont2.ctx.document;
      const outil2 = doc2.body.querySelector(".vttk-outil-reglages");
      const cible2 = (outil2 && (outil2.querySelector("button") || outil2)) || null;
      if (cible2) {
        cible2.declenche("keydown", { key: "Enter" });
        verifie("  la touche Entrée aussi",
          doc2.body.querySelectorAll(".vttk-reglages").length > 0);
      }
    });

  /* ---------- ET LA SOURCE LE DIT ----------
   *
   * Le repli doit rester écrit : un jour où la barre de Roll20 reprendra des
   * « button », il ne faudra pas que quelqu'un « simplifie » en supprimant le
   * cas qui ne sert plus — c'est celui-là qui sert aujourd'hui. */
  const src = lis("page/pont.js");
  verifie("le câblage prend le nœud à défaut d'un button",
    /n\.querySelector\("button"\) \|\| n;/.test(src));
  verifie("  et il n'y a plus de branche qui puisse ne rien câbler",
    !/var b = n\.querySelector\("button"\);\s*\n\s*if \(b\) \{/.test(src));
}

/* ---------- LES HUIT DÉFAUTS, ET CE QUI LES EMPÊCHE DE REVENIR ----------
 *
 * Huit défauts relevés un par un dans le dépôt, tous corrigés, aucun n'ayant
 * demandé de déplacer une ligne d'architecture. Ce bloc ne raconte pas les
 * corrections : il pose le contrôle qui échouera si l'une d'elles se défait.
 *
 * C'est la seule forme de correction qui tienne. Un défaut réparé sans garde
 * revient — pas forcément par la même main, ni par la même route.
 */
function essaiHuitDefauts() {
  titre("14. Les huit défauts, et leurs gardes");

  /* « lis » ne sait lire que sous extension/. Deux voisines pour le reste. */
  const lisOutil = function (f) { return fs.readFileSync(path.join(RACINE, "..", "outils", f), "utf8"); };
  const lisRacine = function (f) { return fs.readFileSync(path.join(RACINE, "..", f), "utf8"); };

  /* ---------- 1. TOUTE CLÉ DEMANDÉE EST DÉFINIE, DANS LES DEUX LANGUES ----------
   *
   * « mq.nom » était réclamée par motsDuPont et définie nulle part : le champ
   * affichait littéralement « mq.nom ». Le contrôle ne vise pas cette clé-là —
   * il vise TOUTES celles que le socle demande. */
  const socle = lis("contenu/000-socle.js");
  const langue = lis("commun/langue.js");
  const bloc = socle.slice(socle.indexOf("motsDuPont"), socle.indexOf("motsDuPont") + 900);
  const demandees = (bloc.match(/"[a-z]+\.[a-zA-Z]+"/g) || []).map(function (s) { return s.slice(1, -1); });
  verifie("motsDuPont demande au moins dix clés", demandees.length >= 10, "trouvé " + demandees.length);
  demandees.forEach(function (c) {
    const n = (langue.match(new RegExp('"' + c.replace(".", "\\.") + '"\\s*:', "g")) || []).length;
    verifie("  « " + c + " » est définie dans les DEUX langues", n === 2, n + " définition(s)");
  });

  /* ---------- 1 bis. AUCUNE CLÉ N'EST DÉCLARÉE DEUX FOIS DANS UN DICTIONNAIRE ----------
   *
   * Trouvé par le contrôle ci-dessus, et c'est un neuvième défaut : « pal.editer »
   * était déclarée DEUX FOIS par langue, avec deux sens différents — « Modifier
   * la palette » puis « Ajouter, supprimer, trier ». JavaScript garde la
   * dernière en silence, et le premier sens était perdu sans que rien ne le dise.
   *
   * Le contrôle porte sur le TEXTE et par bloc de langue : sur l'objet il ne
   * verrait plus rien, le doublon ayant déjà été avalé au chargement. */
  const lignes = langue.split("\n");
  let dico = "(hors bloc)";
  const vues = {};
  const doublons = [];
  lignes.forEach(function (t, i) {
    const b = t.match(/^\s*(en|fr)\s*:/);
    if (b) { dico = b[1]; }
    const m = t.match(/^\s*"([a-z]+\.[a-zA-Z]+)"\s*:/);
    if (!m) { return; }
    const k = dico + "/" + m[1];
    if (vues[k]) { doublons.push(k + " (lignes " + vues[k] + " et " + (i + 1) + ")"); }
    vues[k] = i + 1;
  });
  verifie("aucune clé n'est déclarée deux fois dans un même dictionnaire",
    doublons.length === 0, doublons.join(" · "));

  /* ---------- 2. TOUTE CLÉ ÉCRITE DANS LE STOCKAGE EST AU CATALOGUE ----------
   *
   * « reg:marqueursMode » était écrite et relue, mais absente du catalogue —
   * donc jamais rechargée, donc perdue à chaque ouverture de partie, alors
   * qu'un commentaire promettait qu'elle tenait. */
  const cat = lis("commun/catalogue.js");
  const declarees = (cat.match(/cle:\s*"([a-zA-Z]+)"/g) || [])
    .map(function (s) { return s.replace(/.*"([a-zA-Z]+)".*/, "$1"); });
  ["contenu/modules/marqueurs.js", "contenu/modules/zoom.js",
   "contenu/modules/grille.js", "contenu/modules/chat.js"].forEach(function (f) {
    const t = lis(f);
    const ecrites = [...new Set((t.match(/"reg:([a-zA-Z]+)"/g) || [])
      .map(function (s) { return s.slice(5, -1); }))];
    ecrites.forEach(function (k) {
      verifie("« " + f.split("/").pop() + " » : le réglage « " + k + " » est au catalogue",
        declarees.indexOf(k) >= 0, "absent — il ne sera jamais rechargé");
    });
  });

  /* ---------- 3. AUCUNE CLÉ DE ROUTE EN DOUBLE ----------
   *
   * JavaScript avale un doublon de littéral d'objet en silence : la seconde
   * gagne. 135 lignes de sonde étaient injoignables, sans erreur, sans trace.
   * Le contrôle porte sur le TEXTE — sur l'objet il ne verrait plus rien. */
  const pilote = lisOutil("pilote.js");
  const table = pilote.slice(pilote.lastIndexOf("const routes = {"));
  const cles = (table.slice(0, table.indexOf("};")).match(/[{,]\s*([a-zA-Z0-9_]+)\s*[:,}]/g) || [])
    .map(function (s) { return s.replace(/[{,\s:}]/g, ""); }).filter(Boolean);
  const vus = {}, doubles = [];
  cles.forEach(function (k) { if (vus[k]) { doubles.push(k); } vus[k] = 1; });
  verifie("la table des routes du pilote n'a aucune clé en double",
    doubles.length === 0, doubles.join(", "));

  /* ---------- 4. AUCUNE RESSOURCE EXPOSÉE QUE PERSONNE NE CHARGE ----------
   *
   * « ui/theme.css » était déclarée accessible à la page et liée par aucune
   * page. R20 telle qu'écrite la déclarait saine, puisque le manifeste la
   * nommait : c'est le second sens du contrôle qui l'attrape. */
  const man = JSON.parse(lis("manifest.json"));
  const exposees = (man.web_accessible_resources || [])
    .reduce(function (t, e) { return t.concat(e.resources || []); }, [])
    .filter(function (r) { return /\.css$/.test(r); });
  const pages = ["panneau/panneau.html", "popup/popup.html"].map(lis).join("\n");
  const injectees = lis("page/pont.js") + lis("contenu/000-socle.js");
  exposees.forEach(function (r) {
    const nom = r.split("/").pop();
    verifie("la feuille exposée « " + r + " » est chargée par quelqu'un",
      pages.indexOf(nom) >= 0 || injectees.indexOf(nom) >= 0,
      "déclarée accessible, liée par personne");
  });

  /* ---------- 5. LES DEUX MONDES DISENT LA MÊME CHOSE D'UNE ADRESSE ----------
   *
   * Le monde isolé faisait trim(), le pont non : une adresse à espace finale
   * entrait au catalogue et ne se dessinait jamais. On ne compare pas les deux
   * TEXTES — ils ne se ressemblent pas et n'ont pas à se ressembler —, on
   * compare ce qu'ils RÉPONDENT. */
  /* On ne compare pas les deux TEXTES — ils ne se ressemblent pas, et n'ont pas
   * à se ressembler. On compare ce qu'ils ACCEPTENT, ce qui est la seule chose
   * dont l'utilisateur voie la différence. */
  const bus = faisBus();
  const c = monteContenu(bus, {});
  const pont = montePont(bus, faisRoll20(false, true));
  let dernier = null;
  bus.ecoute({ window: {} }, function (ev) {
    if (ev.data && ev.data.type === "marqueurs-resultat") { dernier = ev.data; }
  });
  [["https://x.test/a.png", true, "une adresse propre"],
   ["  https://x.test/b.png  ", true, "la même, entourée d'espaces"],
   ["javascript:alert(1)", false, "un schéma qui n'est pas http"],
   ["https://x.test/a,b.png", false, "une virgule, que l'étiquette ne supporte pas"]
  ].forEach(function (cas) {
    const isole = c.ctx.vttMarqueurUrlValide(cas[0]);
    verifie("le monde isolé : " + cas[2] + " → " + cas[1], !!isole === cas[1]);
    dernier = null;
    bus.poste({ ns: "vttinker", depuis: "contenu", type: "marqueurs", actif: true,
                catalogue: [{ tag: "vttk_x_" + Math.abs(cas[0].length) + "_x.test/a.png",
                              nom: "X", url: cas[0] }] });
    const retenue = dernier && dernier.etiquettes === 1;
    verifie("  et le pont retient la même chose", !!retenue === !!isole,
      "isolé " + !!isole + ", pont " + !!retenue);
  });
  /* ---------- 6. LE BANC MONTE TOUT CE QUE LE MANIFESTE LIVRE ----------
   *
   * monteContenu disait suivre le manifeste et en omettait trois : emojis.js,
   * grille.js et chat.js — 1 451 lignes livrées, jamais montées, donc jamais
   * éprouvées. */
  const listes = (man.content_scripts || [])[0].js || [];
  const source = lisOutil("verifie.js");
  const monte = source.slice(source.indexOf("function monteContenu"),
                             source.indexOf("function monteContenu") + 3000);
  listes.forEach(function (f) {
    verifie("le banc monte « " + f + " »", monte.indexOf('"' + f + '"') >= 0,
      "le manifeste le livre, le banc ne l'exécute jamais");
  });

  /* ---------- 6 bis. AUCUNE SONDE N'OUVRE UNE FENÊTRE D'ELLE-MÊME ----------
   *
   * Le défaut était « config().visible !== false ». La clé n'étant définie nulle
   * part, le test valait VRAI, et chacune des 131 sondes ouvrait une fenêtre
   * Firefox qui prenait le focus — trente fois dans une session de travail.
   *
   * L'instance était pourtant bien isolée : son propre profil, et « -no-remote »
   * pour ne jamais parler à celle de l'utilisateur. Isoler ne suffit pas : ce
   * qui se voit doit se DEMANDER, jamais se subir. La règle est donc
   * « === true », et un fichier de configuration neuf n'ouvre rien.
   *
   * « connexion.js » est la seule exception, et elle est de nature : son objet
   * est justement de montrer une fenêtre pour qu'un humain franchisse le
   * contrôle anti-robot à la main. */
  verifie("aucune sonde n'ouvre de fenêtre sans qu'on la demande",
    pilote.indexOf("config().visible !== false") < 0,
    (pilote.match(/config\(\)\.visible !== false/g) || []).length + " sonde(s) encore visibles par défaut");
  verifie("  et le pilote ajoute bien « -headless » quand on n'en demande pas",
    /if \(!visible\) \{ opts\.addArguments\("-headless"\); \}/.test(pilote));

  /* ---------- 6 ter. AUCUN OUTIL D'ASSISTANCE N'EST NOMMÉ NULLE PART ----------
   *
   * Le dépôt ne doit porter aucune trace d'un outil d'assistance : ni dans un
   * nom de fichier, ni dans un commentaire, ni dans une chaîne, ni dans un
   * message de commit. C'est une exigence de l'auteur, et elle est absolue.
   *
   * Elle s'était pourtant fait prendre en défaut à l'endroit le plus retors :
   * `.gitignore` NOMMAIT l'outil pour ignorer son dossier de réglages. Le
   * fichier étant versionné, la mention serait partie avec — la règle destinée
   * à effacer la trace en était devenue le porteur. La règle vit désormais dans
   * .git/info/exclude, que git ne versionne jamais.
   *
   * Le contrôle balaie TOUT fichier de texte du dépôt, sans exception : c'est le
   * seul balayage qui aurait vu celui-là. */
  /* LA LISTE EST ÉPELÉE EN MORCEAUX, ET CE N'EST PAS UNE COQUETTERIE.
   *
   * Écrite d'un trait, elle contiendrait les mots qu'elle traque — et le
   * balayage se dénoncerait lui-même au premier passage. Vérifié : il l'a fait.
   * Un contrôle qui échoue sur son propre texte n'apprend rien de ce qu'il
   * surveille, et pousse à le désarmer pour retrouver le vert. */
  const MORCEAUX = ["cla" + "ude", "anthro" + "pic", "copi" + "lot", "chat" + "gpt",
                    "open" + "ai", "gpt-[0-9]", "code" + "ium", "co-authored" + "-by"];
  const NOMS = new RegExp(MORCEAUX.join("|"), "i");
  const dossiers = ["extension", "outils", "site"];
  const fautifs = [];
  (function balaie(d) {
    let entrees;
    try { entrees = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    entrees.forEach(function (e) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (/^\.|^node_modules$|^releves$/.test(e.name)) { return; }
        if (NOMS.test(e.name)) { fautifs.push(p + " (nom de dossier)"); }
        balaie(p);
        return;
      }
      if (NOMS.test(e.name)) { fautifs.push(p + " (nom de fichier)"); }
      if (!/\.(js|json|css|html|md|txt|yml)$/.test(e.name)) { return; }
      let t;
      try { t = fs.readFileSync(p, "utf8"); } catch (e2) { return; }
      t.split("\n").forEach(function (l, i) {
        /* « cursor: pointer » n'est pas un outil, c'est du CSS. */
        if (/cursor:\s*(pointer|text|grab|grabbing|default|move|not-allowed|crosshair)/.test(l)) { return; }
        if (NOMS.test(l)) { fautifs.push(p + ":" + (i + 1)); }
      });
    });
  })(path.join(RACINE, ".."));
  ["package.json", ".gitignore", ".gitattributes", "README.md", "LICENSE.md", "mkdocs.yml"]
    .forEach(function (f) {
      let t;
      try { t = fs.readFileSync(path.join(RACINE, "..", f), "utf8"); } catch (e) { return; }
      t.split("\n").forEach(function (l, i) {
        if (NOMS.test(l)) { fautifs.push(f + ":" + (i + 1)); }
      });
    });
  verifie("aucun outil d'assistance n'est nommé dans le dépôt",
    fautifs.length === 0, fautifs.slice(0, 6).join(" · "));
  verifie("  et les dossiers balayés existent bien",
    dossiers.every(function (d) { return fs.existsSync(path.join(RACINE, "..", d)); }));

  /* ---------- 7. UNE SEULE HORLOGE ---------- */
  const pontSrc = lis("page/pont.js");
  verifie("il n'y a qu'une déclaration de « maintenant »",
    (pontSrc.match(/^\s*(var|function) maintenant\b/gm) || []).length === 1,
    (pontSrc.match(/^\s*(var|function) maintenant\b/gm) || []).join(" / "));

  /* ---------- 8. UN SEUL NUMÉRO DE VERSION ---------- */
  const paquet = JSON.parse(lisRacine("package.json"));
  egal("le manifeste et package.json portent la même version", paquet.version, man.version);
}

/* ============================================================
 * 15. LES JETONS, VISIBLES HORS DE LA CARTE
 * ============================================================
 *
 * Ce module tient à un seul chiffre — le w de `u_Board` — et il s'est trompé
 * DEUX FOIS avant d'être juste. Les deux erreurs ont été signalées en jouant, et
 * aucune n'était visible d'ici. Ce bloc existe pour qu'aucune ne revienne.
 *
 * ---------- LA PREMIÈRE : ÉCRIRE SUR LA SOURCE ----------
 *
 * Cinq mesures ont conclu « le levier ne mord pas » parce qu'elles écrivaient
 * sur le maillage SOURCE, qui ne porte que la valeur du modèle, au lieu de
 * chaque INSTANCE, seule à finir sur la carte graphique. Une régression qui y
 * reviendrait ne se verrait NULLE PART : la fonction rendrait ok, le compte
 * rendu annoncerait des tampons posés, et seul un joueur devant sa page
 * s'apercevrait que rien n'a changé.
 *
 * ---------- LA SECONDE : LE MAUVAIS COMPOSANT ----------
 *
 * `z = 1` saute le rejet mais laisse `offBoard` vrai, donc la ligne
 * `glFragColor.a *= 0.5` s'applique : le jeton revient À DEMI-OPACITÉ, comme
 * voilé. C'est ce qui a été livré, et signalé. `w = 0` saute le test entier :
 * ni rejet, ni demi-teinte. C'est aussi, exactement, ce que le MJ reçoit.
 *
 * Le banc éprouve donc quel composant est touché, et lequel ne l'est pas.
 *
 * ---------- ET LE CLIGNOTEMENT ----------
 *
 * La correction passait toutes les 500 ms. Entre la réécriture de Roll20 et
 * notre passage, des images étaient dessinées avec sa valeur : ça clignotait.
 * Elle passe désormais AVANT CHAQUE IMAGE. Un banc qui ne jouerait pas d'image
 * ne verrait pas la différence entre les deux, et c'est justement la différence
 * qu'on est venu signaler.
 */
function faisTampon(w) {
  return { x: 1750, y: 1750, z: 0, w: w };
}

/* Un maillage source et ses instances, comme Roll20 les range : les instances
 * portent CHACUNE leur tampon, et c'est là que tout se joue. */
/* LES COUCHES, PARCE QUE LE MODULE LES REGARDE MAINTENANT.
 *
 * Il ne pose plus w = 0 partout : seulement sous « tokens-layer ». Un faux
 * monde sans couches lui ferait tout accepter, et le banc ne verrait pas la
 * régression qui remettrait la carte dans le lot — celle-là même qui a changé
 * dix-huit mille pixels sur l écran d un MJ.
 *
 * La chaîne rejoue celle qu on a relevée dans une vraie partie :
 *   instance  <  image-instance--<id>  <  -<id>  <  tokens-layer
 */
function faisCouche(nom) { return { name: nom, parent: null }; }

function faisJetons(w, couche) {
  const racine = faisCouche(couche || "tokens-layer");
  const source = { name: "instance-0-objects - 0_group_0", parent: racine,
                   instancedBuffers: { u_Board: faisTampon(w) } };
  source.instances = [1, 2, 3].map(function (i) {
    const jeton = { name: "-jeton" + i, parent: racine };
    const image = { name: "image-instance--jeton" + i, parent: jeton };
    return { name: "instance- /images/character" + i + ".png",
             parent: image, sourceMesh: source,
             instancedBuffers: { u_Board: faisTampon(w) } };
  });
  source.racine = racine;
  return source;
}

async function essaiHorsPage() {
  titre("15. Les jetons, visibles hors de la carte");

  /* ---------- CE QUE LE PRODUIT DÉCLARE ---------- */
  const cat = lis("commun/catalogue.js");
  verifie("le catalogue porte le module « horsPage »", /id:\s*"horsPage"/.test(cat));
  const lang = lis("commun/langue.js");
  egal("  et il est nommé dans les deux langues",
    (lang.match(/"mod\.horsPage"/g) || []).length, 2);
  const man = JSON.parse(lis("manifest.json"));
  const js = man.content_scripts[0].js;
  verifie("  le manifeste le livre", js.indexOf("contenu/modules/horspage.js") >= 0);
  verifie("  et APRÈS le socle, qui porte VTT.module",
    js.indexOf("contenu/modules/horspage.js") > js.indexOf("contenu/000-socle.js"));

  /* L'IDENTIFIANT DU MODULE EST CELUI DU CATALOGUE, AU CARACTÈRE PRÈS. Un écart
   * de casse — « horspage » au lieu de « horsPage » — ne lèverait aucune erreur :
   * le socle chercherait simplement un réglage qui n'existe pas, et le module ne
   * démarrerait jamais. En silence. */
  const modSrc = lis("contenu/modules/horspage.js");
  verifie("  et le module s'enregistre sous l'identifiant du catalogue",
    /id:\s*"horsPage"/.test(modSrc));

  /* ---------- CE QU'IL FAIT, DANS UN MONDE QUI RESSEMBLE AU VRAI ---------- */
  const bus = faisBus();
  const r20 = faisRoll20(false);
  const jetons = faisJetons(1);
  r20.scene.meshes.push(jetons);
  montePont(bus, r20);

  let rep = null;
  bus.ecoute(null, (ev) => { if (ev.data && ev.data.type === "horspage-resultat") { rep = ev.data; } });

  const tampons = function () {
    return [jetons.instancedBuffers.u_Board].concat(
      jetons.instances.map(function (i) { return i.instancedBuffers.u_Board; }));
  };
  const wDesInstances = function () {
    return jetons.instances.map(function (i) { return i.instancedBuffers.u_Board.w; });
  };

  bus.poste({ ns: "vttinker", depuis: "contenu", type: "horspage", actif: true });
  await attends(60);
  verifie("le pont accepte la pose", !!rep && rep.ok === true, JSON.stringify(rep));
  egal("  il compte les quatre tampons (une source et trois instances)", rep && rep.tampons, 4);

  /* LA PREMIÈRE MESURE : CHAQUE INSTANCE, PAS LA SEULE SOURCE. */
  egal("  et il écrit sur CHAQUE INSTANCE, pas seulement sur la source",
    JSON.stringify(wDesInstances()), JSON.stringify([0, 0, 0]));
  egal("  la source aussi, pour les instances à venir", jetons.instancedBuffers.u_Board.w, 0);

  /* LA SECONDE : C'EST w QU'ON POSE, ET z QU'ON LAISSE.
   *
   * Toucher z rendrait le jeton à demi-opacité — le défaut signalé. Le banc le
   * dit dans les deux sens, sans quoi une inversion des deux composants
   * passerait : les deux valeurs seraient « changées », et les deux contrôles
   * d'une seule d'entre elles seraient satisfaits. */
  egal("  z reste celui de Roll20 : sinon le jeton revient à demi-opacité",
    JSON.stringify(jetons.instances.map(function (i) { return i.instancedBuffers.u_Board.z; })),
    JSON.stringify([0, 0, 0]));

  /* ET LE GUET EST CELUI DU RENDU, PAS UN INTERVALLE. */
  egal("  le guet est accroché au rendu, pas à une horloge", rep && rep.guet, "rendu");
  egal("  un seul observateur de rendu posé", r20.scene.observateurs.length, 1);

  /* ---------- LA CORRECTION PASSE AVANT CHAQUE IMAGE ----------
   *
   * On rejoue ce que fait Roll20 : il REMPLACE le vecteur par un neuf. Le module
   * doit avoir corrigé le remplaçant avant que l'image suivante soit dessinée —
   * pas 500 ms plus tard, sinon ça clignote. */
  jetons.instances[1].instancedBuffers.u_Board = faisTampon(1);
  egal("Roll20 réécrit un tampon : il est fautif tant qu'aucune image n'est jouée",
    wDesInstances()[1], 1);
  r20.scene.image();
  egal("  et corrigé DÈS l'image suivante, sans attendre d'horloge",
    JSON.stringify(wDesInstances()), JSON.stringify([0, 0, 0]));

  /* ---------- ET LA CARTE, ELLE, N'Y TOUCHE PAS ----------
   *
   * C'est le défaut qui a été livré et signalé : w = 0 posé partout éteignait
   * aussi la demi-teinte que Roll20 applique hors page aux images de CARTE.
   * Dix-huit mille pixels changeaient sur l'écran d'un MJ sans qu'un seul jeton
   * n'ait bougé. Le module ne touche plus que « tokens-layer ». */
  const carte = faisJetons(1, "map-layer");
  r20.scene.meshes.push(carte);
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "horspage", actif: true });
  await attends(60);
  r20.scene.image();
  egal("la couche CARTE n'est pas touchée",
    JSON.stringify(carte.instances.map(function (i) { return i.instancedBuffers.u_Board.w; })),
    JSON.stringify([1, 1, 1]));
  egal("  et les jetons le sont toujours",
    JSON.stringify(wDesInstances()), JSON.stringify([0, 0, 0]));
  /* Et rien n'est retenu pour elle : à l'extinction, il n'y aura rien à rendre
   * — donc rien à rendre DE TRAVERS. */
  verifie("  rien n'est retenu pour la carte",
    carte.instances.every(function (i) { return i.instancedBuffers.u_Board.vttkW === undefined; }));

  /* ---------- L'EXTINCTION REND SA VALEUR À ROLL20 ----------
   *
   * PAS « 1 » : Roll20 calcule ce w selon la couche, et le MJ en reçoit déjà
   * zéro sur la sienne. Lui rendre 1 lui prendrait ce qu'il voyait avant. */
  rep = null;
  bus.poste({ ns: "vttinker", depuis: "contenu", type: "horspage", actif: false });
  await attends(60);
  verifie("le pont accepte l'extinction", !!rep && rep.ok === true, JSON.stringify(rep));
  egal("  et le joueur retrouve exactement ce que Roll20 lui donnait",
    JSON.stringify(wDesInstances()), JSON.stringify([1, 1, 1]));
  egal("  l'observateur de rendu est retiré", r20.scene.observateurs.length, 0);

  /* ET IL NE REPASSE PLUS. Un observateur qui survit à l'extinction reposerait
   * le levier à l'image suivante, et le module serait ineffaçable. */
  r20.scene.image();
  egal("  jouer une image ne le repose pas", JSON.stringify(wDesInstances()), JSON.stringify([1, 1, 1]));

  /* Et la marque de rangement part avec : la laisser ferait rendre, au prochain
   * cycle, une valeur relevée deux allumages plus tôt. */
  verifie("  et la valeur retenue est libérée",
    tampons().every(function (b) { return b.vttkW === undefined; }));

  /* ---------- CHEZ LE MJ, ÉTEINDRE NE LUI PREND RIEN ----------
   *
   * Sur sa couche, Roll20 lui donne DÉJÀ w = 0. Le module n'a rien à poser, donc
   * rien à rendre, et l'extinction doit le laisser exactement comme il était. */
  const bus2 = faisBus();
  const r20b = faisRoll20(false);
  const mj = faisJetons(0);
  r20b.scene.meshes.push(mj);
  montePont(bus2, r20b);
  bus2.poste({ ns: "vttinker", depuis: "contenu", type: "horspage", actif: true });
  await attends(60);
  bus2.poste({ ns: "vttinker", depuis: "contenu", type: "horspage", actif: false });
  await attends(60);
  egal("le MJ éteint le module et garde son w",
    JSON.stringify(mj.instances.map(function (i) { return i.instancedBuffers.u_Board.w; })),
    JSON.stringify([0, 0, 0]));

  /* ---------- SANS SCÈNE, IL LE DIT AU LIEU DE SE CROIRE POSÉ ----------
   *
   * La scène Babylon se monte APRÈS la page. Répondre « ok » à un moment où il
   * n'y a rien à écrire arrêterait les tentatives du module, et il resterait
   * allumé sans effet — c'est la panne qu'avait eue la grille, mot pour mot. */
  const bus3 = faisBus();
  const r20c = faisRoll20(false);
  r20c.scene.meshes = null;
  montePont(bus3, r20c);
  let rep3 = null;
  bus3.ecoute(null, (ev) => { if (ev.data && ev.data.type === "horspage-resultat") { rep3 = ev.data; } });
  bus3.poste({ ns: "vttinker", depuis: "contenu", type: "horspage", actif: true });
  await attends(60);
  verifie("sans scène, il répond un échec nommé",
    !!rep3 && rep3.ok === false && rep3.raison === "scene-absente", JSON.stringify(rep3));
}

/* ============================================================ */

(async function () {
  await essaiContenu();
  await essaiPont(false);
  await essaiPont(true);
  await essaiGrille();
  essaiMarqueurs();
  await essaiMarqueursDessin();
  await essaiPanneau();
  await essaiFenetre();
  essaiEmojis();
  essaiInterdits();
  essaiHeritage();
  essaiHeritagePeint();
  essaiOrigine();
  essaiBoutonColonne();
  await essaiHorsPage();
  essaiHuitDefauts();

  console.log("\n" + (echecs ? "ÉCHEC — " + echecs + " sur " + total : "Tout passe — " + total + " contrôles"));
  process.exit(echecs ? 1 : 0);
})();
