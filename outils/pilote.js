/* LE PILOTE — Firefox conduit depuis la ligne de commande.
 *
 * POURQUOI. Roll20 n'est documenté nulle part : tout ce qu'on sait de lui a été
 * relevé en direct, dans la console d'une vraie partie, puis recopié à la main
 * d'une fenêtre à l'autre. C'était le vrai coût du projet, et il était payé par
 * l'humain. Ce fichier le supprime : Firefox se lance tout seul, avec
 * l'extension déjà dedans, va sur la partie, exécute ce qu'on veut et écrit le
 * résultat dans un fichier. Plus rien à sélectionner, plus rien à coller.
 *
 * CE QU'IL NE FAIT PAS, ET C'EST VOULU. Il n'utilise PAS le Firefox de tous les
 * jours ni son profil : il en tient un à lui, dans outils/.profil, hors du
 * suivi git. Rien de la navigation ordinaire n'est touché, lu, ni recopié. La
 * connexion à Roll20 se fait une fois, à la main, dans ce profil-là, et ce sont
 * ses cookies à lui qui servent ensuite.
 *
 *
 *   node outils/pilote.js connexion
 *       Ouvre Firefox sur le profil dédié et ATTEND que tu te connectes à
 *       Roll20 (jusqu'à dix minutes). Dès qu'il te voit connecté, il note
 *       l'adresse de la partie et se referme. À faire UNE fois.
 *
 *   node outils/pilote.js recon
 *       Ouvre la partie, laisse l'extension se poser, appelle __vttinkerRecon()
 *       et écrit le relevé dans outils/releves/.
 *
 *   node outils/pilote.js js "<code>"
 *       Exécute ce code dans la page et écrit ce qu'il rend.
 *
 *   node outils/pilote.js zoom
 *       La suite d'essais du zoom, mais SUR LA VRAIE PARTIE : bornes élargies,
 *       molette et boutons poussés au-delà, capture d'écran à chaque étape, et
 *       remise en état. C'est le banc d'essai de outils/verifie.js confronté au
 *       vrai Roll20 au lieu d'un modèle.
 *
 *   node outils/pilote.js journal
 *       Ce que l'extension a écrit dans sa console, sans ouvrir de console.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Builder, By } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

const RACINE = path.join(__dirname, "..");
const EXT = path.join(RACINE, "extension");
const PROFIL = path.join(__dirname, ".profil");
const PILOTE = path.join(__dirname, ".bin", "geckodriver.exe");
const CONFIG = path.join(__dirname, "config.json");
const RELEVES = path.join(__dirname, "releves");

const FIREFOX = [
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"
].find(fs.existsSync);

function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch (e) { return {}; }
}
function ecrisConfig(o) {
  fs.writeFileSync(CONFIG, JSON.stringify(Object.assign(config(), o), null, 2) + "\n", "utf8");
}
function releve(nom, contenu) {
  fs.mkdirSync(RELEVES, { recursive: true });
  const p = path.join(RELEVES, nom);
  fs.writeFileSync(p, typeof contenu === "string" ? contenu : JSON.stringify(contenu, null, 2), "utf8");
  console.log("  écrit : " + path.relative(RACINE, p));
  return p;
}
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/* L'ÉTIQUETTE SE FABRIQUE PAR LE MODÈLE DE L'EXTENSION, jamais à la main.
 *
 * Depuis qu'elle PORTE l'adresse, une étiquette écrite en dur dans une sonde est
 * un mensonge dès que l'adresse de l'épreuve est découverte à l'exécution — le
 * pont dessinerait l'image que dit l'ÉTIQUETTE, pas celle que dit la palette, et
 * la sonde comparerait deux choses sans rapport en croyant les avoir accordées.
 *
 * On charge donc le vrai fichier, celui que l'extension embarque. S'il changeait
 * de règles, les sondes changeraient avec lui — ce qui est bien le but. */
const MODELE = (function () {
  const src = fs.readFileSync(path.join(EXT, "commun", "marqueurs.js"), "utf8");
  const bac = {};
  new Function("g", src + "\n;g.etiquette = vttMarqueurEtiquette;" +
    "g.lis = vttMarqueurDepuisEtiquette; g.propres = vttMarqueursPropres;")(bac);
  return bac;
})();
/* Un marqueur complet à partir d'un nom et d'une adresse : les trois champs
 * s'accordent par construction, et on saura tout de suite si l'un ne passe pas. */
function marqueur(nom, url) {
  const tag = MODELE.etiquette(nom, url);
  if (!tag) { throw new Error("étiquette impossible pour « " + nom + " » / " + url); }
  return { tag: tag, nom: nom, url: url };
}

/* Atteindre un magasin Pinia depuis la page. Il FAUT parcourir toutes les
 * racines Vue : Roll20 en monte une douzaine et toutes ne portent pas le Pinia.
 * Prendre la première venue échoue une fois sur deux — le pont fait la même
 * boucle, et c'est pour ça que lui trouve. */
const MAGASIN = "function __mag(n){" +
  "var r=document.querySelectorAll('[data-v-app]');" +
  "for(var i=0;i<r.length;i++){try{var a=r[i].__vue_app__," +
  "p=a&&a.config&&a.config.globalProperties&&a.config.globalProperties.$pinia;" +
  "if(p&&p._s&&p._s.get){var s=p._s.get(n);if(s)return s;}}catch(e){}}" +
  "throw new Error('magasin '+n+' introuvable');}";

/* L'IDENTIFIANT INTERNE DE L'EXTENSION, ÉPINGLÉ CÔTÉ PROFIL.
 *
 * Une page d'extension vit sous moz-extension://<identifiant>/…, et Firefox
 * tire cet identifiant AU HASARD à chaque installation — exprès, pour qu'une
 * page web ne puisse pas détecter les extensions installées. On ne va donc pas
 * le faire fuiter depuis l'extension pour la commodité d'un essai : ce serait
 * défaire une protection dans le produit pour arranger l'outillage.
 *
 * On l'impose plutôt côté profil, par user.js, que Firefox relit à chaque
 * démarrage. Le produit n'en sait rien, et l'adresse du panneau devient
 * connue d'avance. Cela ne vaut que pour ce profil d'essai. */
const UUID = "7b1f0a2c-4d3e-4a5b-8c6d-9e0f1a2b3c4d";
const BASE_EXT = "moz-extension://" + UUID + "/";

function epingleIdentifiant() {
  const lignes = [
    'user_pref("extensions.webextensions.uuids", ' +
      JSON.stringify(JSON.stringify({ "vttinker@igneefleur": UUID })) + ');',
    /* Ouvre le contexte privilégié de Firefox à WebDriver. Sans lui, on ne peut
     * pas ouvrir une page moz-extension://, donc pas éprouver le panneau — et
     * l'argument de ligne de commande équivalent est refusé par geckodriver.
     * Réservé à ce profil d'essai, qui ne sert qu'à ça. */
    'user_pref("remote.system-access-check.enabled", false);'
  ];
  fs.writeFileSync(path.join(PROFIL, "user.js"), lignes.join("\n") + "\n", "utf8");
}

/* SANS FENÊTRE, SAUF DEMANDE EXPRESSE.
 *
 * Le pilote tourne « headless ». Il n'ouvre une fenêtre que si
 * outils/config.json porte « "visible": true », et il faut donc l'écrire pour
 * l'obtenir.
 *
 * Le défaut faisait l'inverse — « visible !== false », donc vrai tant que la
 * clé n'existait pas —, et chacune des 131 sondes ouvrait une fenêtre qui
 * prenait le focus. L'instance était pourtant bien isolée : son propre profil,
 * et « -no-remote » pour ne jamais parler à celle de l'utilisateur. Isoler ne
 * suffit pas : ce qui se voit doit se demander. */
async function ouvre(visible) {
  if (!FIREFOX) { throw new Error("Firefox introuvable"); }
  fs.mkdirSync(PROFIL, { recursive: true });
  epingleIdentifiant();
  const opts = new firefox.Options()
    .setBinary(FIREFOX)
    // -profile plutôt que setProfile() : setProfile RECOPIE le profil dans un
    // dossier temporaire, et la connexion à Roll20 serait perdue à chaque
    // lancement. Ici Firefox travaille dans le nôtre, en place.
    .addArguments("-profile", PROFIL)
    /* « -no-remote », ET C'EST IMPÉRATIF.
     *
     * Sans ce drapeau, lancer firefox.exe pendant qu'un Firefox tourne déjà ne
     * démarre PAS un second navigateur : la demande est transmise à celui qui
     * est ouvert, qui ouvre l'onglet lui-même. Le pilote croit alors piloter son
     * instance à lui, et à la fin driver.quit() FERME LE NAVIGATEUR DE
     * L'UTILISATEUR — onglets, session, tout. C'est arrivé, et c'est
     * inacceptable.
     *
     * Avec le drapeau, l'instance d'essai est isolée : elle ignore celle qui
     * existe, et elle est la seule qu'on puisse arrêter. La commande
     * « connexion » l'utilisait déjà ; il manquait ici. */
    .addArguments("-no-remote");
  if (!visible) { opts.addArguments("-headless"); }
  const service = new firefox.ServiceBuilder(PILOTE);
  return await new Builder().forBrowser("firefox").setFirefoxOptions(opts).setFirefoxService(service).build();
}

/* L'extension est posée en MODULE TEMPORAIRE, comme dans about:debugging : rien
 * n'est signé, rien n'est installé durablement, et elle disparaît avec la
 * session.
 *
 * Le dossier non empaqueté d'abord, parce qu'il n'y a alors RIEN à construire :
 * ce qui tourne est exactement ce qui est sur le disque, et une correction se
 * teste sans étape intermédiaire où se glisserait une version périmée. Si le
 * pilote le refuse, on lui fabrique un .xpi à la volée — c'est-à-dire un zip,
 * qu'on demande à Windows plutôt que d'ajouter une dépendance pour ça. */
async function poseExtension(driver) {
  try {
    await driver.installAddon(EXT, true);
    console.log("  extension posée (dossier, module temporaire)");
    return;
  } catch (e) {
    console.log("  dossier refusé (" + e.message.slice(0, 80) + "), on empaquette");
  }
  const build = path.join(__dirname, ".bin");
  fs.mkdirSync(build, { recursive: true });
  const xpi = path.join(build, "vttinker.xpi");
  try { fs.unlinkSync(xpi); } catch (e) {}
  require("child_process").execFileSync("powershell", ["-NoProfile", "-Command",
    "Compress-Archive -Path '" + path.join(EXT, "*") + "' -DestinationPath '" + xpi + "' -Force"],
    { stdio: "pipe" });
  await driver.installAddon(xpi, true);
  console.log("  extension posée (xpi, module temporaire)");
}

/* `campagne` : l'identifiant d'une partie précise. Sans lui, Roll20 rouvre la
 * dernière de la session — ce qui suffisait tant qu'on n'en éprouvait qu'une.
 * Depuis qu'il existe une partie « joueur » à côté de la partie « MJ », il faut
 * pouvoir dire laquelle, et `setcampaign` est le chemin de Roll20 lui-même. */
async function vaALaPartie(driver, campagne) {
  const c = config();
  const url = campagne
    ? "https://app.roll20.net/editor/setcampaign/" + campagne
    : (c.partie || "https://app.roll20.net/campaigns/");
  await driver.get(url);
  // La partie met du temps à se monter : on attend le canevas de la table, pas
  // un nombre de secondes choisi au doigt mouillé.
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    /* ---------- « CHARGÉE » NE VEUT PAS DIRE « PRÊTE » ----------
     *
     * Le test se contentait de la toile et de la barre d'outils. Or les deux
     * existent AVANT que la partie soit montée : sur une campagne d'héritage,
     * il a rendu « chargée en 0 s » sur une page qui affichait encore
     * « Chargement… Connexion au serveur », et tout ce qui a été mesuré ensuite
     * l'a été sur une page à moitié faite — pas de scène, pas de sections
     * d'outils, et des conclusions fausses sur la version de Roll20.
     *
     * On demande donc en plus la CAMPAGNE et sa page active : c'est ce dont tout
     * le reste dépend, et c'est ce qui arrive en dernier. Et l'on refuse tant
     * que le voile de chargement est là. */
    const pret = await driver.executeScript([
      "if (!document.getElementById('babylonCanvas')) { return false; }",
      "if (!document.querySelector('#vm-master-toolbar,#master-toolbar')) { return false; }",
      "var voile = document.querySelector('#loading-overlay, .loading-overlay, #loadingoverlay');",
      "if (voile && voile.offsetParent !== null) { return false; }",
      "try { return !!(window.Campaign && Campaign.activePage && Campaign.activePage()); }",
      "catch (e) { return false; }"
    ].join(String.fromCharCode(10))).catch(() => false);
    if (pret) { console.log("  partie chargée en " + Math.round((Date.now() - t0) / 1000) + " s"); return true; }
    await dors(1500);
  }
  /* ---------- QUAND ELLE NE CHARGE PAS, ON DIT POURQUOI ----------
   *
   * « La partie ne s'est pas chargée » est un constat, pas un diagnostic : on ne
   * sait ni où l'on a atterri, ni si la session tient encore. Quatre-vingt-dix
   * secondes d'attente pour une phrase qui n'apprend rien, c'est cher. */
  try {
    const ou = await driver.executeScript(
      "return { url: location.href.slice(0, 110), titre: document.title.slice(0, 70)," +
      "  toile: !!document.getElementById('babylonCanvas')," +
      "  barre: !!document.querySelector('#vm-master-toolbar,#master-toolbar')," +
      "  connexion: !!document.querySelector('input[type=password], form[action*=login]')," +
      "  texte: (document.body ? document.body.textContent : '').replace(/s+/g, ' ').trim().slice(0, 160) };");
    console.log("  où l'on est : " + JSON.stringify(ou));
  } catch (e) { console.log("  et la page ne répond pas : " + String(e.message).slice(0, 80)); }
  return false;
}

// Le pont ne s'injecte qu'à la demande d'un module : on lui laisse le temps.
async function attendPont(driver, secondes) {
  const t0 = Date.now();
  while (Date.now() - t0 < (secondes || 25) * 1000) {
    const la = await driver.executeScript("return typeof window.__vttinkerRecon === 'function';").catch(() => false);
    if (la) { return true; }
    await dors(700);
  }
  return false;
}

/* OUVRIR LA PAGE DU PANNEAU DANS UN ONGLET, ET Y RESTER.
 *
 * Deux voies, dans cet ordre. La normale d'abord : un onglet neuf et une
 * navigation vers moz-extension://…, qui ne demande aucun privilège.
 *
 * La seconde ne sert que si la première échoue : le contexte de l'interface de
 * Firefox, qui sait ouvrir n'importe quelle adresse. Elle a longtemps été la
 * seule employée ici, et elle a cessé de fonctionner sans prévenir — Firefox
 * exige désormais « -remote-allow-system-access », un drapeau que geckodriver
 * refuse de transmettre. D'où l'ordre : ce qui ne dépend de personne d'abord.
 *
 * Rend le descripteur de l'onglet ouvert, ou null. */
async function ouvrePanneau(driver, avant) {
  try {
    await driver.switchTo().newWindow("tab");
    await driver.get(BASE_EXT + "popup/popup.html");
    await dors(900);
    const bon = await driver.executeScript(
      "return !!document.querySelector('.carte-titre');").catch(() => false);
    if (bon) { return await driver.getWindowHandle(); }
    console.log("  voie normale : page atteinte mais vide — " +
                String(await driver.getCurrentUrl().catch(() => "?")).slice(0, 70));
  } catch (e) {
    console.log("  voie normale refusée : " + String(e.message).slice(0, 110));
  }
  try {
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript("openTrustedLinkIn(arguments[0], 'tab');", BASE_EXT + "popup/popup.html");
    await driver.setContext(firefox.Context.CONTENT);
    await dors(1200);
    const neuf = (await driver.getAllWindowHandles()).find((h) => avant.indexOf(h) < 0);
    if (neuf) { await driver.switchTo().window(neuf); await dors(900); return neuf; }
  } catch (e) {
    console.log("  panneau inaccessible : " + String(e.message).slice(0, 90));
  }
  return null;
}

/* REGARDER DE PRÈS, SANS TOUCHER À LA CAMÉRA.
 *
 * Une rangée de pictogrammes fait dix-neuf pixels de haut : sur une capture
 * plein écran, on ne distingue pas une image d'une image RETOURNÉE. Déplacer la
 * caméra pour s'en approcher, on a essayé — Roll20 s'en est trouvé si mal qu'il
 * a rechargé la page.
 *
 * On découpe donc APRÈS coup. La capture repart dans la page, se dessine
 * agrandie dans un canevas détaché (jamais inséré dans le document, donc
 * invisible et sans effet), et revient découpée. Le lissage est coupé : on veut
 * voir les pixels tels qu'ils sont, pas une interpolation qui les arrangerait.
 *
 * `monde` est un point du plateau ; le cadre est centré dessus. */
async function captureZoom(driver, nom, monde, rayon, echelle) {
  const png = await driver.takeScreenshot();
  /* ON NE REFAIT PAS LA PROJECTION À LA MAIN.
   *
   * Premier jet : orthoLeft/orthoTop et la position de la caméra. Résultat, une
   * découpe entièrement blanche — et l'explication tient en une ligne du relevé
   * précédent : la caméra est en (0, 0, 0) alors que les tokens sont vers
   * (700, -840) et bien visibles. Le plateau est donc promené par un parent que
   * cette formule ignorait.
   *
   * On passe par Vector3.Project, qui tient compte de TOUT — parent compris. La
   * classe se prend sur un objet vivant, la page n'exposant pas le global. */
  const cadre = await driver.executeScript(
    "var S = window.MeshScene, e = S.getEngine();" +
    "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
    "var cv = e.getRenderingCanvas() || document.querySelector('canvas');" +
    "if (!c || !cv) { return null; }" +
    "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
    "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
    "function proj(x, y, z) { return V.Project(new V(x, y, z), M.Identity(), S.getTransformMatrix(), vp); }" +
    "var r = cv.getBoundingClientRect();" +
    "var kx = r.width / e.getRenderWidth(), ky = r.height / e.getRenderHeight();" +
    "var p = proj(arguments[0], arguments[1], arguments[2]);" +
    /* Le facteur d'échelle se mesure au lieu de se calculer : on projette un
     * second point à dix unités et on regarde ce que ça fait en pixels. */
    "var q = proj(arguments[0] + 10, arguments[1], arguments[2]);" +
    "return { x: p.x * kx + r.left, y: p.y * ky + r.top," +
    "         parUnite: Math.abs(q.x - p.x) * kx / 10," +
    "         canevas: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]," +
    "         dpr: window.devicePixelRatio };",
    monde[0], monde[1], monde[2] || 0);
  if (!cadre) { console.log("  cadrage impossible"); return null; }
  const demi = Math.max(8, rayon * cadre.parUnite);
  console.log("  cadre : centre (" + Math.round(cadre.x) + ", " + Math.round(cadre.y) +
              ") ± " + Math.round(demi) + " px, canevas " + JSON.stringify(cadre.canevas) +
              ", " + cadre.parUnite.toFixed(2) + " px par unité");
  const dec = await driver.executeAsyncScript(
    "var cb = arguments[arguments.length - 1];" +
    "var x0 = arguments[1], y0 = arguments[2], w = arguments[3], e = arguments[4];" +
    "var img = new Image();" +
    "img.onload = function () {" +
    "  var c = document.createElement('canvas');" +
    "  c.width = Math.round(w * e); c.height = Math.round(w * e);" +
    "  var g = c.getContext('2d');" +
    "  g.imageSmoothingEnabled = false;" +
    "  g.drawImage(img, x0, y0, w, w, 0, 0, c.width, c.height);" +
    "  try { cb(c.toDataURL('image/png')); } catch (err) { cb('ERREUR ' + String(err)); } };" +
    "img.onerror = function () { cb('ERREUR chargement'); };" +
    "img.src = 'data:image/png;base64,' + arguments[0];",
    png, Math.round(cadre.x - demi), Math.round(cadre.y - demi),
    Math.round(demi * 2), echelle || 6);
  if (typeof dec !== "string" || dec.indexOf("data:image/png;base64,") !== 0) {
    console.log("  découpe impossible : " + String(dec).slice(0, 80));
    return null;
  }
  fs.mkdirSync(RELEVES, { recursive: true });
  const p = path.join(RELEVES, nom);
  fs.writeFileSync(p, Buffer.from(dec.split(",")[1], "base64"));
  console.log("  capture rapprochée : " + path.relative(RACINE, p) +
              " (×" + (echelle || 6) + ")");
  return p;
}

/* LE DOCUMENT DE PARTAGE NE DOIT PAS SURVIVRE À UNE SONDE.
 *
 * Depuis que le module publie son catalogue, toute épreuve qui lui envoie une
 * palette laisse un document dans la VRAIE campagne de l'auteur — avec des
 * marqueurs d'essai dedans. C'est légitime en usage normal ; ça ne l'est pas comme
 * résidu d'un outil de développement. */
async function oteDocumentMarqueurs(driver) {
  const n = await driver.executeScript(
    "var C = window.Campaign; if (!C || !C.handouts) { return 0; }" +
    "var n = 0;" +
    "C.handouts.models.slice().forEach(function (h) {" +
    "  if (/^VTTinker/.test((h.attributes || {}).name || '')) {" +
    "    try { h.destroy(); n++; } catch (e) {} } });" +
    "return n;").catch(() => null);
  if (n) { console.log("  document de partage retiré (" + n + ")"); }
  return n;
}

/* Un gros plan à des coordonnées d'ÉCRAN, sans passer par la caméra du plateau :
 * la colonne d'outils n'est pas dans la scène Babylon. Même découpe que
 * captureZoom — la capture repart dans la page, se dessine agrandie dans un
 * canevas détaché, et revient. */
async function capturePres(driver, nom, x, y, l, h, echelle) {
  const png = await driver.takeScreenshot();
  const dec = await driver.executeAsyncScript(
    "var cb = arguments[arguments.length - 1];" +
    "var x0 = arguments[1], y0 = arguments[2], w = arguments[3], hh = arguments[4], e = arguments[5];" +
    "var img = new Image();" +
    "img.onload = function () {" +
    "  var c = document.createElement('canvas');" +
    "  c.width = Math.round(w * e); c.height = Math.round(hh * e);" +
    "  var g = c.getContext('2d');" +
    "  g.imageSmoothingEnabled = false;" +
    "  g.drawImage(img, x0, y0, w, hh, 0, 0, c.width, c.height);" +
    "  try { cb(c.toDataURL('image/png')); } catch (err) { cb('ERREUR ' + String(err)); } };" +
    "img.onerror = function () { cb('ERREUR chargement'); };" +
    "img.src = 'data:image/png;base64,' + arguments[0];",
    png, Math.round(x), Math.round(y), Math.round(l), Math.round(h), echelle || 6);
  if (typeof dec !== "string" || dec.indexOf("data:image/png;base64,") !== 0) {
    console.log("  découpe impossible : " + String(dec).slice(0, 80));
    return null;
  }
  fs.mkdirSync(RELEVES, { recursive: true });
  const p = path.join(RELEVES, nom);
  fs.writeFileSync(p, Buffer.from(dec.split(",")[1], "base64"));
  console.log("  gros plan : " + path.relative(RACINE, p) + " (×" + (echelle || 6) + ")");
  return p;
}

async function capture(driver, nom) {
  const png = await driver.takeScreenshot();
  fs.mkdirSync(RELEVES, { recursive: true });
  const p = path.join(RELEVES, nom);
  fs.writeFileSync(p, Buffer.from(png, "base64"));
  console.log("  capture : " + path.relative(RACINE, p));
}

/* ---------- connexion ----------
 *
 * LA CONNEXION SE FAIT DANS UN FIREFOX ORDINAIRE, JAMAIS DANS LE PILOTÉ.
 *
 * Roll20 protège sa page de connexion par un contrôle anti-robot, et un
 * navigateur conduit par geckodriver s'annonce comme tel : il pose
 * navigator.webdriver et ouvre Marionette. Le contrôle le voit, et il a raison
 * de le voir — ce n'est pas à contourner.
 *
 * On n'en a pas besoin. Firefox est lancé ici SANS aucune automatisation, comme
 * si on l'avait cliqué : un humain se connecte, résout ce qu'il y a à résoudre,
 * et les cookies obtenus restent dans le profil. Le pilote ne fait ensuite que
 * s'en servir — il n'a plus jamais à se connecter, donc plus jamais à passer
 * devant ce contrôle.
 *
 * On attend la FERMETURE de Firefox plutôt qu'un signe dans la page : sans
 * Marionette, on ne voit rien de ce qui s'y passe, et c'est justement le but. */
/* DEUX COMMANDES, ET PAS UNE SEULE QUI DEVINERAIT. Attendre la fermeture de la
 * fenêtre paraissait plus simple, mais Firefox sous Windows se relaie entre
 * processus : celui qu'on lance rend la main presque aussitôt, et la suite
 * partait pendant qu'on tapait encore son mot de passe. Un délai choisi au
 * doigt mouillé n'aurait fait que déplacer le problème. C'est donc l'humain qui
 * dit quand il a fini, en lançant la seconde commande. */
async function connexion() {
  fs.mkdirSync(PROFIL, { recursive: true });
  const { spawn } = require("child_process");
  // -no-remote : sans lui, si un Firefox tourne déjà, celui-ci lui passerait
  // simplement l'adresse et se refermerait — profil ordinaire compris.
  spawn(FIREFOX, ["-profile", PROFIL, "-no-remote", "https://app.roll20.net/campaigns/"],
        { stdio: "ignore", detached: true }).unref();
  console.log("Firefox s'ouvre sur le profil dédié, SANS automatisation.\n");
  console.log("  1. connecte-toi à Roll20 ;");
  console.log("  2. ouvre ta partie d'ESSAI (pas celle de tes joueurs) ;");
  console.log("  3. FERME cette fenêtre Firefox — entièrement ;");
  console.log("  4. puis lance :   node outils/pilote.js session\n");
  console.log("Cette fenêtre-là n'est pas pilotée : le contrôle anti-robot s'y résout");
  console.log("normalement, et le profil gardera les cookies.");
  return 0;
}

/* La session est-elle utilisable par le navigateur PILOTÉ ? C'est la seule
 * question qui compte, et mieux vaut y répondre maintenant que dans trois
 * commandes. */
async function session() {
  console.log("Contrôle de la session dans le navigateur piloté…");
  console.log("(si le profil est verrouillé, c'est que la fenêtre Firefox est encore ouverte)\n");
  const driver = await ouvre(true);
  try {
    await driver.get("https://app.roll20.net/campaigns/");
    await dors(4000);
    const etat = await driver.executeScript(
      "return { titre: document.title, url: location.href," +
      " connecte: !!document.querySelector('a[href*=\"/campaigns/details/\"]')," +
      " parties: [].slice.call(document.querySelectorAll('a[href*=\"/campaigns/details/\"]'))" +
      "            .slice(0, 10).map(function (a) { return { nom: (a.textContent || '').trim().slice(0, 60), lien: a.href }; }) };"
    );
    if (!etat.connecte) {
      console.log("\nLa session ne passe pas dans le navigateur piloté.");
      console.log("  page atteinte : " + etat.url + "  (« " + etat.titre + " »)");
      console.log("\nSi c'est encore le contrôle anti-robot, laisse la fenêtre ouverte : elle est");
      console.log("visible, et le résoudre à la main une fois suffit — le profil gardera le marqueur.");
      await dors(120000);
      const encore = await driver.executeScript("return !!document.querySelector('a[href*=\"/campaigns/details/\"]');");
      if (!encore) { console.log("Toujours pas. On changera de méthode."); return 1; }
    }
    const parties = etat.parties && etat.parties.length ? etat.parties : await driver.executeScript(
      "return [].slice.call(document.querySelectorAll('a[href*=\"/campaigns/details/\"]'))" +
      "        .slice(0, 10).map(function (a) { return { nom: (a.textContent || '').trim().slice(0, 60), lien: a.href }; });");
    console.log("\nSession valide. Parties visibles :");
    parties.forEach(function (p, i) { console.log("  " + (i + 1) + ". " + p.nom + "  " + p.lien); });
    ecrisConfig({ partie: "https://app.roll20.net/editor/", parties: parties });
    console.log("\nAdresse de travail retenue : https://app.roll20.net/editor/");
    console.log("Roll20 y rouvre la dernière partie de la session. Pour en imposer une autre,");
    console.log("écris son adresse d'éditeur dans outils/config.json, champ « partie ».");
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- DIRE BONJOUR DANS LE CHAT DE PLUSIEURS PARTIES ----------
 *
 * Demandé pour éprouver le passage d'une partie à l'autre : on ouvre chacune et
 * on y poste un message.
 *
 * ON PASSE PAR LE CHAMP DE SAISIE, PAS PAR UNE FONCTION INTERNE. Appeler
 * `d20.textchat.doChatInput` serait plus court, mais ce n'est pas le chemin
 * qu'emprunte un joueur : on n'éprouverait alors ni le champ, ni son bouton, ni
 * ce que Roll20 fait de la frappe. Et si sa fonction change de nom demain, une
 * sonde qui l'appelle se tait au lieu d'échouer.
 *
 * On VÉRIFIE que le message est arrivé en le relisant dans le journal du chat.
 * Un envoi qui ne se relit pas n'est pas un envoi. */
async function salutParties() {
  const driver = await ouvre(config().visible === true);
  try {
    /* ---- 1. LES PARTIES VISIBLES, avec leur identifiant ---- */
    await driver.get("https://app.roll20.net/campaigns/");
    await dors(4500);
    /* LE NOM N'EST PAS DANS LE LIEN. Un premier jet lisait `a.textContent` et
     * rendait dix parties toutes nommées « » : le lien enveloppe la vignette,
     * pas le titre. On remonte donc la carte et on prend le premier texte
     * plausible qu'on y trouve — titre, aria-label, ou le texte de la carte. */
    const parties = await driver.executeScript(
      /* L'ARIA-LABEL EN DERNIER, ET NON EN PREMIER. Il vaut « Navigate to
       * user_campaign » sur les cartes récentes : quatre parties portaient donc
       * le même nom, dont les deux qu'on cherchait. Un libellé d'accessibilité
       * décrit l'action du lien, pas le titre de ce qu'il ouvre. */
      "function nomDe(a) {" +
      "  var t = (a.textContent || '').replace(/\\s+/g, ' ').trim();" +
      "  if (t) { return t; }" +
      "  var n = a, k = 0;" +
      "  while (n && k < 5) {" +
      "    var h = n.querySelector && n.querySelector('h1,h2,h3,h4,.campaign-title,[class*=title],[class*=name]');" +
      "    if (h) { var s = (h.textContent || '').replace(/\\s+/g, ' ').trim(); if (s) { return s; } }" +
      "    n = n.parentNode; k++; }" +
      "  n = a.parentNode; k = 0;" +
      "  while (n && k < 4) {" +
      "    var s2 = (n.textContent || '').replace(/\\s+/g, ' ').trim();" +
      "    if (s2 && s2.length < 120) { return s2; }" +
      "    n = n.parentNode; k++; }" +
      "  return (a.getAttribute('aria-label') || a.title || '').trim(); }" +
      "return [].slice.call(document.querySelectorAll('a[href*=\"/campaigns/details/\"]'))" +
      "  .map(function (a) {" +
      "    var m = String(a.href).match(/details\\/(\\d+)/);" +
      "    return { nom: nomDe(a).slice(0, 70), id: m ? m[1] : null, lien: a.href }; })" +
      "  .filter(function (p) { return p.id; });");
    const vues = {};
    const uniques = parties.filter((p) => (vues[p.id] ? false : (vues[p.id] = true)));
    if (!uniques.length) {
      console.log("Aucune partie visible — la session ne passe pas.");
      console.log("Lance d'abord : node outils/pilote.js session");
      return 1;
    }
    console.log("\n  parties visibles :");
    uniques.forEach((p) => console.log("    " + p.id + "  « " + p.nom + " »"));

    /* Celles qu'on vise : le nom donné par l'auteur, au plus proche. */
    const veut = ["Outward (Player Mode)", "Outward"];
    const cibles = [];
    veut.forEach(function (nom) {
      const exact = uniques.filter((p) => p.nom === nom)[0];
      const proche = uniques.filter((p) => p.nom.indexOf(nom) >= 0 && cibles.indexOf(p) < 0)[0];
      const p = exact || proche;
      if (p && cibles.indexOf(p) < 0) { cibles.push(p); }
    });
    if (cibles.length < 2) {
      console.log("\n  Je n'en retrouve que " + cibles.length + " sur deux :");
      cibles.forEach((p) => console.log("    " + p.id + "  « " + p.nom + " »"));
      console.log("  Dis-moi les noms exacts si les miens ne collent pas.");
      if (!cibles.length) { return 1; }
    }
    console.log("\n  parties visées :");
    cibles.forEach((p) => console.log("    " + p.id + "  « " + p.nom + " »"));

    const MESSAGE = "Hello World!";
    const bilan = [];

    for (const partie of cibles) {
      console.log("\n  ── « " + partie.nom + " » ──");
      await driver.get("https://app.roll20.net/editor/setcampaign/" + partie.id);
      await dors(12000);

      const ou = await driver.executeScript(
        "return { url: location.href, titre: document.title," +
        "  champ: !!document.querySelector('#textchat-input textarea, textarea#textchat-input') };");
      console.log("     ouverte : " + ou.url + "   champ de chat : " + ou.champ);
      if (!ou.champ) {
        /* La partie peut mettre longtemps à monter son interface : on laisse une
         * seconde chance avant de renoncer, plutôt que de conclure trop tôt. */
        await dors(9000);
      }

      const envoi = await driver.executeScript(
        "var texte = arguments[0];" +
        "var z = document.querySelector('#textchat-input textarea') ||" +
        "        document.querySelector('textarea#textchat-input') ||" +
        "        document.querySelector('#textchat-input [contenteditable]');" +
        "if (!z) { return { ok: false, raison: 'champ de chat introuvable' }; }" +
        "z.focus();" +
        /* ON ÉCRIT COMME LE NAVIGATEUR ÉCRIT. Poser `value` directement ne
         * prévient ni Vue ni React, qui ne verraient rien passer : on emploie le
         * setteur natif du prototype puis on émet « input », ce qui est la
         * manière reconnue de simuler une frappe dans un champ contrôlé. */
        "var proto = Object.getPrototypeOf(z);" +
        "var d = Object.getOwnPropertyDescriptor(proto, 'value');" +
        "if (d && d.set) { d.set.call(z, texte); } else { z.value = texte; }" +
        "z.dispatchEvent(new Event('input', { bubbles: true }));" +
        "var avant = z.value;" +
        "['keydown', 'keypress', 'keyup'].forEach(function (t) {" +
        "  z.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter'," +
        "    keyCode: 13, which: 13, bubbles: true, cancelable: true })); });" +
        "var bouton = document.querySelector('#textchat-input .btn, #textchat-input button');" +
        "return { ok: true, ecrit: avant, videApres: z.value === ''," +
        "  bouton: !!bouton };", MESSAGE);
      console.log("     saisie : " + JSON.stringify(envoi));
      if (!envoi.ok) { bilan.push({ partie: partie.nom, envoye: false, raison: envoi.raison }); continue; }

      /* SI ENTRÉE N'A PAS SUFFI, on presse son bouton. Certaines versions
       * n'envoient qu'au clic, et un message resté dans le champ n'est pas un
       * message envoyé. */
      if (!envoi.videApres && envoi.bouton) {
        await driver.executeScript(
          "var b = document.querySelector('#textchat-input .btn, #textchat-input button');" +
          "if (b) { b.click(); }");
        console.log("     Entrée n'a pas vidé le champ : bouton pressé");
      }
      await dors(3000);

      /* ---- LA VÉRIFICATION : on relit le journal du chat ---- */
      const relu = await driver.executeScript(
        "var texte = arguments[0];" +
        "var n = document.querySelectorAll('#textchat .message, .textchatcontainer .message');" +
        "var derniers = [].slice.call(n).slice(-6).map(function (m) {" +
        "  return (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80); });" +
        "return { trouve: derniers.some(function (l) { return l.indexOf(texte) >= 0; })," +
        "  derniers: derniers, total: n.length };", MESSAGE);
      console.log("     relu dans le chat : " + (relu.trouve ? "OUI" : "NON"));
      relu.derniers.slice(-3).forEach((l) => console.log("        · " + l));
      bilan.push({ partie: partie.nom, id: partie.id, envoye: relu.trouve });
    }

    console.log("\n  ──────────────────────────────────────────────");
    bilan.forEach((b) => console.log("  " + (b.envoye ? "✓" : "✗") + "  « " + b.partie + " »" +
      (b.raison ? "  — " + b.raison : "")));
    releve("salut-parties.json", { message: MESSAGE, parties: uniques, bilan });
    return bilan.every((b) => b.envoye) ? 0 : 1;
  } finally {
    await dors(800);
    await driver.quit().catch(() => {});
  }
}

/* ---------- L'EXTENSION VUE PAR UN JOUEUR ----------
 *
 * TOUT CE QU'ON A ÉPROUVÉ JUSQU'ICI L'A ÉTÉ EN MJ, et rien ne dit que ce que
 * l'extension trouve dans la page soit la même chose pour un joueur. Roll20 ne
 * lui montre ni les mêmes outils, ni les mêmes calques, ni les mêmes tokens, et
 * ne le laisse pas écrire ce qu'il veut.
 *
 * On ne devine donc rien : on ouvre la partie d'essai en joueur et on relève,
 * point par point, ce dont chaque module dépend. Ce qui manque ici est ce qu'il
 * faudra adapter — et ce qui est présent n'aura pas à l'être.
 */
/* LES PARTIES D'ESSAI NE SONT PLUS ÉCRITES ICI.
 *
 * Un identifiant de campagne désigne une vraie table, avec de vraies
 * personnes. Le dépôt est destiné à des pages publiques et le premier commit
 * est irréversible : ces deux nombres n'ont rien à y faire.
 *
 * Ils vivent dans outils/config.json, que .gitignore couvre déjà et où les
 * sondes lisent l'adresse de la partie courante. On échoue TÔT et EN LE
 * DISANT quand ils manquent — un identifiant vide part sans broncher, ouvre
 * une page de connexion, et l'on cherche la faute trois minutes plus loin
 * dans le mauvais fichier.
 */
function partieDEssai(role) {
  const c = config().essais || {};
  const id = role === "mj" ? c.mj : c.joueur;
  if (!id) {
    console.log("  Aucune partie d'essai « " + role + " » dans outils/config.json.");
    console.log("  Ajoute :   \"essais\": { \"joueur\": \"<identifiant>\", \"mj\": \"<identifiant>\" }");
    process.exit(1);
  }
  return String(id);
}

async function auditJoueur() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    const pont = await attendPont(driver, 40);
    console.log("  pont injecté : " + pont);
    await dors(10000);

    const r = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var out = {};" +

      /* ---- QUI SUIS-JE ---- */
      "var cp = window.currentPlayer || (window.Campaign && window.Campaign.players &&" +
      "  window.Campaign.players.get && null);" +
      "out.moi = { id: cp && cp.id, nom: cp && cp.attributes && cp.attributes.displayname," +
      "  mj: !!(cp && cp.attributes && (cp.attributes.d20userid !== undefined) && window.is_gm)," +
      "  is_gm: typeof window.is_gm !== 'undefined' ? window.is_gm : null," +
      "  d20surCp: !!(cp && cp.d20), d20surWindow: typeof window.d20 !== 'undefined' };" +

      /* ---- LA COLONNE D'OUTILS, où nos deux boutons se greffent ---- */
      "var bar = document.querySelector('#master-toolbar') || document.querySelector('#vm-master-toolbar');" +
      "out.barre = { existe: !!bar, id: bar ? bar.id : null," +
      "  hautes: bar ? bar.querySelectorAll('.upper-buttons').length : 0," +
      "  sections: bar ? bar.querySelectorAll('.spacer-outer').length : 0," +
      "  sectionsAvecTitre: bar ? [].slice.call(bar.querySelectorAll('.spacer-outer'))" +
      "    .filter(function (s) { return s.querySelector('.spacer-header'); }).length : 0," +
      "  boutons: bar ? bar.querySelectorAll('.toolbar-button-outer').length : 0," +
      "  boutonsVisibles: bar ? [].slice.call(bar.querySelectorAll('.toolbar-button-outer'))" +
      "    .filter(function (b) { return b.getBoundingClientRect().height > 4; }).length : 0," +
      "  intitules: bar ? [].slice.call(bar.querySelectorAll('.spacer-header'))" +
      "    .map(function (h) { return (h.textContent || '').trim(); }) : [] };" +

      /* ---- CE QUE L'EXTENSION A RÉUSSI À POSER ---- */
      "out.notre = { section: document.querySelectorAll('.vttk-outil-titre').length," +
      "  boutonReglages: document.querySelectorAll('.vttk-outil-reglages').length," +
      "  boutonMarqueurs: document.querySelectorAll('.vttk-outil-marqueurs').length," +
      "  palette: document.querySelectorAll('.vttk-barre').length," +
      "  tuiles: document.querySelectorAll('.vttk-barre-marqueur').length," +
      "  zoom: document.querySelectorAll('.vttk-zoom').length };" +

      /* ---- LE PLATEAU ET SES TOKENS ---- */
      "var C = window.Campaign;" +
      "var page = C && C.activePage && C.activePage();" +
      "var col = page && page.thegraphics;" +
      "out.plateau = { campagne: C ? C.id : null," +
      "  pageActive: page ? page.id : null," +
      "  playerpageid: C && C.attributes ? C.attributes.playerpageid : null," +
      "  memePage: !!(page && C && C.attributes && page.id === C.attributes.playerpageid)," +
      "  tokens: col ? col.models.length : null," +
      "  parCalque: (function () { var o = {};" +
      "    (col ? col.models : []).forEach(function (m) {" +
      "      var l = m.attributes.layer || '?'; o[l] = (o[l] || 0) + 1; }); return o; })()," +
      "  controlables: (col ? col.models : []).filter(function (m) {" +
      "    var c = m.attributes.controlledby || '';" +
      "    return c === 'all' || (cp && c.indexOf(cp.id) >= 0); }).length };" +

      /* ---- LE CATALOGUE DE MARQUEURS ---- */
      "var camp = mag('campaign');" +
      "out.marqueurs = { pinia: !!(camp && camp.tokenMarkerData)," +
      "  nPinia: camp && camp.tokenMarkerData ? camp.tokenMarkerData.length : 0," +
      "  attribut: !!(C && C.attributes && C.attributes.token_markers)," +
      "  quads: (window.MeshScene ? (window.MeshScene.meshes || []) : [])" +
      "    .filter(function (m) { return /^vttk-/.test(m.name); }).length," +
      "  pastilles: (window.MeshScene ? (window.MeshScene.meshes || []) : [])" +
      "    .filter(function (m) { return /-marker-template$/.test(m.name); }).length };" +

      /* ---- LE ZOOM ---- */
      "var eng = mag('engine');" +
      "out.zoom = { magasin: !!eng, valeur: eng ? eng.zoom : null," +
      "  setZoom: !!(eng && typeof eng.setZoom === 'function')," +
      "  setZoomSilent: !!(eng && typeof eng.setZoomSilent === 'function')," +
      "  stepAdjust: !!(eng && typeof eng.stepAdjustZoom === 'function')," +
      "  boutonsRoll20: !!document.getElementById('vm_zoom_buttons')," +
      "  preference: (function () { try { var p = mag('preference');" +
      "    return p && p.zoom ? p.zoom.interfaceEnabled : null; } catch (e) { return 'illisible'; } })() };" +

      /* ---- LA GRILLE ---- */
      "out.grille = { page: !!page," +
      "  type: page ? page.attributes.grid_type : null," +
      "  montre: page ? page.attributes.showgrid : null," +
      "  echelle: page ? page.attributes.snapping_increment : null," +
      "  maillages: (window.MeshScene ? (window.MeshScene.meshes || []) : [])" +
      "    .filter(function (m) { return /grille|grid/i.test(m.name); }).length };" +

      "out.journal = (window.__vttinkerJournal || []).slice(-14);" +
      "out.erreur = window.__vttinkerMarqueursErreur || null;" +
      "return out;");

    console.log("\n════ " + (quelle === "mj" ? "PARTIE MJ" : "PARTIE JOUEUR") + " ════");
    console.log("\n  moi        : " + JSON.stringify(r.moi));
    console.log("  barre      : " + JSON.stringify(r.barre));
    console.log("  nos pièces : " + JSON.stringify(r.notre));
    console.log("  plateau    : " + JSON.stringify(r.plateau));
    console.log("  marqueurs  : " + JSON.stringify(r.marqueurs));
    console.log("  zoom       : " + JSON.stringify(r.zoom));
    console.log("  grille     : " + JSON.stringify(r.grille));
    if (r.erreur) { console.log("\n  ERREUR RETENUE : " + r.erreur); }
    console.log("\n  journal :");
    r.journal.forEach((l) => console.log("    · " + l));

    releve("audit-" + quelle + ".json", r);
    return 0;
  } finally {
    await dors(800);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES FEATURES, ÉPROUVÉES EN JOUEUR ----------
 *
 * L'audit dit ce qui EXISTE ; celui-ci dit ce qui MARCHE. Un joueur n'a pas les
 * mêmes droits qu'un MJ, et la différence qui compte n'est pas dans le DOM mais
 * dans ce que le serveur accepte : Roll20 ne laisse écrire un token qu'à qui le
 * contrôle. Un module qui l'ignore fait voir à l'utilisateur un marqueur que
 * personne d'autre ne verra, et que le serveur effacera trois secondes plus tard.
 *
 * On éprouve donc, dans la partie joueur :
 *   1. poser un marqueur sur un token QU'ON CONTRÔLE ;
 *   2. poser un marqueur sur un token qu'on NE contrôle PAS — et regarder si ça
 *      tient, ou si le serveur le reprend ;
 *   3. le compteur, le zoom au-delà de 250, la palette et son mode édition. */
async function epreuveJoueur() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("joueur")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 40))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const A = "vttk_essaia_cdn.discordapp.com/embed/avatars/0.png";
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true," +
      "  catalogue: [{ tag: arguments[0], nom: 'Essai A'," +
      "    url: 'https://cdn.discordapp.com/embed/avatars/0.png' }] }, '*');", A);
    await dors(1500);

    /* Qui contrôle quoi — c'est la donnée qui décide de tout le reste. */
    const tokens = await driver.executeScript(
      "var cp = window.currentPlayer, C = window.Campaign;" +
      "return C.activePage().thegraphics.models.map(function (m) {" +
      "  var c = m.attributes.controlledby || '';" +
      "  return { id: m.id, nom: m.attributes.name, calque: m.attributes.layer," +
      "    controlePar: c," +
      "    mien: c === 'all' || (cp && c.indexOf(cp.id) >= 0)," +
      "    avant: m.attributes.statusmarkers || '' }; });");
    console.log("\n  tokens de la page :");
    tokens.forEach((t) => console.log("    " + (t.mien ? "à moi " : "à AUTRUI") +
      "  « " + t.nom + " »  contrôlé par « " + t.controlePar + " »"));

    const mien = tokens.filter((t) => t.mien)[0];
    const autrui = tokens.filter((t) => !t.mien)[0];

    const essaie = async (t, quoi) => {
      if (!t) { console.log("\n  (aucun token " + quoi + " sur cette page)"); return null; }
      console.log("\n  ── pose sur un token " + quoi + " : « " + t.nom + " » ──");
      await driver.executeScript(
        "var C = window.Campaign;" +
        "var t = C.activePage().thegraphics.get(arguments[0]);" +
        "t.save({ statusmarkers: arguments[1] });", t.id, A + "@3");
      await dors(1200);
      const tot = await driver.executeScript(
        "var C = window.Campaign;" +
        "var t = C.activePage().thegraphics.get(arguments[0]);" +
        "var S = window.MeshScene;" +
        "return { champ: t.attributes.statusmarkers," +
        "  quads: (S.meshes || []).filter(function (m) { return /^vttk-/.test(m.name); })" +
        "    .map(function (m) { return m.name.slice(0, 40); }) };", t.id);
      console.log("     aussitôt      : champ « " + tot.champ + " », " + tot.quads.length + " quad(s)");
      /* LE SERVEUR A LE DERNIER MOT, et il met une seconde ou deux à le dire.
       * C'est tout l'objet de cette épreuve : ce qui tient localement ne tient
       * pas forcément dans la campagne. */
      await dors(6000);
      const apres = await driver.executeScript(
        "var C = window.Campaign;" +
        "var t = C.activePage().thegraphics.get(arguments[0]);" +
        "var S = window.MeshScene;" +
        "return { champ: t.attributes.statusmarkers," +
        "  quads: (S.meshes || []).filter(function (m) { return /^vttk-/.test(m.name); }).length };", t.id);
      console.log("     six secondes après : champ « " + apres.champ + " », " + apres.quads + " quad(s)");
      const tient = String(apres.champ).indexOf(A) >= 0;
      console.log("     → la pose TIENT : " + (tient ? "OUI" : "NON — le serveur l'a reprise"));
      return { token: t.nom, quoi: quoi, aussitot: tot.champ, apres: apres.champ, tient: tient,
               quads: apres.quads };
    };

    const r1 = await essaie(mien, "À MOI");
    const r2 = await essaie(autrui, "D'AUTRUI");

    /* ---- LE REFUS, SUR UN TOKEN QU'ON NE CONTRÔLE PAS ----
     *
     * Les trois tokens de la partie d'essai appartiennent au joueur : le cas ne
     * s'y présente pas de lui-même. On change donc le `controlledby` EN LOCAL,
     * sans `save()` — rien ne part dans la campagne, et c'est bien notre
     * vérification qu'on éprouve, pas celle du serveur. */
    if (mien) {
      const refus = await driver.executeScript(
        "var C = window.Campaign;" +
        "var t = C.activePage().thegraphics.get(arguments[0]);" +
        "var garde = t.attributes.controlledby;" +
        "t.attributes.controlledby = 'UN-AUTRE-JOUEUR';" +
        "t.attributes.statusmarkers = '';" +
        /* On arme une tuile puis on clique le token, par le vrai chemin. */
        "var b = document.querySelector('.vttk-outil-marqueurs button'); if (b) { b.click(); }" +
        "var q = document.querySelector('.vttk-barre-marqueur[data-tag=\"' + arguments[1] + '\"]');" +
        "if (q) { q.click(); }" +
        "var S = window.MeshScene, e = S.getEngine(), cv = e.getRenderingCanvas();" +
        "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
        "var r = cv.getBoundingClientRect();" +
        "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
        "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
        "var p = V.Project(new V(t.attributes.left, -t.attributes.top, 9999000), M.Identity()," +
        "  S.getTransformMatrix(), vp);" +
        "var x = p.x * r.width / e.getRenderWidth() + r.left;" +
        "var y = p.y * r.height / e.getRenderHeight() + r.top;" +
        "cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y," +
        "  bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse'," +
        "  isPrimary: true, button: 0, buttons: 1 }));" +
        "var mot = document.querySelector('.vttk-barre-mot');" +
        "var res = { champ: t.attributes.statusmarkers," +
        "  mot: mot && !mot.hidden ? mot.textContent : null," +
        "  rouge: !!(mot && mot.className.indexOf('mauvais') >= 0) };" +
        "t.attributes.controlledby = garde;" +
        "return res;", mien.id, A);
      console.log("\n  ── refus sur un token qu'on ne contrôle pas ──");
      console.log("     champ resté : « " + refus.champ + " »");
      console.log("     la palette dit : " + JSON.stringify(refus.mot) + (refus.rouge ? "  (en rouge)" : ""));
      console.log("     → refusé ET expliqué : " +
        ((refus.champ === "" && refus.mot) ? "OUI" : "NON"));
    }

    /* ---- SON CONTRÔLE DE ZOOM EST-IL VRAIMENT MASQUÉ ? ---- */
    const sien = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var pref = mag('preference');" +
      "var z = document.getElementById('vm_zoom_buttons');" +
      "var r = z ? z.getBoundingClientRect() : null;" +
      "return { preference: pref && pref.zoom ? pref.zoom.interfaceEnabled : null," +
      "  bascule: !!(pref && typeof pref.toggleZoomInterfaceEnabled === 'function')," +
      "  element: !!z, affichage: z ? getComputedStyle(z).display : null," +
      "  taille: r ? [Math.round(r.width), Math.round(r.height)] : null," +
      "  enfants: z ? z.children.length : null };");
    console.log("\n  son contrôle de zoom : " + JSON.stringify(sien));

    /* ---- LA PALETTE, SON MODE ÉDITION, ET LE ZOOM ---- */
    const ui = await driver.executeScript(
      "var b = document.querySelector('.vttk-outil-marqueurs button'); if (b) { b.click(); }" +
      "return null;");
    await dors(1200);
    const palette = await driver.executeScript(
      "var b = document.querySelector('.vttk-barre');" +
      "var r = b ? b.getBoundingClientRect() : null;" +
      "return { ouverte: !!(b && b.className.indexOf('ouvert') >= 0)," +
      "  largeur: r ? Math.round(r.width) : null, hauteur: r ? Math.round(r.height) : null," +
      "  tuiles: b ? b.querySelectorAll('.vttk-barre-marqueur').length : 0," +
      "  rouage: b ? b.querySelectorAll('.vttk-barre-rouage').length : 0 };");
    console.log("\n  palette : " + JSON.stringify(palette));

    const edition = await driver.executeScript(
      "var r = document.querySelector('.vttk-barre-rouage'); if (r) { r.click(); }" +
      "var b = document.querySelector('.vttk-barre');" +
      "return { edition: !!(b && b.className.indexOf('edition') >= 0)," +
      "  champs: b ? b.querySelectorAll('.vttk-marqueur-champ').length : 0," +
      "  croix: b ? b.querySelectorAll('.vttk-marqueur-sup').length : 0," +
      "  ouverte: !!(b && b.className.indexOf('ouvert') >= 0) };");
    console.log("  édition : " + JSON.stringify(edition));

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 900 }, '*');");
    await dors(2000);
    const zoom = await driver.executeScript(
      "function eng() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }" +
      "var st = eng(), S = window.MeshScene;" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var avant = c.orthoTop;" +
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 500 }, '*');" +
      "return { avant: +avant.toFixed(1), magasin: st.zoom," +
      "  commande: document.querySelectorAll('.vttk-zoom').length," +
      "  sienMasque: (function () { var z = document.getElementById('vm_zoom_buttons');" +
      "    return z ? getComputedStyle(z).display : 'absent'; })() };");
    await dors(1500);
    const zoom2 = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "return { apres: +c.orthoTop.toFixed(1) };");
    console.log("\n  zoom : " + JSON.stringify(zoom) + "  →  " + JSON.stringify(zoom2));
    console.log("    la caméra a-t-elle bougé ? " + (Math.abs(zoom.avant - zoom2.apres) > 1 ? "OUI" : "NON"));

    /* ---- LE PANNEAU DES RÉGLAGES, en joueur ----
     *
     * C'est un CADRE sur une page moz-extension:// : rien ne dit qu'un joueur y
     * ait les mêmes droits, et c'est par lui qu'on allume les modules. */
    const panneau = await driver.executeScript(
      "var b = document.querySelector('.vttk-outil-reglages button'); if (b) { b.click(); }" +
      "var r = document.querySelector('.vttk-reglages');" +
      "var q = r ? r.getBoundingClientRect() : null;" +
      "return { existe: !!r, cadre: !!(r && r.tagName === 'IFRAME')," +
      "  adresse: r ? String(r.src || '').slice(0, 46) : null," +
      "  taille: q ? [Math.round(q.width), Math.round(q.height)] : null };");
    console.log("\n  panneau des réglages : " + JSON.stringify(panneau));

    /* ---- ET SON CONTRÔLE DE ZOOM, MESURÉ AU BON ENDROIT ----
     *
     * `display` reste « block » même masqué : Roll20 ne retire pas l'élément, il
     * le RÉDUIT — 230 × 342 avec son glisseur, 230 × 70 sans. Un premier jet
     * lisait `display` et concluait que le masquage ne marchait pas. C'est la
     * TAILLE qui le dit. */
    const apresInstall = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var pref = mag('preference'), z = document.getElementById('vm_zoom_buttons');" +
      "var r = z ? z.getBoundingClientRect() : null;" +
      "return { preference: pref && pref.zoom ? pref.zoom.interfaceEnabled : null," +
      "  taille: r ? [Math.round(r.width), Math.round(r.height)] : null };");
    console.log("  son contrôle après installation : " + JSON.stringify(apresInstall) +
      (apresInstall.taille && apresInstall.taille[1] < 200 ? "   (réduit : masqué)" : "   (ENTIER : pas masqué)"));

    const journal = await driver.executeScript("return (window.__vttinkerJournal || []).slice(-10);");
    console.log("\n  journal :");
    journal.forEach((l) => console.log("    · " + l));

    releve("epreuve-joueur.json", { tokens, mien: r1, autrui: r2, palette, edition, zoom, zoom2 });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "C.activePage().thegraphics.models.forEach(function (m) {" +
      "  var s = m.attributes.statusmarkers || '';" +
      "  if (s.indexOf('vttk_') >= 0) {" +
      "    m.save({ statusmarkers: s.split(',').filter(function (x) {" +
      "      return x.indexOf('vttk_') !== 0; }).join(',') }); } });")
      .catch(() => {});
    await dors(1500);
    await driver.quit().catch(() => {});
  }
}

/* ---------- SA BASCULE DE CONTRÔLE FONCTIONNE-T-ELLE ? ----------
 *
 * Le module annonce « contrôle de Roll20 masqué » et le contrôle reste affiché,
 * 230 × 342, dans les deux modes. Il appelle `toggleZoomInterfaceEnabled` sur le
 * magasin des préférences, et considère l'affaire close.
 *
 * On regarde donc ce que cette bascule fait vraiment : la préférence change-t-elle,
 * et l'élément disparaît-il ? Tant qu'on ne le sait pas, on ne peut ni corriger
 * ni s'en passer. */
async function basculeControle() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 40))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const MAG =
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "function etat() { var pref = mag('preference');" +
      "  var z = document.getElementById('vm_zoom_buttons');" +
      "  var r = z ? z.getBoundingClientRect() : null;" +
      "  return { pref: pref && pref.zoom ? pref.zoom.interfaceEnabled : null," +
      "    affiche: z ? getComputedStyle(z).display : 'absent'," +
      "    taille: r ? [Math.round(r.width), Math.round(r.height)] : null }; }";

    console.log("\n════ " + (quelle === "mj" ? "PARTIE MJ" : "PARTIE JOUEUR") + " ════");
    const avant = await driver.executeScript(MAG + "return etat();");
    console.log("  avant       : " + JSON.stringify(avant));

    const cles = await driver.executeScript(MAG +
      "var pref = mag('preference');" +
      "if (!pref) { return { erreur: 'pas de magasin preference' }; }" +
      "var fns = [], champs = [];" +
      "for (var k in pref) { try {" +
      "  if (typeof pref[k] === 'function') { if (/zoom|interface/i.test(k)) { fns.push(k); } }" +
      "  else if (/zoom|interface/i.test(k)) { champs.push(k + '=' + JSON.stringify(pref[k]).slice(0, 60)); }" +
      "} catch (e) {} }" +
      "return { fonctions: fns, champs: champs };");
    console.log("  ce qu'il offre : " + JSON.stringify(cles));

    const apres = await driver.executeScript(MAG +
      "var pref = mag('preference');" +
      "try { pref.toggleZoomInterfaceEnabled(); } catch (e) { return { erreur: String(e).slice(0, 90) }; }" +
      "return etat();");
    console.log("  après bascule : " + JSON.stringify(apres));
    await dors(2500);
    const stable = await driver.executeScript(MAG + "return etat();");
    console.log("  2,5 s après   : " + JSON.stringify(stable));

    /* Et si on l'écrivait à la main plutôt que par sa bascule ? */
    const direct = await driver.executeScript(MAG +
      "var pref = mag('preference');" +
      "try { pref.$patch({ zoom: Object.assign({}, pref.zoom, { interfaceEnabled: false }) }); }" +
      "catch (e) { return { erreur: String(e).slice(0, 90) }; }" +
      "return etat();");
    console.log("  après $patch  : " + JSON.stringify(direct));
    await dors(2000);
    console.log("  2 s après     : " + JSON.stringify(await driver.executeScript(MAG + "return etat();")));

    releve("bascule-controle-" + quelle + ".json", { avant, cles, apres, stable, direct });
    return 0;
  } finally {
    await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var pref = mag('preference');" +
      "try { if (pref && pref.zoom && !pref.zoom.interfaceEnabled) { pref.toggleZoomInterfaceEnabled(); } } catch (e) {}")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- OÙ VIT LA SÉLECTION DE ROLL20 ----------
 *
 * Le mode « on sélectionne les tokens, puis on clique un marqueur » demande de
 * LIRE sa sélection. Un relevé ancien dit que `d20.engine.tabletopSelected`
 * reste vide sous un clic du pilote — mais il concluait sur la CAPACITÉ À
 * SÉLECTIONNER par script, pas sur la lecture. Un vrai joueur, lui, sélectionne
 * à la souris, et l'événement est alors de confiance.
 *
 * On cherche donc trois choses, dans cet ordre :
 *   1. où la sélection est rangée, et sous quelle forme ;
 *   2. s'il existe une fonction pour la poser — ce qui rendrait la sonde
 *      capable de l'éprouver sans main humaine ;
 *   3. si un clic PILOTÉ (actions WebDriver, donc de confiance) y arrive, là où
 *      un événement fabriqué dans la page échouait.
 */
async function ouEstLaSelection() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("joueur")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 40))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const MAG =
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }";

    /* ---- 1. LES MAGASINS, ET CE QUI PARLE DE SÉLECTION ---- */
    const magasins = await driver.executeScript(
      "var out = { noms: [], selection: {} };" +
      "var n = document.querySelectorAll('[data-v-app]');" +
      "for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "  var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "  if (p && p._s) { p._s.forEach(function (st, nom) {" +
      "    if (out.noms.indexOf(nom) < 0) { out.noms.push(nom); }" +
      "    for (var k in st) { try {" +
      "      if (!/select/i.test(k)) { continue; }" +
      "      var v = st[k];" +
      "      out.selection[nom + '.' + k] = (typeof v === 'function') ? 'fonction'" +
      "        : (v && v.length !== undefined ? 'liste(' + v.length + ')' : JSON.stringify(v).slice(0, 60));" +
      "    } catch (e) {} } }); } }" +
      "return out;");
    console.log("\n  magasins Pinia :" + magasins.noms.join(", "));
    console.log("\n  ce qui parle de sélection :");
    Object.keys(magasins.selection).forEach((k) =>
      console.log("    " + k.padEnd(38) + " " + magasins.selection[k]));

    /* ---- 2. LE d20, où qu'il soit ---- */
    const d20 = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "if (!d) { return { erreur: 'pas de d20' }; }" +
      "var e = d.engine || {};" +
      "var out = { moteur: [], selection: null, fonctions: [] };" +
      "for (var k in e) { try {" +
      "  if (/select/i.test(k)) { out.moteur.push(k + ' : ' + (typeof e[k])); }" +
      "} catch (x) {} }" +
      /* C EST UNE FONCTION, ET C EST TOUT LE MALENTENDU : un relevé ancien la
       * lisait comme un tableau, la trouvait vide, et concluait que la sélection
       * de Roll20 était inatteignable. Elle ne l’était pas ; on l’appelait mal. */
      "try { var s = (typeof e.tabletopSelected === \"function\") ? e.tabletopSelected() : e.tabletopSelected;" +
      "  out.selection = { type: typeof s, longueur: s && s.length," +
      "    extrait: s ? JSON.stringify(s).slice(0, 200) : null }; } catch (x) { out.selection = String(x).slice(0, 90); }" +
      "for (var f in e) { try { if (typeof e[f] === 'function' && /select|pick|highlight/i.test(f))" +
      "  { out.fonctions.push(f); } } catch (x) {} }" +
      "return out;");
    console.log("\n  d20.engine :" + JSON.stringify(d20, null, 1));

    /* ---- 3. UN CLIC PILOTÉ, DE CONFIANCE ---- */
    const cible = await driver.executeScript(
      "var C = window.Campaign, S = window.MeshScene, e = S.getEngine();" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var cv = e.getRenderingCanvas(), r = cv.getBoundingClientRect();" +
      "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
      "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
      "var p = V.Project(new V(t.attributes.left, -t.attributes.top, 9999000), M.Identity()," +
      "  S.getTransformMatrix(), vp);" +
      "return { nom: t.attributes.name, id: t.id," +
      "  x: Math.round(p.x * r.width / e.getRenderWidth() + r.left)," +
      "  y: Math.round(p.y * r.height / e.getRenderHeight() + r.top) };");
    if (!cible) { console.log("  aucun token."); return 1; }
    console.log("\n  clic piloté sur «" + cible.nom + " » en (" + cible.x + ", " + cible.y + ")");

    const toile = await driver.findElement({ id: "babylonCanvas" });
    const boite = await toile.getRect();
    await driver.actions({ bridge: true })
      .move({ x: Math.round(cible.x - boite.x - boite.width / 2),
              y: Math.round(cible.y - boite.y - boite.height / 2), origin: toile })
      .click()
      .perform();
    await dors(2000);

    const apres = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "var e = d && d.engine ? d.engine : {};" +
      "var s = (typeof e.tabletopSelected === \"function\") ? e.tabletopSelected() : e.tabletopSelected;" +
      "if (!s) { return { longueur: null }; }" +
      "var liste = [].slice.call(s.length !== undefined ? s : []);" +
      "return { longueur: liste.length," +
      "  formes: liste.map(function (o) {" +
      "    var m = o && (o.model || o);" +
      "    return { id: m && m.id, nom: m && m.attributes && m.attributes.name," +
      "      clefs: Object.keys(o || {}).slice(0, 6) }; }) };");
    console.log("  après le clic piloté : " + JSON.stringify(apres));
    console.log("  → un clic de confiance sélectionne-t-il ? " +
      (apres.longueur ? "OUI" : "NON"));


    /* ---- 4. D'OÙ VIENT-ELLE ? On lit la source de sa fonction, et le magasin
       qui porte l'état du plateau. C'est la seule façon de savoir quelle donnée
       fait foi — et donc laquelle écouter. ---- */
    const source = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "var e = d && d.engine ? d.engine : {};" +
      "var out = {};" +
      "try { out.code = String(e.tabletopSelected).slice(0, 700); } catch (x) {}" +
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var pp = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (pp && pp._s && pp._s.get(nom)) { return pp._s.get(nom); } } return null; }" +
      "var st = mag('vttTools_tabletopState');" +
      "if (st) { out.tabletopState = {}; for (var k in st) { try {" +
      "  var v = st[k];" +
      "  out.tabletopState[k] = (typeof v === 'function') ? 'fonction'" +
      "    : (v && v.length !== undefined && typeof v !== 'string' ? 'liste(' + v.length + ')'" +
      "    : JSON.stringify(v).slice(0, 70));" +
      "} catch (x) {} } }" +
      "var to = mag('vttTools');" +
      "if (to) { out.vttTools = {}; for (var k2 in to) { try {" +
      "  var v2 = to[k2];" +
      "  out.vttTools[k2] = (typeof v2 === 'function') ? 'fonction'" +
      "    : (v2 && v2.length !== undefined && typeof v2 !== 'string' ? 'liste(' + v2.length + ')'" +
      "    : JSON.stringify(v2).slice(0, 70));" +
      "} catch (x) {} } }" +
      "return out;");
    console.log("\n  source de tabletopSelected :\n" + (source.code || "(illisible)"));

    /* ---- 5. LE PLATEAU LUI-MÊME : que sait-il faire d'une sélection ? ----
     *
     * `tabletopSelected()` délègue à `VTTEngine.instance.tabletop.getSelection()`.
     * On n'atteint pas la classe, mais on atteint l'objet : il suffit de partir
     * de la fonction pour retrouver le `this` qu'elle appelle. Ce qu'on cherche :
     * une méthode pour POSER une sélection, faute de quoi la sonde ne pourra
     * jamais éprouver ce mode sans une main humaine. */
    const plateau = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "var e = d && d.engine ? d.engine : {};" +
      "var sel = null;" +
      "try { sel = e.tabletopSelected(); } catch (x) { return { erreur: String(x).slice(0, 90) }; }" +
      /* On remonte au plateau par un objet sélectionné s'il y en a un ; sinon on
       * fouille les propriétés du moteur à la recherche de celui qui porte
       * getSelection. */
      "var tt = null;" +
      "for (var k in e) { try { var v = e[k];" +
      "  if (v && typeof v === 'object' && typeof v.getSelection === 'function') { tt = v; break; }" +
      "} catch (x) {} }" +
      "if (!tt) { for (var k2 in e) { try { var v2 = e[k2];" +
      "  if (v2 && typeof v2 === 'object' && v2.tabletop && typeof v2.tabletop.getSelection === 'function')" +
      "    { tt = v2.tabletop; break; } } catch (x) {} } }" +
      "if (!tt) { return { trouve: false, selection: sel && sel.length }; }" +
      "var meth = [], props = [];" +
      "var o = tt; var vus = {};" +
      "while (o && o !== Object.prototype) {" +
      "  Object.getOwnPropertyNames(o).forEach(function (n) {" +
      "    if (vus[n]) { return; } vus[n] = 1;" +
      "    try { if (typeof tt[n] === 'function') { if (/select|pick|highlight|clear/i.test(n)) { meth.push(n); } }" +
      "      else if (/select/i.test(n)) { props.push(n); } } catch (x) {} });" +
      "  o = Object.getPrototypeOf(o); }" +
      "return { trouve: true, selection: sel && sel.length, methodes: meth, proprietes: props };");
    console.log("\n  le plateau : " + JSON.stringify(plateau, null, 1));

    /* ---- 6. LA FORME D'UNE ENTRÉE SÉLECTIONNÉE ----
     *
     * C'est elle qui décide du code : il faut pouvoir remonter de ce que Roll20
     * met dans sa sélection jusqu'au modèle Backbone du token, celui qui porte
     * `statusmarkers`. Sans ce chaînon, le second mode de pose ne peut rien. */
    const forme = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "var sel = d.engine.tabletopSelected();" +
      "if (!sel || !sel.length) { return { vide: true }; }" +
      "var o = sel[0];" +
      "var chemins = {};" +
      "['id', 'model', 'graphic', 'token', 'obj', 'backbone'].forEach(function (c) {" +
      "  try { var v = o[c]; chemins[c] = v === undefined ? undefined" +
      "    : (typeof v === 'object' && v ? ('objet, id=' + v.id) : String(v).slice(0, 40)); } catch (e) {} });" +
      "var clefs = []; var p = o, vus = {};" +
      "while (p && p !== Object.prototype && clefs.length < 40) {" +
      "  Object.getOwnPropertyNames(p).forEach(function (n) {" +
      "    if (!vus[n]) { vus[n] = 1; clefs.push(n + ':' + (typeof o[n])); } });" +
      "  p = Object.getPrototypeOf(p); }" +
      /* Et la question qui tranche : cet objet mène-t-il à un modèle qui a
       * `attributes.statusmarkers` ? */
      "var C = window.Campaign, col = C.activePage().thegraphics;" +
      "var parId = o && o.id ? col.get(o.id) : null;" +
      "var parModel = o && o.model ? o.model : null;" +
      "return { clefs: clefs.slice(0, 30)," +
      "  chemins: chemins," +
      "  parId: parId ? { nom: parId.attributes.name, marqueurs: parId.attributes.statusmarkers } : null," +
      "  parModel: parModel ? { nom: parModel.attributes && parModel.attributes.name } : null };");
    console.log("\n  forme d'une entrée : " + JSON.stringify(forme, null, 1));
    console.log("\n  magasin vttTools_tabletopState :");
    Object.keys(source.tabletopState || {}).forEach((k) =>
      console.log("    " + k.padEnd(30) + " " + source.tabletopState[k]));
    console.log("\n  magasin vttTools :");
    Object.keys(source.vttTools || {}).forEach((k) =>
      console.log("    " + k.padEnd(30) + " " + source.vttTools[k]));

    releve("ou-est-la-selection.json", { magasins, d20, cible, apres, source });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES DEUX MANIÈRES DE POSER, SUR UNE VRAIE PARTIE ----------
 *
 * Le banc éprouve la règle sur une fausse sélection ; ici on éprouve qu'on lit
 * la VRAIE — celle de Roll20, faite d'un clic, avec ses poignées. C'est le seul
 * point que le banc ne peut pas tenir, puisqu'il fabrique lui-même ce qu'il lit.
 *
 * Un clic piloté est de CONFIANCE — WebDriver le produit au niveau du système,
 * pas dans la page — et Roll20 le traite comme un vrai. C'est ce qui permet de
 * sélectionner sans main humaine, là où un événement fabriqué échouait. */
async function deuxModes() {
  const driver = await ouvre(config().visible === true);
  let repose = [];
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("joueur")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 40))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const A = "vttk_essaia_cdn.discordapp.com/embed/avatars/0.png";
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true," +
      "  mode: 'tokens'," +
      "  catalogue: [{ tag: arguments[0], nom: 'Essai A'," +
      "    url: 'https://cdn.discordapp.com/embed/avatars/0.png' }] }, '*');", A);
    await dors(1800);

    /* On repère deux tokens et on note leur état, pour le rendre à la fin. */
    const cibles = await driver.executeScript(
      "var C = window.Campaign, S = window.MeshScene, e = S.getEngine();" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var cv = e.getRenderingCanvas(), r = cv.getBoundingClientRect();" +
      "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
      "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
      "return C.activePage().thegraphics.models" +
      "  .filter(function (m) { return m.attributes.layer === 'objects'; })" +
      "  .slice(0, 2).map(function (t) {" +
      "    var p = V.Project(new V(t.attributes.left, -t.attributes.top, 9999000), M.Identity()," +
      "      S.getTransformMatrix(), vp);" +
      "    return { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers || ''," +
      "      x: Math.round(p.x * r.width / e.getRenderWidth() + r.left)," +
      "      y: Math.round(p.y * r.height / e.getRenderHeight() + r.top) }; });");
    repose = cibles;
    console.log("\n  tokens : " + cibles.map((t) => t.nom + " (" + t.x + "," + t.y + ")").join("  "));
    if (cibles.length < 2) { console.log("  il en faut deux."); return 1; }

    await driver.executeScript(
      "var C = window.Campaign;" +
      "[].forEach.call(arguments[0], function (id) {" +
      "  var t = C.activePage().thegraphics.get(id); if (t) { t.save({ statusmarkers: '' }); } });",
      cibles.map((t) => t.id));
    await dors(1200);

    /* ---- ON SÉLECTIONNE À LA SOURIS, comme un joueur ---- */
    const toile = await driver.findElement({ id: "babylonCanvas" });
    const boite = await toile.getRect();
    const versToile = (t) => ({
      x: Math.round(t.x - boite.x - boite.width / 2),
      y: Math.round(t.y - boite.y - boite.height / 2)
    });
    await driver.actions({ bridge: true }).move(Object.assign({ origin: toile }, versToile(cibles[0]))).click().perform();
    await dors(1200);
    /* Le second en gardant Maj : c'est le geste d'une sélection multiple. */
    const MAJ = "";
    await driver.actions({ bridge: true })
      .keyDown(MAJ)
      .move(Object.assign({ origin: toile }, versToile(cibles[1]))).click()
      .keyUp(MAJ)
      .perform();
    await dors(1800);

    const lue = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "var s = d.engine.tabletopSelected();" +
      "return { n: s ? s.length : null," +
      "  noms: s ? [].slice.call(s).map(function (o) {" +
      "    var m = o.model || o; return m.attributes ? m.attributes.name : m.id; }) : null };");
    console.log("  sélection lue par le pont : " + JSON.stringify(lue));

    /* ---- UN CLIC SUR LE MARQUEUR ---- */
    const pose = await driver.executeScript(
      "var b = document.querySelector('.vttk-outil-marqueurs button'); if (b) { b.click(); }" +
      "var q = document.querySelector('.vttk-barre-marqueur[data-tag=\"' + arguments[0] + '\"]');" +
      "if (!q) { return { erreur: 'tuile introuvable' }; }" +
      "q.click();" +
      "var mot = document.querySelector('.vttk-barre-mot');" +
      "return { mot: mot && !mot.hidden ? mot.textContent : null };", A);
    console.log("  la palette dit : " + JSON.stringify(pose.mot));
    await dors(2500);

    const apres = await driver.executeScript(
      "var C = window.Campaign;" +
      "return [].map.call(arguments[0], function (id) {" +
      "  var t = C.activePage().thegraphics.get(id);" +
      "  return { nom: t.attributes.name, champ: t.attributes.statusmarkers }; });",
      cibles.map((t) => t.id));
    console.log("  après le clic :");
    apres.forEach((t) => console.log("    « " + t.nom + " » → « " + t.champ + " »"));

    const tousMarques = apres.every((t) => String(t.champ).indexOf(A) >= 0);
    console.log("\n  → les deux tokens sélectionnés sont marqués d'un seul clic : " +
      (tousMarques ? "OUI" : "NON"));

    /* ---- ET LE MÊME CLIC LES DÉMARQUE ---- */
    await driver.executeScript(
      "var q = document.querySelector('.vttk-barre-marqueur[data-tag=\"' + arguments[0] + '\"]');" +
      "if (q) { q.click(); }", A);
    await dors(2500);
    const apres2 = await driver.executeScript(
      "var C = window.Campaign;" +
      "return [].map.call(arguments[0], function (id) {" +
      "  return C.activePage().thegraphics.get(id).attributes.statusmarkers; });",
      cibles.map((t) => t.id));
    console.log("  au clic suivant : " + JSON.stringify(apres2));
    const tousNets = apres2.every((c) => String(c).indexOf(A) < 0);
    console.log("  → et le même clic les démarque : " + (tousNets ? "OUI" : "NON"));

    /* ---- LE CAS MIXTE : un token l'a, l'autre non ----
     *
     * C'est celui qui distingue les deux règles. L'ancienne jugeait chaque token
     * séparément — le premier perdait le marqueur pendant que le second le
     * gagnait, et les deux se croisaient sans jamais se rejoindre. La nouvelle
     * décide une fois pour tous : tous ne l'ont pas, donc on ajoute. */
    await driver.executeScript(
      "var C = window.Campaign;" +
      "C.activePage().thegraphics.get(arguments[0]).save({ statusmarkers: arguments[2] });" +
      "C.activePage().thegraphics.get(arguments[1]).save({ statusmarkers: '' });",
      cibles[0].id, cibles[1].id, A);
    await dors(1800);
    await driver.executeScript(
      "var q = document.querySelector('.vttk-barre-marqueur[data-tag=\"' + arguments[0] + '\"]');" +
      "if (q) { q.click(); }", A);
    await dors(2500);
    const mixte = await driver.executeScript(
      "var C = window.Campaign;" +
      "var mot = document.querySelector('.vttk-barre-mot');" +
      "return { champs: [].map.call(arguments[0], function (id) {" +
      "  return C.activePage().thegraphics.get(id).attributes.statusmarkers; })," +
      "  mot: mot && !mot.hidden ? mot.textContent : null };",
      cibles.map((t) => t.id));
    console.log("\n  cas mixte (un l'a, l'autre non) : " + JSON.stringify(mixte.champs));
    console.log("     la palette dit : " + JSON.stringify(mixte.mot));
    const gardeEtAjoute = mixte.champs.every((c) => String(c).indexOf(A) >= 0);
    console.log("  → celui qui l'avait le GARDE, l'autre le gagne : " + (gardeEtAjoute ? "OUI" : "NON"));

    /* ---- LA FENÊTRE NE SE REFERME PLUS TOUTE SEULE ---- */
    const ferm = await driver.executeScript(
      "var b = document.querySelector('.vttk-barre');" +
      "var ouverte = function () { return b.className.indexOf('ouvert') >= 0; };" +
      "var out = { avant: ouverte() };" +
      /* Un clic franc ailleurs dans la page : le tchat fait très bien l'affaire. */
      "var ailleurs = document.querySelector('#textchat-input textarea') || document.body;" +
      "ailleurs.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 800, clientY: 600 }));" +
      "window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 800, clientY: 600 }));" +
      "out.apresClicAilleurs = ouverte();" +
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));" +
      "out.apresEchap = ouverte();" +
      "var x = b.querySelector('.vttk-barre-ferme');" +
      "out.croix = !!x;" +
      "if (x) { x.click(); }" +
      "out.apresCroix = ouverte();" +
      "var bo = document.querySelector('.vttk-outil-marqueurs button');" +
      "if (bo) { bo.click(); }" +
      "out.apresBouton = ouverte();" +
      "if (bo) { bo.click(); }" +
      "out.apresReBouton = ouverte();" +
      "return out;");
    console.log("\n  fermeture : " + JSON.stringify(ferm));
    const bonneFermeture = ferm.avant && ferm.apresClicAilleurs && ferm.apresEchap &&
                           ferm.croix && !ferm.apresCroix && ferm.apresBouton && !ferm.apresReBouton;
    console.log("  → ni le clic ailleurs ni Échap ne ferment ; la croix et le bouton, oui : " +
      (bonneFermeture ? "OUI" : "NON"));

    releve("deux-modes.json", { cibles, lue, pose, apres, apres2, mixte, ferm });
    return (tousMarques && tousNets && gardeEtAjoute && bonneFermeture) ? 0 : 1;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "[].forEach.call(arguments[0], function (t) {" +
      "  var m = C.activePage().thegraphics.get(t.id);" +
      "  if (m) { m.save({ statusmarkers: t.avant }); } });", repose).catch(() => {});
    await dors(1500);
    await driver.quit().catch(() => {});
  }
}

/* ---------- L'ÉCART QUE ROLL20 MET ENTRE SA COLONNE ET SES FENÊTRES ----------
 *
 * Notre palette est collée au bord droit de sa boîte à outils. Ses propres
 * panneaux, eux, laissent un jour — et l'auteur veut le même. On ne le choisit
 * donc pas : on presse ses boutons un par un, on regarde ce qui s'ouvre à droite
 * de la colonne, et on mesure la distance. Ce qui revient le plus souvent est
 * son écart. */
async function ecartDesFenetres() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(9000);

    const r = await driver.executeScript(
      "var bar = document.querySelector('#master-toolbar');" +
      "if (!bar) { return { erreur: 'pas de colonne' }; }" +
      "var rb = bar.getBoundingClientRect();" +
      "var boutons = [].slice.call(bar.querySelectorAll('.toolbar-button-outer button'))" +
      "  .filter(function (b) { return b.getBoundingClientRect().height > 4; });" +
      "var out = { colonne: { droite: Math.round(rb.right), haut: Math.round(rb.top)," +
      "  bas: Math.round(rb.bottom), largeur: Math.round(rb.width) }, ouvertures: [] };" +
      /* Ce qui est visible AVANT, pour ne retenir que ce qui apparaît. */
      "function visibles() {" +
      "  var v = [];" +
      "  [].slice.call(document.body.querySelectorAll('div, aside, section')).forEach(function (n) {" +
      "    var q = n.getBoundingClientRect();" +
      "    if (q.width > 140 && q.height > 100 && q.left >= rb.right - 4 && q.left < rb.right + 90" +
      "        && n.offsetParent !== null) {" +
      "      v.push({ n: n, gauche: Math.round(q.left), haut: Math.round(q.top)," +
      "        largeur: Math.round(q.width), hauteur: Math.round(q.height)," +
      "        classe: String(n.className).slice(0, 40), id: n.id }); } });" +
      "  return v; }" +
      "var avant = visibles().map(function (o) { return o.n; });" +
      "for (var i = 0; i < boutons.length; i++) {" +
      "  try { boutons[i].click(); } catch (e) { continue; }" +
      "  var apres = visibles();" +
      "  for (var k = 0; k < apres.length; k++) {" +
      "    if (avant.indexOf(apres[k].n) >= 0) { continue; }" +
      "    out.ouvertures.push({ bouton: i," +
      "      libelle: (boutons[i].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20)," +
      "      gauche: apres[k].gauche, haut: apres[k].haut," +
      "      largeur: apres[k].largeur, hauteur: apres[k].hauteur," +
      "      classe: apres[k].classe, id: apres[k].id," +
      "      ecart: apres[k].gauche - Math.round(rb.right)," +
      "      ecartHaut: apres[k].haut - Math.round(rb.top) }); }" +
      "  try { boutons[i].click(); } catch (e) {} }" +
      "return out;");

    if (r.erreur) { console.log("  " + r.erreur); return 1; }
    console.log("\n  colonne : " + JSON.stringify(r.colonne));
    console.log("\n  ce qui s'ouvre à sa droite (" + r.ouvertures.length + ") :");
    r.ouvertures.forEach((o) => console.log("    écart " + String(o.ecart).padStart(4) +
      " px | haut " + String(o.ecartHaut).padStart(5) +
      " | " + String(o.largeur).padStart(4) + "×" + String(o.hauteur).padStart(4) +
      "  « " + o.libelle + " »  " + o.classe + (o.id ? " #" + o.id : "")));

    /* ---- CE QUE ROLL20 ANCRE PRÈS DE SA COLONNE, quoi qu'il soit ----
     *
     * Ses boutons changent d'outil, ils n'ouvrent pas de panneau : la première
     * passe n'a donc rien attrapé d'autre que notre propre grille. On regarde
     * alors TOUT ce qui est positionné dans la bande à droite de la colonne, sans
     * condition de taille — c'est sa convention qu'on cherche, pas un panneau
     * particulier. */
    const bande = await driver.executeScript(
      "var bar = document.querySelector('#master-toolbar');" +
      "var rb = bar.getBoundingClientRect();" +
      "var out = [];" +
      "[].slice.call(document.querySelectorAll('body *')).forEach(function (n) {" +
      "  if (/^vttk-/.test(String(n.className))) { return; }" +
      "  var s = getComputedStyle(n);" +
      "  if (s.position !== 'absolute' && s.position !== 'fixed') { return; }" +
      "  var q = n.getBoundingClientRect();" +
      "  if (q.width < 40 || q.height < 24) { return; }" +
      "  if (q.left < rb.right - 2 || q.left > rb.right + 140) { return; }" +
      "  out.push({ gauche: Math.round(q.left), haut: Math.round(q.top)," +
      "    l: Math.round(q.width), h: Math.round(q.height)," +
      "    ecart: Math.round(q.left - rb.right)," +
      "    position: s.position," +
      "    marge: s.marginLeft + '/' + s.left," +
      "    balise: n.tagName.toLowerCase()," +
      "    id: n.id, classe: String(n.className).slice(0, 46) }); });" +
      "var vus = {};" +
      "return out.filter(function (o) { var c = o.ecart + '|' + o.classe;" +
      "  if (vus[c]) { return false; } vus[c] = 1; return true; });");
    console.log("\n  ce que Roll20 ancre dans la bande à droite de sa colonne :");
    bande.forEach((o) => console.log("    écart " + String(o.ecart).padStart(4) +
      " px | " + String(o.l).padStart(4) + "×" + String(o.h).padStart(4) +
      " | " + o.position + " left=" + o.marge +
      " | " + o.balise + (o.id ? "#" + o.id : "") + " ." + o.classe));

    /* ---- ET LE JOUR EN HAUT ? ----
     *
     * On a recopié son écart HORIZONTAL et laissé nos panneaux collés au plafond.
     * Le sien ne l'est pas non plus : on lit donc les deux bords du même témoin,
     * `.block-submenu`, et on prend ses deux valeurs plutôt qu'une seule. */
    const haut = await driver.executeScript(
      "var bar = document.querySelector('#master-toolbar');" +
      "var rb = bar.getBoundingClientRect();" +
      "var out = { colonne: { haut: Math.round(rb.top), droite: Math.round(rb.right)," +
      "  bas: Math.round(rb.bottom) }, temoins: [] };" +
      "['.block-submenu', '.submenu', '[class*=submenu]', '[class*=flyout]', '[class*=panel]']" +
      "  .forEach(function (sel) {" +
      "    [].slice.call(document.querySelectorAll(sel)).forEach(function (n) {" +
      "      var s = getComputedStyle(n), q = n.getBoundingClientRect();" +
      "      if (q.width < 80 || q.height < 60) { return; }" +
      "      if (/^vttk-/.test(String(n.className))) { return; }" +
      "      out.temoins.push({ selecteur: sel, classe: String(n.className).slice(0, 40)," +
      "        position: s.position, gauche: s.left, hautStyle: s.top," +
      "        bas: s.bottom, hauteur: s.height," +
      "        boite: [Math.round(q.left), Math.round(q.top)," +
      "                Math.round(q.width), Math.round(q.height)]," +
      "        ecartGauche: Math.round(q.left - rb.right)," +
      "        ecartHaut: Math.round(q.top - rb.top) }); }); });" +
      "var vus = {};" +
      "out.temoins = out.temoins.filter(function (t) {" +
      "  var c = t.classe + t.gauche + t.hautStyle;" +
      "  if (vus[c]) { return false; } vus[c] = 1; return true; });" +
      "return out;");
    console.log("\n  colonne : haut=" + haut.colonne.haut + " droite=" + haut.colonne.droite +
                " bas=" + haut.colonne.bas);
    console.log("  ses panneaux, bord par bord :");
    haut.temoins.forEach((t) => console.log(
      "    ." + t.classe.padEnd(30) + " " + t.position +
      "  left=" + String(t.gauche).padStart(7) + " top=" + String(t.hautStyle).padStart(7) +
      "  bottom=" + String(t.bas).padStart(7) +
      "  | écart gauche " + String(t.ecartGauche).padStart(4) +
      ", écart haut " + String(t.ecartHaut).padStart(4)));

    const ecarts = {};
    r.ouvertures.forEach((o) => { ecarts[o.ecart] = (ecarts[o.ecart] || 0) + 1; });
    const tri = Object.keys(ecarts).sort((a, b) => ecarts[b] - ecarts[a]);
    console.log("\n  écarts observés : " + tri.map((e) => e + " px ×" + ecarts[e]).join(", "));
    console.log("  → celui qui revient le plus : " + (tri[0] !== undefined ? tri[0] + " px" : "aucun"));
    releve("ecart-fenetres.json", r);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES DEUX PASTILLES, CÔTE À CÔTE ----------
 *
 * Elles ne se jugent qu'ENSEMBLE, et c'est précisément ce que l'ancienne
 * structure interdisait : une seule pastille portait le nombre frappé quand il
 * y en avait un, et sinon le rang du clic. On choisit donc deux marqueurs, dont
 * le second numéroté, et on photographie la grille de près. */
async function deuxPastilles() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 40))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(8000);

    const PALETTE = [0, 1, 2].map((i) => ({
      tag: "vttk_essai" + i + "_cdn.discordapp.com/embed/avatars/" + i + ".png",
      nom: "Essai " + i,
      url: "https://cdn.discordapp.com/embed/avatars/" + i + ".png"
    }));
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs'," +
      "  actif: true, mode: 'marqueur', catalogue: arguments[0] }, '*');", PALETTE);
    await dors(1500);

    const etat = await driver.executeScript(
      "var b = document.querySelector('.vttk-outil-marqueurs button'); if (b) { b.click(); }" +
      "var barre = document.querySelector('.vttk-barre');" +
      "var t = barre.querySelectorAll('.vttk-barre-marqueur');" +
      /* Premier choisi : rang 1, aucun nombre. */
      "t[0].click();" +
      /* Second : on le survole, on frappe « 12 », puis on le choisit. */
      "t[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));" +
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));" +
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));" +
      "var lis = function (b) {" +
      "  var n = b.parentNode.querySelector('.vttk-marqueur-nombre');" +
      "  var r = b.parentNode.querySelector('.vttk-marqueur-rang');" +
      "  var qn = n.getBoundingClientRect(), qr = r.getBoundingClientRect();" +
      "  return { nombre: n.hidden ? null : n.textContent, rang: r.hidden ? null : r.textContent," +
      "    nombreX: Math.round(qn.left), rangX: Math.round(qr.left) }; };" +
      "var g = barre.querySelector('.vttk-marqueur-grille').getBoundingClientRect();" +
      "return { premier: lis(t[0]), second: lis(t[1])," +
      "  grille: { x: Math.round(g.left), y: Math.round(g.top)," +
      "    l: Math.round(g.width), h: Math.round(g.height) } };");

    console.log("\n  premier choisi : " + JSON.stringify(etat.premier));
    console.log("  second choisi  : " + JSON.stringify(etat.second));
    const bonCote = etat.second.nombreX < etat.second.rangX;
    console.log("\n  → le NOMBRE est à gauche du RANG : " + (bonCote ? "OUI" : "NON"));
    console.log("  → les deux paraissent ensemble : " +
      (etat.second.nombre && etat.second.rang ? "OUI" : "NON"));

    await capturePres(driver, "pastilles.png",
      etat.grille.x - 10, etat.grille.y - 14, etat.grille.l + 20, etat.grille.h + 24, 7);
    releve("deux-pastilles.json", etat);
    return (bonCote && etat.second.nombre && etat.second.rang) ? 0 : 1;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA ZONE DE CHAT, ET LES JOUEURS DE LA TABLE ----------
 *
 * Deux choses à trouver avant d'écrire une ligne :
 *
 *   1. LA STRUCTURE de son pied de chat — l'intitulé « En tant que : », le
 *      sélecteur qui l'accompagne, le champ de saisie et le bouton d'envoi.
 *      C'est là qu'on doit se greffer, et cloner ce qui s'y trouve plutôt que de
 *      dessiner à côté.
 *   2. OÙ VIVENT LES JOUEURS de la table. L'auteur en cite deux — « Alandush »,
 *      « Erua » —, ce qui donne de quoi vérifier qu'on a trouvé la bonne source
 *      et pas une liste qui leur ressemble.
 *
 * On fouille donc plusieurs pistes à la fois : la collection Backbone de la
 * campagne, les magasins Pinia, et le DOM du chat lui-même. */
async function zoneDeChat() {
  const quelle = (process.argv[3] || "mj").toLowerCase();
  const id = quelle === "joueur" ? partieDEssai("joueur") : partieDEssai("mj");
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(10000);

    /* ---- 1. LE PIED DU CHAT ---- */
    const chat = await driver.executeScript(
      "function decris(n, prof) {" +
      "  if (!n || prof > 4) { return null; }" +
      "  var q = n.getBoundingClientRect();" +
      "  var d = { balise: n.tagName.toLowerCase()," +
      "    id: n.id || null, classe: String(n.className || '').slice(0, 50)," +
      "    boite: [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)]," +
      "    texte: (n.children.length ? '' : (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40))," +
      "    enfants: [] };" +
      "  for (var i = 0; i < n.children.length && i < 8; i++) {" +
      "    d.enfants.push(decris(n.children[i], prof + 1)); }" +
      "  return d; }" +
      /* On part de l'intitulé, où qu'il soit : c'est le repère que l'auteur cite. */
      "var cible = null;" +
      "[].slice.call(document.querySelectorAll('body *')).forEach(function (n) {" +
      "  if (cible || n.children.length) { return; }" +
      "  var t = (n.textContent || '').replace(/\\s+/g, ' ').trim();" +
      "  if (/^En tant que\\s*:?$/i.test(t) || /^Speaking as\\s*:?$/i.test(t)) { cible = n; } });" +
      "if (!cible) { return { trouve: false }; }" +
      "var pere = cible.parentNode, k = 0;" +
      "while (pere && k < 3 && !pere.querySelector('select')) { pere = pere.parentNode; k++; }" +
      "var sel = pere ? pere.querySelector('select') : null;" +
      "return { trouve: true," +
      "  intitule: { balise: cible.tagName.toLowerCase(), classe: String(cible.className).slice(0, 50)," +
      "    texte: (cible.textContent || '').trim() }," +
      "  bloc: decris(pere, 0)," +
      "  selecteur: sel ? { id: sel.id, classe: String(sel.className).slice(0, 40)," +
      "    options: [].slice.call(sel.options).slice(0, 8).map(function (o) {" +
      "      return { valeur: String(o.value).slice(0, 50), mot: o.textContent.trim().slice(0, 40) }; })," +
      "    n: sel.options.length } : null," +
      "  saisie: (function () { var z = document.querySelector('#textchat-input textarea');" +
      "    return z ? { balise: 'textarea', classe: String(z.className).slice(0, 40) } : null; })()," +
      "  bouton: (function () { var b = document.querySelector('#textchat-input .btn, #textchat-input button');" +
      "    return b ? { mot: (b.textContent || '').trim().slice(0, 20), classe: String(b.className).slice(0, 40) } : null; })() };");

    console.log("\n════ PIED DU CHAT ════");
    if (!chat.trouve) { console.log("  intitulé « En tant que » introuvable."); }
    else {
      console.log("  intitulé  : " + JSON.stringify(chat.intitule));
      console.log("  sélecteur : " + JSON.stringify(chat.selecteur, null, 1));
      console.log("  saisie    : " + JSON.stringify(chat.saisie));
      console.log("  bouton    : " + JSON.stringify(chat.bouton));
      const montre = (n, dec) => {
        if (!n) { return; }
        console.log(dec + n.balise + (n.id ? "#" + n.id : "") +
          (n.classe ? "." + n.classe : "") + "  " + JSON.stringify(n.boite) +
          (n.texte ? "  « " + n.texte + " »" : ""));
        (n.enfants || []).forEach((e) => montre(e, dec + "  "));
      };
      console.log("\n  structure du bloc :");
      montre(chat.bloc, "    ");
    }

    /* ---- 2. LES JOUEURS ---- */
    const joueurs = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var out = {};" +
      /* a. la collection Backbone de la campagne */
      "try { var C = window.Campaign;" +
      "  if (C && C.players && C.players.models) {" +
      "    out.backbone = C.players.models.map(function (m) {" +
      "      var a = m.attributes || {};" +
      "      return { id: m.id, nom: a.displayname, en_ligne: a.online," +
      "        couleur: a.color, mj: a.d20userid !== undefined ? undefined : undefined }; }); }" +
      "} catch (e) { out.backboneErreur = String(e).slice(0, 80); }" +
      /* b. le magasin Pinia « player » */
      "try { var st = mag('player');" +
      "  if (st) { out.pinia = {}; for (var k in st) { try { var v = st[k];" +
      "    out.pinia[k] = (typeof v === 'function') ? 'fonction'" +
      "      : (v && v.length !== undefined && typeof v !== 'string' ? 'liste(' + v.length + ')'" +
      "      : JSON.stringify(v).slice(0, 80)); } catch (x) {} } }" +
      "} catch (e) { out.piniaErreur = String(e).slice(0, 80); }" +
      /* c. ce que le d20 en dit */
      "try { var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "  if (d && d.Campaign && d.Campaign.players) {" +
      "    out.d20 = d.Campaign.players.length; } } catch (e) {}" +
      /* d. le nom qui figure dans le sélecteur « En tant que » */
      "out.moi = window.currentPlayer && window.currentPlayer.attributes" +
      "  ? window.currentPlayer.attributes.displayname : null;" +
      "return out;");

    console.log("\n════ LES JOUEURS ════");
    console.log(JSON.stringify(joueurs, null, 1).slice(0, 2200));

    releve("zone-de-chat-" + quelle + ".json", { chat, joueurs });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUI A ÉTÉ PERDU ICI, ET COMMENT ----------
 *
 * Un découpage automatique visait « const LIS = » pour remplacer le corps
 * d'une sonde. Ce nom était employé par PLUSIEURS sondes : la première
 * occurrence du fichier était celle-ci, et la coupure a emporté tout ce qui
 * suivait jusqu'à la sonde visée — treize sondes.
 *
 * LA LEÇON EST DANS L'ANCRE, PAS DANS LE REMÈDE. Une ancre doit être UNIQUE
 * dans le fichier qu'elle vise ; « const LIS = » ne l'était pas, et rien ne
 * l'avait vérifié. Les remplacements de ce dépôt lèvent quand l'ancre est
 * introuvable — jamais quand elle est trouvée DEUX fois.
 *
 * L'extension elle-même n'a pas été touchée : ces sondes sont des outils.
 * Celles dont le texte existait encore ont été reposées ; les autres
 * réécrites. « chuchote », qui mesurait la syntaxe du chuchotement, ne l'a pas
 * été : « destinataire » couvre le même terrain et c'est celle qu'on lance.
 */

/* ---------- LES ÉMOJIS SE VOIENT-ILS VRAIMENT ? ----------
 *
 * La promesse est « des émojis que tout le monde peut voir ». Le banc d'essai
 * vérifie la FORME — pas de séquence composée, rien de postérieur à 2019 — mais
 * il ne sait rien du RENDU, et c'est là que se cachait la vraie erreur : le
 * premier jet croyait déduire d'un intervalle de points de code si un caractère
 * a besoin de son sélecteur de présentation. C'est faux dans les deux sens.
 *
 * On ne déduit donc plus, on DESSINE. Chaque émoji est peint sur un canevas
 * dans le vrai navigateur, et l'on regarde ce qui sort :
 *   · rien du tout            → le caractère n'existe pas dans la police ;
 *   · le même dessin que le
 *     carré vide de référence → la police ne le connaît pas ;
 *   · une image en gris       → présentation TEXTE, donc sélecteur manquant.
 *
 * Puis on s'en sert pour de vrai : ouvrir le panneau, cliquer, vérifier que le
 * caractère atterrit au curseur, envoyer, et le relire dans le journal du chat.
 * C'est ce dernier point qui prouve la promesse — ce qui est dans le journal,
 * tout le monde le voit.
 */
async function emojisDuChat() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(12000);

    /* Le catalogue est lu SUR LE DISQUE et passé à la page : c'est celui qui
     * part chez l'utilisateur, pas une copie qu'on aurait retapée. */
    const ctx = {};
    require("vm").createContext(ctx);
    require("vm").runInContext(
      require("fs").readFileSync(require("path").join(RACINE, "extension/commun/emojis.js"), "utf8"),
      ctx, { filename: "emojis.js" });
    const cats = ctx.VTT_EMOJIS;
    const tous = [];
    cats.forEach(function (c) { c.liste.forEach(function (e) { tous.push([c.id, e[0], e[1]]); }); });
    console.log("\n  " + tous.length + " émojis à peindre, en " + cats.length + " catégories.");

    const RENDU = function (liste) {
      var T = 32;
      var c = document.createElement("canvas");
      c.width = T; c.height = T;
      var x = c.getContext("2d", { willReadFrequently: true });
      var police = '26px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

      function peins(txt) {
        x.clearRect(0, 0, T, T);
        x.font = police;
        x.textBaseline = "top";
        x.fillStyle = "#000";
        x.fillText(txt, 2, 2);
        return x.getImageData(0, 0, T, T).data;
      }
      function signe(d) {
        var s = "", vides = 0, couleurs = 0, i;
        for (i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 8) { vides++; continue; }
          if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) { couleurs++; }
        }
        for (i = 0; i < d.length; i += 16) { s += String.fromCharCode(65 + (d[i + 3] >> 5)); }
        return { s: s, vide: vides === d.length / 4, couleurs: couleurs };
      }

      /* La référence du carré vide : un point de code d'usage privé, que
       * AUCUNE police ne dessine. Tout ce qui lui ressemble est un trou. */
      var carre = signe(peins(String.fromCodePoint(0x10FFFD)));

      var out = { invisibles: [], carres: [], gris: [], ok: 0 };
      liste.forEach(function (e) {
        var g = signe(peins(e[1]));
        if (g.vide) { out.invisibles.push(e); return; }
        if (g.s === carre.s) { out.carres.push(e); return; }
        if (g.couleurs === 0) { out.gris.push(e); return; }
        out.ok++;
      });
      out.reference = { vide: carre.vide };
      return out;
    };

    const r = await driver.executeScript(RENDU, tous);
    console.log("\n  ── LE RENDU, MESURÉ ──");
    console.log("    en couleur         : " + r.ok + " / " + tous.length);
    console.log("    invisibles         : " + r.invisibles.length);
    r.invisibles.slice(0, 12).forEach(function (e) { console.log("        " + e[0] + " — " + e[2]); });
    console.log("    carrés vides       : " + r.carres.length);
    r.carres.slice(0, 12).forEach(function (e) { console.log("        " + e[0] + " — " + e[2]); });
    console.log("    en gris (texte)    : " + r.gris.length);
    r.gris.slice(0, 20).forEach(function (e) {
      console.log("        " + e[0] + " — " + e[2] + "   " +
        Array.from(e[1]).map(function (c) { return c.codePointAt(0).toString(16); }).join(" "));
    });

    /* ---------- ET MAINTENANT, ON S'EN SERT ---------- */
    console.log("\n  ── LE PANNEAU ──");
    const ouvert = await driver.executeScript(
      "var b = document.querySelector('.vttk-chat-emoji');" +
      "if (!b) { return { erreur: 'pas de bouton' }; }" +
      "b.click();" +
      "var p = document.querySelector('.vttk-emoji-panneau');" +
      "if (!p) { return { erreur: 'pas de panneau' }; }" +
      "var z = document.querySelector('#textchat-input textarea');" +
      "var q = p.getBoundingClientRect(), c = z.getBoundingClientRect();" +
      "return { onglets: p.querySelectorAll('.vttk-emoji-onglet').length," +
      "  tuiles: p.querySelectorAll('.vttk-emoji-tuile').length," +
      "  titre: (p.querySelector('.vttk-emoji-titre') || {}).textContent," +
      "  boite: { x: Math.round(q.left), y: Math.round(q.top), l: Math.round(q.width), h: Math.round(q.height) }," +
      "  champ: { x: Math.round(c.left), y: Math.round(c.top), l: Math.round(c.width), h: Math.round(c.height) }," +
      "  memeGauche: Math.abs(q.left - c.left) < 1," +
      "  memeLargeur: Math.abs(q.width - c.width) < 1," +
      "  recouvre: q.bottom > c.top + 0.5," +
      "  dansLEcran: q.top >= 0 && q.left >= 0 && q.right <= window.innerWidth && q.bottom <= window.innerHeight," +
      "  allume: b.classList.contains('ouvert') };");
    Object.keys(ouvert).forEach(function (k) { console.log("    " + k.padEnd(12) + " " + JSON.stringify(ouvert[k])); });

    if (ouvert.boite) {
      await capturePres(driver, "emoji-panneau.png",
        ouvert.boite.x - 10, ouvert.boite.y - 10, ouvert.boite.l + 20, ouvert.boite.h + 90, 2);
    }

    /* ---------- ET QUAND ON REDIMENSIONNE ? ----------
     * Le champ est redimensionnable ; une largeur relevée à l'ouverture serait
     * fausse au premier glissement. On force donc une nouvelle largeur sur la
     * barre latérale, on laisse l'observateur réagir, et on remesure. */
    /* ON REDIMENSIONNE LE CHAMP LUI-MÊME, par sa hauteur — c'est ce que fait sa
     * poignée, et c'est ce qui déplace son bord haut, donc le bas du panneau.
     *
     * Le premier essai élargissait la barre latérale : elle n'a pas bougé d'un
     * pixel (330 avant, 330 après), si bien que l'essai ne prouvait rien du
     * tout. Une vérification qui ne fait pas varier ce qu'elle mesure ne
     * vérifie rien. */
    const avantH = await driver.executeScript(
      "var z = document.querySelector('#textchat-input textarea');" +
      "var h = z.getBoundingClientRect().height;" +
      "z.style.height = (h + 70) + 'px';" +
      "return Math.round(h);");
    await dors(900);
    const suivi = await driver.executeScript(
      "var p = document.querySelector('.vttk-emoji-panneau');" +
      "var z = document.querySelector('#textchat-input textarea');" +
      "if (!p || !z) { return { erreur: 'disparu' }; }" +
      "var q = p.getBoundingClientRect(), c = z.getBoundingClientRect();" +
      "return { largeurPanneau: Math.round(q.width), largeurChamp: Math.round(c.width)," +
      "  hauteurChamp: Math.round(c.height)," +
      "  ecart: Math.round(c.top - q.bottom)," +
      "  memeLargeur: Math.abs(q.width - c.width) < 1," +
      "  memeGauche: Math.abs(q.left - c.left) < 1," +
      "  recouvre: q.bottom > c.top + 0.5 };");
    console.log(String.fromCharCode(10) + "  ── APRÈS REDIMENSIONNEMENT DU CHAMP ──");
    console.log("    hauteur du champ : " + avantH + " → " + (suivi.hauteurChamp || "?") + " px");
    Object.keys(suivi).forEach(function (k) { console.log("    " + k.padEnd(16) + " " + JSON.stringify(suivi[k])); });

    /* ---------- L'INSERTION SE FAIT AU CURSEUR ----------
     * On écrit « ab », on ramène le curseur ENTRE les deux, et on clique. Un
     * émoji qui se collerait à la fin passerait un essai naïf sans rien prouver. */
    console.log("\n  ── L'INSERTION ──");
    const ins = await driver.executeScript(
      "var z = document.querySelector('#textchat-input textarea');" +
      "if (!z) { return { erreur: 'pas de champ' }; }" +
      "var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(z), 'value');" +
      "d.set.call(z, 'ab'); z.dispatchEvent(new Event('input', { bubbles: true }));" +
      "z.focus(); z.selectionStart = z.selectionEnd = 1;" +
      "var t = document.querySelector('.vttk-emoji-tuile');" +
      "if (!t) { return { erreur: 'pas de tuile' }; }" +
      "var car = t.textContent;" +
      "t.click();" +
      "var t2 = document.querySelectorAll('.vttk-emoji-tuile')[1];" +
      "var car2 = t2 ? t2.textContent : '';" +
      "if (t2) { t2.click(); }" +
      "return { valeur: z.value, attendu: 'a' + car + car2 + 'b'," +
      "  curseur: z.selectionStart, apresLesDeux: 1 + car.length + car2.length," +
      "  premier: car, second: car2 };");
    Object.keys(ins).forEach(function (k) { console.log("    " + k.padEnd(14) + " " + JSON.stringify(ins[k])); });

    /* ---------- ET LA TABLE LE VOIT ---------- */
    console.log("\n  ── L'ENVOI ──");
    const marque = "essai-emoji-" + tous.length;
    const envoye = await driver.executeScript(
      "var z = document.querySelector('#textchat-input textarea');" +
      "if (!z) { return { erreur: 'pas de champ' }; }" +
      "var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(z), 'value');" +
      "d.set.call(z, arguments[0] + ' \u{1F3B2}\u{2694}️\u{1F409}');" +
      "z.dispatchEvent(new Event('input', { bubbles: true }));" +
      "var b = document.querySelector('#chatSendBtn');" +
      "if (b) { b.click(); return { envoye: true }; }" +
      "return { envoye: false };", marque);
    console.log("    " + JSON.stringify(envoye));
    await dors(2500);
    const lu = await driver.executeScript(
      "var n = document.querySelectorAll('#textchat .message'), out = [];" +
      "for (var i = Math.max(0, n.length - 6); i < n.length; i++) {" +
      "  out.push((n[i].textContent || '').replace(/\\s+/g, ' ').trim()); }" +
      "return out;");
    (lu || []).forEach(function (l) { console.log("      " + l.slice(0, 120)); });
    const vu = (lu || []).some(function (l) {
      return l.indexOf(marque) >= 0 && l.indexOf("\u{1F409}") >= 0 && l.indexOf("\u{2694}️") >= 0;
    });

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  tous les émojis se dessinent en couleur : " + (r.invisibles.length + r.carres.length + r.gris.length === 0 ? "OUI" : "NON"));
    console.log("  le panneau s'ouvre entièrement à l'écran : " + (ouvert.dansLEcran ? "OUI" : "NON"));
    console.log("  il NE RECOUVRE PAS le champ de saisie     : " + (!ouvert.recouvre ? "OUI" : "NON"));
    console.log("  il a exactement la largeur du champ       : " + (ouvert.memeLargeur && ouvert.memeGauche ? "OUI" : "NON — " + ouvert.boite.l + " contre " + ouvert.champ.l));
    console.log("  il suit quand on redimensionne            : " + (suivi.memeLargeur && suivi.memeGauche && !suivi.recouvre ? "OUI" : "NON — " + suivi.largeurPanneau + " contre " + suivi.largeurChamp));
    console.log("  l'insertion se fait AU CURSEUR           : " + (ins.valeur === ins.attendu ? "OUI" : "NON — « " + ins.valeur + " » au lieu de « " + ins.attendu + " »"));
    console.log("  le curseur reste APRÈS l'émoji           : " + (ins.curseur === ins.apresLesDeux ? "OUI" : "NON — " + ins.curseur + " au lieu de " + ins.apresLesDeux));
    console.log("  l'émoji arrive intact dans le journal    : " + (vu ? "OUI" : "NON"));

    releve("emoji-rendu.json", { total: tous.length, ok: r.ok, invisibles: r.invisibles, carres: r.carres, gris: r.gris, panneau: ouvert, insertion: ins, journal: lu });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- OÙ VA LA SECONDE ET DEMIE ? ----------
 *
 * Mesuré : au-delà de 250 %, chaque cran de molette bloque le fil principal
 * plus d'une seconde ; dans la plage de Roll20, rien du tout. Reste à savoir
 * CE QUI coûte, parce que trois explications tiennent également debout :
 *
 *   1. écrire la caméra coûte, quel que soit le zoom ;
 *   2. c'est le CHANGEMENT qui coûte, proportionnellement à son ampleur ;
 *   3. c'est le NIVEAU de zoom qui coûte — dessiner la carte à 450 % est cher
 *      en soi, et personne n'y peut rien.
 *
 * Les trois se distinguent en faisant varier une seule chose à la fois. On
 * demande donc le même pas — dix pour cent — à des niveaux différents, et on
 * mesure ce que le fil principal encaisse après chaque demande.
 */
async function ouEstLeCout() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(14000);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 10, max: 700 }, '*');");
    await dors(2000);

    /* Le chronomètre : on note la gigue d'une minuterie à 20 ms pendant les
     * deux secondes qui suivent une demande. Ce qui dépasse est du blocage. */
    const CHRONO = "window.__c = function (ms) { return new Promise(function (res) {" +
      "  var g = [], att = performance.now() + 20;" +
      "  var t = setInterval(function () { var n = performance.now(); g.push(n - att); att = n + 20; }, 20);" +
      "  setTimeout(function () { clearInterval(t);" +
      "    var b = g.filter(function (x) { return x > 40; });" +
      "    res({ pire: Math.round(Math.max.apply(null, g.concat([0])))," +
      "      blocages: b.length, ms: Math.round(b.reduce(function (a, c) { return a + c; }, 0)) }); }, ms); }); };";
    await driver.executeScript(CHRONO);

    async function demande(z) {
      return await driver.executeAsyncScript(
        "var cb = arguments[arguments.length - 1], z = arguments[0];" +
        "var pr = window.__c(2200);" +
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: z }, '*');" +
        "pr.then(cb);", z);
    }

    async function ou() {
      return await driver.executeScript(
        "return window.__vttinkerZoom ? JSON.parse(JSON.stringify(window.__vttinkerZoom)) : null;");
    }

    /* Un pas de dix pour cent, à sept niveaux : quatre dans sa plage, trois
     * au-dehors. Le même geste, le même écart relatif, des niveaux différents. */
    const NIVEAUX = [50, 100, 150, 200, 240, 300, 450, 600];
    console.log(String.fromCharCode(10) + "  ── UN PAS DE 10 %, À CHAQUE NIVEAU ──");
    const table = [];
    for (const n of NIVEAUX) {
      await demande(n);            // s'y rendre, sans mesurer le trajet
      await dors(2500);
      const avant = await ou();
      const r = await demande(Math.round(n * 1.1));
      const apres = await ou();
      const d = {};
      if (avant && apres) { Object.keys(apres).forEach(function (k) { d[k] = apres[k] - avant[k]; }); }
      console.log("    " + String(n).padStart(4) + " → " + String(Math.round(n * 1.1)).padStart(4) +
        "   pire " + String(r.pire).padStart(5) + " ms" +
        "   blocages " + String(r.blocages).padStart(2) +
        "   total " + String(r.ms).padStart(5) + " ms" +
        "   | caméras " + (d.cameras || 0) + "  états " + (d.etats || 0));
      table.push({ de: n, a: Math.round(n * 1.1), pire: r.pire, blocages: r.blocages, ms: r.ms, compteurs: d });
      await dors(1200);
    }

    /* ET LA MÊME ÉCRITURE SANS RIEN CHANGER : si elle coûte autant, ce n'est pas
     * le changement qui coûte, c'est l'écriture. */
    console.log(String.fromCharCode(10) + "  ── LA MÊME VALEUR, RÉÉCRITE ──");
    for (const n of [150, 450]) {
      await demande(n);
      await dors(2500);
      const r = await demande(n);
      console.log("    " + String(n).padStart(4) + " → " + String(n).padStart(4) +
        "   pire " + String(r.pire).padStart(5) + " ms   total " + String(r.ms).padStart(5) + " ms");
      table.push({ de: n, a: n, pire: r.pire, blocages: r.blocages, ms: r.ms });
      await dors(1200);
    }

    /* ET SANS NOUS : on demande à Roll20 de zoomer par SA propre action, dans sa
     * plage. Si ça coûte pareil à niveau égal, le coût n'est pas le nôtre. */
    console.log(String.fromCharCode(10) + "  ── PAR SA PROPRE ACTION, DANS SA PLAGE ──");
    const sien = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1];" +
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var st = mag('engine');" +
      "if (!st || typeof st.setZoom !== 'function') { cb({ erreur: 'pas de setZoom' }); return; }" +
      "st.setZoom(150);" +
      "setTimeout(function () { var pr = window.__c(2200); st.setZoom(165); pr.then(cb); }, 2500);");
    console.log("    150 → 165 par son setZoom : " + JSON.stringify(sien));

    releve("zoom-ou-ca.json", { table: table, sien: sien });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- L'ABONNEMENT EST-IL LE COUPABLE ? ----------
 *
 * Mesuré, et reproductible : module éteint, TOUS les appels de zoom de Roll20
 * sont gratuits ; module allumé, LES MÊMES bloquent le fil principal de 455 à
 * 1 603 ms. Y compris « $patch », que nous ne remplaçons pas — donc le coût
 * n'est pas dans nos remplacements, mais dans quelque chose que nous ATTACHONS
 * à son magasin.
 *
 * Une seule chose est attachée : « $subscribe », posé pour suivre le zoom
 * quand Roll20 le change lui-même. Or « $subscribe » de Pinia ne se contente
 * pas d'enregistrer un rappel : il installe AUSSI un observateur PROFOND sur
 * l'état du magasin, pour attraper les écritures directes. Sur le magasin
 * « engine » de Roll20 — qui porte l'état de toute la scène — chaque mutation
 * ferait alors parcourir tout le graphe.
 *
 * ON NE LE CROIT PAS SUR PAROLE. Module ÉTEINT, on mesure « $patch », puis on
 * pose NOUS-MÊMES un « $subscribe » vide depuis la page, et on remesure. Si le
 * coût apparaît avec un rappel qui ne fait RIEN, la cause n'est pas ce que le
 * rappel fait : c'est l'abonnement lui-même.
 *
 * Et l'on mesure le remède dans la foulée : un relevé périodique de la valeur,
 * qui n'attache rien du tout.
 */
async function abonnementCoupable() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(14000);

    await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "window.__mag = mag;" +
      "window.__c = function (ms) { return new Promise(function (res) {" +
      "  var g = [], att = performance.now() + 20;" +
      "  var t = setInterval(function () { var n = performance.now(); g.push(n - att); att = n + 20; }, 20);" +
      "  setTimeout(function () { clearInterval(t);" +
      "    var b = g.filter(function (x) { return x > 40; });" +
      "    res({ pire: Math.round(Math.max.apply(null, g.concat([0])))," +
      "      ms: Math.round(b.reduce(function (a, c) { return a + c; }, 0)) }); }, ms); }); };");

    async function mesure(nom) {
      await driver.executeScript("var st = window.__mag('engine'); st.setZoomSilent(150);");
      await dors(2500);
      const r = await driver.executeAsyncScript(
        "var cb = arguments[arguments.length - 1];" +
        "var st = window.__mag('engine');" +
        "var pr = window.__c(2400);" +
        "st.$patch({ zoom: 165 });" +
        "pr.then(cb);");
      console.log("    " + nom.padEnd(40) + " blocage " + String(r.ms).padStart(5) + " ms   pire " + String(r.pire).padStart(5));
      await dors(1000);
      return r;
    }

    console.log(String.fromCharCode(10) + "  ── UN « $patch », DANS QUATRE CONDITIONS ──");
    const nu = await mesure("rien d'attaché");

    /* Un rappel VIDE : il ne fait rien, absolument rien. */
    await driver.executeScript(
      "var st = window.__mag('engine');" +
      "window.__stop = st.$subscribe(function () {});");
    const abonne = await mesure("un $subscribe au rappel VIDE");

    await driver.executeScript("try { window.__stop(); } catch (e) {} window.__stop = null;");
    await dors(1500);
    const retire = await mesure("le même, retiré");

    /* Le remède : un relevé périodique, qui n'attache rien. */
    await driver.executeScript(
      "var st = window.__mag('engine'); window.__vu = st.zoom; window.__tours = 0;" +
      "window.__poll = setInterval(function () { window.__tours++;" +
      "  var z = st.zoom; if (z !== window.__vu) { window.__vu = z; } }, 250);");
    const sonde = await mesure("un relevé toutes les 250 ms");
    const tours = await driver.executeScript("return window.__tours;");
    await driver.executeScript("clearInterval(window.__poll);");

    console.log(String.fromCharCode(10) + "  le relevé a tourné " + tours + " fois sans rien coûter.");
    console.log(String.fromCharCode(10) + "  ──────────────────────────────────────────────");
    console.log("  rien d'attaché        : " + nu.ms + " ms");
    console.log("  $subscribe vide       : " + abonne.ms + " ms");
    console.log("  après l'avoir retiré  : " + retire.ms + " ms");
    console.log("  relevé périodique     : " + sonde.ms + " ms");
    console.log("  VERDICT : l'abonnement " + (abonne.ms > 200 && nu.ms < 100 && retire.ms < 100 ? "EST le coupable" : "n'est pas établi coupable"));

    releve("zoom-coupable.json", { nu: nu, abonne: abonne, retire: retire, sonde: sonde, tours: tours });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- L'HORLOGE MONTE-T-ELLE ENCORE LA GARDE ? ----------
 *
 * L'abonnement qu'on vient de supprimer ne servait pas qu'à suivre la valeur :
 * il reposait AUSSI la caméra à chaque remuement du magasin de Roll20, et le
 * commentaire du pont nommait un cas précis — le redimensionnement de la
 * fenêtre. Au-delà de 250 %, la caméra est le SEUL objet qui tienne le zoom :
 * si Roll20 recalcule ses plans orthographiques à cette occasion et que
 * personne ne les repose, la vue retombe à 250 sans que rien ne le relève.
 *
 * Une relecture adverse a soulevé exactement ce risque contre le correctif. On
 * ne répond pas à ça par un raisonnement : on redimensionne, et on regarde.
 *
 * CE QU'ON ATTEND. La hauteur orthographique vaut (hauteur de la toile / 2) ×
 * (100 / zoom) : elle DOIT donc changer avec la fenêtre, et rester accordée au
 * zoom demandé. Ce qu'on refuse, c'est qu'elle corresponde à 250 %.
 */
async function gardeDeLaCamera() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(14000);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 10, max: 700 }, '*');");
    await dors(2000);

    const LIS = "function cam() { var s = null;" +
      "  try { s = window.currentPlayer.d20.engine.canvasScene; } catch (e) {}" +
      "  if (!s) { try { s = VTTEngine.instance.scene; } catch (e) {} }" +
      "  var c = s && s.activeCamera ? s.activeCamera : null;" +
      "  var t = document.querySelector('canvas');" +
      "  if (!c || !t) { return null; }" +
      "  return { haut: Math.round(c.orthoTop * 100) / 100, toile: t.height," +
      "    zoomDeduit: Math.round((t.height / 2) * 100 / c.orthoTop) };" +
      "} return cam();";

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 450 }, '*');");
    await dors(2500);
    const avant = await driver.executeScript(LIS);
    console.log(String.fromCharCode(10) + "  avant le redimensionnement : " + JSON.stringify(avant));

    const r = await driver.manage().window().getRect();
    await driver.manage().window().setRect({ width: Math.max(900, r.width - 260), height: Math.max(700, r.height - 180), x: r.x, y: r.y });
    await dors(1200);
    const pendant = await driver.executeScript(LIS);
    console.log("  juste après (1,2 s)        : " + JSON.stringify(pendant));
    await dors(2000);
    const apres = await driver.executeScript(LIS);
    console.log("  trois secondes plus tard   : " + JSON.stringify(apres));

    await driver.manage().window().setRect(r);
    await dors(2500);
    const rendu = await driver.executeScript(LIS);
    console.log("  fenêtre rendue à sa taille : " + JSON.stringify(rendu));

    const compteurs = await driver.executeScript("return window.__vttinkerZoom;");
    console.log(String.fromCharCode(10) + "  compteurs : " + JSON.stringify(compteurs));
    console.log("  ──────────────────────────────────────────────");
    function bon(x) { return x && x.zoomDeduit >= 440 && x.zoomDeduit <= 460; }
    console.log("  le zoom tient après redimensionnement : " + (bon(apres) ? "OUI" : "NON — " + (apres ? apres.zoomDeduit : "?") + " %"));
    console.log("  et après retour à la taille d'origine : " + (bon(rendu) ? "OUI" : "NON — " + (rendu ? rendu.zoomDeduit : "?") + " %"));

    releve("zoom-garde.json", { avant: avant, pendant: pendant, apres: apres, rendu: rendu, compteurs: compteurs });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE STYLE DE ROLL20, RELEVÉ ET NON IMITÉ ----------
 *
 * Demandé : « respecte les normes de Roll20 », « du style à la Roll20 ». On ne
 * répond pas à ça de mémoire : on relève ses vraies valeurs — familles et
 * tailles de police, couleurs, rayons, hauteurs de contrôle, épaisseurs de
 * bord — sur ses propres panneaux, ceux que l'utilisateur a sous les yeux.
 *
 * On regarde en particulier SES PANNEAUX DE RÉGLAGES, parce que c'est
 * exactement ce que nos deux surfaces sont : une liste d'interrupteurs et
 * quelques champs.
 */
async function styleDeRoll20() {
  const driver = await ouvre(config().visible === true);
  try {
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(14000);

    const LIS = "function d(n) { if (!n) { return null; }" +
      "  var c = getComputedStyle(n), q = n.getBoundingClientRect();" +
      "  return { police: c.fontFamily.split(',')[0].replace(/\"/g, ''), taille: c.fontSize, graisse: c.fontWeight," +
      "    interligne: c.lineHeight, casse: c.textTransform, espacement: c.letterSpacing," +
      "    couleur: c.color, fond: c.backgroundColor," +
      "    bord: c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor," +
      "    rayon: c.borderRadius, ombre: c.boxShadow.slice(0, 60), pad: c.padding," +
      "    h: Math.round(q.height), l: Math.round(q.width) }; }" +
      "function q1(sel) { return d(document.querySelector(sel)); }" +
      "var out = {};" +
      "out.corps = d(document.body);" +
      "out.barre = q1('#floatingtoolbar');" +
      "out.sousMenu = q1('.block-submenu') || q1('[class*=submenu]');" +
      "out.tchat = q1('#textchat');" +
      "out.message = q1('#textchat .message');" +
      "out.bouton = q1('.btn');" +
      "out.boutonPrimaire = q1('.btn.btn-primary') || q1('.btn-primary');" +
      "out.champ = q1('input[type=text]');" +
      "out.nombre = q1('input[type=number]');" +
      "out.select = q1('select');" +
      "out.case = q1('input[type=checkbox]');" +
      "out.etiquette = q1('label');" +
      "out.onglet = q1('.ui-tabs-nav li') || q1('[role=tab]');" +
      "out.titrePanneau = q1('.sidebarheader') || q1('h3') || q1('h4');" +
      "out.panneauDroit = q1('#rightsidebar');" +
      "var boites = document.querySelectorAll('.ui-dialog, .dialog, [class*=popover], [class*=submenu]');" +
      "out.boites = [];" +
      "for (var i = 0; i < Math.min(6, boites.length); i++) {" +
      "  var o = d(boites[i]); o.quoi = boites[i].className.slice(0, 46); out.boites.push(o); }" +
      "var tailles = {}, n = document.querySelectorAll('#rightsidebar *, #floatingtoolbar *');" +
      "for (var j = 0; j < n.length; j++) { var t = getComputedStyle(n[j]).fontSize;" +
      "  tailles[t] = (tailles[t] || 0) + 1; }" +
      "out.taillesFrequentes = Object.keys(tailles).map(function (k) { return [k, tailles[k]]; })" +
      "  .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);" +
      "var fam = {}; for (var k = 0; k < n.length; k++) { var f = getComputedStyle(n[k]).fontFamily.split(',')[0];" +
      "  fam[f] = (fam[f] || 0) + 1; }" +
      "out.policesFrequentes = Object.keys(fam).map(function (x) { return [x, fam[x]]; })" +
      "  .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);" +
      "return out;";

    const st = await driver.executeScript(LIS);
    console.log(String.fromCharCode(10) + "  ── CE QUE ROLL20 EMPLOIE ──");
    Object.keys(st).forEach(function (k) {
      if (k === 'boites' || k === 'taillesFrequentes' || k === 'policesFrequentes') { return; }
      if (!st[k]) { console.log("    " + k.padEnd(16) + " absent"); return; }
      const o = st[k];
      console.log("    " + k.padEnd(16) + " " + o.police + "  " + o.taille + "  gras " + o.graisse +
        "  interligne " + o.interligne);
      console.log("      ".padEnd(20) + "couleur " + o.couleur + "   fond " + o.fond);
      console.log("      ".padEnd(20) + "bord " + o.bord + "   rayon " + o.rayon + "   h=" + o.h);
    });
    console.log(String.fromCharCode(10) + "  ── LES BOÎTES FLOTTANTES ──");
    (st.boites || []).forEach(function (o) {
      console.log("    " + String(o.quoi).padEnd(46) + " rayon " + o.rayon + "  bord " + o.bord +
        "  fond " + o.fond + "  ombre " + o.ombre);
    });
    console.log(String.fromCharCode(10) + "  ── TAILLES DE POLICE LES PLUS FRÉQUENTES ──");
    (st.taillesFrequentes || []).forEach(function (x) { console.log("    " + String(x[0]).padStart(7) + "  ×" + x[1]); });
    console.log("  ── FAMILLES ──");
    (st.policesFrequentes || []).forEach(function (x) { console.log("    " + String(x[0]).padEnd(26) + " ×" + x[1]); });

    /* Sa propre boîte de réglages, ouverte : c'est le modèle le plus proche. */
    const ouvert = await driver.executeScript(
      "var b = document.querySelector('#floatingtoolbar li[data-tool=settings], #floatingtoolbar li');" +
      "if (b) { b.click(); }" +
      "return !!document.querySelector('.block-submenu');");
    await dors(1200);
    const sien = await driver.executeScript(
      "var p = document.querySelector('.block-submenu');" +
      "if (!p) { return null; }" +
      "var c = getComputedStyle(p), q = p.getBoundingClientRect();" +
      "var enf = [];" +
      "[].slice.call(p.querySelectorAll('*')).slice(0, 14).forEach(function (n) {" +
      "  var s = getComputedStyle(n), r = n.getBoundingClientRect();" +
      "  enf.push(n.tagName.toLowerCase() + '.' + String(n.className).slice(0, 24) + ' | ' + s.fontSize +" +
      "    ' | ' + s.color + ' | h=' + Math.round(r.height) + ' | rayon ' + s.borderRadius); });" +
      "return { fond: c.backgroundColor, bord: c.border, rayon: c.borderRadius, ombre: c.boxShadow.slice(0, 70)," +
      "  pad: c.padding, taille: c.fontSize, police: c.fontFamily.split(',')[0], couleur: c.color," +
      "  boite: [Math.round(q.width), Math.round(q.height)], enfants: enf };");
    console.log(String.fromCharCode(10) + "  ── SON PROPRE PANNEAU (.block-submenu) : " + (ouvert ? "ouvert" : "pas ouvert"));
    if (sien) {
      Object.keys(sien).forEach(function (k) {
        if (k === 'enfants') { return; }
        console.log("    " + k.padEnd(10) + " " + JSON.stringify(sien[k]));
      });
      (sien.enfants || []).forEach(function (e) { console.log("      | " + e); });
      await capturePres(driver, "style-roll20.png", 40, 60, 420, 520, 2);
    }

    releve("style-roll20.json", { global: st, sien: sien });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QU'EST-CE QUI RAME, ET DE COMBIEN ? ----------
 *
 * Plainte : « mon PC rame quand j'active l'extension de zoom ». Pas « quand je
 * zoome » — quand il ACTIVE. Ce qui coûte est donc peut-être payé en
 * permanence, sans qu'on touche à rien.
 *
 * DEUX INSTRUMENTS, ET IL A FALLU JETER LES DEUX PREMIERS.
 *
 *   · LA GIGUE D'UNE MINUTERIE. Une minuterie réglée sur 20 ms qui revient au
 *     bout de 200 dit qu'un travail a tenu le fil principal pendant 180 ms.
 *     C'est ça, « ça rame », et ça se mesure partout.
 *
 *     Le premier jet employait PerformanceObserver sur « longtask » : Firefox
 *     ne connaît pas ce type d'entrée, l'appel ne lève rien, et l'observateur
 *     n'a JAMAIS rien signalé. Quatre colonnes de zéros parfaitement rassurantes
 *     et parfaitement creuses.
 *
 *   · LES TRAMES, dont on ne garde que la queue. La médiane ment ; c'est le 95e
 *     centile et le pire qu'on ressent.
 *
 * ET LES COMPTEURS DU PONT disent combien de fois par seconde chaque chemin est
 * parcouru. Un chemin cher mais rare ne fait rien ; un chemin bon marché
 * parcouru mille fois par seconde, si.
 *
 * ON ACTIVE LE MODULE EN PARLANT AU PONT, ET NON PAR LE STOCKAGE.
 *
 * Deux tentatives ont échoué avant celle-ci. Écrire browser.storage depuis
 * executeScript : ce code s'exécute dans le monde de la PAGE, qui n'a pas de
 * browser.storage — on écrivait dans le vide en croyant avoir éteint le module.
 * Passer par le panneau de l'extension : Firefox piloté refuse de naviguer vers
 * une page moz-extension.
 *
 * Or le pont n'attend qu'un message : « zoom, actif, min, max ». Le lui envoyer
 * installe exactement ce qu'on veut mesurer — les bornes, l'écouteur de molette,
 * l'abonnement au magasin — dans le MÊME chargement de page, donc avec le même
 * témoin. C'est plus direct et plus juste.
 *
 * ET IL FAUT DES BORNES PLUS LARGES QUE LES SIENNES. Par défaut elles valent
 * 10–250, c'est-à-dire exactement celles de Roll20 : le module n'a alors rien à
 * faire. C'est en les élargissant qu'on obtient l'outil dont l'auteur parle.
 */
async function fluiditeDuZoom() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(14000);

    const MSG = "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: arguments[0], min: 10, max: 600 }, '*');";

    /* L'INSTRUMENT. */
    const POSE = "window.__m = { trames: [], gigue: [], actif: false };" +
      "var m = window.__m, dernier = 0, attendu = 0, minut = null;" +
      "function tic(t) { if (dernier) { m.trames.push(t - dernier); } dernier = t;" +
      "  if (m.actif) { requestAnimationFrame(tic); } }" +
      "m.demarre = function () { m.trames.length = 0; m.gigue.length = 0; m.actif = true; dernier = 0;" +
      "  requestAnimationFrame(tic);" +
      "  attendu = performance.now() + 20;" +
      "  minut = setInterval(function () { var n = performance.now();" +
      "    m.gigue.push(n - attendu); attendu = n + 20; }, 20);" +
      "  m.depart = window.__vttinkerZoom ? JSON.parse(JSON.stringify(window.__vttinkerZoom)) : null;" +
      "  m.t0 = performance.now(); };" +
      "m.arrete = function () { m.actif = false; clearInterval(minut);" +
      "  function q(a, x) { var d = a.slice().sort(function (u, v) { return u - v; });" +
      "    return d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(d.length * x))] * 10) / 10 : 0; }" +
      "  var duree = (performance.now() - m.t0) / 1000;" +
      "  var fin = window.__vttinkerZoom, par = {};" +
      "  if (fin && m.depart) { Object.keys(fin).forEach(function (k) {" +
      "    par[k] = Math.round((fin[k] - m.depart[k]) / duree * 10) / 10; }); }" +
      "  return { secondes: Math.round(duree * 10) / 10," +
      "    trameP95: q(m.trames, 0.95), tramePire: Math.round(Math.max.apply(null, m.trames.concat([0])))," +
      "    tramesLentes: m.trames.filter(function (x) { return x > 50; }).length," +
      "    gigueP95: q(m.gigue, 0.95), giguePire: Math.round(Math.max.apply(null, m.gigue.concat([0])))," +
      "    blocages: m.gigue.filter(function (x) { return x > 50; }).length," +
      "    msBloques: Math.round(m.gigue.filter(function (x) { return x > 50; })" +
      "      .reduce(function (a, b) { return a + b; }, 0))," +
      "    parSeconde: par }; };";

    async function mesure(nom, secondes, pendant) {
      await driver.executeScript(POSE);
      await driver.executeScript("window.__m.demarre();");
      if (pendant) { await pendant(); }
      await dors(secondes * 1000);
      const r = await driver.executeScript("return window.__m.arrete();");
      console.log("  " + nom.padEnd(24) +
        " trame p95 " + String(r.trameP95).padStart(6) + "  pire " + String(r.tramePire).padStart(5) +
        "  | gigue p95 " + String(r.gigueP95).padStart(6) + "  pire " + String(r.giguePire).padStart(5) +
        "  blocages " + String(r.blocages).padStart(3) + " (" + r.msBloques + " ms)");
      const nz = Object.keys(r.parSeconde || {}).filter(function (k) { return r.parSeconde[k] > 0; });
      if (nz.length) {
        console.log("      par seconde : " + nz.map(function (k) { return k + " " + r.parSeconde[k]; }).join("   "));
      }
      return r;
    }

    async function crans(n, monte) {
      for (let i = 0; i < n; i++) {
        await driver.executeScript(
          "var t = document.querySelector('canvas'); if (!t) { return; }" +
          "var q = t.getBoundingClientRect();" +
          "t.dispatchEvent(new WheelEvent('wheel', { deltaY: arguments[0], bubbles: true, cancelable: true," +
          "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));", monte ? -120 : 120);
        await dors(120);
      }
    }

    /* ---------- LE TÉMOIN : le pont est là, le zoom ne l'est pas ---------- */
    await driver.executeScript(MSG, false);
    await dors(1500);
    console.log(String.fromCharCode(10) + "  ══ ZOOM ÉTEINT (témoin) ══");
    const t0 = await mesure("au repos", 8);
    const t1 = await mesure("crans de molette", 8, function () { return crans(12, false); });

    /* ---------- ET MAINTENANT AVEC ---------- */
    await driver.executeScript(MSG, true);
    await dors(2000);
    const pret = await driver.executeScript(
      "return { compteurs: !!window.__vttinkerZoom," +
      "  natif: (function () { var z = document.getElementById('vm_zoom_buttons');" +
      "    return z ? getComputedStyle(z).display : 'absent'; })() };");
    console.log(String.fromCharCode(10) + "  ══ ZOOM ALLUMÉ ══   compteurs " + pret.compteurs +
      ", commande de Roll20 " + pret.natif);
    const a0 = await mesure("au repos", 8);
    const a1 = await mesure("crans de molette", 8, function () { return crans(12, false); });

    /* Au-delà de sa borne : c'est là que la caméra est réécrite sans arrêt. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 450 }, '*');");
    await dors(2500);
    const zoomLa = await driver.executeScript(
      "return window.__vttinkerZoom ? JSON.parse(JSON.stringify(window.__vttinkerZoom)) : null;");
    const a2 = await mesure("au repos, hors plage", 8);
    const a3 = await mesure("crans hors plage", 8, function () { return crans(12, true); });

    console.log(String.fromCharCode(10) + "  ──────────────────────────────────────────────");
    function ligne(nom, off, on) {
      console.log("  " + nom.padEnd(22) +
        "  gigue p95 " + String(off.gigueP95).padStart(6) + " → " + String(on.gigueP95).padStart(6) +
        "   blocages " + String(off.blocages).padStart(3) + " → " + String(on.blocages).padStart(3) +
        "   (" + off.msBloques + " → " + on.msBloques + " ms)");
    }
    ligne("au repos", t0, a0);
    ligne("crans de molette", t1, a1);
    console.log("  hors plage : repos gigue p95 " + a2.gigueP95 + " (" + a2.blocages + " blocages, " + a2.msBloques + " ms)" +
      "  |  crans gigue p95 " + a3.gigueP95 + " (" + a3.blocages + " blocages, " + a3.msBloques + " ms)");
    console.log("  compteurs cumulés : " + JSON.stringify(zoomLa));

    releve("zoom-fluidite.json", { eteint: { repos: t0, crans: t1 },
      allume: { repos: a0, crans: a1, reposHors: a2, cransHors: a3, compteurs: zoomLa } });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LEQUEL DE SES APPELS COÛTE 1,3 SECONDE ? ----------
 *
 * Mesuré : avec le module actif, chaque pas de zoom DANS la plage de Roll20
 * bloque le fil principal 1,35 s ; au-dehors, notre chemin caméra ne coûte
 * rien. Puis, module ÉTEINT, ses propres appels — setZoom, setZoomSilent,
 * $patch — se sont tous révélés gratuits.
 *
 * Les deux mesures ne peuvent pas être vraies telles quelles : ou bien c'est
 * NOTRE remplacement qui coûte, ou bien c'est l'ACTIVATION du module, qui se
 * trouvait dans le même appel que le seul essai coûteux.
 *
 * On refait donc la batterie DEUX FOIS, à l'identique : module éteint, puis
 * module allumé et posé. Une seule chose change entre les deux tableaux, et
 * c'est elle qu'on accuse.
 */
async function quelAppelCoute() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(14000);

    const OUTILS = "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "window.__mag = mag;" +
      "window.__c = function (ms) { return new Promise(function (res) {" +
      "  var g = [], att = performance.now() + 20;" +
      "  var t = setInterval(function () { var n = performance.now(); g.push(n - att); att = n + 20; }, 20);" +
      "  setTimeout(function () { clearInterval(t);" +
      "    var b = g.filter(function (x) { return x > 40; });" +
      "    res({ pire: Math.round(Math.max.apply(null, g.concat([0])))," +
      "      ms: Math.round(b.reduce(function (a, c) { return a + c; }, 0)) }); }, ms); }); };";
    await driver.executeScript(OUTILS);

    async function essai(nom, code) {
      await driver.executeScript("var st = window.__mag('engine'); if (st && st.setZoomSilent) { st.setZoomSilent(150); }");
      await dors(3000);
      const r = await driver.executeAsyncScript(
        "var cb = arguments[arguments.length - 1];" +
        "var st = window.__mag('engine');" +
        "var pr = window.__c(2400);" +
        "var t0 = performance.now(); var err = null;" +
        "try { " + code + " } catch (e) { err = String(e).slice(0, 80); }" +
        "var sync = Math.round(performance.now() - t0);" +
        "pr.then(function (x) { x.sync = sync; x.err = err; x.zoom = st.zoom; cb(x); });");
      console.log("    " + nom.padEnd(32) +
        " synchrone " + String(r.sync).padStart(5) + " ms" +
        "   blocage " + String(r.ms).padStart(5) + " ms   pire " + String(r.pire).padStart(5) +
        "   zoom " + r.zoom + (r.err ? "   ERREUR " + r.err : ""));
      await dors(1000);
      return r;
    }

    async function batterie(titre) {
      console.log(String.fromCharCode(10) + "  ── " + titre + " ──");
      const o = {};
      o.rien = await essai("rien du tout (témoin)", "var x = 1;");
      o.silent = await essai("st.setZoomSilent(165)", "st.setZoomSilent(165);");
      o.setZoom = await essai("st.setZoom(165)", "st.setZoom(165);");
      o.step = await essai("st.stepAdjustZoom(true)", "st.stepAdjustZoom(true);");
      o.patch = await essai("st.$patch({ zoom: 165 })", "st.$patch({ zoom: 165 });");
      return o;
    }

    const off = await batterie("MODULE ÉTEINT");

    /* L'activation, chronométrée à part : c'est peut-être elle, le coût. */
    const act = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1];" +
      "var pr = window.__c(4000);" +
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 10, max: 700 }, '*');" +
      "pr.then(cb);");
    console.log(String.fromCharCode(10) + "  activation du module : blocage " + act.ms + " ms (pire " + act.pire + ")");
    await dors(3000);

    const on = await batterie("MODULE ALLUMÉ");

    /* Et notre propre chemin, une fois posé, des deux côtés de sa borne. */
    console.log(String.fromCharCode(10) + "  ── NOTRE CHEMIN ──");
    async function notre(de, a) {
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: arguments[0] }, '*');", de);
      await dors(3000);
      const r = await driver.executeAsyncScript(
        "var cb = arguments[arguments.length - 1];" +
        "var pr = window.__c(2400);" +
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: arguments[0] }, '*');" +
        "pr.then(cb);", a);
      console.log("    zoom-veut " + String(de).padStart(4) + " → " + String(a).padStart(4) +
        "   blocage " + String(r.ms).padStart(5) + " ms   pire " + String(r.pire).padStart(5));
      await dors(1000);
      return r;
    }
    const n1 = await notre(150, 165);
    const n2 = await notre(450, 495);

    releve("zoom-quel-appel.json", { eteint: off, activation: act, allume: on, notre: { dansLaPlage: n1, horsPlage: n2 } });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES DEUX SURFACES, ET LES DEUX PANNEAUX ----------
 *
 * Le banc dit ce qu'elles CONTIENNENT ; il ne dit rien de ce qu'elles ont
 * l'air, ni de ce qu'elles ont l'air L'UNE À CÔTÉ DE L'AUTRE.
 *
 * QUATRE QUESTIONS, TOUTES POSÉES PAR L'AUTEUR, TOUTES MESURABLES :
 *   1. le panneau de réglages a-t-il le style du panneau de marqueurs ?
 *   2. le bouton VTTK part-il quand on éteint l'extension ?
 *   3. la nuit tombe-t-elle sur les deux surfaces ?
 *   4. la palette de marqueurs parle-t-elle anglais ?
 */
async function surfacesVTTK() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(15000);

    async function presse(sel) {
      await driver.executeScript(
        "var b = document.querySelector(arguments[0] + ' button') || document.querySelector(arguments[0]);" +
        "if (b) { b.click(); }", sel);
      await dors(1500);
    }

    const STYLE = "function d(sel) { var n = document.querySelector(sel); if (!n) { return null; }" +
      "  var c = getComputedStyle(n), q = n.getBoundingClientRect();" +
      "  return { police: c.fontFamily.split(',')[0].replace(/\"/g, ''), taille: c.fontSize," +
      "    couleur: c.color, fond: c.backgroundColor, rayon: c.borderRadius," +
      "    ombre: c.boxShadow.slice(0, 46), l: Math.round(q.width) }; }" +
      "return { palette: d('.vttk-barre'), titrePalette: d('.vttk-barre-nom')," +
      "  reglages: d('.vttk-reglages') };";

    /* ---------- 1. LES DEUX PANNEAUX, CÔTE À CÔTE ---------- */
    await presse('.vttk-outil-marqueurs');
    await presse('.vttk-outil-reglages');
    const st = await driver.executeScript(STYLE);
    console.log(String.fromCharCode(10) + "  ── LES DEUX PANNEAUX ──");
    Object.keys(st).forEach(function (k) { console.log("    " + k.padEnd(14) + " " + JSON.stringify(st[k])); });
    if (st.palette && st.reglages) {
      const m = [];
      ["police", "taille", "rayon", "ombre", "l"].forEach(function (k) {
        if (String(st.palette[k]) !== String(st.reglages[k])) { m.push(k + " : " + st.palette[k] + "  \u2260  " + st.reglages[k]); }
      });
      console.log("    identiques : " + (m.length ? "NON" : "OUI"));
      m.forEach(function (x) { console.log("      " + x); });
    }

    /* ---------- 4. LA PALETTE PARLE-T-ELLE ANGLAIS ? ---------- */
    const pal = await driver.executeScript(
      "function t(s) { var n = document.querySelector(s); return n ? n.textContent.trim() : null; }" +
      "function a(s) { var n = document.querySelector(s); return n ? n.title : null; }" +
      "var modes = [].slice.call(document.querySelectorAll('.vttk-barre-mode'))" +
      "  .map(function (n) { return n.textContent.trim(); });" +
      "return { titre: t('.vttk-barre-nom'), rouage: a('.vttk-barre-rouage')," +
      "  fermer: a('.vttk-barre-ferme'), modes: modes };");
    console.log(String.fromCharCode(10) + "  ── LA PALETTE, EN ANGLAIS ──");
    Object.keys(pal).forEach(function (k) { console.log("    " + k.padEnd(8) + " " + JSON.stringify(pal[k])); });

    await capturePres(driver, "deux-panneaux.png", 48, 12, 780, 420, 2);

    /* ---------- 3. LA NUIT ---------- */
    const cadres = await driver.findElements({ css: '.vttk-reglages iframe' });
    if (cadres.length) {
      await driver.switchTo().frame(cadres[0]);
      await driver.executeScript(
        "var api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;" +
        "api.storage.local.set({ 'reg:theme': 'nuit' });");
      await dors(2000);
      const nuit = await driver.executeScript(
        "var c = getComputedStyle(document.body);" +
        "return { attribut: document.documentElement.getAttribute('data-theme')," +
        "  fond: c.backgroundColor, couleur: c.color }; }".replace(/ \}$/, ""));
      console.log(String.fromCharCode(10) + "  ── LA NUIT, DANS LE PANNEAU ──");
      Object.keys(nuit).forEach(function (k) { console.log("    " + k.padEnd(10) + " " + JSON.stringify(nuit[k])); });
      await driver.switchTo().defaultContent();
      await dors(700);
      await capturePres(driver, "panneau-nuit.png", 48, 12, 380, 340, 2);
    }

    /* ---------- 2. ÉTEINDRE ---------- */
    if (cadres.length) {
      await driver.switchTo().frame(cadres[0]);
      await driver.executeScript(
        "var api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;" +
        "api.storage.local.set({ 'reg:actif': false, 'reg:theme': 'auto' });");
      await driver.switchTo().defaultContent();
      await dors(3000);
    }
    const apres = await driver.executeScript(
      "return { rouage: !!document.querySelector('.vttk-outil-reglages')," +
      "  marqueurs: !!document.querySelector('.vttk-outil-marqueurs')," +
      "  section: !!document.querySelector('.vttk-outil-titre')," +
      "  panneau: !!document.querySelector('.vttk-reglages')," +
      "  palette: !!document.querySelector('.vttk-barre')," +
      "  zoom: !!document.querySelector('.vttk-zoom')," +
      "  chat: !!document.querySelector('.vttk-chat-a') };");
    console.log(String.fromCharCode(10) + "  ── APRÈS EXTINCTION ──");
    Object.keys(apres).forEach(function (k) {
      console.log("    " + k.padEnd(10) + " " + (apres[k] ? "ENCORE LÀ" : "parti"));
    });
    console.log("    tout est parti : " + (Object.keys(apres).every(function (k) { return !apres[k]; }) ? "OUI" : "NON"));
    await capturePres(driver, "eteint.png", 0, 12, 300, 420, 2);

    releve("surfaces-vttk.json", { styles: st, palette: pal, apres: apres });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA LIGNE « À : », ÉPROUVÉE DE BOUT EN BOUT ----------
 *
 * Cinq cas, et ils couvrent tout ce que le sélecteur peut produire :
 * chuchoter au MJ, à un nom simple, à un nom à espaces — qui exige des
 * guillemets, faute de quoi Roll20 avale une partie du message —, ne PAS
 * préfixer une commande, et laisser passer un message public.
 *
 * On lit le journal du chat après chaque envoi : c'est le seul juge.
 */
async function ligneDestinataire() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(15000);

    const CHOISIS = [
      "var s = document.querySelector('.vttk-chat-select');",
      "if (!s) { return 'pas de selecteur'; }",
      "var v = arguments[0], trouve = false, i;",
      "for (i = 0; i < s.options.length; i++) {",
      "  if (s.options[i].value === v || s.options[i].textContent.indexOf(v) === 0) {",
      "    s.value = s.options[i].value; trouve = true; break; }",
      "}",
      "if (!trouve) { return 'destinataire absent : ' + v; }",
      "s.dispatchEvent(new Event('change', { bubbles: true }));",
      "return s.value;"
    ].join("\n");

    const ENVOIE = [
      "var z = document.querySelector('#textchat-input textarea');",
      "if (!z) { return 'pas de champ'; }",
      "var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(z), 'value');",
      "d.set.call(z, arguments[0]);",
      "z.dispatchEvent(new Event('input', { bubbles: true }));",
      "var b = document.querySelector('#chatSendBtn');",
      "if (!b) { return 'pas de bouton'; }",
      "b.click();",
      "return 'envoye';"
    ].join("\n");

    const DERNIER = [
      "var n = document.querySelectorAll('#textchat .message');",
      "if (!n.length) { return null; }",
      "var m = n[n.length - 1];",
      "return { classes: String(m.className).slice(0, 60),",
      "  texte: (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) };"
    ].join("\n");

    const joueurs = await driver.executeScript(
      "var s = document.querySelector('.vttk-chat-select');" +
      "if (!s) { return []; }" +
      "return [].slice.call(s.options).map(function (o) { return [o.value, o.textContent]; });");
    console.log("\n  destinataires proposés : " + JSON.stringify(joueurs));

    const cas = [
      { qui: "gm", texte: "essai-a-1", attend: /To GM/i },
      { qui: "Alandush", texte: "essai-a-2", attend: /To Alandush/i },
      { qui: "Jean", texte: "essai-a-3", attend: /To Jean/i },
      { qui: "gm", texte: "/roll 1d20", attend: /rolling/i, commande: true },
      { qui: "", texte: "essai-a-public", attend: null }
    ];

    const vus = [];
    for (const c of cas) {
      const ch = await driver.executeScript(CHOISIS, c.qui);
      if (typeof ch === "string" && ch.indexOf("absent") === 0) {
        console.log("\n  « " + c.texte + " » — " + ch + " (ignoré)");
        vus.push({ cas: c, saute: true });
        continue;
      }
      await dors(400);
      await driver.executeScript(ENVOIE, c.texte);
      await dors(2200);
      const lu = await driver.executeScript(DERNIER);
      console.log("\n  « " + c.texte + " » vers « " + (c.qui || "tout le monde") + " »");
      console.log("      [" + (lu ? lu.classes : "?") + "] " + (lu ? lu.texte : "rien"));
      vus.push({ cas: c, lu: lu });
    }

    function bon(i) {
      const v = vus[i];
      if (!v || v.saute) { return null; }
      const t = v.lu ? v.lu.texte : "";
      if (v.cas.attend) { return v.cas.attend.test(t) && t.indexOf(v.cas.texte.replace("/roll ", "")) >= 0; }
      /* Public : le message doit être là SANS mention de destinataire. */
      return t.indexOf(v.cas.texte) >= 0 && !/To /i.test(t);
    }
    function dis(nom, v) {
      console.log("  " + nom.padEnd(38) + " : " + (v === null ? "sauté" : (v ? "OUI" : "NON")));
    }
    console.log("\n  ──────────────────────────────────────────────");
    dis("chuchoter au MJ", bon(0));
    dis("chuchoter à un nom simple", bon(1));
    dis("chuchoter à un nom à espaces, intact", bon(2));
    dis("une commande n'est PAS préfixée", bon(3));
    dis("« tout le monde » reste public", bon(4));

    releve("ligne-destinataire.json", { joueurs: joueurs, vus: vus });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA ZONE DE CHAT : SES BOÎTES ----------
 *
 * « Le tout est trop large, ça change la taille de la zone de texte au-dessus. »
 * Mesuré des deux côtés, la largeur ne bouge pas d'un pixel : c'est la HAUTEUR
 * qui bougeait, et le journal perdait exactement ce que la zone prenait. Cette
 * sonde garde le compte.
 */
async function largeurDuChat() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(15000);

    const MESURE = [
      "function b(sel) {",
      "  var n = document.querySelector(sel);",
      "  if (!n) { return null; }",
      "  var q = n.getBoundingClientRect();",
      "  return { x: Math.round(q.left), l: Math.round(q.width),",
      "    h: Math.round(q.height), scroll: n.scrollWidth };",
      "}",
      "return { panneau: b('#rightsidebar') || b('.rightsidebar'),",
      "  journal: b('#textchat'), zone: b('#textchat-input'),",
      "  champ: b('#textchat-input textarea'),",
      "  ligneDe: b('.vttk-chat-de-ligne'), ligneA: b('.vttk-chat-a') };"
    ].join("\n");

    const m = await driver.executeScript(MESURE);
    console.log("");
    Object.keys(m).forEach(function (k) {
      console.log("    " + k.padEnd(14) + " " + JSON.stringify(m[k]));
    });
    if (m.zone) {
      await dors(500);
      await capturePres(driver, "largeur-avec.png", m.zone.x - 12, 700, m.zone.l + 30, 380, 2);
    }
    releve("largeur-chat.json", m);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES DEUX COLONNES SONT-ELLES SUR LA MÊME LIGNE ? ----------
 *
 * La feuille disait « même grille, align-items: center » et pourtant « À : » et
 * « Envoyer » ne l'étaient pas. Deux causes empilées, dont une qu'aucune règle
 * d'alignement ne peut voir : une marge héritée, qui décale la boîte DE MARGE,
 * et un « position: relative ; top: -2px », qui ne déplace que le dessin.
 *
 * On mesure donc chaque enfant, et l'écart de leurs centres.
 */
async function aligneDuChat() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(15000);

    const MESURE = [
      "function dec(n) {",
      "  var q = n.getBoundingClientRect(), c = getComputedStyle(n);",
      "  return { quoi: (n.tagName || '?').toLowerCase() + '.' + String(n.className).slice(0, 30),",
      "    h: Math.round(q.height * 10) / 10, haut: Math.round(q.top * 10) / 10,",
      "    centre: Math.round((q.top + q.bottom) / 2 * 10) / 10,",
      "    marge: c.marginTop + ' ' + c.marginBottom,",
      "    position: c.position, decale: c.top + ' / ' + c.bottom,",
      "    aff: c.display, ligneH: c.lineHeight };",
      "}",
      "function ligne(sel) {",
      "  var n = document.querySelector(sel);",
      "  if (!n) { return null; }",
      "  var c = getComputedStyle(n), out = { items: c.alignItems, cols: c.gridTemplateColumns,",
      "    gap: c.gap, enfants: [] };",
      "  for (var i = 0; i < n.children.length; i++) { out.enfants.push(dec(n.children[i])); }",
      "  return out;",
      "}",
      "function r(s) { var n = document.querySelector(s); return n ? n.getBoundingClientRect() : null; }",
      "function e(x, y) { return (x && y) ? Math.round((y - x) * 10) / 10 : null; }",
      "var t = r('#textchat-input textarea'), d = r('.vttk-chat-de-ligne'), a = r('.vttk-chat-a');",
      "var z = r('#textchat-input');",
      "return { de: ligne('.vttk-chat-de-ligne'), a: ligne('.vttk-chat-a'),",
      "  espaces: { champVersDe: e(t && t.bottom, d && d.top),",
      "    deVersA: e(d && d.bottom, a && a.top),",
      "    hautZone: z ? Math.round(z.height) : null } };"
    ].join("\n");

    const m = await driver.executeScript(MESURE);
    ["de", "a"].forEach(function (k) {
      const L = m[k];
      if (!L) { console.log("\n  ligne « " + k + " » : absente"); return; }
      console.log("\n  ── LIGNE « " + k.toUpperCase() + " » ──   " + L.cols + "   gap " + L.gap +
        "   align " + L.items);
      const ref = L.enfants.length ? L.enfants[0].centre : 0;
      L.enfants.forEach(function (x) {
        console.log("      " + String(x.quoi).slice(0, 42).padEnd(44) +
          " h=" + String(x.h).padStart(5) + " centre=" + String(x.centre).padStart(7) +
          "  Δ=" + (Math.round((x.centre - ref) * 10) / 10));
        console.log("        marge " + x.marge + " | " + x.position + " " + x.decale +
          " | " + x.aff + " | ligne-h " + x.ligneH);
      });
    });
    console.log("\n  ── LES ESPACES ──");
    Object.keys(m.espaces || {}).forEach(function (k) {
      console.log("    " + k.padEnd(14) + " " + m.espaces[k]);
    });
    console.log("\n  ──────────────────────────────────────────────");
    ["de", "a"].forEach(function (k) {
      const L = m[k];
      if (!L || !L.enfants.length) { return; }
      const c = L.enfants.map(function (x) { return x.centre; });
      const ecart = Math.round((Math.max.apply(null, c) - Math.min.apply(null, c)) * 10) / 10;
      console.log("  ligne « " + k + " » : écart de centres " + ecart + " px  → " +
        (ecart <= 0.5 ? "ALIGNÉE" : "MAL ALIGNÉE"));
    });
    releve("aligne-chat.json", m);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QU'EST-CE QUI RECOUVRE LES JETONS HORS CARTE ? ----------
 *
 * Signalé, côté JOUEUR seulement : les jetons posés au-delà des bords de la
 * page sont sous une couche et ne se voient pas. Le MJ, lui, les voit.
 *
 * QUESTION DE FAISABILITÉ, ET RIEN D'AUTRE. On ne corrige rien : on relève ce
 * qu'est cette couche, où elle est dans l'ordre de rendu, et où les jetons y
 * sont. Sans ça, « on n'a qu'à les passer devant » est une phrase, pas une
 * réponse.
 */
async function coucheHorsCarte() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    /* CE QU'ON LIT, ET POURQUOI CHAQUE CHAMP.
     *   · la CAMÉRA, parce que c'est elle qui décide lequel des deux z est
     *     devant l'autre ; sans elle, « z = 8000000 » ne veut rien dire ;
     *   · les BOÎTES ENGLOBANTES, parce que « grand » ne suffit pas : il faut
     *     savoir si la chose couvre la page ou ce qui l'entoure ;
     *   · le GROUPE DE RENDU, seule poignée par laquelle on pourrait passer
     *     quelque chose devant sans toucher aux positions. */
    const SCENE = [
      "var S = window.MeshScene;",
      "if (!S) { return { erreur: 'pas de scene' }; }",
      "var out = { mj: !!window.is_gm, total: S.meshes.length, grands: [], jetons: [] };",
      "function boite(m) {",
      "  try {",
      "    var i = m.getBoundingInfo().boundingBox;",
      "    return { x: [Math.round(i.minimumWorld.x), Math.round(i.maximumWorld.x)],",
      "             y: [Math.round(i.minimumWorld.y), Math.round(i.maximumWorld.y)] };",
      "  } catch (e) { return null; }",
      "}",
      "function decris(m) {",
      "  var mat = m.material;",
      "  return { nom: String(m.name).slice(0, 42), groupe: m.renderingGroupId || 0,",
      "    z: m.position ? m.position.z : null, visible: m.isVisible,",
      "    materiau: mat ? String(mat.name).slice(0, 30) : null,",
      "    alpha: mat ? mat.alpha : null,",
      "    sansProfondeur: mat ? !!mat.disableDepthWrite : null,",
      "    boite: boite(m) };",
      "}",
      "var c = S.activeCamera;",
      "out.camera = c ? { nom: String(c.name),",
      "  pos: [Math.round(c.position.x), Math.round(c.position.y), Math.round(c.position.z)],",
      "  proche: c.minZ, loin: c.maxZ, mode: c.mode } : null;",
      "S.meshes.map(function (m) {",
      "  var b = boite(m), a = 0;",
      "  if (b) { a = (b.x[1] - b.x[0]) * (b.y[1] - b.y[0]); }",
      "  return { m: m, a: Math.abs(a) };",
      "}).sort(function (x, y) { return y.a - x.a; }).slice(0, 12).forEach(function (t) {",
      "  var d = decris(t.m); d.aire = Math.round(t.a); out.grands.push(d);",
      "});",
      "var g = null;",
      "try { g = window.Campaign.activePage().thegraphics.models; } catch (e) {}",
      "if (g) {",
      "  g.forEach(function (t) {",
      "    var sien = null;",
      "    for (var i = 0; i < S.meshes.length && !sien; i++) {",
      "      if (String(S.meshes[i].name || '').indexOf(t.id) >= 0) { sien = S.meshes[i]; }",
      "    }",
      "    var d = sien ? decris(sien) : { nom: '(pas de maillage)' };",
      "    d.gauche = t.get('left'); d.haut = t.get('top');",
      "    d.couche = t.get('layer'); d.aQui = t.get('controlledby');",
      "    out.jetons.push(d);",
      "  });",
      "}",
      "try {",
      "  var pg = window.Campaign.activePage();",
      "  out.page = { cases: [pg.get('width'), pg.get('height')],",
      "    pixels: [pg.get('width') * 70, pg.get('height') * 70] };",
      "} catch (e) {}",
      "return out;"
    ].join("\n");

    const r = await driver.executeScript(SCENE);
    if (r.erreur) { console.log("  " + r.erreur); return 1; }

    console.log("\n  == " + (r.mj ? "MJ" : "JOUEUR") + " ==   " + r.total + " maillages");
    console.log("  page   : " + JSON.stringify(r.page));
    console.log("  camera : " + JSON.stringify(r.camera));

    console.log("\n  -- LES DOUZE PLUS GRANDS --");
    (r.grands || []).forEach(function (c) {
      console.log("    " + String(c.nom).padEnd(38) + " g" + c.groupe +
        "  z " + String(c.z).padStart(10) + "  aire " + String(c.aire).padStart(10) +
        "  vis " + (c.visible ? "o" : "n") + "  alpha " + c.alpha);
      if (c.boite) {
        console.log("        x " + JSON.stringify(c.boite.x) + "   y " + JSON.stringify(c.boite.y));
      }
    });

    console.log("\n  -- LES JETONS --");
    (r.jetons || []).forEach(function (t) {
      console.log("    " + String(t.nom).padEnd(38) + " g" + t.groupe +
        "  z " + String(t.z).padStart(8) + "  vis " + (t.visible ? "o" : "n") +
        "  en (" + t.gauche + ", " + t.haut + ")  couche " + t.couche +
        (t.aQui ? "  a " + t.aQui : ""));
    });

    /* ---------- ON EN MET UN DEHORS, ET ON REGARDE AU BON ENDROIT ----------
     *
     * Les trois jetons de cette partie sont tous DANS la page : il n'y avait
     * rien à observer. On en déplace un au-delà du bord droit.
     *
     * DEUX PIÈGES, TOUS DEUX RENCONTRÉS :
     *
     *   · UN JETON A DEUX MAILLAGES. Celui qui porte son identifiant
     *     (« image-instance-<id> ») a un matériau d'alpha ZÉRO : c'est une
     *     doublure de détection, pas le dessin. Le sprite visible est une
     *     INSTANCE, nommée d'après le fichier image. Lire le premier et conclure
     *     « alpha 0, donc invisible » serait une erreur de lecture, pas une
     *     découverte.
     *
     *   · DÉPLACER LA CAMÉRA À LA MAIN NE MARCHE PAS ICI. On l'a essayé, la vue
     *     n'a pas suivi. On PROJETTE donc la position du jeton à l'écran avec la
     *     matrice de la caméra, et on découpe là — sans rien déplacer.
     *
     * C'est un jeu d'essai, et il est fait pour ça. Le jeton est remis en place
     * à la fin.
     */
    const dehors = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "if (!g || !g.length) { return 'pas de jeton'; }",
      "var t = g[0];",
      "var avant = { gauche: t.get('left'), haut: t.get('top') };",
      "/* DEHORS, MAIS DANS LA VUE — et il a fallu deux essais pour comprendre",
      "   qu'il fallait les deux. Posé au-dela du bord droit, le jeton se",
      "   retrouvait hors du cadre de la camera : on photographiait une zone ou il",
      "   n'y avait rien a voir, et l'on aurait pu conclure qu'il etait masque.",
      "   La page occupe x de 0 a 1750 et y de -1750 a 0 ; le coin oppose a",
      "   l'origine — x negatif, y positif — est donc HORS PAGE, et il est sous les",
      "   yeux quand la camera est au centre. */",
      "t.save({ left: -210, top: -210 });",
      "return { id: t.id, avant: avant, vers: -210 };"
    ].join("\n"));
    console.log("\n  -- UN JETON DEHORS --   " + JSON.stringify(dehors));
    await dors(3500);

    const vu = await driver.executeScript([
      "var S = window.MeshScene, B = window.BABYLON;",
      "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
      "/* TOUS ses maillages, la doublure comme le sprite. */",
      "var siens = [];",
      "S.meshes.forEach(function (m) {",
      "  var n = String(m.name || '');",
      "  var q = null;",
      "  try { var i = m.getBoundingInfo().boundingBox;",
      "    q = { x: [Math.round(i.minimumWorld.x), Math.round(i.maximumWorld.x)],",
      "          y: [Math.round(i.minimumWorld.y), Math.round(i.maximumWorld.y)] }; } catch (e) {}",
      "  if (n.indexOf(t.id) >= 0) { siens.push({ role: 'doublure', nom: n.slice(0, 40), m: m, boite: q }); return; }",
      "  /* Le sprite : une instance dont la boite tombe sur celle du jeton. */",
      "  if (!q) { return; }",
      "  var cx = (q.x[0] + q.x[1]) / 2, cy = (q.y[0] + q.y[1]) / 2;",
      "  if (Math.abs(cx - t.get('left')) < 6 && Math.abs(cy + t.get('top')) < 6) {",
      "    siens.push({ role: 'sprite', nom: n.slice(0, 40), m: m, boite: q });",
      "  }",
      "});",
      "var out = { jeton: { gauche: t.get('left'), haut: t.get('top') }, maillages: [] };",
      "siens.forEach(function (s) {",
      "  var m = s.m, mat = m.material;",
      "  out.maillages.push({ role: s.role, nom: s.nom, boite: s.boite,",
      "    visible: m.isVisible, actif: m.isEnabled ? m.isEnabled() : null,",
      "    visibilite: m.visibility, groupe: m.renderingGroupId || 0,",
      "    z: m.position ? m.position.z : null,",
      "    alpha: mat ? mat.alpha : null, materiau: mat ? String(mat.name).slice(0, 28) : null });",
      "});",
      "/* OÙ EST-IL À L'ÉCRAN ? ON PROJETTE À LA MAIN.",
      "   Babylon n'est pas une variable globale de cette page — « BABYLON » y est",
      "   indéfini —, et l'on n'a pas besoin de lui : la caméra est ORTHOGRAPHIQUE,",
      "   donc la projection est une règle de trois. Quatre nombres qu'elle porte",
      "   elle-même, et la taille de la toile. */",
      "try {",
      "  var c = S.activeCamera;",
      "  var toile = document.getElementById('babylonCanvas');",
      "  var q = toile.getBoundingClientRect();",
      "  var lx = c.orthoRight - c.orthoLeft, ly = c.orthoTop - c.orthoBottom;",
      "  var wx = t.get('left') - c.position.x, wy = -t.get('top') - c.position.y;",
      "  out.cadre = { gauche: c.orthoLeft, droite: c.orthoRight, haut: c.orthoTop, bas: c.orthoBottom,",
      "    cam: [Math.round(c.position.x), Math.round(c.position.y)] };",
      "  out.dansLeCadre = (wx >= c.orthoLeft && wx <= c.orthoRight && wy >= c.orthoBottom && wy <= c.orthoTop);",
      "  out.ecran = { x: Math.round(q.left + (wx - c.orthoLeft) / lx * q.width),",
      "                y: Math.round(q.top + (c.orthoTop - wy) / ly * q.height) };",
      "} catch (e) { out.ecran = { erreur: String(e).slice(0, 60) }; }",
      "return out;"
    ].join("\n"));

    console.log("    jeton en (" + vu.jeton.gauche + ", " + vu.jeton.haut + ")   ecran " + JSON.stringify(vu.ecran));
    console.log("    cadre de la camera : " + JSON.stringify(vu.cadre) + "   le jeton y est : " + vu.dansLeCadre);
    (vu.maillages || []).forEach(function (m) {
      console.log("      " + m.role.padEnd(9) + " " + String(m.nom).padEnd(38) +
        " vis " + (m.visible ? "o" : "n") + "  actif " + m.actif +
        "  visibilite " + m.visibilite + "  alpha " + m.alpha + "  g" + m.groupe +
        "  z " + m.z);
      if (m.boite) { console.log("                  boite x " + JSON.stringify(m.boite.x) + " y " + JSON.stringify(m.boite.y)); }
    });

    /* ---------- POURQUOI N'EST-IL PAS PEINT ? ----------
     *
     * Le sprite est marqué visible, opacité 1, à la bonne place, et rien n'est
     * dessiné là. Ce n'est donc ni un z-order ni une couche par-dessus : il est
     * ÉCARTÉ DU RENDU. Trois mécanismes peuvent le faire, et ils n'ont pas du
     * tout le même coût si l'on voulait y toucher :
     *
     *   · un PLAN DE COUPE de la scène — on le lirait, et on pourrait
     *     l'élargir ;
     *   · un MASQUE DE COUCHE qui ne croise pas celui de la caméra ;
     *   · une exclusion du LOT ACTIF, c'est-à-dire un tri fait à chaque image —
     *     le plus cher à contrarier, puisqu'il faudrait le refaire soixante fois
     *     par seconde.
     */
    const pourquoi = await driver.executeScript([
      "var S = window.MeshScene;",
      "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
      "var sprite = null;",
      "S.meshes.forEach(function (m) {",
      "  var q = null;",
      "  try { var i = m.getBoundingInfo().boundingBox;",
      "    q = { cx: (i.minimumWorld.x + i.maximumWorld.x) / 2,",
      "          cy: (i.minimumWorld.y + i.maximumWorld.y) / 2 }; } catch (e) { return; }",
      "  if (Math.abs(q.cx - t.get('left')) < 6 && Math.abs(q.cy + t.get('top')) < 6 &&",
      "      String(m.name || '').indexOf(t.id) < 0) { sprite = m; }",
      "});",
      "if (!sprite) { return { erreur: 'sprite introuvable' }; }",
      "var out = {};",
      "out.plansDeCoupe = {};",
      "['clipPlane','clipPlane2','clipPlane3','clipPlane4','clipPlane5','clipPlane6'].forEach(function (k) {",
      "  var v = S[k];",
      "  out.plansDeCoupe[k] = v ? { a: v.a, b: v.b, c: v.c, d: v.d } : null;",
      "});",
      "out.masque = { mesh: sprite.layerMask, camera: S.activeCamera.layerMask };",
      "out.source = sprite.sourceMesh ? String(sprite.sourceMesh.name).slice(0, 40) : null;",
      "out.tampons = sprite.instancedBuffers ? Object.keys(sprite.instancedBuffers) : null;",
      "if (sprite.instancedBuffers) {",
      "  out.valeurs = {};",
      "  Object.keys(sprite.instancedBuffers).forEach(function (k) {",
      "    var v = sprite.instancedBuffers[k];",
      "    out.valeurs[k] = (v && v.asArray) ? v.asArray() : v;",
      "  });",
      "}",
      "/* EST-IL DANS LE LOT ACTIF DE L'IMAGE ? C'est la question decisive. */",
      "try {",
      "  var actifs = S.getActiveMeshes();",
      "  var dedans = false;",
      "  for (var i = 0; i < actifs.length; i++) { if (actifs.data[i] === sprite) { dedans = true; } }",
      "  out.dansLeLotActif = dedans;",
      "  out.tailleDuLot = actifs.length;",
      "} catch (e) { out.dansLeLotActif = 'erreur : ' + String(e).slice(0, 40); }",
      "out.culling = { alwaysActive: sprite.alwaysSelectAsActiveMesh,",
      "  frozen: sprite.isWorldMatrixFrozen, occlusion: sprite.occlusionType };",
      "return out;"
    ].join("\n"));
    console.log("\n-- POURQUOI N'EST-IL PAS PEINT ? --");
    console.log("    " + JSON.stringify(pourquoi, null, 2).split(String.fromCharCode(10)).join(String.fromCharCode(10) + "    "));

    /* ---------- L'EXPÉRIENCE DÉCISIVE ----------
     *
     * « u_Board: [1750, 1750, 0, 1] » — la taille de la page, plus un nombre.
     * Si c'est bien lui qui commande la coupe, le changer doit faire apparaître
     * le jeton. On essaie les deux lectures possibles du quatrieme nombre :
     * un DRAPEAU qu'on baisse, ou une taille qu'on agrandit.
     *
     * On ne touche à rien de persistant : ces tampons sont recalculés par
     * Roll20 à la première synchronisation. Rien n'est écrit dans la campagne.
     */
    async function essaieBoard(quoi, code) {
      await driver.executeScript([
        "var S = window.MeshScene;",
        "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
        "var sp = null;",
        "S.meshes.forEach(function (m) {",
        "  try { var i = m.getBoundingInfo().boundingBox;",
        "    var cx = (i.minimumWorld.x + i.maximumWorld.x) / 2;",
        "    var cy = (i.minimumWorld.y + i.maximumWorld.y) / 2;",
        "    if (Math.abs(cx - t.get('left')) < 6 && Math.abs(cy + t.get('top')) < 6 &&",
        "        String(m.name || '').indexOf(t.id) < 0) { sp = m; }",
        "  } catch (e) {}",
        "});",
        "if (!sp || !sp.instancedBuffers || !sp.instancedBuffers.u_Board) { return 'pas de tampon'; }",
        "var b = sp.instancedBuffers.u_Board;",
        arguments[1],
        "return [b.x, b.y, b.z, b.w];"
      ].join(String.fromCharCode(10)));
      await dors(1200);
      const etat = await driver.executeScript([
        "var S = window.MeshScene;",
        "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
        "var sp = null;",
        "S.meshes.forEach(function (m) {",
        "  try { var i = m.getBoundingInfo().boundingBox;",
        "    var cx = (i.minimumWorld.x + i.maximumWorld.x) / 2;",
        "    var cy = (i.minimumWorld.y + i.maximumWorld.y) / 2;",
        "    if (Math.abs(cx - t.get('left')) < 6 && Math.abs(cy + t.get('top')) < 6 &&",
        "        String(m.name || '').indexOf(t.id) < 0) { sp = m; }",
        "  } catch (e) {}",
        "});",
        "if (!sp || !sp.instancedBuffers || !sp.instancedBuffers.u_Board) { return 'pas de tampon'; }",
        "var b = sp.instancedBuffers.u_Board;",
        "return [b.x, b.y, b.z, b.w];"
      ].join(String.fromCharCode(10)));
      if (vu.ecran && !vu.ecran.erreur) {
        await capturePres(driver, "board-" + quoi + "-" + quelle + ".png",
          Math.max(0, vu.ecran.x - 90), Math.max(0, vu.ecran.y - 90), 180, 180, 4);
      }
      return etat;
    }

    /* LE TROISIÈME NOMBRE, ET PAS LE QUATRIÈME. Relevé des deux côtés :
     *     joueur : u_Board = [1750, 1750, 0, 1]
     *     MJ     : u_Board = [1540, 2202, 1, 1]
     * La page change, le quatrième ne bouge pas, et le TROISIÈME vaut 1 chez
     * celui qui voit hors plateau. Le premier essai avait changé le quatrième —
     * il ne pouvait rien donner. */
    console.log("    z = 1 : " + JSON.stringify(await essaieBoard("z", "b.z = 1;")));

    /* ---------- ET SI ON LE METTAIT CARRÉMENT DEVANT ? ----------
     *
     * « Passer les jetons dessus » a été écartée comme sans objet : rien ne les
     * recouvre, donc les avancer ne peut rien changer. C'est une DÉDUCTION, et
     * une déduction n'est pas une mesure. On la met à l'épreuve de la façon la
     * plus brutale qui soit — le sprite passe dans le groupe de rendu le plus
     * en avant, celui que Babylon dessine en dernier, par-dessus tout le reste.
     *
     * S'il n'apparaît toujours pas, la question est close : ce n'est pas une
     * affaire d'ordre. */
    const devant = await driver.executeScript([
      "var S = window.MeshScene;",
      "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
      "var sp = null;",
      "S.meshes.forEach(function (m) {",
      "  try { var i = m.getBoundingInfo().boundingBox;",
      "    var cx = (i.minimumWorld.x + i.maximumWorld.x) / 2;",
      "    var cy = (i.minimumWorld.y + i.maximumWorld.y) / 2;",
      "    if (Math.abs(cx - t.get('left')) < 6 && Math.abs(cy + t.get('top')) < 6 &&",
      "        String(m.name || '').indexOf(t.id) < 0) { sp = m; }",
      "  } catch (e) {}",
      "});",
      "if (!sp) { return 'sprite introuvable'; }",
      "sp.renderingGroupId = 3;",
      "if (sp.position) { sp.position.z = 90000000; }",
      "if (sp.material) { sp.material.disableDepthWrite = true; sp.material.zOffset = -1000; }",
      "sp.alwaysSelectAsActiveMesh = true;",
      "return { groupe: sp.renderingGroupId, z: sp.position ? sp.position.z : null,",
      "  visible: sp.isVisible, visibilite: sp.visibility };"
    ].join(String.fromCharCode(10)));
    console.log("    poussé devant : " + JSON.stringify(devant));
    await dors(1500);
    if (vu.ecran && !vu.ecran.erreur) {
      await capturePres(driver, "devant-" + quelle + ".png",
        Math.max(0, vu.ecran.x - 90), Math.max(0, vu.ecran.y - 90), 180, 180, 4);
    }

    /* ---------- ET UNE COUCHE HTML ? ----------
     * Un élément posé PAR-DESSUS la toile expliquerait aussi bien le symptôme,
     * et ne se verrait dans aucun relevé de la scène. On demande au document ce
     * qu'il y a sous le point où le jeton devrait être. */
    if (vu.ecran && !vu.ecran.erreur) {
      const dessus = await driver.executeScript([
        "var n = document.elementsFromPoint(arguments[0], arguments[1]);",
        "return n.slice(0, 6).map(function (e) {",
        "  var c = getComputedStyle(e);",
        "  return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +",
        "    (e.className ? '.' + String(e.className).slice(0, 24) : '') +",
        "    '  fond ' + c.backgroundColor + '  opacite ' + c.opacity;",
        "});"
      ].join(String.fromCharCode(10)), vu.ecran.x, vu.ecran.y);
      console.log("    ce qu'il y a a l'ecran, du dessus vers le dessous :");
      (dessus || []).forEach(function (x) { console.log("      " + x); });
    }

    if (vu.ecran && !vu.ecran.erreur) {
      await capturePres(driver, "jeton-dehors-" + quelle + ".png",
        Math.max(0, vu.ecran.x - 130), Math.max(0, vu.ecran.y - 130), 260, 260, 3);
    }

    /* ON LE REMET OÙ IL ÉTAIT. Un jeu d'essai reste un jeu : on n'y laisse pas
     * un personnage à deux mille pixels du plateau. */
    if (dehors && dehors.avant) {
      await driver.executeScript([
        "var g = window.Campaign.activePage().thegraphics.models;",
        "g[0].save({ left: arguments[0], top: arguments[1] });"
      ].join("\n"), dehors.avant.gauche, dehors.avant.haut);
      console.log("    jeton remis en (" + dehors.avant.gauche + ", " + dehors.avant.haut + ")");
    }

    releve("couche-" + quelle + ".json", r);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE COÛTERAIT LA VOIE 2 ----------
 *
 * Question posée : « la voie 2 ne risque-t-elle pas de faire laguer ? » — la
 * voie 2 étant de forcer le paramètre de nuanceur qui fait disparaître les
 * jetons hors page, côté joueur.
 *
 * ON N'Y RÉPOND PAS DE TÊTE. Le précédent est net : un abonnement Pinia qui
 * paraissait gratuit coûtait 555 ms par mutation, avec un rappel vide. Ce qui
 * paraît bon marché dans ce moteur ne l'est pas forcément.
 *
 * TROIS MESURES, ET ELLES SUFFISENT À TRANCHER :
 *
 *   A. COMBIEN DE TEMPS NOTRE ÉCRITURE SURVIT-ELLE ? C'est elle qui décide de
 *      tout. Si Roll20 la réécrit à chaque image, il faudrait la reposer
 *      soixante fois par seconde ; s'il ne la touche qu'à la synchronisation
 *      d'un jeton, une écriture par événement suffit. Entre les deux, il y a
 *      trois ordres de grandeur.
 *
 *   B. QUE COÛTE UNE PASSE D'ÉCRITURE ? On la répète à chaque image sur tous les
 *      jetons de la page, et on mesure la gigue d'une minuterie — l'instrument
 *      qui a déjà servi pour le zoom. Le témoin est la même fenêtre, sans
 *      écriture.
 *
 *   C. COMBIEN DE JETONS ? Le coût est par instance : une page de cinq jetons
 *      et une page de cent ne disent pas la même chose.
 */
async function coutDeLaVoie2() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    /* L'outillage : retrouver les sprites, et le chronomètre de gigue. */
    const OUTILS = [
      "window.__v2 = {};",
      "window.__v2.sprites = function () {",
      "  var S = window.MeshScene, out = [];",
      "  if (!S) { return out; }",
      "  S.meshes.forEach(function (m) {",
      "    if (m.instancedBuffers && m.instancedBuffers.u_Board) { out.push(m); }",
      "  });",
      "  return out;",
      "};",
      "window.__v2.chrono = function (ms) {",
      "  return new Promise(function (res) {",
      "    var g = [], att = performance.now() + 20;",
      "    var t = setInterval(function () {",
      "      var n = performance.now(); g.push(n - att); att = n + 20;",
      "    }, 20);",
      "    setTimeout(function () {",
      "      clearInterval(t);",
      "      var d = g.slice().sort(function (a, b) { return a - b; });",
      "      var bl = g.filter(function (x) { return x > 40; });",
      "      res({ p95: Math.round(d[Math.floor(d.length * 0.95)] * 10) / 10,",
      "        pire: Math.round(Math.max.apply(null, g.concat([0]))),",
      "        blocages: bl.length,",
      "        ms: Math.round(bl.reduce(function (a, b) { return a + b; }, 0)) });",
      "    }, ms);",
      "  });",
      "};",
      "return window.__v2.sprites().length;"
    ].join("\n");
    const combien = await driver.executeScript(OUTILS);
    console.log("\n  sprites porteurs de u_Board : " + combien);

    /* ---------- POURQUOI L'ÉCRITURE NE PREND-ELLE PAS ? ----------
     *
     * On écrit u_Board.z = 1, la valeur reste — mesuré, elle survit même à un
     * déplacement de jeton — et l'image ne change pas. Trois explications
     * possibles, et elles se distinguent :
     *
     *   1. LE TAMPON N'EST PAS RETÉLÉVERSÉ. Babylon garde les attributs
     *      d'instance dans un tableau typé qu'il reconstruit avant chaque rendu
     *      seulement si on le lui demande. Écrire l'objet Vector4 sans marquer
     *      quoi que ce soit ne toucherait alors jamais le GPU.
     *   2. LE NUANCEUR NE LIT PAS CET ATTRIBUT pour décider de la coupe : le nom
     *      « u_Board » nous a mis sur une piste, la piste peut être fausse.
     *   3. LA COUPE EST AILLEURS — un uniforme du matériau, une définition de
     *      compilation, ou un tri fait avant même le rendu.
     *
     * On les sépare : on regarde ce que Babylon garde vraiment (le tableau
     * typé), ce que le matériau porte comme uniformes et comme définitions, et
     * la source GLSL si elle est lisible.
     */
    const pourquoiRien = await driver.executeScript([
      "var S = window.MeshScene;",
      "var sp = window.__v2 && window.__v2.sprites ? window.__v2.sprites() : [];",
      "if (!sp.length) { return { erreur: 'pas de sprite' }; }",
      "var m = sp[0], src = m.sourceMesh || m;",
      "var out = { source: String(src.name).slice(0, 44) };",
      "/* 1. Ce que Babylon garde pour cet attribut, cote source. */",
      "try {",
      "  var ib = src.instancedBuffers ? Object.keys(src.instancedBuffers) : null;",
      "  out.sourceTampons = ib;",
      "  var mgr = src._instanceDataStorage;",
      "  out.stockage = mgr ? {",
      "    instances: mgr.instancesCount,",
      "    tamponsUtilisateur: mgr.instancesData ? 'oui' : 'non',",
      "    fige: !!mgr.isFrozen",
      "  } : null;",
      "  var ub = src._userInstancedBuffersStorage;",
      "  out.tamponUtilisateur = ub ? {",
      "    attributs: ub.vertexArrayObjects ? 'vao' : null,",
      "    tampons: ub.data ? Object.keys(ub.data) : null,",
      "    tailles: ub.strides ? ub.strides : null,",
      "    tamponsVB: ub.vertexBuffers ? Object.keys(ub.vertexBuffers) : null",
      "  } : null;",
      "  if (ub && ub.data && ub.data.u_Board) {",
      "    var d = ub.data.u_Board;",
      "    out.premieresValeurs = [].slice.call(d, 0, 16);",
      "  }",
      "} catch (e) { out.erreurStockage = String(e).slice(0, 80); }",
      "/* 2. Ce que le materiau porte. */",
      "try {",
      "  var mat = src.material;",
      "  out.materiau = mat ? { nom: String(mat.name).slice(0, 40),",
      "    classe: mat.getClassName ? mat.getClassName() : null } : null;",
      "  if (mat && mat.getEffect && mat.getEffect()) {",
      "    var eff = mat.getEffect();",
      "    out.effet = { defines: String(eff.defines || '').split('\\n').filter(Boolean).slice(0, 24) };",
      "    out.attributs = eff._attributeNames || eff.attributes || null;",
      "    out.uniformes = eff._uniformsNames ? eff._uniformsNames.slice(0, 40) : null;",
      "  }",
      "  if (mat && mat.getAlphaTestTexture) { out.alphaTest = !!mat.getAlphaTestTexture(); }",
      "} catch (e) { out.erreurMateriau = String(e).slice(0, 80); }",
      "/* 3. La source GLSL, si Babylon la garde. */",
      "try {",
      "  var mat2 = src.material, eff2 = mat2 && mat2.getEffect ? mat2.getEffect() : null;",
      "  if (eff2) {",
      "    var f = eff2._fragmentSourceCode || eff2.fragmentSourceCode || '';",
      "    out.glslLongueur = f.length;",
      "    /* On ne remonte que les lignes qui parlent du plateau : le reste est",
      "       du bruit, et une source entiere ne tient pas dans un releve. */",
      "    out.glslPlateau = String(f).split('\\n')",
      "      .filter(function (l) { return /board|discard|clip|bound/i.test(l); })",
      "      .slice(0, 24);",
      "  }",
      "} catch (e) { out.erreurGlsl = String(e).slice(0, 80); }",
      "return out;"
    ].join("\n"));
    console.log("\n  -- POURQUOI L'ÉCRITURE NE PREND PAS --");
    console.log("    " + JSON.stringify(pourquoiRien, null, 2)
      .split(String.fromCharCode(10)).join(String.fromCharCode(10) + "    "));

    /* ---------- A. COMBIEN DE TEMPS L'ÉCRITURE SURVIT-ELLE ? ---------- */
    console.log("\n  -- A. DURÉE DE VIE D'UNE ÉCRITURE --");
    const survie = await driver.executeAsyncScript([
      "var cb = arguments[arguments.length - 1];",
      "var sp = window.__v2.sprites();",
      "if (!sp.length) { cb('pas de sprite'); return; }",
      "/* On marque TOUS les sprites d'une valeur qui ne peut venir que de nous. */",
      "sp.forEach(function (m) { m.instancedBuffers.u_Board.z = 7; });",
      "var t0 = performance.now(), releves = [];",
      "function relis() {",
      "  var s = window.__v2.sprites();",
      "  var restants = 0;",
      "  s.forEach(function (m) { if (m.instancedBuffers.u_Board.z === 7) { restants++; } });",
      "  releves.push({ ms: Math.round(performance.now() - t0), sur: s.length, marques: restants });",
      "}",
      "[0, 100, 500, 1500, 4000].forEach(function (d) { setTimeout(relis, d); });",
      "setTimeout(function () { cb(releves); }, 4600);"
    ].join("\n"));
    (survie || []).forEach(function (x) {
      console.log("    à " + String(x.ms).padStart(5) + " ms : " + x.marques + " marqués sur " + x.sur);
    });

    /* Et après un geste : déplacer un jeton force Roll20 à resynchroniser. */
    const apresGeste = await driver.executeAsyncScript([
      "var cb = arguments[arguments.length - 1];",
      "var sp = window.__v2.sprites();",
      "sp.forEach(function (m) { m.instancedBuffers.u_Board.z = 7; });",
      "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
      "var avant = { left: t.get('left'), top: t.get('top') };",
      "t.save({ left: avant.left + 70 });",
      "setTimeout(function () {",
      "  var s = window.__v2.sprites(), restants = 0;",
      "  s.forEach(function (m) { if (m.instancedBuffers.u_Board.z === 7) { restants++; } });",
      "  t.save({ left: avant.left });",
      "  cb({ sur: s.length, marques: restants });",
      "}, 2000);"
    ].join("\n"));
    console.log("    après avoir déplacé un jeton : " +
      apresGeste.marques + " marqués sur " + apresGeste.sur);

    /* ---------- LE CONTRÔLE DE L'INSTRUMENT, QU'ON AURAIT DÛ FAIRE D'ABORD ----------
     *
     * Toutes les conclusions de cette sonde reposent sur une projection écran
     * calculée à la main. Elle n'avait JAMAIS été contrôlée — et un premier
     * essai de contrôle a échoué faute de sujet : la caméra est parquée sur le
     * COIN de la page, et aucun des trois jetons n'y est.
     *
     * On prend donc UN SEUL jeton et on le photographie à DEUX endroits, avec
     * le même calcul : d'abord dedans, où il doit se voir, puis dehors. Une
     * seule chose change entre les deux images, et c'est elle qu'on accuse.
     */
    async function ouEst(x, y) {
      return await driver.executeScript([
        "var S = window.MeshScene, c = S.activeCamera;",
        "var toile = document.getElementById('babylonCanvas');",
        "var q = toile.getBoundingClientRect();",
        "var lx = c.orthoRight - c.orthoLeft, ly = c.orthoTop - c.orthoBottom;",
        "var wx = arguments[0] - c.position.x, wy = -arguments[1] - c.position.y;",
        "return { x: Math.round(q.left + (wx - c.orthoLeft) / lx * q.width),",
        "         y: Math.round(q.top + (c.orthoTop - wy) / ly * q.height),",
        "         dansLeCadre: (wx >= c.orthoLeft && wx <= c.orthoRight && wy >= c.orthoBottom && wy <= c.orthoTop) };"
      ].join(String.fromCharCode(10)), x, y);
    }

    const dejaLa = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "if (!g || !g.length) { return null; }",
      "return { left: g[0].get('left'), top: g[0].get('top') };"
    ].join(String.fromCharCode(10)));

    async function poseEtPhotographie(nom, x, y, dit) {
      await driver.executeScript([
        "var g = window.Campaign.activePage().thegraphics.models;",
        "g[0].save({ left: arguments[0], top: arguments[1] });"
      ].join(String.fromCharCode(10)), x, y);
      await dors(2600);
      const e = await ouEst(x, y);
      console.log("    " + dit.padEnd(30) + " (" + x + ", " + y + ")  écran (" +
        e.x + ", " + e.y + ")  dans le cadre : " + e.dansLeCadre);
      /* ON PHOTOGRAPHIE LA TOILE ENTIÈRE, ET PAS UN CADRAGE CALCULÉ.
       *
       * La projection écran maison a ÉCHOUÉ À SON PROPRE CONTRÔLE : cadrée sur
       * un jeton qui est DANS la page — donc certainement dessiné —, elle ne
       * montrait qu'un éclat sombre au bord, soit quatre-vingt-dix pixels à
       * côté. Probablement le rapport de pixels de l'écran, que le calcul
       * ignore.
       *
       * Toutes les conclusions « rien n'est peint » tirées de ces cadrages
       * étaient donc sans valeur. Un instrument qui échoue à son témoin ne se
       * répare pas, il se remplace : la toile entière ne peut pas rater ce
       * qu'elle contient. */
      const toile = await driver.executeScript(
        "var n = document.getElementById('babylonCanvas');" +
        "if (!n) { return null; }" +
        "var q = n.getBoundingClientRect();" +
        "return { x: Math.round(q.left), y: Math.round(q.top)," +
        "  l: Math.round(q.width), h: Math.round(q.height) };");
      if (toile) {
        await capturePres(driver, nom + "-" + quelle + ".png",
          toile.x, toile.y, toile.l, toile.h, 1);
      }
      return e;
    }

    console.log(String.fromCharCode(10) + "  -- CONTRÔLE : LE MÊME JETON, DEDANS PUIS DEHORS --");
    await poseEtPhotographie("controle-dedans", 210, 210, "DANS la page");
    const ou = await poseEtPhotographie("controle-dehors", -210, -210, "HORS de la page");

    /* ---------- LE VRAI LEVIER : LE TABLEAU, PAS L'OBJET ----------
     *
     * Le nuanceur de Roll20, lu dans sa source :
     *
     *     offBoard = vPositionW.x < 0. || vPositionW.x > v_Board.x
     *             || vPositionW.y > 0. || vPositionW.y < -v_Board.y;
     *     if (offBoard && v_Board.z == 0.) { discard; }
     *
     * C'est donc bien le TROISIÈME nombre qui commande, et zéro veut dire
     * « jette ». Mais écrire dans mesh.instancedBuffers.u_Board ne sert à rien :
     * relevé, l'objet garde notre valeur pendant que le TABLEAU TYPÉ réellement
     * téléversé garde 0. Roll20 remplit ce tableau lui-même, sans passer par
     * l'objet que Babylon expose.
     *
     * On écrit donc dans le tableau, un flottant sur quatre, et on demande le
     * téléversement.
     */
    const levier = await driver.executeScript([
      "var sp = window.__v2.sprites();",
      "if (!sp.length) { return 'pas de sprite'; }",
      "/* TOUS LES GROUPES, ET PAS LE PREMIER. Roll20 range ses instances par",
      "   atlas de textures : il peut y avoir plusieurs maillages sources, chacun",
      "   avec son tableau. N'en corriger qu'un laisse les autres jeter. */",
      "var sources = [], vus = [];",
      "sp.forEach(function (m) {",
      "  var src = m.sourceMesh || m;",
      "  if (vus.indexOf(src) < 0) { vus.push(src); sources.push(src); }",
      "});",
      "var out = { groupes: [], total: 0 };",
      "sources.forEach(function (src) {",
      "  var st = src._userInstancedBuffersStorage;",
      "  if (!st || !st.data || !st.data.u_Board) {",
      "    out.groupes.push({ nom: String(src.name).slice(0, 34), tableau: 'absent' }); return; }",
      "  var d = st.data.u_Board, n = 0;",
      "  for (var i = 2; i < d.length; i += 4) { if (d[i] !== 1) { d[i] = 1; n++; } }",
      "  var pousse = 'non';",
      "  try {",
      "    var vb = st.vertexBuffers && st.vertexBuffers.u_Board;",
      "    if (vb && vb.updateDirectly) { vb.updateDirectly(d, 0); pousse = 'updateDirectly'; }",
      "  } catch (e) { pousse = 'erreur'; }",
      "  /* Et l'objet exposé, au cas où c'est LUI que Babylon recopie. */",
      "  try { if (src.instancedBuffers && src.instancedBuffers.u_Board) { src.instancedBuffers.u_Board.z = 1; } } catch (e) {}",
      "  out.total += n;",
      "  out.groupes.push({ nom: String(src.name).slice(0, 34), corriges: n,",
      "    longueur: d.length, pousse: pousse });",
      "});",
      "/* Et sur CHAQUE instance aussi : deux chemins valent mieux qu'un quand on",
      "   ne sait pas lequel Babylon lit. */",
      "sp.forEach(function (m) {",
      "  try { if (m.instancedBuffers && m.instancedBuffers.u_Board) { m.instancedBuffers.u_Board.z = 1; } } catch (e) {}",
      "});",
      "return out;"
    ].join("\n"));
    console.log("\n  -- LE VRAI LEVIER --");
    console.log("    " + JSON.stringify(levier));
    await dors(1500);
    if (ou && ou.dansLeCadre) {
      await capturePres(driver, "levier-" + quelle + ".png",
        Math.max(0, ou.x - 90), Math.max(0, ou.y - 90), 180, 180, 4);
    }

    /* ---------- L'AUTRE LEVIER : scene.metadata ----------
     *
     * Une relecture du bundle de Roll20 — retrouvé dans le cache de Firefox et
     * détendu — a montré deux implémentations de la coupe hors plateau :
     *
     *   · l'attribut d'instance « u_Board », celui qu'on a essayé trois fois ;
     *   · un « OffBoardMaterialPlugin » qui, lui, ne lit PAS l'attribut : il
     *     relie des uniformes « u_GMMode » et « u_BoardSize » À CHAQUE LIAISON,
     *     depuis « scene.metadata », sur un matériau gelé.
     *
     * Si c'est le second qui commande, écrire dans le tampon d'instance ne peut
     * évidemment rien donner — et le vrai levier est UN champ, lu à chaque
     * image par Roll20 lui-même. Ce serait le meilleur des cas pour la question
     * du coût : rien à réécrire, rien à surveiller, une affectation.
     *
     * On regarde d'abord ce que metadata porte, puis on bascule.
     */
    const meta = await driver.executeScript([
      "var S = window.MeshScene;",
      "if (!S) { return 'pas de scene'; }",
      "var m = S.metadata;",
      "if (!m) { return 'pas de metadata'; }",
      "var out = { cles: Object.keys(m).slice(0, 40), valeurs: {} };",
      "['gmMode','boardWidth','boardHeight','previewAsPlayer','isGM'].forEach(function (k) {",
      "  if (k in m) { out.valeurs[k] = m[k]; }",
      "});",
      "return out;"
    ].join("\n"));
    console.log("\n  -- scene.metadata --");
    console.log("    " + JSON.stringify(meta));

    const bascule = await driver.executeScript([
      "var S = window.MeshScene;",
      "if (!S || !S.metadata) { return 'pas de metadata'; }",
      "var avant = S.metadata.gmMode;",
      "S.metadata.gmMode = true;",
      "return { avant: avant, apres: S.metadata.gmMode };"
    ].join("\n"));
    console.log("    bascule gmMode : " + JSON.stringify(bascule));
    await dors(2000);
    if (ou && ou.dansLeCadre) {
      await capturePres(driver, "metadata-" + quelle + ".png",
        Math.max(0, ou.x - 90), Math.max(0, ou.y - 90), 180, 180, 4);
    }

    /* ---------- LE MATÉRIAU EST GELÉ, ET C'EST PEUT-ÊTRE TOUT LE PROBLÈME ----------
     *
     * La relecture du bundle signale « material.freeze() » sur le greffon hors
     * plateau. Un matériau gelé ne relie plus ses uniformes : changer
     * scene.metadata ne peut alors RIEN produire, puisque personne ne va relire
     * metadata. On dégèle, et on refait passer les trois leviers ensemble —
     * metadata, l'attribut d'instance, et le dégel. Si rien ne bouge après ça,
     * la voie 2 n'est pas seulement fragile : elle est fermée. */
    const degel = await driver.executeScript([
      "var S = window.MeshScene;",
      "var n = 0, noms = [];",
      "S.materials.forEach(function (m) {",
      "  try {",
      "    if (m.isFrozen) { m.unfreeze(); n++; noms.push(String(m.name).slice(0, 24)); }",
      "  } catch (e) {}",
      "});",
      "S.metadata.gmMode = true;",
      "/* Et l'attribut, une fois de plus, maintenant que le materiau peut relire. */",
      "var sp = window.__v2.sprites(), vus = [];",
      "sp.forEach(function (m) {",
      "  var src = m.sourceMesh || m;",
      "  if (vus.indexOf(src) >= 0) { return; }",
      "  vus.push(src);",
      "  var st = src._userInstancedBuffersStorage;",
      "  if (!st || !st.data || !st.data.u_Board) { return; }",
      "  var d = st.data.u_Board;",
      "  for (var i = 0; i < d.length; i += 4) { d[i + 2] = 1; d[i + 3] = 0; }",
      "  try { st.vertexBuffers.u_Board.updateDirectly(d, 0); } catch (e) {}",
      "});",
      "sp.forEach(function (m) {",
      "  try { if (m.instancedBuffers && m.instancedBuffers.u_Board) {",
      "    m.instancedBuffers.u_Board.z = 1; m.instancedBuffers.u_Board.w = 0; } } catch (e) {}",
      "});",
      "return { degeles: n, noms: noms, materiaux: S.materials.length, sources: vus.length };"
    ].join(String.fromCharCode(10)));
    console.log("    dégel + tout : " + JSON.stringify(degel));
    await dors(2500);
    if (ou && ou.dansLeCadre) {
      await capturePres(driver, "degel-" + quelle + ".png",
        Math.max(0, ou.x - 90), Math.max(0, ou.y - 90), 180, 180, 4);
    }

    /* ET CE QUE ÇA COÛTE : la scène relie ces uniformes à chaque liaison de
     * sous-maillage, que l'on touche à quoi que ce soit ou non. Notre part se
     * réduit donc à une affectation, une fois. On mesure quand même la fenêtre
     * qui suit, pour ne rien affirmer sans chiffre. */
    const apresBascule = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1]; window.__v2.chrono(5000).then(cb);");
    console.log("    gigue après bascule : " + JSON.stringify(apresBascule));

    /* ON REMET COMME C'ÉTAIT. C'est un drapeau d'affichage du client, pas un
     * droit : le serveur n'a de toute façon jamais envoyé à ce joueur ce qu'il
     * n'a pas le droit de voir. On le rend quand même. */
    if (bascule && bascule.avant !== undefined) {
      await driver.executeScript(
        "window.MeshScene.metadata.gmMode = arguments[0];", bascule.avant);
      console.log("    gmMode remis à " + JSON.stringify(bascule.avant));
    }

    /* ---------- ON NE LUTTE PLUS : ON LUI FAIT RÉÉCRIRE ----------
     *
     * Cinq tentatives d'écriture directe, aucun pixel. La lecture du bundle
     * explique pourquoi : « u_Board » n'a qu'UN écrivain,
     *
     *     u_Board = new Vector4(boardWidth, boardHeight,
     *                           gmMode ? 1 : 0,
     *                           !gmMode || layerName === ... ? 1 : 0)
     *
     * et il n'est appelé qu'à DEUX occasions, toutes deux événementielles.
     * Écrire le tampon après coup ne rejoue pas la décision ; il faut que
     * l'écrivain repasse.
     *
     * D'où ce dernier essai, qui est aussi le plus propre : on pose
     * « scene.metadata.gmMode = true », puis on provoque la reconstruction de la
     * vue du jeton — un changement de couche la force — et c'est ROLL20 qui
     * réécrit u_Board, avec sa propre formule, dans son propre ordre.
     *
     * SI ÇA MARCHE, c'est la meilleure des trois voies : coût nul (le tampon
     * part déjà à chaque image), et aucun champ privé touché — on ne fait que
     * poser un drapeau que Roll20 lit lui-même.
     */
    const parLui = await driver.executeScript([
      "var S = window.MeshScene;",
      "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
      "if (!S || !S.metadata) { return 'pas de metadata'; }",
      "S.metadata.gmMode = true;",
      "var avantCouche = t.get('layer');",
      "/* Un aller-retour de couche : la vue se refait, l'ecrivain repasse. */",
      "t.save({ layer: avantCouche === 'objects' ? 'map' : 'objects' });",
      "return { gmMode: S.metadata.gmMode, couche: avantCouche };"
    ].join("\n"));
    console.log("\n  -- ON LUI FAIT RÉÉCRIRE --");
    console.log("    " + JSON.stringify(parLui));
    await dors(2500);

    const relu = await driver.executeScript([
      "var S = window.MeshScene;",
      "var g = window.Campaign.activePage().thegraphics.models, t = g[0];",
      "t.save({ layer: arguments[0] });",
      "return 'couche rendue';"
    ].join("\n"), (parLui && parLui.couche) || "objects");
    await dors(2500);

    const valeurs = await driver.executeScript([
      "var sp = window.__v2.sprites(), out = [];",
      "sp.forEach(function (m) {",
      "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (b) { out.push({ nom: String(m.name).slice(0, 34), v: [b.x, b.y, b.z, b.w] }); }",
      "});",
      "var src = sp[0] && (sp[0].sourceMesh || sp[0]);",
      "var d = src && src._userInstancedBuffersStorage && src._userInstancedBuffersStorage.data.u_Board;",
      "return { objets: out, tableau: d ? [].slice.call(d, 0, 12) : null,",
      "  gmMode: window.MeshScene.metadata.gmMode };"
    ].join("\n"));
    console.log("    après reconstruction : " + JSON.stringify(valeurs));
    await dors(1200);
    if (ou && ou.dansLeCadre) {
      await capturePres(driver, "parlui-" + quelle + ".png",
        Math.max(0, ou.x - 90), Math.max(0, ou.y - 90), 180, 180, 4);
    }

    /* ON REMET LE DRAPEAU. C'est un drapeau d'affichage du client, pas un
     * droit : le serveur n'envoie de toute façon à ce joueur que ce qu'il a le
     * droit de voir. On le rend quand même, et la couche aussi. */
    await driver.executeScript("window.MeshScene.metadata.gmMode = false;");
    console.log("    gmMode remis à false");

    /* ET COMBIEN DE TEMPS ÇA TIENT ? Si Roll20 réécrit le tableau à chaque
     * image, il faudrait le refaire à chaque image — et c'est là que la question
     * du coût redeviendrait vraie. */
    const tenue = await driver.executeAsyncScript([
      "var cb = arguments[arguments.length - 1];",
      "var sp = window.__v2.sprites();",
      "var src = sp[0].sourceMesh || sp[0];",
      "var d = src._userInstancedBuffersStorage.data.u_Board;",
      "var t0 = performance.now(), releves = [];",
      "function relis() {",
      "  var n = 0;",
      "  for (var i = 2; i < d.length; i += 4) { if (d[i] === 1) { n++; } }",
      "  releves.push({ ms: Math.round(performance.now() - t0), aUn: n, sur: d.length / 4 });",
      "}",
      "[0, 300, 1200, 3000].forEach(function (x) { setTimeout(relis, x); });",
      "setTimeout(function () { cb(releves); }, 3400);"
    ].join("\n"));
    console.log("    tenue du tableau :");
    (tenue || []).forEach(function (x) {
      console.log("      à " + String(x.ms).padStart(5) + " ms : " + x.aUn + " à 1 sur " + x.sur);
    });

    /* ---------- B. CE QUE COÛTE UNE PASSE, RÉPÉTÉE À CHAQUE IMAGE ---------- */
    console.log("\n  -- B. LE COÛT D'UNE ÉCRITURE PAR IMAGE --");
    const temoin = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1]; window.__v2.chrono(6000).then(cb);");
    console.log("    témoin, sans rien écrire     : " + JSON.stringify(temoin));

    const avecEcriture = await driver.executeAsyncScript([
      "var cb = arguments[arguments.length - 1];",
      "var stop = false, passes = 0, total = 0;",
      "function tour() {",
      "  if (stop) { return; }",
      "  var t0 = performance.now();",
      "  var sp = window.__v2.sprites();",
      "  sp.forEach(function (m) { m.instancedBuffers.u_Board.z = 1; });",
      "  total += performance.now() - t0; passes++;",
      "  requestAnimationFrame(tour);",
      "}",
      "requestAnimationFrame(tour);",
      "window.__v2.chrono(6000).then(function (r) {",
      "  stop = true;",
      "  r.passes = passes;",
      "  r.msParPasse = Math.round(total / Math.max(1, passes) * 1000) / 1000;",
      "  cb(r);",
      "});"
    ].join("\n"));
    console.log("    en écrivant à chaque image   : " + JSON.stringify(avecEcriture));

    /* Et la même chose SANS l'énumération, pour séparer les deux coûts : c'est
     * chercher les sprites qui pourrait coûter, pas les écrire. */
    const sansCherche = await driver.executeAsyncScript([
      "var cb = arguments[arguments.length - 1];",
      "var sp = window.__v2.sprites();",
      "var stop = false, passes = 0, total = 0;",
      "function tour() {",
      "  if (stop) { return; }",
      "  var t0 = performance.now();",
      "  sp.forEach(function (m) { m.instancedBuffers.u_Board.z = 1; });",
      "  total += performance.now() - t0; passes++;",
      "  requestAnimationFrame(tour);",
      "}",
      "requestAnimationFrame(tour);",
      "window.__v2.chrono(6000).then(function (r) {",
      "  stop = true;",
      "  r.passes = passes;",
      "  r.msParPasse = Math.round(total / Math.max(1, passes) * 1000) / 1000;",
      "  cb(r);",
      "});"
    ].join("\n"));
    console.log("    sans réenumérer les sprites  : " + JSON.stringify(sansCherche));

    console.log("\n  ----------------------------------------------");
    console.log("  blocages : témoin " + temoin.blocages + " (" + temoin.ms + " ms)" +
      "  |  écriture par image " + avecEcriture.blocages + " (" + avecEcriture.ms + " ms)");
    console.log("  gigue p95 : témoin " + temoin.p95 + "  |  écriture " + avecEcriture.p95);

    if (dejaLa) {
      await driver.executeScript([
        "var g = window.Campaign.activePage().thegraphics.models;",
        "g[0].save({ left: arguments[0], top: arguments[1] });"
      ].join(String.fromCharCode(10)), dejaLa.left, dejaLa.top);
      console.log("  jeton remis en (" + dejaLa.left + ", " + dejaLa.top + ")");
    }

    releve("cout-voie2-" + quelle + ".json",
      { sprites: combien, survie: survie, apresGeste: apresGeste,
        temoin: temoin, avecEcriture: avecEcriture, sansCherche: sansCherche });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA VOIE 2 MARCHE-T-ELLE ? LE MONTAGE QUI TRANCHE ----------
 *
 * Cinq tentatives précédentes n'ont RIEN prouvé, et c'est l'instrument qui
 * était en cause : une projection écran calculée à la main, jamais contrôlée.
 * Mise à l'épreuve, elle a échoué — deux captures, le même jeton dedans puis
 * dehors, IDENTIQUES OCTET POUR OCTET. Le sujet n'était dessiné nulle part.
 *
 * CE MONTAGE NE CALCULE RIEN. Il ne suppose ni où la caméra regarde, ni où un
 * jeton tombe à l'écran. Il photographie la toile entière et compare les
 * empreintes. Deux images différentes veulent dire que quelque chose a changé ;
 * deux images identiques, que rien n'a bougé. C'est tout ce dont on a besoin.
 *
 * QUATRE ÉTAPES, DANS CET ORDRE :
 *
 *   0. LE TÉMOIN DE L'INSTRUMENT. Deux captures sans rien toucher. Si elles
 *      diffèrent, la page bouge toute seule et aucune comparaison ne vaudra —
 *      on le dit et on s'arrête. C'est le contrôle qui manquait à tout le
 *      reste.
 *   1. QUEL JETON EST DESSINÉ ? On les envoie très loin un par un : celui dont
 *      le départ change l'image était visible. Aucune géométrie, juste une
 *      différence.
 *   2. LE FAIT À ÉTABLIR. Ce jeton-là, déplacé JUSTE au-dessus du bord haut de
 *      la page — donc dehors, mais à cent pixels de là où on le voyait —
 *      disparaît-il ?
 *   3. LE LEVIER. On pose « gmMode » et on force Roll20 à réécrire u_Board par
 *      sa propre formule. Le jeton revient-il ?
 */
async function preuveVoie2() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  const crypto = require("crypto");
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    /* La toile entière, et son empreinte. Aucun cadrage, aucun calcul. */
    async function photo(nom) {
      const t = await driver.executeScript(
        "var n = document.getElementById('babylonCanvas');" +
        "if (!n) { return null; }" +
        "var q = n.getBoundingClientRect();" +
        "return { x: Math.round(q.left), y: Math.round(q.top)," +
        "  l: Math.round(q.width), h: Math.round(q.height) };");
      if (!t) { return null; }
      const p = await capturePres(driver, nom + ".png", t.x, t.y, t.l, t.h, 1);
      if (!p) { return null; }
      const b = fs.readFileSync(p);
      return { nom: nom, taille: b.length, sha: crypto.createHash("sha1").update(b).digest("hex").slice(0, 12) };
    }

    async function bouge(i, gauche, haut) {
      await driver.executeScript(
        "var g = window.Campaign.activePage().thegraphics.models;" +
        "if (!g[arguments[0]]) { return 'absent'; }" +
        "g[arguments[0]].save({ left: arguments[1], top: arguments[2] });" +
        "return 'ok';", i, gauche, haut);
      await dors(2600);
    }

    const jetons = await driver.executeScript(
      "var g = window.Campaign.activePage().thegraphics.models;" +
      "var pg = window.Campaign.activePage();" +
      "return { page: { l: pg.get('width') * 70, h: pg.get('height') * 70 }," +
      "  liste: g.map(function (t) { return { id: String(t.id).slice(-6)," +
      "    gauche: t.get('left'), haut: t.get('top'), couche: t.get('layer') }; }) };");
    console.log("\n  page " + jetons.page.l + " x " + jetons.page.h + " px, " +
      jetons.liste.length + " jeton(s)");
    jetons.liste.forEach(function (t, i) {
      console.log("    [" + i + "] …" + t.id + "  (" + t.gauche + ", " + t.haut + ")  " + t.couche);
    });

    /* ---------- 0. LE TÉMOIN DE L'INSTRUMENT ---------- */
    console.log("\n  -- 0. L'INSTRUMENT EST-IL STABLE ? --");
    const a1 = await photo("stab-1");
    await dors(2600);
    const a2 = await photo("stab-2");
    console.log("    " + a1.sha + "   " + a2.sha +
      (a1.sha === a2.sha ? "   → stable" : "   → LA PAGE BOUGE SEULE, comparaisons sans valeur"));
    if (a1.sha !== a2.sha) {
      console.log("    on s'arrête : un instrument instable ne prouve rien.");
      return 1;
    }

    /* ---------- 1. QUEL JETON EST DESSINÉ ? ---------- */
    console.log("\n  -- 1. LEQUEL EST DESSINÉ ? --");
    const LOIN = 99999;
    let vu = -1;
    for (let i = 0; i < jetons.liste.length; i++) {
      const chez = jetons.liste[i];
      await bouge(i, LOIN, LOIN);
      const p = await photo("sans-" + i);
      const change = p.sha !== a1.sha;
      console.log("    [" + i + "] envoyé au loin : " + p.sha +
        (change ? "   → il était VISIBLE" : "   → invisible de toute façon"));
      await bouge(i, chez.gauche, chez.haut);
      if (change && vu < 0) { vu = i; }
    }
    if (vu < 0) {
      console.log("    aucun jeton visible dans cette vue — rien à éprouver ici.");
      return 1;
    }
    const chez = jetons.liste[vu];
    console.log("    → on travaille avec [" + vu + "] …" + chez.id);

    async function board() {
      return await driver.executeScript(
        "var S = window.MeshScene, out = [];" +
        "S.meshes.forEach(function (m) {" +
        "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;" +
        "  if (b && String(m.name).indexOf('instance- ') === 0) { out.push([b.x, b.y, b.z, b.w]); }" +
        "});" +
        "return { gmMode: S.metadata ? S.metadata.gmMode : null, boards: out.slice(0, 3) };");
    }

    /* ---------- 2. DEDANS PUIS DEHORS ---------- */
    console.log("\n  -- 2. LE MÊME JETON, DEDANS PUIS DEHORS --");
    await bouge(vu, chez.gauche, chez.haut);
    const dedans = await photo("preuve-dedans");
    console.log("    dedans (" + chez.gauche + ", " + chez.haut + ") : " + dedans.sha);

    /* JUSTE AU-DESSUS DU BORD HAUT : « top » négatif est hors page, et cent
     * pixels au-dessus de sa position visible, donc dans le même voisinage à
     * l'écran. On ne parie pas sur la position de la caméra. */
    await bouge(vu, chez.gauche, -105);
    const dehors = await photo("preuve-dehors");
    const bDehors = await board();
    console.log("    dehors (" + chez.gauche + ", -105) : " + dehors.sha +
      (dehors.sha === dedans.sha ? "   → AUCUN changement" : "   → l'image a changé"));
    console.log("      u_Board : " + JSON.stringify(bDehors));

    /* ---------- 3. LE LEVIER ---------- */
    console.log("\n  -- 3. LE LEVIER : gmMode + réécriture par Roll20 --");
    await driver.executeScript(
      "if (window.MeshScene && window.MeshScene.metadata) { window.MeshScene.metadata.gmMode = true; }");
    /* L'aller-retour de couche force la reconstruction de la vue, donc le
     * passage de l'écrivain de u_Board — avec gmMode à vrai, cette fois. */
    await driver.executeScript(
      "var g = window.Campaign.activePage().thegraphics.models;" +
      "g[arguments[0]].save({ layer: 'map' });", vu);
    await dors(2600);
    await driver.executeScript(
      "var g = window.Campaign.activePage().thegraphics.models;" +
      "g[arguments[0]].save({ layer: arguments[1] });", vu, chez.couche || "objects");
    await dors(3000);
    const apres = await photo("preuve-levier");
    const bApres = await board();
    console.log("    dehors + levier : " + apres.sha);
    console.log("      u_Board : " + JSON.stringify(bApres));

    /* ---------- 4. L'ÉCRITURE DIRECTE, AVEC UN INSTRUMENT QUI TIENT ----------
     *
     * Le levier par « gmMode » n'a rien changé — et pour cause : u_Board est
     * resté à z = 0, relevé après coup. On n'a donc toujours pas éprouvé ce qui
     * compte, à savoir « z = 1 fait-il réapparaître le jeton ». On l'écrit à la
     * main, cette fois-ci sous l'œil d'un montage contrôlé.
     *
     * Deux essais, parce que le nuanceur offre deux sorties :
     *   z = 1  → le test « offBoard && v_Board.z == 0 » devient faux, pas de
     *            rejet, et le jeton sort à 50 % d'opacité — la vue du MJ ;
     *   w = 0  → « v_Offboard == 1 » devient faux, tout le bloc est sauté, et
     *            le jeton sort à pleine opacité.
     */
    async function ecris(quoiDit, corps) {
      const r = await driver.executeScript([
        "var S = window.MeshScene, vus = [], n = 0;",
        "S.meshes.forEach(function (m) {",
        "  var src = m.sourceMesh || m;",
        "  if (vus.indexOf(src) >= 0) { return; }",
        "  var st = src._userInstancedBuffersStorage;",
        "  if (!st || !st.data || !st.data.u_Board) { return; }",
        "  vus.push(src);",
        "  var d = st.data.u_Board;",
        "  for (var i = 0; i < d.length; i += 4) {",
        "    d[i + 2] = arguments[0];",
        "    if (arguments[1] !== null) { d[i + 3] = arguments[1]; }",
        "  }",
        "  try { st.vertexBuffers.u_Board.updateDirectly(d, 0); n++; } catch (e) {}",
        "  var b = src.instancedBuffers && src.instancedBuffers.u_Board;",
        "  if (b) { b.z = arguments[0]; if (arguments[1] !== null) { b.w = arguments[1]; } }",
        "});",
        "/* Et sur chaque instance : deux chemins valent mieux qu'un quand on ne",
        "   sait pas lequel Babylon lit. */",
        "S.meshes.forEach(function (m) {",
        "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
        "  if (b) { b.z = arguments[0]; if (arguments[1] !== null) { b.w = arguments[1]; } }",
        "});",
        "return { sources: vus.length, pousses: n };"
      ].join("\n"), corps.z, corps.w === undefined ? null : corps.w);
      await dors(2400);
      const ph = await photo("preuve-" + quoiDit);
      console.log("    " + quoiDit.padEnd(6) + " " + JSON.stringify(r) + "  →  " + ph.sha +
        (ph.sha !== dehors.sha ? "   L'IMAGE A CHANGÉ" : "   rien"));
      return ph;
    }

    console.log("\n  -- 4. L'ÉCRITURE DIRECTE --");
    const zUn = await ecris("z1", { z: 1 });
    const wZero = await ecris("w0", { z: 1, w: 0 });


    console.log("\n  ──────────────────────────────────────────────");
    console.log("  hors page, le jeton disparaît          : " + (dehors.sha !== dedans.sha ? "OUI" : "NON"));
    console.log("  le levier change l'image               : " + (apres.sha !== dehors.sha ? "OUI" : "NON"));
    console.log("  z = 1 le fait revenir                  : " + (zUn.sha !== dehors.sha ? "OUI" : "NON"));
    console.log("  w = 0 le fait revenir                  : " + (wZero.sha !== dehors.sha ? "OUI" : "NON"));
    console.log("  et le levier a bien changé u_Board     : " +
      (JSON.stringify(bApres.boards) !== JSON.stringify(bDehors.boards) ? "OUI" : "NON"));
    console.log("  VERDICT : " +
      (dehors.sha !== dedans.sha && apres.sha !== dehors.sha
        ? "la voie 2 MORD — le jeton hors page réapparaît."
        : (dehors.sha === dedans.sha
           ? "montage encore muet : le jeton ne change rien à l'image même dedans."
           : "le levier ne mord pas : l'image ne bouge pas.")));

    /* ---------- ON REMET TOUT ---------- */
    await driver.executeScript(
      "if (window.MeshScene && window.MeshScene.metadata) { window.MeshScene.metadata.gmMode = false; }");
    await bouge(vu, chez.gauche, chez.haut);
    console.log("  jeton remis en (" + chez.gauche + ", " + chez.haut + "), gmMode remis à false");

    releve("preuve-voie2-" + quelle + ".json",
      { jetons: jetons, stable: a1.sha === a2.sha, choisi: vu,
        dedans: dedans, dehors: dehors, apres: apres,
        boardDehors: bDehors, boardApres: bApres });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QU'UN JOUEUR ATTEINT VRAIMENT ----------
 *
 * Signalé : « en mode joueur, je n'ai quasiment accès à rien dans l'extension ».
 *
 * On ne devine pas ce qui manque : on fait l'inventaire des deux côtés, avec le
 * même code, et on compare colonne par colonne. Ce qui diffère est ce qu'il faut
 * expliquer — ou corriger.
 *
 * L'INVENTAIRE PORTE SUR CE QU'ON PEUT ATTEINDRE, pas sur ce qui existe en
 * mémoire : un bouton présent mais introuvable, une palette ouverte mais vide,
 * un panneau qui s'ouvre sur rien, tout cela se compte comme « rien ».
 */
async function accesJoueur() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(16000);

    const INV = [
      "function q(s) { return document.querySelector(s); }",
      "function n(s) { return document.querySelectorAll(s).length; }",
      "var out = {};",
      "out.mj = !!window.is_gm;",
      "out.pont = !!window.__vttinkerZoom || !!window.__vttinkerJournal;",
      "out.journal = (window.__vttinkerJournal || []).slice(-6);",
      "/* LA BOÎTE À OUTILS : notre section, et ses boutons. */",
      "out.colonne = !!q('.upper-buttons');",
      "out.sections = n('.spacer-outer');",
      "out.sectionsAvecTitre = (function () {",
      "  var c = 0, s = document.querySelectorAll('.spacer-outer');",
      "  for (var i = 0; i < s.length; i++) { if (s[i].querySelector('.spacer-header')) { c++; } }",
      "  return c;",
      "})();",
      "out.notreSection = !!q('.vttk-outil-titre');",
      "out.boutonReglages = !!q('.vttk-outil-reglages');",
      "out.boutonMarqueurs = !!q('.vttk-outil-marqueurs');",
      "/* LE ZOOM : il ne s'installe que si les bornes sortent des siennes. */",
      "out.zoomNatif = !!q('#vm_zoom_buttons');",
      "out.zoomNotre = !!q('.vttk-zoom');",
      "/* LE CHAT. */",
      "out.chatLigne = !!q('.vttk-chat-a');",
      "out.chatSelect = (function () { var s = q('.vttk-chat-select');",
      "  return s ? [].slice.call(s.options).map(function (o) { return o.textContent; }) : null; })();",
      "out.chatEmoji = !!q('.vttk-chat-emoji');",
      "/* LA GRILLE. */",
      "out.grille = (function () {",
      "  try { var S = window.MeshScene;",
      "    var g = S.getMeshByName('tabletop-square-grid');",
      "    if (!g) { return null; }",
      "    var b = g.getBoundingInfo().boundingBox;",
      "    return [Math.round(b.maximumWorld.x - b.minimumWorld.x),",
      "            Math.round(b.maximumWorld.y - b.minimumWorld.y)];",
      "  } catch (e) { return null; }",
      "})();",
      "/* CE QUE LE JOUEUR PEUT ÉCRIRE : les jetons qu'il contrôle. */",
      "try {",
      "  var g2 = window.Campaign.activePage().thegraphics.models;",
      "  var moi = window.currentPlayer ? window.currentPlayer.id : null;",
      "  out.moi = moi;",
      "  out.jetons = g2.length;",
      "  out.jetonsAMoi = g2.filter(function (t) {",
      "    var c = String(t.get('controlledby') || '');",
      "    return c === 'all' || (moi && c.indexOf(moi) >= 0);",
      "  }).length;",
      "} catch (e) { out.jetons = 'erreur'; }",
      "return out;"
    ].join("\n");

    const r = await driver.executeScript(INV);
    console.log("\n  ══ " + (r.mj ? "MJ" : "JOUEUR") + " ══");
    const dit = function (nom, v) {
      console.log("    " + nom.padEnd(26) + " " + JSON.stringify(v));
    };
    ["pont", "colonne", "sections", "sectionsAvecTitre", "notreSection",
     "boutonReglages", "boutonMarqueurs", "zoomNatif", "zoomNotre",
     "chatLigne", "chatEmoji", "chatSelect", "grille",
     "jetons", "jetonsAMoi", "moi"].forEach(function (k) { dit(k, r[k]); });
    console.log("    journal :");
    (r.journal || []).forEach(function (l) { console.log("      | " + String(l).slice(0, 100)); });

    /* ---------- ET CE QUI S'OUVRE ---------- */
    async function ouvre1(sel, nom) {
      await driver.executeScript(
        "var b = document.querySelector(arguments[0] + ' button') || document.querySelector(arguments[0]);" +
        "if (b) { b.click(); }", sel);
      await dors(1800);
      const d = await driver.executeScript(
        "var p = document.querySelector(arguments[0]);" +
        "if (!p) { return null; }" +
        "var q = p.getBoundingClientRect();" +
        "return { ouvert: p.classList.contains('ouvert'), l: Math.round(q.width), h: Math.round(q.height) };",
        nom);
      return d;
    }

    const pan = await ouvre1(".vttk-outil-reglages", ".vttk-reglages");
    console.log("\n    panneau de réglages : " + JSON.stringify(pan));
    if (pan && pan.ouvert) {
      const cadres = await driver.findElements({ css: ".vttk-reglages iframe" });
      if (cadres.length) {
        await driver.switchTo().frame(cadres[0]);
        const dedans = await driver.executeScript(
          "return { lignes: document.querySelectorAll('.r20-ligne').length," +
          "  interrupteurs: document.querySelectorAll('.sw').length," +
          "  champs: document.querySelectorAll('input[type=number]').length," +
          "  texte: (document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };");
        console.log("      dedans : " + JSON.stringify(dedans));
        await driver.switchTo().defaultContent();
      }
    }

    const pal = await ouvre1(".vttk-outil-marqueurs", ".vttk-barre");
    console.log("    palette de marqueurs : " + JSON.stringify(pal));
    if (pal && pal.ouvert) {
      const dedans = await driver.executeScript(
        "var b = document.querySelector('.vttk-barre');" +
        "return { tuiles: b.querySelectorAll('.vttk-barre-marqueur').length," +
        "  modes: b.querySelectorAll('.vttk-barre-mode').length," +
        "  rouage: !!b.querySelector('.vttk-barre-rouage')," +
        "  titre: (b.querySelector('.vttk-barre-nom') || {}).textContent };");
      console.log("      dedans : " + JSON.stringify(dedans));
    }

    releve("acces-" + quelle + ".json", r);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUELLES CAMPAGNES, ET SOUS QUEL NOM ? ----------
 *
 * Pour éprouver une campagne nommée, il faut son identifiant. On lit la liste
 * telle que Roll20 la rend, sans rien ouvrir : c'est une page de gestion, pas
 * une partie, et personne n'y voit qu'on est passé.
 *
 * ELLE DIT AUSSI SI LA SESSION TIENT. Déconnecté, Roll20 renvoie vers sa page
 * de connexion ou vers son contrôle anti-robot — et « aucune campagne » ne veut
 * alors pas dire « aucune campagne ».
 */
async function listeDesCampagnes() {
  const driver = await ouvre(config().visible === true);
  try {
    await driver.get("https://app.roll20.net/campaigns/");
    await dors(6000);

    const etat = await driver.executeScript([
      "return { url: location.href.slice(0, 90), titre: document.title.slice(0, 60),",
      "  connecte: !/login|Un instant/i.test(location.href + ' ' + document.title) };"
    ].join("\n"));
    console.log("\n  " + JSON.stringify(etat));
    if (!etat.connecte) {
      console.log("\n  LA SESSION EST TOMBÉE. Roll20 a coupé la session pilotée — son");
      console.log("  contrôle anti-robot. Il faut se reconnecter À LA MAIN, dans un");
      console.log("  Firefox ordinaire, sur le profil du pilote :");
      console.log("      node outils/pilote.js connexion");
      return 1;
    }

    /* ON RELÈVE LE VOISINAGE, ON NE DEVINE PLUS LA STRUCTURE.
     *
     * Deux extracteurs successifs ont rendu dix chaînes vides : le nom n'est ni
     * dans l'ancre — elle ne porte qu'une image —, ni dans un titre au-dessus
     * d'elle. Plutôt qu'un troisième pari sur la mise en page de Roll20, on
     * remonte de parent en parent jusqu'à trouver du texte, et on rapporte
     * aussi l'attribut « alt » de l'image et le « title » du lien : l'un des
     * trois portera le nom, et on verra lequel. */
    const liste = await driver.executeScript([
      "var out = [], vus = {};",
      "var a = document.querySelectorAll('a[href*=\"/campaigns/details/\"], a[href*=\"/editor/setcampaign/\"]');",
      "for (var i = 0; i < a.length; i++) {",
      "  var n = a[i];",
      "  var m = String(n.href).match(/(?:details|setcampaign)[/](\\d+)/);",
      "  if (!m || vus[m[1]]) { continue; }",
      "  vus[m[1]] = 1;",
      "  var texte = '', p = n;",
      "  for (var k = 0; k < 5 && p && texte.length < 3; k++) {",
      "    texte = (p.textContent || '').replace(/\\s+/g, ' ').trim();",
      "    p = p.parentElement;",
      "  }",
      "  var img = n.querySelector('img');",
      "  out.push({ id: m[1], nom: texte.slice(0, 70),",
      "    alt: img ? String(img.alt || '').slice(0, 60) : '',",
      "    titre: String(n.getAttribute('title') || '').slice(0, 60) });",
      "}",
      "return out;"
    ].join(String.fromCharCode(10)));

    console.log("\n  " + liste.length + " campagne(s) :");
    liste.forEach(function (c) {
      console.log("    " + String(c.id).padStart(9) + "  " +
        (c.nom || c.alt || c.titre || "(sans nom)"));
    });
    releve("campagnes.json", liste);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- SUR QUELLE VERSION DE ROLL20 SOMMES-NOUS ? ----------
 *
 * Il y a QUATRE mondes à tenir, et pas deux :
 *
 *                    Jumpgate            héritage (« legacy »)
 *     MJ             .................   .....................
 *     joueur         .................   .....................
 *
 * Le rôle, on sait déjà le lire — « window.is_gm ». La VERSION, non : tout le
 * pont suppose Jumpgate sans jamais l'avoir vérifié, et sur une campagne
 * d'héritage il cherche une scène Babylon qui n'existe pas. Les modules qui
 * passent par lui ne posent alors rien, sans un mot.
 *
 * CETTE SONDE N'ÉCRIT RIEN. Elle est faite pour tourner sur une VRAIE campagne,
 * où l'on n'est qu'invité : elle lit, elle compte, elle photographie, et elle
 * ne touche à aucun jeton, aucun marqueur, aucun message.
 */
async function versionDeRoll20() {
  const campagne = process.argv[3];
  if (!campagne) {
    console.log("  usage : node outils/pilote.js version <identifiant de campagne>");
    console.log("          (la liste s'obtient par « node outils/pilote.js campagnes »)");
    return 1;
  }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(16000);

    const LIS = [
      "function q(s) { try { return !!document.querySelector(s); } catch (e) { return false; } }",
      "function n(s) { try { return document.querySelectorAll(s).length; } catch (e) { return 0; } }",
      "var out = {};",
      "",
      "/* ---------- CE QUI DISTINGUE LES DEUX MOTEURS ----------",
      "   Jumpgate dessine avec Babylon, dans UNE toile nommée. L'héritage",
      "   empile des <canvas> classiques et garde son API sur window.d20. */",
      "out.jumpgate = {",
      "  toile: q('#babylonCanvas'),",
      "  meshScene: typeof window.MeshScene !== 'undefined',",
      "  vtt: typeof window.VTTEngine !== 'undefined',",
      "  pinia: n('[data-v-app]') > 0,",
      "  d20SurJoueur: !!(window.currentPlayer && window.currentPlayer.d20)",
      "};",
      "out.heritage = {",
      "  d20SurWindow: typeof window.d20 !== 'undefined',",
      "  finalcanvas: q('#finalcanvas'),",
      "  gridcanvas: q('#gridcanvas'),",
      "  bgcanvas: q('#bgcanvas'),",
      "  fowcanvas: q('#fowcanvas'),",
      "  objectscanvas: q('#objectscanvas'),",
      "  canvasCount: n('canvas'),",
      "  jquery: typeof window.$ !== 'undefined'",
      "};",
      "",
      "/* Le verdict, tiré de ce qui est le plus stable : la toile de Babylon",
      "   n'existe QUE sous Jumpgate, et l'empilement de canvas QUE dans",
      "   l'héritage. On demande les deux, pour ne pas confondre « autre chose »",
      "   avec « l'un des deux ». */",
      "/* LE SEUL INDICE QUI TRANCHE, et il a fallu mesurer les deux pour le",
      "   savoir : la campagne d'HÉRITAGE tourne dans le MÊME client neuf.",
      "   « #babylonCanvas », Pinia et « currentPlayer.d20 » y sont tous les",
      "   trois — le premier jet concluait donc « jumpgate » sur une campagne",
      "   d'héritage. Seul « MeshScene » n'existe que là où Babylon dessine. */",
      "out.verdict = out.jumpgate.meshScene ? 'jumpgate'",
      "  : (window.currentPlayer && window.currentPlayer.d20 && window.currentPlayer.d20.engine",
      "     && window.currentPlayer.d20.engine.canvas) ? 'heritage'",
      "  : (window.d20 && window.d20.engine && window.d20.engine.canvas) ? 'heritage'",
      "  : 'inconnu';",
      "out.moteurDuPont = window.__vttinkerMoteur || null;",
      "",
      "out.role = (typeof window.is_gm === 'boolean') ? (window.is_gm ? 'mj' : 'joueur') : 'inconnu';",
      "",
      "/* ---------- LA BOÎTE À OUTILS, QUI DÉCIDE DE TOUT CHEZ NOUS ----------",
      "   Notre section s'y greffe en clonant une des siennes. Si sa structure",
      "   change, on ne pose rien — et l'utilisateur ne voit rien. */",
      "out.barre = {",
      "  upperButtons: q('.upper-buttons'),",
      "  spacerOuter: n('.spacer-outer'),",
      "  spacerHeader: n('.spacer-header'),",
      "  floatingtoolbar: q('#floatingtoolbar'),",
      "  masterToolbar: q('#master-toolbar') || q('#vm-master-toolbar'),",
      "  li: n('#floatingtoolbar li'),",
      "  ul: n('#floatingtoolbar ul')",
      "};",
      "",
      "/* ---------- CE QUE NOUS AVONS RÉUSSI À POSER ---------- */",
      "out.nous = {",
      "  pont: !!(window.__vttinkerZoom || window.__vttinkerJournal),",
      "  section: q('.vttk-outil-titre'),",
      "  boutonReglages: q('.vttk-outil-reglages'),",
      "  boutonMarqueurs: q('.vttk-outil-marqueurs'),",
      "  zoom: q('.vttk-zoom'),",
      "  chatLigne: q('.vttk-chat-a'),",
      "  chatEmoji: q('.vttk-chat-emoji'),",
      "  palette: q('.vttk-barre')",
      "};",
      "out.journal = (window.__vttinkerJournal || []).slice(-10);",
      "",
      "/* ---------- CE QUE L'HÉRITAGE OFFRE À LA PLACE ----------",
      "   Si l'on doit un jour le servir, c'est par là que ça passera. On relève",
      "   ce qui existe, sans rien appeler. */",
      "if (out.heritage.d20SurWindow) {",
      "  try {",
      "    var d = window.d20;",
      "    out.d20 = {",
      "      engine: !!d.engine,",
      "      zoom: d.engine ? typeof d.engine.canvasZoom : null,",
      "      setZoom: d.engine ? typeof d.engine.setZoom : null,",
      "      canvas: d.engine ? typeof d.engine.canvas : null,",
      "      textchat: !!d.textchat,",
      "      Campaign: typeof window.Campaign !== 'undefined'",
      "    };",
      "  } catch (e) { out.d20 = 'erreur ' + String(e).slice(0, 50); }",
      "}",
      "",
      "/* Le pied de chat : c'est le seul de nos modules qui ne demande rien à",
      "   Babylon, donc le seul qui pourrait marcher des deux côtés. */",
      "out.chat = {",
      "  zone: q('#textchat-input'),",
      "  champ: q('#textchat-input textarea'),",
      "  speakingas: q('#speakingas'),",
      "  bouton: q('#chatSendBtn')",
      "};",
      "return out;"
    ].join("\n");

    const r = await driver.executeScript(LIS);

    console.log("\n  ══ CAMPAGNE " + campagne + " ══");
    console.log("  VERDICT : " + String(r.verdict).toUpperCase() + " — rôle : " + r.role +
      "   (le pont dit : " + r.moteurDuPont + ")");
    console.log("");
    const bloc = function (nom, o) {
      console.log("  " + nom);
      Object.keys(o || {}).forEach(function (k) {
        console.log("    " + k.padEnd(18) + " " + JSON.stringify(o[k]));
      });
    };
    bloc("indices Jumpgate", r.jumpgate);
    bloc("indices héritage", r.heritage);
    bloc("sa boîte à outils", r.barre);
    bloc("ce que NOUS avons posé", r.nous);
    bloc("son pied de chat", r.chat);
    if (r.d20) { bloc("ce que d20 offre", r.d20); }
    console.log("  journal de l'extension :");
    (r.journal || []).forEach(function (l) { console.log("    | " + String(l).slice(0, 104)); });

    /* ---------- CE QU'IL FAUT VOIR POUR S'Y GREFFER ----------
     *
     * Deux choses décident de tout, et aucune des deux ne se devine :
     *
     *   · LA STRUCTURE DE SA COLONNE D'OUTILS. On y pose notre section en
     *     CLONANT une des siennes — il faut donc qu'il en existe une qui porte
     *     un intitulé. Ici « .spacer-header » est à zéro : il n'y a rien à
     *     cloner, et c'est pour ça qu'aucun bouton VTTK n'apparaît.
     *   · L'INTITULÉ DE SON PIED DE CHAT. Le module le cherche par son TEXTE —
     *     « En tant que » ou « Speaking as ». La capture montre « As: ». Un mot
     *     de moins, et la ligne « À : » ne se pose jamais.
     */
    const detail = await driver.executeScript([
      "function decris(n, prof) {",
      "  return { balise: n.tagName.toLowerCase(),",
      "    classe: String(n.className || '').slice(0, 46),",
      "    id: n.id || '',",
      "    texte: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26),",
      "    enfants: n.children.length, prof: prof };",
      "}",
      "var out = { colonne: [], labels: [], barres: [] };",
      "var col = document.querySelector('.upper-buttons');",
      "if (col) {",
      "  for (var i = 0; i < col.children.length && i < 16; i++) {",
      "    out.colonne.push(decris(col.children[i], 1));",
      "    var e = col.children[i];",
      "    for (var j = 0; j < e.children.length && j < 3; j++) {",
      "      out.colonne.push(decris(e.children[j], 2));",
      "    }",
      "  }",
      "}",
      "/* Toutes les barres d'outils candidates, pour savoir où l'on POURRAIT se",
      "   greffer si la sienne n'offre rien à cloner. */",
      "['#master-toolbar', '#vm-master-toolbar', '.upper-buttons', '.lower-buttons',",
      " '#floatingtoolbar', '[class*=toolbar]'].forEach(function (s) {",
      "  var n = document.querySelector(s);",
      "  if (n) { out.barres.push({ sel: s, classe: String(n.className || '').slice(0, 40),",
      "    enfants: n.children.length }); }",
      "});",
      "/* Les intitulés du pied de chat, tels qu'ils sont écrits. */",
      "var z = document.querySelector('#textchat-input');",
      "if (z) {",
      "  var ls = z.querySelectorAll('label, span, div');",
      "  for (var k = 0; k < ls.length && out.labels.length < 10; k++) {",
      "    var t = (ls[k].textContent || '').replace(/\\s+/g, ' ').trim();",
      "    if (t && t.length < 30 && ls[k].children.length === 0) {",
      "      out.labels.push({ balise: ls[k].tagName.toLowerCase(),",
      "        classe: String(ls[k].className || '').slice(0, 30), texte: t });",
      "    }",
      "  }",
      "}",
      "/* Ce que d20 offre, s'il est là : c'est par lui que passerait une couche",
      "   d'héritage. */",
      "try {",
      "  var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "  if (d) {",
      "    out.d20 = { engine: !!d.engine, textchat: !!d.textchat,",
      "      cles: Object.keys(d).slice(0, 24) };",
      "    if (d.engine) {",
      "      out.engine = Object.keys(d.engine).filter(function (k) {",
      "        return /zoom|canvas|render|scale/i.test(k);",
      "      }).slice(0, 20);",
      "    }",
      "  }",
      "} catch (e) { out.d20 = 'erreur ' + String(e).slice(0, 40); }",
      "return out;"
    ].join("\n"));

    console.log("\n  -- SA COLONNE D'OUTILS --");
    (detail.colonne || []).forEach(function (n) {
      console.log("    " + "  ".repeat(n.prof) + n.balise +
        (n.id ? "#" + n.id : "") + (n.classe ? "." + n.classe : "") +
        "   [" + n.enfants + "]  « " + n.texte + " »");
    });
    console.log("  -- LES BARRES CANDIDATES --");
    (detail.barres || []).forEach(function (b) {
      console.log("    " + String(b.sel).padEnd(22) + " " + b.enfants + " enfant(s)  " + b.classe);
    });
    console.log("  -- LES INTITULÉS DE SON CHAT --");
    (detail.labels || []).forEach(function (l) {
      console.log("    <" + l.balise + "> « " + l.texte + " »   " + l.classe);
    });
    if (detail.d20) { console.log("  -- d20 --\n    " + JSON.stringify(detail.d20)); }
    if (detail.engine) { console.log("    engine : " + JSON.stringify(detail.engine)); }

    await capture(driver, "version-" + campagne + ".png");
    releve("version-" + campagne + ".json", r);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- UN SEUL MESSAGE, CHUCHOTÉ À SOI-MÊME ----------
 *
 * Cette sonde tourne sur une VRAIE campagne, où l'on n'est qu'invité. Elle
 * n'envoie donc qu'UN message, et elle le chuchote À SOI : personne d'autre ne
 * le voit, et il ne bascule aucun réglage de la partie — contrairement à
 * « /talktomyself », qui est un interrupteur et resterait allumé derrière nous.
 *
 * C'est aussi le meilleur essai possible : le chuchotement à soi-même est
 * exactement ce que la ligne « À : » sait faire, et le relire dans le journal
 * prouve la chaîne entière — sélecteur, préfixe, envoi, affichage.
 *
 * ELLE NE TOUCHE À RIEN D'AUTRE. Pas de jeton, pas de marqueur, pas de réglage.
 */
async function essaiDuChat() {
  const campagne = process.argv[3];
  if (!campagne) {
    console.log("  usage : node outils/pilote.js essaichat <identifiant>");
    return 1;
  }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(14000);

    const qui = await driver.executeScript([
      "var s = document.querySelector('.vttk-chat-select');",
      "if (!s) { return { erreur: 'pas de ligne À :' }; }",
      "var moi = null;",
      "try { moi = window.currentPlayer ? window.currentPlayer.get('displayname') : null; } catch (e) {}",
      "return { moi: moi,",
      "  options: [].slice.call(s.options).map(function (o) { return { v: o.value, t: o.textContent }; }) };"
    ].join("\n"));
    console.log("\n  moi : " + JSON.stringify(qui.moi));
    console.log("  destinataires : " + JSON.stringify(qui.options));
    if (qui.erreur) { console.log("  " + qui.erreur); return 1; }

    /* ON NE VISE QUE SOI. Si l'on ne se trouve pas dans la liste, on s'arrête :
     * mieux vaut ne rien envoyer que d'envoyer au hasard sur la table de
     * quelqu'un. */
    const cible = (qui.options || []).filter(function (o) {
      return qui.moi && o.t && o.t.indexOf(qui.moi) === 0;
    })[0];
    if (!cible) {
      console.log("  je ne me trouve pas dans la liste — on n'envoie rien.");
      return 1;
    }
    console.log("  cible : « " + cible.t + " »");

    const mot = "vttk-essai-" + campagne;
    const envoi = await driver.executeScript([
      "var s = document.querySelector('.vttk-chat-select');",
      "s.value = arguments[0];",
      "s.dispatchEvent(new Event('change', { bubbles: true }));",
      "var z = document.querySelector('#textchat-input textarea');",
      "if (!z) { return 'pas de champ'; }",
      "var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(z), 'value');",
      "d.set.call(z, arguments[1]);",
      "z.dispatchEvent(new Event('input', { bubbles: true }));",
      "var b = document.querySelector('#chatSendBtn') ||",
      "  document.querySelector('#textchat-input .btn:not(.vttk-chat-bouton)');",
      "if (!b) { return 'pas de bouton'; }",
      "b.click();",
      "return 'envoyé';"
    ].join("\n"), cible.v, mot);
    console.log("  " + envoi);
    await dors(3000);

    const lu = await driver.executeScript([
      "var n = document.querySelectorAll('#textchat .message'), out = [];",
      "for (var i = Math.max(0, n.length - 3); i < n.length; i++) {",
      "  out.push((n[i].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 110));",
      "}",
      "return out;"
    ].join("\n"));
    console.log("  les trois dernières lignes du journal :");
    (lu || []).forEach(function (l) { console.log("    | " + l); });

    const bon = (lu || []).some(function (l) {
      return l.indexOf(mot) >= 0 && /to /i.test(l);
    });
    console.log("\n  le chuchotement à soi-même fonctionne : " + (bon ? "OUI" : "NON"));
    releve("essaichat-" + campagne + ".json", { moi: qui.moi, cible: cible, journal: lu, bon: bon });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE L'ANCIEN MOTEUR OFFRE ----------
 *
 * Trois modules restent muets en héritage : les marqueurs dessinés, la grille
 * hors carte, les bornes du zoom. Tous trois passent par Babylon, qui n'existe
 * pas là-bas. La question n'est pas « peut-on les porter » mais « par où » —
 * et ça se relève, ça ne se devine pas.
 *
 * ON CHERCHE TROIS CHOSES, une par module :
 *
 *   · POUR LE ZOOM : qui le détient, qui le change, et si sa commande le
 *     ramènerait dans ses bornes comme sous Jumpgate ;
 *   · POUR LA GRILLE : sur quelle surface elle est peinte, et s'il existe un
 *     calque au-dessus où poser la nôtre sans toucher à la sienne ;
 *   · POUR LES MARQUEURS : comment un jeton est représenté, et s'il existe un
 *     rendez-vous après chaque rendu où poser nos images.
 *
 * LECTURE SEULE. On énumère, on ne modifie rien.
 */
async function ancienMoteur() {
  const campagne = process.argv[3];
  if (!campagne) {
    console.log("  usage : node outils/pilote.js ancien <identifiant>");
    return 1;
  }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(14000);

    const LIS = [
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "if (!d) { return { erreur: 'pas de d20' }; }",
      "var out = {};",
      "function typeDe(x) { return x === null ? 'null' : (Array.isArray(x) ? 'array' : typeof x); }",
      "function membres(o, filtre) {",
      "  if (!o) { return null; }",
      "  var out = [];",
      "  for (var k in o) {",
      "    try {",
      "      if (filtre && !filtre.test(k)) { continue; }",
      "      out.push(k + ':' + typeDe(o[k]));",
      "    } catch (e) {}",
      "  }",
      "  return out.slice(0, 40);",
      "}",
      "",
      "/* ---------- LE ZOOM ---------- */",
      "out.zoom = {",
      "  valeur: d.engine ? d.engine.canvasZoom : null,",
      "  fonctions: membres(d.engine, /zoom/i),",
      "  surObjet: membres(d, /zoom/i)",
      "};",
      "",
      "/* ---------- LES SURFACES ---------- */",
      "var toiles = document.querySelectorAll('canvas');",
      "out.toiles = [];",
      "for (var i = 0; i < toiles.length; i++) {",
      "  var c = toiles[i], q = c.getBoundingClientRect(), st = getComputedStyle(c);",
      "  out.toiles.push({ id: c.id || '', classe: String(c.className || '').slice(0, 30),",
      "    l: c.width, h: c.height,",
      "    ecran: [Math.round(q.width), Math.round(q.height)],",
      "    zIndex: st.zIndex, position: st.position });",
      "}",
      "out.calques = {",
      "  canvas: !!(d.engine && d.engine.canvas),",
      "  uppercanvas: !!(d.engine && d.engine.uppercanvas),",
      "  fowcanvas: !!(d.engine && d.engine.fowcanvas),",
      "  lightingcanvas: !!(d.engine && d.engine.lightingcanvas),",
      "  canvas_overlay: !!d.canvas_overlay",
      "};",
      "if (d.canvas_overlay) { out.overlay = membres(d.canvas_overlay).slice(0, 24); }",
      "",
      "/* ---------- LE CANEVAS PRINCIPAL : QUELLE BIBLIOTHÈQUE ? ---------- */",
      "if (d.engine && d.engine.canvas) {",
      "  var cv = d.engine.canvas;",
      "  out.canvas = {",
      "    classe: cv.constructor ? String(cv.constructor.name) : null,",
      "    aFabric: typeof cv.renderAll === 'function',",
      "    objets: typeof cv.getObjects === 'function' ? cv.getObjects().length : null,",
      "    methodes: membres(cv, /add|render|remove|on|insert|bring|send/i)",
      "  };",
      "}",
      "out.fabric = typeof window.fabric !== 'undefined';",
      "",
      "/* ---------- LE RENDEZ-VOUS DE RENDU ---------- */",
      "out.rendu = {",
      "  renderLoop: d.engine ? typeof d.engine.renderLoop : null,",
      "  onAfterFOW: d.engine && d.engine.onAfterFOWRenderCallbacks",
      "    ? (d.engine.onAfterFOWRenderCallbacks.length + ' rappel(s)') : null,",
      "  pauseRender: d.engine ? d.engine.pauseRender : null",
      "};",
      "",
      "/* ---------- UN JETON, ET SA REPRÉSENTATION ---------- */",
      "try {",
      "  var g = window.Campaign.activePage().thegraphics.models;",
      "  out.jetons = g.length;",
      "  if (g.length) {",
      "    var t = g[0];",
      "    out.jeton = {",
      "      cles: Object.keys(t).slice(0, 20),",
      "      aView: !!t.view,",
      "      viewCles: t.view ? Object.keys(t.view).slice(0, 20) : null,",
      "      graphic: t.view && t.view.graphic ? (t.view.graphic.constructor ?",
      "        String(t.view.graphic.constructor.name) : 'objet') : null,",
      "      statusmarkers: t.get('statusmarkers'),",
      "      gauche: t.get('left'), haut: t.get('top'),",
      "      largeur: t.get('width'), hauteur: t.get('height')",
      "    };",
      "  }",
      "} catch (e) { out.jetons = 'erreur ' + String(e).slice(0, 50); }",
      "",
      "/* ---------- LA GRILLE ---------- */",
      "try {",
      "  var pg = window.Campaign.activePage();",
      "  out.page = { largeur: pg.get('width'), hauteur: pg.get('height'),",
      "    type: pg.get('grid_type'), opacite: pg.get('gridopacity'),",
      "    couleur: pg.get('gridcolor'), taille: pg.get('snapping_increment'),",
      "    echelle: pg.get('scale_number') };",
      "} catch (e) {}",
      "return out;"
    ].join("\n");

    const r = await driver.executeScript(LIS);
    if (r.erreur) { console.log("  " + r.erreur); return 1; }

    const bloc = function (nom, o) {
      console.log("\n  -- " + nom + " --");
      if (Array.isArray(o)) { o.forEach(function (x) { console.log("    " + JSON.stringify(x)); }); return; }
      Object.keys(o || {}).forEach(function (k) {
        console.log("    " + k.padEnd(16) + " " + JSON.stringify(o[k]));
      });
    };
    bloc("LE ZOOM", r.zoom);
    bloc("LES SURFACES", r.toiles);
    bloc("LES CALQUES", r.calques);
    if (r.overlay) { console.log("    canvas_overlay : " + JSON.stringify(r.overlay)); }
    if (r.canvas) { bloc("LE CANEVAS PRINCIPAL", r.canvas); }
    console.log("    fabric global : " + r.fabric);
    bloc("LE RENDEZ-VOUS DE RENDU", r.rendu);
    if (r.jeton) { bloc("UN JETON", r.jeton); }
    if (r.page) { bloc("LA PAGE", r.page); }

    releve("ancien-" + campagne + ".json", r);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE ZOOM DE L'ANCIEN MOTEUR, ÉPROUVÉ ----------
 *
 * Avant d'écrire une seule ligne, trois choses à savoir, et aucune ne se
 * devine :
 *
 *   1. L'ÉCHELLE. « canvasZoom » vaut 1 à cent pour cent — ce n'est donc pas
 *      la même unité que sous Jumpgate, où le magasin porte 100.
 *   2. LES BORNES. Roll20 refuse-t-il au-delà d'une certaine valeur, et
 *      lesquelles ? C'est ce qui décide s'il y a quelque chose à élargir.
 *   3. LE RETOUR. Sa propre commande de zoom repousse-t-elle la valeur dans ses
 *      bornes, comme celle de Jumpgate le fait en moins de soixante
 *      millisecondes ? Si oui, il faudra la masquer comme là-bas.
 *
 * On demande, on relit, et on remet la valeur d'origine à la fin. Campagne
 * d'essai : rien d'autre n'est touché.
 */
async function zoomAncien() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js zoomancien <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(14000);

    const depart = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "return { zoom: d.engine.canvasZoom, arite: d.engine.setZoom.length," +
      "  source: String(d.engine.setZoom).slice(0, 260) };");
    console.log("\n  zoom au départ : " + depart.zoom + "   setZoom prend " + depart.arite + " argument(s)");
    console.log("  sa source :\n    " + String(depart.source).replace(/\n/g, "\n    "));

    async function demande(v) {
      const r = await driver.executeScript(
        "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
        "try { d.engine.setZoom(arguments[0]); } catch (e) { return { erreur: String(e).slice(0, 60) }; }" +
        "return { apres: d.engine.canvasZoom };", v);
      await dors(900);
      const stable = await driver.executeScript(
        "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
        "return d.engine.canvasZoom;");
      console.log("    setZoom(" + String(v).padStart(5) + ")  →  " +
        JSON.stringify(r) + "   une seconde après : " + stable);
      return stable;
    }

    console.log("\n  -- CE QU'IL ACCEPTE --");
    for (const v of [0.5, 1, 2.5, 4, 6, 0.05]) { await demande(v); }

    /* SA COMMANDE REPOUSSE-T-ELLE ? On demande une valeur hors de ses bornes,
     * et on regarde si elle tient trois secondes. */
    console.log("\n  -- TIENT-IL LA VALEUR ? --");
    await demande(4);
    await dors(3000);
    const apres3s = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "return d.engine.canvasZoom;");
    console.log("    trois secondes plus tard : " + apres3s);

    /* Sa commande à l'écran : existe-t-elle, et que montre-t-elle ? */
    const cmd = await driver.executeScript(
      "var n = document.querySelector('#vm_zoom_buttons');" +
      "var t = document.body.textContent || '';" +
      "return { boiteJumpgate: !!n," +
      "  slider: !!document.querySelector('.el-slider__runway, input[type=range]')," +
      "  zoomAffiche: (t.match(/\\b(\\d{2,3})\\s*%/) || [])[1] || null };");
    console.log("\n  sa commande : " + JSON.stringify(cmd));

    /* ---------- PEUT-ON DÉPASSER SA BORNE ? ----------
     *
     * Sous Jumpgate, au-delà de 250 % on cesse d'écrire dans son magasin et
     * l'on ne pose plus que la caméra. Ici, « setZoom » borne LUI-MÊME par
     * « zoomSizeCheck » : lui demander 4 rend 2,5. La question est donc de
     * savoir si l'on peut écrire « canvasZoom » directement et forcer un rendu.
     *
     * On photographie avant et après, et on compare les empreintes : c'est le
     * seul juge, et le seul qui ne dépende d'aucune projection. */
    const crypto = require("crypto");
    async function empreinte(nom) {
      const t = await driver.executeScript(
        "var n = document.getElementById('babylonCanvas') || document.querySelector('canvas');" +
        "if (!n) { return null; }" +
        "var q = n.getBoundingClientRect();" +
        "return { x: Math.round(q.left), y: Math.round(q.top), l: Math.round(q.width), h: Math.round(q.height) };");
      if (!t) { return null; }
      const f = await capturePres(driver, nom + ".png", t.x, t.y, t.l, t.h, 1);
      if (!f) { return null; }
      const b = fs.readFileSync(f);
      return crypto.createHash("sha1").update(b).digest("hex").slice(0, 12);
    }

    console.log("\n-- DÉPASSER SA BORNE --");
    await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "d.engine.setZoom(1);");
    await dors(1500);
    const e100 = await empreinte("her-100");
    await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "d.engine.setZoom(2.5);");
    await dors(1500);
    const e250 = await empreinte("her-250");
    console.log("    100 % : " + e100 + "    250 % : " + e250 +
      (e100 === e250 ? "   → IDENTIQUES, l'instrument ne voit rien" : "   → le zoom se voit"));

    const force = await driver.executeScript([
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "var avant = d.engine.canvasZoom;",
      "d.engine.canvasZoom = 4;",
      "var fait = [];",
      "try { if (d.engine.canvas && d.engine.canvas.renderAll) { d.engine.canvas.renderAll(); fait.push('renderAll'); } } catch (e) {}",
      "try { if (d.canvas_overlay && d.canvas_overlay.compositeCanvases) { d.canvas_overlay.compositeCanvases(); fait.push('composite'); } } catch (e) {}",
      "try { if (d.canvas_overlay && d.canvas_overlay.drawGrid) { d.canvas_overlay.drawGrid(); fait.push('drawGrid'); } } catch (e) {}",
      "return { avant: avant, apres: d.engine.canvasZoom, fait: fait };"
    ].join(String.fromCharCode(10)));
    await dors(2000);
    const e400 = await empreinte("her-400");
    console.log("    écriture directe : " + JSON.stringify(force));
    console.log("    après : " + e400 +
      (e400 !== e250 ? "   → L'IMAGE A CHANGÉ" : "   → rien"));

    await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "d.engine.setZoom(arguments[0]);", depart.zoom);
    console.log("  zoom remis à " + depart.zoom);

    releve("zoom-ancien-" + campagne + ".json", { depart: depart, apres3s: apres3s, cmd: cmd });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- OÙ TOMBE UN JETON SUR SON CANEVAS ? ----------
 *
 * Les trois modules manquants dépendent d'une seule chose : savoir convertir
 * les coordonnées d'un jeton — celles de la page, en pixels de carte — en
 * coordonnées de son canevas. Sans ça, ni marqueur ni grille ne peuvent être
 * peints au bon endroit.
 *
 * ET ON NE SE FIERA PAS À UN CALCUL NON CONTRÔLÉ. La leçon a été payée deux
 * fois : une projection écran écrite à la main, jamais éprouvée, a invalidé
 * toute une enquête. Ici, on DESSINE un repère à l'endroit calculé et on
 * regarde s'il tombe sur le jeton. C'est le seul contrôle qui vaille.
 *
 * On relève d'abord tout ce qui peut servir à la conversion, puis on peint.
 */
async function reperesHeritage() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js reperes2 <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(14000);

    const etat = await driver.executeScript([
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "var cv = d.engine.canvas;",
      "var el = cv.lowerCanvasEl || document.getElementById('babylonCanvas');",
      "var out = {",
      "  zoom: d.engine.canvasZoom,",
      "  offset: d.engine.currentCanvasOffset,",
      "  canvasWH: [d.engine.canvasWidth, d.engine.canvasHeight],",
      "  elementWH: el ? [el.width, el.height] : null,",
      "  vpt: cv.viewportTransform || null,",
      "  fabricZoom: typeof cv.getZoom === 'function' ? cv.getZoom() : null,",
      "  contexte: typeof cv.getContext === 'function',",
      "  lower: !!cv.lowerCanvasEl, upper: !!cv.upperCanvasEl",
      "};",
      "try {",
      "  var g = window.Campaign.activePage().thegraphics.models;",
      "  out.jetons = g.map(function (t) {",
      "    var f = t.view && t.view.fabric ? t.view.fabric : (t.fabric || null);",
      "    return { id: String(t.id).slice(-6),",
      "      gauche: t.get('left'), haut: t.get('top'),",
      "      l: t.get('width'), h: t.get('height'),",
      "      couche: t.get('layer'),",
      "      fabric: f ? { left: f.left, top: f.top, width: f.width, height: f.height,",
      "        scaleX: f.scaleX, scaleY: f.scaleY, angle: f.angle, visible: f.visible } : null };",
      "  }).slice(0, 6);",
      "} catch (e) { out.jetons = 'erreur ' + String(e).slice(0, 50); }",
      "var pg = window.Campaign.activePage();",
      "out.page = { l: pg.get('width') * 70, h: pg.get('height') * 70,",
      "  pas: pg.get('snapping_increment'), echelle: pg.get('scale_number'),",
      "  couleur: pg.get('gridcolor'), opacite: pg.get('gridopacity') };",
      "return out;"
    ].join("\n"));
    console.log("\n  -- CE QUI SERT À CONVERTIR --");
    Object.keys(etat).forEach(function (k) {
      if (k === "jetons") { return; }
      console.log("    " + k.padEnd(14) + " " + JSON.stringify(etat[k]));
    });
    console.log("  -- LES JETONS --");
    (etat.jetons || []).forEach(function (t) {
      console.log("    …" + t.id + "  page(" + t.gauche + ", " + t.haut + ")  " +
        t.l + "×" + t.h + "  " + t.couche + "   fabric " + JSON.stringify(t.fabric));
    });

    /* ---------- CE QUE SON CANEVAS CONTIENT VRAIMENT ----------
     *
     * « t.view.fabric » a toutes ses propriétés à null : ce n'est pas l'objet
     * de dessin. On énumère donc les objets du canevas et on les rapproche des
     * jetons par leur taille et leur position — c'est ce que fait n'importe qui
     * devant une bibliothèque qu'il ne connaît pas. */
    const objets = await driver.executeScript([
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "var cv = d.engine.canvas;",
      "var o = cv.getObjects ? cv.getObjects() : [];",
      "var out = [];",
      "for (var i = 0; i < o.length && i < 14; i++) {",
      "  var x = o[i];",
      "  out.push({ i: i, type: x.type || (x.constructor ? x.constructor.name : '?'),",
      "    left: x.left, top: x.top, w: x.width, h: x.height,",
      "    sx: x.scaleX, sy: x.scaleY, visible: x.visible,",
      "    model: x.model ? String(x.model.id).slice(-6) : null,",
      "    cles: Object.keys(x).filter(function (k) { return /model|id|src|token/i.test(k); }).slice(0, 6) });",
      "}",
      "return { total: o.length, objets: out,",
      "  cvCles: Object.keys(cv).filter(function (k) { return /zoom|offset|transform|scale|pan/i.test(k); }).slice(0, 14) };"
    ].join(String.fromCharCode(10)));
    console.log("\n-- SES OBJETS (" + objets.total + ") --");
    (objets.objets || []).forEach(function (x) {
      console.log("    [" + x.i + "] " + String(x.type).padEnd(10) +
        " (" + Math.round(x.left) + ", " + Math.round(x.top) + ")  " +
        Math.round(x.w) + "×" + Math.round(x.h) + "  ×" + x.sx +
        "  vis " + x.visible + "  model " + x.model + "  " + JSON.stringify(x.cles));
    });
    console.log("    canevas : " + JSON.stringify(objets.cvCles));
    /* ---------- ON PEINT UN REPÈRE, ET ON REGARDE ----------
     *
     * Ce que le relevé apprend : ses objets de canevas portent « left » et
     * « top » DANS LES COORDONNÉES DE LA PAGE — les mêmes que le jeton — et un
     * « .model » qui pointe le jeton. La conversion vers les pixels du canevas
     * est donc simplement (page − décalage) × zoom.
     *
     * MAIS FABRIC REMET SA TRANSFORMATION À L'IDENTITÉ en sortant de renderAll.
     * Peindre après lui en coordonnées de page tomberait donc n'importe où : il
     * faut appliquer la conversion soi-même. C'est exactement ce qu'on vérifie.
     *
     * Un cadre rouge sur CHAQUE jeton, et l'on regarde s'ils tombent dessus.
     */
    const peint = await driver.executeScript([
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "var cv = d.engine.canvas;",
      "var ctx = null;   /* il sera celui de NOTRE calque, pas de Fabric */",
      "var g = window.Campaign.activePage().thegraphics.models;",
      "/* On retrouve l'objet de dessin de chaque jeton par son modèle. */",
      "var parModele = {};",
      "(cv.getObjects() || []).forEach(function (o) {",
      "  if (o && o.model && o.model.id) { parModele[o.model.id] = o; }",
      "});",
      "var vus = [];",
      "function peinsUnCoup() {",
      "  var z = d.engine.canvasZoom || 1;",
      "  var off = d.engine.currentCanvasOffset || [0, 0];",
      "  ctx.save();",
      "  ctx.strokeStyle = 'rgb(255,0,0)';",
      "  ctx.lineWidth = 4;",
      "  g.forEach(function (t) {",
      "    var o = parModele[t.id];",
      "    var px = o ? o.left : t.get('left');",
      "    var py = o ? o.top : t.get('top');",
      "    var w = (o ? o.width * (o.scaleX || 1) : t.get('width'));",
      "    var h = (o ? o.height * (o.scaleY || 1) : t.get('height'));",
      "    var x = (px - off[0]) * z, y = (py - off[1]) * z;",
      "    ctx.strokeRect(x - w * z / 2, y - h * z / 2, w * z, h * z);",
      "  });",
      "  ctx.restore();",
      "}",
      "/* TROIS ESSAIS, ET LE TROISIÈME TOMBE JUSTE.",
      "",
      "   1. Enveloppé « renderAll » : il a peint, sans erreur — RIEN À L'ÉCRAN.",
      "   2. Poussé un rappel dans « onAfterFOWRenderCallbacks » : JAMAIS APPELÉ,",
      "      ce rendez-vous n'existe que si le brouillard rend.",
      "   3. Énuméré les surfaces : IL N'Y A QU'UN SEUL CANEVAS AU DOCUMENT, et",
      "      ce n'est ni « lowerCanvasEl » ni « upperCanvasEl ». Le canevas de",
      "      Fabric est un TAMPON HORS ÉCRAN ; on peignait dans le vide.",
      "",
      "   Mais la même mesure donne la sortie. Le jeton du modèle est en page",
      "   (357, 880) ; sur la photo il est à l'écran en (357, 875), et la surface",
      "   commence en (0, 0) : « (page − décalage) × zoom » tombe juste. On ne",
      "   touche donc RIEN de son rendu — on pose NOTRE calque par-dessus.",
      "",
      "   C'est aussi ce que fera l'extension : indépendant de Fabric, indépendant",
      "   de sa boucle, indépendant de sa couche WebGL. */",
      "var vis = null, toutes = document.querySelectorAll('canvas');",
      "for (var i = 0; i < toutes.length; i++) {",
      "  if (toutes[i] !== cv.lowerCanvasEl && toutes[i] !== cv.upperCanvasEl) { vis = toutes[i]; break; }",
      "}",
      "if (!vis) { return { erreur: 'aucune surface visible' }; }",
      "var q = vis.getBoundingClientRect();",
      "var mien = document.getElementById('vttk-calque');",
      "if (!mien) {",
      "  mien = document.createElement('canvas');",
      "  mien.id = 'vttk-calque';",
      "  mien.style.cssText = 'position:fixed;pointer-events:none;z-index:9;';",
      "  vis.parentNode.appendChild(mien);",
      "}",
      "mien.width = vis.width; mien.height = vis.height;",
      "mien.style.left = q.left + 'px'; mien.style.top = q.top + 'px';",
      "mien.style.width = q.width + 'px'; mien.style.height = q.height + 'px';",
      "ctx = mien.getContext('2d');",
      "window.__vttkPeint = 0;",
      "window.__vttkOu = 'calque propre';",
      "try { peinsUnCoup(); window.__vttkPeint++; } catch (e) { window.__vttkErr = String(e).slice(0, 70); }",
      "window.__vttkSurf = [{ id: vis.id || '?', ecran: [Math.round(q.left), Math.round(q.top),",
      "  Math.round(q.width), Math.round(q.height)], interne: [vis.width, vis.height],",
      "  ctx2d: !!ctx, dpr: window.devicePixelRatio }];",
      "g.forEach(function (t) {",
      "  var o = parModele[t.id];",
      "  vus.push({ id: String(t.id).slice(-6), trouve: !!o,",
      "    objet: o ? [Math.round(o.left), Math.round(o.top), Math.round(o.width * (o.scaleX || 1))] : null,",
      "    modele: [Math.round(t.get('left')), Math.round(t.get('top')), Math.round(t.get('width'))] });",
      "});",
      "return { peints: window.__vttkPeint, compo: window.__vttkCompo, ou: window.__vttkOu,",
      "  err: window.__vttkErr || null, surfaces: window.__vttkSurf,",
      "  zoom: d.engine.canvasZoom, offset: d.engine.currentCanvasOffset, jetons: vus };"
    ].join("\n"));
    console.log(String.fromCharCode(10) + "  -- LE REPÈRE --");
    console.log("    " + JSON.stringify(peint, null, 2).split(String.fromCharCode(10)).join(String.fromCharCode(10) + "    "));

    await dors(3000);
    await capture(driver, "reperes-heritage.png");
    const encore = await driver.executeScript("return window.__vttkPeint;");
    console.log("    peintures cumulées après trois secondes : " + encore);

    /* On retire notre enveloppe : on ne laisse pas une page instrumentée. */
    await driver.executeScript(
      "var n = document.getElementById('vttk-calque'); if (n) { n.remove(); }");

    releve("reperes-heritage-" + campagne + ".json", { etat: etat, peint: peint });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUI COMMANDE LE ZOOM EN HÉRITAGE ? ----------
 *
 * Le client neuf sert les DEUX moteurs, et sa commande de zoom est la même à
 * l'écran : même chiffre, mêmes boutons, même glisseur. Mais dessous, deux
 * candidats s'offrent, et l'écart entre eux décide de tout le module :
 *
 *   · LE MAGASIN PINIA, comme sous Jumpgate — auquel cas le module existant
 *     marche presque tel quel, et il n'y a qu'à remplacer la pose de caméra ;
 *   · « d20.engine », l'ancien moteur — auquel cas il faut un second module.
 *
 * ON NE DEVINE PAS : on appelle chaque voie, et on regarde CE QUI BOUGE de
 * l'autre côté. Une voie qui entraîne l'autre est la vraie ; une voie qui ne
 * bouge que soi-même est un miroir.
 *
 * Campagne d'essai, et l'on remet le zoom de départ à la fin.
 */
async function quiCommandeLeZoom() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js commande <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const PREAMBULE = [
      "function racines() {",
      "  var out = [], n = document.querySelectorAll('div,body>*');",
      "  for (var i = 0; i < n.length; i++) { if (n[i].__vue_app__) { out.push(n[i]); } }",
      "  return out;",
      "}",
      "function magasin(nom) {",
      "  var r = racines();",
      "  for (var i = 0; i < r.length; i++) {",
      "    try {",
      "      var p = r[i].__vue_app__.config.globalProperties.$pinia;",
      "      if (p && p._s && p._s.get(nom)) { return p._s.get(nom); }",
      "    } catch (e) {}",
      "  }",
      "  return null;",
      "}",
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;"
    ].join("\n");

    const etat = await driver.executeScript(PREAMBULE + "\n" + [
      "var st = magasin('engine');",
      "var out = { pinia: !!st, d20: !!(d && d.engine) };",
      "if (st) {",
      "  out.zoomPinia = st.zoom;",
      "  out.actions = ['setZoom','setZoomSilent','stepAdjustZoom','zoom']",
      "    .map(function (k) { return k + ':' + typeof st[k]; });",
      "}",
      "if (d && d.engine) { out.zoomD20 = d.engine.canvasZoom; }",
      "return out;"
    ].join("\n"));
    console.log("\n  -- LES DEUX CANDIDATS --");
    Object.keys(etat).forEach(function (k) { console.log("    " + k.padEnd(12) + " " + JSON.stringify(etat[k])); });

    /* L'ÉPREUVE : on pousse par une voie, on relit LES DEUX. */
    async function pousse(voie, code, valeur) {
      const r = await driver.executeScript(PREAMBULE + "\n" + [
        "var st = magasin('engine');",
        "var av = { pinia: st ? st.zoom : null, d20: d.engine.canvasZoom };",
        "try { " + code + " } catch (e) { return { erreur: String(e).slice(0, 70), av: av }; }",
        "return { av: av };"
      ].join("\n"), valeur);
      await dors(1200);
      const ap = await driver.executeScript(PREAMBULE + "\n" +
        "var st = magasin('engine');" +
        "return { pinia: st ? st.zoom : null, d20: d.engine.canvasZoom };");
      const bouge = function (a, b) { return a === b ? "        —" : (" " + JSON.stringify(a) + " → " + JSON.stringify(b)); };
      console.log("    " + voie.padEnd(26) +
        "  Pinia" + bouge(r.av ? r.av.pinia : null, ap.pinia) +
        "   d20" + bouge(r.av ? r.av.d20 : null, ap.d20) +
        (r.erreur ? "   (" + r.erreur + ")" : ""));
      return ap;
    }

    console.log("\n  -- QUI ENTRAÎNE QUI --");
    await pousse("Pinia.setZoom(150)", "st.setZoom(arguments[0]);", 150);
    await pousse("d20.engine.setZoom(2)", "d.engine.setZoom(arguments[0]);", 2);
    await pousse("Pinia.setZoom(100)", "st.setZoom(arguments[0]);", 100);

    /* ET LA MOLETTE : par où passe-t-elle ? On la simule sur la toile. */
    const molette = await driver.executeScript(PREAMBULE + "\n" + [
      "var st = magasin('engine');",
      "var av = { pinia: st ? st.zoom : null, d20: d.engine.canvasZoom };",
      "var cv = document.getElementById('babylonCanvas');",
      "if (!cv) { return { erreur: 'pas de toile' }; }",
      "var q = cv.getBoundingClientRect();",
      "cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -102, bubbles: true, cancelable: true,",
      "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));",
      "return { av: av };"
    ].join("\n"));
    await dors(1200);
    const apMol = await driver.executeScript(PREAMBULE + "\n" +
      "var st = magasin('engine');" +
      "return { pinia: st ? st.zoom : null, d20: d.engine.canvasZoom };");
    console.log("    " + "un cran de molette".padEnd(26) + "  Pinia " +
      JSON.stringify(molette.av ? molette.av.pinia : null) + " → " + JSON.stringify(apMol.pinia) +
      "   d20 " + JSON.stringify(molette.av ? molette.av.d20 : null) + " → " + JSON.stringify(apMol.d20));

    /* LA BORNE : jusqu'où chacun accepte-t-il d'aller ? */
    console.log("\n  -- LES BORNES DE CHACUN --");
    for (const v of [400, 800]) { await pousse("Pinia.setZoom(" + v + ")", "st.setZoom(arguments[0]);", v); }
    await pousse("ecriture directe canvasZoom", "d.engine.canvasZoom = arguments[0]; d.engine.canvas.renderAll();", 4);
    await capture(driver, "qui-commande.png");
    await pousse("Pinia.setZoom(100)", "st.setZoom(arguments[0]);", 100);

    releve("qui-commande-" + campagne + ".json", { etat: etat });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE PAS DE L'ANCIEN MOTEUR, ET SES COMMANDES ----------
 *
 * Deux questions, et le module entier en dépend :
 *
 *   1. PAR OÙ PASSENT LES BOUTONS ET LE GLISSEUR ? Le magasin « engine » de
 *      Pinia est VIDE en héritage — mesuré — alors que la commande à l'écran
 *      est la même que sous Jumpgate. Elle s'alimente donc ailleurs, et il faut
 *      savoir où pour l'intercepter.
 *   2. LE PAS DE LA MOLETTE EST-IL ADDITIF OU GÉOMÉTRIQUE ? Sous Jumpgate il
 *      est additif (12,875 par cran) et le prolongement doit valoir exactement
 *      ça À LA BORNE pour ne pas se sentir. Un cran mesuré ici donne
 *      2 → 2,0858 : les deux lectures collent. Il en faut trois pour trancher.
 *
 * LECTURE ET MOLETTE SEULEMENT — on ne remplace rien, et le zoom revient à sa
 * valeur de départ.
 */
async function pasDeLancien() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js pasancien <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const PRE = [
      "function racines() {",
      "  var out = [], n = document.querySelectorAll('div,body>*');",
      "  for (var i = 0; i < n.length; i++) { if (n[i].__vue_app__) { out.push(n[i]); } }",
      "  return out;",
      "}",
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;"
    ].join("\n");

    /* ---------- 1. TOUS LES MAGASINS, ET CELUI QUI PORTE UN ZOOM ---------- */
    const mags = await driver.executeScript(PRE + "\n" + [
      "var out = { magasins: [], porteurs: [] };",
      "var r = racines();",
      "for (var i = 0; i < r.length; i++) {",
      "  try {",
      "    var p = r[i].__vue_app__.config.globalProperties.$pinia;",
      "    if (!p || !p._s) { continue; }",
      "    p._s.forEach(function (st, nom) {",
      "      if (out.magasins.indexOf(nom) < 0) { out.magasins.push(nom); }",
      "      var cles = [];",
      "      for (var k in st) { if (/zoom/i.test(k)) { cles.push(k + ':' + typeof st[k]); } }",
      "      if (cles.length) { out.porteurs.push({ magasin: nom, cles: cles }); }",
      "    });",
      "  } catch (e) {}",
      "}",
      "return out;"
    ].join("\n"));
    console.log("\n  -- LES MAGASINS DE PINIA --");
    console.log("    " + (mags.magasins || []).join(", "));
    console.log("  -- CEUX QUI PARLENT DE ZOOM --");
    (mags.porteurs || []).forEach(function (x) {
      console.log("    " + String(x.magasin).padEnd(18) + " " + x.cles.join("  "));
    });

    /* ---------- 2. LA COMMANDE À L'ÉCRAN : QUE MONTRE-T-ELLE ? ---------- */
    const cmd = await driver.executeScript(PRE + "\n" + [
      "var t = document.body.textContent || '';",
      "return { chiffre: (t.match(/\b(\d{2,3})\s*%?/) || [])[1] || null,",
      "  boiteZoom: !!document.querySelector('#vm_zoom_buttons, .zoom-controls'),",
      "  glisseur: !!document.querySelector('input[type=range], .el-slider__runway'),",
      "  boutons: document.querySelectorAll('button').length };"
    ].join("\n"));
    console.log("\n  sa commande : " + JSON.stringify(cmd));

    /* ---------- 3. LE PAS, MESURÉ À TROIS ALTITUDES ---------- */
    const depart = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
    console.log("\n  -- LE PAS DE LA MOLETTE, TROIS FOIS --");
    console.log("    " + "depart".padEnd(10) + "  " + "un cran".padEnd(22) + "  ecart      rapport");
    for (const z of [0.5, 1, 2, 2.5]) {
      await driver.executeScript(PRE + "\nd.engine.setZoom(arguments[0]);", z);
      await dors(700);
      const av = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
      await driver.executeScript(PRE + "\n" + [
        "var cv = document.getElementById('babylonCanvas');",
        "var q = cv.getBoundingClientRect();",
        "cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -102, bubbles: true, cancelable: true,",
        "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));"
      ].join("\n"));
      await dors(900);
      const ap = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
      console.log("    " + String(av).padEnd(10) + "  " + String(ap).padEnd(22) +
        "  " + (Math.round((ap - av) * 1e6) / 1e6 + "").padEnd(10) +
        " " + (av ? Math.round((ap / av) * 1e6) / 1e6 : "-"));
    }

    /* ---------- 4. LA MOLETTE S'ARRÊTE-T-ELLE À SA BORNE ? ---------- */
    console.log("\n  -- ET AU-DELÀ DE 250 % --");
    await driver.executeScript(PRE + "\nd.engine.setZoom(2.5);");
    await dors(700);
    for (let i = 0; i < 3; i++) {
      const av = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
      await driver.executeScript(PRE + "\n" + [
        "var cv = document.getElementById('babylonCanvas');",
        "var q = cv.getBoundingClientRect();",
        "cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -102, bubbles: true, cancelable: true,",
        "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));"
      ].join("\n"));
      await dors(900);
      const ap = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
      console.log("    cran " + (i + 1) + " : " + av + " → " + ap + (av === ap ? "   (bloque)" : ""));
    }

    /* ---------- 5. QUI ÉCOUTE LA MOLETTE, ET SUR QUOI ? ---------- */
    const ecoute = await driver.executeScript(PRE + "\n" + [
      "var out = { surEngine: [] };",
      "for (var k in d.engine) { if (/wheel|scroll|mouse/i.test(k)) { out.surEngine.push(k + ':' + typeof d.engine[k]); } }",
      "out.zoomFns = [];",
      "for (var k2 in d.engine) { if (/zoom/i.test(k2)) { out.zoomFns.push(k2 + ':' + typeof d.engine[k2]); } }",
      "return out;"
    ].join("\n"));
    console.log("\n  -- CE QUE d20.engine EXPOSE --");
    console.log("    molette : " + (ecoute.surEngine || []).join("  "));
    console.log("    zoom    : " + (ecoute.zoomFns || []).join("  "));

    await driver.executeScript(PRE + "\nd.engine.setZoom(arguments[0]);", depart);
    console.log("\n  zoom remis a " + depart);
    releve("pas-ancien-" + campagne + ".json", { magasins: mags, cmd: cmd, ecoute: ecoute });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE MAGASIN QUI ALIMENTE SA COMMANDE ----------
 *
 * En héritage, le magasin « engine » de Pinia est VIDE : ni zoom ni setZoom.
 * Mais la commande à l'écran affiche bien un chiffre, et un autre magasin porte
 * un zoom — « vttTools_tabletopState ». C'est donc lui qu'elle lit.
 *
 * Trois choses à en savoir, et le module de zoom en dépend entièrement :
 *
 *   1. SON UNITÉ. « engine.canvasZoom » vaut 1 à cent pour cent ; ce magasin-là
 *      affiche peut-être 100. Se tromper d'unité, c'est un facteur cent.
 *   2. SES ACTIONS. S'il en porte, ce sont elles que pressent les boutons + / −
 *      et le glisseur — donc elles qu'il faut remplacer, comme sous Jumpgate.
 *   3. LE SENS DU LIEN. Suit-il « canvasZoom » quand on l'écrit directement ?
 *      Si oui, la commande affichera nos valeurs hors plage sans qu'on la
 *      touche ; sinon il faudra l'écrire nous-mêmes.
 *
 * Et une quatrième, qui décide de la peine : ROLL20 REPREND-IL LA MAIN ? On
 * pousse à 400 %, on attend cinq secondes, on relit.
 */
async function tableauDeBordAncien() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js tablo <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const PRE = [
      "function mag(nom) {",
      "  var n = document.querySelectorAll('div,body>*');",
      "  for (var i = 0; i < n.length; i++) {",
      "    try {",
      "      var p = n[i].__vue_app__ && n[i].__vue_app__.config.globalProperties.$pinia;",
      "      if (p && p._s && p._s.get(nom)) { return p._s.get(nom); }",
      "    } catch (e) {}",
      "  }",
      "  return null;",
      "}",
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "var T = mag('vttTools_tabletopState');"
    ].join("\n");

    const quoi = await driver.executeScript(PRE + "\n" + [
      "if (!T) { return { erreur: 'magasin absent' }; }",
      "var cles = [], fns = [];",
      "for (var k in T) {",
      "  if (/^[$_]/.test(k)) { continue; }",
      "  try { if (typeof T[k] === 'function') { fns.push(k); } else { cles.push(k + '=' + JSON.stringify(T[k]).slice(0, 40)); } } catch (e) {}",
      "}",
      "return { zoom: T.zoom, canvasZoom: d.engine.canvasZoom, cles: cles, fns: fns };"
    ].join("\n"));
    console.log("\n  -- vttTools_tabletopState --");
    console.log("    son zoom : " + quoi.zoom + "     canvasZoom : " + quoi.canvasZoom);
    console.log("    valeurs  : " + (quoi.cles || []).join("  "));
    console.log("    actions  : " + (quoi.fns || []).join("  "));

    /* LE SENS DU LIEN, dans les deux directions. */
    async function voir(titre, code, v) {
      const r = await driver.executeScript(PRE + "\ntry { " + code + " } catch (e) { return String(e).slice(0, 70); } return null;", v);
      await dors(1200);
      const ap = await driver.executeScript(PRE + "\nreturn { T: T ? T.zoom : null, d20: d.engine.canvasZoom };");
      console.log("    " + titre.padEnd(34) + " → magasin " + String(ap.T).padEnd(8) + " canvasZoom " + ap.d20 + (r ? "   (" + r + ")" : ""));
      return ap;
    }
    console.log("\n  -- QUI SUIT QUI --");
    await voir("d20.engine.setZoom(1.5)", "d.engine.setZoom(arguments[0]);", 1.5);
    await voir("canvasZoom = 4 + renderAll", "d.engine.canvasZoom = arguments[0]; d.engine.canvas.renderAll();", 4);
    await voir("  puis compositeCanvases", "if (d.canvas_overlay && d.canvas_overlay.compositeCanvases) { d.canvas_overlay.compositeCanvases(); }", 0);
    await capture(driver, "tablo-400.png");

    /* ROLL20 REPREND-IL ? */
    await dors(5000);
    const apres = await driver.executeScript(PRE + "\nreturn { T: T ? T.zoom : null, d20: d.engine.canvasZoom };");
    console.log("\n    cinq secondes plus tard        → magasin " + apres.T + "  canvasZoom " + apres.d20 +
      (apres.d20 === 4 ? "   (IL TIENT)" : "   (REPRIS)"));

    /* ET SI L'ON ÉCRIT LE MAGASIN, LA CARTE BOUGE-T-ELLE ? */
    await voir("magasin.zoom = 400 (seul)", "T.zoom = arguments[0];", 400);

    await driver.executeScript(PRE + "\nd.engine.setZoom(1);");
    console.log("\n  zoom remis a 1");
    releve("tablo-" + campagne + ".json", { quoi: quoi, apres: apres });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- Y A-T-IL UNE SEULE PORTE ? ----------
 *
 * Sous Jumpgate il y en avait trois — molette, boutons, glisseur —, et la
 * molette n'en franchissait aucune : elle appelait « setZoomSilent »
 * directement. C'est ce qui a imposé un écouteur de molette sur la fenêtre,
 * posé en capture et non passif, donc le morceau le plus cher et le plus
 * risqué du module.
 *
 * En héritage, RIEN NE DIT QU'IL EN VA DE MÊME. Si les trois commandes
 * passent toutes par « d20.engine.setZoom », le remplacer suffit : pas
 * d'écouteur global, pas de coût sur chaque défilement de la page.
 *
 * ON COMPTE. On enveloppe les trois fonctions de zoom qu'expose d20.engine,
 * on fait un cran de molette, puis on presse le bouton « + » à l'écran, et on
 * regarde ce qui a été appelé. Les enveloppes sont retirées à la fin.
 */
async function porteDuZoom() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js porte <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const PRE = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";

    await driver.executeScript(PRE + "\n" + [
      "window.__vk = { setZoom: 0, slideZoom: 0, debounced_setZoom: 0, args: [] };",
      "window.__vkNatif = {};",
      "['setZoom', 'slideZoom', 'debounced_setZoom'].forEach(function (n) {",
      "  if (typeof d.engine[n] !== 'function') { return; }",
      "  window.__vkNatif[n] = d.engine[n];",
      "  d.engine[n] = function () {",
      "    window.__vk[n]++;",
      "    if (window.__vk.args.length < 8) { window.__vk.args.push(n + '(' + [].slice.call(arguments).join(', ') + ')'); }",
      "    return window.__vkNatif[n].apply(this, arguments);",
      "  };",
      "});",
      "return Object.keys(window.__vkNatif);"
    ].join("\n"));

    async function compte(titre, code) {
      await driver.executeScript(PRE + "\nwindow.__vk.setZoom = window.__vk.slideZoom = window.__vk.debounced_setZoom = 0; window.__vk.args = [];");
      await driver.executeScript(PRE + "\n" + code);
      await dors(1200);
      const r = await driver.executeScript("return window.__vk;");
      console.log("    " + titre.padEnd(24) + " setZoom " + r.setZoom +
        "   slideZoom " + r.slideZoom + "   debounced " + r.debounced_setZoom);
      if (r.args && r.args.length) { console.log("      " + r.args.join("  ")); }
      return r;
    }

    console.log("\n  -- QUELLE PORTE CHAQUE COMMANDE FRANCHIT --");
    await compte("un cran de molette", [
      "var cv = document.getElementById('babylonCanvas');",
      "var q = cv.getBoundingClientRect();",
      "cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -102, bubbles: true, cancelable: true,",
      "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));"
    ].join("\n"));

    /* LE BOUTON « + » : on le trouve par sa boite de zoom, pas par un texte. */
    const boutons = await driver.executeScript([
      "var b = document.querySelectorAll('#vm_zoom_buttons button, .zoom-controls button');",
      "return { combien: b.length, titres: [].slice.call(b).map(function (x) {",
      "  return (x.getAttribute('aria-label') || x.title || x.textContent || '').trim().slice(0, 20); }) };"
    ].join("\n"));
    console.log("\n    ses boutons de zoom : " + JSON.stringify(boutons));

    if (boutons.combien) {
      await compte("le bouton [0]", "document.querySelectorAll('#vm_zoom_buttons button, .zoom-controls button')[0].click();");
      if (boutons.combien > 1) {
        await compte("le bouton [1]", "document.querySelectorAll('#vm_zoom_buttons button, .zoom-controls button')[1].click();");
      }
    }

    await driver.executeScript(PRE + "\n" + [
      "Object.keys(window.__vkNatif || {}).forEach(function (n) { d.engine[n] = window.__vkNatif[n]; });",
      "d.engine.setZoom(1);"
    ].join("\n"));
    console.log("\n  enveloppes retirees, zoom remis a 1");
    releve("porte-" + campagne + ".json", { boutons: boutons });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- L'APPELANT BORNE-T-IL AVANT D'APPELER ? ----------
 *
 * C'est LA question qui décide de la forme du module, et elle a déjà coûté
 * cher sous Jumpgate : là-bas, chaque commande bornait AVANT d'appeler, et
 * collée à la borne elle n'appelait plus du tout. Remplacer sa fonction de
 * zoom ne servait donc à rien, et il a fallu un écouteur de molette sur la
 * fenêtre — le morceau le plus cher du module.
 *
 * En héritage, la molette passe par « slideZoom(valeurAbsolue) ». Si, arrivée
 * à 250 %, elle appelle encore slideZoom — fût-ce avec 2,5 —, alors le
 * remplacer suffit et l'écouteur global disparaît. Si elle cesse d'appeler,
 * il faudra l'intercepter comme là-bas.
 *
 * ON POSE UN MOUCHARD SUR LES DEUX PORTES, on se colle à chaque borne, et on
 * tourne la molette. Ce qui est appelé, et avec quoi, tranche.
 */
async function borneDeLancien() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js borne <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const PRE = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";

    await driver.executeScript(PRE + "\n" + [
      "window.__vkN = {};",
      "window.__vk = [];",
      "['setZoom', 'slideZoom'].forEach(function (n) {",
      "  window.__vkN[n] = d.engine[n];",
      "  d.engine[n] = function () {",
      "    window.__vk.push(n + '(' + [].slice.call(arguments).join(', ') + ')');",
      "    return window.__vkN[n].apply(this, arguments);",
      "  };",
      "});"
    ].join("\n"));

    async function cran(z, sens) {
      await driver.executeScript(PRE + "\nwindow.__vkN.setZoom.call(d.engine, arguments[0]);", z);
      await dors(900);
      await driver.executeScript("window.__vk = [];");
      const av = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
      await driver.executeScript([
        "var cv = document.getElementById('babylonCanvas');",
        "var q = cv.getBoundingClientRect();",
        "cv.dispatchEvent(new WheelEvent('wheel', { deltaY: arguments[0], bubbles: true, cancelable: true,",
        "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));"
      ].join("\n"), sens > 0 ? -102 : 102);
      await dors(1000);
      const r = await driver.executeScript(PRE + "\nreturn { appels: window.__vk, apres: d.engine.canvasZoom };");
      console.log("    depuis " + String(av).padEnd(6) + (sens > 0 ? " vers le haut" : " vers le bas ") +
        "  →  " + String(r.apres).padEnd(20) +
        (r.appels.length ? "  " + r.appels.join(" ") : "  AUCUN APPEL"));
      return r;
    }

    console.log("\n  -- LA MOLETTE, COLLEE A CHAQUE BORNE --");
    await cran(2.5, +1);      // borne haute, on pousse encore
    await cran(2.4, +1);      // juste en dessous : le dernier cran natif
    await cran(0.1, -1);      // borne basse, on pousse encore
    await cran(0.15, -1);     // juste au-dessus

    /* ET LES BOUTONS, MEME EPREUVE. */
    console.log("\n  -- LES BOUTONS, COLLES A LA BORNE HAUTE --");
    await driver.executeScript(PRE + "\nwindow.__vkN.setZoom.call(d.engine, 2.5);");
    await dors(900);
    await driver.executeScript("window.__vk = [];");
    await driver.executeScript("var b = document.querySelectorAll('#vm_zoom_buttons button, .zoom-controls button'); if (b[0]) { b[0].click(); }");
    await dors(1000);
    const bh = await driver.executeScript(PRE + "\nreturn { appels: window.__vk, apres: d.engine.canvasZoom };");
    console.log("    « + » depuis 2.5  →  " + bh.apres + (bh.appels.length ? "   " + bh.appels.join(" ") : "   AUCUN APPEL"));

    /* SA FONCTION BORNE-T-ELLE ELLE-MEME ? On l'appelle hors plage. */
    console.log("\n  -- SES PROPRES FONCTIONS, APPELEES HORS PLAGE --");
    for (const v of [4, 0.02]) {
      await driver.executeScript(PRE + "\nwindow.__vkN.setZoom.call(d.engine, arguments[0]);", v);
      await dors(800);
      const z1 = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
      await driver.executeScript(PRE + "\nwindow.__vkN.slideZoom.call(d.engine, arguments[0]);", v);
      await dors(800);
      const z2 = await driver.executeScript(PRE + "\nreturn d.engine.canvasZoom;");
      console.log("    setZoom(" + v + ") → " + z1 + "     slideZoom(" + v + ") → " + z2);
    }

    await driver.executeScript(PRE + "\n" + [
      "Object.keys(window.__vkN || {}).forEach(function (n) { d.engine[n] = window.__vkN[n]; });",
      "d.engine.setZoom(1);"
    ].join("\n"));
    console.log("\n  mouchards retires, zoom remis a 1");
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE SON setZoom FAIT VRAIMENT ----------
 *
 * On sait qu'il borne à 0,1–2,5, et qu'écrire « canvasZoom » directement puis
 * appeler « renderAll » change bien l'image. Mais « change bien l'image » ne
 * suffit pas : son setZoom fait forcément AUTRE CHOSE — recentrer, redimen-
 * sionner ses toiles, prévenir sa couche WebGL, retenir la valeur. Reproduire
 * la moitié de son travail donnerait une carte juste et un état de travers.
 *
 * On lit donc la source des trois fonctions. C'est la seule façon de savoir
 * exactement ce qu'il faut refaire à notre valeur — et ce qu'il ne faut PAS
 * refaire.
 *
 * LECTURE PURE : on ne touche à rien.
 */
async function sourceDuZoom() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js srczoom <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const r = await driver.executeScript([
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "var out = {};",
      "['setZoom', 'slideZoom', 'debounced_setZoom', 'zoomObject'].forEach(function (n) {",
      "  try { out[n] = String(d.engine[n]); } catch (e) { out[n] = 'illisible'; }",
      "});",
      "/* Et ce que d20 expose autour, pour reconnaitre les noms qu'on lira. */",
      "out.autour = [];",
      "for (var k in d.engine) {",
      "  try { if (typeof d.engine[k] === 'function' && /render|resize|grid|offset|center|canvas|draw/i.test(k)) { out.autour.push(k); } } catch (e) {}",
      "}",
      "out.overlay = [];",
      "if (d.canvas_overlay) { for (var k2 in d.canvas_overlay) { try { if (typeof d.canvas_overlay[k2] === 'function') { out.overlay.push(k2); } } catch (e) {} } }",
      "return out;"
    ].join("\n"));

    ["setZoom", "slideZoom", "debounced_setZoom", "zoomObject"].forEach(function (n) {
      console.log("\n  ---------- " + n + " ----------");
      console.log("  " + String(r[n] || "").split(String.fromCharCode(10)).join(String.fromCharCode(10) + "  ").slice(0, 2600));
    });
    console.log("\n  ---------- autour ----------");
    console.log("  d20.engine : " + (r.autour || []).join("  "));
    console.log("  overlay    : " + (r.overlay || []).join("  "));

    releve("srczoom-" + campagne + ".json", r);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE ZOOM HÉRITÉ, À L'ÉPREUVE ----------
 *
 * Le module est écrit ; il reste à savoir s'il tient. Six questions, dans
 * l'ordre où elles peuvent faire tout écrouler :
 *
 *   1. LE PONT AIGUILLE-T-IL ? Il doit répondre « moteur: heritage » et non
 *      partir dans la branche de Babylon, où le magasin est vide.
 *   2. VA-T-IL AU-DELÀ DE 250 % ? C'est la promesse du module.
 *   3. L'IMAGE SUIT-ELLE ? Un « canvasZoom » à 4 sans redessin serait un
 *      nombre juste devant une carte fausse. On PHOTOGRAPHIE et on compare
 *      les octets — pas de conclusion sans témoin.
 *   4. LA MOLETTE PROLONGE-T-ELLE ? Elle est la vraie commande, et c'est par
 *      « slideZoom » qu'on l'a prise.
 *   5. LE RETOUR DANS SA PLAGE EST-IL PROPRE ? Le rapport se calcule depuis
 *      « canvasZoom » ; s'il est faux, la carte revient de travers.
 *   6. L'EXTINCTION REND-ELLE LA PARTIE INTACTE ? C'est ce qui sépare un
 *      module d'un dégât.
 *
 * Campagne d'essai, et le zoom revient à sa valeur de départ.
 */
async function epreuveZoomHerite() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js zh <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";
    const lis = async () => driver.executeScript(D + "\nreturn Math.round(d.engine.canvasZoom * 100);");
    const miroir = async () => driver.executeScript([
      "var n = document.querySelectorAll('div,body>*');",
      "for (var i = 0; i < n.length; i++) {",
      "  try {",
      "    var p = n[i].__vue_app__ && n[i].__vue_app__.config.globalProperties.$pinia;",
      "    var t = p && p._s && p._s.get('vttTools_tabletopState');",
      "    if (t) { return Math.round(t.zoom * 100); }",
      "  } catch (e) {}",
      "}",
      "return null;"
    ].join("\n"));
    const depart = await lis();
    console.log("\n  zoom au depart : " + depart + " %");

    /* Le pont repond-il, et par quelle branche ? */
    const reponse = await driver.executeScript([
      "window.__vkRep = null;",
      "window.addEventListener('message', function (ev) {",
      "  var m = ev.data;",
      "  if (m && m.ns === 'vttinker' && m.depuis === 'page' && m.type === 'zoom-resultat') { window.__vkRep = m; }",
      "}, false);",
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', min: 10, max: 800 }, '*');",
      "return true;"
    ].join("\n"));
    await dors(1500);
    const rep = await driver.executeScript("return window.__vkRep;");
    console.log("  -- 1. L AIGUILLAGE --");
    console.log("    " + JSON.stringify(rep));
    const bonne = rep && rep.moteur === "heritage" && rep.ok;
    console.log("    " + (bonne ? "OUI, la branche heritage" : "NON — il est parti ailleurs"));
    if (!bonne) { return 1; }

    /* L IMAGE : on photographie avant, on demande, on rephotographie. */
    /* L'INSTRUMENT D'IMAGE, ET SON TÉMOIN.
     *
     * Le premier jet lisait « babylonCanvas.toDataURL ». Il rendait
     * « INCHANGEE » de 100 % à 250 %, ce qui est impossible : c'est une toile
     * WebGL, et sans « preserveDrawingBuffer » son tampon est vide au moment où
     * on le lit. L'instrument échouait à son propre témoin, donc rien de ce
     * qu'il disait ne valait. On prend de vraies photos d'écran. */
    const crypto = require("crypto");
    const empreinte = async () => {
      const b64 = await driver.takeScreenshot();
      return crypto.createHash("sha256").update(b64).digest("hex").slice(0, 16);
    };

    /* ET SA STABILITÉ : deux photos sans rien toucher. Si elles diffèrent, la
     * page bouge d'elle-même et « changee » ne prouverait rien. */
    const s1 = await empreinte();
    await dors(1500);
    const s2 = await empreinte();
    console.log("  instrument : deux photos sans rien toucher " +
      (s1 === s2 ? "IDENTIQUES (il est stable)" : "DIFFERENTES — la page bouge seule, la mesure ne dira rien"));

    async function veut(v) {
      const av = await empreinte();
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: arguments[0] }, '*');", v);
      await dors(1500);
      const ap = await empreinte();
      const z = await lis(), m = await miroir();
      console.log("    demande " + String(v).padStart(4) + "  →  canvasZoom " + String(z).padStart(4) +
        " %   miroir " + String(m).padStart(4) + " %   image " +
        (av === ap ? "INCHANGEE" : "changee") + (String(av).indexOf("refus") === 0 ? "  (" + av + ")" : ""));
      return { z: z, m: m, bouge: av !== ap };
    }

    console.log("\n  -- 2 ET 3. AU-DELA DE 250 %, ET L IMAGE --");
    await veut(100);
    await veut(250);
    const a400 = await veut(400);
    const a800 = await veut(800);
    await capture(driver, "zh-800.png");

    console.log("\n  -- 4. LA MOLETTE, AU-DELA --");
    for (let i = 0; i < 2; i++) {
      const av = await lis();
      await driver.executeScript([
        "var cv = document.getElementById('babylonCanvas');",
        "var q = cv.getBoundingClientRect();",
        "cv.dispatchEvent(new WheelEvent('wheel', { deltaY: arguments[0], bubbles: true, cancelable: true,",
        "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));"
      ].join("\n"), i === 0 ? -102 : 102);
      await dors(1200);
      const ap = await lis();
      console.log("    " + (i === 0 ? "un cran vers le haut" : "un cran vers le bas ") +
        "  " + String(av).padStart(4) + " % → " + String(ap).padStart(4) + " %" +
        (av === ap ? "   RIEN N A BOUGE" : ""));
    }

    console.log("\n  -- 5. LE RETOUR DANS SA PLAGE --");
    const r150 = await veut(150);
    console.log("    et son propre setZoom repond encore : " +
      JSON.stringify(await driver.executeScript(D + "\nd.engine.setZoom(1.2); return Math.round(d.engine.canvasZoom * 100);")));

    console.log("\n  -- 6. L EXTINCTION --");
    await driver.executeScript("window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 600 }, '*');");
    await dors(1200);
    const avantOff = await lis();
    await driver.executeScript("window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');");
    await dors(1500);
    const apresOff = await lis();
    const rendu = await driver.executeScript(D + "\nreturn { setZoom: String(d.engine.setZoom).indexOf('poseH') < 0, slideZoom: String(d.engine.slideZoom).indexOf('poseH') < 0 };");
    console.log("    eteint depuis " + avantOff + " %  →  " + apresOff + " %" +
      (apresOff <= 250 && apresOff >= 10 ? "   (dans sa plage)" : "   HORS DE SA PLAGE"));
    console.log("    ses fonctions lui sont rendues : setZoom " + rendu.setZoom + "   slideZoom " + rendu.slideZoom);
    await capture(driver, "zh-eteint.png");

    /* Et la carte est-elle encore maniable ? On lui demande un zoom, par SA voie. */
    await driver.executeScript(D + "\nd.engine.setZoom(arguments[0] / 100);", depart);
    await dors(1000);
    const fin = await lis();
    console.log("    sa voie repond encore : zoom remis a " + fin + " %");

    releve("zh-" + campagne + ".json", { rep: rep, a400: a400, a800: a800, r150: r150,
      avantOff: avantOff, apresOff: apresOff, rendu: rendu });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUAND REPEINDRE, SUR L'ANCIEN MOTEUR ? ----------
 *
 * Les deux modules qui restent — les marqueurs et la grille — peignent sur NOTRE
 * calque, posé au-dessus de sa toile. Reste la question du rythme, et elle
 * décide de tout le reste : trop lent, un jeton traîné laisse ses marqueurs
 * derrière lui ; permanent, on paie soixante peintures par seconde pour rien,
 * et c'est exactement ce qu'on nous a reproché sur le zoom.
 *
 * DEUX PISTES DÉJÀ ÉCARTÉES, PAR LA MESURE :
 *   · « renderAll » — enveloppé, il n'a été appelé QU'UNE FOIS en trois
 *     secondes. Ce n'est pas le battement de la boucle.
 *   · « onAfterFOWRenderCallbacks » — un rappel poussé dedans n'a JAMAIS été
 *     appelé : ce rendez-vous n'existe que si le brouillard rend.
 *
 * On compte donc ce qui bat vraiment. Chaque candidat est enveloppé d'un
 * compteur — le coût d'un « ++ », rien de plus, sans quoi la mesure fausserait
 * ce qu'elle mesure — et on lit à trois secondes d'intervalle, au repos.
 *
 * On mesure AUSSI ce que coûte une peinture à vide, pour savoir ce qu'un
 * rythme donné coûterait vraiment.
 */
async function battementAncien() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js boucle <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";

    const pose = await driver.executeScript(D + "\n" + [
      "window.__vb = {}; window.__vbN = {};",
      "var cibles = ['renderLoop', 'redrawScreenNextTick', 'drawHighlights', 'checkCanvasSize', 'drawPings'];",
      "cibles.forEach(function (n) {",
      "  if (typeof d.engine[n] !== 'function') { return; }",
      "  window.__vb[n] = 0;",
      "  window.__vbN[n] = d.engine[n];",
      "  d.engine[n] = function () { window.__vb[n]++; return window.__vbN[n].apply(this, arguments); };",
      "});",
      "/* Et sa couche WebGL, qui compose l'image finale. */",
      "if (d.canvas_overlay && typeof d.canvas_overlay.compositeCanvases === 'function') {",
      "  window.__vb.compositeCanvases = 0;",
      "  window.__vbN.compositeCanvases = d.canvas_overlay.compositeCanvases;",
      "  d.canvas_overlay.compositeCanvases = function () {",
      "    window.__vb.compositeCanvases++; return window.__vbN.compositeCanvases.apply(this, arguments); };",
      "}",
      "/* Et la trame du navigateur, pour avoir une reference. */",
      "window.__vbTrames = 0;",
      "(function boucle() { window.__vbTrames++; window.__vbRaf = requestAnimationFrame(boucle); })();",
      "return Object.keys(window.__vb);"
    ].join("\n"));
    console.log("\n  enveloppes : " + JSON.stringify(pose));

    async function mesure(titre, avant) {
      await driver.executeScript("Object.keys(window.__vb).forEach(function (k) { window.__vb[k] = 0; }); window.__vbTrames = 0;");
      if (avant) { await avant(); }
      await dors(3000);
      const r = await driver.executeScript("return { c: window.__vb, t: window.__vbTrames };");
      console.log("\n  -- " + titre + " (trois secondes) --");
      console.log("    trames du navigateur   " + String(Math.round(r.t / 3)).padStart(5) + " /s");
      Object.keys(r.c).forEach(function (k) {
        console.log("    " + k.padEnd(22) + " " + String(Math.round(r.c[k] / 3)).padStart(5) + " /s" +
          (r.c[k] === 0 ? "   (jamais)" : ""));
      });
      return r;
    }

    await mesure("AU REPOS");

    /* ET PENDANT QU'ON REMUE LA CARTE : c'est la seule facon de voir ce qui ne
     * bat QUE lorsque quelque chose bouge. */
    await mesure("PENDANT UN ZOOM", async () => {
      for (let i = 0; i < 3; i++) {
        await driver.executeScript(D + "\nd.engine.setZoom(arguments[0]);", 1 + i * 0.2);
        await dors(200);
      }
    });

    /* CE QUE COUTE UNE PEINTURE A VIDE, sur notre propre calque. */
    const cout = await driver.executeScript([
      "var vis = document.getElementById('babylonCanvas');",
      "var c = document.createElement('canvas');",
      "c.width = vis.width; c.height = vis.height;",
      "var x = c.getContext('2d');",
      "var t0 = performance.now();",
      "for (var i = 0; i < 200; i++) { x.clearRect(0, 0, c.width, c.height); }",
      "var t1 = performance.now();",
      "for (var j = 0; j < 200; j++) {",
      "  x.clearRect(0, 0, c.width, c.height);",
      "  for (var k = 0; k < 20; k++) { x.fillRect(10 + k * 5, 10, 19, 19); }",
      "}",
      "var t2 = performance.now();",
      "return { vide: Math.round((t1 - t0) / 200 * 1000) / 1000,",
      "  vingtCases: Math.round((t2 - t1) / 200 * 1000) / 1000, toile: [c.width, c.height] };"
    ].join("\n"));
    console.log("\n  -- CE QUE COUTE UNE PEINTURE --");
    console.log("    effacer la toile " + JSON.stringify(cout.toile) + " : " + cout.vide + " ms");
    console.log("    l effacer et poser vingt cases : " + cout.vingtCases + " ms");

    await driver.executeScript(D + "\n" + [
      "Object.keys(window.__vbN || {}).forEach(function (n) {",
      "  if (n === 'compositeCanvases') { d.canvas_overlay[n] = window.__vbN[n]; }",
      "  else { d.engine[n] = window.__vbN[n]; }",
      "});",
      "if (window.__vbRaf) { cancelAnimationFrame(window.__vbRaf); }",
      "d.engine.setZoom(1);"
    ].join("\n"));
    console.log("\n  enveloppes retirees, zoom remis a 1");
    releve("boucle-" + campagne + ".json", { cout: cout });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- COMMENT L'ANCIEN MOTEUR DESSINE SES MARQUEURS ----------
 *
 * Nos marqueurs doivent se coller aux siens : même taille, même pas, même
 * ligne. Sous Jumpgate on LIT son échelle sur ses propres quads Babylon,
 * plutôt que de la calculer — sa loi est quantifiée par pas de 0,02 d'une
 * façon qu'on ne reproduit qu'à 1 % près, et 1 % côte à côte se voit.
 *
 * Ici, il n'y a pas de quads. Trois questions, donc :
 *
 *   1. LES DESSINE-T-IL COMME DES OBJETS DE CANEVAS, qu'on pourrait lire comme
 *      on lit ses quads ? Ou bien peint-il tout dans l'image du jeton ?
 *   2. OÙ EXACTEMENT, en coordonnées de page ? Bord haut, à partir de la
 *      droite, comme sous Jumpgate ?
 *   3. À QUELLE TAILLE, et rapetisse-t-il quand la rangée déborde ?
 *
 * ON POSE DE VRAIS MARQUEURS ET ON REGARDE. La campagne est une table d'essai,
 * et l'état d'origine du jeton est relevé puis remis.
 */
async function marqueursHeritage() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js marqh <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";

    /* On prend le jeton le plus large de la couche des jetons : c'est sur lui
     * qu'une rangee se lit le mieux. */
    const cible = await driver.executeScript(D + "\n" + [
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var best = null;",
      "g.forEach(function (t) {",
      "  if (String(t.get('layer')) !== 'objects') { return; }",
      "  var w = t.get('width') || 0;",
      "  if (w > 200) { return; }",              // pas une image de fond
      "  if (!best || w > best.w) { best = { id: t.id, w: w, h: t.get('height'),",
      "    x: t.get('left'), y: t.get('top'), sm: t.get('statusmarkers') || '' }; }",
      "});",
      "return best;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton retenu : ..." + String(cible.id).slice(-6) +
      "   " + cible.w + "x" + cible.h + " en (" + cible.x + ", " + cible.y + ")" +
      "   marqueurs d origine : " + JSON.stringify(cible.sm));

    /* On se place dessus, bien zoome, pour que la rangee soit lisible. */
    await driver.executeScript(D + "\n" + [
      "d.engine.setZoom(2.5);",
      "if (typeof d.engine.centerOnPoint === 'function') { d.engine.centerOnPoint(arguments[0], arguments[1]); }"
    ].join("\n"), cible.x, cible.y);
    await dors(2000);

    async function pose(sm, titre, nom) {
      const av = await driver.executeScript(D + "\nreturn d.engine.canvas.getObjects().length;");
      await driver.executeScript(D + "\n" + [
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);",
        "t.save({ statusmarkers: arguments[1] });"
      ].join("\n"), cible.id, sm);
      await dors(2500);
      const ap = await driver.executeScript(D + "\n" + [
        "var out = { objets: d.engine.canvas.getObjects().length, nouveaux: [] };",
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);",
        "out.relu = t.get('statusmarkers');",
        "/* Y a-t-il des objets de canevas pres du jeton, autres que lui ? */",
        "var cx = t.get('left'), cy = t.get('top'), w = t.get('width'), h = t.get('height');",
        "d.engine.canvas.getObjects().forEach(function (o) {",
        "  if (!o || (o.model && o.model.id === t.id)) { return; }",
        "  if (Math.abs(o.left - cx) > w * 2 || Math.abs(o.top - cy) > h * 2) { return; }",
        "  out.nouveaux.push({ type: o.type, l: Math.round(o.left), t: Math.round(o.top),",
        "    w: Math.round(o.width * (o.scaleX || 1)), h: Math.round(o.height * (o.scaleY || 1)),",
        "    modele: o.model ? String(o.model.id).slice(-6) : null });",
        "});",
        "/* Et son objet a lui : a-t-il grossi pour porter la rangee ? */",
        "d.engine.canvas.getObjects().forEach(function (o) {",
        "  if (o && o.model && o.model.id === t.id) {",
        "    out.sien = { type: o.type, l: Math.round(o.left), t: Math.round(o.top),",
        "      w: Math.round(o.width * (o.scaleX || 1)), h: Math.round(o.height * (o.scaleY || 1)) };",
        "  }",
        "});",
        "return out;"
      ].join("\n"), cible.id);
      console.log("    " + titre.padEnd(28) + " objets " + av + " → " + ap.objets +
        "   relu " + JSON.stringify(ap.relu));
      if (ap.nouveaux.length) {
        console.log("      voisins : " + JSON.stringify(ap.nouveaux));
      }
      console.log("      son objet : " + JSON.stringify(ap.sien));
      await capture(driver, nom);
      return ap;
    }

    console.log("\n  -- CE QU IL DESSINE --");
    await pose("", "aucun marqueur", "marqh-0.png");
    await pose("red", "un marqueur", "marqh-1.png");
    await pose("red,blue,green", "trois marqueurs", "marqh-3.png");
    await pose("red,blue,green,brown,purple,pink,yellow,dead", "huit marqueurs", "marqh-8.png");

    /* ON REMET LE JETON COMME IL ETAIT. */
    await driver.executeScript(D + "\n" + [
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);",
      "t.save({ statusmarkers: arguments[1] });"
    ].join("\n"), cible.id, cible.sm);
    await dors(1200);
    const remis = await driver.executeScript(D + "\n" + [
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);",
      "return t.get('statusmarkers');"
    ].join("\n"), cible.id);
    console.log("\n  jeton remis a " + JSON.stringify(remis) +
      (String(remis) === String(cible.sm) ? "   (identique a l origine)" : "   ECART"));
    await driver.executeScript(D + "\nd.engine.setZoom(1);");

    releve("marqh-" + campagne + ".json", { cible: cible, remis: remis });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA VUE, LE DÉCALAGE, ET LA CONVERSION ----------
 *
 * Le repère peint plus tôt tombait juste — mais À DÉCALAGE NUL ET À ZOOM 1,
 * c'est-à-dire dans le seul cas où « (page − décalage) × zoom » ne prouve rien :
 * l'identité tombe juste par accident. Le contrôle qui vaut demande les deux
 * autres : une vue déplacée, et un zoom qui n'est pas 1.
 *
 * Et il faut de toute façon savoir déplacer la vue, ne serait-ce que pour
 * regarder un jeton : « centerOnPoint » n'a rien centré du tout.
 *
 * TROIS CHOSES, DONC :
 *   1. Qui porte le déplacement — « currentCanvasOffset » est-il le défilement
 *      d'un conteneur du document, ou une valeur interne ?
 *   2. La conversion tient-elle une fois la vue déplacée ET zoomée ?
 *   3. Où l'ancien moteur pose-t-il SES marqueurs, qu'on doit rejoindre ?
 *
 * On peint un cadre rouge sur chaque jeton et on regarde. Campagne d'essai ; le
 * jeton retrouve ses marqueurs d'origine à la fin.
 */
async function vueHeritage() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js vue <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";

    /* ---------- 1. QUI PORTE LE DÉPLACEMENT ---------- */
    const qui = await driver.executeScript(D + "\n" + [
      "var out = { offset: d.engine.currentCanvasOffset, defilables: [] };",
      "var n = document.getElementById('babylonCanvas');",
      "while (n && n !== document.documentElement) {",
      "  if (n.scrollWidth > n.clientWidth + 4 || n.scrollHeight > n.clientHeight + 4) {",
      "    out.defilables.push({ id: n.id || '', classe: String(n.className || '').slice(0, 24),",
      "      sl: n.scrollLeft, st: n.scrollTop,",
      "      taille: [n.scrollWidth, n.scrollHeight], vue: [n.clientWidth, n.clientHeight] });",
      "  }",
      "  n = n.parentElement;",
      "}",
      "out.fenetre = [window.scrollX, window.scrollY];",
      "return out;"
    ].join("\n"));
    console.log("\n  -- QUI PORTE LE DEPLACEMENT --");
    console.log("    currentCanvasOffset : " + JSON.stringify(qui.offset));
    console.log("    la fenetre          : " + JSON.stringify(qui.fenetre));
    (qui.defilables || []).forEach(function (x) {
      console.log("    defilable : " + JSON.stringify(x));
    });

    /* ---------- LE JETON, ET SES MARQUEURS ---------- */
    const cible = await driver.executeScript(D + "\n" + [
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var best = null;",
      "g.forEach(function (t) {",
      "  if (String(t.get('layer')) !== 'objects') { return; }",
      "  var w = t.get('width') || 0;",
      "  if (w > 200) { return; }",
      "  if (!best || w > best.w) { best = { id: t.id, w: w, h: t.get('height'),",
      "    x: t.get('left'), y: t.get('top'), sm: t.get('statusmarkers') || '' }; }",
      "});",
      "return best;"
    ].join("\n"));
    console.log("\n  jeton : ..." + String(cible.id).slice(-6) + "  " +
      Math.round(cible.w) + " de cote en (" + Math.round(cible.x) + ", " + Math.round(cible.y) + ")" +
      "   d origine " + JSON.stringify(cible.sm));

    await driver.executeScript(D + "\n" + [
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);",
      "t.save({ statusmarkers: 'red,blue,green' });"
    ].join("\n"), cible.id);
    await dors(1500);

    /* ---------- 2. ON DEPLACE LA VUE PAR CHAQUE VOIE, ET ON REGARDE ---------- */
    async function essaie(titre, code, args) {
      await driver.executeScript(D + "\n" + code, ...(args || []));
      await dors(1500);
      const r = await driver.executeScript(D + "\n" + [
        "var w = document.getElementById('editor-wrapper');",
        "return { offset: d.engine.currentCanvasOffset, zoom: d.engine.canvasZoom,",
        "  defil: w ? [w.scrollLeft, w.scrollTop] : null,",
        "  contenu: w ? [w.scrollWidth, w.scrollHeight] : null };"
      ].join("\n"));
      console.log("    " + titre.padEnd(34) + " offset " + JSON.stringify(r.offset) +
        "   defil " + JSON.stringify(r.defil) + "   zoom " + r.zoom);
      return r;
    }

    console.log("\n  -- DEPLACER LA VUE --");
    await essaie("setZoom(2)", "d.engine.setZoom(2);");
    const voulu = { x: cible.x, y: cible.y };
    /* ON CENTRE LE JETON. Le contenu du conteneur vaut 125 + page×zoom + 125,
     * et son defilement de depart est [125, 125] : le defilement qui met le
     * point (x, y) de la page au centre de la vue est donc
     * 125 + x×zoom − largeurVue/2. */
    await essaie("on centre le jeton", [
      "var w = document.getElementById('editor-wrapper');",
      "if (!w) { return; }",
      "w.scrollLeft = 125 + arguments[0] * d.engine.canvasZoom - w.clientWidth / 2;",
      "w.scrollTop = 125 + arguments[1] * d.engine.canvasZoom - w.clientHeight / 2;",
      "w.dispatchEvent(new Event('scroll', { bubbles: true }));"
    ].join("\n"), [voulu.x, voulu.y]);
    await dors(1500);
    await essaie("  et on relit une seconde apres", "1;");

    /* ---------- 3. LA CONVERSION, EPROUVEE LA OU ELLE PEUT ECHOUER ---------- */
    const peint = await driver.executeScript(D + "\n" + [
      "var e = d.engine, cv = e.canvas;",
      "var vis = document.getElementById('babylonCanvas');",
      "var q = vis.getBoundingClientRect();",
      "var mien = document.getElementById('vttk-calque');",
      "if (!mien) {",
      "  mien = document.createElement('canvas');",
      "  mien.id = 'vttk-calque';",
      "  mien.style.cssText = 'position:fixed;pointer-events:none;z-index:9;';",
      "  vis.parentNode.appendChild(mien);",
      "}",
      "mien.width = vis.width; mien.height = vis.height;",
      "mien.style.left = q.left + 'px'; mien.style.top = q.top + 'px';",
      "mien.style.width = q.width + 'px'; mien.style.height = q.height + 'px';",
      "var ctx = mien.getContext('2d');",
      "var z = e.canvasZoom || 1, off = e.currentCanvasOffset || [0, 0];",
      "ctx.clearRect(0, 0, mien.width, mien.height);",
      "ctx.strokeStyle = 'rgb(255,0,0)'; ctx.lineWidth = 3;",
      "var vus = [];",
      "window.Campaign.activePage().thegraphics.models.forEach(function (t) {",
      "  var w = t.get('width'), h = t.get('height');",
      "  if (w > 200) { return; }",
      "  var x = (t.get('left') - off[0]) * z, y = (t.get('top') - off[1]) * z;",
      "  ctx.strokeRect(x - w * z / 2, y - h * z / 2, w * z, h * z);",
      "  if (x > -50 && x < mien.width + 50 && y > -50 && y < mien.height + 50) {",
      "    vus.push({ id: String(t.id).slice(-6), ecran: [Math.round(x), Math.round(y)] });",
      "  }",
      "});",
      "return { zoom: z, off: off, toile: [mien.width, mien.height], visibles: vus };"
    ].join("\n"));
    console.log("\n  -- LA CONVERSION, PEINTE --");
    console.log("    zoom " + peint.zoom + "   decalage " + JSON.stringify(peint.off) +
      "   toile " + JSON.stringify(peint.toile));
    console.log("    a l ecran : " + JSON.stringify(peint.visibles));
    await dors(800);
    await capture(driver, "vue-heritage.png");

    /* ON REMET TOUT. */
    await driver.executeScript("var n = document.getElementById('vttk-calque'); if (n) { n.remove(); }");
    await driver.executeScript(D + "\n" + [
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);",
      "t.save({ statusmarkers: arguments[1] });",
      "d.engine.setZoom(1);"
    ].join("\n"), cible.id, cible.sm);
    await dors(1200);
    const remis = await driver.executeScript(D + "\n" +
      "return window.Campaign.activePage().thegraphics.get(arguments[0]).get('statusmarkers');", cible.id);
    console.log("\n  jeton remis a " + JSON.stringify(remis) +
      (String(remis) === String(cible.sm) ? "   (identique a l origine)" : "   ECART"));

    releve("vue-" + campagne + ".json", { qui: qui, peint: peint });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA LOI DE SA RANGÉE, MESURÉE AU PIXEL ----------
 *
 * Nos marqueurs doivent se coller aux siens. Sous Jumpgate on LIT son échelle
 * sur ses propres quads Babylon ; ici il n'y a pas de quads — mesuré, poser
 * huit marqueurs ne crée AUCUN objet de canevas — et sa rangée ne suit pas la
 * même loi : la photo montre trois pastilles réparties sur le bord haut À
 * PARTIR DE LA GAUCHE, là où Jumpgate part de la droite.
 *
 * ON NE DEVINE PAS UNE LOI, ON LA MESURE. Ses pastilles sont des disques de
 * couleur franche : il suffit de lire les pixels et de chercher où chaque
 * teinte se trouve. Reste à savoir SUR QUELLE SURFACE les lire — la toile
 * visible est en WebGL, donc muette, mais le moteur en tient plusieurs en 2D.
 *
 * On cherche donc d'abord la surface qui les porte, puis on relève, pour un
 * nombre croissant de marqueurs : le centre de chacun, et son diamètre.
 *
 * Campagne d'essai ; le jeton retrouve ses marqueurs d'origine à la fin.
 */
async function loiDeLaRangee() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js loi <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";

    const cible = await driver.executeScript(D + "\n" + [
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var best = null;",
      "g.forEach(function (t) {",
      "  if (String(t.get('layer')) !== 'objects') { return; }",
      "  var w = t.get('width') || 0;",
      "  if (w > 200) { return; }",
      "  if (!best || w > best.w) { best = { id: t.id, w: w, h: t.get('height'),",
      "    x: t.get('left'), y: t.get('top'), sm: t.get('statusmarkers') || '' }; }",
      "});",
      "return best;"
    ].join("\n"));
    console.log("\n  jeton : ..." + String(cible.id).slice(-6) + "  " + Math.round(cible.w) +
      " de cote   d origine " + JSON.stringify(cible.sm));

    /* On zoome et on centre : plus la pastille est grande, plus la mesure est fine. */
    await driver.executeScript(D + "\n" + [
      "d.engine.setZoom(2.5);"
    ].join("\n"));
    await dors(1200);
    await driver.executeScript(D + "\n" + [
      "var w = document.getElementById('editor-wrapper');",
      "w.scrollLeft = 125 + arguments[0] * d.engine.canvasZoom - w.clientWidth / 2;",
      "w.scrollTop = 125 + arguments[1] * d.engine.canvasZoom - w.clientHeight / 2;",
      "w.dispatchEvent(new Event('scroll', { bubbles: true }));"
    ].join("\n"), cible.x, cible.y);
    await dors(2000);

    /* ---------- 1. QUELLE SURFACE PORTE SES PASTILLES ? ---------- */
    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().thegraphics.get(arguments[0]).save({ statusmarkers: 'red' });"
    ].join("\n"), cible.id);
    await dors(2500);

    const surfaces = await driver.executeScript(D + "\n" + [
      "var e = d.engine, out = [];",
      "var cands = [];",
      "if (e.canvas) {",
      "  if (e.canvas.lowerCanvasEl) { cands.push(['fabric.lower', e.canvas.lowerCanvasEl.getContext('2d'), e.canvas.lowerCanvasEl]); }",
      "  if (e.canvas.upperCanvasEl) { cands.push(['fabric.upper', e.canvas.upperCanvasEl.getContext('2d'), e.canvas.upperCanvasEl]); }",
      "}",
      "if (e.final_canvas_ctx) { cands.push(['final_canvas', e.final_canvas_ctx, e.final_canvas_ctx.canvas]); }",
      "var w = e.work_canvases || {};",
      "for (var k in w) { if (w[k] && w[k].context) { cands.push(['work.' + k, w[k].context, w[k].context.canvas]); } }",
      "['uppercanvas', 'fowcanvas', 'lightingcanvas'].forEach(function (n) {",
      "  var c = e[n];",
      "  if (c && c.getContext) { cands.push([n, c.getContext('2d'), c]); }",
      "  else if (c && c.canvas) { cands.push([n, c, c.canvas]); }",
      "});",
      "cands.forEach(function (c) {",
      "  var nom = c[0], ctx = c[1], el = c[2];",
      "  var o = { nom: nom, taille: el ? [el.width, el.height] : null, rouge: 0, opaque: 0, err: null };",
      "  try {",
      "    var im = ctx.getImageData(0, 0, el.width, el.height).data;",
      "    for (var i = 0; i < im.length; i += 4) {",
      "      if (im[i + 3] > 40) { o.opaque++; }",
      "      if (im[i] > 150 && im[i + 1] < 90 && im[i + 2] < 90 && im[i + 3] > 200) { o.rouge++; }",
      "    }",
      "  } catch (x) { o.err = String(x).slice(0, 50); }",
      "  out.push(o);",
      "});",
      "return out;"
    ].join("\n"));
    console.log("\n  -- OU SES PASTILLES SONT-ELLES PEINTES --");
    surfaces.forEach(function (s) {
      console.log("    " + String(s.nom).padEnd(16) + " " + JSON.stringify(s.taille).padEnd(14) +
        " opaques " + String(s.opaque).padStart(8) + "   rouges " + String(s.rouge).padStart(6) +
        (s.err ? "   (" + s.err + ")" : ""));
    });
    const porteuse = surfaces.filter((s) => !s.err && s.rouge > 20).sort((a, b) => a.rouge - b.rouge)[0];
    if (!porteuse) {
      console.log("\n    AUCUNE surface 2D ne porte de rouge : elles sont peintes ailleurs.");
    } else {
      console.log("\n    la porteuse : " + porteuse.nom);
    }

    /* ---------- 2. LA LOI, POUR UN NOMBRE CROISSANT ---------- */
    const TEINTES = [
      ["red", 201, 16, 16], ["blue", 16, 118, 201], ["green", 47, 201, 16],
      ["brown", 201, 115, 16], ["purple", 149, 16, 201], ["pink", 235, 117, 225],
      ["yellow", 229, 235, 117]
    ];
    if (porteuse) {
      console.log("\n  -- LA LOI, RELEVEE --");
      console.log("    n   pastille                     centre (page)        cote (page)");
      for (const k of [1, 2, 3, 5, 7]) {
        const sm = TEINTES.slice(0, k).map((t) => t[0]).join(",");
        await driver.executeScript(D + "\n" +
          "window.Campaign.activePage().thegraphics.get(arguments[0]).save({ statusmarkers: arguments[1] });",
          cible.id, sm);
        await dors(2500);
        const r = await driver.executeScript(D + "\n" + [
          "var e = d.engine, nom = arguments[0], teintes = arguments[1];",
          "var ctx = null, el = null;",
          "if (nom === 'fabric.lower') { el = e.canvas.lowerCanvasEl; ctx = el.getContext('2d'); }",
          "else if (nom === 'fabric.upper') { el = e.canvas.upperCanvasEl; ctx = el.getContext('2d'); }",
          "else if (nom === 'final_canvas') { ctx = e.final_canvas_ctx; el = ctx.canvas; }",
          "else if (nom.indexOf('work.') === 0) { ctx = e.work_canvases[nom.slice(5)].context; el = ctx.canvas; }",
          "else { var c = e[nom]; ctx = c.getContext ? c.getContext('2d') : c; el = ctx.canvas; }",
          "var im = ctx.getImageData(0, 0, el.width, el.height).data;",
          "var boites = {};",
          "for (var y = 0; y < el.height; y++) {",
          "  for (var x = 0; x < el.width; x++) {",
          "    var i = (y * el.width + x) * 4;",
          "    if (im[i + 3] < 200) { continue; }",
          "    var meilleur = null, dm = 3000;",
          "    for (var t = 0; t < teintes.length; t++) {",
          "      var dr = im[i] - teintes[t][1], dg = im[i + 1] - teintes[t][2], db = im[i + 2] - teintes[t][3];",
          "      var dd = dr * dr + dg * dg + db * db;",
          "      if (dd < dm) { dm = dd; meilleur = teintes[t][0]; }",
          "    }",
          "    if (!meilleur) { continue; }",
          "    var b = boites[meilleur] || (boites[meilleur] = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9, n: 0 });",
          "    if (x < b.x0) { b.x0 = x; } if (x > b.x1) { b.x1 = x; }",
          "    if (y < b.y0) { b.y0 = y; } if (y > b.y1) { b.y1 = y; }",
          "    b.n++;",
          "  }",
          "}",
          "return { boites: boites, zoom: e.canvasZoom, off: e.currentCanvasOffset, taille: [el.width, el.height] };"
        ].join("\n"), porteuse.nom, TEINTES.slice(0, k));
        const z = r.zoom, off = r.off;
        const noms = TEINTES.slice(0, k).map((t) => t[0]);
        noms.forEach(function (n, i) {
          const b = r.boites[n];
          if (!b || b.n < 12) { console.log("    " + String(k).padStart(2) + "  " + n.padEnd(28) + " introuvable"); return; }
          const cx = (b.x0 + b.x1) / 2 / z + off[0], cy = (b.y0 + b.y1) / 2 / z + off[1];
          const cote = (b.x1 - b.x0 + 1) / z;
          console.log("    " + (i === 0 ? String(k).padStart(2) : "  ") + "  " + n.padEnd(28) +
            " (" + cx.toFixed(1) + ", " + cy.toFixed(1) + ")".padEnd(6) +
            "   " + cote.toFixed(2));
        });
        console.log("        bord gauche du jeton " + (cible.x - cible.w / 2).toFixed(1) +
          "   bord haut " + (cible.y - cible.h / 2).toFixed(1) + "   largeur " + cible.w.toFixed(1));
      }
    }

    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().thegraphics.get(arguments[0]).save({ statusmarkers: arguments[1] });",
      "d.engine.setZoom(1);"
    ].join("\n"), cible.id, cible.sm);
    await dors(1200);
    const remis = await driver.executeScript(D + "\n" +
      "return window.Campaign.activePage().thegraphics.get(arguments[0]).get('statusmarkers');", cible.id);
    console.log("\n  jeton remis a " + JSON.stringify(remis) +
      (String(remis) === String(cible.sm) ? "   (identique a l origine)" : "   ECART"));

    releve("loi-" + campagne + ".json", { cible: cible, surfaces: surfaces });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES MARQUEURS HÉRITÉS, À L'ÉPREUVE ----------
 *
 * Cinq questions, dans l'ordre où elles peuvent tout faire écrouler :
 *
 *   1. LE PONT AIGUILLE-T-IL ? Il doit répondre « moteur: heritage » et poser
 *      un peintre, non tenter de monter des maillages Babylon.
 *   2. LE CALQUE EXISTE-T-IL, au bon endroit et à la bonne taille ?
 *   3. NOS MARQUEURS SE VOIENT-ILS, et se collent-ils aux siens ? C'est une
 *      question de PHOTO, pas de nombre : on met deux marqueurs à nous à côté
 *      de trois à lui, et on regarde.
 *   4. SUIVENT-ILS LA VUE ? Un marqueur juste à un seul zoom ne prouve rien —
 *      la conversion a déjà tombé juste par accident une fois.
 *   5. L'EXTINCTION RETIRE-T-ELLE TOUT ? Un calque orphelin qui continue de
 *      tourner à soixante trames par seconde serait pire que pas de module.
 *
 * Campagne d'essai ; le jeton retrouve ses marqueurs d'origine à la fin.
 */
async function epreuveMarqueursHerites() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js emh <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";

    const cible = await driver.executeScript(D + "\n" + [
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var best = null;",
      "g.forEach(function (t) {",
      "  if (String(t.get('layer')) !== 'objects') { return; }",
      "  var w = t.get('width') || 0;",
      "  if (w > 200) { return; }",
      "  if (!best || w > best.w) { best = { id: t.id, w: w, h: t.get('height'),",
      "    x: t.get('left'), y: t.get('top'), sm: t.get('statusmarkers') || '' }; }",
      "});",
      "return best;"
    ].join("\n"));
    console.log("\n  jeton : ..." + String(cible.id).slice(-6) + "  " + Math.round(cible.w) +
      " de cote   d origine " + JSON.stringify(cible.sm));

    /* ---------- 1. L AIGUILLAGE ---------- */
    const rep = await driver.executeScript([
      "window.__vkRep = null;",
      "window.addEventListener('message', function (ev) {",
      "  var m = ev.data;",
      "  if (m && m.ns === 'vttinker' && m.depuis === 'page' && m.type === 'marqueurs-resultat') { window.__vkRep = m; }",
      "}, false);",
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true,",
      "  catalogue: [",
      "    { tag: 'vttk_essaia_cdn.discordapp.com/embed/avatars/0.png', nom: 'Essai A',",
      "      url: 'https://cdn.discordapp.com/embed/avatars/0.png' },",
      "    { tag: 'vttk_essaib_cdn.discordapp.com/embed/avatars/1.png', nom: 'Essai B',",
      "      url: 'https://cdn.discordapp.com/embed/avatars/1.png' }",
      "  ] }, '*');",
      "return true;"
    ].join("\n"));
    await dors(2000);
    const r1 = await driver.executeScript("return window.__vkRep;");
    console.log("\n  -- 1. L AIGUILLAGE --");
    console.log("    " + JSON.stringify(r1));
    if (!r1 || r1.moteur !== "heritage") { console.log("    NON — il est parti ailleurs"); return 1; }

    /* ---------- 2. LE CALQUE ---------- */
    const calque = await driver.executeScript([
      "var c = document.getElementById('vttk-calque');",
      "var vis = document.getElementById('babylonCanvas');",
      "if (!c) { return { present: false }; }",
      "var qc = c.getBoundingClientRect(), qv = vis.getBoundingClientRect();",
      "var st = getComputedStyle(c);",
      "return { present: true, meme: [c.width === vis.width, c.height === vis.height],",
      "  ecart: [Math.round(qc.left - qv.left), Math.round(qc.top - qv.top),",
      "          Math.round(qc.width - qv.width), Math.round(qc.height - qv.height)],",
      "  clics: st.pointerEvents, z: st.zIndex, memeParent: c.parentNode === vis.parentNode };"
    ].join("\n"));
    console.log("\n  -- 2. LE CALQUE --");
    console.log("    " + JSON.stringify(calque));

    /* ---------- 3. LA PHOTO, LA SEULE PREUVE ---------- */
    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().thegraphics.get(arguments[0]).save({ statusmarkers: arguments[1] });"
    ].join("\n"), cible.id,
      "red,blue,green,vttk_essaia_cdn.discordapp.com/embed/avatars/0.png@7," +
      "vttk_essaib_cdn.discordapp.com/embed/avatars/1.png");
    await dors(2500);

    async function regarde(zoom, nom) {
      await driver.executeScript(D + "\nd.engine.setZoom(arguments[0]);", zoom);
      await dors(1200);
      await driver.executeScript(D + "\n" + [
        "var w = document.getElementById('editor-wrapper');",
        "w.scrollLeft = 125 + arguments[0] * d.engine.canvasZoom - w.clientWidth / 2;",
        "w.scrollTop = 125 + arguments[1] * d.engine.canvasZoom - w.clientHeight / 2;",
        "w.dispatchEvent(new Event('scroll', { bubbles: true }));"
      ].join("\n"), cible.x, cible.y);
      await dors(2000);
      const e = await driver.executeScript([
        "var d2 = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
        "return { erreur: window.__vttinkerCalqueErreur || null,",
        "  zoom: d2.engine.canvasZoom, off: d2.engine.currentCanvasOffset };"
      ].join("\n"));
      console.log("    a " + Math.round(zoom * 100) + " %   decalage " + JSON.stringify(e.off) +
        (e.erreur ? "   ERREUR DU PEINTRE : " + e.erreur : ""));
      await capture(driver, nom);
      return e;
    }
    console.log("\n  -- 3 ET 4. LA PHOTO, A DEUX ECHELLES --");
    await regarde(2.5, "emh-250.png");
    await regarde(1.2, "emh-120.png");

    /* ---------- 5. L EXTINCTION ---------- */
    const avant = await driver.executeScript(
      "return { calque: !!document.getElementById('vttk-calque') };");
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');");
    await dors(1500);
    const apres = await driver.executeScript(
      "return { calque: !!document.getElementById('vttk-calque') };");
    console.log("\n  -- 5. L EXTINCTION --");
    console.log("    calque avant " + avant.calque + "   apres " + apres.calque +
      (apres.calque ? "   IL RESTE" : "   (retire)"));
    await capture(driver, "emh-eteint.png");

    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().thegraphics.get(arguments[0]).save({ statusmarkers: arguments[1] });",
      "d.engine.setZoom(1);"
    ].join("\n"), cible.id, cible.sm);
    await dors(1200);
    const remis = await driver.executeScript(D + "\n" +
      "return window.Campaign.activePage().thegraphics.get(arguments[0]).get('statusmarkers');", cible.id);
    console.log("\n  jeton remis a " + JSON.stringify(remis) +
      (String(remis) === String(cible.sm) ? "   (identique a l origine)" : "   ECART"));

    releve("emh-" + campagne + ".json", { r1: r1, calque: calque, remis: remis });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- OÙ L'ANCIEN MOTEUR POSE SA GRILLE ----------
 *
 * Le module de grille prolonge la sienne au-delà de la carte. Pour que le
 * prolongement se raccorde, il faut savoir EXACTEMENT où tombent ses lignes —
 * pas approximativement : un décalage d'un pixel sur une grille se voit sur
 * toute la longueur.
 *
 * Sous Jumpgate, on lit sa géométrie sur ses propres maillages Babylon. Ici il
 * n'y en a pas, et « d20.canvas_overlay.drawGrid » laisse entendre qu'elle est
 * peinte en WebGL — donc muette. Mais le relevé des marqueurs a montré que
 * « lowerCanvasEl » porte ce qu'il dessine en 2D : on va voir s'il en va de
 * même pour la grille.
 *
 * TROIS QUESTIONS :
 *   1. Quels réglages de page commandent la grille, et dans quelle unité ?
 *   2. Sur quelle surface ses lignes sont-elles peintes ?
 *   3. Où tombent-elles, en coordonnées de page — et la première est-elle en 0 ?
 *
 * La page d'essai n'a AUCUNE grille (« snapping_increment » vaut 0) : on en
 * pose une, d'une couleur franche pour la reconnaître au pixel, et on remet
 * TOUS les réglages d'origine à la fin.
 */
async function grilleHeritage() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js grh <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";
    const CLES = ["grid_type", "snapping_increment", "gridcolor", "gridopacity",
                  "showgrid", "grid_opacity", "scale_number", "scale_units",
                  "width", "height", "diagonaltype", "gridlabels"];

    const avant = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "out.id = pg.id;",
      "return out;"
    ].join("\n"), CLES);
    console.log("\n  -- LA PAGE, TELLE QU ELLE EST --");
    Object.keys(avant).forEach(function (k) {
      console.log("    " + k.padEnd(20) + " " + JSON.stringify(avant[k]));
    });

    /* ---------- ON POSE UNE GRILLE RECONNAISSABLE ---------- */
    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().save({ grid_type: 'square', snapping_increment: 1,",
      "  gridcolor: '#00FF00', gridopacity: 1, showgrid: true });"
    ].join("\n"));
    await dors(3000);
    await driver.executeScript(D + "\nd.engine.setZoom(1);");
    await dors(1000);
    await driver.executeScript(D + "\n" + [
      "var w = document.getElementById('editor-wrapper');",
      "w.scrollLeft = 125; w.scrollTop = 125;",
      "w.dispatchEvent(new Event('scroll', { bubbles: true }));"
    ].join("\n"));
    await dors(2000);
    await capture(driver, "grh-posee.png");

    /* ---------- 2. SUR QUELLE SURFACE ---------- */
    const surfaces = await driver.executeScript(D + "\n" + [
      "var e = d.engine, out = [];",
      "var cands = [];",
      "if (e.canvas) {",
      "  if (e.canvas.lowerCanvasEl) { cands.push(['fabric.lower', e.canvas.lowerCanvasEl.getContext('2d'), e.canvas.lowerCanvasEl]); }",
      "  if (e.canvas.upperCanvasEl) { cands.push(['fabric.upper', e.canvas.upperCanvasEl.getContext('2d'), e.canvas.upperCanvasEl]); }",
      "}",
      "if (e.final_canvas_ctx) { cands.push(['final_canvas', e.final_canvas_ctx, e.final_canvas_ctx.canvas]); }",
      "var w = e.work_canvases || {};",
      "for (var k in w) { if (w[k] && w[k].context && w[k].context.getImageData) { cands.push(['work.' + k, w[k].context, w[k].context.canvas]); } }",
      "cands.forEach(function (c) {",
      "  var o = { nom: c[0], vert: 0, err: null };",
      "  try {",
      "    var el = c[2], im = c[1].getImageData(0, 0, el.width, el.height).data;",
      "    for (var i = 0; i < im.length; i += 4) {",
      "      if (im[i] < 90 && im[i + 1] > 170 && im[i + 2] < 90 && im[i + 3] > 60) { o.vert++; }",
      "    }",
      "  } catch (x) { o.err = String(x).slice(0, 40); }",
      "  out.push(o);",
      "});",
      "return out;"
    ].join("\n"));
    console.log("\n  -- QUI PORTE SES LIGNES --");
    surfaces.forEach(function (s) {
      console.log("    " + String(s.nom).padEnd(16) + " pixels verts " + String(s.vert).padStart(8) +
        (s.err ? "   (" + s.err + ")" : ""));
    });
    const porteuse = surfaces.filter((s) => !s.err && s.vert > 200)
                             .sort((a, b) => a.vert - b.vert)[0];
    if (!porteuse) {
      console.log("\n    AUCUNE surface 2D ne la porte : elle est peinte en WebGL.");
    } else {
      console.log("\n    la porteuse : " + porteuse.nom);

      /* ---------- 3. OU TOMBENT-ELLES ---------- */
      const ou = await driver.executeScript(D + "\n" + [
        "var e = d.engine, nom = arguments[0];",
        "var ctx, el;",
        "if (nom === 'fabric.lower') { el = e.canvas.lowerCanvasEl; ctx = el.getContext('2d'); }",
        "else if (nom === 'final_canvas') { ctx = e.final_canvas_ctx; el = ctx.canvas; }",
        "else { ctx = e.work_canvases[nom.slice(5)].context; el = ctx.canvas; }",
        "var im = ctx.getImageData(0, 0, el.width, el.height).data;",
        "/* Une colonne est une ligne verticale si elle est verte sur toute sa hauteur. */",
        "var cols = [], lignes = [];",
        "for (var x = 0; x < el.width; x++) {",
        "  var n = 0;",
        "  for (var y = 0; y < el.height; y += 4) {",
        "    var i = (y * el.width + x) * 4;",
        "    if (im[i] < 90 && im[i + 1] > 170 && im[i + 2] < 90 && im[i + 3] > 60) { n++; }",
        "  }",
        "  if (n > el.height / 8) { cols.push(x); }",
        "}",
        "for (var y2 = 0; y2 < el.height; y2++) {",
        "  var m = 0;",
        "  for (var x2 = 0; x2 < el.width; x2 += 4) {",
        "    var j = (y2 * el.width + x2) * 4;",
        "    if (im[j] < 90 && im[j + 1] > 170 && im[j + 2] < 90 && im[j + 3] > 60) { m++; }",
        "  }",
        "  if (m > el.width / 8) { lignes.push(y2); }",
        "}",
        "return { cols: cols.slice(0, 24), lignes: lignes.slice(0, 24),",
        "  nCols: cols.length, nLignes: lignes.length,",
        "  zoom: e.canvasZoom, off: e.currentCanvasOffset, toile: [el.width, el.height] };"
      ].join("\n"), porteuse.nom);
      console.log("\n  -- OU TOMBENT SES LIGNES --");
      console.log("    zoom " + ou.zoom + "   decalage " + JSON.stringify(ou.off));
      console.log("    verticales (" + ou.nCols + ")   x = " + JSON.stringify(ou.cols));
      console.log("    horizontales (" + ou.nLignes + ")   y = " + JSON.stringify(ou.lignes));
      if (ou.cols.length > 2) {
        const p = [];
        for (let i = 1; i < ou.cols.length; i++) { p.push(ou.cols[i] - ou.cols[i - 1]); }
        console.log("    pas entre verticales : " + JSON.stringify(p));
      }
    }

    /* ---------- ET AU-DELA DE LA CARTE : QUE FAIT-IL ? ---------- */
    await driver.executeScript(D + "\nd.engine.setZoom(0.3);");
    await dors(1500);
    await capture(driver, "grh-large.png");

    /* ---------- ON REMET TOUT ---------- */
    await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), av = arguments[0], mis = {};",
      "['grid_type', 'snapping_increment', 'gridcolor', 'gridopacity', 'showgrid'].forEach(function (k) {",
      "  if (av[k] !== undefined) { mis[k] = av[k]; }",
      "});",
      "pg.save(mis);",
      "d.engine.setZoom(1);"
    ].join("\n"), avant);
    await dors(2500);
    const apres = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "return out;"
    ].join("\n"), CLES);
    const ecarts = CLES.filter((k) => JSON.stringify(apres[k]) !== JSON.stringify(avant[k]));
    console.log("\n  page remise : " + (ecarts.length ? "ECART sur " + ecarts.join(", ") : "identique a l origine"));
    ecarts.forEach((k) => console.log("      " + k + " : " + JSON.stringify(avant[k]) + " → " + JSON.stringify(apres[k])));

    releve("grh-" + campagne + ".json", { avant: avant, surfaces: surfaces, apres: apres });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE SA GRILLE FAIT, LU DANS SA SOURCE ----------
 *
 * La grille est bien affichée — la photo le montre — mais AUCUNE surface 2D ne
 * la porte : 239 pixels verts sur « lowerCanvasEl », c'est-à-dire les tracés
 * verts de la carte, pas des lignes. Elle est peinte en WebGL par
 * « d20.canvas_overlay.drawGrid », donc muette aux pixels.
 *
 * On ne va pas l'estimer à l'œil sur une photo : un décalage d'un pixel sur une
 * grille se voit sur toute la longueur. On lit sa source, qui dit exactement où
 * commencent ses lignes, de combien elles se répètent, et ce qu'elle fait aux
 * bords de la carte — c'est-à-dire précisément là où notre prolongement doit se
 * raccorder.
 *
 * LECTURE PURE : on ne modifie rien. Il faut cependant une grille pour que le
 * code intéressant soit atteignable, donc on en pose une et on remet la page
 * comme elle était.
 */
async function sourceDeLaGrille() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js srcg <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";
    const CLES = ["grid_type", "snapping_increment", "gridcolor", "grid_opacity",
                  "showgrid", "width", "height", "diagonaltype", "scale_number"];

    const avant = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "return out;"
    ].join("\n"), CLES);
    console.log("\n  la page avant : " + JSON.stringify(avant));

    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().save({ grid_type: 'square', snapping_increment: 1,",
      "  gridcolor: '#00FF00', grid_opacity: 1, showgrid: true });"
    ].join("\n"));
    await dors(3000);

    const src = await driver.executeScript(D + "\n" + [
      "var o = d.canvas_overlay, out = {};",
      "['drawGrid', 'compositeCanvases', 'drawBackground'].forEach(function (n) {",
      "  try { out[n] = String(o[n]); } catch (e) { out[n] = 'illisible'; }",
      "});",
      "/* Et ce que porte son contexte WebGL, qui recoit les sommets. */",
      "out.gl = [];",
      "try { for (var k in o.gl) { out.gl.push(k + ':' + typeof o.gl[k]); } } catch (e) {}",
      "/* Les fonctions de grille ailleurs. */",
      "out.ailleurs = [];",
      "try { for (var k2 in d) { if (/grid/i.test(k2)) { out.ailleurs.push('d20.' + k2 + ':' + typeof d[k2]); } } } catch (e) {}",
      "try { for (var k3 in d.engine) { if (/grid|snap/i.test(k3)) { out.ailleurs.push('engine.' + k3 + ':' + typeof d.engine[k3]); } } } catch (e) {}",
      "try { for (var k4 in d.utils) { if (/grid|snap/i.test(k4)) { out.ailleurs.push('utils.' + k4 + ':' + typeof d.utils[k4]); } } } catch (e) {}",
      "return out;"
    ].join("\n"));

    console.log("\n  ---------- drawGrid ----------");
    console.log("  " + String(src.drawGrid || "").split(String.fromCharCode(10)).join(String.fromCharCode(10) + "  ").slice(0, 5000));
    console.log("\n  ---------- ce qui parle de grille ailleurs ----------");
    console.log("  " + (src.ailleurs || []).join("  "));
    console.log("\n  ---------- son contexte WebGL ----------");
    console.log("  " + (src.gl || []).slice(0, 40).join("  "));

    /* Et le nuanceur, s il est atteignable : c est lui qui decide du trait. */
    const gl = await driver.executeScript(D + "\n" + [
      "var g = d.canvas_overlay.gl, out = {};",
      "['drawGrid', 'gridProgram', 'updateGlSize', 'active'].forEach(function (n) {",
      "  try { out[n] = typeof g[n] === 'function' ? String(g[n]).slice(0, 2000) : JSON.stringify(g[n]); } catch (e) {}",
      "});",
      "return out;"
    ].join("\n"));
    Object.keys(gl || {}).forEach(function (k) {
      console.log("\n  ---------- gl." + k + " ----------");
      console.log("  " + String(gl[k]).split(String.fromCharCode(10)).join(String.fromCharCode(10) + "  ").slice(0, 2200));
    });

    await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), av = arguments[0], mis = {};",
      "['grid_type', 'snapping_increment', 'gridcolor', 'grid_opacity', 'showgrid'].forEach(function (k) {",
      "  if (av[k] !== undefined) { mis[k] = av[k]; }",
      "});",
      "pg.save(mis);"
    ].join("\n"), avant);
    await dors(2500);
    const apres = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "return out;"
    ].join("\n"), CLES);
    const ecarts = CLES.filter((k) => JSON.stringify(apres[k]) !== JSON.stringify(avant[k]));
    console.log("\n  page remise : " + (ecarts.length ? "ECART sur " + ecarts.join(", ") : "identique a l origine"));

    releve("srcg-" + campagne + ".json", { src: src, gl: gl, avant: avant, apres: apres });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- SON drawGrid VEUT-IL BIEN PEINDRE CHEZ NOUS ? ----------
 *
 * Sa source est lisible, et elle est encourageante :
 *
 *     drawGrid(T) { ... const x = offset[1], k = offset[0], P = v.width, B = v.height,
 *                       R = activePage().get("grid_type");
 *                   showgrid && engine.snapTo > 0 && (
 *                     R == "hex"  ? d(T, -k, -x, P, B, "cols")
 *                   : R == "hexr" ? d(T, -k, -x, P, B, "rows")
 *                   : R === "dimetric" || R === "isometric" ? r(T, -k, -x)
 *                   :               e(T, -k, -x, P, B)) }
 *
 * « T » EST UN CONTEXTE 2D, passé de l'extérieur. Si on lui donne le nôtre, il
 * peint sa grille chez nous — carrés, hexagones par colonnes ou par rangées,
 * isométrique, dimétrique : les cinq types, avec SA géométrie, SES couleurs,
 * SON opacité. Rien à réimplémenter, rien à faire coïncider : c'est le même
 * code qui dessine les deux.
 *
 * MAIS SA GRILLE S'ARRÊTE À LA CARTE — la photo à 30 % le montre —, et c'est
 * tout l'objet du module. La question est donc : QUI l'arrête ? Sa source ne
 * passe que le décalage et la taille de la toile ; le bord de la page doit donc
 * être lu par la fonction interne, hors d'atteinte.
 *
 * DEUX ESSAIS, ET LE SECOND N'A LIEU QUE SI LE PREMIER ÉCHOUE :
 *   1. On l'appelle sur notre calque, tel quel. Si la grille dépasse la carte,
 *      le module est fait.
 *   2. Sinon, on lui MENT sur la taille de la page — le temps d'un appel
 *      synchrone, sans rien d'asynchrone entre les deux — et on regarde si sa
 *      grille s'étend d'autant.
 *
 * Campagne d'essai ; tous les réglages de page sont remis.
 */
async function drawGridChezNous() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js dg <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";
    const CLES = ["grid_type", "snapping_increment", "gridcolor", "grid_opacity", "showgrid", "width", "height"];
    const avant = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "return out;"
    ].join("\n"), CLES);
    console.log("\n  la page avant : " + JSON.stringify(avant));

    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().save({ grid_type: 'square', snapping_increment: 1,",
      "  gridcolor: '#00FF00', grid_opacity: 1, showgrid: true });"
    ].join("\n"));
    await dors(3000);
    await driver.executeScript(D + "\nd.engine.setZoom(0.3);");
    await dors(2500);

    /* Le calque, et ce qu on y voit. On compte les pixels HORS de la page. */
    const POSE = [
      "var e = d.engine;",
      "var vis = document.getElementById('babylonCanvas');",
      "var q = vis.getBoundingClientRect();",
      "var mien = document.getElementById('vttk-essai-grille');",
      "if (!mien) {",
      "  mien = document.createElement('canvas');",
      "  mien.id = 'vttk-essai-grille';",
      "  mien.style.cssText = 'position:fixed;pointer-events:none;z-index:9;';",
      "  vis.parentNode.appendChild(mien);",
      "}",
      "mien.width = vis.width; mien.height = vis.height;",
      "mien.style.left = q.left + 'px'; mien.style.top = q.top + 'px';",
      "mien.style.width = q.width + 'px'; mien.style.height = q.height + 'px';",
      "var ctx = mien.getContext('2d');",
      "ctx.clearRect(0, 0, mien.width, mien.height);"
    ].join("\n");

    const COMPTE = [
      "/* Le rectangle de la page, a l ecran. */",
      "var pg = window.Campaign.activePage();",
      "var z = e.canvasZoom, off = e.currentCanvasOffset;",
      "var px0 = (0 - off[0]) * z, py0 = (0 - off[1]) * z;",
      "var px1 = (pg.get('width') * 70 - off[0]) * z, py1 = (pg.get('height') * 70 - off[1]) * z;",
      "var im = ctx.getImageData(0, 0, mien.width, mien.height).data;",
      "var dedans = 0, dehors = 0;",
      "for (var y = 0; y < mien.height; y += 2) {",
      "  for (var x = 0; x < mien.width; x += 2) {",
      "    var i = (y * mien.width + x) * 4;",
      "    if (im[i + 3] < 20) { continue; }",
      "    if (x >= px0 && x <= px1 && y >= py0 && y <= py1) { dedans++; } else { dehors++; }",
      "  }",
      "}",
      "return { dedans: dedans, dehors: dehors, page: [Math.round(px0), Math.round(py0), Math.round(px1), Math.round(py1)],",
      "  toile: [mien.width, mien.height], zoom: z, off: off };"
    ].join("\n");

    console.log("\n  -- 1. drawGrid SUR NOTRE CALQUE, TEL QUEL --");
    const un = await driver.executeScript(D + "\n" + POSE + "\n" + [
      "try { d.canvas_overlay.drawGrid(ctx); } catch (x) { return { erreur: String(x).slice(0, 90) }; }"
    ].join("\n") + "\n" + COMPTE);
    console.log("    " + JSON.stringify(un));
    await capture(driver, "dg-tel-quel.png");

    console.log("\n  -- 2. AVEC SA TRANSFORMATION, ET RIEN D AUTRE --");
    const deux = await driver.executeScript(D + "\n" + POSE + "\n" + [
      "var z = e.canvasZoom || 1;",
      "ctx.setTransform(z, 0, 0, z, 0, 0);",
      "var err = null;",
      "try { d.canvas_overlay.drawGrid(ctx); } catch (x) { err = String(x).slice(0, 90); }",
      "ctx.setTransform(1, 0, 0, 1, 0, 0);",
      "if (err) { return { erreur: err }; }"
    ].join("\n") + "\n" + COMPTE);
    console.log("    " + JSON.stringify(deux));
    await capture(driver, "dg-transforme.png");

    /* ---------- 3. ET DECOUPE : SA CARTE LUI RESTE ----------
     *
     * Le decoupage se pose EN COORDONNEES D ECRAN, transformation a l identite,
     * puis la transformation vient par-dessus : « clip » retient la region en
     * espace du peripherique, pas en espace utilisateur. On garde tout SAUF le
     * rectangle de la page, et on limite le prolongement a N cases. */
    console.log("\n  -- 3. DECOUPE HORS DE LA CARTE, HUIT CASES --");
    const trois = await driver.executeScript(D + "\n" + POSE + "\n" + [
      "var pg = window.Campaign.activePage();",
      "var z = e.canvasZoom || 1, off = e.currentCanvasOffset || [0, 0];",
      "var pas = 70 * (pg.get('snapping_increment') || 1);",
      "var cases = 8, m = pas * cases;",
      "var L = pg.get('width') * 70, H = pg.get('height') * 70;",
      "function X(v) { return (v - off[0]) * z; }",
      "function Y(v) { return (v - off[1]) * z; }",
      "ctx.beginPath();",
      "ctx.rect(X(-m), Y(-m), (L + 2 * m) * z, (H + 2 * m) * z);   /* le dehors permis */",
      "ctx.rect(X(0), Y(0), L * z, H * z);                          /* sa carte, retiree */",
      "ctx.clip('evenodd');",
      "ctx.setTransform(z, 0, 0, z, 0, 0);",
      "var err = null;",
      "try { d.canvas_overlay.drawGrid(ctx); } catch (x) { err = String(x).slice(0, 90); }",
      "ctx.setTransform(1, 0, 0, 1, 0, 0);",
      "if (err) { return { erreur: err }; }"
    ].join("\n") + "\n" + COMPTE);
    console.log("    " + JSON.stringify(trois));
    await capture(driver, "dg-decoupe.png");

    /* ---------- ON REMET TOUT ---------- */
    await driver.executeScript("var n = document.getElementById('vttk-essai-grille'); if (n) { n.remove(); }");
    await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), av = arguments[0], mis = {};",
      "['grid_type', 'snapping_increment', 'gridcolor', 'grid_opacity', 'showgrid'].forEach(function (k) {",
      "  if (av[k] !== undefined) { mis[k] = av[k]; }",
      "});",
      "pg.save(mis);",
      "d.engine.setZoom(1);"
    ].join("\n"), avant);
    await dors(2500);
    const apres = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "return out;"
    ].join("\n"), CLES);
    const ecarts = CLES.filter((k) => JSON.stringify(apres[k]) !== JSON.stringify(avant[k]));
    console.log("\n  page remise : " + (ecarts.length ? "ECART sur " + ecarts.join(", ") : "identique a l origine"));

    releve("dg-" + campagne + ".json", { un: un, deux: deux, avant: avant, apres: apres });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA GRILLE HÉRITÉE, À L'ÉPREUVE — ET LES TROIS ENSEMBLE ----------
 *
 * Six questions :
 *
 *   1. LE PONT AIGUILLE-T-IL, et répond-il tout de suite ?
 *   2. LA GRILLE SE PROLONGE-T-ELLE, et de combien de cases ?
 *   3. SA CARTE RESTE-T-ELLE À LUI ? Zéro pixel de nous à l'intérieur : c'est
 *      la garantie qu'il n'y aura ni double trait ni moiré.
 *   4. LES DEUX PEINTRES COHABITENT-ILS ? La grille pose une transformation
 *      pour le drawGrid de Roll20 ; si elle survivait au peintre suivant, les
 *      marqueurs seraient dessinés à trois fois la bonne taille.
 *   5. SANS GRILLE CHEZ LUI, NE PEINT-ON RIEN ? Prolonger ce qui n'existe pas
 *      serait dessiner une grille là où le MJ a choisi de n'en pas avoir.
 *   6. L'EXTINCTION REND-ELLE LA PAGE INTACTE ?
 *
 * Campagne d'essai ; tous les réglages de page et le jeton sont remis.
 */
async function epreuveGrilleHeritee() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js egh <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  /* CE QU'ON EMPRUNTE SE REND DANS UN « finally », TOUJOURS. La restitution
   * était la dernière ligne du corps : une exception au milieu — et il y en a
   * eu une — a laissé la table d'essai habillée de ma grille verte jusqu'à la
   * course suivante. */
  let rendreLaPage = null, rendreLeJeton = null;
  const rends = async (dr) => {
    try {
      if (rendreLaPage) {
        await dr.executeScript(
          "window.Campaign.activePage().save(arguments[0]);", rendreLaPage);
      }
      if (rendreLeJeton) {
        await dr.executeScript(
          "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
          "if (t) { t.save({ statusmarkers: arguments[1] }); }",
          rendreLeJeton.id, rendreLeJeton.sm);
      }
      await dr.executeScript(
        "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
        "if (d && d.engine) { d.engine.setZoom(1); }");
    } catch (e) { console.log("  la restitution a echoue : " + String(e).slice(0, 80)); }
  };
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";
    const CLES = ["grid_type", "snapping_increment", "gridcolor", "grid_opacity", "showgrid", "width", "height"];
    /* SON ÉTAT D'ORIGINE, RELEVÉ AVANT LA PREMIÈRE POSE. Une course précédente
     * a planté avant de rendre la page : elle porte encore ma grille verte,
     * donc la relire ne rendrait que ma pollution. */
    const ORIGINE = { grid_type: "square", snapping_increment: 0, gridcolor: "#C0C0C0",
                      grid_opacity: 0.5, showgrid: false };
    const avant = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "return out;"
    ].join("\n"), CLES);
    console.log("\n  la page telle qu on la trouve : " + JSON.stringify(avant));
    console.log("  on la rendra a : " + JSON.stringify(ORIGINE));
    rendreLaPage = ORIGINE;

    /* ON ÉTEINT TOUT AVANT DE MESURER, et c'est une nécessité de l'instrument.
     * L'extension allume ses modules d'elle-même au démarrage — ses réglages
     * persistent dans le profil du pilote —, et les marqueurs peignent des
     * images d'un autre domaine, qui TEINTENT le calque : « getImageData »
     * lèverait SecurityError sur notre propre mesure. Rayer le dernier peintre
     * détruit le calque ; le suivant en fabrique un neuf, donc net. */
    await driver.executeScript([
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');",
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', actif: false }, '*');"
    ].join("\n"));
    await dors(1500);

    const cible = await driver.executeScript(D + "\n" + [
      "var g = window.Campaign.activePage().thegraphics.models, best = null;",
      "g.forEach(function (t) {",
      "  if (String(t.get('layer')) !== 'objects') { return; }",
      "  var w = t.get('width') || 0;",
      "  if (w > 200) { return; }",
      "  if (!best || w > best.w) { best = { id: t.id, w: w, x: t.get('left'), y: t.get('top'),",
      "    sm: t.get('statusmarkers') || '' }; }",
      "});",
      "return best;"
    ].join("\n"));
    /* MÊME CAUSE, MÊME CORRECTION : le jeton porte encore les marqueurs d'essai
     * de la course plantée. Son vrai état d'origine a été relevé avant la
     * première pose, et c'est celui-là qu'on lui rend. */
    const JETON_ORIGINE = "bleeding-eye";
    rendreLeJeton = { id: cible.id, sm: JETON_ORIGINE };

    /* ---------- 5. SANS GRILLE CHEZ LUI ---------- */
    const ecoute = [
      "window.__vkG = null;",
      "window.addEventListener('message', function (ev) {",
      "  var m = ev.data;",
      "  if (m && m.ns === 'vttinker' && m.depuis === 'page' && m.type === 'grille-resultat') { window.__vkG = m; }",
      "}, false);"
    ].join("\n");
    await driver.executeScript(ecoute);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', cases: 8 }, '*');");
    await dors(1200);
    const sans = await driver.executeScript([
      "var c = document.getElementById('vttk-calque');",
      "var n = 0;",
      "if (c) {",
      "  var im = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;",
      "  for (var i = 3; i < im.length; i += 4) { if (im[i] > 20) { n++; } }",
      "}",
      "return { reponse: window.__vkG, calque: !!c, pixels: n };"
    ].join("\n"));
    console.log("\n  -- 1 ET 5. L AIGUILLAGE, SANS GRILLE CHEZ LUI --");
    console.log("    " + JSON.stringify(sans.reponse));
    console.log("    calque " + sans.calque + "   pixels peints " + sans.pixels +
      (sans.pixels === 0 ? "   (rien, et c est ce qu il faut)" : "   IL A PEINT SANS GRILLE"));

    /* ---------- ON POSE UNE GRILLE, ET LES MARQUEURS ---------- */
    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().save({ grid_type: 'square', snapping_increment: 1,",
      "  gridcolor: '#00FF00', grid_opacity: 1, showgrid: true });"
    ].join("\n"));
    await dors(3000);
    /* LA GRILLE SEULE D'ABORD, ET LES MARQUEURS APRÈS — une image d'un autre
     * domaine teinte la toile, et « getImageData » lèverait SecurityError sur
     * notre propre mesure. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', cases: 8 }, '*');");
    await dors(1500);

    /* ---------- 2, 3, 4 : ON COMPTE ET ON PHOTOGRAPHIE ---------- */
    async function regarde(zoom, nom) {
      await driver.executeScript(D + "\nd.engine.setZoom(arguments[0]);", zoom);
      await dors(2000);
      const r = await driver.executeScript(D + "\n" + [
        "var c = document.getElementById('vttk-calque');",
        "if (!c) { return { calque: false }; }",
        "var pg = window.Campaign.activePage();",
        "var z = d.engine.canvasZoom, off = d.engine.currentCanvasOffset;",
        "var x0 = (0 - off[0]) * z, y0 = (0 - off[1]) * z;",
        "var x1 = (pg.get('width') * 70 - off[0]) * z, y1 = (pg.get('height') * 70 - off[1]) * z;",
        "var im = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;",
        "var dedans = 0, dehors = 0;",
        "var bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;",
        "for (var y = 0; y < c.height; y += 2) {",
        "  for (var x = 0; x < c.width; x += 2) {",
        "    var i = (y * c.width + x) * 4;",
        "    if (im[i + 3] < 20) { continue; }",
        "/* UN PIXEL DE TOLERANCE AU BORD, ET C EST UNE CORRECTION DE L INSTRUMENT.",
        "   La boite des fautifs valait [0, 1050, 660, 1050] : UNE SEULE RANGEE, sur",
        "   le bord meme de la page. C est le lisere du decoupage, pas un",
        "   debordement — le bord appartient aux deux cotes, et une comparaison",
        "   large le comptait dedans. On demande donc STRICTEMENT dedans. */",
        "    if (x > x0 + 1 && x < x1 - 1 && y > y0 + 1 && y < y1 - 1) {",
        "      dedans++;",
        "      if (x < bx0) { bx0 = x; } if (x > bx1) { bx1 = x; }",
        "      if (y < by0) { by0 = y; } if (y > by1) { by1 = y; }",
        "    } else { dehors++; }",
        "  }",
        "}",
        "return { calque: true, dedans: dedans, dehors: dehors, zoom: z,",
        "  boite: dedans ? [bx0, by0, bx1, by1] : null,",
        "  peintres: (window.__vttinkerPeintres || null),",
        "  toile: [c.width, c.height],",
        "  page: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)],",
        "  erreur: window.__vttinkerCalqueErreur || null };"
      ].join("\n"));
      console.log("    a " + Math.round(zoom * 100) + " %   dedans " + String(r.dedans).padStart(6) +
        "   dehors " + String(r.dehors).padStart(6) + "   page " + JSON.stringify(r.page) +
        "   toile " + JSON.stringify(r.toile) +
        (r.erreur ? "   ERREUR : " + r.erreur : ""));
      if (r.boite) { console.log("      leur boite : " + JSON.stringify(r.boite) +
        "   peintres " + JSON.stringify(r.peintres)); }
      await capture(driver, nom);
      return r;
    }
    console.log("\n  -- 2 ET 3. LE PROLONGEMENT, ET SA CARTE --");
    console.log("    (« dedans » compte NOS pixels dans SA carte : il doit valoir zero)");
    const large = await regarde(0.3, "egh-030.png");
    await regarde(0.6, "egh-060.png");

    /* 4. Les marqueurs, MAINTENANT : la mesure de la grille est faite, la toile
     * peut etre teintee. */
    await driver.executeScript([
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true,",
      "  catalogue: [{ tag: 'vttk_essaia_cdn.discordapp.com/embed/avatars/0.png', nom: 'Essai A',",
      "    url: 'https://cdn.discordapp.com/embed/avatars/0.png' }] }, '*');"
    ].join("\n"));
    await dors(1500);
    await driver.executeScript(D + "\n" +
      "window.Campaign.activePage().thegraphics.get(arguments[0]).save({ statusmarkers: arguments[1] });",
      cible.id, "red,vttk_essaia_cdn.discordapp.com/embed/avatars/0.png@3");
    await dors(2500);
    await driver.executeScript(D + "\nd.engine.setZoom(2.5);");
    await dors(1200);
    await driver.executeScript(D + "\n" + [
      "var w = document.getElementById('editor-wrapper');",
      "w.scrollLeft = 125 + arguments[0] * d.engine.canvasZoom - w.clientWidth / 2;",
      "w.scrollTop = 125 + arguments[1] * d.engine.canvasZoom - w.clientHeight / 2;",
      "w.dispatchEvent(new Event('scroll', { bubbles: true }));"
    ].join("\n"), cible.x, cible.y);
    await dors(2000);
    console.log("\n  -- 4. LES DEUX PEINTRES ENSEMBLE --");
    const err = await driver.executeScript("return window.__vttinkerCalqueErreur || null;");
    console.log("    erreur de peintre : " + JSON.stringify(err));
    await capture(driver, "egh-ensemble.png");

    /* ---------- 6. L EXTINCTION ---------- */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', actif: false }, '*');");
    await dors(1200);
    const apresG = await driver.executeScript(
      "return { calque: !!document.getElementById('vttk-calque'), reponse: window.__vkG };");
    console.log("\n  -- 6. L EXTINCTION --");
    console.log("    grille eteinte, calque " + apresG.calque + " (les marqueurs le gardent)  " +
      JSON.stringify(apresG.reponse));
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');");
    await dors(1200);
    const apresM = await driver.executeScript(
      "return { calque: !!document.getElementById('vttk-calque') };");
    console.log("    marqueurs eteints, calque " + apresM.calque +
      (apresM.calque ? "   IL RESTE" : "   (retire)"));

    /* ---------- ON REMET TOUT ---------- */
    await rends(driver);
    await dors(2500);
    const apres = await driver.executeScript(D + "\n" + [
      "var pg = window.Campaign.activePage(), out = {};",
      "arguments[0].forEach(function (k) { out[k] = pg.get(k); });",
      "out.sm = pg.thegraphics.get(arguments[1]).get('statusmarkers');",
      "return out;"
    ].join("\n"), CLES, cible.id);
    /* ON COMPARE À L'ORIGINE, PAS À CE QU'ON A TROUVÉ. Le premier jet comparait
     * à l'état trouvé — c'est-à-dire à la grille verte qu'une course plantée
     * avait laissée — et annonçait donc un ECART là où la restitution venait
     * précisément de réussir. */
    const ecarts = Object.keys(ORIGINE).filter((k) => JSON.stringify(apres[k]) !== JSON.stringify(ORIGINE[k]));
    console.log("\n  page remise : " + (ecarts.length ? "ECART sur " + ecarts.join(", ") : "identique a l origine"));
    ecarts.forEach((k) => console.log("      " + k + " : attendu " + JSON.stringify(ORIGINE[k]) +
      "  trouve " + JSON.stringify(apres[k])));
    console.log("  jeton remis a " + JSON.stringify(apres.sm) +
      (String(apres.sm) === JETON_ORIGINE ? "   (identique a l origine)" : "   ECART"));

    releve("egh-" + campagne + ".json", { sans: sans, large: large, avant: avant, apres: apres });
    return 0;
  } finally {
    await rends(driver);
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- JUMPGATE N'A PAS RÉGRESSÉ ----------
 *
 * Le port vers l'ancien moteur a touché UNE chose du moteur moderne, et une
 * seule : l'ordre de la coupure dans « surMolette ». Le défaut avait été mesuré
 * en héritage — bornes 10–800, zoom à 800, un cran vers le haut ramenait la
 * carte à 250 % — et il dormait à l'identique ici : l'écouteur voyait notre
 * borne, renonçait, et ne coupait pas ; Roll20 recevait alors le geste et
 * bornait à SA plage.
 *
 * On vérifie donc trois choses sur une vraie partie Jumpgate :
 *   1. Le module s'installe toujours, et par la bonne branche.
 *   2. À notre plafond, un cran de plus NE RAMÈNE PLUS la carte. C'est la
 *      correction, et elle doit se voir ici aussi.
 *   3. Tout le reste marche comme avant : on prolonge au-delà de 250, on
 *      redescend, on rentre dans sa plage, et l'extinction rend la partie.
 *
 * Campagne d'essai ; le zoom revient à sa valeur de départ.
 */
async function jumpgateSansRegression() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js jg <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const moteur = await driver.executeScript([
      "if (window.MeshScene) { return 'jumpgate'; }",
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;",
      "if (d && d.engine && d.engine.canvas) { return 'heritage'; }",
      "return 'inconnu';"
    ].join("\n"));
    console.log("\n  moteur : " + moteur);
    if (moteur !== "jumpgate") {
      console.log("  cette sonde ne vaut que pour Jumpgate.");
      return 1;
    }

    const lit = async () => driver.executeScript([
      "var n = document.querySelectorAll('div,body>*');",
      "for (var i = 0; i < n.length; i++) {",
      "  try {",
      "    var p = n[i].__vue_app__ && n[i].__vue_app__.config.globalProperties.$pinia;",
      "    var st = p && p._s && p._s.get('engine');",
      "    if (st) { return st.zoom; }",
      "  } catch (e) {}",
      "}",
      "return null;"
    ].join("\n"));
    /* CE QUE LA CARTE MONTRE, ET PAS CE QUE SON MAGASIN CROIT. Hors de sa plage
     * le magasin garde 250 pendant que la caméra est à 800 : c'est la caméra
     * qui dit la vérité, et c'est elle qu'il faut lire. */
    const camera = async () => driver.executeScript([
      "var cams = (window.MeshScene && window.MeshScene.cameras) || [];",
      "var c = null;",
      "for (var i = 0; i < cams.length; i++) {",
      "  if (String(cams[i].name || '') === 'vtt-main-camera') { c = cams[i]; }",
      "}",
      "if (!c) { c = cams[0]; }",
      "var t = document.getElementById('babylonCanvas');",
      "if (!c || !t) { return null; }",
      "return Math.round((t.height / 2) * 100 / c.orthoTop);"
    ].join("\n"));
    const depart = await lit();
    console.log("  zoom au depart : " + depart);

    const rep = await driver.executeScript([
      "window.__vkR = null;",
      "window.addEventListener('message', function (ev) {",
      "  var m = ev.data;",
      "  if (m && m.ns === 'vttinker' && m.depuis === 'page' && m.type === 'zoom-resultat') { window.__vkR = m; }",
      "}, false);",
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', min: 10, max: 800 }, '*');",
      "return true;"
    ].join("\n"));
    await dors(1800);
    console.log("\n  -- 1. L INSTALLATION --");
    console.log("    " + JSON.stringify(await driver.executeScript("return window.__vkR;")));

    async function veut(v) {
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: arguments[0] }, '*');", v);
      await dors(1200);
      return camera();
    }
    async function cran(sens) {
      const av = await camera();
      await driver.executeScript([
        "var cv = document.getElementById('babylonCanvas');",
        "var q = cv.getBoundingClientRect();",
        "cv.dispatchEvent(new WheelEvent('wheel', { deltaY: arguments[0], bubbles: true, cancelable: true,",
        "  clientX: q.left + q.width / 2, clientY: q.top + q.height / 2 }));"
      ].join("\n"), sens > 0 ? -102 : 102);
      await dors(1200);
      const ap = await camera();
      return { av: av, ap: ap };
    }

    console.log("\n  -- 2. A NOTRE PLAFOND, UN CRAN DE PLUS NE RAMENE PLUS --");
    const a800 = await veut(800);
    console.log("    pose a 800  →  la camera dit " + a800);
    const haut = await cran(+1);
    console.log("    un cran vers le haut : " + haut.av + " → " + haut.ap +
      (haut.ap !== null && haut.ap >= 700 ? "   (il tient)" : "   IL A ETE RAMENE"));
    const bas = await cran(-1);
    console.log("    un cran vers le bas  : " + bas.av + " → " + bas.ap +
      (bas.ap !== null && bas.ap < bas.av ? "   (il descend)" : "   IL N A PAS BOUGE"));

    console.log("\n  -- 3. LE RESTE, COMME AVANT --");
    await veut(250);
    const p250 = await cran(+1);
    console.log("    depuis 250, un cran vers le haut : " + p250.av + " → " + p250.ap +
      (p250.ap !== null && p250.ap > 250 ? "   (il prolonge)" : "   IL EST BLOQUE"));
    const r150 = await veut(150);
    console.log("    retour dans sa plage, a 150 : " + r150);

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 600 }, '*');");
    await dors(1200);
    const avOff = await camera();
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');");
    await dors(1800);
    const apOff = await camera(), stOff = await lit();
    console.log("    eteint depuis " + avOff + "  →  camera " + apOff + "   magasin " + stOff +
      (apOff !== null && apOff <= 260 ? "   (dans sa plage)" : "   HORS DE SA PLAGE"));
    await capture(driver, "jg-eteint.png");

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', min: 10, max: 800 }, '*');");
    await dors(800);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: arguments[0] }, '*');", depart);
    await dors(800);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');");
    await dors(1200);
    console.log("\n  zoom remis a " + (await camera()));

    releve("jg-" + campagne + ".json", { depart: depart, haut: haut, bas: bas, p250: p250, apOff: apOff });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE LES DEUX PEINTRES COÛTENT VRAIMENT ----------
 *
 * « Je veux un outil optimisé. » On n'y répond pas en relisant le code : on
 * compte. C'est ainsi qu'on a trouvé, sur le zoom de Jumpgate, les 555 ms par
 * mutation d'un $subscribe dont le rappel était VIDE.
 *
 * Une trame qui bat à la fréquence de l'écran mérite le même traitement. Trois
 * mesures, sur la même partie :
 *
 *   1. AU REPOS, SANS PEINTRE — la référence : ce que le navigateur fait sans
 *      nous, en trames par seconde.
 *   2. AVEC LA GRILLE SEULE — elle appelle le drawGrid de Roll20, qui trace des
 *      centaines de lignes.
 *   3. AVEC LES DEUX — le peintre des marqueurs parcourt tous les jetons de la
 *      page à chaque trame, et c'est lui qu'on soupçonne.
 *
 * On lit le compteur du calque — trames, millisecondes cumulées, pire trame —
 * et on rend une moyenne. On compte AUSSI les trames du navigateur, parce
 * qu'une moyenne basse sur une trame qui a chuté à trente images par seconde ne
 * voudrait rien dire.
 */
async function coutDesPeintres() {
  const campagne = process.argv[3];
  if (!campagne) { console.log("  usage : node outils/pilote.js coutp <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  let rendreLaPage = null;
  const rends = async (dr) => {
    try {
      if (rendreLaPage) {
        await dr.executeScript("window.Campaign.activePage().save(arguments[0]);", rendreLaPage);
      }
      await dr.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', actif: false }, '*');" +
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');");
    } catch (e) { console.log("  la restitution a echoue : " + String(e).slice(0, 70)); }
  };
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    const D = "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;";
    const ORIGINE = { grid_type: "square", snapping_increment: 0, gridcolor: "#C0C0C0",
                      grid_opacity: 0.5, showgrid: false };
    rendreLaPage = ORIGINE;

    const jetons = await driver.executeScript(D + "\n" +
      "return window.Campaign.activePage().thegraphics.models.length;");
    console.log("\n  jetons sur la page : " + jetons);

    /* On repart de zero : aucun peintre. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', actif: false }, '*');" +
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');");
    await dors(1500);

    /* La reference du navigateur, sans nous. */
    await driver.executeScript([
      "window.__vbT = 0;",
      "(function b() { window.__vbT++; window.__vbR = requestAnimationFrame(b); })();"
    ].join("\n"));

    async function mesure(titre) {
      await driver.executeScript(
        "window.__vbT = 0;" +
        "if (window.__vttinkerCalque) { window.__vttinkerCalque.trames = 0;" +
        "  window.__vttinkerCalque.ms = 0; window.__vttinkerCalque.max = 0; }");
      await dors(4000);
      const r = await driver.executeScript(
        "return { trames: window.__vbT, c: window.__vttinkerCalque || null," +
        "  peintres: window.__vttinkerPeintres || [] };");
      const c = r.c;
      const moy = (c && c.trames) ? (c.ms / c.trames) : 0;
      console.log("    " + titre.padEnd(26) +
        " navigateur " + String(Math.round(r.trames / 4)).padStart(4) + " img/s" +
        "   nos trames " + String(c ? c.trames : 0).padStart(4) +
        "   moyenne " + moy.toFixed(3) + " ms" +
        "   pire " + (c ? c.max.toFixed(2) : "-") + " ms" +
        "   [" + (r.peintres || []).join(" ") + "]");
      return { moy: moy, img: Math.round(r.trames / 4), max: c ? c.max : 0 };
    }

    console.log("\n  -- CE QUE COUTE UNE TRAME --");
    const vide = await mesure("aucun peintre");

    await driver.executeScript(D + "\n" + [
      "window.Campaign.activePage().save({ grid_type: 'square', snapping_increment: 1,",
      "  gridcolor: '#C0C0C0', grid_opacity: 0.5, showgrid: true });"
    ].join("\n"));
    await dors(3000);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', cases: 12 }, '*');");
    await dors(2000);
    const grille = await mesure("la grille seule");

    await driver.executeScript([
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true,",
      "  catalogue: [{ tag: 'vttk_essaia_cdn.discordapp.com/embed/avatars/0.png', nom: 'Essai A',",
      "    url: 'https://cdn.discordapp.com/embed/avatars/0.png' }] }, '*');"
    ].join("\n"));
    await dors(2500);
    const deux = await mesure("les deux");

    /* ET LE PIRE CAS : tous les jetons portent un de nos marqueurs. On les rend
     * ensuite tels qu'ils etaient — chacun le sien. */
    const avantJetons = await driver.executeScript(D + "\n" + [
      "var out = [];",
      "window.Campaign.activePage().thegraphics.models.forEach(function (t) {",
      "  out.push({ id: t.id, sm: t.get('statusmarkers') || '' });",
      "  t.save({ statusmarkers: 'red,blue,vttk_essaia_cdn.discordapp.com/embed/avatars/0.png@12' });",
      "});",
      "return out;"
    ].join("\n"));
    await dors(4000);
    const pire = await mesure("tous les jetons marques");
    await driver.executeScript(D + "\n" + [
      "arguments[0].forEach(function (x) {",
      "  var t = window.Campaign.activePage().thegraphics.get(x.id);",
      "  if (t) { t.save({ statusmarkers: x.sm }); }",
      "});"
    ].join("\n"), avantJetons);
    await dors(2500);

    console.log("\n  -- CE QUE ÇA VEUT DIRE --");
    const part = (x) => (x.moy * x.img / 10).toFixed(2);
    console.log("    la grille seule occupe " + part(grille) + " % d un coeur");
    console.log("    les deux ensemble      " + part(deux) + " %");
    console.log("    tous les jetons marques " + part(pire) + " %   (pire trame " + pire.max.toFixed(2) + " ms)");
    console.log("    les images du navigateur : " + vide.img + " → " + pire.img + " par seconde");

    releve("coutp-" + campagne + ".json", { jetons: jetons, vide: vide, grille: grille, deux: deux, pire: pire });
    return 0;
  } finally {
    await rends(driver);
    await dors(1500);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE PROTOCOLE PASSE-T-IL ENCORE ? ----------
 *
 * On vient de poser deux gardes sur chaque écouteur de message : l'origine, et
 * la fenêtre émettrice. Le banc dit qu'elles écartent ce qui vient d'ailleurs
 * et laissent passer le reste — mais le banc est un MODÈLE, et c'est
 * précisément l'identité d'un objet fenêtre entre deux mondes qu'il modélise le
 * plus mal : il a fallu lui faire déposer sa propre fenêtre pour qu'il la
 * reconnaisse.
 *
 * Dans le navigateur, le script de contenu et le pont vivent dans deux mondes
 * SUR UNE SEULE fenêtre, séparés par les enveloppes de sécurité de Firefox.
 * Rien ne garantit d'avance que « ev.source === window » y soit vrai. Si ça ne
 * l'est pas, l'extension entière devient muette — et muette EN SILENCE, chaque
 * message étant simplement ignoré.
 *
 * ON ÉPROUVE DONC LES QUATRE SENS DU PROTOCOLE SUR UNE VRAIE PARTIE :
 *   1. page → contenu   l'annonce du moteur
 *   2. contenu → page   la pose d'un module
 *   3. page → contenu   la réponse à cette pose
 *   4. panneau → page   la hauteur du cadre de réglages, seul message venu
 *                       d'une AUTRE origine qui soit légitime
 */
async function protocoleApresGardes() {
  const campagne = process.argv[3] || (config().essais || {}).heritage;
  if (!campagne) { console.log("  usage : node outils/pilote.js proto <id>"); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, campagne))) { console.log("La partie ne s'est pas chargee."); return 1; }
    await dors(14000);

    /* ---------- 1 ET 2. LES DEUX SENS ORDINAIRES ---------- */
    const r = await driver.executeScript([
      "window.__protoRecu = [];",
      "window.addEventListener('message', function (ev) {",
      "  var m = ev.data;",
      "  if (m && m.ns === 'vttinker' && m.depuis === 'page') {",
      "    window.__protoRecu.push({ type: m.type, origine: ev.origin, memeFenetre: ev.source === window });",
      "  }",
      "}, false);",
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'recon' }, location.origin);",
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true,",
      "  catalogue: [{ tag: 'vttk_p_cdn.discordapp.com/embed/avatars/0.png', nom: 'P',",
      "    url: 'https://cdn.discordapp.com/embed/avatars/0.png' }] }, location.origin);",
      "return true;"
    ].join("\n"));
    await dors(2500);
    const recu = await driver.executeScript("return window.__protoRecu;");
    console.log("\n  -- LE PONT REPOND-IL ENCORE ? --");
    (recu || []).forEach(function (x) {
      console.log("    " + String(x.type).padEnd(20) + " origine " + x.origine +
        "   meme fenetre : " + x.memeFenetre);
    });
    const aRepondu = (recu || []).some(function (x) { return x.type === "recon-resultat"; });
    const aPose = (recu || []).some(function (x) { return x.type === "marqueurs-resultat"; });
    console.log("    " + (aRepondu ? "il repond a « recon »" : "AUCUNE REPONSE A « recon »"));
    console.log("    " + (aPose ? "il pose les marqueurs" : "AUCUNE REPONSE A « marqueurs »"));

    /* LA QUESTION QUI DECIDE : le pont voit-il la fenetre du script de contenu
     * comme la SIENNE ? On le lui demande directement. */
    const meme = await driver.executeScript([
      "return { memeFenetre: window === window.top,",
      "  origine: location.origin,",
      "  moteur: window.__vttinkerMoteur || null };"
    ].join("\n"));
    console.log("    window === window.top : " + meme.memeFenetre + "   origine : " + meme.origine);

    /* ---------- 3. LE PANNEAU, SEUL MESSAGE VENU D'AILLEURS ---------- */
    console.log("\n  -- LE CADRE DE REGLAGES --");
    /* LE PANNEAU S OUVRE PAR SON BOUTON, ET PAS PAR UN MESSAGE — il n existe
     * aucun type « reglages » dans le protocole. Le premier jet en inventait un
     * et concluait que la garde d origine refusait le panneau, alors que rien
     * ne l avait jamais ouvert. */
    /* L'ÉCOUTEUR EST SUR LE BOUTON INTERNE, et pas sur le nœud qui porte la
     * classe : « faisBoutonOutil » cherche un « button » dans le nœud cloné et
     * écoute CELUI-LÀ. Cliquer le conteneur ne déclenche rien — et la sonde en
     * concluait que la garde d'origine refusait un panneau que rien n'avait
     * jamais ouvert. Deux instruments fautifs de suite sur la même mesure. */
    const clique = await driver.executeScript(
      "var n = document.querySelector('.vttk-outil-reglages');" +
      "if (!n) { return 'aucun bouton de reglages'; }" +
      "var b = n.querySelector('button') || n;" +
      "b.click();" +
      "return b === n ? 'clic sur le noeud' : 'clic sur le button interne';");
    console.log("    " + clique);
    /* SIX SECONDES, ET C'EST MESURÉ. Le cadre doit charger sa page, lire le
     * stockage, se peindre, se mesurer, puis parler. À trois secondes il n'avait
     * pas fini, et la sonde concluait que la garde d'origine le refusait. */
    await dors(6000);
    /* ET SI RIEN NE S OUVRE : on dit CE QU ON VOIT, plutot que de conclure. */
    const etatBarre = await driver.executeScript([
      "return { titre: document.querySelectorAll('.vttk-outil-titre').length,",
      "  bouton: document.querySelectorAll('.vttk-outil-reglages').length,",
      "  outils: document.querySelectorAll('[class*=vttk-outil]').length,",
      "  cadres: document.querySelectorAll('iframe').length,",
      "  reglages: document.querySelectorAll('.vttk-reglages').length };"
    ].join("\n"));
    console.log("    la barre : " + JSON.stringify(etatBarre));

    const cadre = await driver.executeScript([
      "/* LA HAUTEUR SE POSE SUR L'ENVELOPPE, pas sur le cadre : poseHauteurPanneau",
      "   ecrit reglages.style.height, et « reglages » est le div .vttk-reglages.",
      "   La sonde lisait le style de l'iframe — vide, evidemment — et concluait",
      "   que la garde d'origine refusait le message. */",
      "var e = document.querySelector('.vttk-reglages');",
      "var c = document.querySelector('.vttk-reglages-cadre, iframe[src*=\"panneau\"]');",
      "if (!e && !c) { return { present: false }; }",
      "return { present: true, hauteur: e ? e.style.height : '', cadre: !!c,",
      "  src: String((c && c.src) || '').slice(0, 60) };"
    ].join("\n"));
    console.log("    " + JSON.stringify(cadre));
    console.log("    " + (cadre.present && cadre.hauteur && cadre.hauteur !== "0px"
      ? "le panneau a annonce sa hauteur, et le pont l'a acceptee"
      : "LA HAUTEUR N'EST PAS APPLIQUEE — la garde d'origine du panneau refuse"));

    /* ---------- 4. ET L'EXTINCTION ---------- */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, location.origin);");
    await dors(1200);
    await capture(driver, "proto.png");

    const verdict = aRepondu && aPose && cadre.present && cadre.hauteur && cadre.hauteur !== "0px";
    console.log("\n  " + (verdict
      ? "LE PROTOCOLE PASSE DANS LES QUATRE SENS. Les gardes n'ont rien cassé."
      : "QUELQUE CHOSE NE PASSE PLUS — voir ci-dessus."));

    releve("proto-" + campagne + ".json", { recu: recu, meme: meme, cadre: cadre });
    return verdict ? 0 : 1;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE JETON HORS PAGE EST-IL SEULEMENT DESSINÉ ? ----------
 *
 * Cinq leviers de nuanceur essayés, aucun pixel. On a écrit dans le tableau
 * réellement téléversé, on l'a poussé, on a basculé « gmMode », on a dégelé les
 * matériaux : rien. Et pourtant le nuanceur, lu dans sa source, dit bien
 * « if (offBoard && v_Board.z == 0.) discard; ».
 *
 * TOUTE CETTE ENQUÊTE SUPPOSE QUE LE JETON EST DESSINÉ PUIS JETÉ. Personne ne
 * l'a vérifié. S'il n'est pas soumis du tout — instance désactivée, retirée de
 * la scène, écartée par le tronc de vue, ou jamais créée — alors aucun levier
 * de nuanceur ne pouvait mordre, et l'on a cherché cinq fois au mauvais endroit.
 *
 * C'est LA question, et elle se pose avant toutes les autres. On relève l'état
 * du maillage du même jeton, dedans puis dehors, sans rien toucher.
 */
async function estIlDessine() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    const LIS = [
      "var S = window.MeshScene;",
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var t = g[arguments[0]];",
      "if (!S || !t) { return { erreur: 'pas de scene ou pas de jeton' }; }",
      "/* On retrouve TOUT ce qui porte l'identifiant du jeton, sans supposer",
      "   qu'il n'y en a qu'un ni où il est rangé. */",
      "var siens = [];",
      "S.meshes.forEach(function (m) {",
      "  var n = String(m.name || '');",
      "  if (n.indexOf(t.id) < 0) { return; }",
      "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  siens.push({",
      "    nom: n.slice(0, 40),",
      "    instance: !!m.sourceMesh,",
      "    actif: (typeof m.isEnabled === 'function') ? m.isEnabled() : null,",
      "    visible: m.isVisible,",
      "    visibilite: m.visibility,",
      "    dansLaScene: S.meshes.indexOf(m) >= 0,",
      "    groupe: m.renderingGroupId,",
      "    position: m.position ? [Math.round(m.position.x), Math.round(m.position.y), Math.round(m.position.z)] : null,",
      "    board: b ? [b.x, b.y, b.z, b.w] : null,",
      "    /* CE QUI DÉCIDE VRAIMENT DE L'APPEL DE DESSIN. */",
      "    dansLesActifs: S._activeMeshes ? (S._activeMeshes.indexOf(m) >= 0) : null,",
      "    toujoursActif: m.alwaysSelectAsActiveMesh,",
      "    tronqueParLaVue: (typeof m.isInFrustum === 'function' && S.activeCamera)",
      "      ? !m.isInFrustum(S.activeCamera._frustumPlanes || []) : null",
      "  });",
      "});",
      "/* Et le compte général, pour voir si UN maillage disparaît de la scène. */",
      "var instances = 0;",
      "S.meshes.forEach(function (m) { if (m.sourceMesh) { instances++; } });",
      "return { siens: siens, maillages: S.meshes.length, instances: instances,",
      "  actifs: S._activeMeshes ? S._activeMeshes.length : null,",
      "  vueDuJeton: !!(t.view), id: t.id };"
    ].join("\n");

    /* On choisit un jeton de la couche des jetons, et on note où il était. */
    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: g[i].id, x: g[i].get('left'), y: g[i].get('top') };",
      "  }",
      "}",
      "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton : ..." + String(cible.id).slice(-6) + "  en (" + cible.x + ", " + cible.y + ")");

    function montre(titre, r) {
      console.log("\n  -- " + titre + " --");
      if (r.erreur) { console.log("    " + r.erreur); return; }
      console.log("    maillages " + r.maillages + "   instances " + r.instances +
        "   actifs " + r.actifs);
      (r.siens || []).forEach(function (m) {
        console.log("    " + m.nom);
        console.log("      instance " + m.instance + "  actif " + m.actif +
          "  visible " + m.visible + "  visibilité " + m.visibilite);
        console.log("      dans la scène " + m.dansLaScene + "  dans les actifs " + m.dansLesActifs +
          "  hors du tronc de vue " + m.tronqueParLaVue);
        console.log("      groupe " + m.groupe + "  position " + JSON.stringify(m.position) +
          "  u_Board " + JSON.stringify(m.board));
      });
      if (!(r.siens || []).length) { console.log("    AUCUN MAILLAGE NE PORTE SON IDENTIFIANT"); }
    }

    const dedans = await driver.executeScript(LIS, cible.i);
    montre("DEDANS, tel qu'il est", dedans);

    /* On l'envoie hors de la page, et on relit exactement la même chose. */
    await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "g[arguments[0]].save({ left: arguments[1], top: -260 });"
    ].join("\n"), cible.i, cible.x);
    await dors(3500);
    const dehors = await driver.executeScript(LIS, cible.i);
    montre("DEHORS, hors de la page", dehors);

    /* ---------- CE QUE ÇA DÉCIDE ---------- */
    console.log("\n  ──────────────────────────────────────────────");
    const a = (dedans.siens || [])[0], b = (dehors.siens || [])[0];
    if (!b) {
      console.log("  SON MAILLAGE A DISPARU DE LA SCÈNE.");
      console.log("  Aucun levier de nuanceur ne pouvait mordre : il n'y a plus rien à dessiner.");
      console.log("  La voie est de le REMETTRE, pas de changer la façon dont il est peint.");
    } else if (b.actif === false) {
      console.log("  SON MAILLAGE EST DÉSACTIVÉ (isEnabled = false).");
      console.log("  Le levier est setEnabled(true), pas le nuanceur.");
    } else if (b.dansLesActifs === false && a && a.dansLesActifs === true) {
      console.log("  IL SORT DE LA LISTE DES MAILLAGES ACTIFS.");
      console.log("  Le levier est alwaysSelectAsActiveMesh, pas le nuanceur.");
    } else if (b.visibilite === 0 || b.visible === false) {
      console.log("  IL EST RENDU INVISIBLE (visibility ou isVisible).");
    } else {
      console.log("  IL EST TOUJOURS LÀ, ACTIF ET SOUMIS AU DESSIN.");
      console.log("  C'est donc bien le nuanceur qui le jette — et le levier est ailleurs");
      console.log("  que dans u_Board tel qu'on l'a écrit.");
    }

    /* ON LE REMET. */
    await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "g[arguments[0]].save({ left: arguments[1], top: arguments[2] });"
    ].join("\n"), cible.i, cible.x, cible.y);
    console.log("  jeton remis en (" + cible.x + ", " + cible.y + ")");

    releve("dessine-" + quelle + ".json", { cible: cible, dedans: dedans, dehors: dehors });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUI PORTE VRAIMENT u_Board ? ----------
 *
 * « dessine » a montré que les trois maillages nommés d'après le jeton ont
 * u_Board à null et une position nulle : ce ne sont pas eux qu'on dessine.
 * Roll20 peint par INSTANCIATION — un maillage source partagé, une instance par
 * jeton — et les cinq leviers essayés écrivaient tous sur la SOURCE. Le relevé
 * de « preuve » le dit d'ailleurs en toutes lettres : il ne lisait que les
 * maillages dont le nom commence par « instance- », c'est-à-dire les sources.
 *
 * Or Babylon reconstruit le tableau téléversé à partir de `instancedBuffers` de
 * CHAQUE instance, à chaque image. Écrire sur la source ne pose que la valeur du
 * modèle, aussitôt recouverte. Le levier, s'il existe, est par instance.
 *
 * On relève donc l'arbre complet avant d'y toucher : qui porte le tampon, qui
 * sont ses instances, et ce que chacune vaut.
 */
async function porteeDuBoard() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  const crypto = require("crypto");
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    /* LE MÊME INSTRUMENT QUE « preuve » — la toile entière, son empreinte, aucun
     * cadrage. Les empreintes se comparent donc d'une épreuve à l'autre. */
    async function photo(nom) {
      const t = await driver.executeScript(
        "var n = document.getElementById('babylonCanvas');" +
        "if (!n) { return null; }" +
        "var q = n.getBoundingClientRect();" +
        "return { x: Math.round(q.left), y: Math.round(q.top)," +
        "  l: Math.round(q.width), h: Math.round(q.height) };");
      if (!t) { return null; }
      const p = await capturePres(driver, nom + ".png", t.x, t.y, t.l, t.h, 1);
      if (!p) { return null; }
      return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
    }

    /* Tout ce qui porte le tampon, source comme instances : on ne suppose pas la
     * mécanique employée, on la lit. */
    const ARBRE = [
      "var S = window.MeshScene; var out = [];",
      "function lis(m) { var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  return b ? [b.x, b.y, b.z, b.w] : null; }",
      "S.meshes.forEach(function (m) {",
      "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  var fines = m.thinInstanceCount || 0;",
      "  if (!b && !fines) { return; }",
      "  out.push({",
      "    nom: String(m.name || '').slice(0, 44),",
      "    source: !m.sourceMesh,",
      "    board: lis(m),",
      "    fines: fines,",
      "    aDesFines: !!m.hasThinInstances,",
      "    enfants: (m.instances || []).map(function (i) {",
      "      return { nom: String(i.name || '').slice(0, 44), board: lis(i),",
      "               actif: i.isEnabled(), visible: i.isVisible };",
      "    })",
      "  });",
      "});",
      "return out;"
    ].join("\n");

    function montreArbre(arbre) {
      arbre.forEach(function (m) {
        console.log("\n    " + m.nom + (m.source ? "   [source]" : "   [instance]"));
        console.log("      u_Board " + JSON.stringify(m.board) +
          "   instances fines " + m.fines + (m.aDesFines ? " (oui)" : ""));
        console.log("      instances : " + m.enfants.length);
        m.enfants.slice(0, 8).forEach(function (i) {
          console.log("        " + i.nom + "   u_Board " + JSON.stringify(i.board) +
            "   actif " + i.actif);
        });
        if (m.enfants.length > 8) { console.log("        … et " + (m.enfants.length - 8) + " autres"); }
      });
      if (!arbre.length) { console.log("    AUCUN maillage ne porte u_Board ni d'instances fines."); }
    }

    console.log("\n  -- QUI PORTE u_Board, LE JETON ÉTANT EN PLACE --");
    montreArbre(await driver.executeScript(ARBRE));

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: g[i].id, x: g[i].get('left'), y: g[i].get('top') };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("\n  aucun jeton sur la couche des jetons"); return 1; }

    /* ---------- ET LE MÊME ARBRE, LE JETON ÉTANT DEHORS ----------
     *
     * CETTE SONDE NE JUGE PLUS DU LEVIER, et c'est une correction.
     * Elle le posait puis comparait deux photos prises avec le jeton en
     * y = -260 — un point qui, au cadrage par défaut, tombe HORS DE L'ÉCRAN.
     * Les deux empreintes étaient donc identiques quoi qu'il arrive, et son
     * verdict « le levier ne mord pas » était sans valeur. Le levier mord :
     * mesuré par « mord », qui dézoome et compte des pixels.
     *
     * Ce qu'elle sait faire, et que rien d'autre ne fait, c'est LIRE l'arbre :
     * quelle source, quelles instances, quel tampon sur chacune. Elle s'en
     * tient à ça. */
    await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "g[arguments[0]].save({ left: arguments[1], top: -260 });"
    ].join("\n"), cible.i, cible.x);
    await dors(3500);

    console.log("\n  -- QUI PORTE u_Board, LE JETON ÉTANT DEHORS --");
    const arbreDehors = await driver.executeScript(ARBRE);
    montreArbre(arbreDehors);

    await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "g[arguments[0]].save({ left: arguments[1], top: arguments[2] });"
    ].join("\n"), cible.i, cible.x, cible.y);
    console.log("\n  jeton remis en (" + cible.x + ", " + cible.y + ")");
    console.log("  Pour savoir si le levier mord :   node outils/pilote.js mord");
    releve("portee-" + quelle + ".json", { cible: cible, arbreDehors: arbreDehors });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE POINT VISÉ EST-IL SEULEMENT À L'ÉCRAN ? ----------
 *
 * « horspage » a montré que le jeton posé en (x, -140) ne laisse aucun pixel,
 * chez le joueur COMME chez le MJ. C'est une mesure propre, avec son témoin.
 * Elle ne dit pourtant pas encore que Roll20 le cache : si la caméra cadre la
 * page et rien d'autre, le point visé est hors de l'écran, et un jeton hors de
 * l'écran ne se dessine nulle part — ce serait vrai de n'importe quel moteur.
 *
 * C'est la même faute que celle qu'on vient de réparer : conclure d'une
 * différence sans avoir établi qu'elle pouvait se voir.
 *
 * On projette donc le point visé par la caméra elle-même, et l'on refuse de
 * conclure tant qu'il n'est pas franchement DANS la toile.
 */
async function cadreHorsPage() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  const crypto = require("crypto");
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function photo(nom) {
      const t = await driver.executeScript(
        "var n = document.getElementById('babylonCanvas'); if (!n) { return null; }" +
        "var q = n.getBoundingClientRect();" +
        "return { x: Math.round(q.left), y: Math.round(q.top)," +
        "  l: Math.round(q.width), h: Math.round(q.height) };");
      if (!t) { return null; }
      const p = await capturePres(driver, nom + ".png", t.x, t.y, t.l, t.h, 1);
      if (!p) { return null; }
      return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
    }

    async function bouge(i, g, h) {
      await driver.executeScript(
        "var m = window.Campaign.activePage().thegraphics.models;" +
        "m[arguments[0]].save({ left: arguments[1], top: arguments[2] });", i, g, h);
      await dors(2800);
    }

    /* OÙ TOMBE UN POINT DE LA PAGE, À L'ÉCRAN ? On le demande à la caméra, par
     * la projection de Babylon : aucune loi devinée, aucun facteur recopié. Le
     * repère du monde a son y vers le haut là où la page l'a vers le bas — ce
     * que le nuanceur dit lui-même, en bornant vPositionW.y entre -hauteur et 0. */
    /* BABYLON N'EST PAS SUR window SOUS JUMPGATE — Roll20 l'empaquette. On
     * reprend donc les deux constructeurs sur des objets VIVANTS de la scène :
     * la position de la caméra est un Vector3, la matrice de transformation une
     * Matrix. Leurs statiques suivent. */
    const PROJETTE = [
      "var S = window.MeshScene;",
      "var c = S.activeCamera, e = S.getEngine();",
      "var V3 = c.position.constructor, M = S.getTransformMatrix().constructor;",
      "var v = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());",
      "var p = V3.Project(new V3(arguments[0], -arguments[1], 0),",
      "  M.Identity(), S.getTransformMatrix(), v);",
      "return { x: Math.round(p.x), y: Math.round(p.y),",
      "  l: e.getRenderWidth(), h: e.getRenderHeight() };"
    ].join("\n");

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var pg = window.Campaign.activePage();",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: String(g[i].id).slice(-6), x: g[i].get('left'), y: g[i].get('top'),",
      "             page: [pg.get('width') * 70, pg.get('height') * 70] };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton …" + cible.id + " en (" + cible.x + ", " + cible.y + ")" +
      "   page " + Math.round(cible.page[0]) + " x " + Math.round(cible.page[1]));

    /* ON DÉZOOME POUR DÉGAGER DE LA MARGE AUTOUR DE LA PAGE. Sans quoi le point
     * visé est dehors, et l'épreuve ne mesure que le cadrage. */
    /* Le magasin « engine » de Pinia, atteint comme le pont l'atteint : par la
     * racine Vue. Il n'y a pas d'autre porte sous Jumpgate — « setZoom » ne vit
     * ni sur window ni sur d20, et le premier essai s'y est cassé le nez. Son
     * unité est le POUR CENT. */
    const dez = await driver.executeScript([
      "function racines() {",
      "  var o = [];",
      "  document.querySelectorAll('*').forEach(function (n) { if (n.__vue_app__) { o.push(n); } });",
      "  return o;",
      "}",
      "var st = null;",
      "racines().forEach(function (n) {",
      "  try {",
      "    var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get && !st) { st = p._s.get('engine'); }",
      "  } catch (e) {}",
      "});",
      "if (!st) { return 'magasin introuvable'; }",
      "if (typeof st.setZoom !== 'function') { return 'setZoom absent (zoom=' + st.zoom + ')'; }",
      "var avant = st.zoom; st.setZoom(arguments[0]);",
      "return avant + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("  dézoom : " + dez);
    await dors(3000);

    const dedansEcran = await driver.executeScript(PROJETTE, cible.x, cible.y);
    console.log("  toile " + dedansEcran.l + " x " + dedansEcran.h +
      "   chez lui tombe en (" + dedansEcran.x + ", " + dedansEcran.y + ")");

    /* On cherche un point HORS PAGE qui soit franchement dans la toile : juste
     * au-dessus du bord haut, en descendant jusqu'à ce que ça tienne. */
    let haut = null, ou = null;
    for (const y of [-70, -140, -210, -280, -420]) {
      const p = await driver.executeScript(PROJETTE, cible.x, y);
      const dedans = p.x > 40 && p.x < p.l - 40 && p.y > 40 && p.y < p.h - 40;
      console.log("    y = " + y + "  →  écran (" + p.x + ", " + p.y + ")   " +
        (dedans ? "DANS la toile" : "hors de la toile"));
      if (dedans && haut === null) { haut = y; ou = p; }
    }
    if (haut === null) {
      console.log("\n  aucun point hors page ne tombe dans la toile à ce cadrage :");
      console.log("  l'épreuve ne peut RIEN conclure, et « horspage » non plus.");
      return 1;
    }
    console.log("\n  on éprouve en y = " + haut + ", qui tombe en (" + ou.x + ", " + ou.y + ")");

    const stab1 = await photo("cadre-stab-1");
    const stab2 = await photo("cadre-stab-2");
    if (stab1 !== stab2) { console.log("  la vue bouge seule : on s'arrête."); return 1; }

    const LOIN = 99999;
    await bouge(cible.i, LOIN, LOIN);
    const loin = await photo("cadre-loin");
    await bouge(cible.i, cible.x, cible.y);
    const chez = await photo("cadre-chez");
    await bouge(cible.i, cible.x, haut);
    const dehors = await photo("cadre-dehors");
    await bouge(cible.i, cible.x, cible.y);

    console.log("\n  au loin      " + loin);
    console.log("  chez lui     " + chez);
    console.log("  hors page    " + dehors);

    console.log("\n  ──────────────────────────────────────────────");
    if (chez === loin) {
      console.log("  TÉMOIN EN ÉCHEC : chez lui non plus il ne fait aucune différence.");
      return 1;
    }
    console.log("  témoin : chez lui, l'image diffère du loin.");
    const cache = (dehors === loin);
    console.log("  hors page, à un point DONT ON A VÉRIFIÉ qu'il est à l'écran :");
    console.log("  " + (cache ? "IL N'EST PAS DESSINÉ. Roll20 le cache bel et bien."
                              : "IL EST DESSINÉ. Il n'y a rien à réparer ici."));

    releve("cadre-" + quelle + ".json",
      { cible: cible, haut: haut, ou: ou, loin: loin, chez: chez, dehors: dehors, cache: cache });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- COMBIEN DE PIXELS, ET LESQUELS ? ----------
 *
 * « cadre2 » a établi qu'une fois le point visé VRAIMENT à l'écran, le jeton
 * hors page laisse une trace : l'empreinte diffère de celle du loin. Une
 * empreinte ne dit pourtant que « ça diffère ». Elle ne dit pas quoi.
 *
 * Et il y a de quoi se tromper : un jeton n'est pas UN maillage mais trois —
 * l'image, le contour, les barres. Le nuanceur peut parfaitement jeter l'image
 * et laisser le reste, auquel cas la trace existe, l'empreinte change, et le
 * joueur ne voit toujours pas son jeton. C'est même exactement ce dont on se
 * plaint.
 *
 * On compte donc. La même vue, le jeton au loin puis à la place éprouvée, et la
 * différence pixel à pixel — combien, et dans quel rectangle. Chez lui sert
 * d'étalon : c'est ce que « tout le jeton » vaut, en pixels, à ce cadrage.
 */
async function combienDePixels() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function bouge(i, g, h) {
      await driver.executeScript(
        "var m = window.Campaign.activePage().thegraphics.models;" +
        "m[arguments[0]].save({ left: arguments[1], top: arguments[2] });", i, g, h);
      await dors(2800);
    }

    /* La différence se calcule DANS LA PAGE : deux captures redessinées dans un
     * canevas détaché, puis lues. Node n'a pas de quoi ouvrir un PNG, et lui en
     * ajouter un serait une dépendance de plus pour une soustraction. */
    async function differe(aB64, bB64) {
      return await driver.executeAsyncScript([
        "var cb = arguments[arguments.length - 1];",
        "var A = new Image(), B = new Image(), n = 0;",
        "function pret() {",
        "  if (++n < 2) { return; }",
        "  var c = document.createElement('canvas');",
        "  c.width = A.width; c.height = A.height;",
        "  var g = c.getContext('2d', { willReadFrequently: true });",
        "  g.drawImage(A, 0, 0); var a = g.getImageData(0, 0, c.width, c.height).data;",
        "  g.clearRect(0, 0, c.width, c.height);",
        "  g.drawImage(B, 0, 0); var b = g.getImageData(0, 0, c.width, c.height).data;",
        "  var cnt = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;",
        "  for (var i = 0; i < a.length; i += 4) {",
        "    if (Math.abs(a[i] - b[i]) < 8 && Math.abs(a[i+1] - b[i+1]) < 8 &&",
        "        Math.abs(a[i+2] - b[i+2]) < 8) { continue; }",
        "    var p = i / 4, x = p % c.width, y = (p - x) / c.width;",
        "    cnt++;",
        "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }",
        "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }",
        "  }",
        "  cb({ pixels: cnt, boite: cnt ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null });",
        "}",
        "A.onload = pret; B.onload = pret;",
        "A.onerror = function () { cb({ erreur: 'A' }); };",
        "B.onerror = function () { cb({ erreur: 'B' }); };",
        "A.src = 'data:image/png;base64,' + arguments[0];",
        "B.src = 'data:image/png;base64,' + arguments[1];"
      ].join("\n"), aB64, bB64);
    }

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var pg = window.Campaign.activePage();",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: String(g[i].id).slice(-6), x: g[i].get('left'), y: g[i].get('top'),",
      "             l: g[i].get('width'), h: g[i].get('height'),",
      "             page: [pg.get('width') * 70, pg.get('height') * 70] };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton …" + cible.id + " en (" + cible.x + ", " + cible.y + ")  " +
      cible.l + " x " + cible.h + " px   page " + Math.round(cible.page[0]) +
      " x " + Math.round(cible.page[1]));

    const dez = await driver.executeScript([
      "var st = null;",
      "document.querySelectorAll('*').forEach(function (n) {",
      "  if (st || !n.__vue_app__) { return; }",
      "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
      "});",
      "if (!st || typeof st.setZoom !== 'function') { return 'magasin absent'; }",
      "var a = st.zoom; st.setZoom(arguments[0]); return a + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("  dézoom : " + dez);
    await dors(3000);

    const LOIN = 99999;
    await bouge(cible.i, LOIN, LOIN);
    const loin = await driver.takeScreenshot();

    /* L'ÉTALON : tout le jeton, chez lui, à ce cadrage. */
    await bouge(cible.i, cible.x, cible.y);
    const etalon = await differe(loin, await driver.takeScreenshot());
    console.log("\n  chez lui (" + cible.x + ", " + cible.y + ")   " +
      etalon.pixels + " pixels   boîte " + JSON.stringify(etalon.boite));
    if (!etalon.pixels) { console.log("  l'instrument ne voit pas le jeton chez lui : rien à conclure."); return 1; }

    /* ET MAINTENANT, HORS PAGE, DE PLUS EN PLUS LOIN DU BORD. */
    const mesures = [];
    for (const y of [-70, -140, -280, -420]) {
      await bouge(cible.i, cible.x, y);
      const d = await differe(loin, await driver.takeScreenshot());
      const part = Math.round((d.pixels / etalon.pixels) * 100);
      mesures.push({ y: y, pixels: d.pixels, boite: d.boite, part: part });
      console.log("  hors page y = " + String(y).padStart(5) + "   " +
        String(d.pixels).padStart(6) + " pixels   " + String(part).padStart(3) + " % de l'étalon" +
        "   boîte " + JSON.stringify(d.boite));
    }
    await bouge(cible.i, cible.x, cible.y);

    console.log("\n  ──────────────────────────────────────────────");
    const loinDuBord = mesures[mesures.length - 1];
    if (!loinDuBord.pixels) {
      console.log("  Loin du bord, plus rien du tout : le jeton est bel et bien caché.");
    } else if (loinDuBord.part >= 60) {
      console.log("  Le jeton est dessiné hors page, à " + loinDuBord.part + " % de ce qu'il vaut");
      console.log("  chez lui. Il n'est PAS caché — pas dans cette partie, pas à ce rôle.");
    } else {
      console.log("  Il ne reste que " + loinDuBord.part + " % : ce n'est pas le jeton qui survit,");
      console.log("  ce sont ses accessoires — contour, barres, étiquette. L'image, elle,");
      console.log("  est bien jetée, et c'est exactement le défaut dont on se plaint.");
    }

    releve("combien-" + quelle + ".json", { cible: cible, etalon: etalon, mesures: mesures });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE LEVIER MORD-IL, UNE FOIS L'ÉPREUVE CADRÉE ? ----------
 *
 * Ce qu'on sait, mesuré, et cette fois avec un témoin :
 *
 *   MJ,     hors page : 105 à 109 % des pixels qu'il vaut chez lui — entier.
 *   Joueur, hors page :  11 % — un fragment de 6 x 7, et rien d'autre.
 *   MJ     : u_Board = [l, h, 1, 0]      joueur : u_Board = [l, h, 0, 1]
 *   Nuanceur : if (offBoard && v_Board.z == 0.) { discard; }
 *
 * L'écart tient au rôle, et il tient à z. La voie 2 visait juste.
 *
 * Ce qui ne valait rien, c'est le verdict porté sur elle. « portee » posait
 * z = 1 puis photographiait le jeton en y = -260 — hors de l'écran à ce cadrage,
 * comme « cadre2 » l'a montré depuis. Ses deux empreintes identiques ne
 * disaient rien du levier : elles disaient que rien n'était visible, avant
 * comme après.
 *
 * On refait donc l'épreuve, cadrée, et on compte les pixels au lieu de comparer
 * des empreintes. Le levier mord si le joueur passe de 11 % à l'étalon.
 */
async function leLevierMord() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function bouge(i, g, h) {
      await driver.executeScript(
        "var m = window.Campaign.activePage().thegraphics.models;" +
        "m[arguments[0]].save({ left: arguments[1], top: arguments[2] });", i, g, h);
      await dors(2800);
    }

    async function differe(aB64, bB64) {
      return await driver.executeAsyncScript([
        "var cb = arguments[arguments.length - 1];",
        "var A = new Image(), B = new Image(), n = 0;",
        "function pret() {",
        "  if (++n < 2) { return; }",
        "  var c = document.createElement('canvas');",
        "  c.width = A.width; c.height = A.height;",
        "  var g = c.getContext('2d', { willReadFrequently: true });",
        "  g.drawImage(A, 0, 0); var a = g.getImageData(0, 0, c.width, c.height).data;",
        "  g.clearRect(0, 0, c.width, c.height);",
        "  g.drawImage(B, 0, 0); var b = g.getImageData(0, 0, c.width, c.height).data;",
        "  var cnt = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;",
        "  for (var i = 0; i < a.length; i += 4) {",
        "    if (Math.abs(a[i] - b[i]) < 8 && Math.abs(a[i+1] - b[i+1]) < 8 &&",
        "        Math.abs(a[i+2] - b[i+2]) < 8) { continue; }",
        "    var p = i / 4, x = p % c.width, y = (p - x) / c.width;",
        "    cnt++;",
        "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }",
        "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }",
        "  }",
        "  cb({ pixels: cnt, boite: cnt ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null });",
        "}",
        "A.onload = pret; B.onload = pret;",
        "A.onerror = function () { cb({ erreur: 'A' }); };",
        "B.onerror = function () { cb({ erreur: 'B' }); };",
        "A.src = 'data:image/png;base64,' + arguments[0];",
        "B.src = 'data:image/png;base64,' + arguments[1];"
      ].join("\n"), aB64, bB64);
    }

    /* Poser z, et RELIRE. La relecture est le point : elle sépare « le levier ne
     * marche pas » de « l'écriture n'a pas tenu », et ces deux-là appellent des
     * suites opposées. */
    async function poseZ(z) {
      return await driver.executeScript([
        /* On retient la valeur AVANT le parcours : dans un rappel, `arguments`
         * est celui du rappel, pas celui du script. */
        "var Z = arguments[0];",
        "var S = window.MeshScene, n = 0, e = 0;",
        "S.meshes.forEach(function (m) {",
        "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
        "  if (b) { b.z = Z; n++; }",
        "  (m.instances || []).forEach(function (i) {",
        "    var c = i.instancedBuffers && i.instancedBuffers.u_Board;",
        "    if (c) { c.z = Z; e++; }",
        "  });",
        "});",
        "return { sources: n, instances: e };"
      ].join("\n"), z);
    }
    async function relis() {
      return await driver.executeScript([
        "var S = window.MeshScene, out = [];",
        "S.meshes.forEach(function (m) {",
        "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
        "  if (b) { out.push([b.x, b.y, b.z, b.w]); }",
        "  (m.instances || []).forEach(function (i) {",
        "    var c = i.instancedBuffers && i.instancedBuffers.u_Board;",
        "    if (c) { out.push([c.x, c.y, c.z, c.w]); }",
        "  });",
        "});",
        "return out.slice(0, 6);"
      ].join("\n"));
    }

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: String(g[i].id).slice(-6), x: g[i].get('left'), y: g[i].get('top') };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton …" + cible.id + " en (" + cible.x + ", " + cible.y + ")");

    const dez = await driver.executeScript([
      "var st = null;",
      "document.querySelectorAll('*').forEach(function (n) {",
      "  if (st || !n.__vue_app__) { return; }",
      "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
      "});",
      "if (!st || typeof st.setZoom !== 'function') { return 'magasin absent'; }",
      "var a = st.zoom; st.setZoom(arguments[0]); return a + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("  dézoom : " + dez);
    await dors(3000);
    console.log("  u_Board au départ : " + JSON.stringify(await relis()));

    const LOIN = 99999, HAUT = -280;
    await bouge(cible.i, LOIN, LOIN);
    const loin = await driver.takeScreenshot();

    await bouge(cible.i, cible.x, cible.y);
    const etalon = await differe(loin, await driver.takeScreenshot());
    console.log("\n  étalon — chez lui        " + String(etalon.pixels).padStart(6) +
      " pixels   boîte " + JSON.stringify(etalon.boite));
    if (!etalon.pixels) { console.log("  l'instrument est aveugle : rien à conclure."); return 1; }

    await bouge(cible.i, cible.x, HAUT);
    const avant = await differe(loin, await driver.takeScreenshot());
    console.log("  hors page, sans levier   " + String(avant.pixels).padStart(6) +
      " pixels   " + Math.round(avant.pixels / etalon.pixels * 100) + " %   boîte " +
      JSON.stringify(avant.boite));

    const pose = await poseZ(1);
    await dors(2500);
    const apres = await differe(loin, await driver.takeScreenshot());
    const relu = await relis();
    console.log("  hors page, AVEC levier   " + String(apres.pixels).padStart(6) +
      " pixels   " + Math.round(apres.pixels / etalon.pixels * 100) + " %   boîte " +
      JSON.stringify(apres.boite));
    console.log("  écrit sur " + pose.sources + " source(s) et " + pose.instances + " instance(s)");
    console.log("  u_Board relu : " + JSON.stringify(relu));

    console.log("\n  ──────────────────────────────────────────────");
    const tenu = relu.length && relu.every(function (v) { return v[2] === 1; });
    const part = Math.round(apres.pixels / etalon.pixels * 100);
    if (!tenu) {
      console.log("  L'ÉCRITURE N'A PAS TENU : z est retombé. Roll20 réécrit le tampon,");
      console.log("  et le levier doit se poser à chaque image, pas une fois.");
    } else if (part >= 60) {
      console.log("  LE LEVIER MORD. z = 1 par instance, et le joueur voit son jeton");
      console.log("  hors page à " + part + " % de ce qu'il vaut chez lui.");
    } else {
      console.log("  z tient à 1, et pourtant il n'y a que " + part + " % de pixels.");
      console.log("  Le tampon n'est donc pas seul à décider : autre chose jette l'image.");
    }

    await poseZ(quelle === "mj" ? 1 : 0);
    await bouge(cible.i, cible.x, cible.y);
    console.log("  jeton remis en (" + cible.x + ", " + cible.y + "), z remis");
    releve("mord-" + quelle + ".json",
      { cible: cible, etalon: etalon, avant: avant, apres: apres, pose: pose, relu: relu });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE LEVIER MONTRE-T-IL AUTRE CHOSE QUE LE BORD DE PAGE ? ----------
 *
 * Poser z = 1 dans u_Board, c'est lever le drapeau que Roll20 réserve au MJ :
 *
 *     u_Board = new Vector4(largeur, hauteur, gmMode ? 1 : 0, ...)
 *
 * Le nuanceur ne s'en sert, à notre connaissance, que pour une chose — ne pas
 * jeter ce qui déborde de la page. « À notre connaissance » ne suffit pas quand
 * la question est : est-ce qu'un joueur va voir ce que le MJ lui cache ?
 *
 * Deux mesures répondent, et aucune ne demande de croire à une lecture de code.
 *
 *   1. Le client d'un joueur REÇOIT-IL seulement les objets de la couche du MJ ?
 *      Si le serveur ne les envoie pas, il n'y a rien à révéler, quoi qu'on
 *      fasse au nuanceur.
 *
 *   2. Le levier posé, l'écran change-t-il AILLEURS que hors page ? On compare
 *      la même vue, jeton chez lui, avec et sans. Zéro pixel de différence est
 *      la seule réponse acceptable.
 */
async function sureteDuLevier() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function differe(aB64, bB64) {
      return await driver.executeAsyncScript([
        "var cb = arguments[arguments.length - 1];",
        "var A = new Image(), B = new Image(), n = 0;",
        "function pret() {",
        "  if (++n < 2) { return; }",
        "  var c = document.createElement('canvas');",
        "  c.width = A.width; c.height = A.height;",
        "  var g = c.getContext('2d', { willReadFrequently: true });",
        "  g.drawImage(A, 0, 0); var a = g.getImageData(0, 0, c.width, c.height).data;",
        "  g.clearRect(0, 0, c.width, c.height);",
        "  g.drawImage(B, 0, 0); var b = g.getImageData(0, 0, c.width, c.height).data;",
        "  var cnt = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;",
        "  for (var i = 0; i < a.length; i += 4) {",
        "    if (Math.abs(a[i] - b[i]) < 8 && Math.abs(a[i+1] - b[i+1]) < 8 &&",
        "        Math.abs(a[i+2] - b[i+2]) < 8) { continue; }",
        "    var p = i / 4, x = p % c.width, y = (p - x) / c.width;",
        "    cnt++;",
        "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }",
        "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }",
        "  }",
        "  cb({ pixels: cnt, boite: cnt ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null });",
        "}",
        "A.onload = pret; B.onload = pret;",
        "A.onerror = function () { cb({ erreur: 'A' }); };",
        "B.onerror = function () { cb({ erreur: 'B' }); };",
        "A.src = 'data:image/png;base64,' + arguments[0];",
        "B.src = 'data:image/png;base64,' + arguments[1];"
      ].join("\n"), aB64, bB64);
    }

    async function poseZ(z) {
      return await driver.executeScript([
        "var Z = arguments[0], S = window.MeshScene, n = 0;",
        "S.meshes.forEach(function (m) {",
        "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
        "  if (b) { b.z = Z; n++; }",
        "  (m.instances || []).forEach(function (i) {",
        "    var c = i.instancedBuffers && i.instancedBuffers.u_Board;",
        "    if (c) { c.z = Z; n++; }",
        "  });",
        "});",
        "return n;"
      ].join("\n"), z);
    }

    /* ---------- 1. LE CLIENT REÇOIT-IL LA COUCHE DU MJ ? ---------- */
    const couches = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "var par = {};",
      "g.forEach(function (t) {",
      "  var c = String(t.get('layer'));",
      "  par[c] = (par[c] || 0) + 1;",
      "});",
      "var p = window.Campaign.activePage();",
      "return { couches: par, total: g.length,",
      "  chemins: p.thepaths ? p.thepaths.length : null,",
      "  textes: p.thetexts ? p.thetexts.length : null };"
    ].join("\n"));
    console.log("\n  -- 1. CE QUE CE CLIENT A REÇU --");
    console.log("    " + JSON.stringify(couches.couches) + "   (" + couches.total + " objets)");
    console.log("    chemins " + couches.chemins + "   textes " + couches.textes);
    const cachees = Object.keys(couches.couches).filter(function (c) {
      return c === "gmlayer" || c === "walls";
    });
    if (cachees.length) {
      console.log("    ATTENTION : ce client détient " +
        cachees.map(function (c) { return couches.couches[c] + " sur « " + c + " »"; }).join(", ") + ".");
    } else {
      console.log("    aucune couche réservée au MJ dans ce client.");
    }

    /* ---------- 2. LE LEVIER CHANGE-T-IL L'ÉCRAN AILLEURS ? ---------- */
    const dez = await driver.executeScript([
      "var st = null;",
      "document.querySelectorAll('*').forEach(function (n) {",
      "  if (st || !n.__vue_app__) { return; }",
      "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
      "});",
      "if (!st || typeof st.setZoom !== 'function') { return 'magasin absent'; }",
      "var a = st.zoom; st.setZoom(arguments[0]); return a + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("\n  -- 2. LE LEVIER CHANGE-T-IL L'ÉCRAN AILLEURS ? --");
    console.log("    dézoom : " + dez + "   (toute la page à l'écran)");
    await dors(3000);

    /* Le témoin de l'instrument : deux photos de suite, sans rien toucher. Si
     * elles diffèrent déjà, la mesure d'après ne veut rien dire. */
    const t1 = await driver.takeScreenshot();
    await dors(2000);
    const t2 = await driver.takeScreenshot();
    const bruit = await differe(t1, t2);
    console.log("    bruit de fond : " + bruit.pixels + " pixels");
    if (bruit.pixels > 20) {
      console.log("    la vue ne tient pas en place : on ne conclut pas.");
      return 1;
    }

    const n = await poseZ(1);
    await dors(2500);
    const apres = await differe(t2, await driver.takeScreenshot());
    console.log("    levier posé sur " + n + " tampon(s)");
    console.log("    différence à l'écran : " + apres.pixels + " pixels   boîte " +
      JSON.stringify(apres.boite));

    await poseZ(quelle === "mj" ? 1 : 0);
    await dors(1500);

    console.log("\n  ──────────────────────────────────────────────");
    const propre = apres.pixels <= Math.max(20, bruit.pixels);
    if (cachees.length) {
      console.log("  Ce client DÉTIENT des objets de couche réservée : le levier doit être");
      console.log("  éprouvé sur eux avant d'être livré.");
    } else if (propre) {
      console.log("  Le levier ne change RIEN à l'écran tant que rien ne déborde de la page");
      console.log("  (" + apres.pixels + " pixels, pour " + bruit.pixels + " de bruit de fond), et ce client");
      console.log("  n'a reçu aucun objet de couche réservée. Il ne révèle donc que le bord.");
    } else {
      console.log("  Le levier change " + apres.pixels + " pixels alors que rien ne déborde.");
      console.log("  Il touche donc à autre chose, et il faut savoir quoi avant de livrer.");
    }

    releve("surete-" + quelle + ".json",
      { couches: couches, bruit: bruit, apres: apres, tampons: n, cachees: cachees });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- À QUOI SERT z, DANS LE NUANCEUR COMPILÉ ? ----------
 *
 * On s'apprête à forcer z = 1 chez un joueur. z est le drapeau « MJ » que
 * Roll20 pose dans u_Board. Tant qu'on ne sait pas TOUT ce que le nuanceur en
 * fait, on ne sait pas ce que le module révèle.
 *
 * Deux mesures l'ont déjà cerné par l'extérieur — zéro pixel de changement tant
 * que rien ne déborde, et aucun objet de couche réservée dans le client. Ni
 * l'une ni l'autre ne vaut une lecture : la première ne prouve rien pour une
 * page qui aurait de tels objets, la seconde ne prouve rien pour une table où le
 * MJ en pose.
 *
 * La source du programme compilé, elle, est le texte que la carte exécute. On la
 * demande à Babylon, et on regarde chaque ligne qui parle de Board.
 */
async function litLeNuanceur() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    const src = await driver.executeScript([
      "var S = window.MeshScene, vus = {}, out = [];",
      "S.meshes.forEach(function (m) {",
      "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (!b || !m.material) { return; }",
      "  var e = null;",
      "  try { e = m.material.getEffect ? m.material.getEffect() : null; } catch (err) {}",
      "  if (!e) { return; }",
      "  var cle = String(e.name && e.name.fragment ? e.name.fragment : e.name || m.material.name);",
      "  if (vus[cle]) { return; }",
      "  vus[cle] = 1;",
      "  out.push({ cle: cle,",
      "    sommet: String(e.vertexSourceCode || e._vertexSourceCode || ''),",
      "    fragment: String(e.fragmentSourceCode || e._fragmentSourceCode || '') });",
      "});",
      "return out;"
    ].join("\n"));

    if (!src.length) { console.log("  aucun programme lisible sur les maillages qui portent u_Board."); return 1; }

    let total = 0;
    src.forEach(function (p) {
      console.log("\n  ══ " + p.cle + " ══");
      ["sommet", "fragment"].forEach(function (quoi) {
        const t = p[quoi] || "";
        if (!t) { console.log("    [" + quoi + "] source absente"); return; }
        const lignes = t.split(/\r?\n/);
        const gardees = [];
        lignes.forEach(function (l, i) {
          if (!/Board/.test(l)) { return; }
          gardees.push(String(i + 1).padStart(5) + " │ " + l.trim());
        });
        console.log("    [" + quoi + "] " + lignes.length + " lignes, " +
          gardees.length + " parlent de Board");
        gardees.forEach(function (l) { console.log("      " + l); });
        total += gardees.length;
        /* Et le contexte de chaque emploi de .z, qui est la question. */
        lignes.forEach(function (l, i) {
          if (!/Board\s*\.\s*z|Board\[2\]/.test(l)) { return; }
          console.log("      ── emploi de z, ligne " + (i + 1) + " ──");
          for (let k = Math.max(0, i - 3); k <= Math.min(lignes.length - 1, i + 3); k++) {
            console.log("         " + (k === i ? ">" : " ") + " " + lignes[k].trim());
          }
        });
      });
    });

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  " + src.length + " programme(s), " + total + " ligne(s) citant Board.");
    releve("nuanceur-" + quelle + ".json", src);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE MODULE « JETONS HORS CARTE », ÉPROUVÉ POUR DE BON ----------
 *
 * Pas de levier posé à la main : l'extension est chargée, le module s'allume
 * tout seul, et l'on regarde ce qu'un joueur voit. C'est la seule mesure qui
 * porte sur ce qui sera livré.
 *
 * ELLE COMPTE DES PIXELS, ET ELLE CADRE. Les deux fautes qui ont fait tourner
 * cette enquête en rond sont là : comparer des empreintes quand le jeton a
 * bougé (ça change toujours), et viser un point hors de l'écran (ça ne montre
 * jamais rien). On dézoome donc pour dégager la marge, on vérifie par la caméra
 * que le point visé y tombe, et on compare au jeton envoyé à l'infini.
 *
 * ET ELLE ÉPROUVE L'EXTINCTION. Un module qui allume sans éteindre laisse la
 * partie de travers, et c'est plus grave que de ne pas s'allumer.
 */
async function epreuveHorsPage() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function differe(aB64, bB64) {
      return await driver.executeAsyncScript([
        "var cb = arguments[arguments.length - 1];",
        "var A = new Image(), B = new Image(), n = 0;",
        "function pret() {",
        "  if (++n < 2) { return; }",
        "  var c = document.createElement('canvas');",
        "  c.width = A.width; c.height = A.height;",
        "  var g = c.getContext('2d', { willReadFrequently: true });",
        "  g.drawImage(A, 0, 0); var a = g.getImageData(0, 0, c.width, c.height).data;",
        "  g.clearRect(0, 0, c.width, c.height);",
        "  g.drawImage(B, 0, 0); var b = g.getImageData(0, 0, c.width, c.height).data;",
        "  var cnt = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;",
        "  for (var i = 0; i < a.length; i += 4) {",
        "    if (Math.abs(a[i] - b[i]) < 8 && Math.abs(a[i+1] - b[i+1]) < 8 &&",
        "        Math.abs(a[i+2] - b[i+2]) < 8) { continue; }",
        "    var p = i / 4, x = p % c.width, y = (p - x) / c.width;",
        "    cnt++;",
        "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }",
        "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }",
        "  }",
        "  cb({ pixels: cnt, boite: cnt ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null });",
        "}",
        "A.onload = pret; B.onload = pret;",
        "A.onerror = function () { cb({ erreur: 'A' }); };",
        "B.onerror = function () { cb({ erreur: 'B' }); };",
        "A.src = 'data:image/png;base64,' + arguments[0];",
        "B.src = 'data:image/png;base64,' + arguments[1];"
      ].join("\n"), aB64, bB64);
    }
    async function bouge(i, g, h) {
      await driver.executeScript(
        "var m = window.Campaign.activePage().thegraphics.models;" +
        "m[arguments[0]].save({ left: arguments[1], top: arguments[2] });", i, g, h);
      await dors(2800);
    }
    async function wLus() {
      return await driver.executeScript([
        "var S = window.MeshScene, out = [];",
        "S.meshes.forEach(function (m) {",
        "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
        "  if (b) { out.push(b.w); }",
        "  (m.instances || []).forEach(function (i) {",
        "    var c = i.instancedBuffers && i.instancedBuffers.u_Board;",
        "    if (c) { out.push(c.w); }",
        "  });",
        "});",
        "return out;"
      ].join("\n"));
    }
    /* On éteint par le MÊME message que le socle envoie — même en-tête, même
     * cible nommée. Le pont refuse tout le reste depuis qu'il valide l'origine :
     * un message forgé « à peu près » ne serait pas lu, et l'épreuve conclurait
     * « ça ne s'éteint pas » alors qu'on aurait mal frappé à la porte. */
    async function interrupteur(actif) {
      await driver.executeScript(
        "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
        " type: 'horspage', actif: arguments[0] }, location.origin);", actif);
      await dors(2500);
    }

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: String(g[i].id).slice(-6), x: g[i].get('left'), y: g[i].get('top') };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton …" + cible.id + " en (" + cible.x + ", " + cible.y + ")");

    const dez = await driver.executeScript([
      "var st = null;",
      "document.querySelectorAll('*').forEach(function (n) {",
      "  if (st || !n.__vue_app__) { return; }",
      "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
      "});",
      "if (!st || typeof st.setZoom !== 'function') { return 'magasin absent'; }",
      "var a = st.zoom; st.setZoom(arguments[0]); return a + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("  dézoom : " + dez);
    await dors(3000);

    const z0 = await wLus();
    console.log("  w lus, module allumé : " + JSON.stringify(z0));

    const LOIN = 99999, HAUT = -280;
    await bouge(cible.i, LOIN, LOIN);
    const loin = await driver.takeScreenshot();
    await bouge(cible.i, cible.x, cible.y);
    const etalon = await differe(loin, await driver.takeScreenshot());
    console.log("\n  étalon — chez lui           " + String(etalon.pixels).padStart(6) +
      " pixels   boîte " + JSON.stringify(etalon.boite));
    if (!etalon.pixels) { console.log("  instrument aveugle : rien à conclure."); return 1; }

    await bouge(cible.i, cible.x, HAUT);
    const allume = await differe(loin, await driver.takeScreenshot());
    const partA = Math.round(allume.pixels / etalon.pixels * 100);
    console.log("  hors page, module ALLUMÉ    " + String(allume.pixels).padStart(6) +
      " pixels   " + partA + " %   boîte " + JSON.stringify(allume.boite));

    /* ---------- ET L'EXTINCTION ---------- */
    await interrupteur(false);
    const z1 = await wLus();
    const eteint = await differe(loin, await driver.takeScreenshot());
    const partE = Math.round(eteint.pixels / etalon.pixels * 100);
    console.log("  hors page, module ÉTEINT    " + String(eteint.pixels).padStart(6) +
      " pixels   " + partE + " %   boîte " + JSON.stringify(eteint.boite));
    console.log("  w lus, module éteint : " + JSON.stringify(z1));

    /* ---------- ET LE RALLUMAGE ---------- */
    await interrupteur(true);
    const rallume = await differe(loin, await driver.takeScreenshot());
    const partR = Math.round(rallume.pixels / etalon.pixels * 100);
    console.log("  hors page, RALLUMÉ          " + String(rallume.pixels).padStart(6) +
      " pixels   " + partR + " %");

    await bouge(cible.i, cible.x, cible.y);

    console.log("\n  ──────────────────────────────────────────────");
    const mj = quelle === "mj";
    const bon = partA >= 60 && (mj ? partE >= 60 : partE <= 25) && partR >= 60;
    console.log("  allumé, le jeton hors page vaut " + partA + " % de ce qu'il vaut chez lui");
    console.log("  éteint, " + partE + " %" + (mj
      ? "   (le MJ le voit de toute façon : Roll20 lui donne déjà le drapeau)"
      : "   (rendu à Roll20 : le joueur ne le voit plus)"));
    console.log("  rallumé, " + partR + " %");
    console.log("  " + (bon ? "LE MODULE FAIT CE QU'IL DIT, ET IL SE REND."
                            : "CE N'EST PAS CE QU'ON ATTENDAIT."));

    releve("epreuve-horspage-" + quelle + ".json",
      { cible: cible, etalon: etalon, allume: allume, eteint: eteint, rallume: rallume,
        z0: z0, z1: z1, bon: bon });
    return bon ? 0 : 1;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE VOILE : COMBIEN D'OPACITÉ, AU JUSTE ? ----------
 *
 * Signalé : hors page, les jetons sont transparents, « comme si quelque chose
 * était par-dessus ». Ce n'est pas quelque chose par-dessus, c'est la dernière
 * ligne du nuanceur :
 *
 *     if (offBoard && v_GridAlign != 1.0) { glFragColor.a *= 0.5; }
 *
 * Deux façons d'échapper au rejet, et elles ne rendent pas la même image :
 *
 *     z = 1  → le rejet est sauté, offBoard reste VRAI, l'alpha est divisé par
 *              deux. C'est ce qui a été livré.
 *     w = 0  → le bloc entier est sauté, offBoard reste FAUX : pleine opacité.
 *              C'est ce que Roll20 donne au MJ.
 *
 * COMPTER DES PIXELS NE SUFFIT PAS ICI. Un jeton à demi-opacité couvre exactement
 * la même surface qu'un jeton opaque : la sonde « combien » aurait dit 106 % dans
 * les deux cas, et elle l'a dit. Ce qui distingue les deux, c'est l'AMPLEUR de
 * l'écart au fond, pixel par pixel : à l'opacité a, la couleur vaut
 * a·jeton + (1-a)·fond, donc l'écart moyen au fond est proportionnel à a.
 *
 * On mesure donc cet écart moyen, dans les trois états, sur la MÊME boîte.
 * Le rapport w0 / z1 doit valoir deux.
 */
async function leVoile() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    /* L'ÉCART MOYEN, ET PAS SEULEMENT LE NOMBRE DE PIXELS QUI DIFFÈRENT. C'est
     * toute la mesure : deux images peuvent différer sur la même surface avec
     * une amplitude du simple au double. */
    async function ecart(aB64, bB64) {
      return await driver.executeAsyncScript([
        "var cb = arguments[arguments.length - 1];",
        "var A = new Image(), B = new Image(), n = 0;",
        "function pret() {",
        "  if (++n < 2) { return; }",
        "  var c = document.createElement('canvas');",
        "  c.width = A.width; c.height = A.height;",
        "  var g = c.getContext('2d', { willReadFrequently: true });",
        "  g.drawImage(A, 0, 0); var a = g.getImageData(0, 0, c.width, c.height).data;",
        "  g.clearRect(0, 0, c.width, c.height);",
        "  g.drawImage(B, 0, 0); var b = g.getImageData(0, 0, c.width, c.height).data;",
        /* LE TOTAL, ET PAS LA MOYENNE.
         *
         * À l'opacité a, chaque pixel du jeton vaut a·jeton + (1-a)·fond : son
         * écart au fond est proportionnel à a, et la SOMME des écarts l'est
         * aussi. La MOYENNE, elle, ne l'est pas — elle se calcule sur les seuls
         * pixels retenus, et à demi-opacité les pixels de bord passent sous le
         * seuil et sortent du calcul, ce qui remonte la moyenne des survivants.
         * Mesuré : moyenne 292 contre 409, soit 1,40 ; totaux 102 200 contre
         * 196 320, soit 1,92. C'est le second chiffre qui dit l'alpha.
         *
         * Le seuil descend donc à 8, juste de quoi écarter le bruit de
         * compression, et l'on garde les deux : la somme pour l'opacité, la
         * moyenne pour la lecture. */
        "  var cnt = 0, somme = 0, pic = 0;",
        "  var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;",
        "  for (var i = 0; i < a.length; i += 4) {",
        "    var d = Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1]) + Math.abs(a[i+2] - b[i+2]);",
        "    if (d < 8) { continue; }",
        "    var p = i / 4, x = p % c.width, y = (p - x) / c.width;",
        "    cnt++; somme += d; if (d > pic) { pic = d; }",
        "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }",
        "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }",
        "  }",
        "  cb({ pixels: cnt, total: somme, moyen: cnt ? Math.round(somme / cnt) : 0, pic: pic,",
        "       boite: cnt ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null });",
        "}",
        "A.onload = pret; B.onload = pret;",
        "A.onerror = function () { cb({ erreur: 'A' }); };",
        "B.onerror = function () { cb({ erreur: 'B' }); };",
        "A.src = 'data:image/png;base64,' + arguments[0];",
        "B.src = 'data:image/png;base64,' + arguments[1];"
      ].join("\n"), aB64, bB64);
    }
    async function bouge(i, g, h) {
      await driver.executeScript(
        "var m = window.Campaign.activePage().thegraphics.models;" +
        "m[arguments[0]].save({ left: arguments[1], top: arguments[2] });", i, g, h);
      await dors(2800);
    }
    /* On force un état donné du tampon, en écrasant ce que le module a posé.
     * `garde` empêche le module de le recorriger : on retire son observateur le
     * temps de la mesure, puis on le laisse reprendre. */
    async function force(z, w) {
      return await driver.executeScript([
        "var Z = arguments[0], W = arguments[1];",
        "var S = window.MeshScene, n = 0;",
        "function pose(m) {",
        "  var b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
        "  if (!b) { return; }",
        "  if (Z !== null) { b.z = Z; }",
        "  if (W !== null) { b.w = W; }",
        "  n++;",
        "}",
        "S.meshes.forEach(function (m) {",
        "  pose(m);",
        "  (m.instances || []).forEach(pose);",
        "});",
        "return n;"
      ].join("\n"), z, w);
    }
    async function moduleActif(actif) {
      await driver.executeScript(
        "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
        " type: 'horspage', actif: arguments[0] }, location.origin);", actif);
      await dors(2000);
    }

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: String(g[i].id).slice(-6), x: g[i].get('left'), y: g[i].get('top') };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton …" + cible.id + " en (" + cible.x + ", " + cible.y + ")");

    const dez = await driver.executeScript([
      "var st = null;",
      "document.querySelectorAll('*').forEach(function (n) {",
      "  if (st || !n.__vue_app__) { return; }",
      "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
      "});",
      "if (!st || typeof st.setZoom !== 'function') { return 'magasin absent'; }",
      "var a = st.zoom; st.setZoom(arguments[0]); return a + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("  dézoom : " + dez);
    await dors(3000);

    const LOIN = 99999, HAUT = -280;
    await bouge(cible.i, LOIN, LOIN);
    const loin = await driver.takeScreenshot();

    /* L'ÉTALON : le jeton chez lui, à pleine opacité par construction. */
    await bouge(cible.i, cible.x, cible.y);
    const etalon = await ecart(loin, await driver.takeScreenshot());
    function dis(nom, m) {
      console.log("    " + nom.padEnd(30) + String(m.pixels).padStart(5) + " px   total " +
        String(m.total).padStart(7) + "   moyen " + String(m.moyen).padStart(3) +
        "   pic " + String(m.pic).padStart(3) +
        (m.boite ? "   boîte " + JSON.stringify(m.boite) : ""));
    }

    console.log("\n  étalon — chez lui, opacité pleine par construction");
    dis("en page", etalon);

    await bouge(cible.i, cible.x, HAUT);

    /* ---------- L'ÉTAT LIVRÉ EN 0.52.0 : z = 1 ---------- */
    await moduleActif(false);
    await force(1, 1);
    await dors(1800);
    const zUn = await ecart(loin, await driver.takeScreenshot());
    console.log("\n  z = 1, w = 1   (ce qui a été livré, et signalé)");
    dis("hors page", zUn);

    /* ---------- LE CORRECTIF : w = 0 ---------- */
    await force(0, 0);
    await dors(1800);
    const wZero = await ecart(loin, await driver.takeScreenshot());
    console.log("\n  z = 0, w = 0   (le correctif, et la configuration du MJ)");
    dis("hors page", wZero);

    /* ---------- ET LE MODULE, TEL QU'IL SERA LIVRÉ ---------- */
    await moduleActif(true);
    await dors(2200);
    const parLeModule = await ecart(loin, await driver.takeScreenshot());
    const tampons = await driver.executeScript([
      "var S = window.MeshScene, out = [];",
      "S.meshes.forEach(function (m) {",
      "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (b) { out.push([b.z, b.w]); }",
      "  (m.instances || []).forEach(function (i) {",
      "    var c = i.instancedBuffers && i.instancedBuffers.u_Board;",
      "    if (c) { out.push([c.z, c.w]); }",
      "  });",
      "});",
      "return out.slice(0, 5);"
    ].join("\n"));
    console.log("\n  le MODULE, tel qu'il sera livré");
    dis("hors page", parLeModule);
    console.log("    [z, w] lus : " + JSON.stringify(tampons));

    await bouge(cible.i, cible.x, cible.y);

    console.log("\n  ──────────────────────────────────────────────");

    /* DEUX CHIFFRES, ET AUCUN N EST LA MOYENNE.
     *
     * Le TOTAL des écarts est proportionnel à l opacité : diviser l alpha par
     * deux divise la somme par deux. Le PIC dit jusqu où le pixel le plus franc
     * du jeton s écarte du fond — à pleine opacité il doit rejoindre celui de
     * l étalon, mesuré en page.
     *
     * La moyenne, elle, se calcule sur les seuls pixels retenus : à demi-opacité
     * les bords passent sous le seuil et sortent du calcul, ce qui la remonte.
     * Elle est imprimée pour la lecture, jamais pour trancher. */
    var rTotal = zUn.total ? (wZero.total / zUn.total) : 0;
    var picZ = etalon.pic ? (zUn.pic / etalon.pic) : 0;
    var picW = etalon.pic ? (wZero.pic / etalon.pic) : 0;

    console.log("  total des écarts, hors page :");
    console.log("    z = 1  →  " + zUn.total + "   (le voile)");
    console.log("    w = 0  →  " + wZero.total + "   (le correctif)");
    console.log("    rapport " + rTotal.toFixed(2) + "  —  deux, si l alpha était bien divisé par deux");
    console.log("\n  pic d écart, rapporté à l étalon en page (" + etalon.pic + ") :");
    console.log("    z = 1  →  " + Math.round(picZ * 100) + " %");
    console.log("    w = 0  →  " + Math.round(picW * 100) + " %");

    var bon = rTotal > 1.7 && picW > 0.9 && parLeModule.total >= wZero.total * 0.9;
    console.log("\n  le module rend " + parLeModule.total + ", soit " +
      (wZero.total ? Math.round(parLeModule.total / wZero.total * 100) : 0) +
      " % du correctif posé à la main");
    console.log("  " + (bon ? "LE VOILE EST LEVÉ." : "LE VOILE EST TOUJOURS LÀ."));

    releve("voile-" + quelle + ".json",
      { cible: cible, etalon: etalon, zUn: zUn, wZero: wZero,
        parLeModule: parLeModule, tampons: tampons,
        rapportTotal: rTotal, picZ: picZ, picW: picW, bon: bon });
    return bon ? 0 : 1;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE CLIGNOTEMENT : COMBIEN, ET POURQUOI ----------
 *
 * Signalé : « un clignotement toutes les X secondes, comme si ce qui empêchait
 * de voir les jetons se remettait par-dessus, puis redescendait ». C'est
 * exactement ce que faisait la 0.52.0 : Roll20 réécrivait `u_Board`, et le guet
 * ne repassait que 500 ms plus tard. Entre les deux, des images étaient
 * dessinées avec la valeur de Roll20.
 *
 * UNE ÉPREUVE QUI NE MONTRE QUE LE CORRECTIF NE PROUVE RIEN. Si l'on regarde la
 * version corrigée pendant trente secondes et qu'on ne voit rien clignoter, on
 * n'a pas montré qu'elle corrige : on a peut-être seulement regardé pendant une
 * accalmie. Il faut le TÉMOIN — rejouer le guet à 500 ms, dans la même partie,
 * sur le même jeton, et le voir clignoter.
 *
 * On mesure donc trois choses :
 *   1. combien de fois Roll20 REMPLACE le vecteur, par identité d'objet ;
 *   2. ce que donne le guet à 500 ms de la 0.52.0 (le témoin) ;
 *   3. ce que donne la correction avant chaque image (ce qu'on livre).
 */
async function leClignotement() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const secondes = Math.max(10, parseInt(process.argv[4], 10) || 30);
  const driver = await ouvre(config().visible === true);
  const crypto = require("crypto");
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function bouge(i, g, h) {
      await driver.executeScript(
        "var m = window.Campaign.activePage().thegraphics.models;" +
        "m[arguments[0]].save({ left: arguments[1], top: arguments[2] });", i, g, h);
      await dors(2800);
    }
    async function moduleActif(actif) {
      await driver.executeScript(
        "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
        " type: 'horspage', actif: arguments[0] }, location.origin);", actif);
      await dors(2000);
    }

    /* La boîte où le jeton se dessine, découpée dans la capture puis empreinte.
     * On ne prend QUE cette boîte : le reste de l'écran bouge tout seul — le
     * chat, un curseur, une infobulle — et noierait le signal. */
    async function empreinte(boite) {
      const png = await driver.takeScreenshot();
      const dec = await driver.executeAsyncScript(
        "var cb = arguments[arguments.length - 1];" +
        "var b = arguments[1];" +
        "var img = new Image();" +
        "img.onload = function () {" +
        "  var c = document.createElement('canvas');" +
        "  c.width = b[2]; c.height = b[3];" +
        "  var g = c.getContext('2d');" +
        "  g.drawImage(img, b[0], b[1], b[2], b[3], 0, 0, b[2], b[3]);" +
        "  try { cb(c.toDataURL('image/png')); } catch (e) { cb('ERREUR ' + e); } };" +
        "img.onerror = function () { cb('ERREUR chargement'); };" +
        "img.src = 'data:image/png;base64,' + arguments[0];", png, boite);
      if (typeof dec !== "string" || dec.indexOf("data:image/png") !== 0) { return null; }
      return crypto.createHash("sha1")
        .update(Buffer.from(dec.split(",")[1], "base64")).digest("hex").slice(0, 10);
    }

    async function boiteDuJeton(i, x, y, haut) {
      const png1 = await driver.takeScreenshot();
      await bouge(i, x, haut);
      const png2 = await driver.takeScreenshot();
      const b = await driver.executeAsyncScript([
        "var cb = arguments[arguments.length - 1];",
        "var A = new Image(), B = new Image(), n = 0;",
        "function pret() {",
        "  if (++n < 2) { return; }",
        "  var c = document.createElement('canvas');",
        "  c.width = A.width; c.height = A.height;",
        "  var g = c.getContext('2d', { willReadFrequently: true });",
        "  g.drawImage(A, 0, 0); var a = g.getImageData(0, 0, c.width, c.height).data;",
        "  g.clearRect(0, 0, c.width, c.height);",
        "  g.drawImage(B, 0, 0); var b = g.getImageData(0, 0, c.width, c.height).data;",
        "  var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, cnt = 0;",
        "  for (var i = 0; i < a.length; i += 4) {",
        "    var d = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);",
        "    if (d < 24) { continue; }",
        "    var p = i / 4, x = p % c.width, y = (p - x) / c.width;",
        "    cnt++;",
        "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }",
        "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }",
        "  }",
        "  if (!cnt) { cb(null); return; }",
        "  var m = 6;",
        "  cb([Math.max(0, x0 - m), Math.max(0, y0 - m),",
        "      Math.min(c.width, x1 - x0 + 1 + 2*m), Math.min(c.height, y1 - y0 + 1 + 2*m)]);",
        "}",
        "A.onload = pret; B.onload = pret;",
        "A.onerror = B.onerror = function () { cb(null); };",
        "A.src = 'data:image/png;base64,' + arguments[0];",
        "B.src = 'data:image/png;base64,' + arguments[1];"
      ].join("\n"), png1, png2);
      return b;
    }

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: String(g[i].id).slice(-6), x: g[i].get('left'), y: g[i].get('top') };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton …" + cible.id + " en (" + cible.x + ", " + cible.y + ")");

    const dez = await driver.executeScript([
      "var st = null;",
      "document.querySelectorAll('*').forEach(function (n) {",
      "  if (st || !n.__vue_app__) { return; }",
      "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
      "});",
      "if (!st || typeof st.setZoom !== 'function') { return 'magasin absent'; }",
      "var a = st.zoom; st.setZoom(arguments[0]); return a + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("  dézoom : " + dez);
    await dors(3000);

    const HAUT = -280;
    const boite = await boiteDuJeton(cible.i, cible.x, cible.y, HAUT);
    if (!boite) { console.log("  le jeton ne se voit pas hors page : rien à mesurer."); return 1; }
    console.log("  boîte suivie : " + JSON.stringify(boite));

    /* ---------- 1. ROLL20 REMPLACE-T-IL LE VECTEUR, ET À QUEL RYTHME ? ----------
     *
     * On compte par IDENTITÉ D'OBJET, et non par valeur : notre module corrige
     * la valeur avant chaque image, donc la valeur ne dit plus rien. Le vecteur
     * NEUF, lui, se voit. La première image sert de référence et ne compte pas. */
    await driver.executeScript([
      "window.__vttkMouchard = { images: 0, neufs: 0, premiere: true, fautifs: 0 };",
      "var S = window.MeshScene, vus = new WeakSet(), M = window.__vttkMouchard;",
      "M.obs = S.onBeforeRenderObservable.add(function () {",
      "  M.images++;",
      "  var l = S.meshes, i, j, ins, b;",
      "  function voir(m) {",
      "    b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
      "    if (!b) { return; }",
      "    if (!vus.has(b)) { vus.add(b); if (!M.premiere) { M.neufs++; } }",
      "    if (b.w !== 0) { M.fautifs++; }",
      "  }",
      "  for (i = 0; i < l.length; i++) {",
      "    voir(l[i]);",
      "    ins = l[i].instances;",
      "    if (!ins) { continue; }",
      "    for (j = 0; j < ins.length; j++) { voir(ins[j]); }",
      "  }",
      "  M.premiere = false;",
      "});",
      "return 'mouchard posé';"
    ].join("\n"));

    /* ---------- 2. LA VERSION LIVRÉE : correction avant chaque image ---------- */
    console.log("\n  -- LA VERSION CORRIGÉE, " + secondes + " s --");
    const vues = {};
    const debut = [];
    for (let k = 0; k < Math.round(secondes / 1.2); k++) {
      const h = await empreinte(boite);
      if (h) { vues[h] = (vues[h] || 0) + 1; debut.push(h); }
      await dors(900);
    }
    const m1 = await driver.executeScript(
      "var M = window.__vttkMouchard; return { images: M.images, neufs: M.neufs, fautifs: M.fautifs };");
    const distinctes = Object.keys(vues);
    console.log("    " + debut.length + " relevés, " + distinctes.length + " image(s) distincte(s)");
    distinctes.forEach(function (h) { console.log("      " + h + "   ×" + vues[h]); });
    console.log("    Roll20 a remplacé le vecteur " + m1.neufs + " fois en " + m1.images + " images");
    console.log("    images dessinées avec sa valeur : " + m1.fautifs);

    /* ---------- 3. LE TÉMOIN : le guet à 500 ms de la 0.52.0 ----------
     *
     * On éteint le module — il retire son observateur — et l'on remet à sa place
     * exactement ce que faisait la version signalée : la même correction, mais
     * sur une horloge de 500 ms. Si le clignotement vient bien de là, il revient. */
    console.log("\n  -- LE TÉMOIN : le guet à 500 ms de la 0.52.0, " + secondes + " s --");
    await moduleActif(false);
    await driver.executeScript([
      "var S = window.MeshScene;",
      "window.__vttkVieux = setInterval(function () {",
      "  var l = S.meshes, i, j, ins, b;",
      "  function pose(m) {",
      "    b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
      "    if (b) { b.w = 0; }",
      "  }",
      "  for (i = 0; i < l.length; i++) {",
      "    pose(l[i]);",
      "    ins = l[i].instances;",
      "    if (!ins) { continue; }",
      "    for (j = 0; j < ins.length; j++) { pose(ins[j]); }",
      "  }",
      "}, 500);",
      "return 'guet 500 ms posé';"
    ].join("\n"));
    await dors(1500);

    const vues2 = {};
    for (let k = 0; k < Math.round(secondes / 1.2); k++) {
      const h = await empreinte(boite);
      if (h) { vues2[h] = (vues2[h] || 0) + 1; }
      await dors(900);
    }
    const distinctes2 = Object.keys(vues2);
    console.log("    " + distinctes2.length + " image(s) distincte(s)");
    distinctes2.forEach(function (h) { console.log("      " + h + "   ×" + vues2[h]); });

    await driver.executeScript(
      "clearInterval(window.__vttkVieux); window.__vttkVieux = null;" +
      "try { window.MeshScene.onBeforeRenderObservable.remove(window.__vttkMouchard.obs); } catch (e) {}");
    await moduleActif(true);
    await bouge(cible.i, cible.x, cible.y);

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  version corrigée : " + distinctes.length + " image(s) distincte(s)");
    console.log("  guet à 500 ms    : " + distinctes2.length + " image(s) distincte(s)");
    const temoinValide = m1.neufs > 0;
    const bon = distinctes.length === 1 && m1.fautifs === 0;
    if (!temoinValide) {
      console.log("  Roll20 n'a rien réécrit pendant l'épreuve : elle ne tranche pas.");
      console.log("  Rallonge la durée (node outils/pilote.js clignote joueur 90).");
    } else if (bon) {
      console.log("  AUCUNE IMAGE dessinée avec la valeur de Roll20, alors qu'il a");
      console.log("  remplacé le vecteur " + m1.neufs + " fois. Le clignotement est levé.");
    } else {
      console.log("  IL RESTE " + m1.fautifs + " image(s) fautive(s) et " + distinctes.length +
        " image(s) distincte(s) : ça clignote encore.");
    }

    releve("clignote-" + quelle + ".json",
      { cible: cible, boite: boite, secondes: secondes,
        corrige: { distinctes: distinctes.length, vues: vues, mouchard: m1 },
        temoin500: { distinctes: distinctes2.length, vues: vues2 },
        bon: bon, temoinValide: temoinValide });
    return bon ? 0 : 1;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QU'EST-CE QUI FAIT RÉÉCRIRE u_Board À ROLL20 ? ----------
 *
 * Sur une page au repos, il ne le réécrit PAS : zéro remplacement en 787 images,
 * quarante-cinq secondes durant. Le clignotement signalé vient donc d'un GESTE,
 * pas du temps qui passe — et tant qu'on ne sait pas lequel, on ne peut ni le
 * reproduire ni prouver qu'on l'a corrigé.
 *
 * On pose un mouchard qui compte les remplacements par IDENTITÉ D'OBJET — la
 * valeur ne dit plus rien, notre module la corrige avant chaque image — puis on
 * joue une série de gestes, un par un, et l'on relève ce que chacun coûte.
 *
 * Le mouchard note aussi les images dessinées avec un w fautif. Il est posé
 * APRÈS l'observateur du module, donc il voit l'état CORRIGÉ : s'il compte des
 * fautifs, c'est que la correction n'a pas tenu, et c'est exactement le défaut
 * qu'on traque.
 */
async function quiDeclencheLaReecriture() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    const cible = await driver.executeScript([
      "var g = window.Campaign.activePage().thegraphics.models;",
      "for (var i = 0; i < g.length; i++) {",
      "  if (String(g[i].get('layer')) === 'objects') {",
      "    return { i: i, id: String(g[i].id).slice(-6), x: g[i].get('left'), y: g[i].get('top'),",
      "             l: g[i].get('width'), h: g[i].get('height'), rot: g[i].get('rotation') || 0 };",
      "  }",
      "}", "return null;"
    ].join("\n"));
    if (!cible) { console.log("  aucun jeton sur la couche des jetons"); return 1; }
    console.log("\n  jeton …" + cible.id + " en (" + cible.x + ", " + cible.y + ")  " +
      cible.l + " x " + cible.h);

    await driver.executeScript([
      "window.__vttkMouchard = { images: 0, neufs: 0, premiere: true, fautifs: 0, vus: new WeakSet() };",
      "var S = window.MeshScene, M = window.__vttkMouchard;",
      "M.obs = S.onBeforeRenderObservable.add(function () {",
      "  M.images++;",
      "  var l = S.meshes, i, j, ins;",
      "  function voir(m) {",
      "    var b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
      "    if (!b) { return; }",
      "    if (!M.vus.has(b)) { M.vus.add(b); if (!M.premiere) { M.neufs++; } }",
      "    if (b.w !== 0) { M.fautifs++; }",
      "  }",
      "  for (i = 0; i < l.length; i++) {",
      "    voir(l[i]);",
      "    ins = l[i].instances;",
      "    if (!ins) { continue; }",
      "    for (j = 0; j < ins.length; j++) { voir(ins[j]); }",
      "  }",
      "  M.premiere = false;",
      "});",
      "return 'posé';"
    ].join("\n"));

    async function releveM() {
      return await driver.executeScript(
        "var M = window.__vttkMouchard; return { images: M.images, neufs: M.neufs, fautifs: M.fautifs };");
    }
    async function magasin() {
      return await driver.executeScript([
        "var st = null;",
        "document.querySelectorAll('*').forEach(function (n) {",
        "  if (st || !n.__vue_app__) { return; }",
        "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
        "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
        "});",
        "window.__vttkEngine = st; return !!st;"
      ].join("\n"));
    }
    await magasin();
    await driver.executeScript("if (window.__vttkEngine) { window.__vttkEngine.setZoom(30); }");
    await dors(3000);

    let precedent = await releveM();

    /* Chaque geste, isolé, et ce qu'il coûte. On laisse deux secondes après
     * chacun : une réécriture peut arriver au tour de boucle suivant. */
    async function geste(nom, script, args) {
      const avant = await releveM();
      try { await driver.executeScript(script, ...(args || [])); }
      catch (e) { console.log("    " + nom.padEnd(34) + "IMPOSSIBLE : " + String(e).slice(0, 60)); return; }
      await dors(2500);
      const apres = await releveM();
      const dn = apres.neufs - avant.neufs;
      const df = apres.fautifs - avant.fautifs;
      const di = apres.images - avant.images;
      console.log("    " + nom.padEnd(34) +
        String(dn).padStart(4) + " remplacement(s)" +
        "   " + String(df).padStart(4) + " image(s) fautive(s)" +
        "   sur " + String(di).padStart(4) + " images");
      precedent = apres;
    }

    const M = "var g = window.Campaign.activePage().thegraphics.models; var t = g[" + cible.i + "];";
    console.log("\n  -- CE QUE CHAQUE GESTE COÛTE --");
    await geste("rien du tout (témoin)", "return 1;");
    await geste("déplacer le jeton", M + "t.save({ left: " + cible.x + ", top: -280 });");
    await geste("le redéplacer", M + "t.save({ left: " + (cible.x + 70) + ", top: -280 });");
    await geste("le redimensionner", M + "t.save({ width: " + (cible.l * 1.5) + " });");
    await geste("le remettre à sa taille", M + "t.save({ width: " + cible.l + " });");
    await geste("le faire tourner", M + "t.save({ rotation: 45 });");
    await geste("le remettre droit", M + "t.save({ rotation: " + cible.rot + " });");
    await geste("changer son opacité", M + "t.save({ fliph: true });");
    await geste("la remettre", M + "t.save({ fliph: false });");
    await geste("poser un marqueur d'état", M + "t.save({ statusmarkers: 'red' });");
    await geste("l'ôter", M + "t.save({ statusmarkers: '' });");
    await geste("zoomer", "if (window.__vttkEngine) { window.__vttkEngine.setZoom(60); }");
    await geste("dézoomer", "if (window.__vttkEngine) { window.__vttkEngine.setZoom(30); }");
    await geste("changer la couche du jeton", M + "t.save({ layer: 'map' });");
    await geste("la remettre", M + "t.save({ layer: 'objects' });");
    await geste("attendre 10 s", "return 1;");
    await dors(9000);
    const apresAttente = await releveM();
    console.log("    " + "(après 10 s de plus)".padEnd(34) +
      String(apresAttente.neufs - precedent.neufs).padStart(4) + " remplacement(s)" +
      "   " + String(apresAttente.fautifs - precedent.fautifs).padStart(4) + " image(s) fautive(s)" +
      "   sur " + String(apresAttente.images - precedent.images).padStart(4) + " images");

    const total = await releveM();
    await driver.executeScript(
      "try { window.MeshScene.onBeforeRenderObservable.remove(window.__vttkMouchard.obs); } catch (e) {}");
    await driver.executeScript(M + "t.save({ left: " + cible.x + ", top: " + cible.y +
      ", width: " + cible.l + ", height: " + cible.h + ", rotation: " + cible.rot +
      ", layer: 'objects', statusmarkers: '', fliph: false });");
    console.log("\n  jeton remis en (" + cible.x + ", " + cible.y + ")");

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  " + total.neufs + " remplacement(s) au total, sur " + total.images + " images");
    console.log("  " + total.fautifs + " image(s) dessinée(s) avec la valeur de Roll20");
    if (total.neufs === 0) {
      console.log("  AUCUN GESTE NE LE FAIT RÉÉCRIRE ICI. Le clignotement vient d'ailleurs,");
      console.log("  et l'épreuve ne l'a pas trouvé — il ne faut pas conclure qu'il est levé.");
    } else if (total.fautifs === 0) {
      console.log("  Il réécrit, et pas une seule image n'a été dessinée avec sa valeur :");
      console.log("  la correction avant chaque image tient.");
    } else {
      console.log("  IL RESTE DES IMAGES FAUTIVES : ça clignote encore.");
    }

    releve("declenche-" + quelle + ".json", { cible: cible, total: total });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA SCÈNE SURVIT-ELLE À UN CHANGEMENT DE PAGE ? ----------
 *
 * Le module accroche son observateur à `window.MeshScene`. Si Roll20 remplace
 * cette scène — un changement de page, par exemple, décidé par le MJ et subi par
 * tous les joueurs —, l'observateur reste sur la MORTE : il ne se déclenche plus
 * jamais, la nouvelle n'a aucun guet, et les jetons hors page redisparaissent.
 *
 * Sans un mot. Le module continue de se dire allumé, sa case reste cochée, et
 * personne ne peut deviner qu'il a lâché.
 *
 * On ne devine pas non plus : on regarde si l'objet change d'identité.
 */
async function laSceneSurvit() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    /* SUR LA PARTIE OÙ L'ON EST MJ : changer de page est son geste, pas celui
     * d'un joueur, et c'est justement le geste qu'on veut éprouver. */
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    /* On marque la scène en cours : une propriété à nous, que Roll20 ne pose
     * pas. Si elle a disparu après le changement, l'objet n'est plus le même. */
    const pages = await driver.executeScript([
      "window.MeshScene.__vttkMarque = 'scene-A';",
      "var C = window.Campaign;",
      "var l = (C.pages && C.pages.models) ? C.pages.models : [];",
      "return { active: C.get('playerpageid'),",
      "  pages: l.map(function (p) { return { id: p.id, nom: p.get('name') }; }),",
      "  marque: window.MeshScene.__vttkMarque,",
      "  observateurs: (window.MeshScene.onBeforeRenderObservable &&",
      "    window.MeshScene.onBeforeRenderObservable._observers || []).length };"
    ].join("\n"));
    console.log("\n  page active : " + pages.active);
    pages.pages.forEach(function (p) {
      console.log("    " + p.id + "   " + p.nom + (p.id === pages.active ? "   ← active" : ""));
    });
    console.log("  marque posée : " + pages.marque +
      "   observateurs de rendu : " + pages.observateurs);

    const autre = pages.pages.filter(function (p) { return p.id !== pages.active; })[0];
    if (!autre) {
      console.log("\n  une seule page dans cette partie : on ne peut pas éprouver le changement.");
      return 1;
    }

    console.log("\n  on bascule sur « " + autre.nom + " »");
    await driver.executeScript(
      "window.Campaign.save({ playerpageid: arguments[0] });", autre.id);
    await dors(9000);

    const apres = await driver.executeScript([
      "var S = window.MeshScene;",
      "return { marque: S ? (S.__vttkMarque || null) : 'PAS DE SCENE',",
      "  observateurs: (S && S.onBeforeRenderObservable &&",
      "    S.onBeforeRenderObservable._observers || []).length,",
      "  maillages: S ? S.meshes.length : null,",
      "  active: window.Campaign.get('playerpageid') };"
    ].join("\n"));
    console.log("  page active : " + apres.active);
    console.log("  marque retrouvée : " + apres.marque +
      "   observateurs : " + apres.observateurs + "   maillages : " + apres.maillages);

    /* ET LE MODULE TIENT-IL ENCORE ? On regarde ce que valent les tampons. */
    const tampons = await driver.executeScript([
      "var S = window.MeshScene, out = [];",
      "S.meshes.forEach(function (m) {",
      "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (b) { out.push(b.w); }",
      "  (m.instances || []).forEach(function (i) {",
      "    var c = i.instancedBuffers && i.instancedBuffers.u_Board;",
      "    if (c) { out.push(c.w); }",
      "  });",
      "});",
      "return out;"
    ].join("\n"));
    console.log("  w des tampons après bascule : " + JSON.stringify(tampons));

    await driver.executeScript(
      "window.Campaign.save({ playerpageid: arguments[0] });", pages.active);
    await dors(6000);
    console.log("  page rendue à « " + (pages.pages.filter(function (p) {
      return p.id === pages.active; })[0] || {}).nom + " »");

    console.log("\n  ──────────────────────────────────────────────");
    const memeScene = apres.marque === "scene-A";
    const tousANeuf = tampons.length > 0 && tampons.every(function (w) { return w === 0; });
    if (memeScene) {
      console.log("  LA SCÈNE SURVIT : c'est le même objet, l'observateur tient.");
    } else {
      console.log("  LA SCÈNE EST REMPLACÉE. L'observateur du module est resté sur la morte :");
      console.log("  il faut se raccrocher, sinon le module lâche en silence au premier");
      console.log("  changement de page.");
    }
    console.log("  et les tampons de la nouvelle page : " +
      (tousANeuf ? "tous à zéro, le module tient encore"
                 : "PAS tous à zéro — " + JSON.stringify(tampons)));

    releve("scene-mj.json", { avant: pages, apres: apres, tampons: tampons, memeScene: memeScene });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE COÛTE UNE CORRECTION AVANT CHAQUE IMAGE ----------
 *
 * Le module ne repasse plus toutes les 500 ms mais AVANT CHAQUE IMAGE, et Roll20
 * dessine au rythme de l'écran — cent quatre-vingts fois par seconde sur ce
 * poste. Un parcours de tous les maillages, cent quatre-vingts fois par seconde,
 * mérite d'être chiffré plutôt que présumé négligeable : c'est le genre de
 * décision qu'on justifie après coup en disant « ça ne coûte rien », sans avoir
 * regardé.
 *
 * On mesure deux choses, et la seconde vaut mieux que la première :
 *   1. le temps du parcours lui-même, moyenné sur des milliers d'appels ;
 *   2. la CADENCE D'AFFICHAGE, module allumé puis éteint — seul chiffre qui dise
 *      ce que l'utilisateur ressent.
 */
async function coutHorsPage() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function moduleActif(actif) {
      await driver.executeScript(
        "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
        " type: 'horspage', actif: arguments[0] }, location.origin);", actif);
      await dors(2500);
    }

    const scene = await driver.executeScript([
      "var S = window.MeshScene, n = 0, ins = 0, tampons = 0;",
      "S.meshes.forEach(function (m) {",
      "  n++;",
      "  if (m.instancedBuffers && m.instancedBuffers.u_Board) { tampons++; }",
      "  (m.instances || []).forEach(function (i) {",
      "    ins++;",
      "    if (i.instancedBuffers && i.instancedBuffers.u_Board) { tampons++; }",
      "  });",
      "});",
      "return { maillages: n, instances: ins, tampons: tampons };"
    ].join("\n"));
    console.log("\n  scène : " + scene.maillages + " maillages, " + scene.instances +
      " instances, " + scene.tampons + " tampons");

    /* ---------- 1. LE PARCOURS, CHRONOMÉTRÉ ----------
     *
     * On rejoue EXACTEMENT ce que fait hpCorrige — même parcours, même test,
     * même écriture conditionnelle — et on le moyenne sur assez d'appels pour
     * sortir du bruit de l'horloge. */
    const chrono = await driver.executeScript([
      "var S = window.MeshScene;",
      /* L ANCIENNE ÉCRITURE : une fermeture neuve par appel, un objet de
       * retour alloué, un appel indirect par tampon. */
      "function parcourt(fn) {",
      "  var l = S.meshes, i, j, ins, b, vus = 0, touches = 0;",
      "  function prend(m) { return m && m.instancedBuffers && m.instancedBuffers.u_Board; }",
      "  for (i = 0; i < l.length; i++) {",
      "    b = prend(l[i]);",
      "    if (b) { vus++; if (fn(b)) { touches++; } }",
      "    ins = l[i].instances;",
      "    if (!ins) { continue; }",
      "    for (j = 0; j < ins.length; j++) {",
      "      b = prend(ins[j]);",
      "      if (b) { vus++; if (fn(b)) { touches++; } }",
      "    }",
      "  }",
      "  return { tampons: vus, poses: touches };",
      "}",
      "function ancienne() {",
      "  return parcourt(function (b) {",
      "    if (b.w === 0) { return false; }",
      "    b.w = 0; return true;",
      "  });",
      "}",
      /* LA NEUVE, telle qu elle est ÉCRITE dans le pont : rien de construit,
       * la couche vérifiée, et surtout une SORTIE TÔT sur « w vaut déjà zéro ».
       *
       * C est cette sortie qui décide du prix en régime établi : une fois les
       * tampons corrigés, plus aucun ne remonte sa chaîne de parents. La
       * remontée ne coûte que l image qui suit une réécriture de Roll20 — et
       * l on en a compté quatre sur mille images. */
      "function surLaCouche(m) {",
      "  var n = m, k = 0;",
      "  while (n.parent && k < 8) { n = n.parent; k++; }",
      "  return String(n.name || '') === 'tokens-layer';",
      "}",
      "function un(m) {",
      "  var b = m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (!b || b.w === 0) { return false; }",
      "  if (!surLaCouche(m)) { return false; }",
      "  b.w = 0; return true;",
      "}",
      "function neuve() {",
      "  var l = S.meshes, i, j, ins, m;",
      "  for (i = 0; i < l.length; i++) {",
      "    m = l[i]; un(m);",
      "    ins = m.instances;",
      "    if (!ins) { continue; }",
      "    for (j = 0; j < ins.length; j++) { un(ins[j]); }",
      "  }",
      "}",
      "var N = 20000, k, g = 0;",
      "for (k = 0; k < 3000; k++) { g += ancienne().tampons; neuve(); }",
      "var a0 = performance.now();",
      "for (k = 0; k < N; k++) { g += ancienne().tampons; }",
      "var a1 = performance.now();",
      "for (k = 0; k < N; k++) { neuve(); }",
      "var a2 = performance.now();",
      "return { ancienne: ((a1 - a0) / N) * 1000, neuve: ((a2 - a1) / N) * 1000,",
      "  appels: N, gage: g };"
    ].join("\n"));
    console.log("\n  -- LE PARCOURS, LES DEUX ÉCRITURES --");
    console.log("    par fermeture (ce qui était écrit) : " + chrono.ancienne.toFixed(2) + " µs");
    console.log("    en clair       (ce qui est écrit)  : " + chrono.neuve.toFixed(2) + " µs" +
      "   soit " + (chrono.ancienne / chrono.neuve).toFixed(1) + " fois moins");

    /* ---------- 2. LA CADENCE, CE QUI SE RESSENT ----------
     *
     * On compte les images sur dix secondes, module allumé puis éteint. C'est le
     * seul chiffre qui parle de ce qu'on voit, et il porte son propre témoin :
     * si les deux mesures d'un même état diffèrent déjà, l'écart entre états ne
     * veut rien dire. */
    async function cadence(secondes) {
      await driver.executeScript([
        "window.__vttkFps = { n: 0 };",
        "var S = window.MeshScene;",
        "window.__vttkFps.obs = S.onBeforeRenderObservable.add(function () { window.__vttkFps.n++; });"
      ].join("\n"));
      await dors(secondes * 1000);
      const n = await driver.executeScript([
        "var F = window.__vttkFps;",
        "try { window.MeshScene.onBeforeRenderObservable.remove(F.obs); } catch (e) {}",
        "return F.n;"
      ].join("\n"));
      return n / secondes;
    }

    /* ON ALTERNE LES DEUX ÉTATS, ET ON ALTERNE PLUSIEURS FOIS.
     *
     * Mesurer dix secondes allumé puis dix secondes éteint donne un écart qui
     * contient la DÉRIVE de la page — elle se charge, elle se calme, elle
     * ralentit sous une autre charge. Le premier essai a rendu 20,0 contre
     * 20,8 : de quoi conclure à un coût de 3 %, pour un travail chronométré à
     * quelques microsecondes par image. C était la dérive, pas le module.
     *
     * En alternant A B A B A B, la dérive frappe les deux états également et
     * l ÉCART DES MOYENNES la perd. L écart entre répétitions d un même état
     * donne le bruit, et c est à lui qu on compare. */
    console.log("\n  -- LA CADENCE D AFFICHAGE, EN ALTERNANCE --");
    var mesA = [], mesE = [];
    for (var tour = 0; tour < 3; tour++) {
      await moduleActif(true);
      mesA.push(await cadence(8));
      await moduleActif(false);
      mesE.push(await cadence(8));
      console.log("    tour " + (tour + 1) + "   allumé " + mesA[tour].toFixed(1) +
        "   éteint " + mesE[tour].toFixed(1));
    }
    await moduleActif(true);

    function moyenne(l) { return l.reduce(function (a, b) { return a + b; }, 0) / l.length; }
    function etendue(l) { return Math.max.apply(null, l) - Math.min.apply(null, l); }
    const allume = moyenne(mesA), eteint = moyenne(mesE);
    const bruit = Math.max(etendue(mesA), etendue(mesE));
    const ecart = eteint - allume;

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  parcours : " + chrono.neuve.toFixed(2) + " µs par image");
    console.log("  cadence  : " + allume.toFixed(1) + " allumé contre " +
      eteint.toFixed(1) + " éteint   (écart " + ecart.toFixed(2) + ")");
    console.log("  bruit entre répétitions d un même état : " + bruit.toFixed(2));
    if (Math.abs(ecart) <= bruit) {
      console.log("  L ÉCART EST SOUS LE BRUIT : le module ne se mesure pas à la cadence.");
    } else {
      console.log("  L écart dépasse le bruit : il coûte " + ecart.toFixed(2) + " images/s.");
    }

    releve("cout-horspage-" + quelle + ".json",
      { scene: scene, chrono: chrono, allume: mesA, eteint: mesE,
        ecart: ecart, bruit: bruit });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE MODULE CHANGE-T-IL AUTRE CHOSE QUE LES JETONS ? ----------
 *
 * Relevé chez le MJ, en éteignant le module : dix-neuf mille pixels changent, sur
 * une boîte de 484 × 782 — bien plus qu'un jeton. Et deux tampons y reviennent à
 * w = 1 alors que tous les autres valaient déjà zéro.
 *
 * C'est cohérent avec le nuanceur, et c'est ma faute de ne pas l'avoir vu :
 *
 *     if (v_Offboard == 1.) { offBoard = <déborde ?>; if (offBoard && z==0) discard; }
 *     ...
 *     if (offBoard && v_GridAlign != 1.0) { glFragColor.a *= 0.5; }
 *
 * Poser w = 0 ne fait pas que sauver les jetons du rejet : ça éteint AUSSI la
 * demi-teinte pour TOUT maillage qui portait w = 1 et qui déborde de la page.
 * Chez le MJ, où rien n'est jeté (z = 1), c'est le SEUL effet — et il est
 * visible.
 *
 * La documentation du module dit « chez le MJ il ne fait rien ». Si c'est faux,
 * il faut le dire ; et si l'effet n'est pas voulu, il faut le corriger.
 *
 * On ne bouge donc AUCUN jeton : on éteint et on rallume, et on regarde ce que
 * l'écran fait — puis on nomme les maillages en cause.
 */
async function effetDeBord() {
  const quelle = (process.argv[3] || "joueur").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    async function differe(aB64, bB64) {
      return await driver.executeAsyncScript([
        "var cb = arguments[arguments.length - 1];",
        "var A = new Image(), B = new Image(), n = 0;",
        "function pret() {",
        "  if (++n < 2) { return; }",
        "  var c = document.createElement('canvas');",
        "  c.width = A.width; c.height = A.height;",
        "  var g = c.getContext('2d', { willReadFrequently: true });",
        "  g.drawImage(A, 0, 0); var a = g.getImageData(0, 0, c.width, c.height).data;",
        "  g.clearRect(0, 0, c.width, c.height);",
        "  g.drawImage(B, 0, 0); var b = g.getImageData(0, 0, c.width, c.height).data;",
        "  var cnt = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;",
        "  for (var i = 0; i < a.length; i += 4) {",
        "    var d = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);",
        "    if (d < 12) { continue; }",
        "    var p = i / 4, x = p % c.width, y = (p - x) / c.width;",
        "    cnt++;",
        "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }",
        "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }",
        "  }",
        "  cb({ pixels: cnt, boite: cnt ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null });",
        "}",
        "A.onload = pret; B.onload = pret;",
        "A.onerror = B.onerror = function () { cb({ erreur: 1 }); };",
        "A.src = 'data:image/png;base64,' + arguments[0];",
        "B.src = 'data:image/png;base64,' + arguments[1];"
      ].join("\n"), aB64, bB64);
    }
    async function moduleActif(actif) {
      await driver.executeScript(
        "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
        " type: 'horspage', actif: arguments[0] }, location.origin);", actif);
      await dors(2500);
    }

    const dez = await driver.executeScript([
      "var st = null;",
      "document.querySelectorAll('*').forEach(function (n) {",
      "  if (st || !n.__vue_app__) { return; }",
      "  try { var p = n.__vue_app__.config.globalProperties.$pinia;",
      "    if (p && p._s && p._s.get) { st = p._s.get('engine'); } } catch (e) {}",
      "});",
      "if (!st || typeof st.setZoom !== 'function') { return 'magasin absent'; }",
      "var a = st.zoom; st.setZoom(arguments[0]); return a + ' -> ' + st.zoom;"
    ].join("\n"), 30);
    console.log("\n  dézoom : " + dez + "   (toute la page à l'écran, et sa marge)");
    await dors(3000);

    /* QUELS MAILLAGES PORTENT w = 1 ? Ce sont eux, et eux seuls, que le module
     * touche. On les nomme avant d'y toucher. */
    const qui = await driver.executeScript([
      "var S = window.MeshScene, out = [];",
      "function voir(m, dansUneInstance) {",
      "  var b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (!b) { return; }",
      "  out.push({ nom: String(m.name || '').slice(0, 46), instance: !!dansUneInstance,",
      "             z: b.z, w: b.w, vttkW: b.vttkW === undefined ? null : b.vttkW });",
      "}",
      "S.meshes.forEach(function (m) {",
      "  voir(m, false);",
      "  (m.instances || []).forEach(function (i) { voir(i, true); });",
      "});",
      "return { gmMode: S.metadata ? !!S.metadata.gmMode : null, tampons: out };"
    ].join("\n"));
    console.log("  gmMode : " + qui.gmMode + "   " + qui.tampons.length + " tampons");

    await moduleActif(true);
    await dors(2500);
    const allume = await driver.takeScreenshot();
    await moduleActif(false);
    await dors(2500);
    const eteint = await driver.takeScreenshot();
    const d1 = await differe(allume, eteint);

    /* Et l'on relit : qui portait quoi, une fois rendu à Roll20 ? */
    const rendu = await driver.executeScript([
      "var S = window.MeshScene, out = [];",
      "function voir(m) {",
      "  var b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (!b) { return; }",
      "  if (b.w !== 0) { out.push({ nom: String(m.name || '').slice(0, 46), z: b.z, w: b.w }); }",
      "}",
      "S.meshes.forEach(function (m) { voir(m); (m.instances || []).forEach(voir); });",
      "return out;"
    ].join("\n"));

    await moduleActif(true);
    await dors(2500);
    const rallume = await driver.takeScreenshot();
    const d2 = await differe(allume, rallume);

    console.log("\n  -- CE QUE LE MODULE CHANGE, SANS QU'UN JETON AIT BOUGÉ --");
    console.log("    allumé → éteint   : " + d1.pixels + " pixels   boîte " + JSON.stringify(d1.boite));
    console.log("    allumé → rallumé  : " + d2.pixels + " pixels   (le bruit de l'épreuve)");

    console.log("\n  -- LES MAILLAGES QUE ROLL20 MET À w = 1 --");
    if (!rendu.length) { console.log("    aucun : Roll20 les met tous à zéro sur cette page."); }
    rendu.forEach(function (m) {
      console.log("    " + m.nom.padEnd(48) + "z " + m.z + "   w " + m.w);
    });

    console.log("\n  ──────────────────────────────────────────────");
    const propre = d1.pixels <= Math.max(40, d2.pixels * 3);
    if (propre) {
      console.log("  Le module ne change RIEN d'autre que les jetons hors page :");
      console.log("  " + d1.pixels + " pixels, pour " + d2.pixels + " de bruit.");
    } else {
      console.log("  IL CHANGE " + d1.pixels + " PIXELS SANS QU'UN JETON AIT BOUGÉ,");
      console.log("  pour " + d2.pixels + " de bruit. Poser w = 0 éteint aussi la demi-teinte");
      console.log("  que Roll20 applique hors page aux maillages ci-dessus. Ce n'est pas");
      console.log("  ce que le module promet.");
    }

    releve("bord-" + quelle + ".json",
      { gmMode: qui.gmMode, avant: qui.tampons, rendu: rendu, d1: d1, d2: d2, propre: propre });
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QU'EST-CE QUI SÉPARE UN JETON D'UNE IMAGE DE CARTE ? ----------
 *
 * Roll20 écrit w ainsi :  w = (!gmMode || layerName === <quelque chose>) ? 1 : 0
 *
 * Chez un JOUEUR, `!gmMode` est vrai : tout reçoit w = 1, et la couche n'y
 * paraît pas. Chez le MJ, elle décide seule — et l'on a mesuré le résultat :
 * ses jetons reçoivent w = 0, ses images de carte w = 1.
 *
 * Autrement dit, LA RÈGLE EST OBSERVABLE CHEZ LE MJ, et nulle part ailleurs.
 * On la relève donc là, en regardant tout ce qui pourrait porter la couche, et
 * l'on garde la propriété qui sépare exactement les deux groupes.
 *
 * C'est ce qui manque au module : poser w = 0 partout éteint aussi la
 * demi-teinte que Roll20 applique hors page aux images de carte — dix-huit mille
 * pixels, mesurés. Il faut ne le poser QUE là où le MJ l'a.
 */
async function quiEstQuoi() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    /* SUR LA PARTIE OÙ L'ON EST MJ : c'est le seul client où la règle se voit. */
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 50))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(15000);

    /* ON ÉTEINT LE MODULE : sinon on lit NOS zéros et non ceux de Roll20. */
    await driver.executeScript(
      "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
      " type: 'horspage', actif: false }, location.origin);");
    await dors(3000);

    const l = await driver.executeScript([
      "var S = window.MeshScene, out = [];",
      "function decris(m, source) {",
      "  var b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (!b) { return; }",
      "  out.push({",
      "    nom: String(m.name || '').slice(0, 56),",
      "    w: b.w, z: b.z,",
      "    source: source ? String(source.name || '').slice(0, 56) : null,",
      "    parent: m.parent ? String(m.parent.name || '').slice(0, 56) : null,",
      "    groupe: m.renderingGroupId,",
      "    couches: m.layerMask,",
      "    /* Tout ce que Roll20 aurait pu accrocher au maillage. */",
      "    metadata: m.metadata ? JSON.stringify(m.metadata).slice(0, 200) : null,",
      "    metaSource: (source && source.metadata) ? JSON.stringify(source.metadata).slice(0, 200) : null,",
      "    /* Et les autres attributs d'instance, qui portent peut-être la réponse. */",
      "    attributs: m.instancedBuffers ? Object.keys(m.instancedBuffers).join(',') : null,",
      "    gridAlign: (m.instancedBuffers && m.instancedBuffers.u_GridAlign !== undefined)",
      "      ? m.instancedBuffers.u_GridAlign : null",
      "  });",
      "}",
      "S.meshes.forEach(function (m) {",
      "  decris(m, null);",
      "  (m.instances || []).forEach(function (i) { decris(i, m); });",
      "});",
      "return { gmMode: S.metadata ? !!S.metadata.gmMode : null, l: out };"
    ].join("\n"));

    console.log("\n  gmMode : " + l.gmMode + "   " + l.l.length + " tampons\n");
    const un = l.l.filter(function (m) { return m.w === 1; });
    const zero = l.l.filter(function (m) { return m.w !== 1; });

    function montre(titre, groupe) {
      console.log("  -- " + titre + " (" + groupe.length + ") --");
      groupe.slice(0, 6).forEach(function (m) {
        console.log("    " + m.nom);
        console.log("      source   " + m.source);
        console.log("      parent   " + m.parent + "   groupe " + m.groupe +
          "   masque " + m.couches + "   gridAlign " + m.gridAlign);
        console.log("      attributs " + m.attributs);
        if (m.metadata) { console.log("      meta     " + m.metadata); }
        if (m.metaSource) { console.log("      metaSrc  " + m.metaSource); }
      });
      if (groupe.length > 6) { console.log("    … et " + (groupe.length - 6) + " autres"); }
      console.log("");
    }
    montre("w = 1   (Roll20 laisse le test s'exécuter)", un);
    montre("w = 0   (Roll20 saute le test)", zero);

    /* ---------- QUELLE PROPRIÉTÉ SÉPARE EXACTEMENT LES DEUX ? ---------- */
    console.log("  -- CE QUI SÉPARE LES DEUX GROUPES --");
    const champs = ["source", "parent", "groupe", "couches", "gridAlign"];
    champs.forEach(function (c) {
      const a = new Set(un.map(function (m) { return String(m[c]); }));
      const b = new Set(zero.map(function (m) { return String(m[c]); }));
      const commun = [...a].filter(function (v) { return b.has(v); });
      console.log("    " + c.padEnd(10) +
        "  w=1 : " + [...a].slice(0, 3).map(function (v) { return v.slice(0, 30); }).join(" | ") +
        "   ||   w=0 : " + [...b].slice(0, 3).map(function (v) { return v.slice(0, 30); }).join(" | ") +
        (commun.length ? "   ← SE CHEVAUCHENT" : "   ← SÉPARE"));
    });

    /* Et le nom de la source, décortiqué : c'est là qu'on a déjà lu « objects ». */
    console.log("\n  -- LA COUCHE, LUE DANS LE NOM DE LA SOURCE --");
    const parCouche = {};
    l.l.forEach(function (m) {
      const n = String(m.source || m.nom);
      const c = (n.match(/instance-\d+-([a-z]+)/) || [])[1] || "(illisible)";
      parCouche[c] = parCouche[c] || { w1: 0, w0: 0 };
      if (m.w === 1) { parCouche[c].w1++; } else { parCouche[c].w0++; }
    });
    Object.keys(parCouche).forEach(function (c) {
      console.log("    couche « " + c + " »   w=1 : " + parCouche[c].w1 +
        "   w=0 : " + parCouche[c].w0);
    });

    await driver.executeScript(
      "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
      " type: 'horspage', actif: true }, location.origin);");
    releve("quiquoi-mj.json", l);
    return 0;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}


/* ---------- LA CHAÎNE D'ASCENDANCE D'UN TAMPON ----------
 *
 * Chez le MJ, Roll20 met w = 1 aux maillages de la couche CARTE et w = 0 à ceux
 * de la couche des jetons. Pour reproduire sa règle au lieu de l'écraser, il
 * faut savoir à quoi se raccrocher : le nom de la source suffit-il, ou faut-il
 * remonter les parents ? On relève la chaîne entière, et on regarde.
 */
async function chaineDuTampon() {
  const quelle = (process.argv[3] || "mj").toLowerCase();
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    const id = quelle === "mj" ? partieDEssai("mj") : partieDEssai("joueur");
    if (!(await vaALaPartie(driver, id))) { return 1; }
    if (!(await attendPont(driver, 50))) { return 1; }
    await dors(15000);
    /* LE MODULE ÉTEINT : sinon on lit NOS zéros et non ceux de Roll20. */
    await driver.executeScript(
      "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
      " type: 'horspage', actif: false }, location.origin);");
    await dors(3000);
    const l = await driver.executeScript([
      "var S = window.MeshScene, out = [];",
      "function chaine(m) {",
      "  var c = [], n = m, k = 0;",
      "  while (n && k < 8) { c.push(String(n.name || '?').slice(0, 40)); n = n.parent; k++; }",
      "  return c;",
      "}",
      "function decris(m, src) {",
      "  var b = m && m.instancedBuffers && m.instancedBuffers.u_Board;",
      "  if (!b) { return; }",
      "  out.push({ w: b.w, chaine: chaine(m),",
      "    src: src ? String(src.name || '').slice(0, 40) : null });",
      "}",
      "S.meshes.forEach(function (m) {",
      "  decris(m, null);",
      "  (m.instances || []).forEach(function (i) { decris(i, m); });",
      "});",
      "return out;"
    ].join("\n"));
    console.log("\n  " + l.length + " tampons\n");
    l.forEach(function (m) {
      console.log("  w=" + m.w + "   " + m.chaine.join("  <  "));
      if (m.src) { console.log("        source : " + m.src); }
    });
    releve("chaine-" + quelle + ".json", l);
    await driver.executeScript(
      "window.top.postMessage({ ns: 'vttinker', depuis: 'contenu'," +
      " type: 'horspage', actif: true }, location.origin);");
    return 0;
  } finally { await dors(600); await driver.quit().catch(() => {}); }
}

/* ---------- reconnaissance ---------- */































async function recon() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) {
      console.log("Le pont ne s'est pas injecté. Journal de l'extension :");
      console.log(await journalDe(driver));
      return 1;
    }
    const brut = await driver.executeScript("return __vttinkerRecon();");
    releve("recon.json", JSON.parse(brut));
    releve("journal.txt", (await journalDe(driver)).join("\n"));
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

async function journalDe(driver) {
  return await driver.executeScript("return (window.__vttinkerJournal || []).slice();").catch(() => []);
}

/* ---------- code libre ---------- */
async function js(code) {
  if (!code) { console.log("Il faut du code : node outils/pilote.js js \"return 1+1\""); return 1; }
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    await vaALaPartie(driver);
    await attendPont(driver, 30);
    const r = await driver.executeScript(/^\s*return\b/.test(code) ? code : "return (" + code + ");");
    releve("js.json", r === undefined ? "undefined" : r);
    console.log(typeof r === "string" ? r.slice(0, 2000) : JSON.stringify(r, null, 2).slice(0, 2000));
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- le journal seul ---------- */
async function journal() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    await vaALaPartie(driver);
    await dors(4000);
    const j = await journalDe(driver);
    console.log(j.length ? j.join("\n") : "(journal vide — l'extension n'a rien dit)");
    releve("journal.txt", j.join("\n"));
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- l'essai du zoom SUR LA VRAIE PARTIE ----------
 * C'est le pendant de outils/verifie.js : le même scénario, mais contre le vrai
 * Roll20 au lieu d'un modèle. Le modèle dit que la logique est juste ; celui-ci
 * dit qu'elle l'est CHEZ EUX, ce qu'aucun modèle ne peut promettre.
 *
 * IL REMET LE ZOOM DE DÉPART, en dernier et quoi qu'il arrive. */
async function zoom() {
  const driver = await ouvre(config().visible === true);
  const pas = [];
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }

    const lis = async (etiquette) => {
      const o = await driver.executeScript(
        "var r = __vttinkerRecon && JSON.parse(__vttinkerRecon()); return r && r.etatZoom;");
      pas.push(Object.assign({ etape: etiquette }, o));
      console.log("  " + etiquette + " → zoom " + (o && o.pinia_engine_zoom) +
                  " %, orthoTop " + (o && o.camera && Math.round(o.camera.orthoTop)));
      return o;
    };

    const depart = (await lis("départ")).pinia_engine_zoom;

    /* LA COMMANDE DE ROLL20 DOIT ÊTRE VISIBLE AU DÉPART, et le module doit
     * avoir eu le temps d'y prendre modèle : c'est sur elle qu'il clone ses
     * boutons, et une fois masquée il n'y a plus rien à cloner. Une exécution
     * précédente a pu la laisser masquée.
     *
     * On ATTEND qu'il dise l'avoir prise, au lieu de compter les secondes — et
     * on n'installe qu'ensuite. Dans l'autre ordre, le module finissait par
     * envoyer SES bornes (celles du stockage, 10–250) par-dessus les nôtres, et
     * tout se défaisait : commande absente, zoom bloqué à 250. */
    console.log("\n  on rend sa commande visible, et on attend que le module en prenne modèle");
    await driver.executeScript(MAGASIN +
      "var p = __mag('preference'); if (!p.zoom.interfaceEnabled) { p.toggleZoomInterfaceEnabled(); }");
    const t0 = Date.now();
    let pris = false;
    while (Date.now() - t0 < 20000 && !pris) {
      await dors(700);
      pris = (await journalDe(driver)).some(function (l) { return /modèle pris/.test(l); });
    }
    console.log("      modèle " + (pris ? "pris" : "NON pris — on continue, repli attendu"));

    console.log("\n  bornes élargies à 2–600 %, contrôle de Roll20 masqué");
    await driver.executeScript(
      "window.postMessage({ns:'vttinker',depuis:'contenu',type:'zoom',actif:true,min:2,max:600}, '*');");
    /* Basculer le contrôle de Roll20 remet le zoom à 100 %, et cette remise
     * arrive APRÈS coup. Sans une attente franche, elle retombait au milieu de
     * l'essai suivant et en faussait le résultat — deux fois sur trois. Trois
     * secondes : ce n'est pas le produit qui est lent, c'est l'essai qui doit
     * attendre que Roll20 ait fini de réagir. */
    await dors(3000);

    /* LA COMMANDE DESSINÉE PAR L'EXTENSION. Elle remplace celle que le
     * masquage vient de retirer : si elle n'est pas là, on a pris un glisseur
     * à quelqu'un sans rien lui rendre. */
    console.log("\n  la commande de l'extension");
    const cmd = await driver.executeScript(
      "var b = document.querySelector('.vttk-zoom');" +
      "if (!b) { return { la: false }; }" +
      "var r = b.getBoundingClientRect();" +
      "return { la: true, flottante: b.classList.contains('vttk-zoom-flottant')," +
      " hote: b.parentElement ? (b.parentElement.className || b.parentElement.id || b.parentElement.tagName) : '?'," +
      " x: Math.round(r.left), y: Math.round(r.top), l: Math.round(r.width), h: Math.round(r.height)," +
      " valeur: (b.querySelector('.vttk-zoom-v') || {}).value," +
      " caseGeo: (function () { var v = b.querySelector('.vttk-zoom-v'); if (!v) { return null; }" +
      "   var y = getComputedStyle(v), e = v.parentElement, ye = getComputedStyle(e);" +
      "   return { l: Math.round(v.getBoundingClientRect().width * 10) / 10," +
      "     deborde: v.scrollWidth + '>' + v.clientWidth," +
      "     police: y.fontSize + '/' + y.fontWeight + ' ' + y.fontFamily.split(',')[0]," +
      "     pad: y.padding, boite: y.boxSizing," +
      "     ecrin: e.className.slice(0, 30) + ' ' + Math.round(e.getBoundingClientRect().width) +" +
      "            'px pad=' + ye.padding + ' min=' + ye.minWidth }; })()," +
      " boutons: b.querySelectorAll('button[title]').length," +
      " clones: b.querySelectorAll('.vttk-zoom-natif').length," +
      " glyphes: [].slice.call(b.querySelectorAll('.grimoire__roll20-icon'))" +
      "            .map(function (s) { return (s.textContent || '').trim(); }) };");
    if (!cmd.la) { console.log("      ABSENTE"); }
    else {
      console.log("      posée dans « " + cmd.hote + " »" + (cmd.flottante ? " (flottante)" : "") +
                  " — " + cmd.l + "×" + cmd.h + " en (" + cmd.x + ", " + cmd.y + ")");
      /* L'ORDRE DES ENFANTS, mesuré et non lu sur une capture de trente pixels
       * de large. C'est le seul moyen de savoir si l'on s'est bien glissé entre
       * l'oeil et la mire, ou si l'on a repoussé la mire vers le haut. */
      const rang = await driver.executeScript(
        "var pc = document.querySelector('#vm_zoom_buttons .parentContainer');" +
        "if (!pc) { return []; }" +
        "return [].slice.call(pc.children).map(function (n, i) {" +
        "  var r = n.getBoundingClientRect();" +
        "  var ic = n.querySelector('.grimoire__roll20-icon, svg');" +
        "  return { i: i, quoi: String(n.className || '').indexOf('vttk-zoom') >= 0 ? 'NOTRE COLONNE'" +
        "    : (n.tagName.toLowerCase() + ' ' + ((ic && ic.textContent) || 'icône')).trim()," +
        "    y: Math.round(r.top), h: Math.round(r.height) };" +
        "});");
      console.log("      ordre dans sa colonne :");
      rang.forEach(function (n) {
        console.log("        " + n.i + ". " + n.quoi.padEnd(16) + " y=" + String(n.y).padStart(4) + "  h=" + n.h);
      });
      console.log("      valeur affichée : " + cmd.valeur + " %, " + cmd.boutons + " boutons, " +
                  cmd.clones + " clonés de Roll20, glyphes " + JSON.stringify(cmd.glyphes));
      if (cmd.caseGeo) {
        console.log("      case : " + cmd.caseGeo.l + "px  " + cmd.caseGeo.police +
                    "  pad=" + cmd.caseGeo.pad + "  " + cmd.caseGeo.boite +
                    "  déborde " + cmd.caseGeo.deborde);
        console.log("      écrin : " + cmd.caseGeo.ecrin);
      }
      // On clique SON bouton +, pas celui de Roll20 : c'est elle qu'on éprouve.
      await driver.executeScript(MAGASIN + "__mag('engine').setZoom(250);");
      await dors(500);
      /* Par l'infobulle, jamais par le rang ni par la classe : le rang a changé
       * quand la barre est passée à la verticale, la classe quand les boutons
       * sont devenus des clones de Roll20. L'infobulle, elle, dit le RÔLE. */
      await driver.executeScript(
        "var b = document.querySelector('.vttk-zoom button[title=\"Zoomer\"]');" +
        "for (var i = 0; i < 3; i++) { b.click(); }");
      await dors(900);
      const apres = await driver.executeScript(MAGASIN +
        "return { zoom: __mag('engine').zoom, affiche: (document.querySelector('.vttk-zoom-v')||{}).value };");
      console.log("      trois clics sur SON + depuis 250 → " + apres.zoom + " %" +
                  ", elle affiche " + apres.affiche);
      pas.push({ etape: "commande de l'extension", commande: cmd, apres: apres });
      await capture(driver, "commande.png");
    }

    console.log("\n  boutons + au-delà de 250 %");
    await driver.executeScript(MAGASIN +
      "var a=__mag('engine'); a.setZoom(250); for (var i=0;i<4;i++) { a.stepAdjustZoom(true); }");
    await dors(900);
    await lis("après quatre + depuis 250");
    await capture(driver, "zoom-haut.png");

    console.log("\n  molette au-delà de 250 %");
    await driver.executeScript(MAGASIN +
      "var a=__mag('engine'); a.setZoom(250);" +
      "var c=document.getElementById('babylonCanvas');" +
      "for (var i=0;i<4;i++) { c.dispatchEvent(new WheelEvent('wheel',{deltaY:-102,bubbles:true,cancelable:true})); }");
    await dors(900);
    await lis("après quatre crans de molette depuis 250");

    console.log("\n  boutons − sous 10 %");
    await driver.executeScript(MAGASIN +
      "var a=__mag('engine'); a.setZoom(10); for (var i=0;i<5;i++) { a.stepAdjustZoom(false); }");
    await dors(900);
    await lis("après cinq − depuis 10");
    await capture(driver, "zoom-bas.png");

    console.log("\n  extinction du module");
    await driver.executeScript(
      "window.postMessage({ns:'vttinker',depuis:'contenu',type:'zoom',actif:false}, '*');");
    await dors(800);
    await lis("après extinction");

    // Remise en état, quoi qu'il soit arrivé plus haut.
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(" + depart + ");");
    await dors(500);
    await lis("remis au départ");

    releve("zoom.json", { depart, pas });
    releve("journal.txt", (await journalDe(driver)).join("\n"));
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- le slider, et ce qu'il coûte de le masquer ----------
 *
 * Le contrôle de zoom de Roll20 est un el-slider borné à 0-100 — une échelle
 * normalisée, pas des pourcentages. Il surveille l'état et le repousse dans sa
 * plage, ce qui neutralise le module dans les DEUX sens. La question n'est donc
 * plus « faut-il prévenir ? » mais « que perd-on à le masquer ? ».
 *
 * L'expérience mesure les deux mondes côte à côte et REMET tout : le réglage du
 * contrôle comme le zoom de départ. */
async function slider() {
  const driver = await ouvre(config().visible === true);
  const res = { pas: [] };
  const mesure = async (etiquette) => {
    const o = await driver.executeScript(MAGASIN +
      "var e=__mag('engine'), p=__mag('preference');" +
      "var b=document.getElementById('vm_zoom_buttons');" +
      "var c=(window.MeshScene&&window.MeshScene.cameras||[]).filter(function(x){return x.name==='vtt-main-camera';})[0];" +
      "return { zoom:e.zoom, orthoTop:c?c.orthoTop:null, interfaceEnabled:p.zoom.interfaceEnabled," +
      " boite: !!b, boiteVisible: !!(b && b.offsetWidth)," +
      " boutons: b ? b.querySelectorAll('button').length : 0," +
      " sliders: document.querySelectorAll('.el-slider').length };");
    res.pas.push(Object.assign({ etape: etiquette }, o));
    console.log("  " + etiquette);
    console.log("      zoom " + o.zoom + " %  |  contrôle " + (o.interfaceEnabled ? "affiché" : "masqué") +
                "  |  boîte " + (o.boiteVisible ? "visible" : (o.boite ? "présente mais invisible" : "absente")) +
                "  |  " + o.boutons + " boutons, " + o.sliders + " slider(s)");
    return o;
  };
  const pousse = async (depuis, n) => {
    await driver.executeScript(MAGASIN +
      "var a=__mag('engine'); a.setZoom(" + depuis + "); for (var i=0;i<" + n + ";i++) { a.stepAdjustZoom(true); }");
    await dors(900);
  };

  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }

    const depart = await mesure("départ");
    console.log("\n  bornes élargies à 2–600 %");
    await driver.executeScript("window.postMessage({ns:'vttinker',depuis:'contenu',type:'zoom',actif:true,min:2,max:600}, '*');");
    await dors(600);

    console.log("\n— CONTRÔLE AFFICHÉ —");
    await pousse(250, 3);
    await mesure("trois + depuis 250, contrôle affiché");

    console.log("\n— CONTRÔLE MASQUÉ —");
    await driver.executeScript(MAGASIN +
      "var p=__mag('preference'); if (p.zoom.interfaceEnabled) { p.toggleZoomInterfaceEnabled(); }");
    await dors(1200);
    await mesure("juste après avoir masqué le contrôle");

    // PAS À PAS, et non trois d'un coup : un enchaînement qui finit ailleurs
    // que prévu ne dit pas OÙ il a dévié. Chaque appui est mesuré seul.
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(250);");
    await dors(600);
    await mesure("posé à 250, contrôle masqué");
    for (let i = 1; i <= 4; i++) {
      await driver.executeScript(MAGASIN + "__mag('engine').stepAdjustZoom(true);");
      await dors(700);
      await mesure("appui + n° " + i);
    }
    await capture(driver, "slider-masque.png");

    // Ce que le pont croit avoir posé, contre ce que Roll20 en a fait.
    const dedans = await driver.executeScript(MAGASIN +
      "var e=__mag('engine');" +
      "return { setZoomRemplace: String(e.setZoom).indexOf('pose') >= 0," +
      "         stepRemplace: String(e.stepAdjustZoom).indexOf('pose') >= 0," +
      "         journal: (window.__vttinkerJournal||[]).slice(-6) };");
    res.dedans = dedans;
    console.log("\n  setZoom remplacé : " + dedans.setZoomRemplace +
                "  |  stepAdjustZoom remplacé : " + dedans.stepRemplace);

    // Remise en état : le réglage d'abord, le zoom ensuite.
    console.log("\n  remise en état");
    if (depart.interfaceEnabled) {
      await driver.executeScript(MAGASIN +
        "var p=__mag('preference'); if (!p.zoom.interfaceEnabled) { p.toggleZoomInterfaceEnabled(); }");
      await dors(800);
    }
    await driver.executeScript("window.postMessage({ns:'vttinker',depuis:'contenu',type:'zoom',actif:false}, '*');");
    await dors(500);
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(" + depart.zoom + ");");
    await dors(500);
    await mesure("remis au départ");

    releve("slider.json", res);
    releve("journal.txt", (await journalDe(driver)).join("\n"));
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LE VRAI CHEMIN, celui que l'utilisateur emprunte ----------
 *
 * Les essais précédents postaient le message d'installation directement au
 * pont. Ils prouvaient que le PONT marche, et rien d'autre : le panneau, le
 * stockage et le module n'étaient jamais mis à l'épreuve. C'est exactement le
 * genre d'essai qui rassure à tort.
 *
 * Ici on passe par où passe un joueur : on ouvre la page du panneau — une page
 * de l'extension, donc browser.storage.local y est réellement disponible —, on
 * y écrit les réglages comme un clic le ferait, puis on retourne dans la partie
 * regarder ce qui s'est passé. Rien n'est simulé.
 *
 * L'adresse de la page du panneau porte un identifiant tiré au hasard à chaque
 * installation temporaire. On le retrouve dans les ressources chargées par la
 * page : le pont a été injecté depuis moz-extension://<identifiant>/page/pont.js
 * et l'entrée de performance en garde la trace. */
async function reglages() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }

    /* OUVRIR LA PAGE DU PANNEAU. driver.get() la refuse : WebDriver interdit de
     * naviguer ailleurs que sur http(s) depuis le contexte de contenu. On passe
     * donc par le contexte PRIVILÉGIÉ de Firefox — celui de son interface — le
     * temps d'ouvrir un onglet, puis on revient au contenu pour travailler
     * dedans normalement. C'est la voie prévue pour ça, et elle ne touche ni le
     * produit ni la page. */
    console.log("  panneau à " + BASE_EXT + "popup/popup.html");
    const ongletsAvant = await driver.getAllWindowHandles();
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript("openTrustedLinkIn(arguments[0], 'tab');", BASE_EXT + "popup/popup.html");
    await driver.setContext(firefox.Context.CONTENT);
    await dors(1200);
    const ongletsApres = await driver.getAllWindowHandles();
    const neuf = ongletsApres.find(function (h) { return ongletsAvant.indexOf(h) < 0; });
    if (!neuf) { console.log("L'onglet du panneau ne s'est pas ouvert."); return 1; }
    await driver.switchTo().window(neuf);
    await dors(900);
    const vu = await driver.executeScript(
      "return { titres: [].slice.call(document.querySelectorAll('.carte-titre')).map(function (n) { return n.textContent; })," +
      " lignes: [].slice.call(document.querySelectorAll('.ligne')).map(function (n) {" +
      "   var l = n.querySelector('label,.lib'), i = n.querySelector('input'), s = n.querySelector('.sw');" +
      "   return { libelle: l ? l.textContent : '?', valeur: i ? i.value : (s ? s.getAttribute('aria-checked') : '?') }; })," +
      " avis: [].slice.call(document.querySelectorAll('.avis-module')).map(function (n) { return n.hidden ? '(masqué)' : n.textContent; }) };");
    console.log("\n  PANNEAU — " + vu.titres.join(", "));
    vu.lignes.forEach(function (l) { console.log("      " + l.libelle + " = " + l.valeur); });
    console.log("      avis : " + JSON.stringify(vu.avis));

    /* On écrit par browser.storage.local, dans la page du panneau — c'est
     * exactement ce que fait un clic, à l'événement près. En asynchrone :
     * executeScript n'attend pas les promesses et rendrait l'objet Promise. */
    console.log("\n  écriture des réglages par browser.storage.local (le vrai chemin)");
    const stock = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1];" +
      "browser.storage.local.set({ 'reg:zoomMin': 2, 'reg:zoomMax': 600 })" +
      "  .then(function () { return browser.storage.local.get(null); })" +
      "  .then(cb, function (e) { cb('ERREUR ' + String(e)); });");
    console.log("      stockage : " + JSON.stringify(stock));

    // --- retour dans la partie, SANS rien poster nous-mêmes ---
    console.log("\n  retour dans l'onglet de la partie (aucun message posté par le pilote)");
    await driver.close();                       // on referme le panneau
    await driver.switchTo().window(ongletsAvant[0]);
    await driver.navigate().refresh();          // la partie se recharge avec les réglages posés
    await vaALaPartie(driver);
    await attendPont(driver, 30);
    await dors(2500);

    const apres = await driver.executeScript(MAGASIN +
      "var e = __mag('engine'), p = __mag('preference');" +
      "return { zoom: e.zoom, controleAffiche: p.zoom.interfaceEnabled," +
      " setZoomRemplace: String(e.setZoom).indexOf('pose') >= 0," +
      " journal: (window.__vttinkerJournal || []).slice() };");
    console.log("      contrôle de Roll20 : " + (apres.controleAffiche ? "AFFICHÉ" : "masqué"));
    console.log("      setZoom remplacé   : " + apres.setZoomRemplace);
    console.log("      journal de l'extension :");
    apres.journal.forEach(function (l) { console.log("        · " + l); });

    // --- et on essaie de dépasser, par les boutons ---
    await driver.executeScript(MAGASIN +
      "var a = __mag('engine'); a.setZoom(250); for (var i = 0; i < 3; i++) { a.stepAdjustZoom(true); }");
    await dors(900);
    const fin = await driver.executeScript(MAGASIN + "return __mag('engine').zoom;");
    console.log("\n      trois + depuis 250 → " + fin + " %   " + (fin > 250 ? "✔ ça passe" : "✘ bloqué"));

    releve("reglages.json", { panneau: vu, stock, apres, zoomFinal: fin });
    return fin > 250 ? 0 : 1;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LA COMMANDE NATIVE, MESURÉE ----------
 *
 * Pour ressembler à celle de Roll20, il faut d'abord la MESURER — pas la
 * regarder et choisir des tailles au jugé, ce qui a déjà donné une colonne deux
 * fois trop courte. On rétablit son contrôle de zoom, on laisse Vue redessiner,
 * et on relève chaque élément : taille, police, couleur, arrondi, espacement.
 *
 * Basculer le réglage et mesurer dans la même foulée ne marche pas : la
 * bascule est réactive, le rendu vient au tour suivant, et on relève l'état
 * d'avant. C'est arrivé, et le relevé annonçait deux boutons au lieu de cinq. */
async function natif() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await attendPont(driver, 30);

    await driver.executeScript(MAGASIN +
      "var p = __mag('preference'); if (!p.zoom.interfaceEnabled) { p.toggleZoomInterfaceEnabled(); }");
    await dors(2500);   // Vue redessine au tour suivant, pas dans la foulée

    const arbre = await driver.executeScript(
      "var z = document.getElementById('vm_zoom_buttons'); if (!z) { return []; }" +
      "var out = [];" +
      "(function marche(n, prof) {" +
      "  if (prof > 7) { return; }" +
      "  var r = n.getBoundingClientRect(), c = getComputedStyle(n);" +
      "  out.push({ prof: prof, tag: n.tagName.toLowerCase()," +
      "    cls: String(n.className || '').replace(/\\[object.*/, '').slice(0, 44)," +
      "    txt: n.children.length ? '' : (n.textContent || '').trim().slice(0, 10)," +
      "    l: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10," +
      "    police: c.fontSize + ' ' + c.fontWeight, couleur: c.color, fond: c.backgroundColor," +
      "    bord: c.borderWidth + ' ' + c.borderColor, rayon: c.borderRadius," +
      "    pad: c.padding, marge: c.margin, gap: c.gap, sens: c.flexDirection });" +
      "  [].slice.call(n.children).forEach(function (e) { marche(e, prof + 1); });" +
      "})(z, 0); return out;");

    console.log("\n  LA COMMANDE NATIVE DE ROLL20 — " + arbre.length + " éléments\n");
    arbre.forEach(function (n) {
      const nom = " ".repeat(n.prof * 2) + n.tag + (n.cls ? "." + n.cls.split(" ")[0] : "") +
                  (n.txt ? " «" + n.txt + "»" : "");
      console.log("  " + nom.padEnd(38) + " " + (n.l + "×" + n.h).padEnd(12) +
                  " pol " + n.police.padEnd(9) + " fond " + n.fond.padEnd(24) +
                  " r " + n.rayon.padEnd(9) + " pad " + n.pad);
    });
    releve("natif.json", arbre);
    await capture(driver, "natif.png");
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LES DEUX THÈMES DE SA COMMANDE ----------
 *
 * Roll20 a un mode sombre et un mode clair, et sa commande de zoom change de
 * couleurs entre les deux. On les relève TOUTES LES DEUX plutôt que d'écrire
 * une palette de mémoire : le mode sombre a été signalé comme fautif, et on ne
 * corrige pas un défaut de couleur au jugé.
 *
 * On relève aussi ce qui, dans la page, DIT le thème : sans ce signe, notre
 * feuille de style ne peut pas suivre. */
async function themes() {
  const driver = await ouvre(config().visible === true);
  const out = {};
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await attendPont(driver, 30);

    for (const t of ["dark", "light"]) {
      await driver.executeScript(MAGASIN +
        "var p = __mag('preference');" +
        "if (typeof p.setColorTheme === 'function') { p.setColorTheme('" + t + "'); }" +
        "if (!p.zoom.interfaceEnabled) { p.toggleZoomInterfaceEnabled(); }");
      await dors(2500);

      out[t] = await driver.executeScript(
        "var res = { theme: '" + t + "' };" +
        "function fiche(s) { var n = document.querySelector(s); if (!n) { return null; }" +
        "  var y = getComputedStyle(n), r = n.getBoundingClientRect();" +
        "  return { l: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10," +
        "    couleur: y.color, fond: y.backgroundColor," +
        "    bord: y.borderWidth + ' ' + y.borderStyle + ' ' + y.borderColor," +
        "    police: y.fontFamily.split(',')[0] + ' ' + y.fontSize + '/' + y.fontWeight," +
        "    opacite: y.opacity, ombre: y.boxShadow.slice(0, 60) }; }" +
        "res.panneau  = fiche('#vm_zoom_buttons .parentContainer');" +
        "res.bouton   = fiche('#vm_zoom_buttons .zoomButtonsInner button');" +
        "res.icone    = fiche('#vm_zoom_buttons .grimoire__roll20-icon');" +
        "res.valeur   = fiche('#vm_zoom_buttons .zoomButtonsInner button:nth-of-type(2) span');" +
        "res.piste    = fiche('#vm_zoom_buttons .el-slider__runway');" +
        "res.rempli   = fiche('#vm_zoom_buttons .el-slider__bar');" +
        "res.curseur  = fiche('#vm_zoom_buttons .el-slider__button');" +
        "var ic = document.querySelector('#vm_zoom_buttons .grimoire__roll20-icon');" +
        "res.iconeTexte = ic ? (ic.textContent || '').trim() : null;" +
        "res.iconeAttrs = ic ? [].slice.call(ic.attributes).map(function (a) { return a.name + (a.value ? '=' + a.value.slice(0, 20) : ''); }) : [];" +
        "res.racine = { cls: String(document.documentElement.className).slice(0, 80)," +
        "  attrs: [].slice.call(document.documentElement.attributes).map(function (a) { return a.name + '=' + String(a.value).slice(0, 24); }) };" +
        "res.corps = { cls: String(document.body.className).slice(0, 100)," +
        "  attrs: [].slice.call(document.body.attributes).map(function (a) { return a.name + '=' + String(a.value).slice(0, 24); }) };" +
        "return res;");

      console.log("\n  ===== THÈME " + t.toUpperCase() + " =====");
      ["panneau", "bouton", "icone", "valeur", "piste", "rempli", "curseur"].forEach(function (k) {
        const f = out[t][k];
        console.log("  " + k.padEnd(9) + " " + (f ? (f.l + "×" + f.h).padEnd(11) + " coul " + f.couleur.padEnd(22) +
          " fond " + f.fond.padEnd(24) + " bord " + f.bord : "(absent)"));
      });
      console.log("  icône      texte «" + out[t].iconeTexte + "»  " + out[t].iconeAttrs.join(" "));
      console.log("  police     " + (out[t].icone ? out[t].icone.police : "?"));
      console.log("  <html>     " + out[t].racine.attrs.join("  "));
      console.log("  <body>     " + out[t].corps.attrs.join("  "));
      await capture(driver, "natif-" + t + ".png");
    }
    releve("themes.json", out);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LES DEUX COMMANDES, CÔTE À CÔTE ----------
 *
 * Une capture d'écran entière ne sert à rien pour juger d'un élément de trente
 * pixels de large : j'y ai lu « 28 » pour « 281 » et corrigé deux fois dans le
 * vide. Selenium sait photographier UN élément ; on prend donc la sienne, puis
 * la nôtre, chacune seule et à sa taille, et on mesure ce qui les sépare. */
async function compare() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await attendPont(driver, 30);

    const mesures = async (racine) => await driver.executeScript(
      "var r = document.querySelector(arguments[0]); if (!r) { return null; }" +
      "function f(n) { if (!n) { return null; } var y = getComputedStyle(n), b = n.getBoundingClientRect();" +
      "  return { l: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10," +
      "    police: y.fontFamily.split(',')[0] + ' ' + y.fontSize + '/' + y.fontWeight," +
      "    couleur: y.color, fond: y.backgroundColor," +
      "    bord: y.borderWidth + ' ' + y.borderStyle + ' ' + y.borderColor }; }" +
      "return { icone: f(r.querySelector('.grimoire__roll20-icon'))," +
      "  boutonIcone: f((r.querySelector('.grimoire__roll20-icon') || {}).closest ?" +
      "    r.querySelector('.grimoire__roll20-icon').closest('button') : null)," +
      "  piste: f(r.querySelector('.el-slider__runway') || r.querySelector('input[type=range]'))," +
      "  curseur: f(r.querySelector('.el-slider__button')) };", racine);

    const photo = async (sel, nom) => {
      try {
        const e = await driver.findElement(By.css(sel));
        const png = await e.takeScreenshot();
        fs.mkdirSync(RELEVES, { recursive: true });
        fs.writeFileSync(path.join(RELEVES, nom), Buffer.from(png, "base64"));
        console.log("      photo : " + nom);
      } catch (e) { console.log("      photo impossible (" + sel + ") : " + e.message.slice(0, 60)); }
    };

    // --- la sienne ---
    await driver.executeScript(MAGASIN +
      "var p = __mag('preference'); if (!p.zoom.interfaceEnabled) { p.toggleZoomInterfaceEnabled(); }");
    await dors(2500);
    const sien = await mesures("#vm_zoom_buttons .zoomButtonsInner");
    console.log("\n  ===== LA SIENNE =====");
    ["icone", "boutonIcone", "piste", "curseur"].forEach(function (k) {
      const f = sien && sien[k];
      console.log("  " + k.padEnd(12) + (f ? (f.l + "×" + f.h).padEnd(11) + " " + f.police.padEnd(26) +
        " fond " + f.fond.padEnd(24) + " bord " + f.bord : "(absent)"));
    });
    await photo("#vm_zoom_buttons .zoomButtonsInner", "cmp-roll20.png");

    // --- la nôtre ---
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if ((await journalDe(driver)).some((l) => /modèle pris/.test(l))) { break; }
      await dors(700);
    }
    await driver.executeScript(
      "window.postMessage({ns:'vttinker',depuis:'contenu',type:'zoom',actif:true,min:2,max:600}, '*');");
    await dors(2500);
    const notre = await mesures(".vttk-zoom");
    console.log("\n  ===== LA NÔTRE =====");
    ["icone", "boutonIcone", "piste", "curseur"].forEach(function (k) {
      const f = notre && notre[k];
      console.log("  " + k.padEnd(12) + (f ? (f.l + "×" + f.h).padEnd(11) + " " + f.police.padEnd(26) +
        " fond " + f.fond.padEnd(24) + " bord " + f.bord : "(absent)"));
    });
    await photo(".vttk-zoom", "cmp-vttinker.png");

    // Ce que contient VRAIMENT notre case de valeur — une marque de deux pixels
    // ne se juge pas à l'oeil sur une photo de trente pixels de large.
    const ecrin = await driver.executeScript(
      "var e = document.querySelector('.vttk-zoom-ecrin'); if (!e) { return null; }" +
      "var v = e.querySelector('input'), y = v ? getComputedStyle(v) : null;" +
      "return { html: e.outerHTML.slice(0, 300), enfants: e.children.length," +
      "  champ: y ? { h: Math.round(v.getBoundingClientRect().height)," +
      "    bord: y.borderWidth + ' ' + y.borderColor, ligne: y.lineHeight," +
      "    type: v.type, apparence: y.appearance || y.MozAppearance } : null };");
    if (ecrin) {
      console.log("\n  ÉCRIN : " + ecrin.enfants + " enfant(s), champ " + JSON.stringify(ecrin.champ));
      console.log("  " + ecrin.html.replace(/\s+/g, " "));
    }

    releve("compare.json", { sien, notre });
    // On rend sa commande avant de partir.
    await driver.executeScript(
      "window.postMessage({ns:'vttinker',depuis:'contenu',type:'zoom',actif:false}, '*');");
    await dors(600);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LA SCÈNE BABYLON ----------
 *
 * La table de Roll20 est rendue par Babylon.js dans un seul canevas WebGL2, et
 * window.MeshScene est sa Scene. Avant de décider ce qu'on peut y faire, on
 * regarde ce qu'elle contient : ses maillages, ses matériaux, ses calques, sa
 * boucle de rendu, et par quoi un marqueur y est représenté.
 *
 * Lecture seule, comme toute reconnaissance. */
async function canvasRecon() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3000);

    const r = await driver.executeScript(
      "var S = window.MeshScene; if (!S) { return { scene: false }; }" +
      "function n(x) { return x && (x.name || x.id || '(sans nom)'); }" +
      "var eng = null; try { eng = S.getEngine(); } catch (e) {}" +
      "var maillages = (S.meshes || []).slice(0, 400);" +
      "var parNom = {};" +
      "maillages.forEach(function (m) {" +
      "  var c = String(n(m)).replace(/[0-9a-f-]{8,}/gi, '#').replace(/\\d+/g, '#');" +
      "  parNom[c] = (parNom[c] || 0) + 1; });" +
      "return {" +
      "  scene: true," +
      "  version: (window.BABYLON && window.BABYLON.Engine && window.BABYLON.Engine.Version) || (eng && eng.description) || '?'," +
      "  compte: { maillages: (S.meshes || []).length, materiaux: (S.materials || []).length," +
      "    textures: (S.textures || []).length, lumieres: (S.lights || []).length," +
      "    cameras: (S.cameras || []).length, transformNodes: (S.transformNodes || []).length," +
      "    layers: (S.layers || []).length, particules: (S.particleSystems || []).length }," +
      "  famillesDeMaillages: Object.keys(parNom).sort(function (a, b) { return parNom[b] - parNom[a]; })" +
      "      .slice(0, 25).map(function (k) { return k + ' ×' + parNom[k]; })," +
      "  exemples: maillages.slice(0, 8).map(function (m) {" +
      "    return { nom: n(m), classe: m.getClassName && m.getClassName()," +
      "      visible: m.isVisible, actif: m.isEnabled && m.isEnabled()," +
      "      pos: m.position ? [Math.round(m.position.x), Math.round(m.position.y), Math.round(m.position.z)] : null," +
      "      materiau: m.material ? n(m.material) : null," +
      "      calque: m.layerMask, metadata: m.metadata ? Object.keys(m.metadata).slice(0, 10) : null }; })," +
      "  moteur: eng ? { webgl2: !!eng.webGLVersion && eng.webGLVersion >= 2," +
      "    fps: Math.round(eng.getFps ? eng.getFps() : 0)," +
      "    largeur: eng.getRenderWidth && eng.getRenderWidth()," +
      "    hauteur: eng.getRenderHeight && eng.getRenderHeight()," +
      "    boucles: eng._activeRenderLoops ? eng._activeRenderLoops.length : null } : null," +
      "  observables: Object.keys(S).filter(function (k) { return /^on[A-Z].*Observable$/.test(k); }).slice(0, 40)," +
      "  globalesBabylon: ['BABYLON', 'MeshScene', 'MeshManager', 'GroupItems', 'material']" +
      "      .map(function (g) { return g + '=' + (typeof window[g]); })," +
      "  gestionnaire: window.MeshManager ? Object.keys(window.MeshManager).slice(0, 20) : null" +
      "};");

    if (!r.scene) { console.log("window.MeshScene absent."); return 1; }
    console.log("\n  SCÈNE BABYLON — " + JSON.stringify(r.compte));
    console.log("  moteur : " + JSON.stringify(r.moteur));
    console.log("  globales : " + r.globalesBabylon.join("  "));
    console.log("  MeshManager : " + JSON.stringify(r.gestionnaire));
    console.log("\n  FAMILLES DE MAILLAGES (nom normalisé × nombre)");
    r.famillesDeMaillages.forEach(function (f) { console.log("    " + f); });
    console.log("\n  EXEMPLES");
    r.exemples.forEach(function (m) {
      console.log("    " + String(m.nom).slice(0, 40).padEnd(42) + " " + String(m.classe).padEnd(16) +
                  " visible=" + m.visible + " calque=" + m.calque + " mat=" + String(m.materiau).slice(0, 24));
    });
    console.log("\n  OBSERVABLES DE SCÈNE : " + r.observables.length);
    releve("canvas.json", r);
    await capture(driver, "canvas.png");
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LA GRILLE ----------
 *
 * Elle s'arrête au bord de la carte, alors que l'aimantation des marqueurs, elle,
 * continue au-delà. On veut l'afficher plus loin. Avant de toucher à quoi que
 * ce soit, on relève : la géométrie du maillage, son matériau et ses réglages,
 * et ce que la page dit de sa grille. Ce sont ces chiffres qui diront s'il faut
 * agrandir le plan, changer un ratio, ou construire le nôtre. */
async function grille() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3000);

    const r = await driver.executeScript(MAGASIN +
      "var S = window.MeshScene; if (!S) { return { scene: false }; }" +
      "function trouve(n) { return (S.meshes || []).filter(function (m) { return m.name === n; })[0] || null; }" +
      "function v3(v) { return v ? [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100] : null; }" +
      "function props(o) { if (!o) { return null; }" +
      "  var out = {};" +
      "  for (var k in o) {" +
      "    if (k[0] === '_') { continue; }" +
      "    var val; try { val = o[k]; } catch (e) { continue; }" +
      "    var t = typeof val;" +
      "    if (t === 'number' || t === 'boolean' || t === 'string') { out[k] = val; }" +
      "    else if (val && typeof val.r === 'number') { out[k] = 'Color(' + [val.r, val.g, val.b].map(function (x) { return Math.round(x * 100) / 100; }).join(',') + ')'; }" +
      "    else if (val && typeof val.x === 'number') { out[k] = v3(val); }" +
      "  }" +
      "  return out; }" +
      "var g = trouve('tabletop-square-grid');" +
      "var res = { scene: true, grilleTrouvee: !!g };" +
      "if (g) {" +
      "  var bb = g.getBoundingInfo && g.getBoundingInfo().boundingBox;" +
      "  res.maillage = { classe: g.getClassName && g.getClassName()," +
      "    position: v3(g.position), echelle: v3(g.scaling), rotation: v3(g.rotation)," +
      "    visible: g.isVisible, actif: g.isEnabled && g.isEnabled()," +
      "    calque: g.layerMask, groupeRendu: g.renderingGroupId," +
      "    parent: g.parent ? g.parent.name : null," +
      "    min: bb ? v3(bb.minimumWorld) : null, max: bb ? v3(bb.maximumWorld) : null," +
      "    etendue: bb ? v3(bb.extendSizeWorld) : null," +
      "    sommets: g.getTotalVertices ? g.getTotalVertices() : null }; " +
      "  res.materiau = { classe: g.material && g.material.getClassName ? g.material.getClassName() : null," +
      "    nom: g.material ? g.material.name : null, props: props(g.material) };" +
      /* Un ShaderMaterial ne dit rien de ses réglages par ses propriétés : tout
       * est dans ses UNIFORMES, et c'est là qu'on saura si la grille se calcule
       * en coordonnées du monde (auquel cas agrandir le plan suffit) ou en UV
       * (auquel cas il faudra aussi corriger le nombre de cases). */
      "  var M = g.material;" +
      "  try { res.uniformes = M._options ? { noms: M._options.uniforms, attributs: M._options.attributes," +
      "    echantillonneurs: M._options.samplers, defines: M._options.defines } : null; } catch (e) {}" +
      "  res.valeurs = {};" +
      "  ['_floats','_ints','_vectors2','_vectors3','_vectors4','_colors3','_colors4','_matrices','_textures']" +
      "    .forEach(function (k) { try { var o = M[k]; if (!o) { return; }" +
      "      var ks = Object.keys(o); if (!ks.length) { return; }" +
      "      res.valeurs[k] = ks.reduce(function (a, n) { var v = o[n];" +
      "        a[n] = (v && typeof v.x === 'number') ? [v.x, v.y, v.z, v.w].filter(function (z) { return z !== undefined; })" +
      "             : (v && typeof v.r === 'number') ? [v.r, v.g, v.b, v.a].filter(function (z) { return z !== undefined; })" +
      "             : (typeof v === 'number') ? v : (v && v.name) ? ('tex:' + v.name) : '[?]';" +
      "        return a; }, {}); } catch (e) {} });" +
      "  try { var eff = M.getEffect && M.getEffect();" +
      "    res.fragment = eff && eff._fragmentSourceCode ? eff._fragmentSourceCode : null; } catch (e) {}" +
      "}" +
      "var ps = __mag('vttTools_pageSettings');" +
      "res.page = ps ? { largeur: ps.width, hauteur: ps.height, snapTo: ps.snapTo," +
      "  type: ps.gridType, echelle: ps.gridScale, unites: ps.scaleUnits," +
      "  montre: ps.showGrid, couleur: ps.gridColor, opacite: ps.gridOpacity," +
      "  fond: ps.backgroundColor } : null;" +
      "var cam = (S.cameras || []).filter(function (c) { return c.name === 'vtt-main-camera'; })[0];" +
      "res.camera = cam ? { orthoTop: cam.orthoTop, orthoRight: cam.orthoRight, position: v3(cam.position) } : null;" +
      "res.autresPlans = (S.meshes || []).filter(function (m) { return /grid|plane|divider|overlay/i.test(m.name); })" +
      "  .map(function (m) { var b = m.getBoundingInfo && m.getBoundingInfo().boundingBox;" +
      "    return { nom: m.name, visible: m.isVisible, groupe: m.renderingGroupId," +
      "      min: b ? v3(b.minimumWorld) : null, max: b ? v3(b.maximumWorld) : null }; });" +
      "return res;");

    if (!r.grilleTrouvee) { console.log("Maillage « tabletop-square-grid » introuvable."); releve("grille.json", r); return 1; }
    console.log("\n  MAILLAGE DE LA GRILLE");
    Object.keys(r.maillage).forEach(function (k) { console.log("    " + k.padEnd(12) + " " + JSON.stringify(r.maillage[k])); });
    console.log("\n  MATÉRIAU : " + r.materiau.classe + " « " + r.materiau.nom + " »");
    Object.keys(r.materiau.props || {}).forEach(function (k) {
      console.log("    " + k.padEnd(24) + " " + JSON.stringify(r.materiau.props[k]));
    });
    if (r.uniformes) {
      console.log("\n  UNIFORMES : " + (r.uniformes.noms || []).join(", "));
      console.log("  ATTRIBUTS : " + (r.uniformes.attributs || []).join(", "));
    }
    if (r.valeurs) {
      console.log("\n  VALEURS POSÉES");
      Object.keys(r.valeurs).forEach(function (k) {
        console.log("    " + k);
        Object.keys(r.valeurs[k]).forEach(function (n) {
          console.log("      " + n.padEnd(22) + " " + JSON.stringify(r.valeurs[k][n]));
        });
      });
    }
    console.log("\n  PAGE : " + JSON.stringify(r.page));
    console.log("  CAMÉRA : " + JSON.stringify(r.camera));
    console.log("\n  AUTRES PLANS");
    r.autresPlans.forEach(function (m) {
      console.log("    " + m.nom.padEnd(26) + " groupe=" + m.groupe + " visible=" + m.visible +
                  " de " + JSON.stringify(m.min) + " à " + JSON.stringify(m.max));
    });
    releve("grille.json", r);

    /* ---- ET MAINTENANT, ON REGARDE ----
     * Le module tourne par défaut : au chargement, la grille devrait DÉJÀ être
     * étendue. On l'éteint pour voir celle de Roll20, on la rallume, et on
     * photographie les deux. Un chiffre dit que la case fait toujours 70 px ;
     * seule l'image dit qu'on voit la trame au-delà de la carte. */
    const etat = async () => await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes || []).filter(function (m) { return m.name === 'tabletop-square-grid'; })[0];" +
      "if (!g) { return null; }" +
      "var v = g.material && g.material._vectors2 && g.material._vectors2.gridSize;" +
      /* La BOÎTE ENGLOBANTE, et pas seulement la propriété `scaling` : c'est
       * elle qui dit si le maillage a VRAIMENT grandi. La propriété se laisse
       * écrire même quand la matrice de monde est figée — et le quad reste
       * alors à sa taille pendant que le chiffre annonce le contraire. */
      "var b = g.getBoundingInfo && g.getBoundingInfo().boundingBox;" +
      "return { cases: v ? [v.x, v.y] : null," +
      "  echelle: [Math.round(g.scaling.x), Math.round(g.scaling.y)]," +
      "  boite: b ? [Math.round(b.minimumWorld.x), Math.round(b.minimumWorld.y)," +
      "              Math.round(b.maximumWorld.x), Math.round(b.maximumWorld.y)] : null," +
      "  casePx: v ? Math.round(Math.abs(g.scaling.x) / v.x * 100) / 100 : null };");

    const dis = (t, e) => console.log("    " + t.padEnd(14) + " cases " + JSON.stringify(e && e.cases) +
      "  case " + (e && e.casePx) + " px  BOÎTE RÉELLE " + JSON.stringify(e && e.boite));

    /* ON ATTEND QUE LE MODULE AIT FINI, au lieu de mesurer quand ça nous
     * arrange. La scène Babylon se monte après la page : le module essaie
     * pendant quelques secondes avant d'y arriver, et mesurer entre-temps
     * donnait un « pas appliqué » qui n'était qu'un essai trop pressé. */
    const t0 = Date.now();
    let applique = false;
    while (Date.now() - t0 < 25000 && !applique) {
      await dors(700);
      applique = (await journalDe(driver)).some((l) => /grille étendue/.test(l));
    }
    console.log("\n  AU CHARGEMENT (le module tourne par défaut) — appliquée en " +
                Math.round((Date.now() - t0) / 100) / 10 + " s");
    dis("tel quel", await etat());

    /* ON DÉZOOME AVANT DE PHOTOGRAPHIER. Au milieu de la carte, les deux états
     * sont rigoureusement identiques à l'image — la trame étendue est hors du
     * cadre. Il faut que le BORD de la carte entre dans la vue pour qu'il y ait
     * quelque chose à comparer. */
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(20);");
    await dors(1200);

    await driver.executeScript(
      "window.postMessage({ns:'vttinker',depuis:'contenu',type:'grille',actif:false}, '*');");
    await dors(1200);
    console.log("\n  MODULE ÉTEINT — la grille de Roll20 seule");
    dis("rendue", await etat());
    await capture(driver, "grille-sans.png");

    await driver.executeScript(
      "window.postMessage({ns:'vttinker',depuis:'contenu',type:'grille',actif:true,cases:60}, '*');");
    await dors(1200);
    console.log("\n  MODULE RALLUMÉ — 60 cases autour");
    dis("étendue", await etat());
    await capture(driver, "grille-avec.png");

    releve("journal.txt", (await journalDe(driver)).join("\n"));
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LES CINQ TYPES DE GRILLE ----------
 *
 * Roll20 en propose cinq : Square, Hex(V), Hex(H), Dimetric, Isometric. Le
 * module ne connaissait que le carré. Avant de généraliser, on regarde comment
 * on change de type, et surtout CE QUE CHAQUE TYPE PRODUIT dans la scène :
 * même maillage ? même nom ? mêmes uniformes ?
 *
 * On repose le type de départ à la fin, quoi qu'il arrive : c'est la page de
 * quelqu'un. */
async function typesGrille() {
  const driver = await ouvre(config().visible === true);
  let depart = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3000);

    // --- par où passe le type de grille ? ---
    const page = await driver.executeScript(
      "var C = window.Campaign; if (!C || !C.activePage) { return { page: false }; }" +
      "var p = C.activePage(); if (!p) { return { page: false }; }" +
      "var a = p.attributes || {}; var out = { page: true, id: p.id, grille: {}, autres: [] };" +
      "Object.keys(a).forEach(function (k) {" +
      "  if (/grid|diag|snap|scale|hex|iso/i.test(k)) { out.grille[k] = a[k]; }" +
      "  else { out.autres.push(k); } });" +
      "out.methodes = Object.keys(p).filter(function (k) { return typeof p[k] === 'function'; }).slice(0, 30);" +
      "return out;");
    console.log("\n  PAGE ACTIVE : " + (page.page ? page.id : "introuvable"));
    if (!page.page) { return 1; }
    console.log("  attributs de grille :");
    Object.keys(page.grille).forEach(function (k) { console.log("    " + k.padEnd(22) + " " + JSON.stringify(page.grille[k])); });
    /* L'ATTRIBUT S'APPELLE « grid_type », AVEC UN SOULIGNÉ. Écrit « gridtype »,
     * il crée un attribut que Roll20 ignore : la page ne change pas de type, et
     * les cinq relevés donnent le même maillage sans que rien ne le signale. */
    depart = page.grille.grid_type;
    console.log("  type au départ : « " + depart + " » (sera remis)");

    /* --- chaque type, l'un après l'autre --- */
    const types = ["square", "hex", "hexr", "dimetric", "isometric"];
    const vus = {};
    for (const t of types) {
      await driver.executeScript(
        "var p = window.Campaign.activePage();" +
        "p.save({ grid_type: arguments[0] });", t);
      await dors(4000);
      vus[t] = await driver.executeScript(
        "var S = window.MeshScene; if (!S) { return null; }" +
        "var g = (S.meshes || []).filter(function (m) { return /grid/i.test(m.name); });" +
        "return { typeVu: (window.Campaign.activePage().attributes || {}).grid_type," +
        "  maillages: g.map(function (m) {" +
        "    var v = m.material && m.material._vectors2 ? m.material._vectors2 : null;" +
        "    var b = m.getBoundingInfo && m.getBoundingInfo().boundingBox;" +
        "    return { nom: m.name, visible: m.isVisible," +
        "      echelle: [Math.round(m.scaling.x), Math.round(m.scaling.y)]," +
        "      boite: b ? [Math.round(b.minimumWorld.x), Math.round(b.minimumWorld.y)," +
        "                  Math.round(b.maximumWorld.x), Math.round(b.maximumWorld.y)] : null," +
        "      classe: m.getClassName && m.getClassName()," +
      "      sommets: m.getTotalVertices ? m.getTotalVertices() : null," +
      "      indices: m.getTotalIndices ? m.getTotalIndices() : null," +
      "      materiau: m.material ? m.material.name : null," +
        "      uniformes: m.material && m.material._options ? m.material._options.uniforms : null," +
        "      vecteurs: v ? Object.keys(v).reduce(function (a, n) { a[n] = [v[n].x, v[n].y]; return a; }, {}) : null," +
        "      flottants: m.material && m.material._floats ? Object.keys(m.material._floats)" +
        "        .reduce(function (a, n) { a[n] = m.material._floats[n]; return a; }, {}) : null }; }) };");
      const v = vus[t];
      console.log("\n  === " + t.toUpperCase() + " (page dit « " + (v && v.typeVu) + " ») ===");
      (v && v.maillages || []).forEach(function (m) {
        console.log("    " + m.nom.padEnd(26) + " " + String(m.classe).padEnd(12) +
                    " échelle " + JSON.stringify(m.echelle).padEnd(16) + " boîte " + JSON.stringify(m.boite));
        console.log("      sommets " + m.sommets + " indices " + m.indices +
                    "  matériau " + m.materiau);
        console.log("      vec2 " + JSON.stringify(m.vecteurs) + "  floats " + JSON.stringify(m.flottants));
      });
      /* ET CE QUE L'EXTENSION EN FAIT. On la relance sur chaque type, et on
       * regarde ce qui sort : un quad agrandi pour le carré, des copies pavées
       * pour les grilles en lignes. */
      await driver.executeScript(
        "window.postMessage({ns:'vttinker',depuis:'contenu',type:'grille',actif:false}, '*');");
      await dors(700);
      await driver.executeScript(
        "window.postMessage({ns:'vttinker',depuis:'contenu',type:'grille',actif:true,cases:60}, '*');");
      await dors(2000);
      const fait = await driver.executeScript(
        "var S = window.MeshScene;" +
        "var p = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); });" +
        "var q = (S.meshes || []).filter(function (m) { return m.name === 'tabletop-square-grid'; })[0];" +
        "var b = null;" +
        "if (p.length) { var mn = [1e9, 1e9], mx = [-1e9, -1e9];" +
        "  p.concat((S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); }))" +
        "   .forEach(function (m) { var bb = m.getBoundingInfo().boundingBox;" +
        "     mn[0] = Math.min(mn[0], bb.minimumWorld.x); mn[1] = Math.min(mn[1], bb.minimumWorld.y);" +
        "     mx[0] = Math.max(mx[0], bb.maximumWorld.x); mx[1] = Math.max(mx[1], bb.maximumWorld.y); });" +
        "  b = [Math.round(mn[0]), Math.round(mn[1]), Math.round(mx[0]), Math.round(mx[1])]; }" +
        "else if (q) { var qb = q.getBoundingInfo().boundingBox;" +
        "  b = [Math.round(qb.minimumWorld.x), Math.round(qb.minimumWorld.y)," +
        "       Math.round(qb.maximumWorld.x), Math.round(qb.maximumWorld.y)]; }" +
        "return { copies: p.length, couverture: b," +
        "  journal: (window.__vttinkerJournal || []).slice(-2) };");
      console.log("      EXTENSION → " + (fait.copies ? "maillage fusionné" : "quad agrandi") +
                  ", couverture " + JSON.stringify(fait.couverture));
      const dit = (fait.journal[fait.journal.length - 1] || "").replace(/\s+/g, " ").trim();
      console.log("      « " + dit + " »");
      // Le relevé garde la phrase : c'est elle qui porte les chiffres du pavage,
      // et un tableau de mesures ne se recopie pas de mémoire.
      vus[t].pavage = dit;
      vus[t].couverture = fait.couverture;
      await driver.executeScript(MAGASIN + "__mag('engine').setZoom(15);");
      await dors(1200);
      await capture(driver, "grille-" + t + ".png");
    }
    releve("types-grille.json", { page, vus });
    return 0;
  } finally {
    if (depart) {
      try {
        await driver.executeScript("window.Campaign.activePage().save({ grid_type: arguments[0] });", depart);
        await dors(2000);
        console.log("\n  type de grille remis à « " + depart + " »");
      } catch (e) { console.log("\n  ÉCHEC de la remise en état du type de grille : " + e.message); }
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE PAVAGE : L'HYPOTHÈSE À ABATTRE ----------
 *
 * Pour les quatre grilles non carrées, la trame est de la GÉOMÉTRIE de lignes,
 * cuite aux dimensions de la page. La mettre à l'échelle agrandirait les
 * cellules au lieu d'en ajouter ; la régénérer demanderait de réimplémenter
 * ses mathématiques d'hexagones et d'isométrie.
 *
 * Reste une troisième voie, beaucoup moins chère : CLONER le maillage et
 * décaler les copies d'une page entière. Elle ne marche que si le motif est
 * périodique de la taille de la page — évident pour le carré, pas du tout pour
 * l'hexagone. On ne le devine pas : on pave, on photographie, et on regarde les
 * jointures.
 *
 * L'expérience défait tout ce qu'elle a posé. */
async function pavage() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);

    const info = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "if (!g) { return { la: false }; }" +
      "var p = g.getVerticesData && g.getVerticesData('position');" +
      "var xs = [], ys = [];" +
      "if (p) { for (var i = 0; i < p.length; i += 3) { xs.push(p[i]); ys.push(p[i + 1]); } }" +
      "function bornes(a) { var mn = Infinity, mx = -Infinity;" +
      "  for (var i = 0; i < a.length; i++) { if (a[i] < mn) { mn = a[i]; } if (a[i] > mx) { mx = a[i]; } }" +
      "  return [Math.round(mn * 100) / 100, Math.round(mx * 100) / 100]; }" +
      "return { la: true, nom: g.name, type: (window.Campaign.activePage().attributes || {}).grid_type," +
      "  sommets: p ? p.length / 3 : null, x: bornes(xs), y: bornes(ys)," +
      "  position: [g.position.x, g.position.y] };");
    if (!info.la) { console.log("Pas de grille en lignes sur cette page."); return 1; }
    console.log("\n  " + info.nom + " (" + info.type + ") — " + info.sommets + " sommets");
    console.log("  étendue des sommets : x " + JSON.stringify(info.x) + "  y " + JSON.stringify(info.y));
    console.log("  position du maillage : " + JSON.stringify(info.position));

    /* LA PÉRIODE DU MOTIF, mesurée sur les sommets. Le pavage n'est sans
     * couture que si la taille de la page est un multiple entier de cette
     * période — évident pour le carré, à vérifier pour l'hexagone. On relève
     * les écarts entre valeurs distinctes et on garde les plus fréquents. */
    const periodes = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "var p = g.getVerticesData('position');" +
      "function analyse(dec) {" +
      "  var vus = {};" +
      "  for (var i = dec; i < p.length; i += 3) { vus[Math.round(p[i] * 100) / 100] = 1; }" +
      "  var v = Object.keys(vus).map(Number).sort(function (a, b) { return a - b; });" +
      "  var ecarts = {};" +
      "  for (var j = 1; j < v.length; j++) {" +
      "    var d = Math.round((v[j] - v[j - 1]) * 100) / 100;" +
      "    if (d > 0.05) { ecarts[d] = (ecarts[d] || 0) + 1; } }" +
      "  var tri = Object.keys(ecarts).map(Number).sort(function (a, b) { return ecarts[b] - ecarts[a]; });" +
      "  return { distincts: v.length, principaux: tri.slice(0, 4).map(function (d) { return d + ' ×' + ecarts[d]; }) }; }" +
      "return { x: analyse(0), y: analyse(1) };");
    console.log("  écarts en x : " + JSON.stringify(periodes.x.principaux) + "  (" + periodes.x.distincts + " valeurs)");
    console.log("  écarts en y : " + JSON.stringify(periodes.y.principaux) + "  (" + periodes.y.distincts + " valeurs)");

    // --- on pave 3 × 3 autour de la page ---
    const pave = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "if (!g) { return 'absent'; }" +
      "var L = 1540, H = 2240, faits = [];" +
      "for (var i = -1; i <= 1; i++) { for (var j = -1; j <= 1; j++) {" +
      "  if (!i && !j) { continue; }" +
      "  try { var c = g.clone('vttk-pave-' + i + '-' + j);" +
      "    c.position.x = g.position.x + i * L;" +
      "    c.position.y = g.position.y + j * H;" +
      "    c.computeWorldMatrix(true); faits.push(c.name); } catch (e) { return 'clone refusé : ' + e.message; }" +
      "} }" +
      "return faits;");
    console.log("  clones posés : " + JSON.stringify(pave));
    await dors(1500);
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(20);");
    await dors(1500);
    await capture(driver, "pavage.png");

    // --- on défait ---
    const oteur = await driver.executeScript(
      "var S = window.MeshScene, n = 0;" +
      "(S.meshes || []).slice().forEach(function (m) {" +
      "  if (/^vttk-grille-/.test(m.name)) { try { m.dispose(); n++; } catch (e) {} } });" +
      "return n;");
    console.log("  clones retirés : " + oteur);
    releve("pavage.json", info);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- CE QUI SE PASSE À LA JOINTURE ----------
 *
 * Les coutures restent visibles sur l'hexagone. Deux causes possibles, et elles
 * appellent des corrections opposées :
 *   - une PÉRIODE IMPRÉCISE : accumulée sur trente-six répétitions, une erreur
 *     minime décale les segments, le dédoublonnage les manque, et deux traits
 *     presque superposés font une ligne épaisse ;
 *   - des CELLULES TRONQUÉES au bord de la page : les moitiés d'hexagone de la
 *     tuile du dessus ne correspondent pas à celles de la tuile du dessous, et
 *     laissent des moignons.
 *
 * On compte, on ne regarde pas. Une bande de jointure qui porte deux fois plus
 * de segments qu'une bande ordinaire désigne la première ; des longueurs de
 * segment anormales désignent la seconde. */
async function jointures(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
      console.log("  type mis à « " + type + " » (était « " + avant + " »)");
      await dors(4000);
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: true, cases: 60 }, '*');");
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if ((await journalDe(driver)).some((l) => /grille pavée|grille étendue/.test(l))) { break; }
      await dors(700);
    }

    /* L'INDICATEUR PAR BANDES NE PROUVE RIEN À LUI SEUL : sur une trame
     * hexagonale les rangées ne portent pas le même nombre de segments, et un
     * facteur deux peut n'être que le motif. Ce qui tranche, c'est la
     * MULTIPLICITÉ : combien de fois une même position est tracée. Roll20
     * dessine ses hexagones un par un, donc ses arêtes partagées sortent déjà en
     * double — la source dit jusqu'où c'est légitime. Toute multiplicité que le
     * résultat porte et que la source ignore est une jointure. */
    const HISTO =
      "function histo(p, i) {" +
      "  var h = Object.create(null);" +
      "  for (var s = 0; s < i.length / 2; s++) {" +
      "    var a = i[2 * s] * 3, b = i[2 * s + 1] * 3;" +
      "    var x0 = p[a], y0 = p[a + 1], x1 = p[b], y1 = p[b + 1], t;" +
      "    if (x1 < x0 || (x1 === x0 && y1 < y0)) { t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }" +
      "    var k = Math.round(x0 * 2) + '/' + Math.round(y0 * 2) + '/' +" +
      "            Math.round(x1 * 2) + '/' + Math.round(y1 * 2);" +
      "    h[k] = (h[k] || 0) + 1; }" +
      "  var m = Object.create(null);" +
      "  for (var k2 in h) { m[h[k2]] = (m[h[k2]] || 0) + 1; }" +
      "  return { profil: m, brut: h }; }" +
      /* Une ligne tracée UNE fois là où ses voisines le sont DEUX est plus pâle.
       * Au bord du champ, c'est normal — c'est le bord. En plein milieu, c'est
       * une couture. On compte donc les positions solitaires loin du bord. */
      "function solitaires(h, marge, page) {" +
      "  var xs = [], ys = [], k, p;" +
      "  for (k in h) { p = k.split('/'); xs.push(+p[0] / 2, +p[2] / 2); ys.push(+p[1] / 2, +p[3] / 2); }" +
      "  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);" +
      "  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);" +
      "  var dedans = 0, total = 0, loinPage = 0;" +
      "  var parX = Object.create(null), parY = Object.create(null);" +
      /* `page` est le rectangle que Roll20 dessine lui-même. Son POURTOUR porte
       * légitimement des traits solitaires : ses hexagones y sont tronqués, les
       * nôtres entiers, et les deux ne se recouvrent pas. Ce qui compte, c'est
       * ce qui reste une fois ce pourtour écarté. */
      "  for (k in h) { if (h[k] !== 1) { continue; } total++;" +
      "    p = k.split('/');" +
      "    var mx = (+p[0] / 2 + +p[2] / 2) / 2, my = (+p[1] / 2 + +p[3] / 2) / 2;" +
      "    if (!(mx - x0 > marge && x1 - mx > marge && my - y0 > marge && y1 - my > marge)) { continue; }" +
      "    dedans++;" +
      "    if (page) {" +
      "      var d = Math.max(page[0] - mx, mx - page[2], page[1] - my, my - page[3]);" +
      "      if (Math.abs(d) < 150) { continue; } }" +
      "    loinPage++;" +
      // Où sont-elles ? Si elles s'alignent sur quelques abscisses ou quelques
      // ordonnées, ce sont les lignes de jointure — et le pas le dira.
      "    var ax = Math.round(mx / 10) * 10, ay = Math.round(my / 10) * 10;" +
      "    parX[ax] = (parX[ax] || 0) + 1; parY[ay] = (parY[ay] || 0) + 1; }" +
      "  function tete(o) { return Object.keys(o).map(Number)" +
      "    .sort(function (a2, b2) { return o[b2] - o[a2]; }).slice(0, 8)" +
      "    .map(function (v) { return v + ' ×' + o[v]; }); }" +
      "  return { total: total, dedans: dedans, loinPage: loinPage," +
      "    parX: tete(parX), parY: tete(parY), boite: [x0, y0, x1, y1] }; }";

    const r = await driver.executeScript(
      HISTO +
      "var S = window.MeshScene;" +
      "var n = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
      "var o = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "if (!n || !o) { return { la: false }; }" +
      "var hSrc = histo(o.getVerticesData('position'), o.getIndices());" +
      "var hOut = histo(n.getVerticesData('position'), n.getIndices());" +
      "var multSrc = hSrc.profil, multOut = hOut.profil;" +
      /* CE QUE L'OEIL VOIT, c'est l'UNION des deux maillages. Compter le nôtre
       * seul fait passer pour pâle toute ligne du pourtour de la carte que
       * Roll20 complète lui-même. */
      "var union = Object.create(null), kk;" +
      "for (kk in hSrc.brut) { union[kk] = (union[kk] || 0) + hSrc.brut[kk]; }" +
      "for (kk in hOut.brut) { union[kk] = (union[kk] || 0) + hOut.brut[kk]; }" +
      "var mUnion = Object.create(null);" +
      "for (kk in union) { mUnion[union[kk]] = (mUnion[union[kk]] || 0) + 1; }" +
      "var page = solitaires(hSrc.brut, 0).boite;" +
      "var seuls = solitaires(union, 220, page), seulsSrc = solitaires(hSrc.brut, 220);" +
      "var p = n.getVerticesData('position'), i = n.getIndices();" +
      "var lg = {}, bandes = {}, PAS = 20;" +   // bandes de 20 px en y
      "for (var s = 0; s < i.length / 2; s++) {" +
      "  var a = i[2 * s] * 3, b = i[2 * s + 1] * 3;" +
      "  var dx = p[b] - p[a], dy = p[b + 1] - p[a + 1];" +
      "  var L = Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10;" +
      "  lg[L] = (lg[L] || 0) + 1;" +
      "  var my = (p[a + 1] + p[b + 1]) / 2;" +
      "  var k = Math.floor(my / PAS) * PAS;" +
      "  bandes[k] = (bandes[k] || 0) + 1; }" +
      "var lgs = Object.keys(lg).map(Number).sort(function (x, y) { return lg[y] - lg[x]; });" +
      "var ks = Object.keys(bandes).map(Number).sort(function (x, y) { return x - y; });" +
      "var vals = ks.map(function (k) { return bandes[k]; });" +
      "var med = vals.slice().sort(function (x, y) { return x - y; })[Math.floor(vals.length / 2)];" +
      "var chargees = ks.filter(function (k) { return bandes[k] > med * 1.6; })" +
      "  .map(function (k) { return k + ':' + bandes[k]; });" +
      "return { la: true, segments: i.length / 2, multSrc: multSrc, multOut: multOut," +
      "  multUnion: mUnion, seuls: seuls, seulsSrc: seulsSrc," +
      "  longueurs: lgs.slice(0, 6).map(function (L) { return L + ' ×' + lg[L]; })," +
      "  bandeMediane: med, bandesChargees: chargees.slice(0, 20)," +
      "  yMin: Math.min.apply(null, ks), yMax: Math.max.apply(null, ks) };");

    if (!r.la) { console.log("Pas de maillage étendu (grille carrée ?)."); return 1; }
    console.log("\n  " + r.segments + " segments, bandes de 20 px en y de " + r.yMin + " à " + r.yMax);
    console.log("  longueurs les plus fréquentes : " + r.longueurs.join("   "));
    console.log("  segments par bande, médiane : " + r.bandeMediane);
    console.log("  bandes chargées (> 1,6 × la médiane) : " +
                (r.bandesChargees.length ? r.bandesChargees.join("  ") : "aucune"));
    const lis = (m) => Object.keys(m).map(Number).sort((x, y) => x - y)
      .map((k) => k + "× : " + m[k] + " positions").join("   ");
    console.log("\n  MULTIPLICITÉS — Roll20 seul : " + lis(r.multSrc));
    console.log("                    nous seuls : " + lis(r.multOut));
    console.log("                    À L'ÉCRAN  : " + lis(r.multUnion));
    const maxSrc = Math.max(...Object.keys(r.multSrc).map(Number));
    const excedent = Object.keys(r.multUnion).map(Number).filter((k) => k > maxSrc)
      .reduce((s, k) => s + r.multUnion[k], 0);
    console.log("  positions tracées PLUS souvent que chez Roll20 : " + excedent);
    console.log("  lignes solitaires (donc PÂLES) — Roll20 : " + r.seulsSrc.total +
                " dont " + r.seulsSrc.dedans + " loin du bord");
    console.log("                              à l'écran : " + r.seuls.total +
                " dont " + r.seuls.dedans + " loin du bord du champ,");
    console.log("                                          et " + r.seuls.loinPage +
                " loin AUSSI du pourtour de la carte  ← les vraies coutures");
    console.log("    leurs abscisses : " + r.seuls.parX.join("   "));
    console.log("    leurs ordonnées : " + r.seuls.parY.join("   "));
    const dit = (await journalDe(driver)).filter((l) => /grille pav/.test(l)).slice(-1)[0];
    if (dit) { console.log("\n  " + dit.replace(/\s+/g, " ").trim()); }
    releve("jointures.json", r);
    return 0;
  } finally {
    if (avant) {
      // On rend la page telle qu'on l'a trouvée, et on laisse le temps à
      // l'écriture de partir : une fermeture immédiate la perd.
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
      console.log("  type de grille remis à « " + avant + " »");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE RÉSEAU, ET SES VRAIES TRANSLATIONS ----------
 *
 * On cherchait les périodes sur la PROJECTION 1-D de chaque axe : les abscisses
 * d'un côté, les ordonnées de l'autre. C'est ce qui a manqué le défaut, et la
 * géométrie dit pourquoi — dans un pavage hexagonal, deux rangées consécutives
 * sont décalées d'une demi-colonne. L'ensemble des abscisses se répète donc tous
 * les demi-pas, alors que le RÉSEAU, lui, ne revient sur lui-même qu'au pas
 * entier. Une projection qui coïncide ne prouve rien.
 *
 * Ici on ne projette pas : on translate les segments et on compte ceux qui
 * retombent sur un segment. C'est la seule preuve qui vaille. */
async function reseau(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
      console.log("  type mis à « " + type + " » (était « " + avant + " »)");
      await dors(4000);
    }

    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var o = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "if (!o) { return { la: false }; }" +
      "var p = o.getVerticesData('position'), idx = o.getIndices();" +
      "var seg = [], k, a, b, x0, y0, x1, y1, t;" +
      "for (k = 0; k < idx.length / 2; k++) {" +
      "  a = idx[2 * k] * 3; b = idx[2 * k + 1] * 3;" +
      "  x0 = p[a]; y0 = p[a + 1]; x1 = p[b]; y1 = p[b + 1];" +
      "  if (x0 === x1 && y0 === y1) { continue; }" +
      "  if (x1 < x0 || (x1 === x0 && y1 < y0)) { t=x0;x0=x1;x1=t; t=y0;y0=y1;y1=t; }" +
      "  seg.push([x0, y0, x1, y1]); }" +
      // Table spatiale sur le premier sommet, pour comparer par DISTANCE.
      "var C = 8, TOL = 0.4, tab = Object.create(null), i, c;" +
      "for (i = 0; i < seg.length; i++) {" +
      "  c = Math.floor(seg[i][0] / C) + ',' + Math.floor(seg[i][1] / C);" +
      "  if (!tab[c]) { tab[c] = []; } tab[c].push(i); }" +
      "function existe(X0, Y0, X1, Y1) {" +
      "  var cx = Math.floor(X0 / C), cy = Math.floor(Y0 / C), u, v, lot, n, s;" +
      "  for (u = -1; u <= 1; u++) { for (v = -1; v <= 1; v++) {" +
      "    lot = tab[(cx + u) + ',' + (cy + v)]; if (!lot) { continue; }" +
      "    for (n = 0; n < lot.length; n++) { s = seg[lot[n]];" +
      "      if (Math.abs(s[0]-X0)<TOL && Math.abs(s[1]-Y0)<TOL &&" +
      "          Math.abs(s[2]-X1)<TOL && Math.abs(s[3]-Y1)<TOL) { return true; } } } }" +
      "  return false; }" +
      // Bornes de la source : un segment translaté hors bornes n'a pas d'image,
      // et ne doit pas compter comme un échec.
      "var X = [], Y = [];" +
      "for (i = 0; i < seg.length; i++) { X.push(seg[i][0], seg[i][2]); Y.push(seg[i][1], seg[i][3]); }" +
      "var xm = Math.min.apply(null, X), xM = Math.max.apply(null, X);" +
      "var ym = Math.min.apply(null, Y), yM = Math.max.apply(null, Y);" +
      "function note(dx, dy) {" +
      "  var testes = 0, ok = 0, s2;" +
      "  for (var j = 0; j < seg.length; j++) { s2 = seg[j];" +
      "    var A = s2[0]+dx, B = s2[1]+dy, Cc = s2[2]+dx, D = s2[3]+dy;" +
      "    if (A < xm-0.1 || Cc > xM+0.1 || B < ym-0.1 || D > yM+0.1) { continue; }" +
      "    testes++; if (existe(A, B, Cc, D)) { ok++; } }" +
      "  return { testes: testes, ok: ok, taux: testes ? Math.round(1000 * ok / testes) / 10 : null }; }" +
      /* Les deux périodes 1-D, celles-là mêmes que le pont calcule : l'écart le
       * plus fréquent entre valeurs distinctes consécutives. */
      "function pas1D(vals) {" +
      "  var u = {}, j;" +
      "  for (j = 0; j < vals.length; j++) { u[Math.round(vals[j] * 100) / 100] = 1; }" +
      "  var v = Object.keys(u).map(Number).sort(function (a2, b2) { return a2 - b2; });" +
      "  var e = {}, d;" +
      "  for (j = 1; j < v.length; j++) { d = Math.round((v[j] - v[j-1]) * 1000) / 1000;" +
      "    if (d > 0.05) { e[d] = (e[d] || 0) + 1; } }" +
      "  var tri = Object.keys(e).map(Number).sort(function (a2, b2) { return e[b2] - e[a2]; });" +
      "  return tri[0]; }" +
      "var px = pas1D(X), py = pas1D(Y);" +
      /* La table : chaque translation (i*px, j*py) et le taux de segments qui
       * retombent sur un segment. 100 % = symétrie du réseau. */
      "var table = [], ii, jj;" +
      "for (ii = 0; ii <= 4; ii++) { for (jj = 0; jj <= 4; jj++) {" +
      "  if (!ii && !jj) { continue; }" +
      "  var n2 = note(ii * px, jj * py);" +
      "  if (n2.testes > 20) { table.push({ i: ii, j: jj, taux: n2.taux, testes: n2.testes }); } } }" +
      "return { la: true, segments: seg.length, px: px, py: py," +
      "  boite: [xm, ym, xM, yM], table: table };");

    if (!r.la) { console.log("Pas de grille en lignes sur cette page."); return 1; }
    console.log("\n  " + r.segments + " segments — périodes 1-D : x " + r.px + "  y " + r.py);
    console.log("  taux de segments qui RETOMBENT sur un segment, par translation (i·x, j·y) :\n");
    const par = new Map();
    r.table.forEach((t) => { if (!par.has(t.i)) { par.set(t.i, []); } par.get(t.i).push(t); });
    console.log("      j →" + [0, 1, 2, 3, 4].map((j) => String(j).padStart(8)).join(""));
    [...par.keys()].sort((a, b) => a - b).forEach((i) => {
      const l = [0, 1, 2, 3, 4].map((j) => {
        const t = par.get(i).find((z) => z.j === j);
        return (t ? t.taux + "%" : "·").padStart(8);
      }).join("");
      console.log("   i=" + i + "   " + l);
    });
    const bons = r.table.filter((t) => t.taux >= 99.5);
    console.log("\n  translations VALIDES (≥ 99,5 %) : " +
      (bons.length ? bons.map((t) => "(" + t.i + "," + t.j + ")").join(" ") : "aucune"));
    releve("reseau.json", r);
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
      console.log("  type de grille remis à « " + avant + " »");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- SOMMES-NOUS EN PHASE AVEC ROLL20 ? ----------
 *
 * Toutes les mesures précédentes comparaient des positions ABSOLUES : elles
 * voient un doublon, une pâleur, jamais un déphasage d'ensemble. Celle-ci
 * ramène chaque segment dans la maille du réseau, par les vraies translations,
 * et compare les deux jeux réduits. Si notre trame est décalée d'une demi-
 * colonne, aucun de nos segments ne se réduit comme les siens. */
async function phaseGrille(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
      console.log("  type mis à « " + type + " » (était « " + avant + " »)");
      await dors(4000);
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: true, cases: 60 }, '*');");
      await dors(2500);
    }

    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "function segs(m) {" +
      "  var p = m.getVerticesData('position'), idx = m.getIndices(), out = [], k, a, b, x0, y0, x1, y1, t;" +
      "  for (k = 0; k < idx.length / 2; k++) {" +
      "    a = idx[2*k] * 3; b = idx[2*k+1] * 3;" +
      "    x0 = p[a]; y0 = p[a+1]; x1 = p[b]; y1 = p[b+1];" +
      "    if (x0 === x1 && y0 === y1) { continue; }" +
      "    if (x1 < x0 || (x1 === x0 && y1 < y0)) { t=x0;x0=x1;x1=t; t=y0;y0=y1;y1=t; }" +
      "    out.push([x0, y0, x1, y1]); }" +
      "  return out; }" +
      "var o = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "var n = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
      "if (!o || !n) { return { la: false, o: !!o, n: !!n }; }" +
      "var A = segs(o), B = segs(n);" +
      /* Les générateurs : les deux plus courtes translations qui ramènent le
       * réseau sur lui-même. On les cherche, on ne les suppose pas. */
      "var X = [], Y = [], i;" +
      "for (i = 0; i < A.length; i++) { X.push(A[i][0], A[i][2]); Y.push(A[i][1], A[i][3]); }" +
      "function pas1D(vals) {" +
      "  var u = {}, j; for (j = 0; j < vals.length; j++) { u[Math.round(vals[j]*100)/100] = 1; }" +
      "  var v = Object.keys(u).map(Number).sort(function (a2,b2) { return a2-b2; });" +
      "  var e = {}, d; for (j = 1; j < v.length; j++) { d = Math.round((v[j]-v[j-1])*1000)/1000;" +
      "    if (d > 0.05) { e[d] = (e[d]||0)+1; } }" +
      "  var tri = Object.keys(e).map(Number).sort(function (a2,b2) { return e[b2]-e[a2]; });" +
      "  return tri[0]; }" +
      "var px = pas1D(X), py = pas1D(Y);" +
      "var C = 8, TOL = 0.4, tab = Object.create(null), c;" +
      "for (i = 0; i < A.length; i++) { c = Math.floor(A[i][0]/C) + ',' + Math.floor(A[i][1]/C);" +
      "  if (!tab[c]) { tab[c] = []; } tab[c].push(i); }" +
      // Renvoie l'ÉCART exact avec le segment trouvé, pas un simple oui/non.
      "function ecart(X0,Y0,X1,Y1) { var cx=Math.floor(X0/C), cy=Math.floor(Y0/C), u,v,lot,q,s;" +
      "  for (u=-1;u<=1;u++){for(v=-1;v<=1;v++){ lot = tab[(cx+u)+','+(cy+v)]; if(!lot){continue;}" +
      "    for(q=0;q<lot.length;q++){ s=A[lot[q]];" +
      "      if (Math.abs(s[0]-X0)<TOL&&Math.abs(s[1]-Y0)<TOL&&Math.abs(s[2]-X1)<TOL&&Math.abs(s[3]-Y1)<TOL) {" +
      "        return [s[0]-X0, s[1]-Y0]; } } } }" +
      "  return null; }" +
      "var xm=Math.min.apply(null,X), xM=Math.max.apply(null,X);" +
      "var ym=Math.min.apply(null,Y), yM=Math.max.apply(null,Y);" +
      /* `note` renvoie aussi la translation AFFINÉE : la moyenne des écarts
       * réellement constatés entre un segment et celui sur lequel il retombe.
       * Sans cela le générateur traîne l'arrondi de la période 1-D — un
       * centième de pixel, mais multiplié par cent trente répétitions pour
       * atteindre nos segments les plus lointains, soit plus d'un pixel, et la
       * mesure accusait de déphasage ce qui ne l'était pas. */
      "function note(dx,dy){ var t2=0,ok=0,s2,j,sx=0,sy=0;" +
      "  for(j=0;j<A.length;j++){ s2=A[j];" +
      "    var a1=s2[0]+dx,b1=s2[1]+dy,c1=s2[2]+dx,d1=s2[3]+dy;" +
      "    if(a1<xm-0.1||c1>xM+0.1||b1<ym-0.1||d1>yM+0.1){continue;}" +
      "    t2++; var e2 = ecart(a1,b1,c1,d1); if(e2){ ok++; sx += e2[0]; sy += e2[1]; } }" +
      "  return { bon: t2 > 20 && ok >= t2 * 0.995," +
      "           v: ok ? [dx + sx/ok, dy + sy/ok] : [dx, dy] }; }" +
      "var gen = [], ii, jj;" +
      "for (var somme = 1; somme <= 12 && gen.length < 2; somme++) {" +
      "  for (ii = 0; ii <= somme; ii++) { jj = somme - ii;" +
      "    var nt = note(ii*px, jj*py); if (!nt.bon) { continue; }" +
      "    var v2 = nt.v;" +
      "    if (gen.length === 1) { var d2 = gen[0][0]*v2[1] - gen[0][1]*v2[0];" +
      "      if (Math.abs(d2) < 1) { continue; } }" +   // colinéaire : inutile
      "    gen.push(v2); if (gen.length === 2) { break; } } }" +
      "if (gen.length < 2) { return { la: true, gen: gen, assez: false }; }" +
      /* Réduction : on retire de chaque segment le multiple entier des
       * générateurs le plus proche, et on compare ce qui reste. */
      "var g1 = gen[0], g2 = gen[1], det = g1[0]*g2[1] - g1[1]*g2[0];" +
      "function reduit(s) {" +
      "  var al = (s[0]*g2[1] - s[1]*g2[0]) / det, be = (g1[0]*s[1] - g1[1]*s[0]) / det;" +
      "  al = Math.round(al); be = Math.round(be);" +
      "  var ox = al*g1[0] + be*g2[0], oy = al*g1[1] + be*g2[1];" +
      "  return Math.round((s[0]-ox)*4) + '/' + Math.round((s[1]-oy)*4) + '/' +" +
      "         Math.round((s[2]-ox)*4) + '/' + Math.round((s[3]-oy)*4); }" +
      "var cles = Object.create(null);" +
      "for (i = 0; i < A.length; i++) { cles[reduit(A[i])] = 1; }" +
      "var dedans = 0, dehors = 0, exemples = [];" +
      "for (i = 0; i < B.length; i++) { var k2 = reduit(B[i]);" +
      "  if (cles[k2]) { dedans++; } else { dehors++; if (exemples.length < 4) { exemples.push(k2); } } }" +
      /* ---------- LA FRANGE ----------
       * On mesure la LONGUEUR DE TRAIT réellement posée, les deux maillages
       * confondus, dans des bandes qui s'éloignent du bord de la page. Le
       * réseau étant périodique, des bandes espacées d'une période entière
       * doivent en porter autant. Une première bande plus courte que les
       * suivantes, c'est la frange — et c'est le seul défaut que ni les
       * doublons, ni les pâleurs, ni la phase ne pouvaient signaler, puisqu'il
       * ne consiste en rien de dessiné. */
      "var P = 2 * Math.abs(g2[1]) || 2 * Math.abs(g1[1]);" +   // période verticale pure
      "var TOUS = A.concat(B);" +
      "function longueurBande(y0, y1, x0, x1) {" +
      "  var L = 0, j2, s3, ax, ay, bx2, by2, t0b, t1b, tt;" +
      "  for (j2 = 0; j2 < TOUS.length; j2++) { s3 = TOUS[j2];" +
      "    ax = s3[0]; ay = s3[1]; bx2 = s3[2]; by2 = s3[3];" +
      "    var mxx = (ax + bx2) / 2; if (mxx < x0 || mxx > x1) { continue; }" +
      "    if (ay > by2) { var q1=ax; ax=bx2; bx2=q1; var q2=ay; ay=by2; by2=q2; }" +
      "    if (by2 <= y0 || ay >= y1) { continue; }" +
      "    tt = function (y) { return by2 === ay ? 0 : (y - ay) / (by2 - ay); };" +
      "    t0b = ay >= y0 ? 0 : tt(y0); t1b = by2 <= y1 ? 1 : tt(y1);" +
      "    L += Math.sqrt(Math.pow((bx2-ax)*(t1b-t0b), 2) + Math.pow((by2-ay)*(t1b-t0b), 2)); }" +
      "  return Math.round(L * 10) / 10; }" +
      "var xa = xm + (xM - xm) * 0.25, xb = xm + (xM - xm) * 0.75;" +
      "var bandes = [];" +
      "for (i = 0; i < 5; i++) { bandes.push(longueurBande(yM + i*P, yM + (i+1)*P, xa, xb)); }" +
      "return { la: true, assez: true, gen: gen, px: px, py: py, periodeY: P," +
      "  siens: A.length, notres: B.length, motifsSiens: Object.keys(cles).length," +
      "  enPhase: dedans, dephases: dehors, exemples: exemples, bandes: bandes };");

    if (!r.la) { console.log("  maillage manquant (Roll20 " + r.o + ", nous " + r.n + ")"); return 1; }
    if (!r.assez) { console.log("  générateurs introuvables : " + JSON.stringify(r.gen)); return 1; }
    const rd = (v) => Math.round(v * 10000) / 10000;
    console.log("\n  générateurs du réseau : (" +
                r.gen.map((g) => g.map(rd).join(" ; ")).join(")   (") + ")");
    console.log("  ses segments : " + r.siens + " → " + r.motifsSiens + " motifs distincts dans la maille");
    console.log("  les nôtres  : " + r.notres);
    console.log("    EN PHASE  : " + r.enPhase + "  (" + Math.round(1000 * r.enPhase / r.notres) / 10 + " %)");
    console.log("    DÉPHASÉS  : " + r.dephases + "  (" + Math.round(1000 * r.dephases / r.notres) / 10 + " %)");
    if (r.exemples.length) { console.log("    motifs inconnus de lui : " + r.exemples.join("   ")); }
    console.log("\n  LA FRANGE — longueur de trait par bande de " +
                Math.round(r.periodeY * 100) / 100 + " px en s'éloignant du bord haut :");
    console.log("    " + r.bandes.map((L, i) => "bande " + i + " : " + L).join("   "));
    const ref = r.bandes.slice(1).reduce((a, b) => a + b, 0) / (r.bandes.length - 1);
    const manque = ref ? Math.round(1000 * (ref - r.bandes[0]) / ref) / 10 : 0;
    console.log("    la bande collée au bord porte " + (manque > 0 ? manque + " % de MOINS" : (-manque) + " % de plus") +
                " que la moyenne des suivantes" + (Math.abs(manque) < 0.5 ? "  → pas de frange" : "  ← FRANGE"));
    releve("phase-grille.json", r);
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
      console.log("  type de grille remis à « " + avant + " »");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA DÉRIVE ----------
 *
 * Toutes les mesures faites jusqu'ici comparent des SOMMETS, et les sommets sont
 * en repère local. Ce que l'écran montre, c'est local + position du maillage.
 * Si Roll20 déplace le sien — au zoom, au panoramique, au changement de calque —
 * sans le remplacer, notre copie garde l'ancienne position, les deux trames
 * dérivent, et pas un seul de nos contrôles ne peut le dire.
 *
 * On relève donc les deux positions, on secoue la vue par les chemins de Roll20
 * lui-même, et on regarde si l'écart bouge. */
async function derive() {
  const driver = await ouvre(config().visible === true);
  const ETAT =
    "var S = window.MeshScene;" +
    "function pose(m) { return m ? { nom: m.name," +
    "  pos: [m.position.x, m.position.y, m.position.z]," +
    "  ech: [m.scaling.x, m.scaling.y]," +
    "  boite: (function () { var b = m.getBoundingInfo().boundingBox;" +
    "    return [Math.round(b.minimumWorld.x*100)/100, Math.round(b.minimumWorld.y*100)/100]; })()," +
    "  gele: !!m._isWorldMatrixFrozen } : null; }" +
    "var lui = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
    "var nous = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
    MAGASIN + "var e = __mag('engine');" +
    "return { lui: pose(lui), nous: pose(nous), zoom: e && e.zoom," +
    "  memeMaillage: !!(lui && nous && nous !== lui) };";
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4500);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
      " actif: true, cases: 60 }, '*');");
    await dors(2500);

    const dit = (quand, e) => {
      if (!e.lui || !e.nous) { console.log("  " + quand.padEnd(22) + "maillage manquant"); return null; }
      const d = [e.nous.pos[0] - e.lui.pos[0], e.nous.pos[1] - e.lui.pos[1]];
      console.log("  " + quand.padEnd(22) + "zoom " + String(e.zoom).padStart(4) +
                  "   lui " + JSON.stringify(e.lui.pos.slice(0, 2).map((v) => Math.round(v * 100) / 100)) +
                  "   nous " + JSON.stringify(e.nous.pos.slice(0, 2).map((v) => Math.round(v * 100) / 100)) +
                  "   ÉCART " + JSON.stringify(d.map((v) => Math.round(v * 1000) / 1000)));
      return d;
    };

    const secousses = [
      ["au départ", null],
      ["après zoom 40", 40],
      ["après zoom 200", 200],
      ["après zoom 10", 10],
      ["retour à 100", 100],
    ];
    const ecarts = [];
    for (const [quand, z] of secousses) {
      if (z !== null) {
        await driver.executeScript(MAGASIN + "__mag('engine').setZoom(arguments[0]);", z);
        await dors(2200);
      }
      const e = await driver.executeScript(ETAT);
      const d = dit(quand, e);
      if (d) { ecarts.push({ quand, d, lui: e.lui, nous: e.nous }); }
    }
    const bouge = ecarts.some((e) => Math.abs(e.d[0] - ecarts[0].d[0]) > 0.01 ||
                                     Math.abs(e.d[1] - ecarts[0].d[1]) > 0.01);
    console.log("\n  " + (bouge ? "L'ÉCART BOUGE — nos deux trames dérivent l'une de l'autre"
                                : "l'écart ne bouge pas — pas de dérive de position"));
    if (ecarts[0]) {
      console.log("  échelle : lui " + JSON.stringify(ecarts[0].lui.ech) +
                  ", nous " + JSON.stringify(ecarts[0].nous.ech) +
                  " ; matrice gelée : lui " + ecarts[0].lui.gele + ", nous " + ecarts[0].nous.gele);
    }
    releve("derive.json", ecarts);
    return bouge ? 1 : 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LE GUET SUIT-IL VRAIMENT ? ----------
 *
 * Tous les essais de types relançaient l'extension à la main après chaque
 * changement : ils vérifiaient le PAVAGE, jamais le GUET. Or c'est là que se
 * joue ce que voit quelqu'un qui change de quadrillage en cours de partie — la
 * carte affiche un type, l'extérieur l'autre, et rien ne le dit.
 *
 * Ici on change le type et on ne fait plus rien. On attend, puis on demande si
 * notre trame est toujours celle de Roll20. */
async function suivi() {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  /* CE QU'ON VÉRIFIE A CHANGÉ AVEC LA MÉCANIQUE. Tant qu'on recopiait des
   * segments, « suivre » voulait dire porter les mêmes directions que lui. La
   * grille est peinte : notre maillage est un quad de quatre sommets, et ses
   * directions ne veulent plus rien dire. Ce qui compte désormais : le quad est
   * là, il est VISIBLE sur une grille en lignes et rangé sur un carré, et les
   * uniformes qu'il porte décrivent bien la trame du moment. */
  const MESURE =
    "var S = window.MeshScene;" +
    "var lui2 = (S.meshes||[]).filter(function (m) {" +
    "  return /Grid-Line-System|tabletop-square-grid/.test(m.name); })[0];" +
    "var q = (S.meshes||[]).filter(function (m) { return /^vttk-grille-peinte/.test(m.name); })[0];" +
    "var seg2 = (S.meshes||[]).filter(function (m) { return /^vttk-grille-etendue/.test(m.name); })[0];" +
    "if (lui2) {" +
    "  var mt = q && q.material;" +
    "  var f = mt && mt._floats ? mt._floats : {};" +
    "  var v2 = mt && mt._vectors2Arrays ? mt._vectors2Arrays : {};" +
    "  return { peinte: true, nom: lui2.name," +
    "    carre: /tabletop-square-grid/.test(lui2.name)," +
    "    quad: !!q, visible: q ? q.isVisible : null, segments: !!seg2," +
    "    mode: f.mode, aplati: f.aplati, taille: v2.taille," +
    "    decalage: v2.decalage, origine: v2.origine," +
    "    saPosition: [lui2.position.x, lui2.position.y] };" +
    "}" +
    "return { peinte: true, nom: null };";

  const MESURE_ANCIENNE =
    "var S = window.MeshScene;" +
    "function segs(m) { var p = m.getVerticesData('position'), i = m.getIndices(), o = [], k;" +
    "  for (k = 0; k < i.length / 2; k++) { var a = i[2*k]*3, b = i[2*k+1]*3;" +
    "    o.push([p[a], p[a+1], p[b], p[b+1]]); } return o; }" +
    "var lui = (S.meshes || []).filter(function (m) { return /Grid-Line-System|tabletop-square-grid/.test(m.name); })[0];" +
    "var nous = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); });" +
    "if (!lui) { return { la: false }; }" +
    "var A = lui.getVerticesData ? segs(lui) : [];" +
    /* La SIGNATURE d'une trame : l'ensemble de ses directions de segment,
     * arrondies. Deux types de grille n'ont jamais la même. */
    /* Avec les EFFECTIFS : une direction représentée deux fois est la bordure de
     * la page, qu'on a raison de ne pas recopier ; représentée mille fois, c'est
     * une famille de côtés, et son absence serait un trou béant. Sans ce compte,
     * l'essai criait au défaut pour deux traits de cadre. */
    "function signature(T) { var d = {}, k;" +
    "  for (k = 0; k < T.length; k++) { var s = T[k], ax = s[2]-s[0], ay = s[3]-s[1];" +
    "    if (ax < 0 || (ax === 0 && ay < 0)) { ax = -ax; ay = -ay; }" +
    "    var L = Math.sqrt(ax*ax + ay*ay); if (L < 0.01) { continue; }" +
    "    var c2 = Math.round(ax/L*20) + ',' + Math.round(ay/L*20);" +
    "    d[c2] = (d[c2] || 0) + 1; }" +
    "  return d; }" +
    "function lisible(d) { return Object.keys(d).sort().map(function (k) {" +
    "  return k + '×' + d[k]; }).join('  '); }" +
    "function familles(d, total) { var o = {}, k;" +   // on ignore le décor
    "  for (k in d) { if (d[k] > Math.max(4, total * 0.01)) { o[k] = d[k]; } } return o; }" +
    "var B = nous.length ? segs(nous[0]) : [];" +
    "var dL = signature(A), dN = signature(B);" +
    "return { la: true, nom: lui.name, aNous: nous.length," +
    "  sigLui: lisible(dL), sigNous: lisible(dN)," +
    "  famLui: Object.keys(familles(dL, A.length)).sort().join(' ')," +
    "  famNous: Object.keys(familles(dN, B.length)).sort().join(' ')," +
    "  siens: A.length, notres: B.length };";
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4000);
    avant = await driver.executeScript(
      "return (window.Campaign.activePage().attributes || {}).grid_type;");
    console.log("  type au départ : « " + avant + " » (sera remis)");

    const suite = ["hex", "hexr", "dimetric", "square", "hex"];
    let mauvais = 0;
    for (const t of suite) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", t);
      // On n'envoie RIEN à l'extension : c'est tout l'objet de l'essai.
      await dors(9000);
      const m = await driver.executeScript(MESURE);
      if (!m.nom) { console.log("  " + t.padEnd(10) + " pas de grille"); continue; }
      /* Sur un carré, Roll20 peint lui-même : notre quad doit être rangé. Sur
       * une grille en lignes, il doit être sorti, et son décalage doit valoir la
       * position du maillage du moment — c'est là-dessus que repose tout
       * l'alignement. */
      const cale = !m.decalage || (Math.abs(m.decalage[0] - m.saPosition[0]) < 0.01 &&
                                   Math.abs(m.decalage[1] - m.saPosition[1]) < 0.01);
      const suit = m.carre ? ((!m.quad || m.visible === false) && !m.segments)
                           : (m.quad && m.visible === true && cale);
      if (!suit) { mauvais++; }
      console.log("  " + t.padEnd(10) + (suit ? "SUIT   " : "NE SUIT PAS  ") +
                  m.nom.padEnd(24) +
                  " quad " + String(m.quad).padEnd(6) +
                  " visible " + String(m.visible).padEnd(6) +
                  " mode " + String(m.mode) +
                  (m.taille ? " taille " + JSON.stringify(m.taille.map(
                    (v) => Math.round(v * 100) / 100)) : "") +
                  (m.segments ? "   (+ des SEGMENTS)" : ""));
      if (!suit && m.decalage) {
        console.log("      décalage " + JSON.stringify(m.decalage) +
                    " pour une position " + JSON.stringify(m.saPosition));
      }
    }
    console.log("\n  " + (mauvais ? mauvais + " type(s) où notre trame NE SUIT PAS" : "le guet suit partout"));
    return mauvais ? 1 : 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
      console.log("  type de grille remis à « " + avant + " »");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES MARQUEURS D'ÉTAT : RECONNAISSANCE ----------
 *
 * Les petits pictogrammes qu'on pose sur un token. Avant d'en ajouter, il faut
 * savoir OÙ ils vivent : dans le modèle du token, dans la campagne, dans le DOM,
 * ou dans la scène Babylon. Cette sonde ne modifie RIEN — elle regarde. */
async function marqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(6000);
    const r = await driver.executeScript(
      "var out = {};" +
      "function cles(o, n) { try { return Object.keys(o).slice(0, n || 40); } catch (e) { return null; } }" +

      /* 1. La campagne : y a-t-il un jeu de marqueurs déclaré ? */
      "var C = window.Campaign;" +
      "out.campagne = C ? { classe: C.constructor && C.constructor.name," +
      "  attributs: C.attributes ? cles(C.attributes, 60) : null } : null;" +
      "if (C && C.attributes) {" +
      "  var a = C.attributes;" +
      "  ['token_markers', 'tokenmarkers', 'markers', 'custom_markers'].forEach(function (k) {" +
      "    if (a[k] !== undefined) {" +
      "      out.jeuDeMarqueurs = { cle: k, type: typeof a[k]," +
      "        taille: String(a[k]).length, extrait: String(a[k]).slice(0, 400) }; } }); }" +

      /* 2. d20, qui porte souvent les tables globales. */
      "var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;" +
      "out.d20 = d ? cles(d, 80) : null;" +
      "if (d) { ['token_markers', 'tokenMarkers', 'statusmarkers', 'statusMarkers'].forEach(function (k) {" +
      "  if (d[k] !== undefined) { out.d20marqueurs = { cle: k, type: typeof d[k]," +
      "    n: (d[k] && d[k].length) || null," +
      "    extrait: JSON.stringify(d[k]).slice(0, 500) }; } }); }" +

      /* 3. Les tokens de la page : où sont-ils, et que portent-ils ? */
      "var p = C && C.activePage && C.activePage();" +
      "out.page = p ? { classe: p.constructor && p.constructor.name," +
      "  collections: cles(p, 40) } : null;" +
      "var coll = null, nom = null;" +
      "if (p) { ['thegraphics', 'graphics', 'objects'].forEach(function (k) {" +
      "  if (!coll && p[k] && p[k].models) { coll = p[k]; nom = k; } }); }" +
      "if (coll) {" +
      "  out.tokens = { collection: nom, n: coll.models.length };" +
      "  var t = coll.models.filter(function (m) {" +
      "    return m.attributes && m.attributes.layer === 'objects'; })[0] || coll.models[0];" +
      "  if (t) { out.token = { id: t.id, attributs: cles(t.attributes, 60)," +
      "    statusmarkers: t.attributes.statusmarkers," +
      "    nom: t.attributes.name, calque: t.attributes.layer }; } }" +

      /* 4. Le DOM : la barre de marqueurs existe-t-elle déjà quelque part ? */
      "var s = document.querySelectorAll('[class*=\"marker\"], [class*=\"status\"], [id*=\"marker\"]');" +
      "out.dom = { n: s.length, echantillon: [].slice.call(s, 0, 12).map(function (n2) {" +
      "  return (n2.tagName || '') + '.' + String(n2.className || '').slice(0, 60); }) };" +

      /* 5. La scène : les marqueurs sont-ils dessinés en Babylon ? */
      "var S = window.MeshScene;" +
      "out.scene = S ? { maillages: (S.meshes || []).length," +
      "  noms: (S.meshes || []).map(function (m) { return m.name; })" +
      "    .filter(function (n2) { return /mark|status|token|sprite|overlay/i.test(n2); }).slice(0, 20)," +
      "  textures: (S.textures || []).length } : null;" +
      "return out;");
    console.log(JSON.stringify(r, null, 2).slice(0, 6000));
    releve("marqueurs.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- POSER UN MARQUEUR, ET REMETTRE EN ÉTAT ----------
 *
 * Première expérience qui ÉCRIT. Un token appartient à la campagne : ce qu'on y
 * touche part chez Roll20 et se voit chez les joueurs. On note donc la valeur
 * d'origine AVANT, et on la remet à la fin, quoi qu'il arrive. */
async function poseMarqueur(spec) {
  const tag = spec || "skull";
  const driver = await ouvre(config().visible === true);
  let cible = null, avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(6000);

    /* Le catalogue complet des marqueurs de la campagne, d'abord : on ne pose pas
     * une étiquette au hasard. */
    const jeu = await driver.executeScript(
      "var s = window.Campaign.attributes.token_markers;" +
      "try { return JSON.parse(s).map(function (m) {" +
      "  return { id: m.id, tag: m.tag, nom: m.name, url: m.url }; }); }" +
      "catch (e) { return { erreur: String(e) }; }");
    if (Array.isArray(jeu)) {
      console.log("\n  " + jeu.length + " marqueurs déclarés dans la campagne :");
      console.log("    " + jeu.map((m) => m.tag).join(", "));
      console.log("  premier : " + JSON.stringify(jeu[0]));
    } else { console.log("  jeu illisible : " + JSON.stringify(jeu)); }

    const etat = await driver.executeScript(
      "var C = window.Campaign, p = C.activePage();" +
      "var t = p.thegraphics.models.filter(function (m) {" +
      "  return m.attributes && m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "return { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers };");
    if (!etat) { console.log("  aucun token sur le calque des objets."); return 1; }
    cible = etat.id; avant = etat.avant;
    console.log("\n  token « " + etat.nom + " » (" + etat.id + ")");
    console.log("    statusmarkers avant : " + JSON.stringify(avant));

    const apres = await driver.executeScript(
      "var C = window.Campaign, p = C.activePage();" +
      "var t = p.thegraphics.get(arguments[0]);" +
      "var avant = t.attributes.statusmarkers || '';" +
      "var liste = avant ? avant.split(',') : [];" +
      "if (liste.indexOf(arguments[1]) < 0) { liste.push(arguments[1]); }" +
      "t.save({ statusmarkers: liste.join(',') });" +
      "return t.attributes.statusmarkers;", cible, tag);
    console.log("    statusmarkers après  : " + JSON.stringify(apres));

    await dors(2500);
    const scene = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var m = (S.meshes || []).filter(function (x) { return /marker/i.test(x.name); });" +
      "return { n: m.length, noms: m.map(function (x) { return x.name; }).slice(0, 20)," +
      "  textures: (S.textures || []).map(function (x) { return x.name || x.url || '?'; })" +
      "    .filter(function (n2) { return /icon|marker|d20/i.test(String(n2)); }).slice(0, 10) };");
    console.log("\n  dans la scène après pose :");
    console.log("    " + scene.n + " maillages « marker »");
    scene.noms.forEach((n) => console.log("      " + n));
    if (scene.textures.length) { console.log("    textures : " + scene.textures.join("  ")); }
    await capture(driver, "marqueur-pose.png");
    releve("marqueurs-catalogue.json", jeu);
    return 0;
  } finally {
    if (cible !== null) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] === null ? '' : arguments[1] }); }",
        cible, avant === undefined ? null : avant).catch(() => {});
      await dors(2500);
      console.log("\n  token remis dans son état d'origine : " + JSON.stringify(avant));
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- UN MARQUEUR À NOUS : L'EXPÉRIENCE QUI DÉCIDE ----------
 *
 * Le catalogue des marqueurs est une chaîne JSON dans Campaign.attributes
 * .token_markers : des { id, name, tag, url }. Toute la feature tient à une
 * question : si on y ajoute une entrée À NOUS, avec une image à nous, Roll20
 * la dessine-t-il sur le token ?
 *
 * On l'ajoute SANS SYNCHRONISER — on écrit l'attribut en place, sans .set() ni
 * .save() : rien ne part chez Roll20, rien ne change pour les joueurs. Et on
 * remet tout, catalogue et token, quoi qu'il arrive. */
async function marqueurPerso() {
  const driver = await ouvre(config().visible === true);
  let token = null, avantToken = null, avantCatalogue = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(6500);

    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes && m.attributes.layer === 'objects'; })[0];" +
      "return t ? { id: t.id, nom: t.attributes.name," +
      "  marqueurs: t.attributes.statusmarkers," +
      "  catalogue: C.attributes.token_markers } : null;");
    if (!dep) { console.log("  aucun token."); return 1; }
    token = dep.id; avantToken = dep.marqueurs; avantCatalogue = dep.catalogue;
    console.log("\n  token « " + dep.nom + " », marqueurs actuels : " + JSON.stringify(avantToken));

    // Un pixel rouge en data:, pour ne dépendre d'aucun réseau ni d'aucune CSP.
    const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA" +
                "DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    const r = await driver.executeScript(
      "var C = window.Campaign, tag = 'vttk-essai';" +
      "var liste = JSON.parse(C.attributes.token_markers);" +
      "var maxId = liste.reduce(function (a, m) { return Math.max(a, m.id || 0); }, 0);" +
      "liste.push({ id: maxId + 1, name: tag, tag: tag, url: arguments[1] });" +
      /* EN PLACE, sans .set() : aucun événement, aucune écriture chez Roll20. */
      "C.attributes.token_markers = JSON.stringify(liste);" +
      "var t = C.activePage().thegraphics.get(arguments[0]);" +
      "var av = t.attributes.statusmarkers || '';" +
      "var l2 = av ? av.split(',') : [];" +
      "l2.push(tag);" +
      "t.save({ statusmarkers: l2.join(',') });" +
      "return { catalogue: JSON.parse(C.attributes.token_markers).length," +
      "  marqueurs: t.attributes.statusmarkers };", token, IMG);
    console.log("  catalogue porté à " + r.catalogue + " marqueurs ; token : " + JSON.stringify(r.marqueurs));

    await dors(4000);
    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes || []).filter(function (m) { return /group_marker/i.test(m.name); });" +
      "function decris(m) {" +
      "  var enfants = m.getChildMeshes ? m.getChildMeshes() : [];" +
      "  return { nom: m.name, enfants: enfants.length," +
      "    detail: enfants.slice(0, 10).map(function (c) {" +
      "      var tx = c.material && (c.material.diffuseTexture || c.material.emissiveTexture ||" +
      "        (c.material.getActiveTextures && c.material.getActiveTextures()[0]));" +
      "      return { nom: c.name, visible: c.isVisible," +
      "        texture: tx ? String(tx.name || tx.url || '?').slice(0, 70) : null }; }) }; }" +
      "return { groupes: g.map(decris)," +
      "  toutesTextures: (S.textures || []).map(function (x) {" +
      "    return String(x.name || x.url || '?').slice(0, 70); }).slice(0, 25) };");
    console.log("\n  groupes de marqueurs dans la scène :");
    console.log(JSON.stringify(vu, null, 1).slice(0, 2500));
    await capture(driver, "marqueur-perso.png");
    releve("marqueur-perso.json", vu);
    return 0;
  } finally {
    if (token !== null) {
      await driver.executeScript(
        "var C = window.Campaign;" +
        "if (arguments[2] !== null) { C.attributes.token_markers = arguments[2]; }" +
        "var t = C.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] === null ? '' : arguments[1] }); }",
        token, avantToken === undefined ? null : avantToken,
        avantCatalogue === undefined ? null : avantCatalogue).catch(() => {});
      await dors(2500);
      console.log("\n  catalogue et token remis dans leur état d'origine.");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- PAR OÙ LES MARQUEURS SONT-ILS DESSINÉS ? ----------
 *
 * Lecture seule, et c'est délibéré : écrire sur un token fait recharger
 * l'éditeur, qui revient parfois sur une AUTRE page — on ne fait pas ça à la
 * partie de quelqu'un pour regarder un maillage. Le token porte déjà un marqueur
 * nommé ; tout ce qu'il faut comprendre est là. */
async function rendudesMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const r = await driver.executeScript(
      "var S = window.MeshScene, out = {};" +
      "var C = window.Campaign, p = C && C.activePage && C.activePage();" +
      "out.page = p ? { nom: p.attributes.name, id: p.id } : null;" +
      "out.tokens = p ? p.thegraphics.models.map(function (m) {" +
      "  return { nom: m.attributes.name, calque: m.attributes.layer," +
      "    marqueurs: m.attributes.statusmarkers }; }) : null;" +

      /* Tout ce qui, dans la scène, porte « marker » — et ce qu'il est vraiment. */
      "out.maillages = (S.meshes || []).filter(function (m) { return /marker/i.test(m.name); })" +
      "  .map(function (m) {" +
      "    return { nom: m.name, classe: m.getClassName && m.getClassName()," +
      "      visible: m.isVisible, sommets: m.getTotalVertices && m.getTotalVertices()," +
      "      fines: m.thinInstanceCount || 0," +
      "      instances: (m.instances && m.instances.length) || 0," +
      "      enfants: (m.getChildMeshes && m.getChildMeshes().length) || 0," +
      "      materiau: m.material ? { nom: m.material.name," +
      "        classe: m.material.constructor && m.material.constructor.name," +
      "        textures: (m.material.getActiveTextures ? m.material.getActiveTextures() : [])" +
      "          .map(function (t) { return String(t.name || t.url || '?').slice(0, 90); }) } : null }; });" +

      "out.sprites = (S.spriteManagers || []).map(function (sm) {" +
      "  return { nom: sm.name, n: (sm.sprites && sm.sprites.length) || 0," +
      "    cellule: [sm.cellWidth, sm.cellHeight]," +
      "    texture: sm.texture ? String(sm.texture.name || sm.texture.url || '?').slice(0, 90) : null }; });" +
      "out.textures = (S.textures || []).map(function (t) {" +
      "  return { nom: String(t.name || '?').slice(0, 80), url: String(t.url || '').slice(0, 80)," +
      "    taille: t.getSize ? [t.getSize().width, t.getSize().height] : null }; });" +
      "out.materiaux = (S.materials || []).map(function (m) { return m.name; }).slice(0, 40);" +
      "out.calques = (S.layers || []).length;" +

      /* Le moteur de Roll20 : ce qu'il expose autour des marqueurs. */
      "var d = (window.currentPlayer && window.currentPlayer.d20) || null;" +
      "if (d && d.engine) { out.engine = Object.keys(d.engine).filter(function (k) {" +
      "  return /mark|status|token|sprite|atlas|icon/i.test(k); }).slice(0, 30); }" +
      "if (d && d.canvas_overlay) { out.overlay = Object.keys(d.canvas_overlay).slice(0, 30); }" +
      "return out;");
    console.log(JSON.stringify(r, null, 1).slice(0, 7000));
    releve("rendu-marqueurs.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- TROIS FAITS À ÉTABLIR AVANT D'ÉCRIRE LA FEATURE ----------
 *
 *  1. Écrire un marqueur fait-il RECHARGER l'éditeur ? Deux essais l'ont laissé
 *     croire, et si c'est vrai la feature est morte-née. On compare save() —
 *     ce qu'on avait employé — et set(), qui n'envoie que le delta.
 *  2. Que devient une étiquette que Roll20 NE CONNAÎT PAS ? Rien, ou une image
 *     cassée ? Ça décide si nos marqueurs peuvent voyager dans son champ.
 *  3. Y a-t-il un objet partagé qu'on puisse posséder pour y ranger le
 *     catalogue — un texte, une note, quelque chose que tous les joueurs
 *     reçoivent ?
 *
 * Une seule écriture, sur un token, remise aussitôt. */
async function faitsMarqueurs() {
  const driver = await ouvre(config().visible === true);
  let token = null, avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    /* 3. D'abord le lecture seule : où pourrait vivre un catalogue partagé ? */
    const ou = await driver.executeScript(
      "var C = window.Campaign, out = {};" +
      "out.collections = Object.keys(C).filter(function (k) {" +
      "  try { return C[k] && C[k].models && typeof C[k].add === 'function'; } catch (e) { return false; } });" +
      "out.detail = {};" +
      "out.collections.forEach(function (k) {" +
      "  try { out.detail[k] = { n: C[k].models.length," +
      "    attributs: C[k].models[0] ? Object.keys(C[k].models[0].attributes).slice(0, 25) : null }; }" +
      "  catch (e) {} });" +
      "var p = C.activePage();" +
      "out.page = { attributs: Object.keys(p.attributes).slice(0, 40) };" +
      "return out;");
    console.log("\n  collections de la campagne :");
    (ou.collections || []).forEach((k) => {
      const d = ou.detail[k] || {};
      console.log("    " + k.padEnd(18) + " " + String(d.n).padStart(4) + " objets" +
                  (d.attributs ? "   attributs : " + d.attributs.slice(0, 8).join(", ") : ""));
    });

    /* 1 et 2 : une écriture par set(), une étiquette inconnue, et on regarde. */
    const dep = await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes && m.attributes.layer === 'objects'; })[0];" +
      "return t ? { id: t.id, nom: t.attributes.name, av: t.attributes.statusmarkers," +
      "  chargement: !!document.querySelector('.loading, #loading-overlay, [class*=\"chargement\"]') } : null;");
    if (!dep) { console.log("  aucun token."); return 1; }
    token = dep.id; avant = dep.av;
    console.log("\n  token « " + dep.nom + " » — marqueurs : " + JSON.stringify(avant));

    await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "var av = t.attributes.statusmarkers || '';" +
      // set() et non save() : on n'envoie que ce qui change.
      "t.set('statusmarkers', (av ? av + ',' : '') + 'vttk_inconnu_a.org/x.png');", token);
    await dors(3000);

    const apres = await driver.executeScript(
      "var S = window.MeshScene, C = window.Campaign;" +
      "var t = C.activePage().thegraphics.get(arguments[0]);" +
      "var g = (S.meshes || []).filter(function (m) { return /group_marker/i.test(m.name); });" +
      "return { marqueurs: t ? t.attributes.statusmarkers : null," +
      "  rechargement: /Chargement|Loading/i.test(document.body.textContent.slice(0, 4000))," +
      "  page: C.activePage().attributes.name," +
      "  groupes: g.map(function (m) { return { nom: m.name, sommets: m.getTotalVertices()," +
      "    instances: (m.instances && m.instances.length) || 0, visible: m.isVisible }; })," +
      "  erreurs: (window.__vtErreurs || []).slice(-5) };", token);
    console.log("    après set() : " + JSON.stringify(apres.marqueurs));
    console.log("    page affichée : « " + apres.page + " »");
    console.log("    rechargement en cours : " + apres.rechargement);
    console.log("    groupes de marqueurs : " + JSON.stringify(apres.groupes));
    await capture(driver, "marqueur-inconnu.png");
    return 0;
  } finally {
    if (token !== null) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.set('statusmarkers', arguments[1] === null ? '' : arguments[1]); }",
        token, avant === undefined ? null : avant).catch(() => {});
      await dors(2000);
      console.log("\n  token remis : " + JSON.stringify(avant));
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- L'INTERFACE DES MARQUEURS DE ROLL20 ----------
 *
 * Deux questions, et la première décide de tout : quand un joueur touche un
 * marqueur par SON menu, réécrit-il tout le champ statusmarkers à partir de sa
 * seule liste — auquel cas il effacerait les nôtres — ou n'y touche-t-il qu'en
 * delta ? Lecture seule ici : on cherche par où passe l'écriture. */
async function uiMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const r = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || null, out = {};" +
      "function cles(o, n) { try { return Object.keys(o).slice(0, n || 60); } catch (e) { return null; } }" +
      "out.d20 = d ? cles(d, 60) : null;" +
      "out.engine = d && d.engine ? cles(d.engine, 80) : null;" +
      "out.tokenEditor = d && d.token_editor ? cles(d.token_editor, 60) : null;" +
      "out.ouvreMenu = d ? typeof d.openVueContextMenu : null;" +
      /* Les magasins Pinia : c'est là que vit l'état de l'interface Vue. */
      "var racines = [].slice.call(document.querySelectorAll('[data-v-app]'));" +
      "var pinia = null;" +
      "for (var i = 0; i < racines.length && !pinia; i++) {" +
      "  try { var a = racines[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s) { pinia = p; } } catch (e) {} }" +
      "if (pinia) {" +
      "  out.magasins = [];" +
      "  pinia._s.forEach(function (st, nom) {" +
      "    var k = [];" +
      "    try { k = Object.keys(st).filter(function (x) { return x[0] !== '$' && x[0] !== '_'; }); } catch (e) {}" +
      "    out.magasins.push({ nom: nom, n: k.length," +
      "      interessant: k.filter(function (x) { return /mark|status|token|select|menu|context/i.test(x); }) }); } ); }" +
      /* Ce que le DOM montre autour de la sélection. */
      "out.domSelection = [].slice.call(document.querySelectorAll('[class*=\"context\"], [class*=\"radial\"], [class*=\"token-\"]'))" +
      "  .slice(0, 15).map(function (n) { return n.tagName + '.' + String(n.className).slice(0, 70); });" +
      "return out;");

    console.log("\n  d20.openVueContextMenu : " + r.ouvreMenu);
    console.log("\n  d20.engine :\n    " + (r.engine || []).join(", "));
    console.log("\n  d20.token_editor :\n    " + (r.tokenEditor || []).join(", "));
    console.log("\n  magasins Pinia qui parlent de marqueurs, de sélection ou de menu :");
    (r.magasins || []).filter((m) => m.interessant.length).forEach((m) => {
      console.log("    " + m.nom.padEnd(28) + " → " + m.interessant.join(", "));
    });
    console.log("\n  tous les magasins : " + (r.magasins || []).map((m) => m.nom).join(", "));
    releve("ui-marqueurs.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LE CODE QUI POSE UN MARQUEUR ----------
 *
 * d20.token_editor.toggleTokenMarker est la fonction que SON menu appelle.
 * Sa source, même minifiée, dit ce qu'on veut savoir : réécrit-elle tout le
 * champ à partir de sa liste — et efface donc nos étiquettes — ou ne fait-elle
 * qu'ajouter et retirer ? */
async function codeMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const r = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || null, out = {};" +
      "var te = d && d.token_editor;" +
      "function src(f) { try { return String(f).slice(0, 2600); } catch (e) { return null; } }" +
      "if (te) {" +
      "  out.toggle = src(te.toggleTokenMarker);" +
      "  out.showMenu = src(te.showTokenMarkerMenu);" +
      "  out.taille = te.statusicon_size;" +
      "  out.pret = te.token_markers_ready;" +
      "  out.couleurs = te.colorMarkers;" +
      "  try { out.markers = (te.token_markers || []).slice(0, 3); } catch (e) {}" +
      "  try { out.nMarkers = (te.token_markers || []).length; } catch (e) {} }" +
      /* Le magasin campaign : la liste que l'interface Vue consomme. */
      "var racines = [].slice.call(document.querySelectorAll('[data-v-app]')), pinia = null, i;" +
      "for (i = 0; i < racines.length && !pinia; i++) {" +
      "  try { var a = racines[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s) { pinia = p; } } catch (e) {} }" +
      "if (pinia) { var c = pinia._s.get('campaign');" +
      "  if (c) { out.magasin = { position: c.tokenMarkerPosition," +
      "    type: typeof c.tokenMarkerData," +
      "    n: (c.tokenMarkerData && c.tokenMarkerData.length) || null," +
      "    extrait: JSON.stringify(c.tokenMarkerData).slice(0, 300)," +
      "    setteur: typeof c.setTokenMarkerData }; } }" +
      "return out;");

    console.log("\n  statusicon_size : " + r.taille + "   markers prêts : " + r.pret);
    console.log("  marqueurs connus de token_editor : " + r.nMarkers);
    console.log("  couleurs : " + JSON.stringify(r.couleurs));
    console.log("\n  magasin campaign.tokenMarkerData : " + JSON.stringify(r.magasin, null, 1));
    console.log("\n  ---- source de toggleTokenMarker ----\n" + (r.toggle || "(illisible)"));
    releve("code-marqueurs.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- INJECTER UN MARQUEUR DANS LA LISTE CÔTÉ CLIENT ----------
 *
 * Le magasin Pinia « campaign » porte tokenMarkerData et son setteur. C'est de
 * l'état CLIENT : rien n'y part chez Roll20. Si son rendu consomme cette liste,
 * on peut y ajouter les nôtres et tout vient gratuitement — son menu les
 * listerait, son atlas les dessinerait, son toggle les poserait par delta.
 *
 * On teste avec une image réelle et visible, pas un pixel : sans quoi on ne
 * saura pas distinguer « ça marche » de « ça ne dessine rien ». */
async function injecteMarqueur() {
  const driver = await ouvre(config().visible === true);
  let token = null, avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    // Un disque orange de 64 px, en SVG puis en data: — aucun réseau, bien visible.
    const IMG = "data:image/svg+xml;base64," + Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<circle cx="32" cy="32" r="28" fill="#ff7a18" stroke="#fff" stroke-width="6"/>' +
      '<rect x="26" y="14" width="12" height="26" rx="6" fill="#fff"/>' +
      '<circle cx="32" cy="48" r="6" fill="#fff"/></svg>').toString("base64");

    const r = await driver.executeScript(
      "var racines = [].slice.call(document.querySelectorAll('[data-v-app]')), pinia = null, i;" +
      "for (i = 0; i < racines.length && !pinia; i++) {" +
      "  try { var a = racines[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s) { pinia = p; } } catch (e) {} }" +
      "var c = pinia && pinia._s.get('campaign');" +
      "if (!c) { return { erreur: 'magasin campaign introuvable' }; }" +
      "var avant = (c.tokenMarkerData || []).slice();" +
      "var neuf = avant.concat([{ tag: 'vttk-essai', name: 'VTTinker essai', url: arguments[0] }]);" +
      "c.setTokenMarkerData(neuf);" +
      "return { avantN: avant.length, apresN: (c.tokenMarkerData || []).length," +
      "  dernier: JSON.stringify((c.tokenMarkerData || [])[(c.tokenMarkerData || []).length - 1]).slice(0, 120) };",
      IMG);
    console.log("\n  tokenMarkerData : " + r.avantN + " → " + r.apresN);
    console.log("  dernier : " + r.dernier);
    if (r.erreur) { console.log("  " + r.erreur); return 1; }

    const dep = await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes && m.attributes.layer === 'objects'; })[0];" +
      "return t ? { id: t.id, nom: t.attributes.name, av: t.attributes.statusmarkers } : null;");
    token = dep.id; avant = dep.av;
    console.log("  token « " + dep.nom + " » — avant : " + JSON.stringify(avant));

    await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "var av = t.attributes.statusmarkers || '';" +
      "t.set('statusmarkers', (av ? av + ',' : '') + 'vttk-essai');", token);
    await dors(4000);

    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes || []).filter(function (m) { return /group_marker/i.test(m.name); })" +
      "  .map(function (m) { return { nom: m.name, instances: (m.instances || []).length," +
      "    fines: m.thinInstanceCount || 0, sommets: m.getTotalVertices() }; });" +
      "return { groupes: g, textures: (S.textures || []).map(function (t) {" +
      "  return String(t.name || t.url || '?').slice(0, 60); }) };");
    console.log("\n  après pose : " + JSON.stringify(vu.groupes));
    console.log("  textures : " + vu.textures.join(" | "));
    await capture(driver, "marqueur-injecte.png");
    return 0;
  } finally {
    if (token !== null) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.set('statusmarkers', arguments[1] === null ? '' : arguments[1]); }",
        token, avant === undefined ? null : avant).catch(() => {});
      await dors(2000);
      console.log("\n  token remis : " + JSON.stringify(avant) +
                  "  (la liste injectée est côté client : elle disparaît au rechargement)");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- ROLL20 ACCEPTE-T-IL UNE IMAGE ÉTRANGÈRE ? ----------
 *
 * Question préalable à toute source d'images extérieure — Discord ou autre. La
 * page de Roll20 a une politique de sécurité de contenu : si elle interdit
 * img-src vers un autre domaine, aucun marqueur personnalisé venu d'ailleurs ne
 * pourra être dessiné, et il faudra tout faire passer par des data: URI.
 *
 * On mesure trois choses distinctes, qu'on confond souvent :
 *   - la CSP laisse-t-elle CHARGER l'image (balise <img>) ;
 *   - le CORS laisse-t-il la LIRE dans WebGL sans souiller le contexte ;
 *   - Babylon en fait-il une texture prête à l'emploi. */
async function imageEtrangere(spec) {
  const url = spec || "https://cdn.discordapp.com/embed/avatars/0.png";
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(6000);
    driver.manage().setTimeouts({ script: 40000 });
    const r = await driver.executeAsyncScript(
      "var fini = arguments[arguments.length - 1], url = arguments[0];" +
      "var out = { url: url };" +
      /* La politique déclarée par la page, si elle est lisible. */
      "var m = document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]');" +
      "out.cspMeta = m ? m.content.slice(0, 300) : null;" +
      "var fait = 0, total = 3;" +
      "function peutEtre() { if (++fait >= total) { fini(out); } }" +
      /* 1. Une simple balise image : c'est la CSP img-src qui répond. */
      "var im = new Image();" +
      "im.onload = function () { out.img = { ok: true, l: im.naturalWidth, h: im.naturalHeight }; peutEtre(); };" +
      "im.onerror = function () { out.img = { ok: false }; peutEtre(); };" +
      "im.src = url;" +
      /* 2. La même, en demandant le CORS : c'est ce qu'exige WebGL. */
      "var ic = new Image();" +
      "ic.crossOrigin = 'anonymous';" +
      "ic.onload = function () { out.cors = { ok: true, l: ic.naturalWidth }; peutEtre(); };" +
      "ic.onerror = function () { out.cors = { ok: false }; peutEtre(); };" +
      "ic.src = url;" +
      /* 3. Et une texture Babylon dans SA scène, qui est le but réel. */
      "try {" +
      "  var S = window.MeshScene;" +
      "  var q = (S.meshes || []).filter(function (x) { return x.material; })[0];" +
      "  var Tex = null;" +
      "  for (var i = 0; i < (S.textures || []).length && !Tex; i++) {" +
      "    if (S.textures[i].constructor && S.textures[i].constructor.name) { Tex = S.textures[i].constructor; } }" +
      "  if (!Tex) { out.texture = { ok: false, raison: 'classe Texture introuvable' }; peutEtre(); }" +
      "  else {" +
      "    var t = new Tex(url, S, true, false, undefined," +
      "      function () { out.texture = { ok: true, taille: t.getSize && [t.getSize().width, t.getSize().height] };" +
      "        try { t.dispose(); } catch (e) {} peutEtre(); }," +
      "      function (msg) { out.texture = { ok: false, raison: String(msg).slice(0, 120) };" +
      "        try { t.dispose(); } catch (e) {} peutEtre(); });" +
      "    t.name = 'vttk-essai-image'; } }" +
      "catch (e) { out.texture = { ok: false, raison: String(e && e.message || e) }; peutEtre(); }" +
      "setTimeout(function () { fini(out); }, 12000);", url);

    console.log("\n  " + r.url);
    console.log("    <img> simple          : " + JSON.stringify(r.img));
    console.log("    <img crossOrigin>     : " + JSON.stringify(r.cors));
    console.log("    texture Babylon       : " + JSON.stringify(r.texture));
    if (r.cspMeta) { console.log("    CSP déclarée en meta  : " + r.cspMeta); }
    releve("image-etrangere.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- OÙ ROLL20 POSE SES PICTOGRAMMES ----------
 *
 * Lecture seule. Pour dessiner les nôtres à côté des siens sans qu'on voie la
 * différence, il faut la géométrie exacte : le maillage du groupe de marqueurs
 * d'un token, comparé au modèle du token lui-même (left, top, width, height).
 * On mesure, on ne place pas au jugé. */
async function placeMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const r = await driver.executeScript(
      "var S = window.MeshScene, C = window.Campaign;" +
      "var p = C.activePage();" +
      "var out = { page: p.attributes.name, tokens: [] };" +
      "var g = (S.meshes || []).filter(function (m) { return /group_marker/i.test(m.name); });" +
      "out.groupes = g.map(function (m) {" +
      "  var b = m.getBoundingInfo().boundingBox;" +
      "  return { nom: m.name," +
      "    position: [m.position.x, m.position.y, m.position.z]," +
      "    echelle: [m.scaling.x, m.scaling.y]," +
      "    boite: [b.minimumWorld.x, b.minimumWorld.y, b.maximumWorld.x, b.maximumWorld.y]," +
      "    instances: (m.instances || []).length, sommets: m.getTotalVertices() }; });" +
      "p.thegraphics.models.forEach(function (t) {" +
      "  var a = t.attributes;" +
      "  if (a.layer !== 'objects') { return; }" +
      "  out.tokens.push({ id: t.id, nom: a.name, marqueurs: a.statusmarkers," +
      "    gauche: a.left, haut: a.top, largeur: a.width, hauteur: a.height," +
      "    rotation: a.rotation, echelleMarqueur: a.scaleX }); });" +
      /* Le maillage de grille sert de référence de repère : on connaît déjà son
       * décalage local→monde, et nos quads devront vivre dans le même. */
      "var gr = (S.meshes || []).filter(function (m) {" +
      "  return /Grid-Line-System|tabletop-square-grid/.test(m.name); })[0];" +
      "out.grille = gr ? { nom: gr.name, position: [gr.position.x, gr.position.y, gr.position.z] } : null;" +
      /* Et le maillage du token lui-même, pour savoir dans quel repère il vit. */
      "out.tokensScene = (S.meshes || []).filter(function (m) {" +
      "  return /objects - /.test(m.name) && !/marker/.test(m.name); })" +
      "  .slice(0, 4).map(function (m) {" +
      "    var b = m.getBoundingInfo().boundingBox;" +
      "    return { nom: m.name.slice(0, 60), position: [m.position.x, m.position.y, m.position.z]," +
      "      boite: [Math.round(b.minimumWorld.x), Math.round(b.minimumWorld.y)," +
      "              Math.round(b.maximumWorld.x), Math.round(b.maximumWorld.y)] }; });" +
      "return out;");
    console.log("\n  page « " + r.page + " »");
    console.log("\n  tokens (modèle Roll20) :");
    r.tokens.forEach((t) => console.log("    " + String(t.nom).padEnd(22) +
      " g=" + t.gauche + " h=" + t.haut + " " + t.largeur + "×" + t.hauteur +
      "  marqueurs=" + JSON.stringify(t.marqueurs)));
    console.log("\n  groupes de marqueurs (scène) :");
    r.groupes.forEach((g) => console.log("    " + JSON.stringify(g)));
    console.log("\n  maillages de tokens (scène) :");
    r.tokensScene.forEach((m) => console.log("    " + JSON.stringify(m)));
    console.log("\n  grille (repère de référence) : " + JSON.stringify(r.grille));
    releve("place-marqueurs.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LE PAS ENTRE PICTOGRAMMES, ET CE QUI LES FAIT GRANDIR ----------
 *
 * Un seul marqueur ne dit ni le sens de la rangée, ni l'écart. Et 19 unités de
 * monde, ça peut être 19 fixes, 19 proportionnels au token, ou 19 qui se
 * compensent au zoom. Trois questions, trois manipulations : on en pose
 * plusieurs, on compare gros token et petit token, on change le zoom.
 *
 * On repose l'état de départ à la fin — c'est la partie de l'auteur. */
async function pasMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const r = await driver.executeScript(
      "var S = window.MeshScene, C = window.Campaign, p = C.activePage();" +
      "var out = { etapes: [] };" +
      "function boites() {" +
      "  return (S.meshes || []).filter(function (m) { return /group_marker/i.test(m.name); })" +
      "    .map(function (m) { var b = m.getBoundingInfo().boundingBox;" +
      "      return { id: m.name.replace(/^.*group_marker_/, '')," +
      "        x: [+b.minimumWorld.x.toFixed(2), +b.maximumWorld.x.toFixed(2)]," +
      "        y: [+b.minimumWorld.y.toFixed(2), +b.maximumWorld.y.toFixed(2)]," +
      "        sommets: m.getTotalVertices(), instances: (m.instances || []).length," +
      "        fines: m.thinInstanceCount || 0 }; }); }" +
      "var toks = p.thegraphics.models.filter(function (t) { return t.attributes.layer === 'objects'; });" +
      "var gros = toks.filter(function (t) { return t.attributes.width >= 140; })[0];" +
      "var petit = toks.filter(function (t) { return t.attributes.width <= 70; })[0];" +
      "out.gros = gros && { g: gros.attributes.left, h: gros.attributes.top, l: gros.attributes.width, avant: gros.attributes.statusmarkers };" +
      "out.petit = petit && { g: petit.attributes.left, h: petit.attributes.top, l: petit.attributes.width, avant: petit.attributes.statusmarkers };" +
      "window.__vtAvant = { gros: gros && gros.attributes.statusmarkers, petit: petit && petit.attributes.statusmarkers };" +
      /* Trois marqueurs sur le gros, deux sur le petit : le pas se lit dans
       * l'écart entre les boîtes, le sens dans leur ordre.
       *
       * save() et pas set() : set() n'a rien redessiné du tout à l'essai
       * précédent — un seul quad, inchangé. C'est save() qui fait le tour
       * complet chez Roll20. */
      /* DES ÉTIQUETTES QUI EXISTENT VRAIMENT. « red », « blue », « green » sont
       * les pastilles par défaut de Roll20, mais cette campagne a son propre
       * jeu de 47, et j'ai déjà établi qu'une étiquette inconnue est ignorée
       * SANS UN MOT. On prend donc les siennes. */
      "var cat = []; try { cat = JSON.parse(C.attributes.token_markers).map(function (m) { return m.tag; }); } catch (e) {}" +
      "out.catalogue = cat.slice(0, 8); out.nCatalogue = cat.length;" +
      "var trois = cat.slice(0, 3).join(','), deux = cat.slice(0, 2).join(',');" +
      "out.pose = { gros: trois, petit: deux };" +
      "if (gros) { gros.save({ statusmarkers: trois }); }" +
      "if (petit) { petit.save({ statusmarkers: deux }); }" +
      "return out;");
    console.log("\n  catalogue : " + r.nCatalogue + " étiquettes, dont " + JSON.stringify(r.catalogue));
    console.log("  posé : " + JSON.stringify(r.pose));
    await dors(2500);
    const apres = await driver.executeScript(
      "var S = window.MeshScene;" +
      /* La boîte du PARENT seul ne dit rien s'il a des enfants : on descend la
       * hiérarchie, et on relève chaque quad séparément. */
      "function decris(m) { var b = m.getBoundingInfo().boundingBox;" +
      "  var h = m.getHierarchyBoundingVectors ? m.getHierarchyBoundingVectors() : null;" +
      "  return { nom: m.name.replace(/^instance-0-objects - 0_/, '')," +
      "    x: [+b.minimumWorld.x.toFixed(2), +b.maximumWorld.x.toFixed(2)]," +
      "    y: [+b.minimumWorld.y.toFixed(2), +b.maximumWorld.y.toFixed(2)]," +
      "    hier: h ? [+h.min.x.toFixed(2), +h.min.y.toFixed(2), +h.max.x.toFixed(2), +h.max.y.toFixed(2)] : null," +
      "    visible: m.isVisible, actif: m.isEnabled ? m.isEnabled() : null," +
      "    sommets: m.getTotalVertices(), fines: m.thinInstanceCount || 0," +
      "    uv: (function () { try { var u = m.getVerticesData('uv');" +
      "      return u ? Array.prototype.slice.call(u).map(function (v) { return +v.toFixed(3); }) : null; }" +
      "      catch (e) { return null; } })()," +
      "    enfants: (m.getChildMeshes ? m.getChildMeshes() : []).map(function (c) {" +
      "      var cb = c.getBoundingInfo().boundingBox;" +
      "      return { nom: c.name.slice(-30)," +
      "        x: [+cb.minimumWorld.x.toFixed(2), +cb.maximumWorld.x.toFixed(2)]," +
      "        y: [+cb.minimumWorld.y.toFixed(2), +cb.maximumWorld.y.toFixed(2)] }; }) }; }" +
      "function boites() {" +
      "  return (S.meshes || []).filter(function (m) { return /marker/i.test(m.name); }).map(decris); }" +
      "window.__vtBoites = boites;" +
      /* Ce que le modèle porte VRAIMENT après save : si l'écriture n'a pas
       * pris, inutile de chercher plus loin du côté de la scène. */
      "var p = window.Campaign.activePage();" +
      "var lus = p.thegraphics.models.filter(function (t) { return t.attributes.layer === 'objects'; })" +
      "  .map(function (t) { return t.attributes.name + ' [' + t.attributes.width + '] = ' + JSON.stringify(t.attributes.statusmarkers); });" +
      "return { boites: boites(), lus: lus };");
    console.log("\n  relu sur les modèles :");
    apres.lus.forEach((l) => console.log("    " + l));
    console.log("\n  maillages « marker » :");
    apres.boites.forEach((b) => console.log("    " + JSON.stringify(b)));
    /* Le zoom : si la boîte monde ne bouge pas, la taille est en unités de
     * plateau et notre quad n'aura aucune compensation à faire. */
    const zoomAvant = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "window.__vtMag = mag; var st = mag('engine'); return st ? st.zoom : null;");
    await driver.executeScript(
      "var st = window.__vtMag('engine'); if (st && st.setZoom) { st.setZoom(220); }");
    await dors(1800);
    const auZoom = await driver.executeScript(
      "var st = window.__vtMag('engine');" +
      "return { zoom: st ? st.zoom : null, boites: window.__vtBoites ? window.__vtBoites() : null };");
    console.log("\n  zoom " + zoomAvant + " → " + (auZoom && auZoom.zoom) + " :");
    ((auZoom && auZoom.boites) || []).forEach((b) => console.log("    " + JSON.stringify(b)));
    /* On remet exactement ce qu'on a trouvé. */
    await driver.executeScript(
      "var C = window.Campaign, p = C.activePage(), a = window.__vtAvant || {};" +
      "p.thegraphics.models.forEach(function (t) {" +
      "  if (t.attributes.layer !== 'objects') { return; }" +
      "  if (t.attributes.width >= 140 && a.gros !== undefined) { t.save({ statusmarkers: a.gros || '' }); }" +
      "  if (t.attributes.width <= 70 && a.petit !== undefined) { t.save({ statusmarkers: a.petit || '' }); } });" +
      "var st = window.__vtMag('engine'); if (st && st.setZoom) { st.setZoom(" + (zoomAvant || 100) + "); }");
    releve("pas-marqueurs.json", { apres, auZoom, zoomAvant });
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LES DOCUMENTS DE LA CAMPAGNE, POUR PARTAGER LE CATALOGUE ----------
 *
 * L'étiquette d'un marqueur voyage jusqu'aux autres joueurs — Roll20 diffuse
 * `statusmarkers` comme les siennes — mais elle ne dit pas QUELLE image. Il faut
 * donc un endroit partagé où ranger la correspondance étiquette → adresse.
 *
 * Un document (« handout ») est le seul candidat raisonnable : il se partage, il
 * porte du texte, et il n'engage rien de ce que Roll20 dessine. Reste à savoir
 * comment on le lit, comment on l'écrit, et surtout ce qu'un JOUEUR peut en
 * faire — le MJ pouvant tout, c'est l'autre cas qui décide du dessin.
 *
 * CETTE PASSE NE CRÉE RIEN. Elle regarde la collection, ses champs, et la façon
 * dont le texte se lit. On n'écrira qu'après avoir vu. */
async function partageMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    const r = await driver.executeScript(
      "var C = window.Campaign, out = {};" +
      /* Où est la collection ? On ne suppose pas le nom. */
      "out.collections = Object.keys(C).filter(function (k) {" +
      "  var v = C[k];" +
      "  return v && v.models && typeof v.length === 'number'; });" +
      "var H = C.handouts || null;" +
      "out.handouts = H ? { n: H.length, aCreer: typeof H.create," +
      "  aAjouter: typeof H.add, url: H.url || null } : null;" +
      "if (H && H.models.length) {" +
      "  var h = H.models[0];" +
      "  out.exemple = { id: h.id, champs: Object.keys(h.attributes)," +
      "    nom: h.attributes.name, journaux: h.attributes.inplayerjournals," +
      "    controle: h.attributes.controlledby, archive: h.attributes.archived };" +
      "  out.methodes = Object.keys(h).filter(function (k) { return typeof h[k] === 'function'; }).slice(0, 20);" +
      /* Les notes ne sont pas dans attributes : Roll20 les va chercher. */
      "  out.aGetBlob = typeof h.get === 'function';" +
      "}" +
      /* Qui sommes-nous ? Un joueur ne pourra pas créer de document. */
      "var p = window.currentPlayer;" +
      "out.moi = p ? { id: p.id, nom: p.attributes && p.attributes.displayname," +
      "  mj: !!(window.is_gm || (C.attributes && C.attributes.gm))," +
      "  cles: Object.keys(p.attributes || {}).slice(0, 14) } : null;" +
      "out.estMJ = typeof window.is_gm !== 'undefined' ? window.is_gm : null;" +
      "return out;");
    console.log("\n  collections de la campagne : " + JSON.stringify(r.collections));
    console.log("  handouts : " + JSON.stringify(r.handouts));
    console.log("  exemple  : " + JSON.stringify(r.exemple));
    console.log("  méthodes : " + JSON.stringify(r.methodes));
    console.log("  moi      : " + JSON.stringify(r.moi) + " ; is_gm = " + r.estMJ);

    /* Lire le texte d'un document : c'est asynchrone chez Roll20, et c'est le
     * point qui décide de toute la mécanique du module. */
    if (r.exemple) {
      const notes = await driver.executeAsyncScript(
        "var cb = arguments[arguments.length - 1];" +
        "var h = window.Campaign.handouts.models[0];" +
        "var fini = false;" +
        "var minuteur = setTimeout(function () { if (!fini) { fini = true; cb({ delai: true }); } }, 6000);" +
        "try {" +
        "  h.get('notes', function (t) {" +
        "    if (fini) { return; } fini = true; clearTimeout(minuteur);" +
        "    cb({ type: typeof t, taille: t ? String(t).length : 0," +
        "         debut: String(t || '').slice(0, 60) }); });" +
        "} catch (e) { fini = true; clearTimeout(minuteur); cb({ erreur: String(e).slice(0, 120) }); }");
      console.log("  lecture des notes : " + JSON.stringify(notes));
    }
    releve("partage-marqueurs.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- FUSIONNER AVEC LE SYSTÈME DE ROLL20 : EST-CE POSSIBLE ? ----------
 *
 * La question vaut d'être reposée, parce que la réponse d'origine reposait sur
 * une déduction et non sur une mesure : on avait conclu que son choix de
 * marqueurs était dessiné dans le canevas, à partir d'un clic qui, en fait,
 * n'avait rien sélectionné du tout. Ça ne prouvait rien.
 *
 * ET IL Y A UNE VOIE JAMAIS ÉPROUVÉE. `Campaign.attributes.token_markers` est
 * une chaîne JSON qui porte les 47 pictogrammes de la campagne. On peut y
 * ajouter les nôtres EN MÉMOIRE — affectation directe, sans `set()` ni
 * `save()` —, donc sans rien écrire chez Roll20, sans événement, et sans que
 * personne d'autre en voie la trace. Si son interface lit cet attribut quand
 * elle s'ouvre, elle montrera nos marqueurs ; et si son moteur de rendu le lit
 * aussi, il les dessinera lui-même, et nos quads deviennent inutiles.
 *
 * Trois questions, et chacune se répond par une observation :
 *   1. le choix de marqueurs est-il dans le DOM, ouvert ou non ?
 *   2. une injection en mémoire y paraît-elle ?
 *   3. Roll20 DESSINE-T-IL une étiquette ainsi injectée ? (module éteint)
 *
 * Le risque connu : ses pictogrammes sont échantillonnés dans un ATLAS de
 * 4096 × 4096 (« instance-0 »). S'il le construit une fois pour toutes au
 * chargement, une entrée ajoutée après coup n'y sera pas, et le marqueur sortira
 * vide ou faux. C'est précisément ce que la troisième question tranche. */
async function fusionRoll20() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(6000);

    /* Notre module ÉTEINT : on veut voir ce que fait Roll20, pas ce que nous
     * faisons. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');");
    await dors(1200);

    /* ---- 1. Le choix de marqueurs est-il dans le DOM ? ---- */
    const cherche = await driver.executeScript(
      "var C = window.Campaign;" +
      "var cat = JSON.parse(C.attributes.token_markers);" +
      "var urls = cat.slice(0, 6).map(function (m) { return m.url; });" +
      /* On cherche TOUT nœud qui référence une de ses adresses de pictogramme :
       * si son sélecteur existe dans le DOM, fût-il caché, il est là. */
      "var trouve = [];" +
      "var tous = document.querySelectorAll('*');" +
      "for (var i = 0; i < tous.length; i++) {" +
      "  var n = tous[i];" +
      "  var s = n.getAttribute && (n.getAttribute('src') || n.getAttribute('data-src') || '');" +
      "  var st = n.style && n.style.backgroundImage || '';" +
      "  var texte = String(s) + ' ' + String(st);" +
      "  for (var k = 0; k < urls.length; k++) {" +
      "    if (urls[k] && texte.indexOf(urls[k].split('?')[0]) >= 0) {" +
      "      var r = n.getBoundingClientRect();" +
      "      trouve.push({ balise: n.tagName.toLowerCase()," +
      "        classe: String(n.className || '').slice(0, 70)," +
      "        parent: n.parentElement ? String(n.parentElement.className || '').slice(0, 60) : null," +
      "        boite: [Math.round(r.left), Math.round(r.top), Math.round(r.width)] });" +
      "      break; } }" +
      "  if (trouve.length > 12) { break; } }" +
      /* Et les classes qui SENTENT le choix de marqueurs, visibles ou non. */
      "var sel = [].slice.call(document.querySelectorAll('[class*=marker i],[class*=status i],[class*=condition i]'))" +
      "  .map(function (n) { var r = n.getBoundingClientRect();" +
      "    return { classe: String(n.className).slice(0, 60), enfants: n.children.length," +
      "      boite: [Math.round(r.width), Math.round(r.height)] }; }).slice(0, 15);" +
      "return { nUrls: urls.length, trouve: trouve, selecteurs: sel, nNoeuds: tous.length };");
    console.log("\n  1. LE CHOIX DE MARQUEURS DANS LE DOM");
    console.log("     " + cherche.nNoeuds + " nœuds balayés ; " + cherche.trouve.length +
                " référencent une image de pictogramme :");
    cherche.trouve.forEach((n) => console.log("       " + JSON.stringify(n)));
    console.log("     classes qui parlent de marqueurs :");
    cherche.selecteurs.forEach((n) => console.log("       " + JSON.stringify(n)));

    /* ---- 2 et 3. Injection EN MÉMOIRE, puis on regarde ---- */
    const IMG = "https://cdn.discordapp.com/embed/avatars/2.png";
    const inj = await driver.executeScript(
      "var C = window.Campaign;" +
      "window.__vtCatAvant = C.attributes.token_markers;" +
      "var l = JSON.parse(C.attributes.token_markers);" +
      "var maxId = l.reduce(function (a, m) { return Math.max(a, +m.id || 0); }, 0);" +
      "l.push({ id: maxId + 1, name: 'vtfusion', tag: 'vtfusion', url: arguments[0] });" +
      /* AFFECTATION DIRECTE : ni set(), ni save(). Aucun événement Backbone,
       * aucune écriture, personne d'autre ne le voit. */
      "C.attributes.token_markers = JSON.stringify(l);" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "var r = { n: l.length, id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers };" +
      "t.save({ statusmarkers: 'vtfusion' });" +
      "return r;", IMG);
    repose = inj;
    console.log("\n  2. INJECTION EN MÉMOIRE : catalogue porté à " + inj.n + " entrées");
    console.log("     étiquette « vtfusion » posée sur « " + inj.nom + " »");
    await dors(4000);

    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var noeud = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var enfants = noeud && noeud.getChildren ? noeud.getChildren() : [];" +
      "return { enfants: enfants.map(function (m) {" +
      "    var b = m.getBoundingInfo ? m.getBoundingInfo().boundingBox : null;" +
      "    var mt = m.material;" +
      "    return { nom: String(m.name).slice(-34), actif: m.isEnabled ? m.isEnabled() : null," +
      "      visible: m.isVisible," +
      "      boite: b ? [+b.minimumWorld.x.toFixed(1), +b.maximumWorld.x.toFixed(1)] : null," +
      "      textures: mt && mt.getActiveTextures ? mt.getActiveTextures().map(function (t) {" +
      "        return String(t.name || t.url || '?').slice(-34); }) : null }; })," +
      "  atlas: (S.textures || []).filter(function (t) { return /instance-0/.test(String(t.name)); })" +
      "    .map(function (t) { return { nom: String(t.name), taille: t.getSize ? [t.getSize().width, t.getSize().height] : null }; })," +
      "  aNotre: String((window.Campaign.activePage().thegraphics.get(arguments[0]).attributes.statusmarkers) || '') };",
      inj.id);
    console.log("\n  3. CE QUE ROLL20 DESSINE (notre module éteint)");
    console.log("     statusmarkers du token : " + JSON.stringify(vu.aNotre));
    console.log("     enfants du nœud de marqueurs :");
    vu.enfants.forEach((e) => console.log("       " + JSON.stringify(e)));
    console.log("     atlas : " + JSON.stringify(vu.atlas));

    const dessine = vu.enfants.some((e) => /vtfusion/.test(e.nom));
    console.log("\n  → Roll20 dessine-t-il notre étiquette injectée ? " +
                (dessine ? "OUI" : "NON"));

    await captureZoom(driver, "fusion-roll20.png",
      [inj.avant !== undefined ? 0 : 0, 0, 0], 1, 1).catch(() => {});
    releve("fusion-roll20.json", { cherche, inj, vu, dessine });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (window.__vtCatAvant) { C.attributes.token_markers = window.__vtCatAvant; }" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant).catch(() => {});
    await dors(1000);
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE COMPTEUR « @N », TEL QUE ROLL20 LE DESSINE ----------
 *
 * ON VA LE REPRODUIRE, DONC ON NE DEVINE RIEN. Le champ accepte « red@3 » : on
 * sait que le nombre existe et que Roll20 coupe l'étiquette dessus, mais on
 * ignore tout du DESSIN — un maillage de plus ? une texture recomposée ? quelle
 * fonte, quelle taille, quelle place, quelle couleur ?
 *
 * On pose donc un jeu d'étiquettes numérotées, on relève TOUT ce qui pend sous
 * le nœud de marqueurs (nom, place, échelle, matériau, texture et sa taille), et
 * on garde une capture. Les nombres qui en sortent sont ceux qu'on recopiera. */
async function compteurRoll20() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    /* Un chiffre, deux chiffres, trois : la boîte du nombre grandit-elle ? Et un
     * marqueur SANS compteur juste à côté, comme témoin de la taille nue. */
    const POSE = "snail@3,spanner@12,padlock@999,skull";
    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects' && m.attributes.width >= 100; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top, l: t.attributes.width };" +
      "t.save({ statusmarkers: arguments[0] }); return r;", POSE);
    if (!dep) { console.log("  aucun token assez grand."); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » (" + dep.l + ") ; posé : " + POSE);
    await dors(4000);

    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "if (!n) { return { erreur: 'nœud absent' }; }" +
      "function decris(m) {" +
      "  var mt = m.material, tx = null;" +
      "  try { tx = mt && mt.getActiveTextures ? mt.getActiveTextures()[0] : null; } catch (e) {}" +
      "  var d = { nom: m.name, classe: m.getClassName ? m.getClassName() : null," +
      "    actif: m.isEnabled ? m.isEnabled() : null," +
      "    pos: [+m.position.x.toFixed(2), +m.position.y.toFixed(2), +m.position.z.toFixed(2)]," +
      "    ech: m.scaling ? [+m.scaling.x.toFixed(3), +m.scaling.y.toFixed(3)] : null," +
      "    materiau: mt ? { classe: mt.getClassName ? mt.getClassName() : null, nom: mt.name," +
      "      couleur: mt.diffuseColor ? [mt.diffuseColor.r, mt.diffuseColor.g, mt.diffuseColor.b] : null," +
      "      emissive: mt.emissiveColor ? [mt.emissiveColor.r, mt.emissiveColor.g, mt.emissiveColor.b] : null," +
      "      zOffset: mt.zOffset } : null," +
      "    texture: tx ? { classe: tx.getClassName ? tx.getClassName() : null," +
      "      nom: String(tx.name || '').slice(-60), url: String(tx.url || '').slice(-60)," +
      "      taille: tx.getSize ? [tx.getSize().width, tx.getSize().height] : null," +
      "      prete: tx.isReady ? tx.isReady() : null," +
      "      /* UNE DynamicTexture PORTE SON CANEVAS : s'il y en a un, le nombre y" +
      "       * est peint, et on saura avec quelle fonte. */" +
      "      canevas: (tx.getContext ? (function () { try { var c = tx.getContext();" +
      "        return { fonte: c.font, aligne: c.textAlign, base: c.textBaseline," +
      "          remplissage: String(c.fillStyle), trait: String(c.strokeStyle)," +
      "          epaisseur: c.lineWidth }; } catch (e) { return String(e); } })() : null) } : null };" +
      "  return d; }" +
      "var enfants = (n.getChildren ? n.getChildren() : []).map(decris);" +
      /* TOUT CE QUI A PU NAÎTRE AILLEURS : un nombre pourrait très bien être un
       * maillage posé hors du nœud de marqueurs, ou une couche d'interface. */
      "var ailleurs = (S.meshes || []).filter(function (m) {" +
      "  return /count|number|badge|text|chiffre|digit/i.test(m.name); })" +
      "  .map(function (m) { return m.name; });" +
      "return { enfants: enfants, ailleurs: ailleurs," +
      "  nMeshes: (S.meshes || []).length," +
      "  nTextures: (S.textures || []).length," +
      "  dyn: (S.textures || []).filter(function (t) {" +
      "    return t.getClassName && /Dynamic/.test(t.getClassName()); })" +
      "    .map(function (t) { return { nom: String(t.name).slice(-40)," +
      "      taille: t.getSize ? [t.getSize().width, t.getSize().height] : null }; }) };",
      dep.id);

    if (vu.erreur) { console.log("  " + vu.erreur); return 1; }
    console.log("\n  " + vu.nMeshes + " maillages, " + vu.nTextures + " textures dans la scène");
    console.log("  textures dynamiques : " + JSON.stringify(vu.dyn));
    console.log("  maillages au nom évocateur ailleurs : " + JSON.stringify(vu.ailleurs));
    console.log("\n  SOUS LE NŒUD DE MARQUEURS (" + vu.enfants.length + ") :");
    vu.enfants.forEach((e) => console.log("    " + JSON.stringify(e)));

    await captureZoom(driver, "compteur-roll20.png",
      [dep.g + dep.l / 2 - 55, -(dep.h - dep.l / 2) - 14, 9999000], 60, 8);
    releve("compteur-roll20.json", { pose: POSE, token: dep, vu });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant).catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE CANEVAS DU COMPTEUR, LU AU PIXEL ----------
 *
 * La première mesure a montré que le nombre n'est PAS un enfant du nœud de
 * marqueurs, mais qu'il existe une DynamicTexture par compteur — « <token>-<tag>
 * -<N>-tex--0-0 », haute de 28 et large de 20, 36 ou 52 selon le nombre de
 * chiffres. Reste à savoir QUI la porte, et ce qui y est peint.
 *
 * On ne va pas deviner la fonte : une DynamicTexture garde son canevas, et un
 * canevas se lit en clair. On l'exporte en PNG et on le REGARDE. C'est la seule
 * mesure qui ne laisse aucune question ouverte. */
async function chiffreRoll20() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    const POSE = "snail@3,spanner@12,padlock@999,skull";
    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects' && m.attributes.width >= 100; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top, l: t.attributes.width, ht: t.attributes.height };" +
      "t.save({ statusmarkers: arguments[0] }); return r;", POSE);
    if (!dep) { console.log("  aucun token assez grand."); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » " + dep.l + "×" + dep.ht + " ; posé : " + POSE);
    await dors(4000);

    const vu = await driver.executeScript(
      "var S = window.MeshScene, out = { porteurs: [], canevas: [] };" +
      /* QUI PORTE CES TEXTURES : on balaie TOUS les maillages et on regarde leurs
       * textures actives. Chercher par le nom du maillage supposerait qu'il
       * ressemble à celui de la texture — supposition, et de celles qui coûtent. */
      "(S.meshes || []).forEach(function (m) {" +
      "  var mt = m.material, tx = null;" +
      "  try { tx = mt && mt.getActiveTextures ? mt.getActiveTextures() : []; } catch (e) { tx = []; }" +
      "  for (var i = 0; i < tx.length; i++) {" +
      "    if (!/-tex--\\d+-\\d+$/.test(String(tx[i].name || ''))) { continue; }" +
      "    out.porteurs.push({ maillage: m.name, classe: m.getClassName ? m.getClassName() : null," +
      "      parent: m.parent ? String(m.parent.name).slice(-34) : null," +
      "      actif: m.isEnabled ? m.isEnabled() : null," +
      "      pos: [+m.position.x.toFixed(2), +m.position.y.toFixed(2), +m.position.z.toFixed(2)]," +
      "      abs: (function () { var p = m.getAbsolutePosition();" +
      "        return [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)]; })()," +
      "      ech: [+m.scaling.x.toFixed(3), +m.scaling.y.toFixed(3)]," +
      "      boite: (function () { try { var b = m.getBoundingInfo().boundingBox;" +
      "        return [+(b.maximumWorld.x - b.minimumWorld.x).toFixed(2)," +
      "                +(b.maximumWorld.y - b.minimumWorld.y).toFixed(2)]; } catch (e) { return null; } })()," +
      "      groupe: m.renderingGroupId, alphaIndex: m.alphaIndex," +
      "      materiau: mt.getClassName ? mt.getClassName() : null," +
      "      texture: String(tx[i].name), taille: [tx[i].getSize().width, tx[i].getSize().height]," +
      "      inverseY: tx[i].invertY, hasAlpha: tx[i].hasAlpha }); } });" +
      /* LE CANEVAS EN CLAIR. Une DynamicTexture le garde ; Babylon 8 l'expose par
       * getCanvas(), les versions d'avant par _canvas. On prend ce qu'on trouve. */
      "(S.textures || []).forEach(function (t) {" +
      "  if (!/-tex--\\d+-\\d+$/.test(String(t.name || ''))) { return; }" +
      "  var c = null;" +
      "  try { c = t.getCanvas ? t.getCanvas() : (t._canvas || null); } catch (e) {}" +
      "  var png = null; try { png = c ? c.toDataURL('image/png') : null; } catch (e) { png = String(e); }" +
      "  out.canevas.push({ nom: String(t.name), taille: [t.getSize().width, t.getSize().height]," +
      "    png: png }); });" +
      "return out;");

    console.log("\n  PORTEURS (" + vu.porteurs.length + ") :");
    vu.porteurs.forEach((p) => console.log("    " + JSON.stringify(p)));

    console.log("\n  CANEVAS (" + vu.canevas.length + ") :");
    const fs2 = require("fs");
    vu.canevas.forEach((c) => {
      console.log("    " + c.nom + "  " + c.taille.join("×") +
                  (String(c.png || "").slice(0, 5) === "data:" ? "" : "  → " + c.png));
      if (String(c.png || "").slice(0, 5) !== "data:") { return; }
      const court = c.nom.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-30);
      const p = path.join(RELEVES, "chiffre-" + court + ".png");
      fs2.mkdirSync(RELEVES, { recursive: true });
      fs2.writeFileSync(p, Buffer.from(c.png.split(",")[1], "base64"));
      console.log("      écrit : " + path.relative(RACINE, p));
    });

    /* LA RANGÉE, CADRÉE SUR LE COIN HAUT-DROIT DU TOKEN — et cette fois avec sa
     * VRAIE hauteur : le premier jet prenait la largeur pour la hauteur et
     * cadrait à côté du plateau, sur une bannière de l'interface. */
    await captureZoom(driver, "chiffre-rangee.png",
      [dep.g + dep.l / 2 - 50, -(dep.h - dep.ht / 2) - 12.5, 9999000], 58, 8);
    releve("chiffre-roll20.json",
      { pose: POSE, token: dep, porteurs: vu.porteurs,
        canevas: vu.canevas.map((c) => ({ nom: c.nom, taille: c.taille })) });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant).catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE COMPTEUR, AU PIXEL ET À L'ÉCHELLE ----------
 *
 * Trois questions, et chacune change ce qu'on écrira :
 *
 *   1. DE QUOI EST FAIT LE DESSIN ? On lit le canevas au pixel — couleurs
 *      exactes, boîte des glyphes, contour ou non. Regarder une vignette de
 *      36 × 28 à l'œil ne dit pas si le rouge est #C91010 ou #D22, ni s'il y a
 *      un liseré blanc d'un pixel.
 *   2. LE COMPTEUR RAPETISSE-T-IL AVEC LE MARQUEUR ? La première mesure s'est
 *      faite à échelle 1, où la question ne se pose pas. On charge donc le token
 *      jusqu'à ce que Roll20 rapetisse, et on regarde.
 *   3. QUELLE TOUCHE FAIT QUOI ? Le chiffre au survol est une fonction de son
 *      interface : on cherche le code qui l'écoute, plutôt que d'inventer une
 *      sémantique qui ne serait pas la sienne. */
async function chiffrePixels() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    /* ---- 1 et 2 : ONZE MARQUEURS, dont trois numérotés ---- */
    const CHARGE = ["snail@3", "spanner@12", "padlock@999", "skull", "sleepy",
      "half-heart", "interdiction", "ninja-mask", "pummeled", "edge-crack", "fishing-net"].join(",");
    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects' && m.attributes.width >= 100; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top, l: t.attributes.width, ht: t.attributes.height };" +
      "t.save({ statusmarkers: arguments[0] }); return r;", CHARGE);
    if (!dep) { console.log("  aucun token assez grand."); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » " + dep.l + "×" + dep.ht + " ; onze marqueurs, dont 3 numérotés");
    await dors(4500);

    const geo = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var siens = (n && n.getChildren ? n.getChildren() : []).filter(function (m) {" +
      "  return m.isEnabled && m.isEnabled() && !/group_marker|^vttk-/.test(m.name); });" +
      "var ancre = n ? n.getAbsolutePosition() : null;" +
      "var comp = [];" +
      "(S.meshes || []).forEach(function (m) {" +
      "  if (!/-renderer$/.test(m.name)) { return; }" +
      "  var mt = m.material, tx = [];" +
      "  try { tx = mt && mt.getActiveTextures ? mt.getActiveTextures() : []; } catch (e) {}" +
      "  if (!tx.length || !/-tex--\\d+-\\d+$/.test(String(tx[0].name || ''))) { return; }" +
      "  var b = m.getBoundingInfo().boundingBox, p = m.getAbsolutePosition();" +
      "  comp.push({ nom: m.name.slice(-28)," +
      "    abs: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(0)]," +
      "    boite: [+(b.maximumWorld.x - b.minimumWorld.x).toFixed(2)," +
      "            +(b.maximumWorld.y - b.minimumWorld.y).toFixed(2)]," +
      "    tex: [tx[0].getSize().width, tx[0].getSize().height] }); });" +
      "var vus = {}; comp = comp.filter(function (c) {" +
      "  if (vus[c.nom]) { return false; } vus[c.nom] = 1; return true; });" +
      "return { ancre: ancre ? [+ancre.x.toFixed(2), +ancre.y.toFixed(2), +ancre.z.toFixed(0)] : null," +
      "  siens: siens.map(function (m) { var p = m.getAbsolutePosition();" +
      "    return { nom: m.name, ech: +m.scaling.x.toFixed(3)," +
      "      loc: [+m.position.x.toFixed(2), +m.position.y.toFixed(2)]," +
      "      abs: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(0)] }; })," +
      "  compteurs: comp };", dep.id);

    console.log("\n  ancre du nœud : " + JSON.stringify(geo.ancre));
    console.log("  SES marqueurs (échelle " + (geo.siens[0] ? geo.siens[0].ech : "?") + ") :");
    geo.siens.forEach((s) => console.log("    " + s.nom + "  loc " + JSON.stringify(s.loc) +
      "  abs " + JSON.stringify(s.abs)));
    console.log("\n  SES compteurs :");
    geo.compteurs.forEach((c) => console.log("    " + JSON.stringify(c)));

    /* LE COMPTEUR SUIT-IL L'ÉCHELLE ? On le dit en clair, chiffres à l'appui. */
    geo.compteurs.forEach((c) => {
      const chiffres = (c.nom.match(/-(\d+)-renderer$/) || [0, ""])[1].length;
      const nu = 10 + 8 * (chiffres - 1);         // sa largeur relevée à échelle 1
      console.log("    « " + c.nom + " » : " + chiffres + " chiffre(s), boîte " +
        c.boite[0] + "×" + c.boite[1] + " — à échelle 1 ce serait " + nu + "×14" +
        "  → rapport " + (c.boite[1] / 14).toFixed(3));
    });

    /* ---- 1 : LE CANEVAS, PIXEL PAR PIXEL ---- */
    const pix = await driver.executeScript(
      "var S = window.MeshScene, out = [];" +
      "(S.textures || []).forEach(function (t) {" +
      "  if (!/-tex--\\d+-\\d+$/.test(String(t.name || ''))) { return; }" +
      "  var c = null;" +
      "  try { c = t.getCanvas ? t.getCanvas() : (t._canvas || null); } catch (e) {}" +
      "  if (!c) { return; }" +
      "  var w = c.width, h = c.height;" +
      "  var d = c.getContext('2d').getImageData(0, 0, w, h).data;" +
      "  var couleurs = {}, x0 = w, y0 = h, x1 = -1, y1 = -1;" +
      "  for (var y = 0; y < h; y++) { for (var x = 0; x < w; x++) {" +
      "    var i = (y * w + x) * 4, a = d[i + 3];" +
      "    if (a < 8) { continue; }" +
      "    if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }" +
      "    if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }" +
      "    var k = d[i] + ',' + d[i + 1] + ',' + d[i + 2] + ',' + a;" +
      "    couleurs[k] = (couleurs[k] || 0) + 1; } }" +
      "  var tri = Object.keys(couleurs).sort(function (a, b) { return couleurs[b] - couleurs[a]; });" +
      "  out.push({ nom: String(t.name).slice(-30), taille: [w, h]," +
      "    boite: [x0, y0, x1, y1], largeurGlyphes: x1 - x0 + 1, hauteurGlyphes: y1 - y0 + 1," +
      "    opaques: tri.length," +
      "    dominantes: tri.slice(0, 6).map(function (k) { return k + ' ×' + couleurs[k]; }) }); });" +
      "return out;");
    console.log("\n  CANEVAS AU PIXEL :");
    pix.forEach((p) => {
      console.log("    " + p.nom + "  " + p.taille.join("×") +
        "  glyphes " + p.largeurGlyphes + "×" + p.hauteurGlyphes +
        " en [" + p.boite.join(", ") + "]  (" + p.opaques + " couleurs)");
      p.dominantes.forEach((d) => console.log("        " + d));
    });

    /* ---- 3 : QUI ÉCOUTE LES CHIFFRES ---- */
    const code = await driver.executeScript(
      "var out = { pistes: [] };" +
      "function fouille(obj, chemin, prof) {" +
      "  if (!obj || prof > 2) { return; }" +
      "  var k; for (k in obj) {" +
      "    var v; try { v = obj[k]; } catch (e) { continue; }" +
      "    if (typeof v === 'function') {" +
      "      var s; try { s = Function.prototype.toString.call(v); } catch (e) { continue; }" +
      "      if (/statusmarkers/.test(s) && /(keyCode|which|@|parseInt)/.test(s)) {" +
      "        out.pistes.push({ ou: chemin + '.' + k, taille: s.length, src: s.slice(0, 900) }); }" +
      "    } else if (v && typeof v === 'object' && prof < 2) { fouille(v, chemin + '.' + k, prof + 1); } } }" +
      "try { fouille(window.d20 && window.d20.token_editor, 'd20.token_editor', 0); } catch (e) {}" +
      "try { fouille(window.currentPlayer && window.currentPlayer.d20 && window.currentPlayer.d20.token_editor, 'cp.d20.token_editor', 0); } catch (e) {}" +
      "return out;");
    console.log("\n  CODE QUI TOUCHE AUX CHIFFRES (" + code.pistes.length + " piste(s)) :");
    code.pistes.forEach((p) => {
      console.log("\n    ---- " + p.ou + "  (" + p.taille + " car.) ----");
      console.log("    " + p.src.replace(/\n/g, "\n    "));
    });

    releve("chiffre-pixels.json", { charge: CHARGE, token: dep, geo, pix, pistes: code.pistes });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant).catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUI A DROIT À UN COMPTEUR CHEZ ROLL20 ? ----------
 *
 * La question s'est posée en écrivant le chiffre au survol : rien n'empêche de
 * frapper un chiffre en survolant « dead » ou une pastille de couleur, ce qui
 * écrirait « dead@3 » dans les données de la campagne. Si personne ne dessine ce
 * 3, c'est une donnée morte et un piège pour le prochain qui lira le champ.
 *
 * On ne tranche pas ça au jugé : on pose « red@4 », « dead@2 » et « skull@9 » sur
 * le même token, et on regarde qui produit un maillage « -renderer ». */
async function quiCompte() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    const POSE = "red@4,dead@2,skull@9,blue@7";
    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects' && m.attributes.width >= 100; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers };" +
      "t.save({ statusmarkers: arguments[0] }); return r;", POSE);
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    console.log("\n  posé sur « " + dep.nom + " » : " + POSE);
    await dors(4000);

    const vu = await driver.executeScript(
      "var S = window.MeshScene, out = { rendus: [], sousLeNoeud: [] };" +
      "(S.meshes || []).forEach(function (m) {" +
      "  if (/-renderer$/.test(m.name)) { out.rendus.push(m.name.slice(-30)); } });" +
      "var vus = {}; out.rendus = out.rendus.filter(function (n) {" +
      "  if (vus[n]) { return false; } vus[n] = 1; return true; });" +
      "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "out.sousLeNoeud = (n && n.getChildren ? n.getChildren() : []).map(function (m) {" +
      "  return { nom: m.name, actif: m.isEnabled ? m.isEnabled() : null," +
      "    x: +m.position.x.toFixed(2), y: +m.position.y.toFixed(2) }; });" +
      "out.mort = (S.meshes || []).filter(function (m) { return /deadmarker/i.test(m.name); })" +
      "  .map(function (m) { return m.name; });" +
      "return out;", dep.id);

    console.log("\n  maillages « -renderer » (donc porteurs d'un nombre) :");
    vu.rendus.forEach((n) => console.log("    " + n));
    console.log("\n  sous le nœud de marqueurs :");
    vu.sousLeNoeud.forEach((e) => console.log("    " + JSON.stringify(e)));
    console.log("\n  maillages « deadmarker » : " + JSON.stringify(vu.mort));

    const a = (t) => vu.rendus.some((n) => n.indexOf("-" + t + "-") >= 0);
    console.log("\n  → une pastille (red) porte-t-elle un nombre ? " + (a("red") ? "OUI" : "NON"));
    console.log("    et « dead » ? " + (a("dead") ? "OUI" : "NON"));
    console.log("    et un pictogramme ordinaire (skull) ? " + (a("skull") ? "OUI" : "NON"));
    releve("qui-compte.json", { pose: POSE, vu });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant).catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA PALETTE PROFESSIONNELLE, DE BOUT EN BOUT ----------
 *
 * Quatre choses à VOIR, et aucune ne se juge au banc :
 *   1. la palette au repos — titre, rouage, huit tuiles par ligne qui ne se
 *      chevauchent plus (elles faisaient 30 dans des colonnes de 26) ;
 *   2. la palette en édition — croix, formulaire [Nom] [Adresse] [+] ;
 *   3. NOTRE compteur sur un token, à côté de celui de Roll20 — c'est la seule
 *      façon de savoir si le nombre sort à l'endroit, à la bonne taille et à la
 *      bonne place ; une DynamicTexture n'a pas les mêmes règles d'orientation
 *      qu'une image, et personne ne peut le déduire de la documentation ;
 *   4. la pose multiple, écrite dans le champ.
 */
async function paletteProfessionnelle() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    /* UNE FENÊTRE DE PROMOTION S'EST DÉJÀ INTERPOSÉE entre la caméra et le
     * plateau, et deux captures sont revenues noires ou barrées d'un bandeau
     * « UPGRADE » sans que rien ne le signale. On la cherche et on la referme
     * avant de photographier quoi que ce soit. */
    const gene = await driver.executeScript(
      "var n = document.querySelectorAll('.modal, [role=dialog], .ReactModal__Overlay'), ote = 0;" +
      "for (var i = 0; i < n.length; i++) {" +
      "  var r = n[i].getBoundingClientRect();" +
      "  if (r.width > 300 && r.height > 200 && n[i].offsetParent !== null) {" +
      "    n[i].style.display = 'none'; ote++; } }" +
      "return { otes: ote, titre: document.title };");
    console.log("  fenêtres écartées avant capture : " + gene.otes);

    const PALETTE = [
      { tag: "vttk_essaia_cdn.discordapp.com/embed/avatars/0.png", nom: "Essai A",
        url: "https://cdn.discordapp.com/embed/avatars/0.png" },
      { tag: "vttk_essaib_cdn.discordapp.com/embed/avatars/1.png", nom: "Essai B",
        url: "https://cdn.discordapp.com/embed/avatars/1.png" },
      { tag: "vttk_essaic_cdn.discordapp.com/embed/avatars/2.png", nom: "Essai C",
        url: "https://cdn.discordapp.com/embed/avatars/2.png" }
    ];
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs'," +
      "  actif: true, catalogue: arguments[0] }, '*');", PALETTE);
    await dors(1500);

    /* ---- 3. LE COMPTEUR, LE NÔTRE À CÔTÉ DU SIEN ---- */
    const POSE = "snail@3," + PALETTE[0].tag + "@7," + PALETTE[1].tag + "@12," + PALETTE[2].tag;
    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects' && m.attributes.width >= 100; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top, l: t.attributes.width, ht: t.attributes.height };" +
      "t.save({ statusmarkers: arguments[0] }); return r;", POSE);
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » ; posé : " + POSE);
    await dors(4500);

    const quads = await driver.executeScript(
      "var S = window.MeshScene, n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var e = (n && n.getChildren ? n.getChildren() : []);" +
      "return { erreur: window.__vttinkerMarqueursErreur || null," +
      "  enfants: e.map(function (m) {" +
      "    var mt = m.material, tx = null;" +
      "    try { tx = mt && mt.getActiveTextures ? mt.getActiveTextures()[0] : null; } catch (x) {}" +
      "    return { nom: m.name.slice(0, 46), actif: m.isEnabled ? m.isEnabled() : null," +
      "      pos: [+m.position.x.toFixed(2), +m.position.y.toFixed(2), +m.position.z.toFixed(0)]," +
      "      ech: [+m.scaling.x.toFixed(2), +m.scaling.y.toFixed(2)]," +
      "      tex: tx ? { classe: tx.getClassName && tx.getClassName()," +
      "        taille: tx.getSize ? [tx.getSize().width, tx.getSize().height] : null," +
      "        prete: tx.isReady && tx.isReady() } : null }; }) };", dep.id);
    if (quads.erreur) { console.log("\n  ERREUR RETENUE PAR LE PONT :\n    " + quads.erreur); }
    console.log("\n  sous le nœud de marqueurs :");
    quads.enfants.forEach((e) => console.log("    " + JSON.stringify(e)));

    await captureZoom(driver, "pro-compteurs.png",
      [dep.g + dep.l / 2 - 52, -(dep.h - dep.ht / 2) - 14, 9999000], 62, 8);

    /* ---- 1 et 2. LA PALETTE, AU REPOS PUIS EN ÉDITION ---- */
    const ouvre1 = await driver.executeScript(
      "var b = document.querySelector('.vttk-outil-marqueurs button');" +
      "if (!b) { return null; } b.click(); return true;");
    if (!ouvre1) { console.log("  bouton de palette introuvable."); return 1; }
    await dors(1200);

    const boite = await driver.executeScript(
      "var b = document.querySelector('.vttk-barre');" +
      "if (!b) { return null; }" +
      "var r = b.getBoundingClientRect();" +
      "var t = b.querySelectorAll('.vttk-barre-marqueur');" +
      "var g = b.querySelector('.vttk-marqueur-grille');" +
      "var rg = g ? g.getBoundingClientRect() : null;" +
      "return { x: r.left, y: r.top, l: r.width, h: r.height," +
      "  tuiles: t.length," +
      "  tuile: t.length ? (function () { var q = t[0].getBoundingClientRect();" +
      "    return [+q.width.toFixed(1), +q.height.toFixed(1)]; })() : null," +
      "  /* CHEVAUCHENT-ELLES ? On compare les bords de deux voisines de la MÊME" +
      "     ligne : c'est le défaut qu'on vient de corriger, et il ne se voit pas" +
      "     autrement que par les nombres ou par l'œil. */" +
      "  chevauche: (function () {" +
      "    for (var i = 1; i < Math.min(8, t.length); i++) {" +
      "      var a = t[i - 1].getBoundingClientRect(), c = t[i].getBoundingClientRect();" +
      "      if (Math.abs(a.top - c.top) > 2) { continue; }" +
      "      if (c.left < a.right - 0.5) { return +(a.right - c.left).toFixed(2); } }" +
      "    return 0; })()," +
      "  grille: rg ? [+rg.width.toFixed(1), +rg.height.toFixed(1)] : null," +
      "  debordeGrille: rg ? +(rg.right - r.right).toFixed(2) : null," +
      "  rouage: !!b.querySelector('.vttk-barre-rouage')," +
      "  champs: b.querySelectorAll('.vttk-marqueur-champ').length," +
      "  croix: b.querySelectorAll('.vttk-marqueur-sup').length };");
    console.log("\n  palette AU REPOS : " + JSON.stringify(boite));
    if (boite) {
      await capturePres(driver, "pro-palette.png",
        Math.round(boite.x) - 6, Math.round(boite.y) - 6,
        Math.round(boite.l) + 12, Math.min(430, Math.round(boite.h) + 12), 2);
    }

    const enEdition = await driver.executeScript(
      "var r = document.querySelector('.vttk-barre-rouage');" +
      "if (!r) { return null; } r.click();" +
      "var b = document.querySelector('.vttk-barre');" +
      "var q = b.getBoundingClientRect();" +
      "return { x: q.left, y: q.top, l: q.width, h: q.height," +
      "  edition: b.className.indexOf('edition') >= 0," +
      "  champs: b.querySelectorAll('.vttk-marqueur-champ').length," +
      "  croix: b.querySelectorAll('.vttk-marqueur-sup').length," +
      "  traînables: [].slice.call(b.querySelectorAll('.vttk-marqueur-tuile'))" +
      "    .filter(function (d) { return d.getAttribute('draggable') === 'true'; }).length };");
    console.log("\n  palette EN ÉDITION : " + JSON.stringify(enEdition));
    if (enEdition) {
      await dors(400);
      await capturePres(driver, "pro-edition.png",
        Math.round(enEdition.x) - 6, Math.round(enEdition.y) - 6,
        Math.round(enEdition.l) + 12, Math.min(430, Math.round(enEdition.h) + 12), 2);
    }

    /* LA BARRE DE TITRE DE TRÈS PRÈS. Le rouage fait quatorze pixels : à cette
     * taille, un dessin en aplat devient une tache et on ne s'en aperçoit qu'en
     * regardant — pas en lisant des nombres. */
    if (enEdition) {
      await capturePres(driver, "pro-titre.png",
        Math.round(enEdition.x) - 2, Math.round(enEdition.y) - 2,
        Math.round(enEdition.l) + 4, 40, 6);
    }
    releve("pro-palette.json", { boite, enEdition, quads: quads.enfants, pose: POSE });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant).catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES GESTES, SUR LA VRAIE PARTIE ----------
 *
 * Le banc éprouve la RÈGLE ; ici on éprouve le GESTE, avec de vrais événements
 * du navigateur : deux tuiles cliquées puis un clic sur le plateau, un chiffre
 * frappé au survol, et une tuile traînée sur une autre. Trois choses que le
 * banc ne peut pas prouver, parce qu'elles dépendent d'un vrai DOM — la
 * délégation du survol, le clavier en capture, et le transfert de glissement. */
async function gestesPalette() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    /* LA PARTIE EST DÉSIGNÉE, plus laissée à la dernière ouverte : depuis quil
     * y a deux parties dessai, « la dernière » dépend de la sonde davant. */
    if (!(await vaALaPartie(driver, partieDEssai("mj")))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    const A = "vttk_essaia_cdn.discordapp.com/embed/avatars/0.png";
    const B = "vttk_essaib_cdn.discordapp.com/embed/avatars/1.png";
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true," +
      "  catalogue: [{ tag: arguments[0], nom: 'Essai A', url: 'https://cdn.discordapp.com/embed/avatars/0.png' }," +
      "              { tag: arguments[1], nom: 'Essai B', url: 'https://cdn.discordapp.com/embed/avatars/1.png' }] }, '*');",
      A, B);
    await dors(1500);

    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects' && m.attributes.width >= 100; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers };" +
      "t.save({ statusmarkers: '' }); return r;");
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;

    await driver.executeScript("document.querySelector('.vttk-outil-marqueurs button').click();");
    await dors(900);

    /* Le point de l'écran où tombe le centre du token, par la projection de
     * Babylon — la même que celle du pont, pour éviter deux vérités. */
    const CLIC =
      "var S = window.MeshScene, e = S.getEngine(), C = window.Campaign;" +
      "var t = C.activePage().thegraphics.get(arguments[0]);" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var cv = e.getRenderingCanvas(), r = cv.getBoundingClientRect();" +
      "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
      "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
      "var p = V.Project(new V(t.attributes.left, -t.attributes.top, 9999000), M.Identity(), S.getTransformMatrix(), vp);" +
      "var x = p.x * r.width / e.getRenderWidth() + r.left;" +
      "var y = p.y * r.height / e.getRenderHeight() + r.top;" +
      "cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y," +
      "  bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));" +
      "return [Math.round(x), Math.round(y)];";

    const lis = "return window.Campaign.activePage().thegraphics.get(arguments[0]).attributes.statusmarkers;";

    /* ---- 1. DEUX TUILES, UN CLIC ---- */
    const choisis = await driver.executeScript(
      "var q = function (t) { return document.querySelector('.vttk-barre-marqueur[data-tag=\"' + t + '\"]'); };" +
      "q(arguments[0]).click(); q(arguments[1]).click();" +
      "return document.querySelectorAll('.vttk-barre-marqueur.arme').length;", A, B);
    console.log("\n  tuiles choisies : " + choisis);
    await driver.executeScript(CLIC, dep.id);
    await dors(1500);
    const apres1 = await driver.executeScript(lis, dep.id);
    console.log("  après le clic sur le token : " + JSON.stringify(apres1));

    await driver.executeScript(CLIC, dep.id);
    await dors(1500);
    const apres2 = await driver.executeScript(lis, dep.id);
    console.log("  et au clic suivant, tous présents : " + JSON.stringify(apres2));

    /* ---- 2. UN CHIFFRE AU SURVOL ---- */
    await driver.executeScript(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
    const survol = await driver.executeScript(
      "var b = document.querySelector('.vttk-barre-marqueur[data-tag=\"' + arguments[0] + '\"]');" +
      "b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));" +
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true }));" +
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));" +
      "var p = b.parentNode.querySelector('.vttk-marqueur-rang');" +
      "return { arme: b.className.indexOf('arme') >= 0, rang: p ? p.textContent : null," +
      "  visible: p ? !p.hidden : null };", A);
    console.log("\n  après « 4 » puis « 2 » au survol : " + JSON.stringify(survol));
    await driver.executeScript(CLIC, dep.id);
    await dors(1500);
    const apres3 = await driver.executeScript(lis, dep.id);
    console.log("  le champ porte : " + JSON.stringify(apres3));

    /* ---- 3. TRAÎNER UNE TUILE SUR UNE AUTRE ---- */
    await driver.executeScript(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));" +
      "document.querySelector('.vttk-barre-rouage').click();");
    await dors(700);
    const avantTri = await driver.executeScript(
      "return [].slice.call(document.querySelectorAll('.vttk-marqueur-grille.mienne .vttk-barre-marqueur'))" +
      "  .map(function (b) { return b.getAttribute('data-tag').slice(0, 12); });");
    /* ON ÉCOUTE CE QUE LE PONT DEMANDE, ET NON CE QUE LA PALETTE DEVIENT.
     *
     * La palette de cette épreuve est portée au pont par un message, pas par le
     * stockage de l'extension : le script de contenu, lui, ne connaît que le
     * stockage — vide ici. Il ne peut donc RIEN réordonner, et regarder l'ordre
     * des tuiles après le dépôt ne prouverait rien. Un premier jet a conclu à un
     * échec sur ce seul indice, alors que la demande partait correctement.
     *
     * Ce qui se vérifie ici, c'est la moitié qui vit dans la page : le geste
     * produit-il la bonne demande ? L'autre moitié — l'écriture — est éprouvée
     * au banc, qui monte les deux mondes autour d'un vrai stockage. */
    const tri = await driver.executeScript(
      "window.__vttkOrdre = null;" +
      "window.addEventListener('message', function (e) {" +
      "  var d = e.data;" +
      "  if (d && d.ns === 'vttinker' && d.depuis === 'page' && d.type === 'marqueurs-ordre') {" +
      "    window.__vttkOrdre = d.ordre; } });" +
      "var g = document.querySelector('.vttk-marqueur-grille.mienne');" +
      "var d = g.querySelectorAll('.vttk-marqueur-tuile');" +
      "if (d.length < 2) { return 'pas assez de tuiles'; }" +
      "var dt = new DataTransfer();" +
      "d[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));" +
      "g.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));" +
      "d[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));" +
      "return 'fait';");
    console.log("\n  glissement : " + tri);
    await dors(1200);
    const demande = await driver.executeScript("return window.__vttkOrdre;");
    console.log("  ordre affiché  : " + JSON.stringify(avantTri));
    console.log("  ordre demandé  : " +
      JSON.stringify((demande || []).map((t) => String(t).slice(0, 12))));

    const triBon = !!demande && demande.length === 2 && demande[0] === B && demande[1] === A;
    console.log("    → la traînée passe bien devant la cible : " + (triBon ? "OUI" : "NON"));

    const bon = String(apres1).indexOf(A) >= 0 && String(apres1).indexOf(B) >= 0 &&
                String(apres2) === "" && String(apres3) === A + "@42" && triBon;
    console.log("\n  → tous les gestes répondent : " + (bon ? "OUI" : "NON"));
    releve("gestes-palette.json", { apres1, apres2, survol, apres3, avantTri, demande });
    return bon ? 0 : 1;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant).catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- POURQUOI ÇA RAME AU-DELÀ DE 250 % ----------
 *
 * L'auteur a élargi les bornes, dépassé 250 %, et la partie s'est mise à ramer
 * très fort. Trois causes possibles, et une seule expérience les sépare :
 *
 *   1. NOUS, à chaque cran de molette — le chemin `pose()` hors plage native
 *      écrit dans le magasin Pinia de Roll20, ce qui réveille tous ses abonnés ;
 *   2. NOUS, en continu — un abonnement, un rendez-vous ou un guet qui bat ;
 *   3. ROLL20, tout seul, parce qu'un zoom de 400 % lui coûte ce qu'il coûte.
 *
 * On mesure donc les temps de trame dans TROIS états, dont le dernier module
 * ÉTEINT et le zoom posé à la main dans son magasin : si la partie rame autant
 * sans nous, la cause n'est pas de notre côté, et aucun réglage de notre code
 * n'y changera rien. C'est la seule façon de ne pas « corriger » au hasard. */
async function pourquoiCaRame() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(8000);

    /* Le chronomètre : on échantillonne les intervalles entre trames pendant
     * une durée donnée, et on rend la médiane, le pire, et combien de trames ont
     * dépassé 33 ms — soit le seuil sous lequel on descend en dessous de 30
     * images par seconde, là où ça « rame » à l'œil. */
    const MESURE =
      "var cb = arguments[arguments.length - 1], ms = arguments[0];" +
      "var S = window.MeshScene, e = S.getEngine();" +
      "var t0 = performance.now(), prec = t0, ecarts = [];" +
      "var etats0 = window.__vttinkerEtats || 0;" +
      "var dessins = 0;" +
      "function tour() {" +
      "  var t = performance.now(); ecarts.push(t - prec); prec = t;" +
      "  dessins = e.drawCalls !== undefined ? e.drawCalls : dessins;" +
      "  if (t - t0 < ms) { requestAnimationFrame(tour); return; }" +
      "  ecarts.sort(function (a, b) { return a - b; });" +
      "  var med = ecarts[Math.floor(ecarts.length / 2)] || 0;" +
      "  var lents = ecarts.filter(function (x) { return x > 33; }).length;" +
      "  cb({ trames: ecarts.length," +
      "    median: +med.toFixed(2), pire: +(ecarts[ecarts.length - 1] || 0).toFixed(2)," +
      "    lentes: lents, fps: Math.round(e.getFps())," +
      "    etats: (window.__vttinkerEtats || 0) - etats0," +
      "    maillages: (S.meshes || []).length," +
      "    actifs: (S.getActiveMeshes ? S.getActiveMeshes().length : null)," +
      "    zoom: (function () { try {" +
      "      var n = document.querySelectorAll('[data-v-app]');" +
      "      for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "        var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "        if (p && p._s && p._s.get('engine')) { return p._s.get('engine').zoom; } }" +
      "    } catch (x) {} return null; })() });" +
      "}" +
      "requestAnimationFrame(tour);";

    const MAGASIN_ENGINE =
      "function __eng() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }";

    /* ---- 1. À 100 %, module armé ---- */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 600 }, '*');");
    await dors(1500);
    await driver.executeScript(MAGASIN_ENGINE +
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 100 }, '*');" +
      "var st = __eng(); if (st) { try { st.setZoom(100); } catch (e) {} }");
    await dors(2500);
    const a100 = await driver.executeAsyncScript(MESURE, 4000);
    console.log("\n  1. zoom 100 %, module armé  : " + JSON.stringify(a100));

    /* ---- 2. À 400 %, par NOTRE chemin ----
     *
     * `depuis: 'contenu'`, et c'est tout le sujet : le pont n'écoute QUE cette
     * direction. Un premier jet a envoyé « depuis: page », que le pont ignore —
     * le zoom est resté à 100 et les trois mesures se valaient, ce qui donnait
     * une conclusion parfaitement rassurante et parfaitement vide. On vérifie
     * donc que le zoom a bougé AVANT de chronométrer quoi que ce soit. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 400 }, '*');");
    await dors(3000);
    const zoomAtteint = await driver.executeScript(MAGASIN_ENGINE + "var st = __eng(); return st ? st.zoom : null;");
    console.log("\n  zoom effectivement atteint : " + zoomAtteint);
    if (zoomAtteint !== 400) {
      console.log("  LE ZOOM N'EST PAS MONTÉ — la mesure ne voudrait rien dire.");
      return 1;
    }
    const a400 = await driver.executeAsyncScript(MESURE, 4000);
    console.log("  2. zoom 400 %, module armé  : " + JSON.stringify(a400));

    /* ET PENDANT QU'ON TOURNE LA MOLETTE, ce qui est le geste de l'auteur : un
     * coût qui n'apparaît qu'au moment du cran ne se verrait pas sur une mesure
     * au repos. Dix crans, espacés comme une vraie molette. */
    const pendant = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1];" +
      "var cv = window.MeshScene.getEngine().getRenderingCanvas();" +
      "var t0 = performance.now(), prec = t0, ecarts = [], n = 0;" +
      "function tour() {" +
      "  var t = performance.now(); ecarts.push(t - prec); prec = t;" +
      "  if (n < 10 && ecarts.length % 6 === 0) {" +
      "    n++; cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -102, bubbles: true, cancelable: true })); }" +
      "  if (t - t0 < 4000) { requestAnimationFrame(tour); return; }" +
      "  ecarts.sort(function (a, b) { return a - b; });" +
      "  cb({ crans: n, trames: ecarts.length," +
      "    median: +(ecarts[Math.floor(ecarts.length / 2)] || 0).toFixed(2)," +
      "    pire: +(ecarts[ecarts.length - 1] || 0).toFixed(2)," +
      "    lentes: ecarts.filter(function (x) { return x > 33; }).length,"  +
      "    etats: window.__vttinkerEtats || 0 });" +
      "}" +
      "requestAnimationFrame(tour);");
    console.log("  2 bis. pendant dix crans de molette : " + JSON.stringify(pendant));

    /* ---- 3. À 400 %, module ÉTEINT, zoom posé À LA MAIN ----
     *
     * On retire les bornes : le pont rend son setZoom à Roll20 et retire sa
     * molette. Puis on écrit le zoom dans SON magasin et on pose SA caméra
     * exactement comme le module le ferait — mais sans une ligne de notre code
     * en vol. Ce qui reste est à lui. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');");
    await dors(1500);
    const eteint = await driver.executeScript(MAGASIN_ENGINE +
      "var st = __eng(); if (!st) { return null; }" +
      /* SON PROPRE CONTRÔLE DE ZOOM LE RAMÈNE DANS SA PLAGE en moins de soixante
       * millisecondes — c'est mesuré, et c'est la raison pour laquelle le module
       * le masque. En le rendant, le pont l'a réaffiché : sans le masquer ici, il
       * ramènerait 400 à 250 et on mesurerait un zoom qu'on n'a pas demandé. Le
       * premier jet est tombé dans ce piège, et le relevé disait « zoom: 250 »
       * sous une ligne annonçant 400. */
      "var z = document.getElementById('vm_zoom_buttons');" +
      "if (z) { z.style.display = 'none'; }" +
      "try { st.$patch({ zoom: 400 }); } catch (e) {}" +
      "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas();" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var ht = (cv.height / 2) * (100 / 400), lg = (cv.width / 2) * (100 / 400);" +
      "c.orthoTop = ht; c.orthoBottom = -ht; c.orthoRight = lg; c.orthoLeft = -lg;" +
      "return { zoom: st.zoom, molettes: 'retirées' };");
    console.log("\n  module éteint : " + JSON.stringify(eteint));
    await dors(3000);
    const sansNous = await driver.executeAsyncScript(MESURE, 4000);
    console.log("  3. zoom 400 %, module ÉTEINT : " + JSON.stringify(sansNous));

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  médiane par trame :  100 % = " + a100.median + " ms" +
                "   |  400 % armé = " + a400.median + " ms" +
                "   |  400 % éteint = " + sansNous.median + " ms");
    const notre = a400.median > a100.median * 1.5 && a400.median > sansNous.median * 1.4;
    console.log("  → le surcoût à 400 % vient-il de NOUS ? " + (notre ? "OUI" : "NON"));
    if (!notre && sansNous.median > a100.median * 1.5) {
      console.log("    (il vient de Roll20 : sans nous, c'est aussi lent)");
    }
    releve("pourquoi-ca-rame.json", { a100, a400, sansNous });
    return 0;
  } finally {
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');" +
      "var n = document.querySelectorAll('[data-v-app]');" +
      "for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "  var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "  if (p && p._s && p._s.get('engine')) { try { p._s.get('engine').setZoom(100); } catch (e) {} } }")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE COÛTE UN CRAN, MORCEAU PAR MORCEAU ----------
 *
 * La mesure précédente a montré où ça rame : pas au repos — 9 ms par trame à
 * 400 % comme à 100 % — mais PENDANT la molette, où quatre secondes n'ont rendu
 * que trente-sept trames et où l'une a duré 716 ms.
 *
 * Le cran hors plage native fait trois choses : `setZoomSilent` de Roll20, un
 * `$patch` sur son magasin si la première n'a pas pris, et l'écriture de la
 * caméra. On les chronomètre SÉPARÉMENT, et on compare à un cran DANS sa plage,
 * qu'il traite entièrement lui-même. Sans cette dernière comparaison, on
 * n'aurait aucun moyen de savoir si le coût est le nôtre ou le sien. */
async function coutDunCran() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(8000);

    const ENG =
      "function __eng() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }" +
      "function __chrono(f, n) { var t = [];" +
      "  for (var i = 0; i < n; i++) { var t0 = performance.now(); try { f(i); } catch (e) {}" +
      "    t.push(+(performance.now() - t0).toFixed(2)); } " +
      "  var s = t.slice().sort(function (a, b) { return a - b; });" +
      "  return { mesures: t, median: s[Math.floor(s.length / 2)], pire: s[s.length - 1]," +
      "    total: +t.reduce(function (a, b) { return a + b; }, 0).toFixed(1) }; }";

    /* ---- A. UN CRAN DANS SA PLAGE, qu'il traite seul ---- */
    const dansSaPlage = await driver.executeScript(ENG +
      "var st = __eng(); if (!st) { return null; }" +
      "st.setZoom(120);" +
      "return __chrono(function (i) { st.setZoom(120 + i * 10); }, 10);");
    console.log("\n  A. dix crans DANS sa plage (120 → 210), son propre setZoom :");
    console.log("     " + JSON.stringify(dansSaPlage));

    /* ---- B. UN CRAN HORS PLAGE, par notre chemin complet ---- */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 900 }, '*');");
    await dors(2000);
    const horsPlage = await driver.executeScript(ENG +
      "var st = __eng(); if (!st) { return null; }" +
      "st.setZoom(300);" +
      "return __chrono(function (i) { st.setZoom(300 + i * 20); }, 10);");
    console.log("\n  B. dix crans HORS plage (300 → 480), NOTRE chemin complet :");
    console.log("     " + JSON.stringify(horsPlage));

    /* ---- C. LES MORCEAUX, un par un, module éteint ---- */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');");
    await dors(1500);
    const morceaux = await driver.executeScript(ENG +
      "var st = __eng(); if (!st) { return null; }" +
      "var z = document.getElementById('vm_zoom_buttons'); if (z) { z.style.display = 'none'; }" +
      "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas();" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var out = {};" +
      "out.setZoomSilent = (typeof st.setZoomSilent === 'function')" +
      "  ? __chrono(function (i) { st.setZoomSilent(300 + i * 20); }, 10) : 'absent';" +
      "out.patch = __chrono(function (i) { st.$patch({ zoom: 500 + i * 20 }); }, 10);" +
      "out.camera = __chrono(function (i) {" +
      "  var zz = 300 + i * 20;" +
      "  var ht = (cv.height / 2) * (100 / zz), lg = (cv.width / 2) * (100 / zz);" +
      "  c.orthoTop = ht; c.orthoBottom = -ht; c.orthoRight = lg; c.orthoLeft = -lg; }, 10);" +
      "return out;");
    console.log("\n  C. les morceaux, module éteint :");
    Object.keys(morceaux || {}).forEach((k) => {
      console.log("     " + k.padEnd(15) + " : " + JSON.stringify(morceaux[k]));
    });

    console.log("\n  ──────────────────────────────────────────────");
    if (dansSaPlage && horsPlage) {
      console.log("  médiane d'un cran :  dans sa plage = " + dansSaPlage.median + " ms" +
                  "   |  hors plage, par nous = " + horsPlage.median + " ms");
      const notre = horsPlage.median > dansSaPlage.median * 1.6;
      console.log("  → le cran hors plage coûte-t-il plus cher que le sien ? " + (notre ? "OUI" : "NON"));
    }
    releve("cout-dun-cran.json", { dansSaPlage, horsPlage, morceaux });
    return 0;
  } finally {
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');" +
      "var n = document.querySelectorAll('[data-v-app]');" +
      "for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "  var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "  if (p && p._s && p._s.get('engine')) { try { p._s.get('engine').setZoom(100); } catch (e) {} } }" +
      "var z = document.getElementById('vm_zoom_buttons'); if (z) { z.style.display = ''; }")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE GEL EST DIFFÉRÉ : OÙ TOMBE-T-IL ? ----------
 *
 * Un cran ne coûte que zéro à une milliseconde de code synchrone — mesuré,
 * morceau par morceau. Le gel de 716 ms est donc dans ce que Roll20 refait
 * ENSUITE, sur sa boucle de rendu.
 *
 * Reste la seule question qui décide de ce qu'on peut y faire : ce gel
 * apparaît-il aussi quand on tourne la molette DANS sa plage, où il fait tout
 * lui-même ? Si oui, zoomer coûte ce qu'il coûte et le franchissement de 250
 * n'y est pour rien. Si non, quelque chose se déclenche au-delà, et il faut
 * savoir quoi. On chronomètre donc les TRAMES autour des crans, et non les
 * appels.
 *
 * On regarde aussi ce que la scène porte de plus : un maillage qui apparaît au
 * moment du gel se voit dans le compte. */
async function gelDifferre() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(8000);

    const ENG =
      "function __eng() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }";

    /* Le chronomètre à crans : on tourne la molette tous les N trames et on
     * garde le pire écart observé APRÈS chaque cran — c'est là que tombe le
     * travail différé. */
    const AUTOUR =
      "var cb = arguments[arguments.length - 1];" +
      "var depart = arguments[0], pas = arguments[1], crans = arguments[2];" +
      "function eng() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }" +
      "var st = eng(), S = window.MeshScene, e = S.getEngine();" +
      "var cv = e.getRenderingCanvas();" +
      "st.setZoom(depart);" +
      "var prec = performance.now(), n = 0, k = 0, pires = [], pire = 0, tout = [];" +
      "var m0 = (S.meshes || []).length;" +
      /* LE GESTE DE L'UTILISATEUR EST UN CRAN DE MOLETTE, pas un appel à setZoom.
       * Le premier jet appelait `st.setZoom(...)` — c'est-à-dire notre fonction
       * remplacée, qui applique tout de suite parce qu'une demande explicite est
       * une intention unique. Il ne mesurait donc PAS le chemin qu'on venait de
       * corriger, et concluait à l'absence d'effet d'une correction qu'il ne
       * traversait jamais. On envoie de vrais événements de molette sur la toile. */
      "function tour() {" +
      "  var t = performance.now(), d = t - prec; prec = t;" +
      "  tout.push(d); if (d > pire) { pire = d; }" +
      "  k++;" +
      "  if (k >= 20) { k = 0;" +
      "    if (n > 0) { pires.push(+pire.toFixed(1)); }" +
      "    pire = 0;" +
      "    if (n < crans) { n++;" +
      "      cv.dispatchEvent(new WheelEvent('wheel', { deltaY: pas > 0 ? -102 : 102," +
      "        bubbles: true, cancelable: true })); }" +
      /* ON LAISSE RETOMBER LE DÉLAI DE FIN DE GESTE avant de conclure : la
       * dernière reconstruction, celle qui est légitime, tombe après. */
      "    else if (k === 0 && n === crans) { n++;" +
      "      setTimeout(function () {" +
      "        tout.sort(function (a, b) { return a - b; });" +
      "        cb({ crans: crans, zoomFinal: st.zoom, trames: tout.length," +
      "          median: +(tout[Math.floor(tout.length / 2)] || 0).toFixed(1)," +
      "          piresParCran: pires," +
      "          pireGlobal: +(tout[tout.length - 1] || 0).toFixed(1)," +
      "          maillagesAvant: m0, maillagesApres: (S.meshes || []).length," +
      "          texturesApres: (S.textures || []).length }); }, 700); return; }" +
      "    else { tout.sort(function (a, b) { return a - b; });" +
      "      cb({ crans: n, zoomFinal: st.zoom, trames: tout.length," +
      "        median: +(tout[Math.floor(tout.length / 2)] || 0).toFixed(1)," +
      "        piresParCran: pires," +
      "        pireGlobal: +(tout[tout.length - 1] || 0).toFixed(1)," +
      "        maillagesAvant: m0, maillagesApres: (S.meshes || []).length," +
      "        texturesApres: (S.textures || []).length }); return; } }" +
      "  requestAnimationFrame(tour); }" +
      "requestAnimationFrame(tour);";

    /* ---- A. DANS SA PLAGE, module NON armé : il fait tout ---- */
    const a = await driver.executeAsyncScript(AUTOUR, 120, 12, 10);
    console.log("\n  A. dix crans DANS sa plage (120 → 240), Roll20 seul :");
    console.log("     " + JSON.stringify(a));

    /* ---- B. AU-DELÀ, par notre chemin ---- */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 900 }, '*');");
    await dors(2000);
    const b = await driver.executeAsyncScript(AUTOUR, 300, 20, 10);
    console.log("\n  B. dix crans AU-DELÀ (300 → 500), notre chemin :");
    console.log("     " + JSON.stringify(b));

    /* ---- C. AU-DELÀ, mais en repassant sous 250 puis en remontant ----
     *
     * Le franchissement lui-même est peut-être le moment coûteux : Roll20
     * pourrait refaire son fond à une résolution qu'il ne prépare que là. */
    const c = await driver.executeAsyncScript(AUTOUR, 200, 15, 10);
    console.log("\n  C. dix crans À CHEVAL sur 250 (200 → 350) :");
    console.log("     " + JSON.stringify(c));

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  pires trames par cran :");
    console.log("     dans sa plage : " + JSON.stringify(a && a.piresParCran));
    console.log("     au-delà       : " + JSON.stringify(b && b.piresParCran));
    console.log("     à cheval      : " + JSON.stringify(c && c.piresParCran));
    releve("gel-differe.json", { a, b, c });
    return 0;
  } finally {
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');" +
      "var n = document.querySelectorAll('[data-v-app]');" +
      "for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "  var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "  if (p && p._s && p._s.get('engine')) { try { p._s.get('engine').setZoom(100); } catch (e) {} } }")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LAQUELLE DES TROIS ÉCRITURES GÈLE LA PARTIE ? ----------
 *
 * Au-delà de 250 %, un cran coûte 550 ms au lieu de 15, et la scène passe de
 * onze à quarante-six textures : Roll20 refait son fond à chaque cran. Le
 * chemin hors plage écrit trois choses — `setZoomSilent`, un `$patch` sur son
 * magasin, et la caméra. Une seule, sans doute, déclenche la reconstruction.
 *
 * On les fait donc UNE PAR UNE, module éteint, en chronométrant les trames qui
 * SUIVENT chacune et en comptant les textures. C'est cette mesure qui décide du
 * correctif : si c'est le magasin, on peut le faire attendre la fin du geste et
 * ne payer qu'une reconstruction au lieu de dix ; si c'est la caméra, il n'y a
 * rien à différer, puisque c'est elle qui donne l'image. */
async function quiGele() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(8000);

    /* Le module reste ÉTEINT : on veut le comportement de Roll20, pas le nôtre.
     * Son contrôle de zoom est masqué, sans quoi il ramènerait tout sous 250. */
    await driver.executeScript(
      "var z = document.getElementById('vm_zoom_buttons'); if (z) { z.style.display = 'none'; }");

    const UN =
      "var cb = arguments[arguments.length - 1], quoi = arguments[0], depart = arguments[1];" +
      "function eng() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }" +
      "var st = eng(), S = window.MeshScene, e = S.getEngine();" +
      "var cv = e.getRenderingCanvas();" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "function camera(z) { var ht = (cv.height / 2) * (100 / z), lg = (cv.width / 2) * (100 / z);" +
      "  c.orthoTop = ht; c.orthoBottom = -ht; c.orthoRight = lg; c.orthoLeft = -lg; }" +
      /* On part d'un état stable, on laisse retomber, puis on fait UNE chose. */
      "var tex0 = (S.textures || []).length;" +
      "var prec = performance.now(), pire = 0, n = 0, fait = false;" +
      "function tour() {" +
      "  var t = performance.now(), d = t - prec; prec = t;" +
      "  if (fait && d > pire) { pire = d; }" +
      "  n++;" +
      "  if (n === 10 && !fait) { fait = true;" +
      "    if (quoi === 'silent' && typeof st.setZoomSilent === 'function') { st.setZoomSilent(depart); }" +
      "    else if (quoi === 'patch') { try { st.$patch({ zoom: depart }); } catch (x) {} }" +
      "    else if (quoi === 'camera') { camera(depart); }" +
      "    prec = performance.now(); return requestAnimationFrame(tour); }" +
      "  if (n < 90) { return requestAnimationFrame(tour); }" +
      "  cb({ quoi: quoi, zoom: st.zoom, pireApres: +pire.toFixed(1)," +
      "    texAvant: tex0, texApres: (S.textures || []).length }); }" +
      "requestAnimationFrame(tour);";

    const remets = async () => {
      await driver.executeScript(
        "function eng() { var n = document.querySelectorAll('[data-v-app]');" +
        "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
        "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
        "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }" +
        "var st = eng(); try { st.setZoom(100); } catch (e) {}" +
        "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas();" +
        "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
        "c.orthoTop = cv.height / 2; c.orthoBottom = -cv.height / 2;" +
        "c.orthoRight = cv.width / 2; c.orthoLeft = -cv.width / 2;");
      await dors(2500);
    };

    const out = [];
    for (const quoi of ["camera", "patch", "silent"]) {
      await remets();
      const r = await driver.executeAsyncScript(UN, quoi, 400);
      out.push(r);
      console.log("\n  " + quoi.padEnd(7) + " → " + JSON.stringify(r));
    }
    await remets();

    console.log("\n  ──────────────────────────────────────────────");
    out.forEach((r) => {
      console.log("  " + r.quoi.padEnd(7) + " : pire trame après = " + r.pireApres +
                  " ms, textures " + r.texAvant + " → " + r.texApres);
    });
    const coupable = out.slice().sort((x, y) => y.pireApres - x.pireApres)[0];
    console.log("\n  → ce qui gèle : " + (coupable ? coupable.quoi : "?"));
    releve("qui-gele.json", out);
    return 0;
  } finally {
    await driver.executeScript(
      "var z = document.getElementById('vm_zoom_buttons'); if (z) { z.style.display = ''; }" +
      "var n = document.querySelectorAll('[data-v-app]');" +
      "for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "  var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "  if (p && p._s && p._s.get('engine')) { try { p._s.get('engine').setZoom(100); } catch (e) {} } }")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- JUSQU'OÙ LE ZOOM RESTE TENABLE, AU REPOS ----------
 *
 * L'auteur signale que ça rame de nouveau. Une hypothèse tient debout : depuis
 * que les crans ne coûtent plus rien, on monte BEAUCOUP plus haut qu'avant —
 * là où l'on s'arrêtait à 300 parce que chaque cran gelait une demi-seconde, on
 * file maintenant à 900 sans s'en apercevoir. Le coût aurait alors simplement
 * changé de place : plus dans le geste, mais dans l'état où il nous laisse.
 *
 * On mesure donc les trames AU REPOS, palier par palier, tout allumé. Et on
 * relève à chaque palier ce que la scène porte — textures, maillages — et si la
 * caméra reste où on l'a posée : si Roll20 la reprend, on la lui redonne, et
 * cette lutte-là se verrait sur la durée des trames sans se voir ailleurs. */
async function zoomLourd() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    /* TOUT EST DANS L'ÉTAT OÙ L'EXTENSION LE MET, sans qu'on force quoi que ce
     * soit : c'est ce que l'auteur a sous les yeux. On relève les modules
     * réellement en marche avant de mesurer, sinon on ne saura pas de quoi on
     * parle. */
    const modules = await driver.executeScript(
      "return { journal: (window.__vttinkerJournal || []).slice(0, 6)," +
      "  grille: (window.MeshScene.meshes || []).filter(function (m) {" +
      "    return /vttk|grille/i.test(m.name); }).map(function (m) { return m.name; })," +
      "  marqueurs: (window.MeshScene.meshes || []).filter(function (m) {" +
      "    return /^vttk-/.test(m.name); }).length };");
    console.log("\n  ce qui tourne : " + JSON.stringify(modules, null, 1));

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 1200 }, '*');");
    await dors(2000);

    const REPOS =
      "var cb = arguments[arguments.length - 1], ms = arguments[0];" +
      "var S = window.MeshScene, e = S.getEngine();" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var haut0 = c.orthoTop;" +
      "var t0 = performance.now(), prec = t0, ec = [];" +
      "function tour() {" +
      "  var t = performance.now(); ec.push(t - prec); prec = t;" +
      "  if (t - t0 < ms) { return requestAnimationFrame(tour); }" +
      "  ec.sort(function (a, b) { return a - b; });" +
      "  cb({ trames: ec.length, fps: Math.round(e.getFps())," +
      "    median: +(ec[Math.floor(ec.length / 2)] || 0).toFixed(1)," +
      "    p90: +(ec[Math.floor(ec.length * 0.9)] || 0).toFixed(1)," +
      "    pire: +(ec[ec.length - 1] || 0).toFixed(1)," +
      "    lentes: ec.filter(function (x) { return x > 33; }).length," +
      "    textures: (S.textures || []).length, maillages: (S.meshes || []).length," +
      "    cameraBouge: +(c.orthoTop - haut0).toFixed(3)," +
      "    memoire: (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null) });" +
      "}" +
      "requestAnimationFrame(tour);";

    const paliers = [100, 250, 400, 600, 800, 1000];
    const releves = [];
    for (const z of paliers) {
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: arguments[0] }, '*');", z);
      await dors(3500);
      const r = await driver.executeAsyncScript(REPOS, 3000);
      r.demande = z;
      releves.push(r);
      console.log("  " + String(z).padStart(5) + " % → " + JSON.stringify(r));
    }

    console.log("\n  ──────────────────────────────────────────────");
    console.log("  palier   médiane   p90    pire   trames>33ms   textures   Mo");
    releves.forEach((r) => {
      console.log("  " + String(r.demande).padStart(5) + " %  " +
        String(r.median).padStart(7) + " " + String(r.p90).padStart(6) + " " +
        String(r.pire).padStart(7) + " " + String(r.lentes).padStart(11) + " " +
        String(r.textures).padStart(10) + " " + String(r.memoire).padStart(5));
    });
    const base = releves[0], haut = releves[releves.length - 1];
    console.log("\n  → au repos, le zoom élevé coûte-t-il ? " +
      (haut.median > base.median * 1.8 || haut.lentes > base.lentes + 5 ? "OUI" : "NON"));
    releve("zoom-lourd.json", { modules, releves });
    return 0;
  } finally {
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 100 }, '*');")
      .catch(() => {});
    await dors(800);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUI TRAVAILLE PENDANT QU'ON JOUE ? ----------
 *
 * Au repos, même à 1000 %, la partie tient 180 images par seconde : le zoom
 * élevé n'est pas le problème. Le coût est donc dans l'interaction, et il faut
 * savoir LAQUELLE et à cause de QUOI.
 *
 * On compare donc trois gestes ordinaires — déplacer la carte, déplacer un
 * token, tourner la molette — module ÉTEINT puis ALLUMÉ, à 100 % puis à 500 %.
 * Et on instrumente au passage ce que l'extension fabrique : combien de
 * matériaux, combien de textures, combien de poses de marqueurs. Un compte qui
 * grimpe pendant un geste désigne son coupable sans qu'on ait à le deviner.
 *
 * ON VÉRIFIE AUSSI L'IDENTITÉ DE LA SCÈNE. Une garde ajoutée récemment vide les
 * caches de matériaux dès que `window.MeshScene` change d'identité ; si cette
 * propriété était un accesseur rendant un objet neuf à chaque lecture, la garde
 * recompilerait TOUS les shaders à chaque changement de marqueur. C'est le
 * genre de méprise qui ne se voit qu'en la mesurant. */
async function quiTravaille() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const identite = await driver.executeScript(
      "var a = window.MeshScene, b = window.MeshScene;" +
      "var d = Object.getOwnPropertyDescriptor(window, 'MeshScene');" +
      "return { stable: a === b, accesseur: !!(d && d.get)," +
      "  memeApres: (function () { var c = window.MeshScene; return c === a; })() };");
    console.log("\n  window.MeshScene est-il stable ? " + JSON.stringify(identite));

    /* ON NE COMPTE PAS, ON NOMME. Un compteur dit qu'il s'est fabriqué cinq
     * maillages ; il ne dit pas QUI les fabrique, et c'est la seule chose qui
     * décide de la suite. On retient donc le nom de chacun et la pile d'appel
     * qui l'a créé — trois lignes suffisent à désigner le module fautif. */
    await driver.executeScript(
      "var S = window.MeshScene;" +
      "window.__vtk = { mat: [], tex: [], quads: [] };" +
      "function pile() { try { return String(new Error().stack || '').split('\\n').slice(2, 5)" +
      "  .map(function (l) { return l.trim().slice(0, 90); }).join(' | '); } catch (e) { return '?'; } }" +
      "function espionne(tab, cle) {" +
      "  var natif = tab.push.bind(tab);" +
      "  tab.push = function () {" +
      "    for (var i = 0; i < arguments.length; i++) {" +
      "      if (window.__vtk[cle].length < 40) {" +
      "        window.__vtk[cle].push({ nom: String(arguments[i] && arguments[i].name || '?').slice(0, 46), ou: pile() }); } }" +
      "    return natif.apply(null, arguments); }; }" +
      "espionne(S.materials, 'mat'); espionne(S.textures, 'tex'); espionne(S.meshes, 'quads');");

    const GESTE =
      "var cb = arguments[arguments.length - 1], quoi = arguments[0];" +
      "var S = window.MeshScene, e = S.getEngine(), cv = e.getRenderingCanvas();" +
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "var g0 = t ? t.attributes.left : 0;" +
      "window.__vtk = { mat: [], tex: [], quads: [] };" +
      "var r = cv.getBoundingClientRect();" +
      "var cx = r.left + r.width / 2, cy = r.top + r.height / 2;" +
      "var prec = performance.now(), ec = [], n = 0, k = 0;" +
      "function agis() {" +
      "  if (quoi === 'carte') {" +
      "    cv.dispatchEvent(new PointerEvent('pointermove', { clientX: cx + (n % 40) - 20," +
      "      clientY: cy + (n % 30) - 15, bubbles: true, buttons: 4, pointerId: 3 })); }" +
      "  else if (quoi === 'token' && t) { t.save({ left: g0 + (n % 20) * 5 }); }" +
      "  else if (quoi === 'molette') {" +
      "    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: (n % 2) ? 102 : -102," +
      "      bubbles: true, cancelable: true })); } }" +
      "function tour() {" +
      "  var tt = performance.now(); ec.push(tt - prec); prec = tt;" +
      "  k++; if (k >= 3) { k = 0; n++; agis(); }" +
      "  if (n < 60) { return requestAnimationFrame(tour); }" +
      "  if (t) { t.save({ left: g0 }); }" +
      "  ec.sort(function (a, b) { return a - b; });" +
      "  cb({ geste: quoi, gestes: n, trames: ec.length," +
      "    median: +(ec[Math.floor(ec.length / 2)] || 0).toFixed(1)," +
      "    p90: +(ec[Math.floor(ec.length * 0.9)] || 0).toFixed(1)," +
      "    pire: +(ec[ec.length - 1] || 0).toFixed(1)," +
      "    lentes: ec.filter(function (x) { return x > 33; }).length," +
      "    fabrique: window.__vtk }); }" +
      "requestAnimationFrame(tour);";

    const serie = async (titre) => {
      console.log("\n  ── " + titre + " ──");
      for (const quoi of ["carte", "token", "molette"]) {
        const r = await driver.executeAsyncScript(GESTE, quoi).catch((e) => ({ geste: quoi, erreur: String(e.message).slice(0, 80) }));
        const f = r.fabrique || {};
        console.log("     " + quoi.padEnd(8) +
          " médiane " + String(r.median).padStart(4) + " | p90 " + String(r.p90).padStart(5) +
          " | pire " + String(r.pire).padStart(6) + " | lentes " + String(r.lentes).padStart(3) +
          (r.erreur ? "   ERREUR " + r.erreur : ""));
        ["quads", "mat", "tex"].forEach((cle) => {
          (f[cle] || []).slice(0, 4).forEach((x) => {
            console.log("        " + cle + " « " + x.nom + " »");
            console.log("           " + x.ou);
          });
          if ((f[cle] || []).length > 4) { console.log("        … et " + ((f[cle] || []).length - 4) + " autres " + cle); }
        });
        await dors(700);
      }
    };

    await serie("module de zoom ÉTEINT, à 100 %");

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 1200 }, '*');");
    await dors(2000);
    await serie("module ALLUMÉ, à 100 %");

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 500 }, '*');");
    await dors(3500);
    await serie("module ALLUMÉ, à 500 %");

    releve("qui-travaille.json", { identite });
    return 0;
  } finally {
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 100 }, '*');")
      .catch(() => {});
    await dors(800);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- ET SI ON NE LUI DISAIT RIEN DU TOUT ? ----------
 *
 * Toutes les mesures convergent : ce qui coûte, c'est que Roll20 APPREND le
 * zoom. Chaque écriture dans son magasin lui fait refaire son fond, et ça vaut
 * de 600 à 2 000 ms selon qu'on franchit sa borne ou non. Le délai de fin de
 * geste réduit le NOMBRE de reconstructions ; il ne peut rien sur leur prix, et
 * il en reste toujours au moins une par geste.
 *
 * D'où la question qui vaut d'être posée : la caméra suffit-elle ? C'est elle
 * qui produit l'image — l'écrire coûte quatre nombres et n'a créé aucune texture
 * quand on l'a mesurée seule. Si l'on peut zoomer en ne touchant QUE la caméra,
 * le zoom étendu devient gratuit.
 *
 * Trois choses à vérifier, et aucune ne se devine :
 *   1. la vue zoome-t-elle vraiment ? (capture à l'appui, pas un nombre) ;
 *   2. Roll20 reprend-il sa caméra ? S'il la recalcule depuis son magasin à la
 *      première occasion, la vue sauterait en arrière au premier clic ;
 *   3. que coûte un geste entier dans ce régime ? */
async function cameraSeule() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const CAM =
      "function cam() { var S = window.MeshScene;" +
      "  return (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera; }";

    await capture(driver, "cam-avant.png");
    const avant = await driver.executeScript(CAM +
      "var c = cam(); return { haut: +c.orthoTop.toFixed(1), large: +c.orthoRight.toFixed(1) };");
    console.log("\n  caméra au départ : " + JSON.stringify(avant));

    /* On écrit la caméra pour 400 %, et RIEN d'autre. Le magasin de Roll20 reste
     * là où il est ; on ne le prévient pas. */
    const pose = await driver.executeScript(CAM +
      "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas(), c = cam();" +
      "var ht = (cv.height / 2) * (100 / 400), lg = (cv.width / 2) * (100 / 400);" +
      "c.orthoTop = ht; c.orthoBottom = -ht; c.orthoRight = lg; c.orthoLeft = -lg;" +
      "return { haut: +c.orthoTop.toFixed(1), textures: (S.textures || []).length };");
    console.log("  après écriture de la seule caméra : " + JSON.stringify(pose));

    await dors(2500);
    const tenue = await driver.executeScript(CAM +
      "var c = cam(); return { haut: +c.orthoTop.toFixed(1) };");
    console.log("  deux secondes plus tard : " + JSON.stringify(tenue) +
      (Math.abs(tenue.haut - pose.haut) < 0.5 ? "   (elle tient)" : "   ROLL20 L'A REPRISE"));
    await capture(driver, "cam-apres.png");

    /* Un vrai geste dans ce régime : cinquante crans de caméra, rien de plus. */
    const geste = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1];" +
      "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas();" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var z = 400, t0 = performance.now(), prec = t0, ec = [], n = 0;" +
      "var tex0 = (S.textures || []).length;" +
      "function tour() {" +
      "  var t = performance.now(); ec.push(t - prec); prec = t;" +
      "  if (n < 50) { n++; z = z * 1.03;" +
      "    var ht = (cv.height / 2) * (100 / z), lg = (cv.width / 2) * (100 / z);" +
      "    c.orthoTop = ht; c.orthoBottom = -ht; c.orthoRight = lg; c.orthoLeft = -lg; }" +
      "  if (t - t0 < 3000) { return requestAnimationFrame(tour); }" +
      "  ec.sort(function (a, b) { return a - b; });" +
      "  cb({ crans: n, zoomAtteint: Math.round(z), trames: ec.length," +
      "    median: +(ec[Math.floor(ec.length / 2)] || 0).toFixed(1)," +
      "    pire: +(ec[ec.length - 1] || 0).toFixed(1)," +
      "    lentes: ec.filter(function (x) { return x > 33; }).length," +
      "    texAvant: tex0, texApres: (S.textures || []).length }); }" +
      "requestAnimationFrame(tour);");
    console.log("\n  cinquante crans de CAMÉRA SEULE : " + JSON.stringify(geste));

    /* Et la vue survit-elle à une interaction ordinaire ? */
    await driver.executeScript(
      "var cv = window.MeshScene.getEngine().getRenderingCanvas();" +
      "var r = cv.getBoundingClientRect();" +
      "cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 40, clientY: r.top + 40," +
      "  bubbles: true, pointerId: 7, button: 0, buttons: 1 }));" +
      "cv.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 40, clientY: r.top + 40," +
      "  bubbles: true, pointerId: 7, button: 0, buttons: 0 }));");
    await dors(1800);
    const apresClic = await driver.executeScript(CAM +
      "var c = cam(); return { haut: +c.orthoTop.toFixed(1) };");
    console.log("  après un clic sur le plateau : " + JSON.stringify(apresClic));
    await capture(driver, "cam-apres-clic.png");

    releve("camera-seule.json", { avant, pose, tenue, geste, apresClic });
    return 0;
  } finally {
    await driver.executeScript(
      "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas();" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "c.orthoTop = cv.height / 2; c.orthoBottom = -cv.height / 2;" +
      "c.orthoRight = cv.width / 2; c.orthoLeft = -cv.width / 2;" +
      "var q = document.querySelectorAll('[data-v-app]');" +
      "for (var i = 0; i < q.length; i++) { var a = q[i].__vue_app__;" +
      "  var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "  if (p && p._s && p._s.get('engine')) { try { p._s.get('engine').setZoom(100); } catch (e) {} } }")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- UN GESTE LONG, COMME ON JOUE VRAIMENT ----------
 *
 * Toutes les sondes précédentes tournent la molette dix ou vingt fois. Un
 * joueur, lui, la tourne pendant des secondes, dans les deux sens, plusieurs
 * fois de suite. Si quelque chose S'ACCUMULE — des minuteries, des écouteurs,
 * des textures, des matériaux —, seule la durée le montre.
 *
 * On relève donc l'état AVANT, on tourne trois cents crans en alternant les
 * sens et en marquant des pauses (celles qui laissent le délai de fin de geste
 * retomber, donc celles qui déclenchent une reconstruction chez Roll20), et on
 * relève APRÈS. Ce qui a grossi désigne ce qui fuit. */
async function gesteLong() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const ETAT =
      "var S = window.MeshScene;" +
      "return { textures: (S.textures || []).length, materiaux: (S.materials || []).length," +
      "  maillages: (S.meshes || []).length," +
      "  memoire: (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)," +
      "  etats: window.__vttinkerEtats || 0 };";

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 1200 }, '*');");
    await dors(2000);

    const avant = await driver.executeScript(ETAT);
    console.log("\n  avant : " + JSON.stringify(avant));

    /* Trois cents crans, en six salves de cinquante, avec une pause entre
     * chacune — c'est la pause qui provoque la reconstruction, donc c'est elle
     * qu'il faut répéter. */
    const salves = [];
    for (let s = 0; s < 6; s++) {
      const r = await driver.executeAsyncScript(
        "var cb = arguments[arguments.length - 1], sens = arguments[0];" +
        "var cv = window.MeshScene.getEngine().getRenderingCanvas();" +
        "var t0 = performance.now(), prec = t0, ec = [], n = 0;" +
        "function tour() {" +
        "  var t = performance.now(); ec.push(t - prec); prec = t;" +
        "  if (n < 50) { n++;" +
        "    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: sens, bubbles: true, cancelable: true })); }" +
        "  if (t - t0 < 3000) { return requestAnimationFrame(tour); }" +
        "  ec.sort(function (a, b) { return a - b; });" +
        "  cb({ crans: n, trames: ec.length," +
        "    median: +(ec[Math.floor(ec.length / 2)] || 0).toFixed(1)," +
        "    pire: +(ec[ec.length - 1] || 0).toFixed(1)," +
        "    lentes: ec.filter(function (x) { return x > 33; }).length }); }" +
        "requestAnimationFrame(tour);", s % 2 ? 102 : -102);
      const e = await driver.executeScript(ETAT);
      salves.push({ salve: s + 1, sens: s % 2 ? "bas" : "haut", ...r, ...e });
      console.log("  salve " + (s + 1) + " (" + (s % 2 ? "dézoom" : "zoom") + ") : " +
        "médiane " + String(r.median).padStart(4) + " | pire " + String(r.pire).padStart(7) +
        " | lentes " + String(r.lentes).padStart(3) +
        " | textures " + String(e.textures).padStart(4) +
        " | matériaux " + String(e.materiaux).padStart(4) +
        " | Mo " + String(e.memoire).padStart(5));
      await dors(1200);
    }

    const apres = await driver.executeScript(ETAT);
    console.log("\n  après : " + JSON.stringify(apres));
    console.log("\n  ──────────────────────────────────────────────");
    console.log("  textures  " + avant.textures + " → " + apres.textures +
                "   matériaux " + avant.materiaux + " → " + apres.materiaux +
                "   maillages " + avant.maillages + " → " + apres.maillages);
    const fuit = apres.textures > avant.textures + 20 || apres.materiaux > avant.materiaux + 10;
    console.log("  → quelque chose s'accumule-t-il ? " + (fuit ? "OUI" : "NON"));
    const pire = salves.map((s) => s.median);
    console.log("  → les trames se dégradent-elles salve après salve ? " +
      (pire[pire.length - 1] > pire[0] * 1.6 ? "OUI" : "NON") + "  (" + pire.join(" → ") + ")");
    releve("geste-long.json", { avant, salves, apres });
    return 0;
  } finally {
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 100 }, '*');")
      .catch(() => {});
    await dors(800);
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE VISE VRAIMENT LA MOLETTE SUR LE PLATEAU ----------
 *
 * La garde ajoutée récemment n'agit que si l'événement a lieu sur la toile ou
 * l'un de ses descendants. Elle sert à rendre la molette au tchat, au journal
 * et à notre palette au-delà de 250 %. Mais si Roll20 couvre son canevas d'une
 * surface transparente, la cible d'un VRAI geste ne serait ni la toile ni son
 * enfant — et la garde éteindrait le module sans un mot, ce qui ressemblerait
 * beaucoup à « ça ne marche plus ».
 *
 * Les sondes envoient leurs événements SUR la toile, donc elles ne peuvent pas
 * voir ce défaut-là : elles fabriquent la cible qu'elles espèrent. On demande
 * donc au navigateur ce qu'il y a réellement sous le pointeur. */
async function cibleMolette() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(8000);

    const r = await driver.executeScript(
      "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas();" +
      "var b = cv.getBoundingClientRect();" +
      "var pts = [[b.left + b.width / 2, b.top + b.height / 2]," +
      "           [b.left + b.width * 0.25, b.top + b.height * 0.3]," +
      "           [b.left + b.width * 0.75, b.top + b.height * 0.7]];" +
      "return { canevas: cv.id, points: pts.map(function (p) {" +
      "  var e = document.elementFromPoint(Math.round(p[0]), Math.round(p[1]));" +
      "  var dedans = false, n = e;" +
      "  while (n) { if (n === cv) { dedans = true; break; } n = n.parentNode; }" +
      "  var chemin = [], q = e, k = 0;" +
      "  while (q && k < 5) { chemin.push((q.tagName || '?') + (q.id ? '#' + q.id : '') +" +
      "    (q.className ? '.' + String(q.className).slice(0, 26) : '')); q = q.parentNode; k++; }" +
      "  return { point: [Math.round(p[0]), Math.round(p[1])]," +
      "    estLaToile: e === cv, descendDeLaToile: dedans, chemin: chemin.join('  <  ') }; }) };");

    console.log("\n  canevas : " + r.canevas);
    r.points.forEach((p) => {
      console.log("\n    " + JSON.stringify(p.point) +
        "  toile=" + p.estLaToile + "  descendant=" + p.descendDeLaToile);
      console.log("      " + p.chemin);
    });
    const bon = r.points.every((p) => p.estLaToile || p.descendDeLaToile);
    console.log("\n  → un vrai geste sur le plateau atteint-il la toile ? " + (bon ? "OUI" : "NON"));
    if (!bon) {
      console.log("    LA GARDE « surLaToile » ÉTEINT DONC LE MODULE SANS RIEN DIRE.");
    }
    releve("cible-molette.json", r);
    return bon ? 0 : 1;
  } finally {
    await dors(600);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CHAQUE CRAN, CHRONOMÉTRÉ SYNCHRONEMENT ----------
 *
 * La sonde précédente a buté : la molette à 100 %, module allumé, a bloqué le
 * script trente secondes. Or elle mesurait dans requestAnimationFrame — donc
 * elle ne pouvait RIEN dire du cas où les trames cessent de venir, qui est
 * précisément celui qu'on cherche.
 *
 * `dispatchEvent` exécute les écouteurs de façon SYNCHRONE. On chronomètre donc
 * l'appel lui-même, cran par cran : ce qui coûte apparaît quoi qu'il arrive au
 * rendu, et rien ne peut nous faire attendre. C'est la même leçon que d'habitude
 * — quand l'instrument dépend de ce qu'on mesure, il ment. */
async function cranParCran() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const CRANS =
      "var n = arguments[0], sens = arguments[1];" +
      "var S = window.MeshScene, cv = S.getEngine().getRenderingCanvas();" +
      "function eng() { var q = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < q.length; i++) { var a = q[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('engine')) { return p._s.get('engine'); } } return null; }" +
      "var st = eng(), t = [], zooms = [];" +
      "for (var i = 0; i < n; i++) {" +
      "  var d = sens === 'alterne' ? ((i % 2) ? 102 : -102) : (sens === 'haut' ? -102 : 102);" +
      "  var t0 = performance.now();" +
      "  cv.dispatchEvent(new WheelEvent('wheel', { deltaY: d, bubbles: true, cancelable: true }));" +
      "  t.push(+(performance.now() - t0).toFixed(2));" +
      "  zooms.push(st ? st.zoom : null); }" +
      "var s = t.slice().sort(function (a, b) { return a - b; });" +
      "return { sens: sens, mesures: t, zooms: zooms," +
      "  median: s[Math.floor(s.length / 2)], pire: s[s.length - 1]," +
      "  total: +t.reduce(function (a, b) { return a + b; }, 0).toFixed(1) };";

    const serie = async (titre) => {
      console.log("\n  ── " + titre + " ──");
      for (const sens of ["haut", "alterne"]) {
        const r = await driver.executeScript(CRANS, 20, sens);
        console.log("     " + sens.padEnd(8) + " total " + String(r.total).padStart(8) +
          " ms | médiane " + String(r.median).padStart(6) + " | pire " + String(r.pire).padStart(8));
        console.log("        crans : " + JSON.stringify(r.mesures));
        console.log("        zooms : " + JSON.stringify(r.zooms));
        await dors(1500);
        await driver.executeScript(
          "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom-veut', valeur: 100 }, '*');" +
          "var q = document.querySelectorAll('[data-v-app]');" +
          "for (var i = 0; i < q.length; i++) { var a = q[i].__vue_app__;" +
          "  var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
          "  if (p && p._s && p._s.get('engine')) { try { p._s.get('engine').setZoom(100); } catch (e) {} } }");
        await dors(1500);
      }
    };

    await serie("module ÉTEINT — Roll20 fait tout");

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom'," +
      "  actif: true, min: 2, max: 1200 }, '*');");
    await dors(2000);
    await serie("module ALLUMÉ, départ à 100 % (dans SA plage)");

    return 0;
  } finally {
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'zoom', actif: false }, '*');")
      .catch(() => {});
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE PORTENT VRAIMENT LES TOKENS DE LA PARTIE ----------
 *
 * Lecture seule, sans rien poser. On veut savoir, pour chaque token : ce que le
 * champ contient, ce que Roll20 en dessine, ce que NOUS en dessinons, et — c'est
 * le point — s'il reste des étiquettes que PERSONNE ne dessine. Une étiquette à
 * nous dont l'image ne charge pas occupe quand même sa case, et le voisin paraît
 * alors décalé alors qu'il est à sa place. */
async function etatReel() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(9000);

    const r = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var st = mag('campaign');" +
      "var jeu = {};" +
      "(st && st.tokenMarkerData ? st.tokenMarkerData : []).forEach(function (m) { jeu[m.tag] = 1; });" +
      "['red','blue','green','brown','purple','pink','yellow'].forEach(function (t) { jeu[t] = 1; });" +
      "var S = window.MeshScene, C = window.Campaign, out = [];" +
      "C.activePage().thegraphics.models.forEach(function (t) {" +
      "  if (t.attributes.layer !== 'objects') { return; }" +
      "  var brut = t.attributes.statusmarkers || '';" +
      "  var n = S.getTransformNodeByName(t.id + '-markers');" +
      "  var e = (n && n.getChildren ? n.getChildren() : [])" +
      "    .filter(function (m) { return m.isEnabled && m.isEnabled(); });" +
      "  var siens = e.filter(function (m) { return !/^vttk-marqueur|group_marker/.test(m.name); });" +
      "  var notres = e.filter(function (m) { return /^vttk-marqueur/.test(m.name); });" +
      /* MUETTE = personne ne la dessine : ni Roll20, qui ne la connaît pas, ni
       * nous, qui ne savons pas la relire. Les étiquettes de l'ancien format y
       * tombent désormais comme les autres — il n'y a plus de catégorie à part
       * pour elles, puisqu'il n'y a plus de second format. */
      "  var muettes = brut.split(',').map(function (x) { return x.split('@')[0].trim(); })" +
      "    .filter(function (x) { return x && !jeu[x] && x !== 'dead' && x.indexOf('vttk_') !== 0; });" +
      "  out.push({ nom: t.attributes.name, l: t.attributes.width, brut: brut," +
      "    siens: siens.length, notres: notres.map(function (m) {" +
      "      var tex = m.material && m.material.getActiveTextures ? m.material.getActiveTextures()[0] : null;" +
      "      return { x: +m.position.x.toFixed(2), y: +m.position.y.toFixed(2)," +
      "        cote: +m.scaling.x.toFixed(2), prete: tex ? tex.isReady() : null }; })," +
      "    muettes: muettes }); });" +
      "return out;");
    r.forEach((t) => {
      console.log("\n  « " + t.nom + " » (" + t.l + ")");
      console.log("     champ    : " + (t.brut || "(vide)"));
      console.log("     lui en dessine " + t.siens + " ; nous " + t.notres.length);
      t.notres.forEach((m) => console.log("        x=" + m.x + " y=" + m.y + " côté=" + m.cote +
        (m.prete === false ? "   IMAGE NON CHARGÉE" : "")));
      if (t.muettes.length) {
        console.log("     étiquettes que PERSONNE ne dessine : " + t.muettes.join(", "));
      }
    });
    releve("etat-reel.json", r);
    return 0;
  } finally {
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA CONFIGURATION EXACTE DE LA CAPTURE ----------
 *
 * Onze marqueurs de Roll20 et UN seul à nous. Sous le code d'aujourd'hui, notre
 * case devrait tomber en colonne 0 de la seconde ligne — sous son marqueur le
 * plus à droite. La capture montre autre chose.
 *
 * On ne suppose pas : on relève TOUS les enfants du nœud, ceux qui se voient
 * comme ceux qui ne se voient pas. Un quad à nous dont l'image ne charge pas
 * reste un quad, et il occupe une case — c'est exactement le genre de chose
 * qu'un relevé « des marqueurs visibles » raterait. */
async function casCapture() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    const ROUGE = "vttk_rouge_cdn.discordapp.com/embed/avatars/4.png";
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true," +
      "  catalogue: [{ tag: arguments[0], nom: 'Rouge'," +
      "    url: 'https://cdn.discordapp.com/embed/avatars/4.png' }] }, '*');", ROUGE);
    await dors(2000);

    const dep = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var st = mag('campaign');" +
      "var cat = (st && st.tokenMarkerData ? st.tokenMarkerData : []).map(function (m) { return m.tag; });" +
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "var r = { id: t.id, nom: t.attributes.name, l: t.attributes.width, avant: t.attributes.statusmarkers };" +
      "r.pose = cat.slice(0, 11).concat([arguments[0]]).join(',');" +
      "t.save({ statusmarkers: r.pose }); return r;", ROUGE);
    repose = dep;
    console.log("\n  token « " + dep.nom + " » (" + dep.l + ") ; posé : 11 des siens + 1 à nous");
    await dors(4500);

    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var e = n && n.getChildren ? n.getChildren() : [];" +
      "return { total: e.length, enfants: e.map(function (m) {" +
      "  var b = null;" +
      "  try { b = m.getBoundingInfo().boundingBox; } catch (err) {}" +
      "  var t = m.material && m.material.getActiveTextures ? m.material.getActiveTextures()[0] : null;" +
      "  return { nom: String(m.name).replace(/^instance-0-objects - 0_/, '')," +
      "    x: +m.position.x.toFixed(2), y: +m.position.y.toFixed(2)," +
      "    ech: m.scaling ? +m.scaling.x.toFixed(3) : null," +
      "    cote: b ? +(b.maximumWorld.x - b.minimumWorld.x).toFixed(2) : null," +
      "    actif: m.isEnabled ? m.isEnabled() : null, visible: m.isVisible," +
      "    imagePrete: t ? t.isReady() : null }; })" +
      "  .sort(function (a, b2) { return (b2.y - a.y) || (b2.x - a.x); }) };", dep.id);
    console.log("  " + vu.total + " enfants du nœud :");
    vu.enfants.forEach((m) => console.log(
      "    " + (m.actif ? " " : "×") + " x=" + String(m.x).padStart(8) +
      " y=" + String(m.y).padStart(8) +
      " éch=" + String(m.ech).padStart(6) +
      " côté=" + String(m.cote).padStart(6) +
      (m.imagePrete === null ? "        " : m.imagePrete ? "  image ok" : "  IMAGE KO") +
      "  " + m.nom.slice(0, 40)));

    /* LE DIAGNOSTIC QUE LE PONT RETIENT. Un « catch » muet a déjà coûté une
     * session entière : la pose échouait, rien ne le disait, et on cherchait un
     * défaut de géométrie là où il y avait une exception. */
    const diag = await driver.executeScript(
      "return { erreur: window.__vttinkerMarqueursErreur || null," +
      "  journal: (window.__vttinkerJournal || [])" +
      "    .filter(function (l) { return /marqueur|palette/i.test(l); }).slice(-4) };");
    if (diag.erreur) { console.log("\n  ERREUR RETENUE PAR LE PONT :\n    " + diag.erreur); }
    console.log("\n  journal :");
    diag.journal.forEach((l) => console.log("    · " + l));

    const notres = vu.enfants.filter((m) => /^vttk-marqueur/.test(m.nom) && m.actif);
    const siens = vu.enfants.filter((m) => !/^vttk-marqueur|group_marker/.test(m.nom) && m.actif);
    console.log("\n  siens dessinés : " + siens.length + " ; nôtres : " + notres.length);
    if (siens.length && notres.length) {
      const droite = siens.reduce((a, b) => b.x > a.x ? b : a);
      const pas = 22 * (droite.ech || 1);
      const dx = (droite.x - notres[0].x) / pas;
      console.log("  sa case la plus à droite : x=" + droite.x + " ; la nôtre : x=" + notres[0].x);
      console.log("  écart = " + dx.toFixed(2) + " case" +
                  (Math.abs(dx) < 0.02 ? "   ← ALIGNÉ" : "   ← DÉCALÉ de " + dx.toFixed(2)));
    }
    await capture(driver, "cas-capture.png");
    releve("cas-capture.json", vu);
    return 0;
  } finally {
    if (repose) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }",
        repose.id, repose.avant).catch(() => {});
      await dors(900);
    }
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- REMETTRE LES TOKENS EN ÉTAT ----------
 *
 * Les sondes posent des marqueurs et les retirent. Mais elles s'enchaînent, et
 * l'une d'elles a mémorisé comme « état d'avant » un état DÉJÀ pollué par la
 * précédente : les marqueurs d'essai se sont accumulés sur un token de la vraie
 * partie de l'auteur.
 *
 * Cette commande les retire, et ELLE SEULE décide de ce qui part : tout ce que
 * les sondes emploient, et rien d'autre. Ce qui n'est pas dans cette liste —
 * les marqueurs que l'auteur a posés lui-même — reste. */
async function nettoieTokens() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    /* Les étiquettes que les sondes posent : les premières du catalogue, les
     * pastilles employées dans les essais, et tout ce qui commence par nos
     * préfixes d'essai. */
    const r = await driver.executeScript(
      "var C = window.Campaign;" +
      "var cat = [];" +
      "try { var st = null, n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('campaign')) { st = p._s.get('campaign'); } }" +
      "  cat = (st && st.tokenMarkerData ? st.tokenMarkerData : []).map(function (m) { return m.tag; }).slice(0, 16);" +
      "} catch (e) {}" +
      "var pastilles = ['red', 'blue', 'green', 'brown', 'purple', 'pink', 'yellow', 'dead'];" +
      "var aOter = {};" +
      "cat.concat(pastilles).forEach(function (t) { aOter[t] = 1; });" +
      "var out = [];" +
      "C.activePage().thegraphics.models.forEach(function (t) {" +
      "  var av = t.attributes.statusmarkers || '';" +
      "  if (!av) { return; }" +
      "  var garde = av.split(',').filter(function (e) {" +
      "    var nu = e.split('@')[0].trim();" +
      "    if (!nu) { return false; }" +
      "    if (/^vttk_(essai|autrui|p[0-9])/.test(nu)) { return false; }" +
      "    if (/^vttk-essai/.test(nu)) { return false; }" +
      "    return !aOter[nu]; });" +
      "  var neuf = garde.join(',');" +
      "  if (neuf !== av) { t.save({ statusmarkers: neuf });" +
      "    out.push({ nom: t.attributes.name, avant: av, apres: neuf }); } });" +
      "return out;");
    console.log("\n  tokens remis en état :");
    r.forEach((t) => {
      console.log("    « " + t.nom + " »");
      console.log("        avant : " + t.avant);
      console.log("        après : " + (t.apres || "(aucun)"));
    });
    if (!r.length) { console.log("    aucun à nettoyer"); }
    await dors(1200);
    return 0;
  } finally {
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA RANGÉE COMPLÈTE, SIENS ET NÔTRES MÊLÉS ----------
 *
 * Ce qu'on éprouve : nos marqueurs ont la MÊME TAILLE que les siens, et quand la
 * ligne est pleine ils passent à celle du dessous — sans rapetisser.
 *
 * On relève les x ET les y de tout ce qui pend sous le nœud, et on regarde. */
async function rangeeComplete() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    const MIENS = [0, 1, 2, 3, 4].map((i) =>
      "vttk_essai" + i + "_cdn.discordapp.com/embed/avatars/" + i + ".png");
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true," +
      "  catalogue: arguments[0].map(function (t, i) {" +
      "    return { tag: t, nom: 'E' + i," +
      "      url: 'https://cdn.discordapp.com/embed/avatars/' + i + '.png' }; }) }, '*');", MIENS);
    await dors(2000);

    const cat = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var st = mag('campaign');" +
      "return (st && st.tokenMarkerData ? st.tokenMarkerData : []).map(function (m) { return m.tag; });");

    const tokens = await driver.executeScript(
      "return window.Campaign.activePage().thegraphics.models" +
      "  .filter(function (m) { return m.attributes.layer === 'objects'; })" +
      "  .map(function (t) { return { id: t.id, nom: t.attributes.name," +
      "    l: t.attributes.width, avant: t.attributes.statusmarkers }; });");
    repose = tokens;
    const gros = tokens.filter((t) => t.l >= 140)[0];
    const petit = tokens.filter((t) => t.l <= 70)[0];

    /* ONZE EST LE CAS QUI A CASSÉ, et il n'était pas éprouvé : à onze marqueurs
     * Roll20 rapetisse à 0,58 et sa rangée fait 140,4 pour un token de 140 —
     * elle DÉBORDE. Une capacité calculée par floor(140/pas) en comptait dix, et
     * notre douzième case partait en colonne 1 avec un trou à sa droite. */
    for (const [t, nSiens] of [[gros, 0], [gros, 3], [gros, 9], [gros, 11], [gros, 13], [petit, 2]]) {
      if (!t) { continue; }
      await driver.executeScript(
        "var g = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "g.save({ statusmarkers: arguments[1] });",
        t.id, cat.slice(0, nSiens).concat(MIENS).join(","));
      await dors(3200);
      const vu = await driver.executeScript(
        "var S = window.MeshScene;" +
        "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
        "var e = (n && n.getChildren ? n.getChildren() : [])" +
        "  .filter(function (k) { return k.isEnabled && k.isEnabled(); });" +
        "return e.map(function (m) {" +
        "  return { nous: /^vttk-marqueur/.test(m.name)," +
        "    x: +m.position.x.toFixed(2), y: +m.position.y.toFixed(2)," +
        "    cote: +(m.getBoundingInfo().boundingBox.maximumWorld.x -" +
        "            m.getBoundingInfo().boundingBox.minimumWorld.x).toFixed(2) }; })" +
        "  .sort(function (a, b) { return (b.y - a.y) || (b.x - a.x); });", t.id);
      const siens = vu.filter((m) => !m.nous), notres = vu.filter((m) => m.nous);
      /* L'ALIGNEMENT, ET PAS SEULEMENT LA TAILLE. Deux marqueurs de même taille
       * mal placés restent mal placés.
       *
       * LA GRILLE EST À DEUX DIMENSIONS, et le premier jet ne regardait que les
       * x : il exigeait que chacun des nôtres partage un y avec l'un des siens,
       * ce qui est FAUX par construction dès qu'on passe à la ligne — il criait
       * « LIGNES DÉCALÉES » sur un placement parfaitement juste. On vérifie donc
       * que chaque marqueur à nous tombe sur un nœud de SA grille : x et y à un
       * multiple entier de son pas de sa case de référence. */
      if (siens.length && notres.length) {
        const ref = siens.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.x > a.x)) ? b : a);
        const pasLu = 22 * (ref.cote / 19);
        const surGrille = (m, axe) => {
          const d = (ref[axe] - m[axe]) / pasLu;
          return Math.abs(d - Math.round(d)) < 0.02 && d >= -0.02;
        };
        const bons = notres.filter((m) => surGrille(m, "x") && surGrille(m, "y"));
        const memeCote = notres.every((m) => Math.abs(m.cote - ref.cote) < 0.05);
        console.log("     alignement : " + bons.length + "/" + notres.length +
                    " sur sa grille (pas " + pasLu.toFixed(2) +
                    ", sa case de référence " + ref.x.toFixed(2) + " ; " + ref.y.toFixed(2) + ")" +
                    (memeCote ? ", même côté" : ", CÔTÉS DIFFÉRENTS"));
        if (bons.length !== notres.length) {
          notres.filter((m) => !(surGrille(m, "x") && surGrille(m, "y")))
            .forEach((m) => console.log("        hors grille : x=" + m.x + " y=" + m.y +
                                        " côté=" + m.cote));
        }
      }
      /* AU DIXIÈME, PAS AU CENTIÈME. Le premier jet comparait les côtés bruts et
       * criait « tailles différentes » sur 13,3 contre 13,29 — un arrondi de
       * boîte englobante, pas un écart. Un instrument qui crie au loup est pire
       * qu'un instrument muet. */
      const cotes = [...new Set(vu.map((m) => Math.round(m.cote * 10) / 10))];
      const rangs = [...new Set(vu.map((m) => m.y))].sort((a, b) => b - a);
      const bord = Math.min.apply(null, vu.map((m) => m.x - m.cote / 2));
      console.log("\n  token " + t.l + " ; " + nSiens + " des siens + " + MIENS.length + " à nous");
      /* LE DÉTAIL, ET PAS UN RÉSUMÉ. Un relevé condensé s'est contredit —
       * « côtés [19] » et « pas 15,40 » dans le même bloc — et il a fallu tout
       * refaire pour comprendre lequel des deux mentait. On imprime donc les
       * deux familles, telles quelles. */
      console.log("     SIENS  : " + (siens.length
        ? siens.map((m) => "(" + m.x + ";" + m.y + ")×" + m.cote).join(" ")
        : "aucun"));
      console.log("     NÔTRES : " + notres.map((m) => "(" + m.x + ";" + m.y + ")×" + m.cote).join(" "));
      console.log("     côtés distincts : " + JSON.stringify(cotes) +
                  (cotes.length === 1 ? "   ← même taille" : "   ← TAILLES DIFFÉRENTES"));
      console.log("     lignes (y) : " + JSON.stringify(rangs));
      /* À QUI EST LE DÉBORDEMENT ? Roll20 déborde LUI-MÊME quand il rapetisse —
       * onze marqueurs sur un token de 140 lui font une rangée de 140,36. Un
       * relevé qui dirait « DÉBORDE » sans dire de qui nous ferait chercher un
       * défaut chez nous alors qu'il est chez lui. */
      const bordSien = siens.length
        ? Math.min.apply(null, siens.map((m) => m.x - m.cote / 2)) : 0;
      const bordNotre = Math.min.apply(null, notres.map((m) => m.x - m.cote / 2));
      console.log("     bord gauche : " + bord.toFixed(2) +
                  (bord >= -t.l ? "   ← dans le token"
                    : (bordNotre < -t.l ? "   ← NOUS débordons"
                                        : "   ← lui déborde (" + bordSien.toFixed(2) + "), pas nous")));
      /* ON REGARDE. Les nombres disent que les tailles sont égales et que rien
       * ne dépasse ; ils ne disent pas si la rangée a l'air d'être la sienne. */
      if (nSiens === 11 && t.l >= 140) {
        await captureZoom(driver, "rangee-complete.png",
          [t.l === undefined ? 0 : 0, 0, 9999000], 1, 1).catch(() => {});
        const g = await driver.executeScript(
          "var C = window.Campaign, t = C.activePage().thegraphics.get(arguments[0]);" +
          "return { g: t.attributes.left, h: t.attributes.top, l: t.attributes.width," +
          "  ht: t.attributes.height };", t.id);
        await captureZoom(driver, "rangee-complete.png",
          [g.g, -(g.h - g.ht / 2) - 30, 9999000], 90, 4);
      }
    }
    return 0;
  } finally {
    for (const t of (repose || [])) {
      await driver.executeScript(
        "var g = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (g) { g.save({ statusmarkers: arguments[1] || '' }); }",
        t.id, t.avant).catch(() => {});
    }
    await dors(900);
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA LOI DE RÉDUCTION : COMMENT LA RANGÉE TIENT DANS LE TOKEN ----------
 *
 * Au-delà d'un certain nombre, Roll20 RÉTRÉCIT ses marqueurs pour que la rangée
 * ne dépasse pas du token. Les nôtres gardent leurs dix-neuf unités et sortent
 * du cadre — signalé, et visible.
 *
 * On ne devine pas la loi : on la mesure. Un marqueur à la fois, de un à
 * quatorze, sur un GROS token (140) et sur un PETIT (70) — c'est la largeur du
 * token qui doit commander, et deux tailles le diront mieux qu'une. On relève à
 * chaque fois la taille et le pas RÉELS de ses quads. */
async function loiReduction() {
  const driver = await ouvre(config().visible === true);
  let repose = [];
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    /* Notre module éteint : on veut la loi de Roll20, pas la nôtre. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');");
    await dors(1200);

    const tokens = await driver.executeScript(
      "var C = window.Campaign;" +
      "var out = [];" +
      "C.activePage().thegraphics.models.forEach(function (t) {" +
      "  if (t.attributes.layer !== 'objects') { return; }" +
      "  out.push({ id: t.id, nom: t.attributes.name, l: t.attributes.width," +
      "    h: t.attributes.height, avant: t.attributes.statusmarkers }); });" +
      "return out;");
    repose = tokens;
    const cat = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "var st = mag('campaign');" +
      "return (st && st.tokenMarkerData ? st.tokenMarkerData : [])" +
      "  .map(function (m) { return m.tag; }).slice(0, 16);");

    /* UN GROS ET UN PETIT, et pas deux au hasard : c'est la largeur du token qui
     * est censée commander, et deux tokens de même taille ne le montreraient
     * pas. Le premier jet en avait pris deux de 140 — même colonne, mêmes
     * chiffres, aucune information. */
    const gros = tokens.filter((x) => x.l >= 140)[0];
    const petit = tokens.filter((x) => x.l <= 70)[0];
    for (const t of [gros, petit].filter(Boolean)) {
      console.log("\n  token « " + t.nom + " » : " + t.l + " × " + t.h);
      console.log("     n   échelle    côté      pas   largeur   bord gauche");
      for (let n = 1; n <= 14; n++) {
        await driver.executeScript(
          "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
          "t.save({ statusmarkers: arguments[1] });", t.id, cat.slice(0, n).join(","));
        await dors(1400);
        const m = await driver.executeScript(
          "var S = window.MeshScene;" +
          "var noeud = S.getTransformNodeByName(arguments[0] + '-markers');" +
          "var e = (noeud && noeud.getChildren ? noeud.getChildren() : [])" +
          "  .filter(function (k) { return k.isEnabled && k.isEnabled(); });" +
          "if (!e.length) { return null; }" +
          "var xs = e.map(function (k) { return k.position.x; }).sort(function (a, b) { return a - b; });" +
          "var b = e[0].getBoundingInfo().boundingBox;" +
          "return { n: e.length," +
          "  cote: +(b.maximumWorld.x - b.minimumWorld.x).toFixed(2)," +
          "  echelle: +e[0].scaling.x.toFixed(3)," +
          "  xs: xs.map(function (v) { return +v.toFixed(2); }) };", t.id);
        if (!m) { console.log("    " + String(n).padStart(2) + "   (rien dessiné)"); continue; }
        const pas = m.xs.length > 1 ? +(m.xs[1] - m.xs[0]).toFixed(2) : null;
        const large = m.xs.length > 1 ? +(m.xs[m.xs.length - 1] - m.xs[0] + m.cote).toFixed(2) : m.cote;
        console.log("    " + String(n).padStart(2) + "  " + String(m.echelle).padStart(8) +
                    "  " + String(m.cote).padStart(6) +
                    "  " + String(pas === null ? "—" : pas).padStart(6) +
                    "  " + String(large).padStart(8) +
                    "  " + String(m.xs[0]).padStart(10) +
                    (m.n !== n ? "   (dessinés : " + m.n + ")" : ""));
      }
    }
    /* ---- LA QUESTION QUI DÉCIDE DE TOUT ----
     *
     * Roll20 calcule-t-il son échelle sur le nombre de marqueurs QU'IL DESSINE,
     * ou sur le nombre d'ÉTIQUETTES du champ ? Dans le second cas, ajouter les
     * nôtres le fait rétrécir tout seul, et il n'y a qu'à lire son échelle et
     * s'y aligner. Dans le premier, la rangée complète déborde et c'est à nous
     * de trancher.
     *
     * On compare : cinq des siens seuls, puis les mêmes cinq PLUS cinq à nous.
     * Si son échelle bouge, il compte les étiquettes. */
    const cible = gros || tokens[0];
    const MIENS = [1, 2, 3, 4, 5].map(function (i) {
      return "vttk_essai" + i + "_cdn.discordapp.com/embed/avatars/" + (i % 5) + ".png";
    });
    const LIS_ECHELLE =
      "var S = window.MeshScene;" +
      "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var e = (n && n.getChildren ? n.getChildren() : [])" +
      "  .filter(function (k) { return k.isEnabled && k.isEnabled() && !/^vttk-marqueur/.test(k.name); });" +
      "return e.length ? { n: e.length, echelle: +e[0].scaling.x.toFixed(3) } : null;";

    await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ statusmarkers: arguments[1] });", cible.id, cat.slice(0, 5).join(","));
    await dors(2500);
    const seul = await driver.executeScript(LIS_ECHELLE, cible.id);
    await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ statusmarkers: arguments[1] });",
      cible.id, cat.slice(0, 5).concat(MIENS).join(","));
    await dors(2500);
    const melange = await driver.executeScript(LIS_ECHELLE, cible.id);
    console.log("\n  cinq des siens SEULS        : " + JSON.stringify(seul));
    console.log("  les mêmes + cinq à nous     : " + JSON.stringify(melange));
    console.log("  → il compte " +
      (seul && melange && seul.echelle !== melange.echelle
        ? "LES ÉTIQUETTES : son échelle a bougé, il suffit de la lire"
        : "SEULEMENT CE QU'IL DESSINE : la rangée complète est à nous de gérer"));

    return 0;
  } finally {
    for (const t of repose) {
      await driver.executeScript(
        "var g = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (g) { g.save({ statusmarkers: arguments[1] || '' }); }",
        t.id, t.avant).catch(() => {});
    }
    await dors(900);
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUI OCCUPE UNE CASE DE LA RANGÉE, ET QUI N'EN OCCUPE PAS ----------
 *
 * Nos marqueurs se rangent à la suite des siens : on compte les siens, et on se
 * décale d'autant. Un décompte faux les fait CHEVAUCHER — et c'est ce qui a été
 * signalé.
 *
 * Deux suspects, et aucun ne se tranche sans mesure :
 *   · LES PASTILLES DE COULEUR ne sont dans aucun catalogue. Si elles occupent
 *     une case et qu'on ne les compte pas, nos marqueurs se posent DESSUS.
 *   · « dead » barre le token d'une croix, sur toute sa surface. S'il n'occupe
 *     PAS de case et qu'on le compte, on laisse un trou.
 *
 * On pose un mélange des deux, plus un des nôtres, et on relève les positions
 * RÉELLES de tout ce qui pend sous le nœud des marqueurs. */
async function rangeeOccupation() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    const MIEN = "vttk_essai_cdn.discordapp.com/embed/avatars/0.png";
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true," +
      "  catalogue: [{ tag: arguments[0], nom: 'Essai'," +
      "    url: 'https://cdn.discordapp.com/embed/avatars/0.png' }] }, '*');", MIEN);
    await dors(2000);

    const cas = [
      { nom: "deux pictogrammes + le nôtre", tags: ["skull", "sleepy"] },
      { nom: "deux PASTILLES + le nôtre", tags: ["red", "blue"] },
      { nom: "« dead » + le nôtre", tags: ["dead"] },
      { nom: "un peu de tout + le nôtre", tags: ["red", "skull", "dead", "sheet-blinded"] }
    ];

    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "return { id: t.id, avant: t.attributes.statusmarkers };");
    repose = dep;

    for (const c of cas) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "t.save({ statusmarkers: arguments[1] });", dep.id, c.tags.concat([MIEN]).join(","));
      await dors(3200);
      const vu = await driver.executeScript(
        "var S = window.MeshScene;" +
        "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
        "var e = n && n.getChildren ? n.getChildren() : [];" +
        "return e.map(function (m) {" +
        "  return { nom: String(m.name).replace(/^instance-0-objects - 0_/, '').slice(0, 40)," +
        "    x: +m.position.x.toFixed(1), y: +m.position.y.toFixed(1)," +
        "    actif: m.isEnabled ? m.isEnabled() : null }; })" +
        "  .sort(function (a, b) { return a.x - b.x; });", dep.id);
      console.log("\n  " + c.nom + "  [" + c.tags.join(",") + "]");
      vu.forEach((m) => console.log("      x=" + String(m.x).padStart(7) +
        "  " + (m.actif ? " " : "×") + " " + m.nom));
      /* Deux quads à la même abscisse, c'est un chevauchement. */
      const vus = {};
      const chevauche = vu.filter((m) => {
        if (m.x === 0 || !m.actif) { return false; }
        if (vus[m.x]) { return true; }
        vus[m.x] = 1; return false;
      });
      console.log("      → " + (chevauche.length
        ? "CHEVAUCHEMENT en x=" + chevauche.map((m) => m.x).join(", ")
        : "aucun chevauchement"));
    }
    return 0;
  } finally {
    if (repose) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }",
        repose.id, repose.avant).catch(() => {});
      await dors(900);
    }
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- D'OÙ SA PROPRE FENÊTRE TIRE SA LISTE ----------
 *
 * La palette montre 47 pictogrammes + 7 pastilles, lus dans
 * `Campaign.attributes.token_markers` et dans les maillages. Or sa fenêtre à lui
 * en montre davantage : une CROIX ROUGE, et des icônes qui viendraient de la
 * fiche de personnage 5.5.
 *
 * On ne discute pas : on cherche la SOURCE. Sa fenêtre est en HTML — champ de
 * recherche, bouton « Tout effacer », barre de défilement —, donc les données
 * qui la remplissent sont quelque part dans la page. On balaie ses magasins
 * Pinia à la recherche de tableaux qui ressemblent à des marqueurs, et on
 * compare à ce qu'on connaît. */
async function sourceMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(8000);

    const r = await driver.executeScript(
      "function tous() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s) { return p._s; } } return null; }" +
      "var out = { magasins: [], connus: [] };" +
      "try { out.connus = JSON.parse(window.Campaign.attributes.token_markers).map(function (m) { return m.tag; }); }" +
      "catch (e) {}" +
      /* Un tableau de marqueurs se reconnaît à ses entrées : un nom ou une
       * étiquette, et une image. On ne cherche pas un nom de magasin, on
       * cherche une FORME. */
      "function ressemble(v) {" +
      "  if (!v || !v.length || v.length < 3) { return false; }" +
      "  var e = v[0];" +
      "  return !!(e && typeof e === 'object' && (e.tag || e.name || e.id) &&" +
      "            (e.url || e.image || e.src || e.icon));" +
      "}" +
      "var s = tous();" +
      "if (s) { s.forEach(function (st, nom) {" +
      "  var etat = {};" +
      "  try { etat = st.$state || {}; } catch (e) { return; }" +
      "  Object.keys(etat).forEach(function (k) {" +
      "    var v = null;" +
      "    try { v = st[k]; } catch (e) { return; }" +
      "    if (!ressemble(v)) { return; }" +
      "    out.magasins.push({ magasin: nom, cle: k, n: v.length," +
      "      champs: Object.keys(v[0]).slice(0, 8)," +
      "      trois: v.slice(0, 3).map(function (e) {" +
      "        return { tag: e.tag || e.name || e.id," +
      "          url: String(e.url || e.image || e.src || e.icon || '').slice(-40) }; }) }); }); }); }" +
      /* Et sa fenêtre, si elle est ouverte quelque part dans le DOM. */
      "out.fenetre = [].slice.call(document.querySelectorAll('[class*=marker i],[class*=status i],[class*=condition i]'))" +
      "  .filter(function (n) { return n.getBoundingClientRect().width > 40; })" +
      "  .slice(0, 8).map(function (n) { return String(n.className).slice(0, 60); });" +
      "return out;");
    console.log("\n  catalogue connu de nous : " + r.connus.length + " étiquettes");
    console.log("\n  tableaux qui ressemblent à des marqueurs :");
    r.magasins.forEach((m) => {
      console.log("    " + m.magasin + "." + m.cle + " → " + m.n + " entrées, champs " +
                  JSON.stringify(m.champs));
      m.trois.forEach((t) => console.log("        " + JSON.stringify(t)));
    });
    console.log("\n  éléments visibles qui parlent de marqueurs : " + JSON.stringify(r.fenetre));

    /* LA CROIX ROUGE. Dans Roll20 c'est le marqueur « dead » : il barre le token
     * d'une croix, et il n'est dans aucun catalogue. */
    const mort = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "var r = { id: t.id, avant: t.attributes.statusmarkers };" +
      "t.save({ statusmarkers: 'dead' }); return r;");
    await dors(3000);
    const vuMort = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var enfants = n && n.getChildren ? n.getChildren() : [];" +
      "var res = { enfants: enfants.map(function (m) { return String(m.name).slice(-26); }) };" +
      /* La croix peut être dessinée ailleurs que sous le nœud des marqueurs. */
      "res.ailleurs = (S.meshes || []).filter(function (m) { return /dead|cross|croix/i.test(m.name); })" +
      "  .map(function (m) { return m.name.slice(-30); });" +
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ statusmarkers: arguments[1] || '' });" +
      "return res;", mort.id, mort.avant);
    console.log("\n  « dead » posé : enfants " + JSON.stringify(vuMort.enfants) +
                " ; ailleurs " + JSON.stringify(vuMort.ailleurs));

    releve("source-marqueurs.json", { r, vuMort });
    return 0;
  } finally {
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUI MANQUE À LA PALETTE, ET L'ADRESSE DANS L'ÉTIQUETTE ----------
 *
 * DEUX QUESTIONS, et aucune ne se tranche sans mesure.
 *
 * 1. QUELS MARQUEURS MANQUENT ? La palette lit
 *    `Campaign.attributes.token_markers` et en tire 47. Mais Roll20 dessine
 *    aussi des PASTILLES DE COULEUR — on a vu passer des maillages
 *    « red-marker-template », « blue-marker-template »… — qui ne sont pas dans
 *    cette liste. Et une campagne peut avoir ses propres marqueurs téléversés.
 *    On énumère tout ce qui existe, et on compare à ce qu'on montre.
 *
 * 2. L'ADRESSE PEUT-ELLE TENIR DANS L'ÉTIQUETTE ? Y mettre l'URL supprimerait le
 *    besoin d'un catalogue partagé : l'étiquette se suffirait à elle-même. Reste
 *    à savoir si Roll20 accepte un champ aussi long, s'il le rend intact, et
 *    s'il ne s'étrangle pas sur les caractères d'une URL. On écrit, on relit, on
 *    compare — et on remet ce qu'on a trouvé. */
async function manqueEtEtiquette() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(8000);

    /* ---- 1. L'inventaire complet ---- */
    const inv = await driver.executeScript(
      "var C = window.Campaign, S = window.MeshScene, out = {};" +
      "var l = []; try { l = JSON.parse(C.attributes.token_markers); } catch (e) {}" +
      "out.nCatalogue = l.length;" +
      "out.tags = l.map(function (m) { return m.tag; });" +
      /* Une entrée téléversée par la campagne se distingue-t-elle des siennes ?
       * On regarde les champs et l'origine des adresses. */
      "out.formes = l.slice(0, 3).map(function (m) { return Object.keys(m); });" +
      "out.hotes = {};" +
      "l.forEach(function (m) {" +
      "  var h = '(sans url)';" +
      "  try { h = new URL(m.url).host; } catch (e) {}" +
      "  out.hotes[h] = (out.hotes[h] || 0) + 1; });" +
      /* Les pastilles : elles sont des MAILLAGES, pas des entrées de catalogue. */
      "out.pastilles = (S.meshes || []).filter(function (m) { return /-marker-template$/.test(m.name); })" +
      "  .map(function (m) { return m.name.replace('-marker-template', ''); });" +
      /* Et tout autre champ de la campagne qui sentirait le marqueur. */
      "out.champsCampagne = Object.keys(C.attributes || {}).filter(function (k) {" +
      "  return /marker|token|status|condition/i.test(k); });" +
      "return out;");
    console.log("\n  1. L'INVENTAIRE");
    console.log("     catalogue : " + inv.nCatalogue + " entrées");
    console.log("     hôtes des images : " + JSON.stringify(inv.hotes));
    console.log("     forme d'une entrée : " + JSON.stringify(inv.formes[0]));
    console.log("     PASTILLES DE COULEUR (maillages, hors catalogue) : " +
                JSON.stringify(inv.pastilles));
    console.log("     autres champs de la campagne : " + JSON.stringify(inv.champsCampagne));
    console.log("     étiquettes : " + inv.tags.join(", "));

    /* ---- 2. L'adresse dans l'étiquette ---- */
    const LONGUE = "vttk_poison_cdn.discordapp.com/emojis/1234567890123456789.webp?size=96";
    const essai = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, avant: t.attributes.statusmarkers };" +
      "t.save({ statusmarkers: arguments[0] });" +
      "r.relu = t.attributes.statusmarkers;" +
      "r.egal = r.relu === arguments[0];" +
      "r.longueur = arguments[0].length;" +
      "return r;", LONGUE);
    if (!essai) { console.log("  aucun token."); return 1; }
    repose = essai;
    console.log("\n  2. L'ADRESSE DANS L'ÉTIQUETTE");
    console.log("     écrit (" + essai.longueur + " caractères) : " + LONGUE);
    console.log("     relu aussitôt, identique : " + essai.egal);

    /* Roll20 le renvoie-t-il intact APRÈS son aller-retour ? C'est là que ça se
     * joue : ce qu'on relit dans la seconde vient de notre propre écriture, pas
     * de son serveur. */
    await dors(4000);
    const apres = await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "return { valeur: t.attributes.statusmarkers, egal: t.attributes.statusmarkers === arguments[1] };",
      essai.id, LONGUE);
    console.log("     quatre secondes plus tard : " + JSON.stringify(apres));

    /* Et une étiquette VRAIMENT longue : plusieurs marqueurs d'un coup. */
    const TROIS = [LONGUE, "vttk_feu_exemple.org/tres/long/chemin/vers/une/image/de/feu.png",
                   "vttk_glace_exemple.org/autre/chemin/glace.png"].join(",");
    const gros = await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ statusmarkers: arguments[1] });" +
      "return { longueur: arguments[1].length, relu: t.attributes.statusmarkers.length," +
      "  egal: t.attributes.statusmarkers === arguments[1] };", essai.id, TROIS);
    console.log("     trois marqueurs d'un coup (" + gros.longueur + " car.) : " + JSON.stringify(gros));

    /* ---- 3. LES PASTILLES S'APPLIQUENT-ELLES COMME ÉTIQUETTES ? ----
     *
     * Elles existent comme MAILLAGES (« red-marker-template »…) mais pas dans le
     * catalogue. Rien ne dit que leur nom soit une étiquette valide — un premier
     * essai avec `set()` n'avait rien donné, mais `set()` ne redessine pas, ce
     * qui ne prouvait rien. Cette fois on passe par `save()`, le vrai chemin. */
    const past = await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ statusmarkers: 'red,blue,green' });" +
      "return t.attributes.statusmarkers;", essai.id);
    await dors(3500);
    const vuPast = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var enfants = n && n.getChildren ? n.getChildren() : [];" +
      "return { marqueurs: arguments[1]," +
      "  enfants: enfants.map(function (m) { return String(m.name).slice(-30); })," +
      "  instances: (S.meshes || []).filter(function (m) { return /-marker-template$/.test(m.name); })" +
      "    .map(function (m) { return { nom: m.name, fines: m.thinInstanceCount || 0," +
      "      instances: (m.instances || []).length, visible: m.isVisible }; }) };",
      essai.id, past);
    console.log("\n  3. LES PASTILLES DE COULEUR");
    console.log("     posé : " + JSON.stringify(vuPast.marqueurs));
    console.log("     enfants du nœud : " + JSON.stringify(vuPast.enfants));
    console.log("     modèles de pastilles : " + JSON.stringify(vuPast.instances));
    const dessinees = vuPast.enfants.filter((n) => /red|blue|green/.test(n)).length;
    console.log("     → Roll20 les dessine : " + (dessinees ? "OUI (" + dessinees + ")" : "NON"));

    /* LEURS COULEURS EXACTES. Elles n'ont pas d'image — ce sont des disques
     * vectoriels —, donc la palette doit les dessiner. On lit la teinte sur SES
     * modèles plutôt que d'en choisir sept au jugé. */
    const teintes = await driver.executeScript(
      "var S = window.MeshScene;" +
      "return (S.meshes || []).filter(function (m) { return /-marker-template$/.test(m.name); })" +
      "  .map(function (m) {" +
      "    var mt = m.material, o = { nom: m.name.replace('-marker-template', '') };" +
      "    if (!mt) { return o; }" +
      "    o.classe = mt.getClassName && mt.getClassName();" +
      "    ['diffuseColor', 'emissiveColor', 'albedoColor', 'color'].forEach(function (k) {" +
      "      var c = mt[k];" +
      "      if (c && c.r !== undefined) {" +
      "        o[k] = [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]; } });" +
      "    try { o.uniformes = Object.keys(mt._uniformBuffers || {}).slice(0, 4); } catch (e) {}" +
      "    try { var e2 = mt.getEffect && mt.getEffect();" +
      "      o.aEffet = !!e2; } catch (e) {}" +
      "    return o; });");
    console.log("\n     teintes des pastilles :");
    teintes.forEach((t) => console.log("       " + JSON.stringify(t)));

    releve("manque-etiquette.json", { inv, essai, apres, gros, vuPast, teintes });
    return 0;
  } finally {
    if (repose) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }",
        repose.id, repose.avant).catch(() => {});
      await dors(1000);
    }
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA SECTION VTTK COMPLÈTE, DANS UNE VRAIE PARTIE ----------
 *
 * Deux boutons dans sa colonne : les réglages et les marqueurs. Le premier ouvre le
 * panneau de l'extension — la MÊME page que le popup du navigateur, chargée dans
 * un cadre —, le second la palette.
 *
 * Ce qu'on éprouve, et qui ne se voit qu'en vrai : que le cadre se charge (une
 * ressource d'extension n'est joignable depuis la page que si le manifeste la
 * déclare accessible), et que les couleurs prises à sa barre soient les bonnes. */
async function sectionVTTK() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(7000);

    /* UNE PALETTE, sans quoi le bouton des marqueurs n'a pas lieu d'être : un
     * module sans contenu ne dessine rien. Le bouton des RÉGLAGES, lui, doit
     * être là de toute façon — c'est par lui qu'on remplit la palette. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: true," +
      "  catalogue: [{ tag: 'vttk_essaivttk_cdn.discordapp.com/embed/avatars/0.png', nom: 'Essai', url: 'https://cdn.discordapp.com/embed/avatars/0.png' }] }, '*');");
    await dors(2000);

    const vu = await driver.executeScript(
      "var col = document.querySelector('.upper-buttons');" +
      "function decris(sel) { var n = document.querySelector(sel); if (!n) { return null; }" +
      "  var r = n.getBoundingClientRect();" +
      "  var g = n.querySelector('.grimoire__roll20-icon');" +
      "  return { boite: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]," +
      "    glyphe: g ? g.textContent : null," +
      "    largeurGlyphe: g ? +g.getBoundingClientRect().width.toFixed(1) : null }; }" +
      "var t = document.querySelector('.vttk-outil-titre .spacer-header');" +
      "return { section: t ? t.textContent : null," +
      "  reglages: decris('.vttk-outil-reglages'), marqueurs: decris('.vttk-outil-marqueurs')," +
      /* Un glyphe de référence, pour dire si les nôtres en sont vraiment. */
      "  reference: (function () { var g = col.querySelector('.toolbar-button-outer:not(.vttk-outil) .grimoire__roll20-icon');" +
      "    return g ? { nom: g.textContent, l: +g.getBoundingClientRect().width.toFixed(1) } : null; })()," +
      "  ordre: [].slice.call(col.children).map(function (n) {" +
      "    var g = n.querySelector('.grimoire__roll20-icon');" +
      "    var h = n.querySelector('.spacer-header');" +
      "    return (h ? '« ' + h.textContent + ' »' : (g ? g.textContent : '·')); }) };");
    console.log("\n  section : " + JSON.stringify(vu.section));
    console.log("  réglages : " + JSON.stringify(vu.reglages));
    console.log("  marqueurs   : " + JSON.stringify(vu.marqueurs));
    console.log("  glyphe de référence : " + JSON.stringify(vu.reference));
    console.log("  ordre de la colonne : " + vu.ordre.join(" / "));

    /* LES GLYPHES SONT-ILS DES GLYPHES ? Un nom inconnu de sa police
     * s'afficherait en toutes lettres — donc bien plus large qu'un glyphe. */
    if (vu.reference) {
      const bon = (g) => g && Math.abs(g.largeurGlyphe - vu.reference.l) < 3;
      console.log("  « settings » est un vrai glyphe : " + (bon(vu.reglages) ? "OUI" : "NON"));
      console.log("  « starFilled » aussi : " + (bon(vu.marqueurs) ? "OUI" : "NON"));
    }

    /* Le panneau : on presse le bouton comme un utilisateur. */
    const ouvert = await driver.executeScript(
      "document.querySelector('.vttk-outil-reglages button').click();" +
      "var p = document.querySelector('.vttk-reglages');" +
      "if (!p) { return { erreur: 'pas de panneau' }; }" +
      "var r = p.getBoundingClientRect(), c = p.querySelector('iframe');" +
      "return { ouvert: p.classList.contains('ouvert')," +
      "  boite: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]," +
      "  src: c ? c.src : null," +
      "  fond: p.style.getPropertyValue('--vttk-fond')," +
      "  texte: p.style.getPropertyValue('--vttk-texte') };");
    console.log("\n  panneau : " + JSON.stringify(ouvert));

    /* LE CADRE S'EST-IL VRAIMENT CHARGÉ ?
     *
     * Pas question de le lire par `contentDocument` : le cadre est d'une autre
     * ORIGINE (moz-extension:// contre app.roll20.net), et la page n'a donc
     * aucun accès à son intérieur. C'est la bonne isolation, pas une panne —
     * mais ça veut dire qu'on ne peut pas se contenter de regarder de dehors.
     *
     * WebDriver, lui, franchit les origines. On entre dans le cadre et on
     * regarde ce qu'il porte : c'est la seule preuve que la ressource a été
     * servie, et donc que le manifeste la déclare bien accessible. */
    await dors(2500);
    let dedans = null;
    try {
      const el = await driver.findElement(By.css(".vttk-reglages iframe"));
      await driver.switchTo().frame(el);
      dedans = await driver.executeScript(
        "return { titre: document.title," +
        "  theme: document.documentElement.getAttribute('data-theme')," +
        "  encadre: document.documentElement.getAttribute('data-encadre')," +
        "  cartes: [].slice.call(document.querySelectorAll('.carte-titre')).map(function (n) { return n.textContent; })," +
        "  fond: getComputedStyle(document.body).backgroundColor," +
        "  texte: getComputedStyle(document.body).color," +
        "  largeur: Math.round(document.body.getBoundingClientRect().width) };");
      await driver.switchTo().defaultContent();
    } catch (e) {
      dedans = { erreur: String(e.message).slice(0, 120) };
      await driver.switchTo().defaultContent().catch(() => {});
    }
    console.log("  dedans  : " + JSON.stringify(dedans));

    await capture(driver, "section-vttk.png");
    /* LA COLONNE DE PRÈS. Les nombres disent que nos deux boutons font 42 × 34
     * au bon endroit ; ils ne disent pas si le sourire tient la comparaison avec
     * ses icônes — même graisse, même taille optique. On cadre depuis l'intitulé
     * « Effets » pour avoir les siennes et les nôtres côte à côte. */
    if (vu.marqueurs) {
      await capturePres(driver, "section-vttk-pres.png",
        0, vu.reglages.boite[1] - 110, 46, 200, 6);
    }
    releve("section-vttk.json", { vu, ouvert, dedans });
    return 0;
  } finally {
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- SES COULEURS, ET SA POLICE D'ICÔNES ----------
 *
 * Deux questions, et aucune ne se devine.
 *
 * 1. LES COULEURS. Nos panneaux ont jusqu'ici un décor écrit en dur — fond
 *    #171717, bord #816e54 — qui va en thème sombre et détonne en thème clair.
 *    Roll20 déclare ses couleurs en propriétés personnalisées ; si on les lit au
 *    lieu de les choisir, nos boîtes suivent son thème sans qu'on ait à le
 *    savoir. Reste à trouver LESQUELLES, et comment il signale jour/nuit.
 *
 * 2. LA POLICE D'ICÔNES. Ses boutons portent un span dont le TEXTE est le nom du
 *    glyphe (« cursor », « measure »…). Un nom inconnu s'afficherait en toutes
 *    lettres — donc on ne devine pas : on essaie une liste de noms plausibles et
 *    on MESURE lesquels rendent un glyphe. Un glyphe tient dans un carré
 *    d'environ 1,3 em ; un mot écrit en clair est bien plus large.
 *
 * Lecture seule, et le nœud d'essai est retiré. */
async function themeRoll20() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(8000);

    /* ---- 1. Les couleurs ---- */
    const couleurs = await driver.executeScript(
      "var out = { racine: {}, marqueurs: {}, calcule: {} };" +
      /* Toutes les propriétés personnalisées déclarées sur la racine. */
      "var st = getComputedStyle(document.documentElement);" +
      "for (var i = 0; i < st.length; i++) {" +
      "  var k = st[i];" +
      "  if (k.indexOf('--') !== 0) { continue; }" +
      "  var v = st.getPropertyValue(k).trim();" +
      "  if (v) { out.racine[k] = v.slice(0, 40); } }" +
      /* Comment le thème est-il signalé ? classe, attribut, media ? */
      "out.marqueurs.htmlClasse = String(document.documentElement.className).slice(0, 120);" +
      "out.marqueurs.bodyClasse = String(document.body.className).slice(0, 160);" +
      "out.marqueurs.attributs = [].slice.call(document.documentElement.attributes)" +
      "  .map(function (a) { return a.name + '=' + String(a.value).slice(0, 24); });" +
      "out.marqueurs.bodyAttributs = [].slice.call(document.body.attributes)" +
      "  .map(function (a) { return a.name + '=' + String(a.value).slice(0, 24); });" +
      "try { out.marqueurs.sombreSysteme = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}" +
      /* Et ce que ses propres boîtes rendent VRAIMENT : c'est la vérité, quelles
       * que soient les variables. */
      "function lu(sel, props) {" +
      "  var n = document.querySelector(sel); if (!n) { return null; }" +
      "  var s = getComputedStyle(n), o = {};" +
      "  props.forEach(function (p) { o[p] = s.getPropertyValue(p); });" +
      "  return o; }" +
      "out.calcule['#master-toolbar'] = lu('#master-toolbar', ['background-color', 'color', 'border-color']);" +
      "out.calcule['.toolbar-button-inner'] = lu('.toolbar-button-inner', ['background-color', 'color']);" +
      "out.calcule['.spacer-header'] = lu('.spacer-header', ['color', 'font-size', 'font-weight', 'letter-spacing', 'text-transform']);" +
      "out.calcule['.spacer-inner'] = lu('.spacer-inner', ['background-color', 'border-top-color', 'height']);" +
      "out.calcule['body'] = lu('body', ['background-color', 'color', 'font-family']);" +
      "return out;");
    const cles = Object.keys(couleurs.racine);
    console.log("\n  1. LES COULEURS");
    console.log("     " + cles.length + " propriétés personnalisées sur la racine ; celles qui parlent");
    console.log("     de barre d'outils, de fond, de texte ou de thème :");
    cles.filter((k) => /toolbar|surface|background|bg|text|border|theme|panel|menu|divider/i.test(k))
      .slice(0, 40)
      .forEach((k) => console.log("       " + k + " = " + couleurs.racine[k]));
    console.log("\n     marqueurs de thème : " + JSON.stringify(couleurs.marqueurs, null, 1).slice(0, 700));
    console.log("\n     ce que ses boîtes rendent :");
    Object.keys(couleurs.calcule).forEach((k) =>
      console.log("       " + k + " → " + JSON.stringify(couleurs.calcule[k])));

    /* ---- 2. Les glyphes ---- */
    /* Une liste large : on cherche une icône qui DISE « pictogramme d'état sur
     * un token », et la seule façon de savoir ce que sa police contient est de
     * demander. Les noms connus (menu, cursor…) servent de repères. */
    const NOMS = ["smiley", "smile", "faceSmile", "emoji", "emote", "sticker", "tag", "tags",
                  "star", "starFilled", "heart", "heartFilled", "flag", "bookmark", "badge",
                  "sparkles", "wandSparkle", "statusMarker", "marker", "pin", "label",
                  "shapes", "palette", "brush", "image", "images", "photo", "grid", "layers",
                  "token", "tokens", "user", "userCircle", "circle", "square", "plus", "gear",
                  "settings", "cog", "wrench", "tool", "toolbox", "puzzle", "magic", "wand",
                  "bolt", "flame", "fire", "skull", "shield", "eye", "bell", "crown", "gem",
                  "diamond", "sun", "moon", "droplet", "leaf", "paw", "medal", "award",
                  "comment", "message", "chat", "chatBubble", "speechBubble", "smileyFace",
                  "faceGrin", "mood", "reaction", "pinFilled", "bookmarkFilled", "tagFilled",
                  "circleFilled", "dot", "dots", "bullet", "checkCircle", "infoCircle",
                  "alertCircle", "helpCircle", "hexagon", "triangle", "pentagon", "clover",
                  "puzzlePiece", "stamp", "seal", "ribbon", "trophy", "lightning", "zap",
                  /* Une passe ciblée sur le vocabulaire de l'ÉTAT : c'est
                   * exactement ce que le module pose sur un token, et le mot
                   * juste vaut mieux qu'une métaphore approchante. */
                  "status", "statuses", "statusIcon", "condition", "conditions",
                  "effect", "effects", "aura", "overlay", "note", "noteFilled",
                  "flagFilled", "shieldFilled", "bellFilled", "starOutline",
                  "heartOutline", "stickers", "emoticon", "face", "faces", "avatar",
                  "avatars", "personCircle", "group", "groups", "chip", "pill",
                  "sticker2", "smileyFilled", "faceSmileFilled", "reactions"];
    const glyphes = await driver.executeScript(
      "var noms = arguments[0];" +
      /* ON CLONE UN VRAI SPAN D'ICÔNE, on n'en fabrique pas un.
       *
       * Le premier jet créait un span avec la seule classe
       * « grimoire__roll20-icon » : tout sortait en toutes lettres, y compris
       * « wandSparkle » qui est pourtant une icône dans sa propre barre. La
       * police vient d'une règle de portée Vue, accrochée à l'attribut
       * data-v-… que le span fabriqué n'avait pas. Un clone les porte tous. */
      "var vrai = document.querySelector('.toolbar-button-inner .grimoire__roll20-icon');" +
      "if (!vrai) { return { erreur: 'pas de span d icone a cloner' }; }" +
      "var hote = vrai.parentNode;" +
      "var essai = vrai.cloneNode(true);" +
      "essai.style.position = 'absolute';" +
      "essai.style.visibility = 'hidden';" +
      "hote.appendChild(essai);" +
      /* Le TÉMOIN POSITIF : un nom dont on SAIT qu'il est un glyphe, puisqu'il
       * est employé dans sa barre. Sans lui, on n'aurait aucune référence. */
      "essai.textContent = vrai.textContent;" +
      "var bon = essai.getBoundingClientRect();" +
      "var out = [];" +
      "noms.forEach(function (n) {" +
      "  essai.textContent = n;" +
      "  var r = essai.getBoundingClientRect();" +
      "  out.push({ nom: n, l: +r.width.toFixed(1), h: +r.height.toFixed(1) }); });" +
      /* Un témoin : une chaîne qui n'est sûrement PAS un glyphe. On compare à
       * elle plutôt qu'à un seuil choisi au hasard. */
      "essai.textContent = 'zzznexistepas';" +
      "var t = essai.getBoundingClientRect();" +
      "essai.parentNode.removeChild(essai);" +
      "return { mesures: out, temoinNegatif: { l: +t.width.toFixed(1), h: +t.height.toFixed(1) }," +
      "  temoinPositif: { nom: vrai.textContent, l: +bon.width.toFixed(1), h: +bon.height.toFixed(1) } };",
      NOMS);
    if (glyphes.erreur) { console.log("\n  2. GLYPHES : " + glyphes.erreur); }
    else {
      console.log("\n  2. LA POLICE D'ICÔNES");
      console.log("     témoin POSITIF « " + glyphes.temoinPositif.nom + " » (c'en est un) : " +
                  glyphes.temoinPositif.l + " × " + glyphes.temoinPositif.h);
      console.log("     témoin NÉGATIF « zzznexistepas » : " +
                  glyphes.temoinNegatif.l + " × " + glyphes.temoinNegatif.h);
      /* On se cale sur le témoin POSITIF, pas sur un seuil choisi : un glyphe
       * fait exactement sa largeur, un mot écrit en clair s'étale. */
      const cible = glyphes.temoinPositif.l;
      const estGlyphe = (m) => Math.abs(m.l - cible) < 2.5;
      console.log("     rendus comme un GLYPHE (largeur ≈ " + cible + ") :");
      glyphes.mesures.filter(estGlyphe)
        .forEach((m) => console.log("       " + m.nom.padEnd(16) + " " + m.l + " × " + m.h));
      console.log("     rendus en toutes lettres : " +
        glyphes.mesures.filter((m) => !estGlyphe(m)).map((m) => m.nom).join(", "));
    }
    /* ---- 3. Le bascule jour/nuit ---- */
    const bascule = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s) { return p._s; } } return null; }" +
      "var s = mag(), out = { magasins: [] };" +
      "if (s) { s.forEach(function (st, nom) {" +
      "  var cles = [];" +
      "  try { cles = Object.keys(st.$state || {}).filter(function (k) { return /theme|dark|light|mode|appearance|couleur/i.test(k); }); }" +
      "  catch (e) {}" +
      "  if (cles.length) { var v = {};" +
      "    cles.forEach(function (k) { try { v[k] = String(st[k]).slice(0, 30); } catch (e) {} });" +
      "    out.magasins.push({ nom: nom, valeurs: v }); } }); }" +
      /* Et les feuilles de style : un thème sombre est souvent une feuille à
       * part, ou une classe posée sur un conteneur. */
      "out.feuilles = [].slice.call(document.styleSheets).map(function (f) {" +
      "  return String(f.href || '(en ligne)').slice(-46); })" +
      "  .filter(function (h) { return /dark|light|theme/i.test(h); });" +
      "out.classesSuspectes = [].slice.call(document.querySelectorAll('[class*=dark i],[class*=theme i]'))" +
      "  .slice(0, 6).map(function (n) { return String(n.className).slice(0, 60); });" +
      "return out;");
    console.log("\n  3. LE BASCULE JOUR/NUIT");
    console.log("     magasins qui en parlent : " + JSON.stringify(bascule.magasins));
    console.log("     feuilles de style : " + JSON.stringify(bascule.feuilles));
    console.log("     classes suspectes : " + JSON.stringify(bascule.classesSuspectes));

    /* ---- 4. LE MÊME RELEVÉ EN MODE NUIT ----
     *
     * C'est le seul contrôle qui vaille : une variable qu'on croit « de thème »
     * mais qui ne bouge pas d'un mode à l'autre donnerait un panneau juste en
     * clair et faux en sombre. On bascule pour de bon, on relit, on remet. */
    const CANDIDATS = ["--background-color", "--background-base", "--background-light",
      "--background-dark", "--border-color", "--text-color", "--primary-text-color",
      "--secondary-text-color", "--gray-text-color", "--panel-bg", "--surface-color",
      "--divider-color", "--card-label-background-dark", "--accent-text-color"];
    const LIS_THEME =
      "var st = getComputedStyle(document.documentElement), o = { vars: {}, boites: {} };" +
      "arguments[0].forEach(function (k) { var v = st.getPropertyValue(k).trim(); if (v) { o.vars[k] = v; } });" +
      "function lu(sel, props) { var n = document.querySelector(sel); if (!n) { return null; }" +
      "  var s = getComputedStyle(n), r = {};" +
      "  props.forEach(function (p) { r[p] = s.getPropertyValue(p); }); return r; }" +
      "o.boites.toolbar = lu('#master-toolbar', ['background-color', 'color']);" +
      "o.boites.entete = lu('.spacer-header', ['color']);" +
      "o.boites.filet = lu('.spacer-inner', ['background-color']);" +
      "try { var p = window.__vtMagPref(); o.theme = p ? p.colorTheme : null; } catch (e) {}" +
      "return o;";
    await driver.executeScript(
      "window.__vtMagPref = function () { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get('preference')) { return p._s.get('preference'); } } return null; };");
    const clair = await driver.executeScript(LIS_THEME, CANDIDATS);
    const bascula = await driver.executeScript(
      "var p = window.__vtMagPref(); if (!p) { return 'pas de magasin'; }" +
      "window.__vtThemeAvant = p.colorTheme;" +
      /* On passe par SON action si elle existe : écrire l'état à la main peut
       * laisser sa feuille de style en arrière. */
      "var noms = Object.keys(p).filter(function (k) { return /theme/i.test(k) && typeof p[k] === 'function'; });" +
      "if (noms.length) { try { p[noms[0]]('dark'); return 'action ' + noms[0]; } catch (e) {} }" +
      "try { p.$patch({ colorTheme: 'dark' }); return 'patch'; } catch (e) { return 'refus ' + String(e).slice(0, 60); }");
    await dors(1800);
    const sombre = await driver.executeScript(LIS_THEME, CANDIDATS);
    await driver.executeScript(
      "var p = window.__vtMagPref();" +
      "if (p && window.__vtThemeAvant) { try { p.$patch({ colorTheme: window.__vtThemeAvant }); } catch (e) {} }");

    console.log("\n  4. CLAIR CONTRE SOMBRE (bascule par « " + bascula + " »)");
    console.log("     thème lu : " + clair.theme + " → " + sombre.theme);
    console.log("     " + "variable".padEnd(34) + "clair".padEnd(26) + "sombre");
    Object.keys(clair.vars).forEach((k) => {
      const a = clair.vars[k], b = sombre.vars[k] || "(absente)";
      console.log("     " + (a !== b ? "→ " : "  ") + k.padEnd(32) + String(a).padEnd(26) + b);
    });
    ["toolbar", "entete", "filet"].forEach((b) => {
      console.log("     " + b + " : " + JSON.stringify(clair.boites[b]) +
                  "  →  " + JSON.stringify(sombre.boites[b]));
    });

    releve("theme-roll20.json", { couleurs, glyphes, bascule, clair, sombre });
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- SA BARRE D'OUTILS : Y A-T-IL UNE PLACE POUR NOUS ? ----------
 *
 * Fusionner avec son RENDU est hors d'atteinte — mesuré deux fois. Mais la
 * gêne, c'est le cadre flottant en trop. Or le module de zoom a déjà montré la
 * voie : on ne dessine pas un bouton, on CLONE le sien et on entre dans sa
 * boîte. Reste à savoir s'il y a une boîte où entrer.
 *
 * Lecture seule : on décrit sa colonne de gauche, ses boutons, leurs classes, et
 * ce qui s'ouvre quand on en presse un. */
async function barreRoll20() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(8000);

    const r = await driver.executeScript(
      "function decris(n) { var r = n.getBoundingClientRect();" +
      "  return { balise: n.tagName.toLowerCase(), classe: String(n.className || '').slice(0, 78)," +
      "    id: n.id || null, texte: (n.textContent || '').trim().slice(0, 26)," +
      "    boite: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]," +
      "    enfants: n.children.length }; }" +
      /* Tout ce qui est collé au bord gauche et assez haut pour être une
       * colonne d'outils. */
      "var col = [].slice.call(document.querySelectorAll('div,nav,aside,ul'))" +
      "  .filter(function (n) { var r = n.getBoundingClientRect();" +
      "    return r.left < 60 && r.width > 20 && r.width < 130 && r.height > 260; })" +
      "  .map(decris);" +
      /* Et les boutons qui s'y trouvent. */
      "var boutons = [].slice.call(document.querySelectorAll('button,[role=button]'))" +
      "  .filter(function (n) { var r = n.getBoundingClientRect();" +
      "    return r.left < 60 && r.width > 10 && r.height > 10; })" +
      "  .map(decris);" +
      "return { colonnes: col.slice(0, 8), boutons: boutons.slice(0, 24)," +
      "  toile: (function () { var c = document.querySelector('canvas');" +
      "    var r = c.getBoundingClientRect();" +
      "    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() };");
    console.log("\n  colonnes au bord gauche :");
    r.colonnes.forEach((n) => console.log("    " + JSON.stringify(n)));
    console.log("\n  boutons au bord gauche :");
    r.boutons.forEach((n) => console.log("    " + JSON.stringify(n)));
    console.log("\n  toile : " + JSON.stringify(r.toile));

    /* LES INTITULÉS DE SECTION. Sa colonne est découpée en groupes — OUTILS,
     * EFFETS —, et on veut y ajouter le nôtre. On relève donc TOUS les enfants
     * de la colonne dans l'ordre, pas seulement les boutons : l'intitulé est un
     * enfant comme un autre, et c'est lui qu'on clonera. */
    const enfants = await driver.executeScript(
      "var col = document.querySelector('.upper-buttons');" +
      "if (!col) { return null; }" +
      "return [].slice.call(col.children).map(function (n, i) {" +
      "  var r = n.getBoundingClientRect();" +
      "  return { i: i, balise: n.tagName.toLowerCase()," +
      "    classe: String(n.className || '').slice(0, 60)," +
      "    texte: (n.textContent || '').trim().slice(0, 20)," +
      "    boite: [Math.round(r.top), Math.round(r.width), Math.round(r.height)]," +
      "    html: n.outerHTML.slice(0, 240) }; });");
    console.log("\n  enfants de .upper-buttons, dans l'ordre :");
    (enfants || []).forEach((n) => console.log(
      "    [" + n.i + "] " + n.balise + " « " + n.texte + " » " +
      JSON.stringify(n.boite) + " — " + n.classe));
    const etiquettes = (enfants || []).filter((n) => !/toolbar-button-outer/.test(n.classe));
    console.log("\n  ce qui n'est PAS un bouton (donc les intitulés) :");
    etiquettes.forEach((n) => console.log("    [" + n.i + "] " + n.html));

    /* LE DEDANS D'UN BOUTON. C'est lui qu'on clonera : ses classes portent sa
     * police d'icônes, son thème et ses états. En redessiner un à nous, ce
     * serait la pièce rapportée qu'on veut justement éviter. */
    const dedans = await driver.executeScript(
      "var col = document.querySelector('.upper-buttons');" +
      "if (!col) { return null; }" +
      "var bs = [].slice.call(col.querySelectorAll('button'));" +
      "return { n: bs.length," +
      "  premier: bs[0] ? bs[0].outerHTML.slice(0, 420) : null," +
      "  dernier: bs[bs.length - 1] ? bs[bs.length - 1].outerHTML.slice(0, 420) : null," +
      "  actif: (function () {" +
      "    var a = bs.filter(function (b) { return /active|selected/i.test(b.className); })[0];" +
      "    return a ? a.outerHTML.slice(0, 300) : 'aucun bouton actif'; })()," +
      "  colonne: col.outerHTML.slice(0, 200)," +
      /* Les noms de glyphes disponibles : on ne dessinera pas une icône si la
       * sienne existe. */
      "  glyphes: bs.map(function (b) {" +
      "    var s = b.querySelector('[class*=icon i], span');" +
      "    return s ? { classe: String(s.className).slice(0, 50), texte: (s.textContent || '').trim() } : null; }) };");
    console.log("\n  dedans de sa colonne :");
    console.log("    " + (dedans && dedans.colonne));
    console.log("    premier bouton : " + (dedans && dedans.premier));
    console.log("    dernier bouton : " + (dedans && dedans.dernier));
    console.log("    bouton actif   : " + (dedans && dedans.actif));
    console.log("    glyphes : " + JSON.stringify(dedans && dedans.glyphes));
    releve("barre-roll20.json", { ...r, dedans });
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- ET SI L'ON INJECTE AVANT QUE L'ATLAS SOIT CONSTRUIT ? ----------
 *
 * L'essai précédent a tranché une moitié de la question : une entrée ajoutée au
 * catalogue APRÈS le chargement n'est pas dessinée, parce que Roll20
 * échantillonne ses pictogrammes dans un atlas de 4096 × 4096 bâti une fois.
 *
 * Reste l'autre moitié, et c'est celle qui déciderait de tout : si l'atlas est
 * bâti À PARTIR de `token_markers`, alors injecter AVANT sa construction ferait
 * entrer nos images dedans. On aurait alors la fusion complète — pictogrammes
 * natifs, dessinés par lui, dans son propre menu — SANS RIEN ÉCRIRE dans la
 * campagne, puisque l'injection reste locale à chaque navigateur.
 *
 * On recharge donc la page et on pose un guetteur qui injecte dès que
 * `Campaign` existe et que la scène, elle, n'existe pas encore. */
async function fusionTot() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4000);
    const avantCat = await driver.executeScript(
      "return window.Campaign ? window.Campaign.attributes.token_markers : null;");

    const IMG = "https://cdn.discordapp.com/embed/avatars/3.png";
    await driver.navigate().refresh();
    /* LE GUETTEUR, posé le plus tôt possible après la navigation. Il tourne DANS
     * la page, à cinquante millisecondes : un aller-retour par WebDriver serait
     * trop lent pour attraper l'instant. */
    await driver.executeScript(
      "window.__vtTot = { pose: true };" +
      "var img = arguments[0];" +
      "var t = setInterval(function () {" +
      "  var C = window.Campaign;" +
      "  if (!C || !C.attributes || !C.attributes.token_markers) { return; }" +
      "  var l; try { l = JSON.parse(C.attributes.token_markers); } catch (e) { return; }" +
      /* ATTENDRE QUE LE CATALOGUE SOIT PEUPLÉ. Le premier essai injectait dès
       * que l'attribut existait — c'est-à-dire sur un « [] » de départ, que
       * Roll20 remplaçait ensuite par ses 47 entrées, emportant la nôtre.
       * On attend donc qu'il soit là POUR DE BON, et que la scène ne le soit
       * pas encore : c'est cette fenêtre-là qu'on veut. */
      "  if (!l.length || l.length < 5) { return; }" +
      "  if (window.MeshScene) { clearInterval(t);" +
      "    window.__vtTot = { injecte: false, raison: 'scène montée avant que le catalogue soit peuplé'," +
      "      entrees: l.length }; return; }" +
      "  clearInterval(t);" +
      "  var maxId = l.reduce(function (a, m) { return Math.max(a, +m.id || 0); }, 0);" +
      "  l.push({ id: maxId + 1, name: 'vtfusion', tag: 'vtfusion', url: img });" +
      "  C.attributes.token_markers = JSON.stringify(l);" +
      "  window.__vtTot = { injecte: true, entrees: l.length," +
      /* L'INSTANT COMPTE, et c'est lui qu'on relève : la scène était-elle déjà
       * montée quand on a injecté ? Si oui, on est arrivé trop tard et l'essai
       * ne prouve rien. */
      "    sceneDejaLa: !!window.MeshScene," +
      "    ms: Math.round((window.performance && performance.now()) || 0) };" +
      "}, 50);", IMG);

    /* SURTOUT PAS `vaALaPartie` ICI. Il RENAVIGUE, ce qui détruit la page et
     * le guetteur avec — c'est ce qui a fait échouer le premier essai, en
     * silence, avec un `__vtTot` à null. Le rechargement a déjà eu lieu ; il
     * n'y a plus qu'à laisser la scène se monter. */
    /* ON ATTEND UN ÉTAT, PAS UNE DURÉE. Douze secondes suffisaient un jour et
     * pas le lendemain : `thegraphics` était encore indéfini et l'épreuve
     * mourait sur une erreur qui n'avait rien à voir avec ce qu'elle mesure. */
    for (let i = 0; i < 40; i++) {
      const pret = await driver.executeScript(
        "try { return !!(window.MeshScene && window.Campaign && window.Campaign.activePage()" +
        "  && window.Campaign.activePage().thegraphics" +
        "  && window.Campaign.activePage().thegraphics.models.length); }" +
        "catch (e) { return false; }");
      if (pret) { break; }
      await dors(1000);
    }
    await dors(3000);

    const etat = await driver.executeScript("return window.__vtTot || null;");
    console.log("\n  guetteur : " + JSON.stringify(etat));
    if (!etat || !etat.injecte) { console.log("  L'INJECTION N'A PAS EU LIEU."); return 1; }
    if (etat.sceneDejaLa) {
      console.log("  ATTENTION : la scène existait déjà — l'essai ne prouve rien.");
    }

    /* Notre module éteint : on ne veut voir que ce que Roll20 fait. */
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs', actif: false }, '*');");
    await dors(1000);

    const inj = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers };" +
      "t.save({ statusmarkers: 'vtfusion' }); return r;");
    repose = inj;
    await dors(4000);

    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var noeud = S.getTransformNodeByName(arguments[0] + '-markers');" +
      "var enfants = noeud && noeud.getChildren ? noeud.getChildren() : [];" +
      "return { enfants: enfants.map(function (m) { return String(m.name).slice(-34); })," +
      "  textures: (S.textures || []).map(function (t) { return String(t.name || t.url || '?').slice(-40); }).slice(0, 12) };",
      inj.id);
    console.log("\n  enfants du nœud de marqueurs : " + JSON.stringify(vu.enfants));
    console.log("  textures de la scène : " + JSON.stringify(vu.textures));
    const dessine = vu.enfants.some((n) => /vtfusion/.test(n));
    console.log("\n  → injecté AVANT la scène, Roll20 le dessine-t-il ? " +
                (dessine ? "OUI" : "NON"));
    releve("fusion-tot.json", { etat, vu, dessine });
    return 0;
  } finally {
    await driver.executeScript(
      "var C = window.Campaign;" +
      "if (arguments[2]) { C.attributes.token_markers = arguments[2]; }" +
      "if (arguments[0]) { var t = C.activePage().thegraphics.get(arguments[0]);" +
      "  if (t) { t.save({ statusmarkers: arguments[1] || '' }); } }",
      repose && repose.id, repose && repose.avant, null).catch(() => {});
    await dors(1000);
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE MARQUEUR D'AUTRUI, SUR UNE VRAIE PARTIE ----------
 *
 * C'EST LA SEULE ÉPREUVE QUI JUSTIFIE LE FORMAT D'ÉTIQUETTE. Tout le reste se
 * vérifie au banc ; ceci, non — il y faut le vrai Backbone et le vrai Firebase.
 *
 * On écrit sur un token une étiquette que NOTRE palette ne contient pas, et qui
 * n'a été annoncée nulle part : ni document de campagne, ni réglage, ni message.
 * Exactement ce que verrait un joueur dont un camarade vient de poser un
 * marqueur maison. Elle doit se dessiner quand même, puisqu'elle porte son
 * adresse — et rester hors de notre barre, qui ne montre que nos marqueurs.
 *
 * Le sous-système de partage qui s'éprouvait ici — un document de campagne créé,
 * fusionné, mis à converger, et que seul un MJ pouvait écrire — a été supprimé :
 * l'étiquette porte l'adresse, il n'y a plus rien à faire circuler. La question,
 * elle, n'a pas changé, et se pose plus directement qu'avant.
 *
 * L'étiquette est retirée du token à la fin, quoi qu'il arrive. */
async function vraiPartage() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(6000);

    /* NOTRE palette : une seule entrée, et ce n'est PAS celle qu'on va poser. */
    const MIEN = "vttk_mien_cdn.discordapp.com/embed/avatars/0.png";
    const PALETTE = [
      { tag: MIEN, nom: "Le mien", url: "https://cdn.discordapp.com/embed/avatars/0.png" }
    ];
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs'," +
      "  actif: true, catalogue: arguments[0] }, '*');", PALETTE);
    await dors(2500);

    /* CELLE D'AUTRUI : une adresse que nous n'avons jamais vue, et une image
     * différente de la nôtre — sans quoi un quad dessiné ne prouverait rien. */
    const AUTRUI = "vttk_dautrui_cdn.discordapp.com/embed/avatars/1.png";
    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers };" +
      "t.save({ statusmarkers: arguments[0] }); return r;", AUTRUI);
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    console.log("\n  posé sur « " + dep.nom + " » : " + AUTRUI);
    await dors(3000);

    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var q = (S.meshes || []).filter(function (m) { return /^vttk-marqueur-/.test(m.name); });" +
      "var b = document.querySelector('.vttk-barre');" +
      "return { quads: q.map(function (m) {" +
      "    var t = m.material && m.material.getActiveTextures ? m.material.getActiveTextures()[0] : null;" +
      "    return { nom: m.name, prete: t ? t.isReady() : null," +
      "      url: t ? String(t.url || '').slice(-28) : null }; })," +
      "  boutons: b ? [].slice.call(b.querySelectorAll('.vttk-barre-marqueur'))" +
      "    .map(function (x) { return x.getAttribute('data-tag'); }) : null," +
      "  journal: (window.__vttinkerJournal || []).filter(function (l) { return /marqueur|catalogue/i.test(l); }).slice(-3) };");
    console.log("\n  quads dessinés : " + JSON.stringify(vu.quads));
    console.log("  boutons de la barre : " + JSON.stringify(vu.boutons));
    console.log("  journal : "); vu.journal.forEach((l) => console.log("    · " + l));

    /* LA TEXTURE DOIT ÊTRE LA SIENNE, pas la nôtre : on lit l'adresse chargée,
     * et pas seulement le nom du mesh — un quad au bon nom qui afficherait notre
     * image passerait pour une réussite alors que rien n'aurait été résolu. */
    const q = vu.quads.filter((x) => x.nom === "vttk-marqueur-" + AUTRUI)[0];
    const dessine = !!(q && q.prete && /avatars\/1\.png$/.test(q.url || ""));
    const pasDansLaBarre = (vu.boutons || []).indexOf(AUTRUI) < 0;
    console.log("\n  → le marqueur d'autrui SE DESSINE, avec SON image : " + (dessine ? "OUI" : "NON"));
    console.log("    et il n'encombre pas notre barre : " + (pasDansLaBarre ? "OUI" : "NON"));
    releve("marqueur-dautrui.json", { palette: PALETTE, pose: AUTRUI, vu, dessine, pasDansLaBarre });
    return (dessine && pasDansLaBarre) ? 0 : 1;
  } finally {
    const net = await driver.executeScript(
      "var C = window.Campaign;" +
      "if (!arguments[0]) { return null; }" +
      "var t = C.activePage().thegraphics.get(arguments[0]);" +
      "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }" +
      "return { token: arguments[0], rendu: arguments[1] || '' };",
      repose && repose.id, repose && repose.avant).catch(() => null);
    console.log("  étiquette rendue : " + JSON.stringify(net));
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE CYCLE COMPLET D'UN DOCUMENT ----------
 *
 * La campagne n'en a aucun : on ne peut donc rien observer sans en créer un.
 * Celui-ci porte un nom d'essai sans ambiguïté et il est SUPPRIMÉ quoi qu'il
 * arrive — y compris si l'épreuve échoue en chemin.
 *
 * Cinq questions, et chacune change le dessin du module :
 *   1. comment on crée, et si la création est asynchrone ;
 *   2. comment on écrit le texte — `notes` n'est pas un attribut ordinaire ;
 *   3. comment on le relit, et en combien de temps ;
 *   4. si un document ARCHIVÉ reste lisible : ce serait l'idéal, partagé mais
 *      hors du journal, donc sans encombrer la partie ;
 *   5. quel événement prévient qu'un autre joueur l'a changé. */
async function cycleDocument() {
  const driver = await ouvre(config().visible === true);
  let cree = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    const NOM = "VTTinker — essai à supprimer";
    const TEXTE = JSON.stringify({ v: 1, marqueurs: [{ tag: "vttk-essai", url: "https://exemple.org/a.png" }] });

    const fait = await driver.executeAsyncScript(
      "var cb = arguments[arguments.length - 1];" +
      "var C = window.Campaign, nom = arguments[0], txt = arguments[1];" +
      "var fini = false;" +
      "var minuteur = setTimeout(function () { if (!fini) { fini = true; cb({ delai: 'création' }); } }, 12000);" +
      "function rends(o) { if (fini) { return; } fini = true; clearTimeout(minuteur); cb(o); }" +
      /* LE RAPPEL « success » NE VIENT PAS — mesuré, douze secondes d'attente
       * pour rien, alors que le document, lui, était bien créé. Backbone rend
       * le modèle directement : on s'en sert, et on n'attend personne. */
      "try {" +
      "  var m = C.handouts.create({ name: nom, inplayerjournals: 'all', archived: true });" +
      "  if (!m) { rends({ erreur: 'create n\\'a rien rendu' }); return; }" +
      "  window.__vtDoc = m.id;" +
      "  var out = { id: m.id, champs: Object.keys(m.attributes)," +
      "    methodes: Object.keys(m).filter(function (k) { return typeof m[k] === 'function'; }).slice(0, 24) };" +
      "  try { m.save({ notes: txt }); out.ecrit = 'save'; }" +
      "  catch (e) { out.ecrit = 'échec ' + String(e).slice(0, 60); }" +
      "  setTimeout(function () {" +
      "    out.archive = m.attributes.archived;" +
      "    out.journaux = m.attributes.inplayerjournals;" +
      "    out.notesEnAttributs = typeof m.attributes.notes;" +
      "    out.notesBrutes = String(m.attributes.notes || '').slice(0, 70);" +
      /* LA VOIE SYNCHRONE D'ABORD. Le get de Backbone rend la valeur et ignore
       * un second argument : passer un rappel ne fait alors rien du tout, et
       * c'est très exactement ce qui a fait expirer les deux essais précédents.
       * On regarde ce que get rend VRAIMENT avant de croire qu'il rappelle. */
      "    try { var direct = m.get('notes');" +
      "      out.getDirect = { type: typeof direct, taille: direct ? String(direct).length : 0," +
      "        egal: String(direct) === txt, debut: String(direct || '').slice(0, 70) }; }" +
      "    catch (e) { out.getDirect = { erreur: String(e).slice(0, 80) }; }" +
      /* Puis la voie à rappel, mais SANS en dépendre pour rendre la main. */
      "    var rappele = false;" +
      "    try { m.get('notes', function (t) { rappele = true;" +
      "      out.getRappel = { taille: t ? String(t).length : 0, egal: String(t) === txt }; }); }" +
      "    catch (e) { out.getRappel = { erreur: String(e).slice(0, 80) }; }" +
      "    setTimeout(function () {" +
      "      if (!rappele && !out.getRappel) { out.getRappel = 'jamais rappelé'; }" +
      "      rends(out); }, 3000);" +
      "  }, 3000);" +
      "} catch (e) { rends({ erreur: String(e).slice(0, 140) }); }",
      NOM, TEXTE);
    cree = await driver.executeScript("return window.__vtDoc || null;");
    console.log("\n  " + JSON.stringify(fait, null, 1).slice(0, 1800));

    /* L'événement : c'est lui qui préviendra qu'un autre joueur a publié. */
    const ev = await driver.executeScript(
      "var C = window.Campaign, vus = [];" +
      "if (!C.handouts.on) { return { erreur: 'pas de on()' }; }" +
      "C.handouts.on('add change remove', function (m, o, x) { vus.push('événement'); });" +
      "return { branche: true, n: C.handouts.length };");
    console.log("  écoute de la collection : " + JSON.stringify(ev));
    releve("cycle-document.json", { fait, ev });
    return 0;
  } finally {
    /* SUPPRESSION GARANTIE. C'est la partie de l'auteur, pas un bac à sable. */
    const parti = await driver.executeScript(
      "var C = window.Campaign;" +
      "var n = 0;" +
      "C.handouts.models.slice().forEach(function (h) {" +
      "  if (/VTTinker — essai/.test(h.attributes.name || '')) {" +
      "    try { h.destroy(); n++; } catch (e) {} } });" +
      "return { supprimes: n, restants: C.handouts.length };").catch(() => null);
    console.log("  nettoyage : " + JSON.stringify(parti));
    await dors(1200);
    await driver.quit().catch(() => {});
  }
}

/* ---------- POSER UN MARQUEUR COMME LE FERAIT QUELQU'UN ----------
 *
 * La barre est à nous : ses boutons sont du DOM ordinaire, et un clic dessus se
 * simule sans peine. Le clic sur le PLATEAU, lui, doit traverser notre écouteur
 * en capture — c'est justement ce qu'on éprouve.
 *
 * On vérifie les trois temps : la barre paraît, le marqueur s'arme, et l'étiquette
 * arrive dans les données du token. Puis on recommence, pour voir qu'un second
 * clic la RETIRE : une bascule qui ne bascule que dans un sens n'est pas une
 * bascule. */
async function poserMarqueur() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    await dors(6000);

    const PALETTE = [
      { tag: "vttk_essaia_cdn.discordapp.com/embed/avatars/0.png", nom: "Essai A", url: "https://cdn.discordapp.com/embed/avatars/0.png" },
      { tag: "vttk_essaib_cdn.discordapp.com/embed/avatars/1.png", nom: "Essai B", url: "https://cdn.discordapp.com/embed/avatars/1.png" }
    ];
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs'," +
      "  actif: true, catalogue: arguments[0] }, '*');", PALETTE);
    await dors(1800);

    /* LA GREFFE D'ABORD : notre bouton est-il bien DANS sa colonne d'outils, et
     * le tiroir bien fermé tant qu'on ne l'ouvre pas ? */
    const greffe = await driver.executeScript(
      /* PAR SA MARQUE : la section VTTK porte deux boutons — les réglages et
       * les marqueurs —, et « le premier .vttk-outil » donnait les réglages. */
      "var o = document.querySelector('.vttk-outil-marqueurs');" +
      "var b = document.querySelector('.vttk-barre');" +
      "if (!b) { return null; }" +
      "var rb = b.getBoundingClientRect();" +
      "return { greffe: !!o," +
      "  dansSaColonne: !!(o && o.closest && o.closest('.upper-buttons'))," +
      "  classesOutil: o ? String(o.className).slice(0, 70) : null," +
      "  boiteOutil: o ? (function () { var r = o.getBoundingClientRect();" +
      "    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() : null," +
      /* LE GLYPHE, et non plus une vignette : le bouton portait l'image du
       * premier marqueur faute de savoir ce que sa police d'icônes contenait. On
       * l'a mesurée depuis, et « starFilled » en fait partie. */
      "  glyphe: (function () { var g = o && o.querySelector('.grimoire__roll20-icon');" +
      "    return g ? g.textContent : null; })()," +
      "  classesBarre: String(b.className)," +
      "  tiroirVisible: rb.width > 0 && rb.height > 0," +
      "  boutons: b.querySelectorAll('.vttk-barre-marqueur').length," +
      "  images: [].slice.call(b.querySelectorAll('.vttk-barre-marqueur img')).map(function (i) {" +
      "    return { fini: i.complete, large: i.naturalWidth }; }) };");
    if (!greffe) { console.log("  LA PALETTE N'EXISTE PAS."); return 1; }
    console.log("  bouton greffé : " + greffe.greffe + ", dans sa colonne : " + greffe.dansSaColonne);
    console.log("    classes : " + greffe.classesOutil + " ; boîte " + JSON.stringify(greffe.boiteOutil));
    console.log("    glyphe : " + JSON.stringify(greffe.glyphe));
    console.log("  palette : « " + greffe.classesBarre + " », visible : " + greffe.tiroirVisible +
                ", " + greffe.boutons + " boutons");
    console.log("    images : " + JSON.stringify(greffe.images));

    /* LA PALETTE PORTE-T-ELLE LES DEUX FAMILLES ? Les siens valent d'y être :
     * c'est LUI qui les dessine, donc tout le monde les voit, extension ou pas. */
    const familles = await driver.executeScript(
      "var b = document.querySelector('.vttk-barre');" +
      "if (!b) { return null; }" +
      "return { entetes: [].slice.call(b.querySelectorAll('.vttk-marqueur-entete-mot')).map(function (n) { return n.textContent; })," +
      "  tuiles: b.querySelectorAll('.vttk-barre-marqueur').length," +
      "  supprimables: b.querySelectorAll('.vttk-marqueur-sup').length," +
      "  champ: !!b.querySelector('.vttk-marqueur-champ')," +
      "  etiquettes: [].slice.call(b.querySelectorAll('.vttk-barre-marqueur'))" +
      "    .map(function (n) { return n.getAttribute('data-tag'); }).slice(0, 6) };");
    console.log("  familles : " + JSON.stringify(familles));

    /* On l'ouvre comme un utilisateur : en pressant NOTRE bouton dans SA barre. */
    const ouvert = await driver.executeScript(
      "var o = document.querySelector('.vttk-outil-marqueurs button');" +
      "if (!o) { return { erreur: 'pas de bouton greffé' }; }" +
      "o.click();" +
      "var b = document.querySelector('.vttk-barre');" +
      "var r = b.getBoundingClientRect();" +
      "return { ouvert: b.classList.contains('ouvert')," +
      "  boite: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]," +
      "  presse: o.getAttribute('aria-expanded') };");
    console.log("  après un clic sur le bouton : " + JSON.stringify(ouvert));
    /* LES IMAGES SONT PARESSEUSES, et c'est voulu : quarante-neuf vignettes ne
     * se chargent pas tant que la palette est fermée. Capturer aussitôt ouvert
     * ne montrait que des carrés vides — ce n'était pas un défaut, seulement une
     * mesure prise trop tôt. */
    await dors(2500);
    const chargees = await driver.executeScript(
      "var im = [].slice.call(document.querySelectorAll('.vttk-barre-marqueur img'));" +
      "return { total: im.length, chargees: im.filter(function (i) { return i.complete && i.naturalWidth > 0; }).length };");
    console.log("  vignettes chargées : " + JSON.stringify(chargees));
    /* ON REGARDE. Les nombres disent que le bouton fait 42 × 34 au bon endroit ;
     * ils ne disent pas s'il a l'air d'être à lui. */
    await capture(driver, "poser-colonne.png");

    const dep = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "return t ? { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top } : null;");
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    console.log("  token « " + dep.nom + " », marqueurs au départ : " + JSON.stringify(dep.avant));

    /* On arme, puis on clique le plateau à l'endroit du token. */
    const CLIC =
      "var b = document.querySelector('.vttk-barre-marqueur[data-tag=\"vttk_essaia_cdn.discordapp.com/embed/avatars/0.png\"]');" +
      "if (arguments[0]) { b.click(); }" +
      "var S = window.MeshScene, e = S.getEngine(), C = window.Campaign;" +
      "var t = C.activePage().thegraphics.get(arguments[1]);" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var cv = e.getRenderingCanvas(), r = cv.getBoundingClientRect();" +
      "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
      "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
      "var p = V.Project(new V(t.attributes.left, -t.attributes.top, 9999000), M.Identity(), S.getTransformMatrix(), vp);" +
      "var x = p.x * r.width / e.getRenderWidth() + r.left;" +
      "var y = p.y * r.height / e.getRenderHeight() + r.top;" +
      "cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y," +
      "  bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));" +
      "return { arme: !!document.querySelector('.vttk-barre-marqueur.arme')," +
      "  clic: [Math.round(x), Math.round(y)] };";

    const un = await driver.executeScript(CLIC, true, dep.id);
    await dors(1600);
    const apresUn = await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "return { marqueurs: t.attributes.statusmarkers," +
      "  quads: (window.MeshScene.meshes || []).filter(function (m) { return /^vttk-marqueur-/.test(m.name); }).length };",
      dep.id);
    console.log("\n  1er clic — armé : " + un.arme + ", en " + JSON.stringify(un.clic));
    console.log("    marqueurs : " + JSON.stringify(apresUn.marqueurs) +
                " ; quads en scène : " + apresUn.quads);

    /* Le même geste une seconde fois : le marqueur doit s'en aller. Le bouton est
     * resté armé, donc on ne le reclique pas. */
    await driver.executeScript(CLIC, false, dep.id);
    await dors(1600);
    const apresDeux = await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "return { marqueurs: t.attributes.statusmarkers," +
      "  quads: (window.MeshScene.meshes || []).filter(function (m) { return /^vttk-marqueur-/.test(m.name); }).length };",
      dep.id);
    console.log("  2e clic au même endroit :");
    console.log("    marqueurs : " + JSON.stringify(apresDeux.marqueurs) +
                " ; quads en scène : " + apresDeux.quads);

    /* ---------- LE CŒUR DU CHANGEMENT ----------
     *
     * Une étiquette qui porte son adresse doit se dessiner SANS être dans notre
     * palette : c'est exactement le cas d'un marqueur posé par quelqu'un d'autre.
     * Si ça marche, tout le catalogue partagé — document de campagne, fusion,
     * convergence, droits de MJ — était de trop. */
    const ETRANGER = "vttk_autrui_cdn.discordapp.com/embed/avatars/4.png";
    await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ statusmarkers: arguments[1] });", dep.id, ETRANGER);
    await dors(3500);
    const etr = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var q = (S.meshes || []).filter(function (m) { return /^vttk-marqueur-/.test(m.name); });" +
      "var b = document.querySelector('.vttk-barre');" +
      "return { quads: q.map(function (m) {" +
      "    var t = m.material && m.material.getActiveTextures ? m.material.getActiveTextures()[0] : null;" +
      /* PAS DE TRONCATURE ICI. Le premier jet coupait le nom à 46 caractères
       * par la fin — ce qui emportait justement le préfixe qu'on cherchait, et
       * l'épreuve concluait « non » sur un quad parfaitement présent. */
      "    return { nom: m.name, prete: t ? t.isReady() : null }; })," +
      "  dansLaPalette: !!(b && [].slice.call(b.querySelectorAll('.vttk-barre-marqueur'))" +
      "    .filter(function (n) { return n.getAttribute('data-tag') === arguments[0]; }).length) };",
      ETRANGER);
    console.log("\n  étiquette d'autrui, ABSENTE de la palette :");
    console.log("    " + JSON.stringify(etr));
    const dessineEtranger = etr.quads.some((q) => /vttk_autrui/.test(q.nom) && q.prete);
    console.log("    → elle se dessine quand même : " + (dessineEtranger ? "OUI" : "NON"));

    const pose = String(apresUn.marqueurs || "").indexOf("vttk_essaia_cdn.discordapp.com/embed/avatars/0.png") >= 0;
    const ote = String(apresDeux.marqueurs || "").indexOf("vttk_essaia_cdn.discordapp.com/embed/avatars/0.png") < 0;
    console.log("\n  → pose : " + (pose ? "OUI" : "NON") +
                " ; retrait : " + (ote ? "OUI" : "NON"));
    releve("poser-marqueur.json", { greffe, ouvert, un, apresUn, apresDeux });
    return (pose && ote) ? 0 : 1;
  } finally {
    if (repose) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }",
        repose.id, repose.avant).catch(() => {});
      await dors(900);
    }
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- COMMENT SAVOIR CE QUI EST SÉLECTIONNÉ ----------
 *
 * Notre bande de marqueurs ne doit paraître que lorsqu'un token est choisi, et
 * agir sur celui-là. Reste à trouver où Roll20 tient sa sélection : un magasin
 * Pinia, un reste de l'ancien d20, ou un événement. On cherche partout à la
 * fois, et on VÉRIFIE en sélectionnant pour de bon — un nom qui contient
 * « select » ne prouve rien tant qu'il n'a pas changé sous nos yeux.
 *
 * Lecture seule : un clic sur un token, comme un joueur. */
async function choixMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    const MAG =
      "function __mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "function __tous() { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s) { return p._s; } } return null; }";

    const LIS =
      MAG +
      "var out = { magasins: [], d20: [], selection: null };" +
      "var s = __tous();" +
      "if (s) { s.forEach(function (st, nom) {" +
      "  var cles = [];" +
      "  try { cles = Object.keys(st.$state || {}).filter(function (k) { return /select|active|chos|current/i.test(k); }); } catch (e) {}" +
      "  if (cles.length) {" +
      "    var v = {}; cles.forEach(function (k) {" +
      "      var x = st[k];" +
      "      v[k] = (x && x.length !== undefined) ? ('[' + x.length + ']') :" +
      "             (x && typeof x === 'object') ? Object.keys(x).slice(0, 5).join('/') : String(x).slice(0, 40); });" +
      "    out.magasins.push({ nom: nom, valeurs: v }); } }); }" +
      "var d = (window.currentPlayer && window.currentPlayer.d20) || null;" +
      "if (d) { out.d20 = Object.keys(d).filter(function (k) { return /select|engine|canvas|token/i.test(k); });" +
      "  try { if (d.engine) { out.engineCles = Object.keys(d.engine).filter(function (k) { return /select/i.test(k); }); } } catch (e) {}" +
      "  try { out.selection = d.engine && d.engine.selected ? d.engine.selected().length : null; } catch (e) {} }" +
      "return out;";

    const avant = await driver.executeScript(LIS);
    console.log("\n  AVANT toute sélection :");
    avant.magasins.forEach((m) => console.log("    magasin « " + m.nom + " » : " + JSON.stringify(m.valeurs)));
    console.log("    d20 : " + JSON.stringify(avant.d20) + " ; engine.select* : " +
                JSON.stringify(avant.engineCles) + " ; selected() = " + avant.selection);

    /* On clique le token, pour de bon. */
    const cible = await driver.executeScript(
      "var S = window.MeshScene, e = S.getEngine(), C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var cv = e.getRenderingCanvas(); var r = cv.getBoundingClientRect();" +
      "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
      "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
      "var p = V.Project(new V(t.attributes.left, -t.attributes.top, 9999000), M.Identity(), S.getTransformMatrix(), vp);" +
      "return { id: t.id, nom: t.attributes.name," +
      "  x: p.x * r.width / e.getRenderWidth() + r.left," +
      "  y: p.y * r.height / e.getRenderHeight() + r.top };");
    const cv = await driver.findElement(By.css("canvas"));
    const boite = await cv.getRect();
    await driver.actions({ bridge: true })
      .move({ origin: cv,
              x: Math.round(cible.x - boite.x - boite.width / 2),
              y: Math.round(cible.y - boite.y - boite.height / 2) })
      .click().perform().catch((e) => console.log("  clic refusé : " + e.message.slice(0, 70)));
    await dors(1500);

    /* `tabletopSelected` vit sur l'objet d20, pas dans un magasin : le balayage
     * des états Pinia ne pouvait pas le voir. On le lit là où il est. */
    const sel = await driver.executeScript(
      "var d = (window.currentPlayer && window.currentPlayer.d20) || null;" +
      "var e = d && d.engine; if (!e) { return { erreur: 'pas de d20.engine' }; }" +
      "function decris(x) {" +
      "  if (x === null || x === undefined) { return String(x); }" +
      "  if (x.length !== undefined) { return 'liste[' + x.length + '] ' +" +
      "    [].slice.call(x, 0, 3).map(function (o) {" +
      "      return (o && o.id) || (o && o.model && o.model.id) || typeof o; }).join(','); }" +
      "  if (typeof x === 'object') { return 'objet{' + Object.keys(x).slice(0, 6).join(',') + '}'; }" +
      "  return String(x).slice(0, 60); }" +
      "var out = { tabletopSelected: decris(e.tabletopSelected) };" +
      /* Et tout ce qui, sur engine, ressemble à une sélection : on ne se fie
       * pas au seul nom qu'on a repéré. */
      "out.autres = {};" +
      "Object.keys(e).forEach(function (k) {" +
      "  if (!/select|highlight|focus/i.test(k)) { return; }" +
      "  try { out.autres[k] = decris(e[k]); } catch (err) { out.autres[k] = 'illisible'; } });" +
      "return out;");
    console.log("\n  d20.engine juste après le clic : " + JSON.stringify(sel));

    /* Le clic de WebDriver n'a rien sélectionné. Avant d'en conclure quoi que
     * ce soit sur Roll20, on essaie l'autre voie : des événements de pointeur
     * dispatchés dans la page. Babylon écoute des pointerdown/up ordinaires, et
     * il ne regarde pas si l'événement est « de confiance ». Si celle-ci marche
     * et pas l'autre, le problème était le pilote, pas le site. */
    const parEvenements = await driver.executeScript(
      "var e = window.currentPlayer.d20.engine;" +
      "var cv = window.MeshScene.getEngine().getRenderingCanvas();" +
      "var x = arguments[0], y = arguments[1];" +
      "function tir(type, boutons) {" +
      "  cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y," +
      "    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse'," +
      "    isPrimary: true, button: 0, buttons: boutons })); }" +
      "tir('pointerdown', 1); tir('pointerup', 0); tir('click', 0);" +
      "return { avant: (e.tabletopSelected || []).length };",
      Math.round(cible.x), Math.round(cible.y));
    await dors(1200);
    const vuSel = await driver.executeScript(
      "var e = window.currentPlayer.d20.engine;" +
      "var s = e.tabletopSelected || [];" +
      "return { n: s.length, formes: [].slice.call(s, 0, 3).map(function (o) {" +
      "  if (!o) { return 'nul'; }" +
      "  var cles = Object.keys(o).slice(0, 10);" +
      "  return { cles: cles, id: o.id || null," +
      "    modele: o.model ? (o.model.id || 'sans id') : null," +
      "    graphique: o.graphic ? (o.graphic.id || 'sans id') : null }; }) };");
    console.log("  par événements dispatchés : " + JSON.stringify(vuSel));

    const apres = await driver.executeScript(LIS);
    console.log("\n  APRÈS un clic sur « " + cible.nom + " » (" + cible.id + ") :");
    apres.magasins.forEach((m) => {
      const av = avant.magasins.filter((x) => x.nom === m.nom)[0];
      const change = !av || JSON.stringify(av.valeurs) !== JSON.stringify(m.valeurs);
      console.log("    " + (change ? "→ " : "  ") + "magasin « " + m.nom + " » : " + JSON.stringify(m.valeurs));
    });
    console.log("    selected() = " + apres.selection);
    await capture(driver, "choix-marqueurs.png");
    releve("choix-marqueurs.json", { avant, apres, cible });
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LE MENU DE ROLL20 QUAND UN TOKEN EST CHOISI ----------
 *
 * Pour poser un marqueur, il faut un endroit où cliquer. Deux voies possibles :
 * greffer nos images dans le choix de marqueurs de Roll20 — natif, mais suspendu
 * à la structure de ses composants —, ou poser notre propre bande. On ne
 * tranche pas sans avoir vu à quoi ressemble la sienne.
 *
 * Lecture seule : on sélectionne un token comme le ferait un clic, et on décrit
 * ce qui apparaît. */
async function menuMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    /* Le clic passe par le canevas : on projette le centre du token à l'écran
     * et on y clique pour de bon, plutôt que d'appeler une fonction interne
     * dont rien ne dit qu'elle est le chemin de l'interface. */
    const cible = await driver.executeScript(
      "var S = window.MeshScene, e = S.getEngine(), C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var c = (S.cameras || []).filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var cv = e.getRenderingCanvas(); var r = cv.getBoundingClientRect();" +
      "var V = c.position.constructor, M = c.getWorldMatrix().constructor;" +
      "var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());" +
      "var p = V.Project(new V(t.attributes.left, -t.attributes.top, 9999000), M.Identity(), S.getTransformMatrix(), vp);" +
      "return { nom: t.attributes.name, id: t.id," +
      "  x: Math.round(p.x * r.width / e.getRenderWidth() + r.left)," +
      "  y: Math.round(p.y * r.height / e.getRenderHeight() + r.top) };");
    if (!cible) { console.log("  aucun token."); return 1; }
    console.log("  token « " + cible.nom + " » à l'écran en (" + cible.x + ", " + cible.y + ")");

    const avant = await driver.executeScript(
      "return [].slice.call(document.querySelectorAll('body > *')).length;");
    const cv = await driver.findElement(By.css("canvas"));
    const boite = await cv.getRect();
    await driver.actions({ bridge: true })
      .move({ origin: cv,
              x: Math.round(cible.x - boite.x - boite.width / 2),
              y: Math.round(cible.y - boite.y - boite.height / 2) })
      .click().perform().catch((e) => console.log("  clic refusé : " + e.message.slice(0, 70)));
    await dors(1800);

    const vu = await driver.executeScript(
      "function decris(n, prof) {" +
      "  var r = n.getBoundingClientRect();" +
      "  return { balise: n.tagName.toLowerCase()," +
      "    classe: String(n.className || '').slice(0, 90)," +
      "    id: n.id || null, prof: prof," +
      "    boite: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]," +
      "    texte: (n.textContent || '').trim().slice(0, 40) }; }" +
      /* Tout ce qui vient d'apparaître et qui parle de marqueurs. */
      "var cand = [].slice.call(document.querySelectorAll('[class*=marker i], [class*=status i], [class*=token-menu i], [class*=radial i], [data-marker], [class*=Marker]'));" +
      "var out = { candidats: cand.slice(0, 40).map(function (n) { return decris(n, 0); }) };" +
      "out.corps = [].slice.call(document.querySelectorAll('body > *')).map(function (n) { return decris(n, 0); });" +
      /* Les images visibles de petite taille : un choix de marqueurs en est fait. */
      "out.vignettes = [].slice.call(document.querySelectorAll('img'))" +
      "  .filter(function (n) { var r = n.getBoundingClientRect();" +
      "    return r.width > 8 && r.width < 60 && r.height > 8 && r.height < 60; })" +
      "  .slice(0, 30).map(function (n) { var r = n.getBoundingClientRect();" +
      "    return { src: String(n.src).slice(-46), classe: String(n.className).slice(0, 60)," +
      "      parent: n.parentElement ? String(n.parentElement.className).slice(0, 60) : null," +
      "      boite: [Math.round(r.left), Math.round(r.top), Math.round(r.width)] }; });" +
      "return out;");
    console.log("\n  éléments qui parlent de marqueurs (" + vu.candidats.length + ") :");
    vu.candidats.forEach((n) => console.log("    " + JSON.stringify(n)));
    console.log("\n  vignettes visibles (" + vu.vignettes.length + ") :");
    vu.vignettes.forEach((n) => console.log("    " + JSON.stringify(n)));
    console.log("\n  enfants directs de body : " + vu.corps.length +
                " (avant le clic : " + avant + ")");
    vu.corps.slice(-8).forEach((n) => console.log("    " + JSON.stringify(n)));
    await capture(driver, "menu-marqueurs.png");
    releve("menu-marqueurs.json", vu);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LE MODULE ENTIER, DE BOUT EN BOUT ----------
 *
 * On écrit une palette dans le stockage de l'extension par le VRAI chemin — la
 * page du panneau, browser.storage.local —, on recharge la partie, on colle les
 * étiquettes sur un token, et on regarde ce que la scène contient.
 *
 * DEUX IMAGES, ET C'EST VOULU : l'une servie par Roll20 lui-même, l'autre par
 * un domaine étranger. Si seule la première apparaît, le problème est la
 * politique de sécurité de la page et non notre géométrie ; si aucune
 * n'apparaît, c'est notre géométrie. Une épreuve qui ne distingue pas les deux
 * ne dit rien. */
async function voirMarqueurs() {
  const driver = await ouvre(config().visible === true);
  let repose = null, reposePetit = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (!(await attendPont(driver, 30))) { console.log("Le pont ne s'est pas injecté."); return 1; }
    /* Le pont s'injecte avant que la campagne soit lue : sans cette attente,
     * token_markers rend null et l'épreuve part sur une palette vide. */
    await dors(6000);

    /* L'ÉPREUVE DE L'ORIENTATION SE FAIT PAR COMPARAISON DIRECTE — MAIS LE
     * TÉMOIN DOIT N'AVOIR AUCUNE SYMÉTRIE.
     *
     * On fait dessiner le même pictogramme deux fois côte à côte : par Roll20,
     * et par nous, à partir de la même adresse. Un quad retourné saute alors
     * aux yeux — À CONDITION que l'image le montre.
     *
     * Le premier témoin était « lightning-helix », et il était mauvais : un
     * éclair en Z a une symétrie de DEMI-TOUR, donc pour lui un miroir
     * horizontal et un miroir vertical rendent la MÊME image. L'épreuve
     * concluait « c'est aligné » sur un marqueur retourné, et c'est un utilisateur
     * qui l'a vu.
     *
     * « snail » et « spanner » n'ont ni miroir ni demi-tour. On prend ceux-là,
     * et on en dessine DEUX : un témoin unique qui se révélerait symétrique
     * ferait retomber dans le même piège. */
    /* ON LIT SA LISTE OÙ LE PONT LA LIT : le magasin Pinia « campaign ». Cette
     * sonde interrogeait `Campaign.attributes.token_markers`, et elle a fini par
     * ne plus rien trouver — cet attribut n'est pas toujours peuplé, alors que
     * tokenMarkerData l'est et porte en plus les marqueurs de la campagne. Une
     * sonde qui lit une autre source que le code qu'elle éprouve ment tôt ou
     * tard ; celle-ci mentait en s'arrêtant, ce qui est la façon honnête. */
    const sien = await driver.executeScript(MAGASIN +
      "var c = __mag('campaign');" +
      "var l = (c && c.tokenMarkerData) || null;" +
      "if (!l || !l.length) { try { l = JSON.parse(window.Campaign.attributes.token_markers); } catch (e) { l = null; } }" +
      "if (!l || !l.length) { return null; }" +
      "var veut = ['snail', 'spanner', 'half-heart', 'sleepy'];" +
      "var out = [];" +
      "veut.forEach(function (t) {" +
      "  var m = l.filter(function (k) { return k.tag === t; })[0];" +
      "  if (m && m.url && out.length < 2) { out.push({ tag: m.tag, url: m.url }); } });" +
      "for (var i = 0; out.length < 2 && i < l.length; i++) {" +
      "  if (l[i].url) { out.push({ tag: l[i].tag, url: l[i].url }); } }" +
      "return out.length === 2 ? out : null;");
    if (!sien) { console.log("  catalogue de Roll20 illisible."); return 1; }
    sien.forEach((s) => console.log("  témoin de Roll20 : « " + s.tag + " » — " + String(s.url).slice(0, 62)));
    /* NOS COPIES PORTENT L'ADRESSE DE ROLL20, et il n'y a pas le choix : le pont
     * dessine ce que dit l'ÉTIQUETTE. Une étiquette inventée ferait charger une
     * autre image — ou rien — et la comparaison côte à côte, qui est tout l'objet
     * de l'épreuve, comparerait deux dessins étrangers l'un à l'autre. */
    const PALETTE = [marqueur("copie1", sien[0].url), marqueur("copie2", sien[1].url)];

    /* LA PALETTE EST PORTÉE AU PONT PAR LE MESSAGE MÊME QU'ENVOIE LE MODULE.
     *
     * On aurait préféré l'écrire dans le stockage de l'extension, par la page du
     * panneau — c'est le chemin complet. Il est fermé : Firefox 153 réserve
     * l'ouverture d'une adresse moz-extension:// au contexte privilégié de son
     * interface, lequel exige un drapeau que geckodriver 0.37 refuse de
     * transmettre. Aucune des deux moitiés n'est de notre ressort.
     *
     * Ce n'est pas une perte de couverture, seulement un déplacement : le
     * câblage module → stockage → pont est éprouvé par le banc, qui monte les
     * deux mondes autour d'un seul objet window. Ce que le banc ne peut PAS
     * éprouver, c'est Babylon — et c'est exactement ce que cette épreuve-ci
     * regarde. On envoie donc le message que le module enverrait, mot pour mot,
     * et tout ce qui se passe ensuite est le vrai code. */
    console.log("  palette portée au pont : " + PALETTE.map((j) => j.tag).join(", "));
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'marqueurs'," +
      "  actif: true, catalogue: arguments[0] }, '*');", PALETTE);
    await dors(1500);

    /* Les étiquettes sur le token, par le chemin de Roll20. */
    const dep = await driver.executeScript(
      "var C = window.Campaign, p = C.activePage();" +
      "var t = p.thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top, l: t.attributes.width, ht: t.attributes.height };" +
      /* Les DEUX pictogrammes de Roll20 d'abord, puis NOS deux copies des mêmes
       * images. La rangée se lit alors : sien-1, sien-2, copie-1, copie-2 — de
       * droite à gauche, la rangée étant alignée à droite. Chaque paire se
       * compare, et le décalage s'éprouve du même coup. */
      "r.pose = [arguments[0], arguments[1], arguments[2], arguments[3]].join(',');" +
      "t.save({ statusmarkers: r.pose }); return r;",
      sien[0].tag, sien[1].tag, PALETTE[0].tag, PALETTE[1].tag);
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » ; posé : " + dep.pose);
    /* Le pont ne redessine que sur changement d'étiquettes : il vient d'en
     * recevoir un, mais la texture, elle, arrive du réseau. */
    await dors(4500);

    const vu = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var q = (S.meshes || []).filter(function (m) { return /^vttk-marqueur-/.test(m.name); });" +
      "return { quads: q.map(function (m) {" +
      "    var b = m.getBoundingInfo().boundingBox, mt = m.material;" +
      "    var tx = (mt && mt.getActiveTextures) ? mt.getActiveTextures()[0] : null;" +
      "    return { nom: m.name, parent: m.parent ? String(m.parent.name).slice(-30) : null," +
      "      locale: [m.position.x, m.position.y]," +
      "      monde: [+b.minimumWorld.x.toFixed(1), +b.minimumWorld.y.toFixed(1)," +
      "              +b.maximumWorld.x.toFixed(1), +b.maximumWorld.y.toFixed(1)]," +
      "      image: tx ? { url: String(tx.url || tx.name).slice(-46), prete: tx.isReady()," +
      "        taille: tx.getSize ? [tx.getSize().width, tx.getSize().height] : null } : null }; })," +
      "  siens: (S.meshes || []).filter(function (m) { return m.parent && /-markers$/.test(String(m.parent.name)) && !/^vttk-marqueur|group_marker/.test(m.name); })" +
      "    .map(function (m) { return { nom: m.name, x: m.position.x }; })," +
      /* LA PROFONDEUR, EN ABSOLU. Un marqueur qui paraît devant l'œuvre d'un token
       * à marges transparentes ne prouve rien : il faut les nombres. La caméra
       * est en z = 0 et regarde vers les z croissants, donc PLUS PETIT veut
       * dire PLUS PRÈS. */
      /* ON COMPARE SUR LE MÊME NŒUD, ET PAS AILLEURS. Le premier jet prenait le
       * premier marqueur venu de toute la scène — donc celui d'un AUTRE token,
       * à une autre profondeur — et concluait « derrière » sur des nombres qui
       * ne se comparaient pas. */
      "  profondeurs: (function () {" +
      "    function z(m) { return +m.getAbsolutePosition().z.toFixed(1); }" +
      "    if (!q.length) { return null; }" +
      "    var noeud = q[0].parent;" +
      "    var sien = (S.meshes || []).filter(function (m) {" +
      "      return m.parent === noeud && !/^vttk-marqueur|group_marker/.test(m.name); });" +
      "    return { noeud: String(noeud.name).slice(-28), nous: z(q[0])," +
      "      roll20: sien.length ? z(sien[0]) : null," +
      "      token: +noeud.getAbsolutePosition().z.toFixed(1) }; })()," +
      "  erreur: window.__vttinkerMarqueursErreur || null," +
      "  journal: (window.__vttinkerJournal || []).filter(function (l) { return /marqueur|palette/i.test(l); }) };");
    if (vu.erreur) { console.log("\n  ERREUR RETENUE PAR LE PONT :\n    " + vu.erreur); }
    console.log("\n  profondeurs : " + JSON.stringify(vu.profondeurs));
    if (vu.profondeurs) {
      const p = vu.profondeurs;
      console.log("    nos marqueurs sont " + (p.nous < p.token ? "DEVANT" : "DERRIÈRE") +
                  " l'image du token (" + (p.token - p.nous) + " unités d'avance)" +
                  " ; ceux de Roll20 sont à " + (p.roll20 - p.token) + " de lui");
    }
    console.log("\n  quads de Roll20 sur ce token :");
    vu.siens.forEach((s) => console.log("    " + JSON.stringify(s)));
    console.log("\n  NOS quads :");
    vu.quads.forEach((q) => console.log("    " + JSON.stringify(q)));
    console.log("\n  journal :");
    vu.journal.forEach((l) => console.log("    · " + l));

    await capture(driver, "voir-marqueurs.png");
    /* La rangée entière, agrandie : quatre pictogrammes de vingt-deux tiennent
     * dans une centaine d'unités, à gauche du coin haut-droit du token. */
    await captureZoom(driver, "voir-marqueurs-pres.png",
      [dep.g + dep.l / 2 - 50, -(dep.h - dep.ht / 2) - 12.5, 9999000], 56, 7);
    /* ET LE TOKEN ENTIER, pour voir si nos marqueurs passent DEVANT son image ou
     * derrière. La rangée est à l'intérieur du token : c'est là que ça se juge,
     * et un cadrage serré sur la seule rangée ne le montrerait pas. */
    await captureZoom(driver, "voir-marqueurs-token.png",
      [dep.g, -dep.h, 9999000], 90, 4);

    /* ET SUR LE PETIT TOKEN, dont l'œuvre remplit toute la case. Le gros a des
     * marges transparentes : un marqueur qui y paraît « devant » ne prouve rien,
     * puisqu'il n'a peut-être rien devant quoi passer. Ici, la rangée tombe en
     * plein dans l'image. */
    const petit = await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) {" +
      "  return m.attributes.layer === 'objects' && m.attributes.width <= 70; })[0];" +
      "if (!t) { return null; }" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top };" +
      "t.save({ statusmarkers: arguments[0] }); return r;",
      PALETTE.map((j) => j.tag).join(","));
    if (petit) {
      reposePetit = petit;
      await dors(2500);
      console.log("\n  petit token « " + petit.nom + " » :");
      await captureZoom(driver, "voir-marqueurs-petit.png",
        [petit.g, -petit.h, 9997500], 46, 8);
    }
    releve("voir-marqueurs.json", vu);
    return 0;
  } finally {
    for (const r of [repose, reposePetit]) {
      if (!r) { continue; }
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }",
        r.id, r.avant).catch(() => {});
      await dors(700);
    }
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- ACCROCHER UN QUAD AU NŒUD DE ROLL20 ----------
 *
 * LA QUESTION QUI DÉCIDE DE TOUTE L'ARCHITECTURE. Le nœud « <id>-markers »
 * survit au déplacement du token et porte déjà la bonne position ET la bonne
 * profondeur. Si nos quads y survivent aussi, ils suivent le token pour rien :
 * pas d'écouteur de position, pas de recalcul, pas une ligne. Sinon il faut
 * tout repositionner à la main.
 *
 * Roll20 RECRÉE ses propres quads à chaque changement. Le risque est qu'il
 * fasse table rase des enfants du nœud — auquel cas il emporterait les nôtres.
 * On le met donc à l'épreuve deux fois : un déplacement, puis un changement de
 * marqueurs, qui est le moment exact où il reconstruit. */
async function colleMarqueur() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);

    const dep = await driver.executeScript(
      "var C = window.Campaign, S = window.MeshScene;" +
      "var t = C.activePage().thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var n = S.getTransformNodeByName(t.id + '-markers');" +
      "if (!n) { return { erreur: 'pas de nœud pour ' + t.id }; }" +
      /* La page n'expose pas le global BABYLON : on prend la classe sur un
       * objet vivant, comme le fait déjà le pont pour la grille. */
      "var Maillage = null;" +
      "for (var i = 0; i < S.meshes.length && !Maillage; i++) {" +
      "  if (S.meshes[i].constructor && S.meshes[i].constructor.CreatePlane) { Maillage = S.meshes[i].constructor; } }" +
      "if (!Maillage) { return { erreur: 'classe Mesh introuvable' }; }" +
      /* Un quad sans matériau : on ne teste pas le rendu ici, on teste la
       * SURVIE. */
      "var q = Maillage.CreatePlane('vttk-essai-survie', 19, S);" +
      "q.parent = n; q.position.x = -12.5 - 22; q.position.y = -12.5; q.position.z = 0;" +
      "q.isPickable = false; q.renderingGroupId = 0; q.alphaIndex = Number.MAX_VALUE;" +
      "q.alwaysSelectAsActiveMesh = true;" +
      "var cat = JSON.parse(C.attributes.token_markers).map(function (k) { return k.tag; });" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, quad: q.uniqueId, noeud: n.uniqueId, pose: cat.slice(0, 2).join(',') };" +
      "t.save({ statusmarkers: r.pose }); return r;");
    if (!dep) { console.log("  aucun token."); return 1; }
    if (dep.erreur) { console.log("  " + dep.erreur); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » ; quad " + dep.quad + " accroché au nœud " + dep.noeud);

    const ETAT =
      "var S = window.MeshScene;" +
      "var q = S.meshes.filter(function (k) { return k.name === 'vttk-essai-survie'; })[0];" +
      "if (!q) { return { vivant: false }; }" +
      "var a = q.getAbsolutePosition();" +
      "return { vivant: true, id: q.uniqueId," +
      "  p: [+a.x.toFixed(2), +a.y.toFixed(2), +a.z.toFixed(2)]," +
      "  parent: q.parent ? q.parent.uniqueId : null," +
      "  jete: q.isDisposed ? q.isDisposed() : null };";

    await dors(2500);
    const t1 = await driver.executeScript(ETAT);
    console.log("  après reconstruction des marqueurs : " + JSON.stringify(t1));

    await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ left: t.attributes.left + 70 });", dep.id);
    await dors(2500);
    const t2 = await driver.executeScript(ETAT);
    console.log("  après un déplacement de +70      : " + JSON.stringify(t2));

    /* Et un second changement de marqueurs, pour être sûr que la première
     * survie n'était pas un coup de chance de calendrier. */
    await driver.executeScript(
      "var C = window.Campaign;" +
      "var t = C.activePage().thegraphics.get(arguments[0]);" +
      "var cat = JSON.parse(C.attributes.token_markers).map(function (k) { return k.tag; });" +
      "t.save({ statusmarkers: cat.slice(0, 4).join(',') });", dep.id);
    await dors(2500);
    const t3 = await driver.executeScript(ETAT);
    console.log("  après un second changement       : " + JSON.stringify(t3));

    const bon = t1.vivant && t2.vivant && t3.vivant;
    console.log("\n  → " + (bon
      ? "NOS QUADS SURVIVENT : on s'accroche au nœud de Roll20, le suivi est gratuit."
      : "nos quads sont emportés : il faudra posséder et repositionner nous-mêmes."));
    if (bon) {
      const dx = t2.p[0] - t1.p[0];
      console.log("    et le déplacement les a suivis : Δx = " + dx.toFixed(2) + " (attendu 70)");
    }
    releve("colle-marqueur.json", { dep, t1, t2, t3, bon });
    return 0;
  } finally {
    await driver.executeScript(
      "var S = window.MeshScene;" +
      "S.meshes.filter(function (k) { return /^vttk-essai/.test(k.name); }).forEach(function (k) { k.dispose(); });" +
      "(S.materials || []).filter(function (k) { return /^vttk-essai/.test(k.name); }).forEach(function (k) { k.dispose(); });")
      .catch(() => {});
    if (repose) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '', left: arguments[2] }); }",
        repose.id, repose.avant, repose.g).catch(() => {});
      await dors(900);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA PROFONDEUR ABSOLUE ----------
 *
 * Lecture seule, rien n'est touché. Un quad posé derrière les tokens ne se
 * verrait pas, et la position locale d'un pictogramme (z = 0 sous son parent)
 * ne dit rien tant qu'on ignore où est le parent. */
async function fondMarqueurs() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = (S.transformNodes || []).filter(function (k) { return /-markers$/.test(k.name); });" +
      "var t = (S.meshes || []).filter(function (k) { return /objects - /.test(k.name); });" +
      "return { noeuds: n.map(function (k) { var a = k.getAbsolutePosition();" +
      "    return { nom: k.name.slice(-30), p: [+a.x.toFixed(2), +a.y.toFixed(2), +a.z.toFixed(2)] }; })," +
      "  maillages: t.slice(0, 14).map(function (k) { var a = k.getAbsolutePosition();" +
      "    return { nom: k.name.slice(-36), z: +a.z.toFixed(2), grp: k.renderingGroupId, ai: k.alphaIndex }; })," +
      "  cam: S.activeCamera ? { nom: S.activeCamera.name, mode: S.activeCamera.mode," +
      "    minZ: S.activeCamera.minZ, maxZ: S.activeCamera.maxZ," +
      "    p: [+S.activeCamera.position.x.toFixed(1), +S.activeCamera.position.y.toFixed(1)," +
      "        +S.activeCamera.position.z.toFixed(1)]," +
      "    cible: S.activeCamera.getTarget ? [+S.activeCamera.getTarget().z.toFixed(1)] : null } : null };");
    console.log("\n  nœuds « -markers » :");
    r.noeuds.forEach((n) => console.log("    " + JSON.stringify(n)));
    console.log("\n  maillages de tokens :");
    r.maillages.forEach((m) => console.log("    " + JSON.stringify(m)));
    console.log("\n  caméra : " + JSON.stringify(r.cam));
    releve("fond-marqueurs.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LA PROFONDEUR, LE GROUPE, ET CE QUI SUIT LE TOKEN ----------
 *
 * La rangée est mesurée : 19 unités de côté, pas de 22, alignée sur le bord
 * droit du token moins 3, et 3 sous son bord haut. Reste ce qui ne se voit pas
 * dans une boîte englobante : la profondeur, le groupe de rendu, le mélange
 * alpha — et surtout comment le pictogramme suit le token qu'on déplace, car
 * c'est ce comportement-là que nos quads devront imiter.
 *
 * On déplace le token de 70 unités, on regarde ce que devient le maillage :
 * s'il garde son identité, il suffira de bouger le nôtre ; s'il est recréé,
 * il faudra se raccrocher à l'événement et non à l'objet. */
async function etatMarqueurs() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const dep = await driver.executeScript(
      "var C = window.Campaign, p = C.activePage();" +
      "var t = p.thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var cat = JSON.parse(C.attributes.token_markers).map(function (m) { return m.tag; });" +
      "var r = { id: t.id, avant: t.attributes.statusmarkers, g: t.attributes.left, h: t.attributes.top," +
      "  pose: cat.slice(0, 2).join(',') };" +
      "t.save({ statusmarkers: r.pose }); return r;");
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    await dors(2500);
    /* LE NŒUD PARENT SURVIT-IL ? C'est toute la question : s'il garde son
     * identité quand le token bouge, on y accroche nos quads et ils suivent
     * sans qu'on écrive une ligne de suivi. S'il est recréé comme ses enfants,
     * il faut repositionner nous-mêmes à chaque changement. */
    const NOEUD =
      "var S = window.MeshScene;" +
      "return (S.transformNodes || []).filter(function (k) { return /-markers$/.test(k.name); })" +
      "  .map(function (k) { var a = k.getAbsolutePosition();" +
      "    return { nom: k.name.slice(-30), id: k.uniqueId," +
      "      p: [+a.x.toFixed(2), +a.y.toFixed(2), +a.z.toFixed(2)]," +
      "      enfants: k.getChildren ? k.getChildren().length : null }; });";
    const noeudsAvant = await driver.executeScript(NOEUD);
    console.log("\n  nœuds parents avant :");
    noeudsAvant.forEach((n) => console.log("    " + JSON.stringify(n)));

    const LIS =
      "var S = window.MeshScene;" +
      "var m = (S.meshes || []).filter(function (k) { return /^(skull|sleepy)$/.test(k.name); });" +
      "return m.map(function (k) {" +
      "  var mt = k.material;" +
      "  return { nom: k.name, id: k.uniqueId," +
      "    p: [+k.position.x.toFixed(2), +k.position.y.toFixed(2), +k.position.z.toFixed(2)]," +
      "    echelle: [k.scaling.x, k.scaling.y]," +
      "    groupeRendu: k.renderingGroupId, alphaIndex: k.alphaIndex," +
      "    choisissable: k.isPickable, gelé: !!k.isWorldMatrixFrozen," +
      "    toujoursActif: !!k.alwaysSelectAsActiveMesh," +
      "    parent: k.parent ? String(k.parent.name).slice(-40) : null," +
      "    materiau: mt ? { nom: mt.name, classe: mt.getClassName && mt.getClassName()," +
      "      alphaMode: mt.alphaMode, needAlpha: mt.needAlphaBlending && mt.needAlphaBlending()," +
      "      backFace: mt.backFaceCulling, zOffset: mt.zOffset," +
      "      textures: (mt.getActiveTextures ? mt.getActiveTextures() : []).map(function (x) {" +
      "        return { nom: String(x.name || '').slice(-60), aAlpha: x.hasAlpha," +
      "          taille: x.getSize ? [x.getSize().width, x.getSize().height] : null }; }) } : null }; });";
    const avant = await driver.executeScript(LIS);
    console.log("\n  état des quads de Roll20 :");
    avant.forEach((m) => console.log("    " + JSON.stringify(m)));

    /* On déplace le token d'une case et on regarde si le maillage survit. */
    await driver.executeScript(
      "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
      "t.save({ left: t.attributes.left + 70 });", dep.id);
    await dors(2500);
    const apres = await driver.executeScript(LIS);
    console.log("\n  après un déplacement de +70 en x :");
    apres.forEach((m) => console.log("    " + JSON.stringify(m)));
    const memes = avant.length === apres.length &&
      avant.every((a, i) => a.id === apres[i].id);
    console.log("\n  identités des quads " + (memes ? "CONSERVÉES : déplacés"
                                                    : "CHANGÉES : recréés"));
    const noeudsApres = await driver.executeScript(NOEUD);
    console.log("\n  nœuds parents après :");
    noeudsApres.forEach((n) => console.log("    " + JSON.stringify(n)));
    const parIdAvant = {}; noeudsAvant.forEach((n) => { parIdAvant[n.nom] = n.id; });
    const survivants = noeudsApres.filter((n) => parIdAvant[n.nom] === n.id).length;
    console.log("\n  " + survivants + " nœud(s) parent(s) sur " + noeudsApres.length +
                " ont gardé leur identité → " +
                (survivants === noeudsApres.length
                  ? "on peut y ACCROCHER nos quads"
                  : "il faudra repositionner nous-mêmes"));
    releve("etat-marqueurs.json", { avant, apres, memes, noeudsAvant, noeudsApres });
    return 0;
  } finally {
    if (repose) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '', left: arguments[2], top: arguments[3] }); }",
        repose.id, repose.avant, repose.g, repose.h).catch(() => {});
      await dors(900);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- QUI DESSINE VRAIMENT LA RANGÉE ----------
 *
 * Les quads « group_marker » sont des ancres désactivées : ils donnent le coin
 * et la taille, pas le dessin. Plutôt que de compter des pixels sur une
 * capture, on balaie TOUTE la scène et on garde ce qui traverse la bande du
 * bord haut du token. Ce qui s'y trouve dessine forcément la rangée, et sa
 * boîte donne le pas au centième — une précision qu'aucune capture ne rendrait.
 *
 * On regarde aussi les sprites et les instances fines : Babylon a trois façons
 * de poser N petits quads identiques, et rien ne dit laquelle Roll20 emploie. */
async function qui() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const dep = await driver.executeScript(
      "var C = window.Campaign, p = C.activePage();" +
      "var t = p.thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var cat = JSON.parse(C.attributes.token_markers).map(function (m) { return m.tag; });" +
      "var r = { id: t.id, nom: t.attributes.name, avant: t.attributes.statusmarkers," +
      "  g: t.attributes.left, h: t.attributes.top, l: t.attributes.width, ht: t.attributes.height," +
      "  pose: cat.slice(0, 4).join(',') };" +
      "t.save({ statusmarkers: r.pose }); return r;");
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » g=" + dep.g + " h=" + dep.h + " " + dep.l + "×" + dep.ht);
    console.log("  quatre marqueurs posés : " + dep.pose);
    await dors(3000);
    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var x0 = arguments[0], x1 = arguments[1], y0 = arguments[2], y1 = arguments[3];" +
      "var out = { croise: [], sprites: [], fines: [] };" +
      "(S.meshes || []).forEach(function (m) {" +
      "  var b; try { b = m.getBoundingInfo().boundingBox; } catch (e) { return; }" +
      "  var mnx = b.minimumWorld.x, mxx = b.maximumWorld.x;" +
      "  var mny = b.minimumWorld.y, mxy = b.maximumWorld.y;" +
      /* Une boîte gigantesque (le plateau, la grille) traverse tout : on ne
       * garde que ce qui a la TAILLE d'un pictogramme. */
      "  if (mxx - mnx > 60 || mxy - mny > 60) { return; }" +
      "  if (mxx < x0 || mnx > x1 || mxy < y0 || mny > y1) { return; }" +
      "  out.croise.push({ nom: m.name.slice(-46)," +
      "    x: [+mnx.toFixed(2), +mxx.toFixed(2)], y: [+mny.toFixed(2), +mxy.toFixed(2)]," +
      "    actif: m.isEnabled(), visible: m.isVisible, sommets: m.getTotalVertices()," +
      "    materiau: m.material ? m.material.name.slice(0, 40) : null }); });" +
      /* Les sprites : Babylon les tient hors de scene.meshes. */
      "(S.spriteManagers || []).forEach(function (sm) {" +
      "  (sm.sprites || []).forEach(function (s) {" +
      "    if (s.position.x < x0 || s.position.x > x1 || s.position.y < y0 || s.position.y > y1) { return; }" +
      "    out.sprites.push({ gestionnaire: sm.name, nom: s.name," +
      "      p: [+s.position.x.toFixed(2), +s.position.y.toFixed(2)]," +
      "      taille: [s.width, s.height], cellule: s.cellIndex, visible: s.isVisible }); }); });" +
      /* Les instances fines : une matrice par instance, on décode la translation. */
      "(S.meshes || []).forEach(function (m) {" +
      "  var n = m.thinInstanceCount || 0; if (!n) { return; }" +
      "  var mat = m.thinInstanceGetWorldMatrices ? m.thinInstanceGetWorldMatrices() : null;" +
      "  if (!mat) { return; }" +
      "  mat.forEach(function (w, i) {" +
      "    var tx = w.m[12], ty = w.m[13];" +
      "    if (tx < x0 || tx > x1 || ty < y0 || ty > y1) { return; }" +
      "    out.fines.push({ maillage: m.name.slice(-40), i: i," +
      "      p: [+tx.toFixed(2), +ty.toFixed(2)]," +
      "      echelle: [+w.m[0].toFixed(2), +w.m[5].toFixed(2)] }); }); });" +
      "out.nMaillages = (S.meshes || []).length;" +
      "return out;",
      dep.g - dep.l / 2 - 30, dep.g + dep.l / 2 + 30,
      -(dep.h - dep.ht / 2) - 30, -(dep.h - dep.ht / 2) + 30);
    console.log("\n  " + r.nMaillages + " maillages en scène ; dans la bande du bord haut :");
    r.croise.forEach((m) => console.log("    " + JSON.stringify(m)));
    console.log("\n  sprites : " + (r.sprites.length ? "" : "aucun"));
    r.sprites.forEach((s) => console.log("    " + JSON.stringify(s)));
    console.log("  instances fines : " + (r.fines.length ? "" : "aucune"));
    r.fines.forEach((f) => console.log("    " + JSON.stringify(f)));
    releve("qui-dessine.json", r);
    return 0;
  } finally {
    if (repose) {
      await driver.executeScript(
        "var t = window.Campaign.activePage().thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }",
        repose.id, repose.avant).catch(() => {});
      await dors(900);
    }
    await oteDocumentMarqueurs(driver);
    await driver.quit().catch(() => {});
  }
}

/* ---------- REGARDER LA RANGÉE ----------
 *
 * L'introspection a donné l'ancre (coin haut-droit) et la taille (19 unités),
 * mais les quads « group_marker » sont désactivés : ce ne sont pas eux qui
 * dessinent. Le pas et le sens de la rangée ne se lisent donc nulle part dans
 * la scène — on pose quatre marqueurs, on cadre le token, et on regarde.
 *
 * La capture est découpée AUTOUR du coin haut-droit du token, calculé depuis la
 * caméra : une capture plein écran à ce zoom ne montrerait qu'une bouillie de
 * 19 pixels. */
async function rangeeMarqueurs() {
  const driver = await ouvre(config().visible === true);
  let repose = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(7000);
    const dep = await driver.executeScript(
      "function mag(nom) { var n = document.querySelectorAll('[data-v-app]');" +
      "  for (var i = 0; i < n.length; i++) { var a = n[i].__vue_app__;" +
      "    var p = a && a.config && a.config.globalProperties && a.config.globalProperties.$pinia;" +
      "    if (p && p._s && p._s.get(nom)) { return p._s.get(nom); } } return null; }" +
      "window.__vtMag = mag;" +
      "var C = window.Campaign, p = C.activePage();" +
      "var t = p.thegraphics.models.filter(function (m) { return m.attributes.layer === 'objects'; })[0];" +
      "if (!t) { return null; }" +
      "var cat = JSON.parse(C.attributes.token_markers).map(function (m) { return m.tag; });" +
      "var quatre = cat.slice(0, 4).join(',');" +
      "var avant = t.attributes.statusmarkers;" +
      "t.save({ statusmarkers: quatre });" +
      "var st = mag('engine');" +
      "return { id: t.id, nom: t.attributes.name, avant: avant, pose: quatre," +
      "  g: t.attributes.left, h: t.attributes.top, l: t.attributes.width, ht: t.attributes.height," +
      "  zoom: st ? st.zoom : null };");
    if (!dep) { console.log("  aucun token."); return 1; }
    repose = dep;
    console.log("\n  token « " + dep.nom + " » g=" + dep.g + " h=" + dep.h + " " + dep.l + "×" + dep.ht);
    console.log("  posé : " + dep.pose);

    /* On centre la caméra sur le coin haut-droit et on grossit : c'est le seul
     * moyen d'avoir assez de pixels pour compter un pas de 19 unités. */
    await driver.executeScript(
      "var st = window.__vtMag('engine'); if (st && st.setZoom) { st.setZoom(250); }");
    await dors(1200);
    const cadre = await driver.executeScript(
      "var S = window.MeshScene, c = S.cameras.filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "var cv = document.querySelector('canvas');" +
      "var r = cv.getBoundingClientRect();" +
      /* monde → écran, caméra orthographique : la formule est déjà établie. */
      "var l = c.orthoLeft, t2 = c.orthoTop, w = c.orthoRight - c.orthoLeft, h = c.orthoTop - c.orthoBottom;" +
      "var cx = c.position.x, cy = c.position.y;" +
      "function ecran(x, y) { return [ (x - (cx + l)) / w * r.width + r.left," +
      "                                ((cy + t2) - y) / h * r.height + r.top ]; }" +
      "var coin = ecran(arguments[0], arguments[1]);" +
      "return { coin: coin, canevas: [r.left, r.top, r.width, r.height]," +
      "  camera: [cx, cy, l, t2, w, h], dpr: window.devicePixelRatio };",
      dep.g + dep.l / 2, -(dep.h - dep.ht / 2));
    console.log("  coin haut-droit à l'écran : " + JSON.stringify(cadre.coin) +
                "  (dpr " + cadre.dpr + ")");
    /* Faire venir le coin au centre de l'écran, pour que le recadrage tombe
     * juste quel que soit l'endroit où la caméra regardait. */
    await driver.executeScript(
      "var S = window.MeshScene, c = S.cameras.filter(function (k) { return /main-camera/.test(k.name); })[0] || S.activeCamera;" +
      "c.position.x = arguments[0]; c.position.y = arguments[1];",
      dep.g + dep.l / 2 - 40, -(dep.h - dep.ht / 2));
    await dors(900);
    await capture(driver, "rangee-marqueurs.png");
    return 0;
  } finally {
    if (repose) {
      await driver.executeScript(
        "var p = window.Campaign.activePage(), t = p.thegraphics.get(arguments[0]);" +
        "if (t) { t.save({ statusmarkers: arguments[1] || '' }); }" +
        "var st = window.__vtMag && window.__vtMag('engine'); if (st && st.setZoom) { st.setZoom(arguments[2] || 100); }",
        repose.id, repose.avant, repose.zoom).catch(() => {});
      await dors(800);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- PESER LE SHADER, ET RIEN QUE LUI ----------
 *
 * Comparer deux sessions ne marche pas : le temps par image dérive tout seul
 * entre 5 et 11 ms selon l'humeur du compositeur, et l'écart cherché est du même
 * ordre. On alterne donc DANS LA MÊME SESSION, toutes les deux secondes, en ne
 * touchant qu'à la VISIBILITÉ du quad — pas au module, qui reposerait la grille
 * et recompilerait. Rien d'autre ne change : la différence entre les fenêtres
 * paires et impaires est le coût du shader, et lui seul. */
async function pese(spec) {
  const [type, zoomStr] = String(spec || "").split(":");
  const zoom = Number(zoomStr) || 100;
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4000);
    if (type) {
      avant = await driver.executeScript(
        "var p = window.Campaign && window.Campaign.activePage && window.Campaign.activePage();" +
        "return p ? (p.attributes || {}).grid_type : null;");
      if (avant && avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4500);
      } else { avant = null; }
    }
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(arguments[0]);", zoom);
    await dors(2500);

    driver.manage().setTimeouts({ script: 60000 });
    const r = await driver.executeAsyncScript(
      "var fini = arguments[arguments.length - 1];" +
      "var S = window.MeshScene;" +
      "var q = (S.meshes||[]).filter(function (m) { return /^vttk-grille-peinte/.test(m.name); })[0];" +
      "if (!q) { fini(null); return; }" +
      "var t0 = performance.now(), dernier = t0, etat = true, jeu = [], courant = [];" +
      "var debut = t0;" +
      "q.isVisible = true;" +
      "function tour() {" +
      "  var t = performance.now();" +
      "  courant.push(t - dernier); dernier = t;" +
      "  if (t - debut >= 2000) {" +
      "    jeu.push({ visible: etat, temps: courant });" +
      "    courant = []; etat = !etat; q.isVisible = etat; debut = t; }" +
      "  if (t - t0 < 24000) { requestAnimationFrame(tour); }" +
      "  else { q.isVisible = true;" +
      "    fini(jeu.map(function (f) {" +
      "      var d = f.temps.slice().sort(function (a, b) { return a - b; });" +
      "      return { visible: f.visible, images: d.length," +
      "        med: Math.round(d[Math.floor(d.length/2)] * 100) / 100," +
      "        p95: Math.round(d[Math.floor(d.length*0.95)] * 100) / 100 }; })); } }" +
      "requestAnimationFrame(tour);");

    if (!r) { console.log("  pas de quad peint — rien à peser."); return 1; }
    console.log("\n  zoom " + zoom + ", fenêtres de 2 s, en alternant la visibilité du quad :\n");
    console.log("    quad     images   médiane    p95");
    r.forEach((f) => {
      console.log("    " + (f.visible ? "VISIBLE " : "caché   ") +
                  String(f.images).padStart(6) + "   " + String(f.med).padStart(7) +
                  "   " + String(f.p95).padStart(6));
    });
    const moy = (v) => { const t = r.filter((f) => f.visible === v).map((f) => f.med);
      return t.reduce((a, b) => a + b, 0) / (t.length || 1); };
    const av = moy(true), sa = moy(false);
    console.log("\n  médiane visible " + Math.round(av * 100) / 100 +
                " ms, caché " + Math.round(sa * 100) / 100 +
                " ms  →  le shader coûte " + Math.round((av - sa) * 100) / 100 + " ms par image");
    releve("pese.json", r);
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA SURFACE D'INJECTION ----------
 *
 * Le coût qu'on paie même quand l'extension ne fait rien. Le manifeste dit
 * « all_frames: true » sur tout app.roll20.net : nos cinq fichiers et la feuille
 * de style sont parsés et exécutés dans CHAQUE cadre de la page — fiches de
 * personnage, notes, tout ce que Roll20 ouvre en iframe. Or le socle exige
 * window.top === window pour qu'un module démarre : aucun de ces cadres ne fera
 * jamais rien. On compte ce qu'on paie pour rien. */
async function cadres() {
  const driver = await ouvre(config().visible === true);
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(6000);
    const r = await driver.executeScript(
      "function decris(w, chemin, out) {" +
      "  var url = '(inaccessible)';" +
      "  try { url = w.location.href; } catch (e) {}" +
      "  out.push({ chemin: chemin, url: String(url).slice(0, 110)," +
      "    memeOrigine: (function () { try { return !!w.document; } catch (e) { return false; } })() });" +
      "  var n = 0; try { n = w.frames.length; } catch (e) {}" +
      "  for (var i = 0; i < n; i++) {" +
      "    try { decris(w.frames[i], chemin + '.' + i, out); } catch (e) {" +
      "      out.push({ chemin: chemin + '.' + i, url: '(refusé)', memeOrigine: false }); } } }" +
      "var out = []; decris(window.top, '0', out); return out;");

    const nos = r.filter((f) => /app\.roll20\.net/.test(f.url));
    console.log("\n  " + r.length + " cadres au total, dont " + nos.length +
                " sur app.roll20.net — c'est-à-dire autant d'injections.\n");
    r.forEach((f) => {
      console.log("   " + f.chemin.padEnd(8) +
                  (/app\.roll20\.net/.test(f.url) ? "★ " : "  ") + f.url);
    });

    const poids = await driver.executeScript(
      "return null;");
    releve("cadres.json", r);
    return 0;
  } finally { await driver.quit().catch(() => {}); }
}

/* ---------- LES REPÈRES : LOCAL, MONDE, ET CE QU'ON DONNE AU SHADER ----------
 *
 * Un maillage Babylon porte des sommets en coordonnées LOCALES et une position
 * qui les emmène dans le MONDE. Tant qu'on clonait sa géométrie, la question ne
 * se posait pas : le clone héritait de sa position, et les deux repères
 * restaient confondus. Un shader, lui, reçoit la position MONDE du fragment —
 * et si on lui donne une trame mesurée en local, tout est décalé de la position
 * du maillage. On relève donc les deux, et l'écart. */
async function reperes(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4500);
      } else { avant = null; }
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: true, cases: 60 }, '*');");
      await dors(2500);
    }
    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes||[]).filter(function (m) {" +
      "  return /Grid-Line-System|tabletop-square-grid/.test(m.name); })[0];" +
      "var q = (S.meshes||[]).filter(function (m) { return /^vttk-grille-peinte/.test(m.name); })[0];" +
      "if (!g) { return null; }" +
      "var p = g.getVerticesData && g.getVerticesData('position');" +
      "var loc = null, i;" +
      "if (p) { loc = [Infinity, Infinity, -Infinity, -Infinity];" +
      "  for (i = 0; i < p.length; i += 3) {" +
      "    loc[0] = Math.min(loc[0], p[i]); loc[2] = Math.max(loc[2], p[i]);" +
      "    loc[1] = Math.min(loc[1], p[i+1]); loc[3] = Math.max(loc[3], p[i+1]); } }" +
      "var b = g.getBoundingInfo().boundingBox;" +
      "var u = q && q.material && q.material._vectors4 ? q.material._vectors4 : null;" +
      "return { lui: { nom: g.name," +
      "  position: [g.position.x, g.position.y, g.position.z]," +
      "  local: loc ? loc.map(function (v) { return Math.round(v * 100) / 100; }) : null," +
      "  monde: [Math.round(b.minimumWorld.x*100)/100, Math.round(b.minimumWorld.y*100)/100," +
      "          Math.round(b.maximumWorld.x*100)/100, Math.round(b.maximumWorld.y*100)/100] }," +
      "  nous: q ? { position: [q.position.x, q.position.y, q.position.z]," +
      "    echelle: [q.scaling.x, q.scaling.y]," +
      "    monde: (function () { var bb = q.getBoundingInfo().boundingBox;" +
      "      return [Math.round(bb.minimumWorld.x), Math.round(bb.minimumWorld.y)," +
      "              Math.round(bb.maximumWorld.x), Math.round(bb.maximumWorld.y)]; })() } : null };");

    if (!r) { console.log("  pas de grille."); return 1; }
    console.log("\n  SON maillage : " + r.lui.nom);
    console.log("    position      " + JSON.stringify(r.lui.position));
    console.log("    sommets (local) " + JSON.stringify(r.lui.local));
    console.log("    boîte (monde)   " + JSON.stringify(r.lui.monde));
    if (r.lui.local) {
      console.log("    → écart local→monde : [" +
                  Math.round((r.lui.monde[0] - r.lui.local[0]) * 100) / 100 + ", " +
                  Math.round((r.lui.monde[1] - r.lui.local[1]) * 100) / 100 + "]");
    }
    if (r.nous) {
      console.log("  NOTRE quad :");
      console.log("    position      " + JSON.stringify(r.nous.position));
      console.log("    échelle       " + JSON.stringify(r.nous.echelle));
      console.log("    boîte (monde) " + JSON.stringify(r.nous.monde));
    } else { console.log("  (pas de quad peint)"); }
    releve("reperes.json", r);
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA VEILLE : CE QUI SE PASSE DANS LA DURÉE ----------
 *
 * « Ça ne rame plus les cinq premières secondes, ça rame juste après. » Aucune
 * moyenne ne peut dire ça : il faut regarder fenêtre par fenêtre, et regarder le
 * TEMPS PAR IMAGE plutôt que le nombre d'images. Treize gels de cent
 * millisecondes en vingt secondes ne font presque pas baisser une moyenne, et
 * rendent une partie injouable.
 *
 * On relève donc, toutes les deux secondes : le temps médian par image, le
 * quatre-vingt-quinzième centile, le pire, et l'état des compteurs du pont. La
 * colonne qui grimpe en même temps que le pire temps désigne le coupable. */
async function veille(spec) {
  const [type, secStr, sans, bouge] = String(spec || "").split(",")[0].split(":");
  const duree = (Number(secStr) || 40) * 1000;
  const remue = String(spec || "").indexOf("bouge") >= 0;
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    /* LE TÉMOIN. Sans l'extension, on mesure ce que Roll20 coûte tout seul
     * pendant qu'il monte sa scène. Sans cette colonne-là, on s'attribue ses
     * à-coups — et on optimise dans le vide. */
    if (sans === "sans") { console.log("  (extension NON posée : témoin)"); }
    else { await poseExtension(driver); }
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    if (type) {
      // Campaign.activePage() n'existe pas dès que la page répond : on laisse
      // la partie s'installer, sinon on lit dans le vide.
      await dors(4000);
      avant = await driver.executeScript(
        "var p = window.Campaign && window.Campaign.activePage && window.Campaign.activePage();" +
        "return p ? (p.attributes || {}).grid_type : null;");
      if (avant && avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4500);
      } else { avant = null; }
    }
    driver.manage().setTimeouts({ script: duree + 30000 });
    console.log("\n  veille de " + (duree / 1000) + " s — " +
                (remue ? "EN REMUANT la vue (zoom et panoramique en continu)."
                       : "on ne touche à rien.") + "\n");
    /* REMUER LA VUE, parce que c'est là que vit l'utilisateur. Une mesure à
     * l'arrêt ne dit rien du coût par image d'un shader qui couvre l'écran, ni
     * de ce que déclenche le magasin de zoom quand il change soixante fois par
     * seconde. On zoome et on déplace sans arrêt, exactement comme une main. */
    /* ÉTEINDRE LA SEULE GRILLE, l'extension restant en place. C'est le témoin
     * qu'il faut pour chiffrer le coût par image du shader : tout le reste est
     * identique, seul le quad disparaît. */
    if (String(spec || "").indexOf("sansgrille") >= 0) {
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: false }, '*');");
      await dors(2000);
      console.log("  (grille ÉTEINTE : témoin du coût du shader)");
    }
    if (remue) {
      await driver.executeScript(
        MAGASIN +
        "var e = __mag('engine'), S = window.MeshScene, c = S.activeCamera;" +
        "var k = 0;" +
        "window.__vtRemue = setInterval(function () {" +
        "  k++;" +
        "  try { e.setZoom(60 + 60 * Math.abs(((k % 40) / 20) - 1)); } catch (x) {}" +
        "  try { c.position.x = 600 * Math.sin(k / 7); c.position.y = 600 * Math.cos(k / 9); } catch (x) {}" +
        "}, 100);");
    }
    const r = await driver.executeAsyncScript(
      "var fini = arguments[arguments.length - 1], duree = arguments[0];" +
      "var t0 = performance.now(), dernier = t0, fenetres = [], courant = [];" +
      "var debutFenetre = t0;" +
      "function lit() { return { grille: window.__vttinkerPoses || 0," +
      "  zoom: window.__vttinkerZoomPoses || 0, etats: window.__vttinkerEtats || 0," +
      "  controles: window.__vttinkerControles || 0 }; }" +
      "var base = lit();" +
      "function tour() {" +
      "  var t = performance.now();" +
      "  courant.push(t - dernier); dernier = t;" +
      "  if (t - debutFenetre >= 2000) {" +
      "    var d = courant.slice().sort(function (a, b) { return a - b; });" +
      "    var c = lit();" +
      /* LE TEMPS BLOQUÉ : la somme de ce que chaque image dépasse les 50 ms.
       * C'est la mesure qui dit ce qu'un utilisateur RESSENT — une seule image à
       * 800 ms se voit, dix images à 20 ms non, et une moyenne les confond.
       * Firefox n'expose pas l'API des tâches longues ; l'écart entre deux
       * images la remplace exactement. */
      "    var bloque = 0;" +
      "    for (var z = 0; z < d.length; z++) { if (d[z] > 50) { bloque += d[z] - 50; } }" +
      "    fenetres.push({ s: Math.round((t - t0) / 1000)," +
      "      med: Math.round(d[Math.floor(d.length / 2)] * 10) / 10," +
      "      p95: Math.round(d[Math.floor(d.length * 0.95)] * 10) / 10," +
      "      pire: Math.round(d[d.length - 1] * 10) / 10, images: d.length," +
      "      bloque: Math.round(bloque)," +
      "      grille: c.grille - base.grille, zoom: c.zoom - base.zoom," +
      "      etats: c.etats - base.etats, controles: c.controles - base.controles });" +
      "    base = c; courant = []; debutFenetre = t; }" +
      "  if (t - t0 < duree) { requestAnimationFrame(tour); } else { fini(fenetres); } }" +
      "requestAnimationFrame(tour);", duree);

    console.log("    s   images   médiane    p95     pire   bloqué  |  poses grille  zoom");
    r.forEach((f) => {
      const alerte = f.pire > 50 ? "  ←" : "";
      console.log("  " + String(f.s).padStart(3) + "   " + String(f.images).padStart(6) +
                  "   " + String(f.med).padStart(6) + "   " + String(f.p95).padStart(6) +
                  "   " + String(f.pire).padStart(6) + "   " + String(f.bloque).padStart(6) +
                  "  |  " + String(f.grille).padStart(10) + String(f.zoom).padStart(7) + alerte);
    });
    const total = r.reduce((a, f) => a + f.bloque, 0);
    console.log("\n  TEMPS BLOQUÉ TOTAL : " + total + " ms sur " + (duree / 1000) + " s");
    releve("veille.json", r);
    return 0;
  } finally {
    await driver.executeScript(
      "if (window.__vtRemue) { clearInterval(window.__vtRemue); window.__vtRemue = null; }")
      .catch(() => {});
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE QUAD SURVIT-IL À UN DÉPLACEMENT ? ----------
 *
 * Un quad qui couvre huit mille pixels n'a que quatre sommets, et Babylon décide
 * de le dessiner ou non sur sa BOÎTE ENGLOBANTE. Si cette boîte est restée celle
 * du plan unité — parce qu'on a coupé sa synchronisation avant de calculer sa
 * matrice —, le tri par frustum le jette dès que la vue s'éloigne, et la grille
 * disparaît en se déplaçant. Aucune mesure au centre ne peut le voir. */
async function frustum(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  const ETAT =
    "var S = window.MeshScene;" +
    "var p = (S.meshes||[]).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
    "if (!p) { return null; }" +
    "var b = p.getBoundingInfo && p.getBoundingInfo().boundingBox;" +
    "var actifs = S.getActiveMeshes ? S.getActiveMeshes() : null;" +
    "var liste = actifs ? (actifs.data || actifs) : [];" +
    "var dedans = false, i;" +
    "for (i = 0; i < (liste.length || 0); i++) { if (liste[i] === p) { dedans = true; } }" +
    "return { nom: p.name," +
    "  boite: b ? [Math.round(b.minimumWorld.x), Math.round(b.minimumWorld.y)," +
    "              Math.round(b.maximumWorld.x), Math.round(b.maximumWorld.y)] : null," +
    "  echelle: [p.scaling.x, p.scaling.y]," +
    "  position: [Math.round(p.position.x), Math.round(p.position.y)]," +
    "  dansFrustum: p.isInFrustum ? !!p.isInFrustum(S.frustumPlanes) : null," +
    "  actif: dedans, toujoursActif: !!p.alwaysSelectAsActiveMesh," +
    "  camera: [Math.round(S.activeCamera.position.x), Math.round(S.activeCamera.position.y)] };";
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4000);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4000);
      } else { avant = null; }
    }
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
      " actif: true, cases: 60 }, '*');");
    await dors(3000);

    for (const [dx, dy] of [[0, 0], [1500, 0], [0, -1500], [4000, 3000], [0, 0]]) {
      await driver.executeScript(
        "var c = window.MeshScene.activeCamera;" +
        "c.position.x = arguments[0]; c.position.y = arguments[1];", dx, dy);
      await dors(900);
      const e = await driver.executeScript(ETAT);
      if (!e) { console.log("  caméra " + dx + "," + dy + " : pas de quad"); continue; }
      console.log("  caméra " + String(dx + "," + dy).padEnd(11) +
                  " boîte " + JSON.stringify(e.boite).padEnd(30) +
                  " frustum " + String(e.dansFrustum).padEnd(6) +
                  " actif " + String(e.actif).padEnd(6) +
                  (e.dansFrustum === false || e.actif === false ? "  ← JETÉ" : ""));
    }
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- PEUT-ON PEINDRE AU LIEU DE TRACER ? ----------
 *
 * Roll20 dessine sa grille CARRÉE dans un shader, sur un quad de six sommets :
 * elle ne coûte rien, et l'utilisateur confirme que ce type ne rame pas. Les
 * quatre autres, on les répète segment par segment — quatre-vingt-dix mille
 * pour un halo moyen. Le remède est évident, reste à savoir s'il est possible :
 * peut-on créer NOTRE shader dans SA scène ? Tout dépend de l'accès aux classes
 * de Babylon, que la page n'expose pas forcément. On relève, on ne suppose pas. */
async function shader(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4000);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4500);
      } else { avant = null; }
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: true, cases: 60 }, '*');");
      await dors(3000);
    }
    const r = await driver.executeScript(
      "var S = window.MeshScene, out = {};" +
      "out.babylonGlobal = typeof window.BABYLON;" +
      "var eng = S.getEngine ? S.getEngine() : null;" +
      "out.moteur = eng ? { classe: eng.constructor && eng.constructor.name," +
      "  webgl: eng.webGLVersion, version: eng.constructor && eng.constructor.Version," +
      "  description: eng.description } : null;" +
      "out.scene = { classe: S.constructor && S.constructor.name, maillages: (S.meshes||[]).length };" +
      /* Le quad carré : c'est LUI le modèle à imiter. */
      "var q = (S.meshes||[]).filter(function (m) { return /tabletop-square-grid/.test(m.name); })[0];" +
      "if (q) { var mt = q.material;" +
      "  out.quad = { classeMesh: q.constructor && q.constructor.name," +
      "    sommets: q.getTotalVertices && q.getTotalVertices()," +
      "    z: q.position && q.position.z, groupe: q.renderingGroupId," +
      "    alphaIndex: q.alphaIndex, pickable: q.isPickable };" +
      "  out.materiau = mt ? { nom: mt.name, classe: mt.constructor && mt.constructor.name," +
      "    aOptions: !!mt._options, options: mt._options ? Object.keys(mt._options) : null," +
      "    uniformes: mt._options && mt._options.uniforms," +
      "    attributs: mt._options && mt._options.attributes," +
      "    sourceEnLigne: !!(mt._shaderPath && (mt._shaderPath.vertexSource || mt._shaderPath.fragmentSource))," +
      "    chemin: mt._shaderPath && (typeof mt._shaderPath === 'string' ? mt._shaderPath : Object.keys(mt._shaderPath))," +
      "    alpha: mt.alpha, needAlphaBlending: mt.needAlphaBlending && mt.needAlphaBlending()," +
      "    floats: mt._floats ? Object.keys(mt._floats) : null," +
      "    couleurs: mt._colors3 ? Object.keys(mt._colors3) : null } : null; }" +
      /* Un LinesMesh, pour savoir où vivent sa couleur et son opacité. */
      "var L = (S.meshes||[]).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      /* NOTRE quad, s'il est posé : c'est la comparaison qui compte. */
      "var n2 = (S.meshes||[]).filter(function (m) { return /^vttk-grille-peinte/.test(m.name); })[0];" +
      "if (n2 && n2.material) { out.nous = { alphaMode: n2.material.alphaMode," +
      "  alpha: n2.material.alpha, blend: n2.material.needAlphaBlending && n2.material.needAlphaBlending()," +
      "  z: n2.position.z, groupe: n2.renderingGroupId, alphaIndex: n2.alphaIndex }; }" +
      "if (L) { out.lignes = { nom: L.name, classe: L.constructor && L.constructor.name," +
      "  alphaMode: L.material && L.material.alphaMode," +
      "  besoinBlend: !!(L.material && L.material.needAlphaBlending && L.material.needAlphaBlending())," +
      "  sansEcritureProfondeur: L.material && L.material.disableDepthWrite," +
      "  alphaMat: L.material && L.material.alpha," +
      "  color: L.color ? [L.color.r, L.color.g, L.color.b] : null, alpha: L.alpha," +
      "  useVertexColor: L.useVertexColor, useVertexAlpha: L.useVertexAlpha," +
      "  z: L.position && L.position.z, groupe: L.renderingGroupId, alphaIndex: L.alphaIndex," +
      "  materiau: L.material ? { nom: L.material.name, classe: L.material.constructor && L.material.constructor.name } : null }; }" +
      /* Les classes atteignables sans le global : par les constructeurs. */
      "var pistes = {};" +
      "if (q) { pistes.meshCtor = q.constructor && q.constructor.name;" +
      "  pistes.meshHasCreatePlane = !!(q.constructor && q.constructor.CreatePlane);" +
      "  var proto = Object.getPrototypeOf(q);" +
      "  pistes.protoChaine = []; var p2 = proto;" +
      "  while (p2 && pistes.protoChaine.length < 8) {" +
      "    pistes.protoChaine.push(p2.constructor && p2.constructor.name); p2 = Object.getPrototypeOf(p2); } }" +
      "if (q && q.material) { pistes.matCtor = q.material.constructor && q.material.constructor.name; }" +
      "out.pistes = pistes;" +
      "out.webpack = typeof window.webpackChunkvtt;" +
      "return out;");
    console.log(JSON.stringify(r, null, 2));
    releve("shader.json", r);
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE VA-TOUT : ON EN CRÉE UN POUR DE VRAI ----------
 *
 * Savoir que les classes sont atteignables ne prouve rien : ce qui compte, c'est
 * qu'un shader À NOUS compile et s'affiche dans SA scène. On en pose un, on
 * demande à Babylon s'il est prêt, et on regarde. Sur une page HEXAGONALE, car
 * c'est là qu'il n'y a pas de quad carré à copier. */
async function essaiShader(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4000);
    avant = await driver.executeScript(
      "return (window.Campaign.activePage().attributes || {}).grid_type;");
    const veut = type || "hex";
    if (avant !== veut) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", veut);
      await dors(4500);
    } else { avant = null; }
    // On éteint notre grille en segments : on veut voir le shader seul.
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', actif: false }, '*');");
    await dors(2000);

    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var g = (S.meshes||[]).filter(function (m) {" +
      "  return /Grid-Line-System|tabletop-square-grid/.test(m.name); })[0];" +
      "if (!g) { return { ok: false, raison: 'pas de grille' }; }" +
      /* Les classes, prises sur des objets vivants. */
      "var Maillage = null, i, m2;" +
      "for (i = 0; i < S.meshes.length; i++) { m2 = S.meshes[i];" +
      "  if (m2.constructor && m2.constructor.CreatePlane) { Maillage = m2.constructor; break; } }" +
      "var Shader = g.material && g.material.constructor;" +
      "if (!Maillage || !Shader) { return { ok: false, raison: 'classes introuvables'," +
      "  maillage: !!Maillage, shader: !!Shader }; }" +
      "var vs = 'precision highp float;' +" +
      "  'attribute vec3 position;' +" +
      "  'uniform mat4 worldViewProjection;' +" +
      "  'uniform mat4 world;' +" +
      "  'varying vec2 vMonde;' +" +
      "  'void main(void){ vec4 w = world * vec4(position,1.0);' +" +
      "  ' vMonde = w.xy; gl_Position = worldViewProjection * vec4(position,1.0); }';" +
      /* Un damier grossier : s'il apparaît, toute la chaîne fonctionne. */
      "var fs = 'precision highp float;' +" +
      "  'varying vec2 vMonde;' +" +
      "  'uniform vec3 couleur; uniform float opacite;' +" +
      "  'void main(void){' +" +
      "  ' vec2 c = floor(vMonde / 140.0);' +" +
      "  ' float d = mod(c.x + c.y, 2.0);' +" +
      "  ' gl_FragColor = vec4(couleur, opacite * d); }';" +
      "var mat, plan, err = null;" +
      "try {" +
      "  mat = new Shader('vttk-essai-shader', S, { vertexSource: vs, fragmentSource: fs }," +
      "    { attributes: ['position']," +
      "      uniforms: ['world','worldViewProjection','couleur','opacite'] });" +
      "  mat.setArray3('couleur', [1, 0.2, 0]);" +
      "  mat.setFloat('opacite', 0.6);" +
      "  mat.backFaceCulling = false;" +
      "  mat.alpha = 0.999;" +
      "  plan = Maillage.CreatePlane('vttk-essai-quad', 1, S);" +
      "  plan.material = mat;" +
      "  plan.scaling.x = 6000; plan.scaling.y = 6000;" +
      "  plan.position.x = g.position.x; plan.position.y = g.position.y;" +
      "  plan.position.z = g.position.z;" +
      "  plan.isPickable = false;" +
      "  plan.renderingGroupId = g.renderingGroupId;" +
      "  plan.alphaIndex = g.alphaIndex;" +
      "} catch (e) { err = String(e && e.message || e); }" +
      "return { ok: !err, erreur: err," +
      "  classeMaillage: Maillage.name, classeShader: Shader.name," +
      "  pret: mat ? !!mat.isReady(plan) : null," +
      "  zGrille: g.position && g.position.z, groupe: g.renderingGroupId," +
      "  alphaIndex: g.alphaIndex };");

    console.log("\n  " + JSON.stringify(r, null, 2));
    if (!r.ok) { return 1; }
    await dors(2500);
    const pret2 = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var p = (S.meshes||[]).filter(function (m) { return m.name === 'vttk-essai-quad'; })[0];" +
      "return p ? { pret: !!p.material.isReady(p), visible: p.isVisible," +
      "  erreurEffet: p.material.getEffect && p.material.getEffect() ?" +
      "    (p.material.getEffect().getCompilationError ? p.material.getEffect().getCompilationError() : null) : 'pas d effet' } : null;");
    console.log("  après deux secondes : " + JSON.stringify(pret2));
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(25);");
    await dors(1500);
    await capture(driver, "essai-shader.png");
    await driver.executeScript(
      "var S = window.MeshScene;" +
      "(S.meshes||[]).slice().forEach(function (m) { if (/^vttk-essai/.test(m.name)) { m.dispose(); } });");
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- CE QUE ÇA COÛTE ----------
 *
 * Le nombre d'images par seconde, module éteint puis allumé, sur la même vue et
 * au même zoom. Et le temps de CONSTRUCTION du maillage, qui est l'autre coût :
 * un pavage refait toutes les secondes et demie hacherait l'affichage même s'il
 * se dessine vite. On mesure les deux, parce qu'ils se corrigent autrement. */
async function cout(spec) {
  const [type, casesStr] = String(spec || "").split(":");
  const cases = Number(casesStr) || 60;
  const driver = await ouvre(config().visible === true);
  let avant = null;
  const IPS =
    "var fini = arguments[arguments.length - 1];" +
    "var n = 0, t0 = performance.now();" +
    "function tour() { n++;" +
    "  if (performance.now() - t0 < 3000) { requestAnimationFrame(tour); }" +
    "  else { fini(Math.round(1000 * n / (performance.now() - t0) * 10) / 10); } }" +
    "requestAnimationFrame(tour);";
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(4000);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4000);
      } else { avant = null; }
    }
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(100);");
    await dors(1500);

    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille', actif: false }, '*');");
    await dors(2500);
    driver.manage().setTimeouts({ script: 20000 });
    const sans = await driver.executeAsyncScript(IPS);

    const t0 = Date.now();
    await driver.executeScript(
      "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
      " actif: true, cases: arguments[0] }, '*');", cases);
    await dors(4000);
    const avec = await driver.executeAsyncScript(IPS);

    const info = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
      "if (!n) { return null; }" +
      "var i = n.getIndices();" +
      "return { segments: i ? i.length / 2 : 0," +
      "  sommets: n.getTotalVertices ? n.getTotalVertices() : 0 };");

    console.log("\n  " + (type || "type courant") + ", " + cases + " cases");
    if (info) { console.log("  " + info.segments + " segments, " + info.sommets + " sommets"); }
    console.log("  images par seconde — sans la grille " + sans + ", avec " + avec +
                "   → " + (sans ? Math.round(100 * avec / sans) : 0) + " %");
    const dit = (await journalDe(driver)).filter((l) => /grille /.test(l)).slice(-1)[0];
    if (dit) { console.log("  " + dit.replace(/\s+/g, " ").trim()); }
    console.log("  (pose complète, message compris : " + (Date.now() - t0) + " ms d'attente)");

    /* COMBIEN DE FOIS SE REFAIT-ELLE ? Un pavage refait toutes les secondes et
     * demie hacherait l'affichage sans faire baisser le compte d'images d'une
     * mesure de trois secondes. C'est le coût qu'aucune moyenne ne montre. */
    /* ON COMPTE LES POSES, PAS LES LIGNES DE JOURNAL. Le guet appelle la pose
     * DIRECTEMENT, sans passer par le module : il n'écrit rien. Compter les
     * lignes rendait donc zéro pendant qu'il reposait la grille deux fois par
     * seconde — recompilation de shader comprise. Le pont expose désormais son
     * compteur, et c'est lui qu'on lit. */
    const poses = () => driver.executeScript("return window.__vttinkerPoses || 0;");
    const nAvant = await poses();
    const ips2 = await driver.executeAsyncScript(IPS);
    await dors(17000);
    const nApres = await poses();
    console.log("  poses de grille en 20 s de repos : " + (nApres - nAvant) +
                (nApres - nAvant > 0 ? "   ← ELLE SE REFAIT TOUTE SEULE" : "   (aucune)") +
                " ; images par seconde pendant ce temps : " + ips2);

    /* LE POINTAGE. Roll20 interroge la scène à chaque mouvement de souris pour
     * savoir ce qu'elle survole. Un maillage « pickable » de deux cent mille
     * segments s'y fait traverser segment par segment : le rendu reste à
     * soixante images par seconde et la page devient injouable dès qu'on bouge
     * la souris. C'est le coût qu'aucune moyenne d'images ne montre. */
    const pointage = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var n = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
      "var o = (S.meshes || []).filter(function (m) { return /Grid-Line-System|tabletop-square/.test(m.name); })[0];" +
      "var t0 = performance.now(), k;" +
      "for (k = 0; k < 20; k++) { S.pick(300 + k, 300 + k); }" +
      "var ms = (performance.now() - t0) / 20;" +
      "return { ms: Math.round(ms * 100) / 100," +
      "  nousPickable: n ? n.isPickable : null, luiPickable: o ? o.isPickable : null," +
      "  nousGele: n ? !!n._isWorldMatrixFrozen : null };");
    console.log("  un pointage souris coûte " + pointage.ms + " ms" +
                (pointage.ms > 8 ? "   ← INJOUABLE" : "") +
                "  (pickable : nous " + pointage.nousPickable +
                ", lui " + pointage.luiPickable + " ; matrice gelée : " + pointage.nousGele + ")");

    /* ET LE ZOOM ARRIÈRE, où toute la trame passe à l'écran d'un coup. */
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(10);");
    await dors(2000);
    const ips10 = await driver.executeAsyncScript(IPS);
    console.log("  images par seconde à 10 % de zoom : " + ips10 +
                (ips10 < 30 ? "   ← ÇA RAME" : ""));
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LES FAMILLES DE DROITES, TELLES QUE ROLL20 LES POSE ----------
 * Pour chaque direction : combien de droites, et surtout la suite de leurs
 * écarts. Un écart régulier, et la période est celle-là ; une suite qui alterne,
 * et il faut un motif. On ne le devine pas, on le lit. */
async function familles(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4000);
      } else { avant = null; }
    }
    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "var lui = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "if (!lui) { return null; }" +
      "var p = lui.getVerticesData('position'), idx = lui.getIndices();" +
      "var fam = {}, ordre = [], k;" +
      "for (k = 0; k < idx.length / 2; k++) {" +
      "  var a = idx[2*k]*3, b = idx[2*k+1]*3;" +
      "  var x0 = p[a], y0 = p[a+1], x1 = p[b], y1 = p[b+1];" +
      "  var ex = x1-x0, ey = y1-y0, L = Math.sqrt(ex*ex+ey*ey);" +
      "  if (L < 1) { continue; }" +
      "  var ux = ex/L, uy = ey/L;" +
      "  if (ux < 0 || (ux === 0 && uy < 0)) { ux = -ux; uy = -uy; }" +
      "  var c = Math.round(ux*2000) + ',' + Math.round(uy*2000);" +
      "  if (!fam[c]) { fam[c] = { ux: ux, uy: uy, off: [], lg: [] }; ordre.push(c); }" +
      "  fam[c].off.push(-uy*x0 + ux*y0); fam[c].lg.push(L); }" +
      "return ordre.map(function (c) { var f = fam[c];" +
      "  var o = f.off.slice().sort(function (a2,b2) { return a2-b2; });" +
      "  var d = [], m = [];" +
      "  for (var i = 0; i < o.length; i++) {" +
      "    if (d.length && o[i] - d[d.length-1] < 0.05) { m[m.length-1]++; continue; }" +
      "    d.push(o[i]); m.push(1); }" +
      "  var ec = [];" +
      "  for (i = 1; i < d.length; i++) { ec.push(Math.round((d[i]-d[i-1])*100)/100); }" +
      "  var lg = f.lg.slice().sort(function (a2,b2){return a2-b2;});" +
      "  return { dir: [Math.round(f.ux*1000)/1000, Math.round(f.uy*1000)/1000]," +
      "    segments: f.off.length, droites: d.length," +
      "    etendue: Math.round((d[d.length-1]-d[0])*100)/100," +
      "    ecarts: ec.slice(0, 14), multiplicites: m.slice(0, 8)," +
      "    longueurMediane: Math.round(lg[Math.floor(lg.length/2)]) }; });");

    if (!r) { console.log("  pas de grille en lignes."); return 1; }
    r.forEach((f, i) => {
      console.log("\n  famille " + (i + 1) + "  direction " + JSON.stringify(f.dir) +
                  "  — " + f.segments + " segments, " + f.droites + " droites distinctes" +
                  ", étendue " + f.etendue + ", longueur médiane " + f.longueurMediane);
      console.log("    écarts     : " + f.ecarts.join("  "));
      console.log("    tracées ×  : " + f.multiplicites.join("  "));
    });
    releve("familles.json", r);
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA DENSITÉ, DEDANS ET DEHORS ----------
 *
 * L'instrument qui manquait, et le seul qui vaille pour les cinq types : la
 * LONGUEUR DE TRAIT posée par unité de surface, mesurée en bandes qui traversent
 * le bord de la page. Dedans c'est Roll20, dehors c'est nous ; si les deux
 * trames sont la même, les bandes portent la même longueur. Une trame deux fois
 * trop dense, une rangée manquante, un halo qui s'arrête : tout s'y voit d'un
 * coup d'oeil, sans rien supposer du réseau. */
async function densite(type) {
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        await dors(4000);
      } else { avant = null; }
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: true, cases: 60 }, '*');");
      await dors(3000);
    }

    const r = await driver.executeScript(
      "var S = window.MeshScene;" +
      "function segs(m) { var p = m.getVerticesData('position'), i = m.getIndices(), o = [], k;" +
      "  if (!p || !i) { return o; }" +
      "  for (k = 0; k < i.length / 2; k++) { var a = i[2*k]*3, b = i[2*k+1]*3;" +
      "    o.push([p[a], p[a+1], p[b], p[b+1]]); } return o; }" +
      "var lui = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "var nous = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
      "if (!lui) { return { la: false }; }" +
      "var A = segs(lui), B = nous ? segs(nous) : [];" +
      "var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, i;" +
      "for (i = 0; i < A.length; i++) { var s = A[i];" +
      "  x0 = Math.min(x0, s[0], s[2]); x1 = Math.max(x1, s[0], s[2]);" +
      "  y0 = Math.min(y0, s[1], s[3]); y1 = Math.max(y1, s[1], s[3]); }" +
      /* Fenêtre en x : le tiers central de la page, pour ne mesurer ni les coins
       * ni les bords latéraux. */
      "var xa = x0 + (x1 - x0) / 3, xb = x0 + 2 * (x1 - x0) / 3;" +
      "var TOUS = A.concat(B), H = 60;" +
      "function longueur(ya, yb) {" +
      "  var L = 0, j, s2, ax, ay, bx, by, t0, t1, f;" +
      "  for (j = 0; j < TOUS.length; j++) { s2 = TOUS[j];" +
      "    ax = s2[0]; ay = s2[1]; bx = s2[2]; by = s2[3];" +
      "    var mx = (ax + bx) / 2;" +
      "    if (ay > by) { var q=ax; ax=bx; bx=q; q=ay; ay=by; by=q; }" +
      "    if (by <= ya || ay >= yb) { continue; }" +
      "    f = function (y) { return by === ay ? 0 : (y - ay) / (by - ay); };" +
      "    t0 = ay >= ya ? 0 : f(ya); t1 = by <= yb ? 1 : f(yb);" +
      /* On ne compte que ce qui est dans la fenêtre en x : on tronque aussi. */
      "    var X0 = ax + (bx - ax) * t0, Y0 = ay + (by - ay) * t0;" +
      "    var X1 = ax + (bx - ax) * t1, Y1 = ay + (by - ay) * t1;" +
      "    var u0 = 0, u1 = 1, dx2 = X1 - X0;" +
      "    if (dx2 === 0) { if (X0 < xa || X0 > xb) { continue; } }" +
      "    else { var ua = (xa - X0) / dx2, ub = (xb - X0) / dx2;" +
      "      u0 = Math.max(0, Math.min(ua, ub)); u1 = Math.min(1, Math.max(ua, ub));" +
      "      if (u1 <= u0) { continue; } }" +
      "    L += Math.sqrt(Math.pow((X1-X0)*(u1-u0), 2) + Math.pow((Y1-Y0)*(u1-u0), 2)); }" +
      "  return Math.round(L); }" +
      "var profil = [], k2;" +
      "for (k2 = -5; k2 <= 5; k2++) { profil.push({ k: k2, L: longueur(y1 + k2 * H, y1 + (k2 + 1) * H) }); }" +
      "return { la: true, page: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)]," +
      "  fenetre: [Math.round(xa), Math.round(xb)], H: H, profil: profil," +
      "  siens: A.length, notres: B.length };");

    if (!r.la) { console.log("  pas de grille en lignes."); return 1; }
    console.log("\n  page " + JSON.stringify(r.page) + " — lui " + r.siens +
                " segments, nous " + r.notres);
    console.log("  longueur de trait par bande de " + r.H + " px, en franchissant le bord HAUT :");
    r.profil.forEach((b) => {
      const ou = b.k < 0 ? "dedans " : "dehors ";
      console.log("    " + ou + String(b.k).padStart(3) + " : " + String(b.L).padStart(6) +
                  "  " + "#".repeat(Math.min(60, Math.round(b.L / 60))));
    });
    const dedans = r.profil.filter((b) => b.k <= -2).map((b) => b.L);
    const dehors = r.profil.filter((b) => b.k >= 1).map((b) => b.L);
    const moy = (t) => t.reduce((a, b) => a + b, 0) / (t.length || 1);
    const md = moy(dedans), mh = moy(dehors);
    console.log("\n  moyenne dedans " + Math.round(md) + ", dehors " + Math.round(mh) +
                "  → " + (md ? Math.round(100 * mh / md) : 0) + " % de la sienne" +
                (md && Math.abs(mh / md - 1) < 0.03 ? "   ✓ même trame" : "   ← ÉCART"));
    const dit = (await journalDe(driver)).filter((l) => /grille /.test(l)).slice(-1)[0];
    if (dit) { console.log("\n  " + dit.replace(/\s+/g, " ").trim()); }
    releve("densite.json", r);
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LE COIN DE PAGE, EN GRAND ----------
 *
 * Les chiffres disent que la trame est en phase à 100 %. L'écran dit autre
 * chose. Quand les deux se contredisent, on ne tranche pas depuis un tableau :
 * on regarde le même endroit, au même grossissement. La vue s'ouvre centrée sur
 * l'origine, c'est-à-dire précisément sur le coin haut-gauche de la page. */
async function coin(spec) {
  const [type, zoomVoulu, camStr, etat] = String(spec || "").split(":");
  const cam = camStr ? camStr.split(",").map(Number) : null;
  const eteint = etat === "off";
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        console.log("  type mis à « " + type + " » (était « " + avant + " »)");
        await dors(4000);
      } else { avant = null; }
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: true, cases: 60 }, '*');");
      await dors(2500);
    }
    /* L'EXPÉRIENCE QUI SÉPARE TOUT. Éteindre le module, puis refaire exactement
     * la même image : ce qui reste au-delà de la carte n'est pas de nous. Sans
     * ce témoin, on attribue à l'extension ce que Roll20 dessine peut-être
     * lui-même — sa page étant souvent plus grande que l'image posée dessus. */
    if (eteint) {
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: false }, '*');");
      await dors(2500);
      const reste = await driver.executeScript(
        "return (window.MeshScene.meshes || [])" +
        "  .filter(function (m) { return /^vttk-grille-/.test(m.name); }).length;");
      console.log("  module ÉTEINT — maillages à nous restants : " + reste);
    }
    const z = Number(zoomVoulu) || 100;
    await driver.executeScript(MAGASIN + "__mag('engine').setZoom(arguments[0]);", z);
    await dors(1500);
    /* LE PANORAMIQUE. Écrire la position de la caméra déplace bel et bien la
     * vue, mais PAS dans le repère des sommets : à caméra (0,0) la vue s'ouvre
     * centrée sur la PAGE, donc l'origine de la caméra est le centre de la page
     * et non celle du monde. On ne suppose plus rien — on passe la position
     * voulue et on relève ce qu'on obtient. */
    if (cam && cam.length === 2 && cam.every(function (v) { return isFinite(v); })) {
      await driver.executeScript(
        "var c = window.MeshScene && window.MeshScene.activeCamera;" +
        "if (c) { c.position.x = arguments[0]; c.position.y = arguments[1]; }",
        cam[0], cam[1]);
      await dors(900);
    }
    await dors(800);
    const etat = await driver.executeScript(
      MAGASIN + "var e = __mag('engine');" +
      "var c = window.MeshScene && window.MeshScene.activeCamera;" +
      "return { zoom: e && e.zoom, camera: c ? [c.position.x, c.position.y] : null," +
      "  ortho: c ? [c.orthoLeft, c.orthoRight, c.orthoTop, c.orthoBottom] : null };");
    console.log("  zoom " + etat.zoom + ", caméra " + JSON.stringify(etat.camera) +
                ", cadre " + JSON.stringify((etat.ortho || []).map(function (v) { return Math.round(v); })));
    await capture(driver, "coin-" + (type || "actuel") + "-" + z +
                  (cam ? "-" + cam.join("_") : "") + (eteint ? "-eteint" : "") + ".png");
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
      console.log("  type de grille remis à « " + avant + " »");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- LA LOUPE ----------
 *
 * Roll20 repositionne sa caméra à chaque image : on ne peut pas cadrer la vue
 * où l'on veut. Alors on ne la cadre pas — on redessine. Les deux géométries
 * sont lues telles quelles et tracées dans un canevas à nous, au grossissement
 * et à l'endroit voulus, SA trame dans une couleur et la NÔTRE dans une autre.
 * Un raccord manquant se voit alors immédiatement, et on sait de qui il est. */
async function loupe(spec) {
  const [type, ouStr, echStr] = String(spec || "").split(":");
  const ou = ouStr || "hg";                 // coin visé : hg, hd, bg, bd
  const ech = Number(echStr) || 2;
  const driver = await ouvre(config().visible === true);
  let avant = null;
  try {
    await poseExtension(driver);
    if (!(await vaALaPartie(driver))) { console.log("La partie ne s'est pas chargée."); return 1; }
    await dors(3500);
    if (type) {
      avant = await driver.executeScript(
        "return (window.Campaign.activePage().attributes || {}).grid_type;");
      if (avant !== type) {
        await driver.executeScript(
          "window.Campaign.activePage().save({ grid_type: arguments[0] });", type);
        console.log("  type mis à « " + type + " » (était « " + avant + " »)");
        await dors(4000);
      } else { avant = null; }
      await driver.executeScript(
        "window.postMessage({ ns: 'vttinker', depuis: 'contenu', type: 'grille'," +
        " actif: true, cases: 60 }, '*');");
      await dors(2500);
    }

    const info = await driver.executeScript(
      "var S = window.MeshScene;" +
      "function segs(m) { var p = m.getVerticesData('position'), i = m.getIndices(), o = [], k;" +
      "  for (k = 0; k < i.length / 2; k++) { var a = i[2*k]*3, b = i[2*k+1]*3;" +
      "    o.push([p[a], p[a+1], p[b], p[b+1]]); } return o; }" +
      "var lui = (S.meshes || []).filter(function (m) { return /Grid-Line-System/.test(m.name); })[0];" +
      "var nous = (S.meshes || []).filter(function (m) { return /^vttk-grille-/.test(m.name); })[0];" +
      "if (!lui || !nous) { return { la: false }; }" +
      "var A = segs(lui), B = segs(nous);" +
      /* LE RECTANGLE DE LA PAGE SE LIT SUR LES SOMMETS, PAS SUR LA BOÎTE
       * ENGLOBANTE. La boîte est en coordonnées MONDE, les sommets en
       * coordonnées locales, et le maillage porte une position : les deux
       * diffèrent d'une trentaine de pixels. L'extension travaille sur les
       * sommets ; la loupe doit en faire autant, sans quoi elle montre le
       * raccord à côté de l'endroit où il se produit. */
      "var px0 = Infinity, px1 = -Infinity, py0 = Infinity, py1 = -Infinity, z;" +
      "for (z = 0; z < A.length; z++) {" +
      "  px0 = Math.min(px0, A[z][0], A[z][2]); px1 = Math.max(px1, A[z][0], A[z][2]);" +
      "  py0 = Math.min(py0, A[z][1], A[z][3]); py1 = Math.max(py1, A[z][1], A[z][3]); }" +
      "var ou = arguments[0], ech = arguments[1];" +
      /* hg/hd/bg/bd = un coin ; h/b/g/d = le MILIEU d'un bord, bien plus lisible
       * qu'un coin où deux raccords se croisent. */
      "var cx, cy;" +
      "if (ou === 'h' || ou === 'b') { cx = (px0 + px1) / 2; cy = ou === 'h' ? py1 : py0; }" +
      "else if (ou === 'g' || ou === 'd') { cy = (py0 + py1) / 2; cx = ou === 'd' ? px1 : px0; }" +
      "else { cx = /d$/.test(ou) ? px1 : px0; cy = /^h/.test(ou) ? py1 : py0; }" +
      "var L = 900, H = 640;" +
      "var c = document.createElement('canvas');" +
      "c.width = L; c.height = H;" +
      "c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#f4f4f4';" +
      "c.id = 'vttk-loupe';" +
      "document.body.appendChild(c);" +
      "var g = c.getContext('2d');" +
      "function X(x) { return L/2 + (x - cx) * ech; }" +
      "function Y(y) { return H/2 - (y - cy) * ech; }" +
      // le rectangle de la page, pour situer le raccord
      "g.strokeStyle = '#c00'; g.lineWidth = 1; g.setLineDash([6, 4]);" +
      "g.strokeRect(X(px0), Y(py1), (px1-px0)*ech, (py1-py0)*ech);" +
      "g.setLineDash([]);" +
      "function trace(T, col, w) { g.strokeStyle = col; g.lineWidth = w; g.beginPath();" +
      "  for (var k = 0; k < T.length; k++) { var s = T[k];" +
      "    var x0 = X(s[0]), y0 = Y(s[1]), x1 = X(s[2]), y1 = Y(s[3]);" +
      "    if ((x0 < -50 && x1 < -50) || (x0 > L+50 && x1 > L+50)) { continue; }" +
      "    if ((y0 < -50 && y1 < -50) || (y0 > H+50 && y1 > H+50)) { continue; }" +
      "    g.moveTo(x0, y0); g.lineTo(x1, y1); }" +
      "  g.stroke(); }" +
      /* LES SOMMETS, marqués. Deux trames en phase partagent leurs sommets au
       * bord : les points se superposent. Déphasées, ils s'entrelacent — et
       * cela, contrairement à des traits, ne se lit pas de travers. */
      "function points(T, col, r2) { g.fillStyle = col;" +
      "  for (var k = 0; k < T.length; k++) { var s = T[k], w2;" +
      "    for (w2 = 0; w2 < 2; w2++) {" +
      "      var xx = X(s[w2 ? 2 : 0]), yy = Y(s[w2 ? 3 : 1]);" +
      "      if (xx < -5 || xx > L + 5 || yy < -5 || yy > H + 5) { continue; }" +
      "      g.beginPath(); g.arc(xx, yy, r2, 0, 6.2832); g.fill(); } } }" +
      "trace(A, 'rgba(0,90,200,0.95)', 2.5);" +   // Roll20 : bleu, épais
      "trace(B, 'rgba(220,60,0,0.95)', 1.2);" +   // nous : orange, fin
      "points(A, 'rgba(0,60,160,0.9)', 4);" +
      "points(B, 'rgba(255,140,0,0.95)', 2);" +
      "g.fillStyle = '#000'; g.font = '13px sans-serif';" +
      "g.fillText('bleu = Roll20   orange = extension   pointillé = bord de page   ×' + ech, 10, 18);" +
      "return { la: true, siens: A.length, notres: B.length, coin: [cx, cy]," +
      "  page: [px0, py0, px1, py1] };", ou, ech);

    if (!info.la) { console.log("  maillage manquant."); return 1; }
    console.log("  page " + JSON.stringify(info.page.map(Math.round)) +
                ", coin visé " + JSON.stringify(info.coin.map(Math.round)) +
                " — " + info.siens + " segments à lui, " + info.notres + " à nous");
    await dors(600);
    await capture(driver, "loupe-" + (type || "actuel") + "-" + ou + ".png");
    await driver.executeScript(
      "var c = document.getElementById('vttk-loupe'); if (c) { c.remove(); }").catch(() => {});
    return 0;
  } finally {
    if (avant) {
      await driver.executeScript(
        "window.Campaign.activePage().save({ grid_type: arguments[0] });", avant).catch(() => {});
      await dors(2500);
      console.log("  type de grille remis à « " + avant + " »");
    }
    await driver.quit().catch(() => {});
  }
}

/* ---------- ---------- */
(async function () {
  const [, , commande, arg] = process.argv;
  const routes = { connexion, session, recon, js: () => js(arg), journal, zoom, slider, reglages,
                   natif, themes, compare, canvas: canvasRecon, grille, types: typesGrille, pavage,
                   jointures: () => jointures(arg), reseau: () => reseau(arg),
                   phase: () => phaseGrille(arg), coin: () => coin(arg),
                   loupe: () => loupe(arg), suivi, derive,
                   densite: () => densite(arg), familles: () => familles(arg),
                   cout: () => cout(arg), shader: () => shader(arg),
                   essai: () => essaiShader(arg), frustum: () => frustum(arg), veille: () => veille(arg), reperes: () => reperes(arg), cadres, pese: () => pese(arg), marqueurs, marqueur: () => poseMarqueur(arg), perso: marqueurPerso, rendu: rendudesMarqueurs, faits: faitsMarqueurs, ui: uiMarqueurs, code: codeMarqueurs, injecte: injecteMarqueur, image: () => imageEtrangere(arg), place: placeMarqueurs, pas: pasMarqueurs, rangee: rangeeMarqueurs, qui, etat: etatMarqueurs, fond: fondMarqueurs, colle: colleMarqueur, voir: voirMarqueurs, menu: menuMarqueurs, choix: choixMarqueurs, poser: poserMarqueur, partage: partageMarqueurs, cycle: cycleDocument, vrai: vraiPartage, fusion: fusionRoll20, tot: fusionTot, outils: barreRoll20, theme: themeRoll20, vttk: sectionVTTK, manque: manqueEtEtiquette, source: sourceMarqueurs, rangee2: rangeeOccupation, reduction: loiReduction, complete: rangeeComplete, nettoie: nettoieTokens, cas: casCapture, reel: etatReel, compteur: compteurRoll20, chiffre: chiffreRoll20, pixels: chiffrePixels, compte: quiCompte, pro: paletteProfessionnelle, gestes: gestesPalette, rame: pourquoiCaRame, cran: coutDunCran, gel: gelDifferre, coupable: quiGele, lourd: zoomLourd, travail: quiTravaille, crans: cranParCran, cible: cibleMolette, long: gesteLong, camseule: cameraSeule, salut: salutParties, audit: auditJoueur, epreuve: epreuveJoueur, bascule: basculeControle, selection: ouEstLaSelection, modes: deuxModes, ecart: ecartDesFenetres, pastilles: deuxPastilles, chat: zoneDeChat, destinataire: ligneDestinataire, largeur: largeurDuChat, aligne: aligneDuChat, emoji: emojisDuChat, fluide: fluiditeDuZoom, ouca: ouEstLeCout, appel: quelAppelCoute, abonne: abonnementCoupable, garde: gardeDeLaCamera, style: styleDeRoll20, surfaces: surfacesVTTK, couche: coucheHorsCarte, cout2: coutDeLaVoie2, preuve: preuveVoie2, dessine: estIlDessine, portee: porteeDuBoard, cadre2: cadreHorsPage, combien: combienDePixels, mord: leLevierMord, surete: sureteDuLevier, nuanceur: litLeNuanceur, ehp: epreuveHorsPage, voile: leVoile, clignote: leClignotement, declenche: quiDeclencheLaReecriture, scenepage: laSceneSurvit, couthp: coutHorsPage, bord: effetDeBord, quiquoi: quiEstQuoi, chaine: chaineDuTampon, acces: accesJoueur, campagnes: listeDesCampagnes, version: versionDeRoll20, essaichat: essaiDuChat, ancien: ancienMoteur, zoomancien: zoomAncien, reperes2: reperesHeritage, commande: quiCommandeLeZoom, pasancien: pasDeLancien, tablo: tableauDeBordAncien, porte: porteDuZoom, borne: borneDeLancien, srczoom: sourceDuZoom, zh: epreuveZoomHerite, boucle: battementAncien, marqh: marqueursHeritage, vue: vueHeritage, loi: loiDeLaRangee, emh: epreuveMarqueursHerites, grh: grilleHeritage, srcg: sourceDeLaGrille, dg: drawGridChezNous, egh: epreuveGrilleHeritee, jg: jumpgateSansRegression, coutp: coutDesPeintres, proto: protocoleApresGardes };
  const f = routes[commande];
  if (!f) {
    console.log("Commandes : connexion | session | recon | js \"<code>\" | journal | zoom");
    process.exit(1);
  }
  if (commande !== "connexion" && commande !== "session" && !config().partie) {
    console.log("Aucune partie connue. Lance d'abord :");
    console.log("  node outils/pilote.js connexion");
    console.log("  node outils/pilote.js session");
    process.exit(1);
  }
  try { process.exit(await f()); }
  catch (e) { console.error("\nÉCHEC : " + e.message); process.exit(1); }
})();
