/* LE PANNEAU DE LA BOÎTE À OUTILS — ce que l'extension FAIT dans cette partie.
 *
 * IL NE FAIT PLUS CE QUE FAIT LA FENÊTRE DE L'EXTENSION. Les deux surfaces
 * étaient le MÊME fichier, chargé une fois dans la fenêtre du navigateur et une
 * fois dans une iframe posée sur la partie : deux endroits pour un seul geste,
 * et aucun des deux n'était le bon. La fenêtre dit désormais si l'extension
 * existe et dans quelle langue elle parle ; ce panneau dit ce qu'elle fait.
 *
 * PLUS AUCUNE DESCRIPTION. Chaque module portait deux lignes d'explication ;
 * elles sont parties du catalogue. Un intitulé qui a besoin d'un paragraphe est
 * un intitulé mal choisi, et une boîte à outils n'est pas un endroit où l'on
 * vient lire — on y vient allumer et éteindre.
 *
 * UNE LIGNE PAR CHOSE : un nom à gauche, un contrôle à droite, un trait. Les
 * réglages d'un module se rangent EN RETRAIT sous lui : l'indentation dit
 * l'appartenance mieux qu'un encadré, et sans rien tracer de plus.
 *
 * L'ÉDITION DES MARQUEURS N'EST PAS ICI, et c'est une décision antérieure qu'on
 * ne défait pas : elle se fait dans la palette, sur la carte, à côté des
 * marqueurs de Roll20 et du jeton qu'on vise. Ce panneau montre ce qu'on a et
 * dit où ça se règle.
 */
/* Le repli vers « chrome » vit dans commun/000-navigateur.js, chargé avant
 * tout le reste. Une règle recopiée à cinq endroits est une règle qui
 * diverge : celle-ci tenait à l'ordre du manifeste, sans que rien ne le dise. */

(function () {
  "use strict";

  var etat = {};
  var corps = null;

  function mot(cle) { return vttMot(cle, vttLangueDe(etat)); }

  function el(balise, classe, texte) {
    var n = document.createElement(balise);
    if (classe) { n.className = classe; }
    if (texte !== undefined) { n.textContent = texte; }
    return n;
  }

  function ecris(cle, val) {
    etat[cle] = val;
    var o = {};
    o[cle] = val;
    try { browser.storage.local.set(o); } catch (e) {}
  }

  /* ---------- LES CONTRÔLES ---------- */

  /* L'interrupteur de Roll20 est un rail, pas une case. La case d'origine reste
   * dans le document, invisible mais atteignable au clavier : c'est elle qui
   * porte l'état, le focus et l'accessibilité — un rail dessiné sans elle ne
   * serait qu'une image. */
  function bascule(coche, surChangement, nom) {
    var b = el("label", "r20-bascule");
    var i = document.createElement("input");
    i.type = "checkbox";
    i.className = "sw";
    i.checked = !!coche;
    if (nom) { i.setAttribute("aria-label", nom); }
    i.setAttribute("aria-checked", String(!!coche));
    i.addEventListener("change", function () { surChangement(i.checked); });
    b.appendChild(i);
    b.appendChild(el("span", "rail"));
    return b;
  }

  /* LE COUPLE DE BORNES SE VÉRIFIE ENSEMBLE, et c'est une correction antérieure
   * qu'on garde. Un minimum au-dessus du maximum n'écrit rien : le pont
   * borne déjà ce qu'il reçoit, mais l'utilisateur, lui, ne verrait qu'un champ
   * qui refuse sa saisie sans un mot. */
  function bornesBonnes(cle, v) {
    if (cle === "zoomMin") { return v < (etat["reg:zoomMax"] || Infinity); }
    if (cle === "zoomMax") { return v > (etat["reg:zoomMin"] || 0); }
    return true;
  }

  /* SANS LES FLÈCHES. Elles sont dessinées par le navigateur, pas par nous, et
   * ne ressemblent à rien de ce que Roll20 emploie — le CSS les retire des deux
   * façons qui existent. Le champ reste un « number » : les flèches sont ce
   * qu'on refuse, pas le clavier numérique ni les bornes.
   *
   * ET LEUR DISPARITION RÈGLE UN AUTRE PROBLÈME. Une flèche tenue appuyée
   * émettait une écriture par cran, chacune diffusée à tous les onglets Roll20
   * ouverts ; et franchir 250 en tirant le maximum faisait basculer le contrôle
   * de zoom de Roll20 à chaque passage, ce qui remet la table à 100 % à chaque
   * fois. On n'écrit plus qu'à « change » et à la sortie du champ : une saisie,
   * une écriture. */
  function nombre(r, surRefus) {
    var c = document.createElement("input");
    c.type = "number";
    c.className = "r20-champ";
    c.value = etat["reg:" + r.cle];
    if (r.min !== undefined) { c.min = r.min; }
    if (r.max !== undefined) { c.max = r.max; }
    if (r.pas !== undefined) { c.step = r.pas; }
    c.setAttribute("aria-label", mot(r.libelle));

    function pose() {
      var v = parseInt(c.value, 10);
      /* UN NOMBRE QUI N'EN EST PAS UN NE S'ÉCRIT PAS. On remet ce qui était là
       * plutôt que d'enregistrer NaN — le pont s'en garde aussi, mais le seul
       * endroit où l'utilisateur peut le corriger, c'est ici. */
      if (!isFinite(v)) { c.value = etat["reg:" + r.cle]; return; }
      if (r.min !== undefined && v < r.min) { v = r.min; }
      if (r.max !== undefined && v > r.max) { v = r.max; }
      c.value = v;
      if (!bornesBonnes(r.cle, v)) {
        c.value = etat["reg:" + r.cle];
        surRefus(mot("reg.bornes"));
        return;
      }
      surRefus("");
      ecris("reg:" + r.cle, v);
    }
    c.addEventListener("change", pose);
    c.addEventListener("blur", pose);
    return c;
  }

  /* ---------- LE DESSIN ---------- */

  /* ---------- LE THÈME ----------
   *
   * ICI, « automatique » VEUT DIRE ROLL20, et pas le navigateur. Ce panneau est
   * posé SUR une partie : suivre la préférence du système serait absurde quand
   * Roll20 est en clair juste derrière, ou l'inverse.
   *
   * Le pont sait déjà lire le thème de Roll20 — il le lit sur sa barre d'outils
   * — et il le dit dans le fragment de l'adresse du cadre : « #clair » ou
   * « #sombre ». On n'a donc rien à mesurer, et surtout rien à mesurer DEPUIS
   * ICI : une page d'extension ne voit pas la page qui la porte.
   *
   * Choisir « jour » ou « nuit » dans la fenêtre de l'extension passe devant :
   * c'est un choix, et un choix ne se fait pas discuter par une détection. */
  function poseTheme() {
    var t = vttThemeDe(etat);
    if (t === "auto") {
      t = (String(location.hash || "").indexOf("sombre") >= 0) ? "nuit" : "jour";
    }
    document.documentElement.setAttribute("data-theme", t);
  }

  function peint() {
    poseTheme();
    corps.textContent = "";

    /* ÉTEINTE, L'EXTENSION N'A RIEN À RÉGLER. Le bouton de la boîte à outils
     * disparaît de lui-même dans ce cas ; si l'on arrive quand même ici — un
     * cadre resté ouvert au moment où l'on éteint —, on le dit plutôt que de
     * montrer des interrupteurs sans effet. */
    if (!vttActif(etat)) {
      corps.appendChild(el("p", "r20-vide", mot("pan.eteint")));
      disHauteur();
      return;
    }

    var refus = el("p", "mq-refus erreur", "");
    refus.hidden = true;
    function dis(texte) {
      refus.textContent = texte;
      refus.hidden = !texte;
    }

    VTT_CATALOGUE.forEach(function (m) {
      var allume = etat["mod:" + m.id] !== false;
      var l = el("div", "r20-ligne");
      l.appendChild(el("span", "r20-nom", mot(m.nom)));
      l.appendChild(bascule(allume, function (v) {
        ecris("mod:" + m.id, v);
        peint();
      }, mot(m.nom)));
      corps.appendChild(l);

      /* LES RÉGLAGES D'UN MODULE ÉTEINT NE S'AFFICHENT PAS. Ils ne commandent
       * rien tant qu'il ne tourne pas, et une liste de champs sans effet est
       * exactement ce qui fait douter que l'interrupteur a marché. */
      if (!allume) { return; }

      (m.reglages || []).forEach(function (r) {
        if (r.type === "nombre") {
          var n = el("div", "r20-ligne r20-fille");
          n.appendChild(el("span", "r20-nom", mot(r.libelle)));
          n.appendChild(nombre(r, dis));
          n.appendChild(el("span", "r20-unite", r.unite ? mot(r.unite) : ""));
          corps.appendChild(n);
          return;
        }
        if (r.type === "marqueurs") {
          var liste = vttMarqueursPropres(etat["reg:" + r.cle] || []);
          var t = el("div", "r20-ligne r20-fille");
          t.appendChild(el("span", "r20-nom", mot(r.libelle)));
          t.appendChild(el("span", "r20-unite marqueurs-compte",
            liste.length ? liste.length + " " + mot("mq.compte") : mot("mq.vide")));
          corps.appendChild(t);
          corps.appendChild(el("p", "r20-note marqueurs-ou", mot("mq.ou")));
        }
      });
    });

    corps.appendChild(refus);
    disHauteur();
  }

  /* ---------- LE STOCKAGE ----------
   *
   * ON ÉCOUTE, et pas seulement au chargement. Le panneau vit dans un cadre qui
   * peut rester ouvert pendant qu'on change la langue ou l'interrupteur général
   * dans la fenêtre de l'extension : sans cette écoute, il continuerait
   * d'afficher l'ancien état sans que rien ne l'explique. */
  function ecoute() {
    try {
      browser.storage.onChanged.addListener(function (ch, zone) {
        if (zone && zone !== "local") { return; }
        var touche = false;
        Object.keys(ch || {}).forEach(function (k) {
          if (k.indexOf("reg:") !== 0 && k.indexOf("mod:") !== 0) { return; }
          etat[k] = ch[k].newValue;
          touche = true;
        });
        if (touche) { peint(); }
      });
    } catch (e) {}
  }

  /* ---------- LE PANNEAU DIT SA HAUTEUR ----------
   *
   * IL FAISAIT 1018 PIXELS POUR 570 DE CONTENU — toute la colonne, du plafond
   * au plancher, avec quatre cent cinquante pixels de blanc sous la dernière
   * ligne. Ceux de Roll20 épousent leur contenu.
   *
   * Un conteneur ne peut pas se régler sur le contenu d'une iframe : c'est une
   * boîte opaque, et sa hauteur intérieure n'est pas lisible du dehors. Le seul
   * qui la connaisse, c'est le document DEDANS — alors il la dit. Le message
   * traverse les origines, comme tous les autres de cette extension.
   *
   * On le redit à chaque dessin : le panneau grandit quand on allume un module
   * et rétrécit quand on l'éteint. */
  /* ON MESURE LE CONTENU, ET SURTOUT PAS LE DOCUMENT.
   *
   * Le premier jet envoyait « documentElement.scrollHeight ». Or <html> fait
   * 100 % du cadre : la mesure valait donc la hauteur du CADRE, c'est-à-dire
   * celle que le message allait fixer. Le panneau s'est effondré de 1018 à
   * 150 pixels en trois allers-retours — chaque message rétrécissant le cadre,
   * donc la mesure suivante, donc le cadre.
   *
   * Une valeur qui dépend de ce qu'elle commande ne se stabilise que par
   * hasard. On mesure le CONTENU, dont la hauteur ne dépend d'aucun cadre. */
  function disHauteur() {
    if (window.parent === window || !corps) { return; }
    try {
      var h = Math.ceil(corps.scrollHeight);
      if (!h) { return; }
      /* VERS ROLL20, NOMMÉMENT. Cette page est un cadre d'extension posé dans
       * la page de Roll20 : sa cible est connue d'avance, et « * » la donnerait
       * à tout hôte qui viendrait à l'encadrer. Le pont, de son côté, exige
       * désormais que ce message vienne de NOTRE origine. */
      window.parent.postMessage({ ns: "vttinker", depuis: "panneau", type: "hauteur", hauteur: h },
                                "https://app.roll20.net");
    } catch (e) {}
  }

  function lis() {
    corps = document.getElementById("corps");
    var def = vttDefauts();
    function recu(r) {
      Object.keys(def).forEach(function (k) {
        etat[k] = (r && r[k] !== undefined) ? r[k] : def[k];
      });
      peint();
      ecoute();
    }
    try { browser.storage.local.get(vttCles()).then(recu, function () { recu(null); }); }
    catch (e) { recu(null); }
  }

  /* LE FRAGMENT PEUT CHANGER SANS QUE LA PAGE RECHARGE : le pont le réécrit
   * quand Roll20 bascule de thème, et un cadre déjà chargé ne redemande rien.
   * « hashchange » est fait pour ça. */
  window.addEventListener("hashchange", function () { peint(); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", lis);
  } else { lis(); }
})();
