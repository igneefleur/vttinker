/* LE PONT — il s'exécute dans le MONDE PRINCIPAL de la page Roll20.
 *
 * C'est le seul endroit d'où l'on voit les objets internes de Roll20. Injecté
 * par le socle, à la demande d'un module, jamais au chargement.
 *
 * ÉCOUTEUR STRICTEMENT PASSIF. Roll20 ouvre et pilote ses propres fenêtres par
 * postMessage : un message inattendu casse son gestionnaire. On ne poste donc
 * rien de spontané, on filtre par ns dès la première ligne, et tout est en
 * try/catch — une exception qui remonte d'ici casse Roll20, pas seulement nous.
 *
 *
 * ===== CE QUI EST ÉTABLI, relevé et mesuré sur une vraie partie =====
 *
 * d20 a quitté window mais vit sur les modèles Backbone (currentPlayer.d20).
 * ATTENTION : sous Jumpgate, d20.engine est une COQUILLE. Il porte encore
 * canvasZoom (figé à 1) et zoomStart, mais AUCUNE fonction de zoom. Cette piste
 * est morte, et il ne faut pas la rouvrir.
 *
 * Le zoom vit à deux endroits, et à deux seulement :
 *   - le magasin Pinia « engine » : état `zoom`, un POURCENTAGE, avec les
 *     actions setZoom, setZoomSilent, stepAdjustZoom ;
 *   - la caméra Babylon « vtt-main-camera », une FreeCamera ORTHOGRAPHIQUE
 *     (mode 1) dans window.MeshScene.
 *
 * LA FORMULE DE LA CAMÉRA EST CONNUE, vérifiée au centième à 10 %, 100 % et
 * 250 % contre un canevas de 617 × 1066 :
 *       orthoTop   =  (hauteur / 2) * (100 / zoom)      orthoBottom = -orthoTop
 *       orthoRight =  (largeur / 2) * (100 / zoom)      orthoLeft   = -orthoRight
 *
 * DEUX BORNAGES, PAS UN, et l'expérience en cinq temps les a séparés :
 *   - setZoom BORNE LUI-MÊME à [10, 250]. Éteindre le contrôle de zoom n'y
 *     change rien : 400 revient à 250 dans les deux cas.
 *   - $patch({zoom:400}) PASSE quand le contrôle est éteint (l'état vaut alors
 *     bien 400), et se fait ramener à 250 quand il est affiché : le slider
 *     Element Plus re-borne son modèle, mais en second seulement.
 *
 * RIEN NE SURVEILLE L'ÉTAT POUR DÉPLACER LA CAMÉRA. Avec l'état à 400, la caméra
 * n'a pas bougé d'un pixel. C'est setZoom qui la déplace, pas un observateur —
 * donc la piloter nous-mêmes ne se bat contre personne.
 *
 * ET LA CAMÉRA ACCEPTE QU'ON L'ÉCRIVE : les quatre plans posés à la main pour
 * 400 % ont tenu six cents millisecondes sans que rien ne les écrase, et la vue
 * a effectivement changé.
 *
 * L'ÉCOUTE PASSIVE a livré le reste : stepAdjustZoom prend un BOOLÉEN (true
 * monte, false descend), la molette appelle setZoomSilent directement, et
 * chaque appelant BORNE AVANT D'APPELER. Tout est détaillé plus bas, au-dessus
 * de l'application.
 *
 * Depuis la console de la PAGE :
 *     __vttinkerEcouteZoom()       écoute passive : zoome à la main, puis relis
 *     __vttinkerTestSlider()       le slider re-borne-t-il ? (état seul)
 *     copy(__vttinkerRecon())      ce que contient la page
 *     copy(__vttinkerGlobales())   les globales de Roll20, avec leur type
 */
(function () {
  "use strict";
  if (window.__vttinkerPont) { return; }   // jamais deux ponts
  window.__vttinkerPont = true;

  var NS = "vttinker";

  /* NOTRE PROPRE ADRESSE, prise à la seule seconde où elle est lisible.
   *
   * Le pont a été injecté depuis moz-extension://<identifiant>/page/pont.js, et
   * cet identifiant change à chaque installation. Il faut le connaître pour
   * ouvrir le panneau des réglages dans un cadre — et la page, elle, n'a aucun
   * accès à browser.runtime. `document.currentScript` ne vaut QUE pendant
   * l'exécution du script : lu plus tard, il est nul. */
  var monAdresse = "";
  try { monAdresse = (document.currentScript && document.currentScript.src) || ""; } catch (e) {}

  function repond(ev, msg) {
    msg.ns = NS;
    msg.depuis = "page";
    /* ON RÉPOND À QUI A DEMANDÉ, ET SEULEMENT LÀ. « * » laissait la réponse
     * lisible par n'importe quelle origine ; l'origine de la demande est la
     * seule qui ait à l'entendre. */
    try {
      var ou = (ev && ev.origin) ? ev.origin : location.origin;
      (ev && ev.source ? ev.source : window).postMessage(msg, ou);
    } catch (e) {}
  }

  /* Tout ce qui sort d'ici traverse postMessage, qui sérialise : une valeur non
   * clonable (fonction, noeud DOM, proxy Vue) ferait échouer TOUT l'envoi. */
  function sur(v) {
    var t = typeof v;
    if (v === null) { return null; }
    if (t === "number" || t === "boolean") { return v; }
    if (t === "string") { return v.length > 160 ? v.slice(0, 160) + "…" : v; }
    if (t === "function") { return "[fn]"; }
    if (t === "undefined") { return "[undefined]"; }
    if (Array.isArray(v)) { return "[array " + v.length + "]"; }
    return "[objet]";
  }

  /* ---------- atteindre les objets de Roll20 ---------- */

  function racinesVue() {
    try { return [].slice.call(document.querySelectorAll("[data-v-app]")); } catch (e) { return []; }
  }

  /* ---------- LE PINIA SE RETIENT ----------
   *
   * `magasin()` refaisait un querySelectorAll sur un sélecteur d'ATTRIBUT à
   * chaque appel — donc un parcours complet de l'arbre de Roll20, qu'aucun index
   * du navigateur n'accélère. Et il est appelé sur le pire chemin qui soit :
   * l'écouteur de molette, posé sur window en NON PASSIF et en capture, c'est-à-
   * dire celui qui retient le navigateur avant qu'il ne compose quoi que ce soit
   * — pour TOUT défilement de la page, le tchat et le journal compris.
   *
   * Les douze applications Vue partagent le même Pinia, et ce Pinia ne change
   * pas : on le retient. `_s.get(nom)` est alors une simple lecture de Map. On
   * ne retient PAS le magasin lui-même, que Roll20 peut recréer.
   *
   * Et on revalide : si Roll20 remonte ses applications sur un Pinia neuf, le
   * nôtre cesserait de répondre en silence. Un magasin introuvable suffit à
   * jeter le cache et à repartir du document. */
  var pinia = null;

  function piniaDe() {
    if (pinia && pinia._s && pinia._s.get) { return pinia; }
    var r = racinesVue();
    for (var i = 0; i < r.length; i++) {
      try {
        var app = r[i].__vue_app__;
        var p = app && app.config && app.config.globalProperties && app.config.globalProperties.$pinia;
        if (p && p._s && p._s.get) { pinia = p; return p; }
      } catch (e) {}
    }
    pinia = null;
    return null;
  }

  function magasin(nom) {
    var p = piniaDe();
    if (!p) { return null; }
    var s = null;
    try { s = p._s.get(nom); } catch (e) {}
    if (s) { return s; }
    // Le Pinia retenu ne connaît plus ce magasin : il a été remplacé.
    pinia = null;
    p = piniaDe();
    if (!p) { return null; }
    try { return p._s.get(nom) || null; } catch (e) { return null; }
  }

  function cameraTable() {
    try {
      var cams = (window.MeshScene && window.MeshScene.cameras) || [];
      for (var i = 0; i < cams.length; i++) {
        if (String(cams[i].name || "") === "vtt-main-camera") { return cams[i]; }
      }
      return cams[0] || null;
    } catch (e) { return null; }
  }

  function toile() {
    try { return document.getElementById("babylonCanvas"); } catch (e) { return null; }
  }

  /* LE GESTE A-T-IL LIEU SUR LE PLATEAU ? On remonte les parents plutôt que
   * d'appeler Node.contains : le banc monte un DOM réduit, et un code qui
   * n'emploie que parentNode s'y éprouve tel quel — c'est le même parti que
   * `dansLaBarre` et `estDedans` plus bas.
   *
   * Sans toile, on répond OUI : c'est l'état d'avant le montage de la scène, et
   * refuser tout à ce moment-là éteindrait le module au lieu de le protéger. */
  function surLaToile(n) {
    var cv = toile();
    if (!cv) { return true; }
    while (n) { if (n === cv) { return true; } n = n.parentNode; }
    return false;
  }

  /* ---------- l'arbre des composants Vue ----------
   * __vueParentComponent et __vnode ne sont posés sur les éléments qu'en build
   * de développement : les deux tentatives précédentes n'ont donc rien rendu.
   * En production, le seul chemin est l'application elle-même — app._instance —
   * puis la descente de son subTree, où chaque vnode de composant porte son
   * instance. C'est plus long à écrire et ça marche partout.
   *
   * ON GARDE TOUTES LES PROPS des composants du zoom : la boîte est petite, et
   * c'est justement le nom du réglage qu'on ne sait pas deviner. Si un min/max
   * traîne quelque part, il sera là. */
  function litInstance(inst, sortie) {
    if (!inst || sortie.length > 100) { return; }
    var fiche = { composant: "?", props: {}, setup: {} };
    try { fiche.composant = (inst.type && (inst.type.name || inst.type.__name)) || "?"; } catch (e) {}
    ["props", "setupState"].forEach(function (quoi) {
      var bag = null;
      try { bag = inst[quoi]; } catch (e) {}
      if (!bag || typeof bag !== "object") { return; }
      var ks = [];
      try { ks = Object.keys(bag); } catch (e) { return; }
      ks.slice(0, 40).forEach(function (k) {
        var v;
        try { v = bag[k]; } catch (e) { return; }
        if (v && typeof v === "object" && "value" in v) { try { v = v.value; } catch (e) {} }
        fiche[quoi === "props" ? "props" : "setup"][k] = sur(v);
      });
    });
    if (Object.keys(fiche.props).length || Object.keys(fiche.setup).length) { sortie.push(fiche); }
  }

  function marche(vnode, prof, sortie) {
    if (!vnode || typeof vnode !== "object" || prof > 14 || sortie.length > 100) { return; }
    var comp = null;
    try { comp = vnode.component; } catch (e) {}
    if (comp) {
      litInstance(comp, sortie);
      try { marche(comp.subTree, prof + 1, sortie); } catch (e) {}
    }
    var enfants = null;
    try { enfants = vnode.children; } catch (e) {}
    if (Array.isArray(enfants)) {
      enfants.forEach(function (c) { marche(c, prof + 1, sortie); });
    }
    var dyn = null;
    try { dyn = vnode.dynamicChildren; } catch (e) {}
    if (Array.isArray(dyn)) { dyn.forEach(function (c) { marche(c, prof + 1, sortie); }); }
  }

  function composantsZoom() {
    var out = [];
    var n = null;
    try { n = document.getElementById("vm_zoom_buttons"); } catch (e) {}
    if (!n) { return out; }
    var app = null;
    try { app = n.__vue_app__; } catch (e) {}
    if (!app) { return out; }
    try {
      var racine = app._instance;
      if (racine) { litInstance(racine, out); marche(racine.subTree, 0, out); }
    } catch (e) {}
    return out;
  }

  /* ---------- l'état du zoom, vu de partout à la fois ---------- */
  function etatZoom() {
    var o = {};
    var st = magasin("engine");
    try { o.pinia_engine_zoom = st ? st.zoom : "[magasin absent]"; } catch (e) {}
    try { o.window_zoomLevel = window.zoomLevel; } catch (e) {}
    try { o.window_dpi = window.dpi; } catch (e) {}
    var pref = magasin("preference");
    try { o.preference_zoom = pref ? JSON.parse(JSON.stringify(pref.zoom)) : null; } catch (e) {}
    var c = cameraTable(), t = toile();
    if (c && t) {
      o.camera = { nom: c.name, classe: (c.getClassName && c.getClassName()) || "", mode: c.mode,
                   orthoTop: c.orthoTop, orthoRight: c.orthoRight };
      o.toile = { w: t.width, h: t.height };
      // La formule, recalculée en direct : si elle cesse de tenir un jour, on le
      // verra ici plutôt qu'en cassant la vue de quelqu'un.
      try {
        var z = st ? st.zoom : null;
        if (z) {
          o.formule = { orthoTopAttendu: (t.height / 2) * (100 / z),
                        orthoRightAttendu: (t.width / 2) * (100 / z),
                        tient: Math.abs(c.orthoTop - (t.height / 2) * (100 / z)) < 0.5 };
        }
      } catch (e) {}
    }
    return o;
  }

  /* d20 reste inventorié, mais court : sa coquille est vide côté zoom, et c'est
   * une information à conserver pour ne pas y revenir. */
  function d20Bref() {
    var D = null;
    try { D = window.d20 || (window.currentPlayer && window.currentPlayer.d20) || null; } catch (e) {}
    if (!D) { return { trouve: false }; }
    var o = { trouve: true, chemin: window.d20 ? "window.d20" : "currentPlayer.d20" };
    try {
      var E = D.engine;
      o.engine = !!E;
      if (E) { o.canvasZoom = E.canvasZoom; o.fonctionsZoom = Object.keys(E).filter(function (k) { return typeof E[k] === "function" && /zoom/i.test(k); }); }
    } catch (e) {}
    return o;
  }

  function globales() {
    var std = {};
    try {
      var f = document.createElement("iframe");
      f.style.display = "none";
      document.documentElement.appendChild(f);
      Object.keys(f.contentWindow).forEach(function (k) { std[k] = true; });
      f.remove();
    } catch (e) { return ["[iframe refusée]"]; }
    var out = [];
    Object.keys(window).forEach(function (k) {
      if (std[k] || /^\d+$/.test(k)) { return; }
      var t = "?";
      try { t = typeof window[k]; } catch (e) { t = "[inaccessible]"; }
      out.push(k + " : " + t);
    });
    return out.slice(0, 400);
  }

  function recon() {
    return {
      version: 5,
      url: location.pathname,
      etatZoom: etatZoom(),
      composantsZoom: composantsZoom(),
      d20: d20Bref()
    };
  }

  window.__vttinkerRecon = function () {
    var r = recon();
    try { console.log("%c[VTTinker] reconnaissance v5", "color:#d72f2f;font-weight:700", r); } catch (e) {}
    return JSON.stringify(r);
  };
  window.__vttinkerGlobales = function () { return JSON.stringify(globales()); };

  /* ---------- ÉCOUTE PASSIVE ----------
   * On ne devine pas la signature de stepAdjustZoom : on regarde Roll20
   * l'appeler pour de vrai, pendant que quelqu'un zoome à la main.
   *
   * CETTE FONCTION N'ÉCRIT RIEN. Ni caméra, ni état, ni réglage. $onAction de
   * Pinia est un observateur, la molette est écoutée en « passive », et rien
   * n'est empêché ni modifié. C'est la seule conduite tenable après un plantage
   * dont on ignore la cause : on n'ajoute pas une variable inconnue à une
   * enquête qui en a déjà une.
   *
   * Elle relève, pour chaque appel : l'action, ses arguments, le zoom AVANT et
   * APRÈS, et où en est la caméra. La molette est notée séparément, parce que
   * rien ne dit qu'elle passe par le magasin — elle pourrait viser la caméra
   * directement, et ce serait une information à elle seule. */
  window.__vttinkerEcouteZoom = function (secondes) {
    var st = magasin("engine");
    if (!st) { console.warn("[VTTinker] magasin « engine » introuvable"); return "magasin introuvable"; }
    if (window.__vttinkerEcouteEnCours) { return "écoute déjà en cours"; }

    var duree = (secondes || 40) * 1000;
    var journal = { actions: [], molette: [], depart: st.zoom };
    var arrete = null;

    function publie() {
      try { window.__vttinkerEcouteZoomResultat = JSON.stringify(journal); } catch (e) {}
    }

    try {
      arrete = st.$onAction(function (ctx) {
        var e = { action: ctx.name, args: [], avant: st.zoom };
        try { e.args = [].slice.call(ctx.args).map(sur); } catch (er) {}
        ctx.after(function (r) {
          e.apres = st.zoom;
          e.retour = sur(r);
          var c = cameraTable();
          if (c) { try { e.orthoTop = c.orthoTop; } catch (er) {} }
          if (journal.actions.length < 200) { journal.actions.push(e); }
          publie();
        });
        ctx.onError(function (err) {
          e.erreur = String((err && err.message) || err).slice(0, 160);
          if (journal.actions.length < 200) { journal.actions.push(e); }
          publie();
        });
      });
    } catch (e) { return "impossible de s'abonner : " + String(e).slice(0, 120); }

    // La molette, en PASSIF : on écoute, on n'empêche rien.
    var t = toile();
    function surMolette(ev) {
      if (journal.molette.length >= 60) { return; }
      var c = cameraTable();
      journal.molette.push({ deltaY: ev.deltaY, deltaMode: ev.deltaMode, ctrl: ev.ctrlKey,
                             zoom: st.zoom, orthoTop: c ? c.orthoTop : null });
      publie();
    }
    if (t) { try { t.addEventListener("wheel", surMolette, { passive: true, capture: true }); } catch (e) {} }

    window.__vttinkerEcouteEnCours = true;
    setTimeout(function () {
      window.__vttinkerEcouteEnCours = false;
      try { if (arrete) { arrete(); } } catch (e) {}
      if (t) { try { t.removeEventListener("wheel", surMolette, true); } catch (e) {} }
      journal.fin = st.zoom;
      publie();
      try {
        console.log("%c[VTTinker] écoute terminée — " + journal.actions.length + " actions, " +
                    journal.molette.length + " crans de molette",
                    "color:#d72f2f;font-weight:700", journal);
        console.log("copy(__vttinkerEcouteZoomResultat)");
      } catch (e) {}
    }, duree);

    return "écoute pendant " + (duree / 1000) + " s — zoome à la main : molette, boutons + et −, " +
           "et le slider. Puis : copy(__vttinkerEcouteZoomResultat)";
  };

  /* ---------- LE SLIDER RE-BORNE-T-IL, ET ENTRAÎNE-T-IL LA CAMÉRA ? ----------
   * RÉPONSE MESURÉE, ET ELLE EST LA PIRE DES DEUX : oui aux deux. Contrôle
   * affiché, un état posé à 400 revient à 250 en MOINS DE SOIXANTE
   * MILLISECONDES, et la caméra suit — elle est passée de 533 (100 %) à 213,2
   * (250 %). Le slider ne se contente donc pas de corriger le nombre : il
   * applique sa correction à la vue.
   *
   * C'est pour ça que le module ne peut pas tenir au-delà de 250 % tant que le
   * contrôle de zoom de Roll20 est visible, et c'est pour ça qu'il le DIT au
   * lieu d'éteindre ce réglage dans le dos de qui l'a choisi.
   *
   * La sonde reste : le jour où Roll20 change son contrôle, elle redira en deux
   * secondes ce qu'il en est.
   *
   * ELLE N'ÉCRIT PAS LA CAMÉRA. Elle ne touche que l'état, et le remet par le
   * chemin normal. */
  window.__vttinkerTestSlider = function () {
    var st = magasin("engine"), pref = magasin("preference");
    if (!st) { return "magasin introuvable"; }
    var depart = st.zoom, c0 = cameraTable();
    var res = { depart: depart, orthoTopDepart: c0 ? c0.orthoTop : null, pas: [] };
    try { res.interfaceEnabled = pref && pref.zoom ? pref.zoom.interfaceEnabled : null; } catch (e) {}

    try { st.$patch({ zoom: 400 }); } catch (e) { return "patch refusé : " + String(e).slice(0, 120); }

    [60, 300, 900, 1800].forEach(function (ms) {
      setTimeout(function () {
        var c = cameraTable();
        res.pas.push({ apres_ms: ms, pinia: st.zoom, orthoTop: c ? c.orthoTop : null });
        if (ms !== 1800) { return; }
        try { st.setZoom(depart); } catch (e) {}
        setTimeout(function () {
          res.rendu = st.zoom;
          var cf = cameraTable();
          res.renduOrthoTop = cf ? cf.orthoTop : null;
          window.__vttinkerTestSliderResultat = JSON.stringify(res);
          try {
            console.log("%c[VTTinker] test du slider — zoom remis à " + res.rendu,
                        "color:#d72f2f;font-weight:700", res);
            console.log("copy(__vttinkerTestSliderResultat)");
          } catch (e) {}
        }, 500);
      }, ms);
    });

    return "test en cours, ~2,5 s — puis : copy(__vttinkerTestSliderResultat)";
  };

  /* ============================================================
   *                    L'APPLICATION DES BORNES
   * ============================================================
   *
   * CE QUE L'ÉCOUTE A MONTRÉ, et qui décide de tout ce qui suit.
   *
   * Trois entrées, une seule sortie. La molette, les boutons + / − et le slider
   * finissent tous les trois dans setZoomSilent(valeurAbsolue), qui arrondit à
   * l'entier et déplace la caméra. Les enveloppes sont :
   *   - BOUTONS : stepAdjustZoom(booléen) -> setZoom(v) -> setZoomSilent(v).
   *     LE BOOLÉEN EST LE SENS : true monte, false descend. Le pas est de 10, et
   *     il arrondit sur les dizaines (137 -> 140 -> 150).
   *   - MOLETTE : appelle setZoomSilent DIRECTEMENT, avec un pas LINÉAIRE de
   *     12,875 par cran de deltaY = ±102.
   *   - SLIDER : passe par setZoom.
   *
   * ET SURTOUT : CHAQUE APPELANT BORNE AVANT D'APPELER. La molette, arrivée à
   * 241,625, ne demande pas 254,5 mais exactement 250 ; arrivée à 18,25, elle
   * demande exactement 10. Puis, collée à la borne, ELLE N'APPELLE PLUS DU TOUT.
   * C'est pour ça que remplacer setZoom ne suffit pas : la molette ne passe pas
   * par lui, et le slider ne peut de toute façon pas produire une valeur hors de
   * sa propre plage.
   *
   * D'OÙ LA FORME DU MODULE : on ne remplace pas le zoom de Roll20, ON LE
   * PROLONGE AUX EXTRÉMITÉS. Entre 10 et 250 Roll20 fait tout son travail, sans
   * qu'on touche à rien — y compris ce qu'il fait et qu'on ne voit pas. On ne
   * prend la main que là où il refuse d'aller.
   *
   * LE PAS DU PROLONGEMENT EST GÉOMÉTRIQUE, ET SON TAUX EST CELUI DE ROLL20 À
   * LA BORNE. C'est le seul réglage qui ne se sente pas.
   *
   * Un pas fixe ne marche à aucun des deux bouts : 12,875 à 800 % demanderait
   * soixante crans pour doubler, et 10 en dessous de 10 % ferait passer sous
   * zéro du premier coup. Un pas proportionnel quelconque, lui, se voit à la
   * jonction : à 13 % du zoom, franchir 250 faisait sauter de 33 d'un coup là
   * où Roll20 venait d'avancer de 10 — un banc d'essai l'a relevé avant qu'un
   * joueur ne le sente.
   *
   * On prend donc, pour chaque commande, le taux qui vaut EXACTEMENT son pas
   * natif à 250 % : 10/250 pour les boutons, 12,875/250 pour la molette. Le
   * premier pas au-delà de la borne est donc identique au dernier pas en deçà,
   * et l'accélération qui suit est celle qu'on attend d'un zoom. En dessous de
   * 10 %, le même calcul tombe sous l'unité et le plancher d'un point prend le
   * relais — c'est le plus fin que permette un zoom rangé en entier.
   */

  var NATIF_MIN = 10, NATIF_MAX = 250;
  var PAS_BOUTON = 10 / 250;        // le pas des boutons + / − à la borne haute
  var PAS_MOLETTE = 12.875 / 250;   // celui d'un cran de molette à la même borne
  var natif = null;      // les trois actions d'origine, capturées une seule fois
  var bornes = null;     // { min, max } — nul quand le module est éteint
  var molette = null;    // l'écouteur posé sur la fenêtre

  function pasDe(z, taux) { return Math.max(1, Math.round(z * taux)); }

  /* ============================================================
   *   AU-DELÀ DE 250 %, ON NE FAIT RECALCULER ROLL20 QU'UNE FOIS
   * ============================================================
   *
   * MESURÉ, ET C'EST BRUTAL. Sur une vraie partie, en chronométrant les trames
   * autour de chaque cran de molette :
   *
   *     dans sa plage (120 → 240)   9 à 29 ms par cran
   *     au-delà       (300 → 500)   537 à 852 ms par cran
   *     à cheval sur 250            jusqu'à 2 209 ms
   *
   * et la scène passe de ONZE à QUARANTE-SIX textures. Au-delà de sa borne,
   * Roll20 refait son fond à la résolution demandée, et il le refait À CHAQUE
   * CRAN. Dix crans de molette, c'est dix reconstructions — cinq secondes de
   * gel pour un geste d'une seconde. Ce n'est pas notre code qui coûte : un
   * cran, chronométré ligne à ligne, ne fait pas une milliseconde de travail
   * synchrone. C'est ce que Roll20 fait ENSUITE.
   *
   * ON NE PEUT PAS L'EN EMPÊCHER, MAIS ON PEUT NE LE LUI DEMANDER QU'UNE FOIS.
   * Un geste de molette, c'est une intention unique — « va à 500 » — exprimée en
   * dix crans. On sépare donc les deux moitiés de la pose :
   *
   *   · LA CAMÉRA, tout de suite, à chaque cran. C'est elle qui donne l'image,
   *     et elle coûte zéro : l'écriture de quatre nombres. Le zoom reste donc
   *     parfaitement fluide sous la molette.
   *   · SON MAGASIN, une seule fois, quand la molette s'arrête. C'est lui qui
   *     déclenche la reconstruction, et il n'y en a plus qu'une.
   *
   * Le fond est donc rendu à l'ancienne résolution pendant le geste, et net dès
   * qu'on relâche — le compromis ordinaire de tout zoom continu, et sans
   * commune mesure avec une demi-seconde de gel par cran.
   *
   * DANS SA PLAGE, RIEN DE TOUT CELA : c'est lui qui tient le zoom, il le fait
   * bien et pour trois fois rien. Ce délai ne s'applique qu'au-delà de sa
   * borne, là où il n'a jamais prévu d'aller. */
  /* HORS DE SA PLAGE, ON NE LE PRÉVIENT JAMAIS. C'est un choix de l'auteur,
   * pris sur des mesures, et il faut dire les deux termes.
   *
   * MESURÉ SUR UNE VRAIE PARTIE, en chronométrant les trames :
   *
   *     dans sa plage (10–250)            9 à 29 ms par cran
   *     au-delà, caméra seule             6 ms par trame, 1754 % atteint en 3 s
   *     au-delà, dès qu'on écrit chez lui 600 à 2 000 ms, À CHAQUE ÉCRITURE
   *
   * Ce qui coûte n'est pas notre code — un cran fait zéro à une milliseconde de
   * travail synchrone — mais le fait que Roll20 APPRENNE le zoom : il refait
   * alors son fond à la résolution demandée. Au-delà de sa borne, il ne sait pas
   * le faire pour moins d'une seconde.
   *
   * Un premier jet différait cette écriture à la fin du geste. C'était mieux —
   * une reconstruction au lieu de dix — mais il en restait une par salve de
   * molette, et l'auteur l'a sentie une seconde fois. On la supprime donc tout
   * à fait : au-delà de 250 %, la caméra seule fait l'image, et le magasin de
   * Roll20 garde la dernière valeur qu'il ait comprise.
   *
   * CE QU'ON PERD, ET IL FAUT LE SAVOIR : son fond reste rendu à cette
   * dernière résolution, donc l'image est floue en proportion du dépassement.
   * Les tokens, la grille et nos marqueurs, eux, restent nets — ce sont des
   * maillages, ils suivent la caméra. Le choix a été posé à l'auteur, qui a
   * préféré la fluidité constante au piqué payé d'une seconde de gel.
   *
   * ET IL NE LA REPREND PAS : mesuré, la caméra reste où on l'a mise deux
   * secondes plus tard, et après un clic sur le plateau. Rien de Roll20 ne
   * recalcule ses bornes orthographiques tant qu'on ne lui demande pas un zoom. */
  var zoomHorsPlage = null;   // notre zoom, celui que Roll20 ignore ; nul dans sa plage

  /* ---------- LES COMPTEURS ----------
   *
   * « Mon PC rame quand j'active le zoom. » On ne répond pas à ça en relisant
   * le code : on compte. Chaque chemin chaud incrémente un entier, et une sonde
   * lit l'objet à une seconde d'intervalle pour obtenir des fréquences.
   *
   * Le coût est celui d'un « ++ » — pas de date, pas de tableau, pas de chaîne.
   * Un compteur qui coûterait quelque chose fausserait ce qu'il mesure. */
  var compte = window.__vttinkerZoom = {
    releves: 0,       // tours d'horloge : on relit la valeur, on n'attache rien
    etats: 0,         // emetEtat entré
    emis: 0,          // postMessage réellement partis
    cameras: 0,       // écritures de la caméra
    molettes: 0,      // événements de molette reçus
    molettesToile: 0, // ... qui ont lieu sur le plateau
    molettesPrises: 0 // ... que l'on coupe pour zoomer nous-mêmes
  };

  /* LE ZOOM QUI FAIT FOI. Sans lui, chaque cran repartirait de la valeur que
   * Roll20 connaît — 250 — et la molette n'avancerait plus d'un pouce. */
  function zoomVu(st) {
    return zoomHorsPlage === null ? st.zoom : zoomHorsPlage;
  }

  function rendLeZoom() { zoomHorsPlage = null; }

  /* Un pas, quel que soit ce qui le demande — le bouton natif que nous avons
   * remplacé, ou la commande que l'extension dessine. Une seule règle, donc un
   * seul comportement : deux escaliers pour le même zoom se verraient. */
  function pasZoom(monte, taux) {
    if (surLancienMoteur()) { return ZH.pas(!!monte, taux); }
    var st = magasin("engine");
    if (!st || !bornes) { return null; }
    var a = zoomVu(st);
    if (!bloqueParRoll20(a, !!monte) && natif) { rendLeZoom(); return natif.stepAdjustZoom.call(st, !!monte); }
    var p = pasDe(a, taux || PAS_BOUTON);
    /* LES BOUTONS AUSSI PASSENT PAR LE DÉLAI. On les presse en rafale exactement
     * comme on tourne la molette — c'est même le geste le plus courant sur une
     * commande dessinée —, et rien ne justifierait de payer une reconstruction
     * par clic ici et une par geste là. */
    return pose(a + (monte ? p : -p));
  }

  /* ---------- ce que le zoom vaut, dit à qui dessine ----------
   *
   * La commande de l'extension vit dans le monde ISOLÉ, comme tout ce qui
   * touche au DOM de Roll20 ; elle ne voit donc pas l'état. On le lui pousse.
   *
   * UNE HORLOGE, ET SURTOUT PAS UN ABONNEMENT. C'est la correction la plus
   * importante de ce module, et elle a demandé six mesures pour être trouvée.
   *
   * Le premier jet employait « st.$subscribe(...) » : être prévenu quand la
   * valeur change paraissait plus propre et moins cher qu'une horloge qui
   * relit. C'est l'inverse, et de trois ordres de grandeur.
   *
   * MESURÉ, SUR UNE VRAIE PARTIE. Le même « $patch » sur son magasin :
   *
   *     rien d'attaché ................................    0 ms
   *     un $subscribe au rappel VIDE ..................  555 ms
   *     le même, retiré ...............................    0 ms
   *     un relevé toutes les 250 ms ...................    0 ms
   *
   * Le rappel ne fait RIEN. Ce n'est donc pas ce qu'il fait qui coûte, c'est
   * l'abonnement lui-même : « $subscribe » de Pinia n'enregistre pas seulement
   * un rappel, il installe AUSSI un observateur PROFOND sur l'état du magasin,
   * pour attraper les écritures directes. Sur « engine », qui porte l'état de
   * toute la scène de Roll20, chaque mutation fait alors parcourir tout le
   * graphe.
   *
   * CE QUE ÇA COÛTAIT À L'USAGE. Module éteint, tous les appels de zoom de
   * Roll20 sont gratuits ; module allumé, LES MÊMES bloquaient le fil principal
   * de 455 à 1 603 ms — un cran de molette dans sa plage, et la machine se
   * figeait une seconde et demie. L'installation de l'observateur, à elle
   * seule, en coûtait 3 349.
   *
   * Et c'est ce qui explique le paradoxe que l'auteur décrivait : au-delà de
   * 250 % on n'écrit plus dans son magasin, donc plus aucune mutation, donc
   * plus rien à parcourir. Le zoom « interdit » était fluide et le zoom
   * ordinaire ramait.
   *
   * L'HORLOGE NE LIT QU'UN NOMBRE, quatre fois par seconde, et n'attache rien.
   * Le quart de seconde de retard ne se voit pas : c'est le délai pour que le
   * CHIFFRE de la commande suive un geste fait ailleurs, et nos propres gestes,
   * eux, émettent tout de suite. */
  var horloge = null, dernierEmis = null;
  var PAS_HORLOGE = 250;

  function emetEtat(force) {
    compte.etats++;
    // Même règle que pour la molette : le test qui ne coûte rien vient d'abord.
    if (!bornes) { return; }
    var st = magasin("engine");
    if (!st) { return; }
    /* CE QU'ON AFFICHE EST CE QU'ON VOIT. Au-delà de sa borne, son magasin garde
     * la dernière valeur qu'il ait comprise : lire `st.zoom` ferait afficher 250
     * dans le champ alors que la carte est à 400. */
    var z = zoomVu(st);
    /* ET ON REPOSE LA CAMÉRA, PAR PRUDENCE. Mesuré : Roll20 ne la reprend ni
     * après deux secondes ni après un clic. Mais cette fonction passe à chaque
     * remuement de son magasin — un redimensionnement de fenêtre en est un —, et
     * s'il recalculait ses bornes orthographiques à cette occasion, notre zoom
     * retomberait à 250 sans que rien ne le relève. Quatre nombres réécrits au
     * plus seize fois par seconde, et seulement quand on est hors de sa plage :
     * c'est moins cher que la question. */
    if (zoomHorsPlage !== null) { poseCamera(zoomHorsPlage); }
    if (!force && z === dernierEmis) { return; }
    compte.emis++;
    dernierEmis = z;
    etatsEmis++;
    try {
      window.__vttinkerEtats = etatsEmis;
      window.postMessage({ ns: NS, depuis: "page", type: "zoom-etat",
                           zoom: z, min: bornes.min, max: bornes.max }, location.origin);
    } catch (e) {}
  }

  function veille() {
    if (horloge) { return; }
    horloge = setInterval(function () {
      compte.releves++;
      emetEtat(false);
    }, PAS_HORLOGE);
  }

  function arreteVeille() {
    if (horloge) { clearInterval(horloge); horloge = null; }
    dernierEmis = null;
  }

  /* La caméra, écrite selon la formule mesurée. C'est la seule écriture
   * réellement irréversible du fichier — d'où la vérification du zoom, qui
   * interdit toute division par zéro et tout plan dégénéré. */
  function poseCamera(z) {
    compte.cameras++;
    var c = cameraTable(), t = toile();
    if (!c || !t || !(z > 0) || !isFinite(z)) { return false; }
    var ht = (t.height / 2) * (100 / z), lg = (t.width / 2) * (100 / z);
    if (!isFinite(ht) || !isFinite(lg) || ht <= 0 || lg <= 0) { return false; }
    try {
      c.orthoTop = ht; c.orthoBottom = -ht;
      c.orthoRight = lg; c.orthoLeft = -lg;
      return true;
    } catch (e) { return false; }
  }

  function dansNotrePlage(z) {
    return Math.round(Math.max(bornes.min, Math.min(bornes.max, z)));
  }

  /* Poser un zoom, quel qu'il soit.
   *
   * DANS LA PLAGE NATIVE ON APPELLE LE setZoom D'ORIGINE, et rien d'autre. Pas
   * setZoomSilent : « silencieux » veut dire quelque chose chez Roll20, et le
   * journal montre que setZoom fait setZoomSilent PLUS son travail à lui —
   * probablement retenir le zoom d'une session à l'autre. Court-circuiter la
   * couche haute pour gagner un appel, c'est perdre ce qu'elle faisait sans
   * qu'on sache quoi. Aucune récursion à craindre : natif.setZoom descend vers
   * setZoomSilent, jamais vers le nôtre.
   *
   * AU-DELÀ, ON N'ÉCRIT RIEN CHEZ LUI — voir le long commentaire plus haut. Ce
   * chemin appelait setZoomSilent puis, au besoin, $patch sur son magasin : les
   * deux le font refaire son fond, et ça vaut de 600 à 2 000 ms par écriture.
   * Seule la caméra est posée, et elle coûte quatre nombres. */
  function pose(z) {
    /* UN NOMBRE QUI N'EN EST PAS UN NE FRANCHIT PAS CETTE PORTE.
     *
     * Taper « 1O0 » dans le champ donnait parseInt → NaN, et NaN traversait
     * tout : Math.max/min le laissent passer, le clone structuré l'accepte,
     * « NaN >= NATIF_MIN » est faux donc on partait dans la branche hors plage,
     * et on écrivait $patch({ zoom: NaN }) DANS LE MAGASIN DE ROLL20. La caméra,
     * elle, se protégeait déjà ; son état, non. C'est ici que se pose le garde,
     * parce que c'est le seul endroit d'où l'on écrit chez lui. */
    /* NOS PROPRES GESTES N'ATTENDENT PAS L'HORLOGE, et les DEUX branches
     * ci-dessous émettent avant de rendre la main. L'horloge est là pour
     * apprendre ce que Roll20 a fait de son côté ; ce que nous faisons, nous le
     * savons déjà. Sans cela, le chiffre de la commande traînerait d'un quart
     * de seconde derrière le glisseur qu'on est en train de tirer — et c'est
     * dans SA plage que le glisseur passe le plus clair de son temps, donc
     * n'émettre que sur la branche hors plage n'aurait rien réglé. */
    if (typeof z !== "number" || !isFinite(z)) { return null; }
    if (surLancienMoteur()) { return ZH.pose(z); }
    var st = magasin("engine");
    if (!st || !bornes) { return null; }
    z = dansNotrePlage(z);
    if (z >= NATIF_MIN && z <= NATIF_MAX) {
      /* DE RETOUR DANS SA PLAGE, IL REPREND TOUT — y compris sa caméra, que son
       * setZoom repositionne lui-même. On lâche donc notre valeur d'abord, sans
       * quoi `zoomVu` continuerait de mentir. Cette rentrée-là lui coûte une
       * reconstruction, et elle est légitime : c'est le moment où il redevient
       * net, et le seul où il a quelque chose à apprendre. */
      rendLeZoom();
      try { natif.setZoom.call(st, z); } catch (e) {}
      emetEtat(false);
      return z;
    }
    zoomHorsPlage = z;
    poseCamera(z);
    emetEtat(false);
    return z;
  }

  // Roll20 refuse-t-il d'aller là où on veut aller ?
  function bloqueParRoll20(actuel, monte) {
    if (actuel > NATIF_MAX || actuel < NATIF_MIN) { return true; }   // déjà dehors : il ramènerait
    return monte ? (actuel >= NATIF_MAX) : (actuel <= NATIF_MIN);
  }

  function surMolette(ev) {
    try {
      /* ON SORT AVANT DE CHERCHER QUOI QUE CE SOIT. Cet écouteur est posé sur
       * window, en capture et NON PASSIF : il s'exécute pour tout défilement de
       * la page — le tchat, le journal, une fiche — et le navigateur ne compose
       * rien tant qu'il n'a pas rendu la main. Les deux tests qui suivent ne
       * coûtent rien ; ce qui coûtait, c'était d'aller chercher le magasin
       * d'abord, pour découvrir ensuite qu'on n'avait rien à faire. */
      compte.molettes++;
      if (!bornes || !ev.deltaY) { return; }
      /* ET ON NE PREND QUE CE QUI SE PASSE SUR LE PLATEAU.
       *
       * Cet écouteur coupe l'événement — preventDefault ET
       * stopImmediatePropagation — dès que le zoom est hors des bornes de
       * Roll20. Or il est posé sur `window` : au-delà de 250 %, la molette
       * cessait donc de faire défiler TOUT le reste — le tchat, le journal, une
       * fiche de personnage, et depuis peu notre propre palette, qui déroule
       * soixante-dix marqueurs. On zoomait au lieu de la parcourir.
       *
       * Le geste n'appartient au zoom que s'il a lieu sur la toile. Ailleurs, on
       * rend la main sans rien toucher. */
      if (!surLaToile(ev.target)) { return; }
      compte.molettesToile++;
      var st = magasin("engine");
      if (!st) { return; }
      /* LE ZOOM VU, ET NON CELUI QU'IL CONNAÎT : pendant un geste, son magasin
       * garde encore la valeur d'avant — c'est tout le principe du délai. */
      var a = zoomVu(st), monte = ev.deltaY < 0;
      if (!bloqueParRoll20(a, monte)) { return; }        // Roll20 s'en occupe : on ne touche à rien
      /* ON COUPE ICI, ET PAS PLUS BAS — c'est une correction, et elle a été
       * mesurée sur l'ancien moteur, où le même défaut dormait : bornes 10–800,
       * zoom à 800, un cran vers le haut ramenait la carte à 250 %.
       *
       * Les deux tests qui suivent disent « on est à NOTRE borne, on ne monte
       * plus » — et ils renonçaient sans avaler l'événement. Roll20 le recevait
       * alors, calculait son cran, et nous ramenait dans SA plage. Refuser un
       * geste et le laisser passer, c'est le donner à quelqu'un d'autre.
       *
       * Dès qu'on sait que Roll20 se comporterait mal — c'est exactement ce que
       * vient de dire `bloqueParRoll20` —, l'événement est à nous, qu'on en
       * fasse quelque chose ou rien. */
      compte.molettesPrises++;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (monte && a >= bornes.max) { return; }          // notre propre borne : on refuse, et on garde
      if (!monte && a <= bornes.min) { return; }
      var p = pasDe(a, PAS_MOLETTE);
      pose(a + (monte ? p : -p));
    } catch (e) {}
  }

  /* LE CONTRÔLE DE ZOOM DE ROLL20 : ON LE MASQUE, ET ON LE REND.
   *
   * Mesuré sur une vraie partie : affiché, il surveille l'état du zoom et le
   * repousse dans SA plage en moins de soixante millisecondes, dans les deux
   * sens. Le module est alors strictement inopérant — bornes installées,
   * actions remplacées, et rien ne bouge. Masqué, la même suite d'appuis donne
   * 250 → 260 → 270 → 281 → 292, caméra à l'appui.
   *
   * C'ÉTAIT UN RÉGLAGE, CE N'EN EST PLUS UN. Tant que le masquer coûtait son
   * glisseur et trois de ses cinq boutons, l'arbitrage revenait à qui utilise
   * l'extension et une case le posait. Depuis que le module rend à la place une
   * commande de mêmes dimensions, aux mêmes couleurs et à la même place, il n'y
   * a plus rien à arbitrer : on masque dès que les bornes sortent des siennes.
   *
   * ON LE REND TEL QU'ON L'A TROUVÉ. C'est un réglage de compte Roll20, pas un
   * détail d'affichage : `controleMasque` ne retient que ce que NOUS avons
   * changé, et l'extinction le remet — jamais plus, jamais moins.
   *
   * Basculer ce réglage remet le zoom à 100 % — c'est Roll20 qui le fait, pas
   * nous. D'où le fait de ne le toucher qu'une fois, à l'installation. */
  var controleMasque = false;

  function litControle() {
    var pref = magasin("preference");
    try { return pref && pref.zoom ? !!pref.zoom.interfaceEnabled : null; } catch (e) { return null; }
  }

  /* Poser son contrôle à l'état voulu, et rien de plus : s'il y est déjà, on ne
   * le bascule pas — chaque bascule lui fait remettre le zoom à 100 %. */
  function poseControle(affiche) {
    controlesPoses++;
    try { window.__vttinkerControles = controlesPoses; } catch (e) {}
    var pref = magasin("preference");
    var v = litControle();
    if (v === null || !pref || typeof pref.toggleZoomInterfaceEnabled !== "function") { return false; }
    if (v === !!affiche) { controleMasque = !affiche; return false; }
    try { pref.toggleZoomInterfaceEnabled(); controleMasque = !affiche; return true; }
    catch (e) { return false; }
  }

  /* ON LE REND VISIBLE À L'EXTINCTION, TOUJOURS, et c'est un choix assumé.
   *
   * Ce réglage est persisté dans le compte Roll20 : masqué en fin de session,
   * il l'est encore à la suivante. Or le module n'a alors PLUS RIEN À CLONER —
   * ses boutons n'existent plus dans la page — et il retombe sur des caractères
   * de repli, deux fois plus petits. C'est le défaut qui a été signalé, et il
   * s'aggravait tout seul.
   *
   * Le prix : quelqu'un qui aurait masqué ce contrôle de lui-même se le verrait
   * rendu. C'est visible, réversible d'un clic, et sans commune mesure avec une
   * partie laissée sans aucune commande de zoom. */
  function rendControle() { return poseControle(true); }

  /* On compte, et on expose. Même raison que pour les poses de grille : une
   * fonction rappelée en boucle par une minuterie ne laisse aucune trace, et
   * c'est précisément celle-là qu'il faut pouvoir attraper. */
  var zoomPoses = 0, etatsEmis = 0, controlesPoses = 0;

  function installe(min, max) {
    zoomPoses++;
    try { window.__vttinkerZoomPoses = zoomPoses; } catch (e) {}
    /* L'ANCIEN MOTEUR A SON PROPRE MODULE, et l'aiguillage tient en une
     * ligne parce que c'est la seule porte : tout ce qui suit parle à Babylon
     * et au magasin « engine » de Pinia, qui est VIDE en héritage. */
    if (surLancienMoteur()) { return ZH.installe(min, max); }
    var st = magasin("engine");
    if (!st) { return { ok: false, raison: "magasin-absent" }; }

    /* BORNES IDENTIQUES AUX SIENNES : ON NE TOUCHE À RIEN. Le module est allumé
     * par défaut avec 10 et 250, c'est-à-dire exactement ce que Roll20 fait
     * déjà. Remplacer deux de ses actions et intercepter la molette pour
     * n'obtenir aucune différence serait du risque pur. Tant qu'un réglage n'a
     * pas bougé, la partie reste rigoureusement telle qu'elle était — et si le
     * module tournait déjà, on lui rend ce qu'on lui avait pris. */
    if (min === NATIF_MIN && max === NATIF_MAX) {
      if (natif && bornes) { retire(); }
      rendControle();   // rien à prolonger : Roll20 récupère son contrôle
      return { ok: true, min: min, max: max, zoom: st.zoom, sliderGene: false, natif: true };
    }

    if (!natif) {
      try { natif = { setZoom: st.setZoom, setZoomSilent: st.setZoomSilent, stepAdjustZoom: st.stepAdjustZoom }; }
      catch (e) { return { ok: false, raison: "actions-illisibles" }; }
    }
    bornes = { min: min, max: max };

    // setZoom : le slider et tout appel programmatique.
    try {
      st.setZoom = function (z) { return pose(z); };
    } catch (e) { return { ok: false, raison: "setZoom-non-remplacable" }; }

    // stepAdjustZoom(booléen) : les boutons + et −. Dans la plage native on
    // délègue mot pour mot, arrondi sur les dizaines compris.
    try {
      st.stepAdjustZoom = function (monte) { return pasZoom(!!monte, PAS_BOUTON); };
    } catch (e) {}

    // La molette n'appelle ni l'un ni l'autre : on l'intercepte au plus tôt,
    // en capture sur la fenêtre.
    if (!molette) {
      molette = surMolette;
      try { window.addEventListener("wheel", molette, { passive: false, capture: true }); } catch (e) {}
    }

    // Son contrôle, masqué — avant de toucher au zoom, puisque le basculer le
    // remet à 100 %.
    poseControle(false);

    // Le zoom courant peut être hors des nouvelles bornes : on le ramène.
    try { if (st.zoom > max || st.zoom < min) { pose(st.zoom); } } catch (e) {}

    // La commande dessinée par l'extension a besoin de suivre la valeur.
    veille();
    emetEtat(true);

    /* « sliderGene » dit à la commande si celle de Roll20 est encore là. Il ne
     * sert plus d'avertissement — on masque de nous-mêmes — mais de garde : si
     * le masquage échouait un jour (réglage renommé, action disparue), les deux
     * commandes se retrouveraient côte à côte, et c'est la nôtre qui doit
     * s'effacer. Une seule barre de zoom à l'écran, toujours. */
    var pref = magasin("preference"), encoreLa = false;
    try { encoreLa = !!(pref && pref.zoom && pref.zoom.interfaceEnabled); } catch (e) {}

    return { ok: true, min: min, max: max, zoom: st.zoom,
             sliderGene: encoreLa, controleMasque: controleMasque };
  }

  function retire() {
    if (surLancienMoteur()) { return ZH.retire(); }
    var st = magasin("engine");
    bornes = null;
    /* UN GESTE EN SUSPENS MEURT AVEC LE MODULE. Sans ça, un délai armé juste
     * avant l'extinction écrirait un zoom hors plage dans le magasin de Roll20
     * une fraction de seconde après qu'on lui a tout rendu — il se retrouverait
     * à 400 % sans plus rien pour l'y tenir. */
    rendLeZoom();
    arreteVeille();
    rendControle();   // on lui rend son contrôle avant tout le reste
    if (molette) {
      try { window.removeEventListener("wheel", molette, true); } catch (e) {}
      molette = null;
    }
    if (st && natif) {
      try { st.setZoom = natif.setZoom; } catch (e) {}
      try { st.stepAdjustZoom = natif.stepAdjustZoom; } catch (e) {}
      // On ramène la vue dans la plage de Roll20, sinon on laisse la partie
      // dans un état qu'elle ne sait plus quitter.
      try { if (st.zoom > NATIF_MAX) { natif.setZoomSilent.call(st, NATIF_MAX); } } catch (e) {}
      try { if (st.zoom < NATIF_MIN) { natif.setZoomSilent.call(st, NATIF_MIN); } } catch (e) {}

      /* ET ON RACCORDE LA CAMÉRA À L'ÉTAT, toujours. Relevé sur une vraie
       * partie : après extinction depuis 5 %, l'état était bien revenu à 10 et
       * la caméra était restée à 10660, c'est-à-dire à 5 %. La vue se retrouvait
       * deux fois trop large, et plus rien ne l'aurait recalée — Roll20 ne
       * touche à sa caméra que lorsqu'on lui demande de changer de zoom, et à
       * ses yeux il n'y avait plus rien à changer.
       *
       * C'est la dernière chose que fait ce fichier, et c'est la plus
       * importante : ce qui sépare « le module s'est éteint » de « le module a
       * laissé la partie de travers ». */
      try { poseCamera(st.zoom); } catch (e) {}
    }
    return { ok: true };
  }

  /* ============================================================
   *              LE MÊME ZOOM, SUR L'ANCIEN MOTEUR
   * ============================================================
   *
   * Roll20 sert deux moteurs derrière le même client. Tout ce qui précède parle
   * à Babylon et au magasin « engine » de Pinia ; sur une campagne d'héritage,
   * CE MAGASIN EXISTE MAIS IL EST VIDE — ni zoom, ni setZoom, ni
   * stepAdjustZoom — et c'est « d20.engine » qui commande. Mesuré côte à côte :
   *
   *     Pinia.engine.setZoom(150)      TypeError, et rien ne bouge
   *     d20.engine.setZoom(2)          canvasZoom 1 → 2, la carte suit
   *
   * D'OÙ CE SECOND MODULE. Il tient la même promesse — prolonger le zoom aux
   * extrémités sans toucher à ce que Roll20 fait dans sa plage — mais par des
   * moyens entièrement différents, et il se trouve qu'ils sont PLUS SIMPLES.
   *
   * ---------- SON UNITÉ N'EST PAS LA SIENNE ----------
   *
   * « canvasZoom » vaut 1 à cent pour cent, là où le magasin de Jumpgate porte
   * 100. Tout ce module parle en POUR CENT, comme le reste du fichier et comme
   * la commande à l'écran, et ne divise qu'au dernier moment.
   *
   * ---------- DEUX PORTES, ET LA MOLETTE EN FRANCHIT UNE ----------
   *
   * C'est la différence qui change tout. Sous Jumpgate, les trois commandes
   * bornaient AVANT d'appeler, et collée à sa borne la molette n'appelait plus
   * rien : il a fallu l'intercepter sur la fenêtre, en capture et non passive,
   * c'est-à-dire payer un écouteur à chaque défilement de la page entière.
   *
   * Ici, non. Mesuré à la borne haute :
   *
   *     à 250 %, un cran de molette     →  slideZoom(2.5858333)
   *     à 250 %, le bouton « + »        →  aucun appel
   *
   * LA MOLETTE PASSE SA VALEUR NON BORNÉE : c'est « slideZoom » lui-même qui la
   * ramène (« ee>2.5&&(ee=2.5) », lu dans sa source).
   *
   * ET POURTANT LE REMPLACER NE SUFFIT PAS — mesuré, et c'est la correction qui
   * a coûté le plus cher ici. Le premier jet interceptait « slideZoom » et lisait
   * le SENS du geste dans la valeur reçue : plus haute que le zoom courant, on
   * monte. À 800 %, deux crans opposés ont donné 800 → 773 → 746 : les deux vers
   * le bas.
   *
   * La raison est dans sa source. Son gestionnaire ne calcule pas son cran
   * depuis « canvasZoom » mais depuis une variable retenue DANS slideZoom
   * (« T=ee »). Dès qu'on cesse de lui déléguer, cette variable se fige, la
   * valeur reçue devient constante, et le sens du geste est indéchiffrable :
   * une valeur figée à 2,5 est plus basse que 800 quoi qu'on fasse.
   *
   * IL FAUT DONC LE SENS DU GESTE, ET IL N'EST QUE DANS L'ÉVÉNEMENT. On pose
   * l'écouteur comme sous Jumpgate — fenêtre, capture, non passif —, avec la
   * même sortie précoce et la même règle : on ne coupe QUE là où Roll20 n'aurait
   * rien fait, ou nous aurait ramenés. Le gain espéré n'était pas là ; ce qui
   * reste acquis, c'est que « slideZoom » n'a pas à être touché.
   *
   * Quant aux boutons, ils ne sont pas en jeu : le module masque la commande de
   * Roll20 et dessine la sienne, dont les boutons appellent « pasZoom »
   * directement.
   *
   * ---------- CE QU'IL FAUT REFAIRE À NOTRE VALEUR ----------
   *
   * Son setZoom borne par « zoomSizeCheck », un import interne qu'on ne peut ni
   * remplacer ni contourner. Mais tout ce qu'il fait ENSUITE est lisible, et
   * chaque pièce est atteignable. Il calcule un RAPPORT — « zoomValue /
   * canvasZoom » — et l'applique aux contextes 2D, puis :
   *
   *     canvasZoom = valeur                         l'échelle qui fait foi
   *     tabletopState.zoom = valeur                 le miroir de la commande
   *     canvas_overlay.gl.updateGlSize()            sa couche WebGL
   *     canvas.forEachObject(o => o.setCoords())    les objets se resituent
   *     un redessin                                 l'image
   *
   * On refait exactement cette liste, avec notre valeur. Et comme le rapport se
   * calcule à partir de « canvasZoom », que nous tenons à jour, LE RETOUR DANS
   * SA PLAGE SE FAIT TOUT SEUL : son setZoom, rappelé depuis 400 %, calcule
   * 2,5/4 et rescale juste. Rien à défaire.
   *
   * ---------- LE PAS DU PROLONGEMENT ----------
   *
   * Même règle que sous Jumpgate, et pour la même raison : le premier pas
   * au-delà de la borne doit valoir le dernier pas en deçà, sans quoi la
   * jonction se sent. Le pas natif d'ici a été mesuré à trois altitudes —
   * 0,085833 à 50 %, à 100 % et à 200 % — il est donc ADDITIF, et vaut 8,5833
   * points de pourcentage (contre 12,875 sous Jumpgate). Le taux géométrique du
   * prolongement est donc 8,5833/250 pour la molette, et 10/250 pour les
   * boutons, dont le pas a été relevé à 109 → 119.
   */
  var ZH = (function () {
    var NATIF_MIN_H = 10, NATIF_MAX_H = 250;
    var PAS_MOLETTE_H = 8.5833 / 250;    // le cran de molette à la borne haute
    var natifH = null;      // son setZoom d'origine — slideZoom n'est pas touché
    var bornesH = null;     // { min, max } — nul quand le module est éteint
    var horlogeH = null, dernierH = null;
    var moletteH = null;    // l'écouteur posé sur la fenêtre

    function d20De() {
      try { return (window.currentPlayer && window.currentPlayer.d20) || window.d20 || null; }
      catch (e) { return null; }
    }
    function moteurH() { var d = d20De(); return (d && d.engine) ? d.engine : null; }

    /* LE ZOOM QUI FAIT FOI, EN POUR CENT, ET IL N'Y EN A QU'UN.
     *
     * Sous Jumpgate il en fallait deux : le magasin de Roll20 garde la dernière
     * valeur qu'il ait comprise — 250 — pendant que la carte est à 400, donc le
     * module tient la sienne à côté. Ici, non : c'est nous qui écrivons
     * « canvasZoom », il vaut donc toujours ce que la carte montre.
     *
     * Une copie n'aurait servi qu'à se périmer, et elle l'a fait : quand Roll20
     * a repris la main à 250 %, elle disait encore 800, et le cran suivant est
     * reparti de 800. Une seule source, et c'est la sienne. */
    function zoomH() {
      var e = moteurH();
      if (!e || !(e.canvasZoom > 0)) { return null; }
      return Math.round(e.canvasZoom * 100);
    }

    function dansNosBornes(p) {
      if (!bornesH) { return Math.round(p); }
      return Math.round(Math.max(bornesH.min, Math.min(bornesH.max, p)));
    }

    /* LE MIROIR DE SA COMMANDE. Son setZoom l'écrit ; nous aussi, sans quoi le
     * chiffre affiché resterait à la dernière valeur qu'il ait comprise — 250 —
     * pendant que la carte est à 400. Il ne commande rien : écrit seul, mesuré,
     * la carte ne bouge pas d'un pixel. C'est de l'affichage, et c'est
     * précisément pour ça qu'il faut le tenir juste. */
    function poseMiroir(z) {
      try {
        var t = magasin("vttTools_tabletopState");
        if (t) { t.zoom = z; }
      } catch (e) {}
    }

    /* ---------- HORS DE SA PLAGE : SON TRAVAIL, REFAIT À NOTRE VALEUR ----------
     *
     * Chaque geste ci-dessous est repris de sa propre source, dans son ordre.
     * Le rapport d'abord, parce que les contextes 2D CUMULENT les échelles : un
     * « scale » n'est pas une valeur qu'on pose, c'est une multiplication qu'on
     * applique, et se tromper de sens compose l'erreur à chaque cran. */
    function poseHorsPlage(p) {
      var d = d20De(), e = moteurH();
      if (!d || !e) { return false; }
      var z = p / 100, cz = e.canvasZoom;
      if (!(z > 0) || !isFinite(z) || !(cz > 0) || !isFinite(cz)) { return false; }
      var r = z / cz;
      if (!(r > 0) || !isFinite(r)) { return false; }
      var cv = e.canvas;
      try { if (cv && cv.contextTop) { cv.contextTop.scale(r, r); } } catch (x) {}
      try { if (cv && cv.contextContainer) { cv.contextContainer.scale(r, r); } } catch (x) {}
      try { if (e.final_canvas_ctx) { e.final_canvas_ctx.scale(r, r); } } catch (x) {}
      try {
        var w = e.work_canvases || {};
        for (var k in w) {
          if (w[k] && !w[k].gl && w[k].context) { w[k].context.scale(r, r); }
        }
      } catch (x) {}
      e.canvasZoom = z;
      poseMiroir(z);
      try {
        if (d.canvas_overlay && d.canvas_overlay.gl && d.canvas_overlay.gl.active) {
          d.canvas_overlay.gl.updateGlSize();
        }
      } catch (x) {}
      try { if (cv && cv.forEachObject) { cv.forEachObject(function (o) { o.setCoords(); }); } } catch (x) {}
      try { if (typeof e.redrawScreenNextTick === "function") { e.redrawScreenNextTick(); } } catch (x) {}
      return true;
    }

    /* Poser un zoom, en pour cent. Dans sa plage on lui rend la main COMPLÈTE —
     * son setZoom recalcule le rapport depuis « canvasZoom », que nous tenons
     * juste, et rescale donc correctement même en revenant de 800 %. */
    function poseH(p) {
      if (typeof p !== "number" || !isFinite(p)) { return null; }
      var e = moteurH();
      if (!e || !bornesH) { return null; }
      p = dansNosBornes(p);
      if (p >= NATIF_MIN_H && p <= NATIF_MAX_H) {
        try { (natifH ? natifH.setZoom : e.setZoom).call(e, p / 100, false, false); } catch (x) {}
        emetH(false);
        return p;
      }
      poseHorsPlage(p);
      emetH(false);
      return p;
    }

    function bloqueH(actuel, monte) {
      if (actuel > NATIF_MAX_H || actuel < NATIF_MIN_H) { return true; }
      return monte ? (actuel >= NATIF_MAX_H) : (actuel <= NATIF_MIN_H);
    }

    /* Un pas, d'où qu'il vienne — la commande dessinée, ou la molette qu'on a
     * interceptée. Dans sa plage on lui laisse SON pas ; au-delà, le nôtre. */
    function pasH(monte, taux) {
      var a = zoomH();
      if (a === null || !bornesH) { return null; }
      if (!bloqueH(a, !!monte)) {
        return poseH(a + (monte ? 1 : -1) * Math.round(NATIF_MAX_H * (taux || PAS_BOUTON)));
      }
      var pas = Math.max(1, Math.round(a * (taux || PAS_BOUTON)));
      return poseH(a + (monte ? pas : -pas));
    }

    function emetH(force) {
      if (!bornesH) { return; }
      var z = zoomH();
      if (z === null) { return; }
      if (!force && z === dernierH) { return; }
      dernierH = z;
      try {
        window.postMessage({ ns: NS, depuis: "page", type: "zoom-etat",
                             zoom: z, min: bornesH.min, max: bornesH.max }, location.origin);
      } catch (e) {}
    }

    function veilleH() {
      if (horlogeH) { return; }
      horlogeH = setInterval(function () { emetH(false); }, PAS_HORLOGE);
    }
    function arreteVeilleH() {
      if (horlogeH) { clearInterval(horlogeH); horlogeH = null; }
      dernierH = null;
    }

    /* LA MOLETTE, PRISE À L'ÉVÉNEMENT. Décalque de « surMolette », y compris sa
     * sortie précoce : cet écouteur s'exécute pour TOUT défilement de la page —
     * le tchat, le journal, une fiche, notre propre palette — et le navigateur
     * ne compose rien tant qu'il n'a pas rendu la main. Les deux premiers tests
     * ne coûtent rien ; aller chercher le zoom d'abord, si. */
    function surMoletteH(ev) {
      try {
        if (!bornesH || !ev.deltaY) { return; }
        if (!surLaToile(ev.target)) { return; }
        var a = zoomH();
        if (a === null) { return; }
        var monte = ev.deltaY < 0;
        if (!bloqueH(a, monte)) { return; }              // Roll20 s'en occupe
        /* ON AVALE AVANT DE REGARDER NOS PROPRES BORNES. Mesuré : à 800 avec
         * un plafond à 800, renoncer sans couper rendait le geste à Roll20, qui
         * ramenait la carte à 250 % d'un seul cran. */
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (monte && a >= bornesH.max) { return; }       // notre borne : on refuse, et on garde
        if (!monte && a <= bornesH.min) { return; }
        var pas = Math.max(1, Math.round(a * PAS_MOLETTE_H));
        poseH(a + (monte ? pas : -pas));
      } catch (e) {}
    }

    /* ---------- LA PORTE, ET LE GESTE ---------- */

    function installeH(min, max) {
      var e = moteurH();
      if (!e) { return { ok: false, raison: "d20-absent", moteur: "heritage" }; }

      /* BORNES IDENTIQUES AUX SIENNES : ON NE TOUCHE À RIEN. Même parti que sous
       * Jumpgate — remplacer deux de ses fonctions pour n'obtenir aucune
       * différence serait du risque pur. */
      if (min === NATIF_MIN_H && max === NATIF_MAX_H) {
        if (natifH && bornesH) { retireH(); }
        rendControle();
        return { ok: true, min: min, max: max, zoom: zoomH(),
                 natif: true, moteur: "heritage" };
      }

      if (!natifH) {
        try { natifH = { setZoom: e.setZoom }; }
        catch (x) { return { ok: false, raison: "actions-illisibles", moteur: "heritage" }; }
      }
      bornesH = { min: min, max: max };

      /* setZoom : le glisseur, et tout appel programmatique. */
      try {
        e.setZoom = function (v) { return poseH(Math.round(v * 100)) / 100; };
      } catch (x) { return { ok: false, raison: "setZoom-non-remplacable", moteur: "heritage" }; }

      /* La molette : elle n'appelle ni l'un ni l'autre de façon exploitable —
       * voir le long commentaire en tête. On la prend à l'événement. */
      if (!moletteH) {
        moletteH = surMoletteH;
        try { window.addEventListener("wheel", moletteH, { passive: false, capture: true }); } catch (x) {}
      }

      poseControle(false);
      try { var z0 = zoomH(); if (z0 !== null && (z0 > max || z0 < min)) { poseH(z0); } } catch (x) {}
      veilleH();
      emetH(true);

      var pref = magasin("preference"), encoreLa = false;
      try { encoreLa = !!(pref && pref.zoom && pref.zoom.interfaceEnabled); } catch (x) {}
      return { ok: true, min: min, max: max, zoom: zoomH(),
               sliderGene: encoreLa, controleMasque: controleMasque, moteur: "heritage" };
    }

    function retireH() {
      var e = moteurH();
      bornesH = null;
      arreteVeilleH();
      rendControle();
      if (moletteH) {
        try { window.removeEventListener("wheel", moletteH, true); } catch (x) {}
        moletteH = null;
      }
      if (e && natifH) {
        try { e.setZoom = natifH.setZoom; } catch (x) {}
        /* ON NE LAISSE PAS LA PARTIE HORS DE CE QU'ELLE SAIT QUITTER. Son
         * setZoom, rappelé depuis 400 %, calcule le rapport 2,5/4 et rescale
         * juste : c'est la même mécanique qui nous a servi à sortir, prise à
         * l'envers. */
        try {
          var z = zoomH();
          if (z !== null && z > NATIF_MAX_H) { natifH.setZoom.call(e, NATIF_MAX_H / 100, false, false); }
          else if (z !== null && z < NATIF_MIN_H) { natifH.setZoom.call(e, NATIF_MIN_H / 100, false, false); }
        } catch (x) {}
      }
      return { ok: true, moteur: "heritage" };
    }

    return { installe: installeH, retire: retireH, pose: poseH, pas: pasH,
             emet: emetH, zoom: zoomH, PAS_MOLETTE: PAS_MOLETTE_H };
  })();

  /* L'ANCIEN MOTEUR EST-IL CELUI QUI DESSINE ? Posée ici parce que c'est ici
   * qu'on aiguille, et une seule fois : les quatre fonctions publiques du zoom
   * s'en remettent à elle, et rien d'autre du module n'a à savoir. */
  function surLancienMoteur() { return moteurDeRoll20() === "heritage"; }


  /* ============================================================
   *              LA GRILLE, ÉTENDUE HORS DE LA CARTE
   * ============================================================
   *
   * Roll20 arrête le DESSIN de la grille au bord de la page, alors que
   * l'aimantation des jetons, elle, continue au-delà : on peut poser un
   * personnage hors carte, il se cale sur la trame, mais plus rien ne la
   * montre. On étend donc l'affichage, et rien d'autre — l'aimantation est déjà
   * la sienne, il n'y a pas à la refaire.
   *
   * CE QU'ELLE EST, relevé sur une vraie partie (`npm run grille`) :
   *   maillage « tabletop-square-grid », un simple quad de six sommets,
   *     position (770, -1120), échelle (1540, -2240) — soit 22 × 70 et 32 × 70,
   *     la page en cases de soixante-dix pixels ;
   *   matériau ShaderMaterial « GridMaterial », uniformes :
   *     gridSize (vec2) = [22, 32]  — le NOMBRE DE CASES, pas leur taille
   *     color = gris 0.753          opacity = 0.5
   *   attributs : position, uv.
   *
   * LE SHADER DESSINE EN ESPACE UV. gridSize est un nombre de cases réparties
   * sur le quad : agrandir le quad SANS toucher à gridSize étirerait les cases.
   * On fait donc les deux, du même facteur, et la case reste à soixante-dix.
   *
   * ET L'ALIGNEMENT TIENT TOUT SEUL, à condition d'ajouter des cases ENTIÈRES
   * de part et d'autre d'un centre inchangé : le bord passe de 0 à -70n, qui
   * reste un multiple de la case. Les lignes tombent exactement sur les
   * siennes, donc sur l'aimantation. C'est la seule raison pour laquelle ce
   * module n'a aucun calcul de position à faire.
   */
  /* ---------- LES CINQ TYPES, ET LEURS DEUX MÉCANIQUES ----------
   *
   * Relevé sur une vraie partie (`npm run types`), en changeant grid_type — la
   * clé porte un SOULIGNÉ, et « gridtype » crée un attribut que Roll20 ignore
   * sans rien dire :
   *
   *   square              tabletop-square-grid   Mesh, quad de 6 sommets
   *   hex / hexr          Hex-Grid-Line-System   LinesMesh, ~9 800 sommets
   *   dimetric/isometric  Iso-Grid-Line-System   LinesMesh, ~175 sommets
   *
   * DEUX FAMILLES, DEUX REMÈDES. Le carré est un shader sur un quad : on
   * agrandit le quad et le nombre de cases, et la case garde sa taille. Les
   * quatre autres sont de la VRAIE GÉOMÉTRIE de lignes, cuite aux dimensions
   * de la page : la mettre à l'échelle agrandirait les cellules. On la PAVE —
   * on clone le maillage et on décale les copies.
   *
   * ET LE DÉCALAGE N'EST PAS LA TAILLE DE LA PAGE. Mesuré sur l'hexagone :
   * l'écart horizontal vaut 35 et 1540 en est un multiple exact, mais la
   * période verticale vaut 35√3 ≈ 60,62 et 2240 n'en est PAS un multiple
   * (36,95 périodes). Décaler d'une page laisserait une couture visible tous
   * les 2240 pixels. On décale donc du plus grand multiple ENTIER de la période
   * qui tienne dans l'étendue : les copies se chevauchent alors légèrement, en
   * phase, et les lignes coïncident exactement. */
  var grille = null;      // { mesh, ex: {…} } — l'état d'origine, pour le rendre
  var paves = [];         // les clones posés, à retirer tels quels
  var paveSource = null;  // LE maillage qu'on a cloné, et pas un autre
  var peint = null;       // le quad peint : la voie normale depuis 0.10
  var derniere = null;    // ce qu'on a posé la dernière fois, pour ne pas refaire
  var attenteEffet = 0;   // tours de guet passés à attendre que le shader compile
  var shaderRefuse = false;   // il a échoué : on ne réessaiera pas cette page
  var refusShader = null;     // pourquoi, pour le dire avec le prochain résultat

  function meshGrille() {
    try {
      var S = window.MeshScene;
      if (!S || !S.meshes) { return null; }
      for (var i = 0; i < S.meshes.length; i++) {
        if (S.meshes[i] && S.meshes[i].name === "tabletop-square-grid") { return S.meshes[i]; }
      }
    } catch (e) {}
    return null;
  }

  /* CHANGER L'ÉCHELLE NE SUFFIT PAS. Roll20 fige la matrice de monde de sa
   * grille — le maillage ne bouge plus tant qu'on ne la lui fait pas
   * recalculer. Sans ces trois lignes, la propriété `scaling` valait bien
   * 9940 à la relecture, et le quad restait à 1540 : gridSize, lui, avait
   * changé, si bien que les cent quarante-deux cases se serraient sur la
   * largeur de la carte. Une trame deux fois plus fine, et toujours rien
   * au-delà du bord.
   *
   * C'est le genre de panne que les chiffres déclarent réussie et que seule
   * l'image dément : la valeur écrite était la bonne, elle n'était simplement
   * pas appliquée. */
  function rafraichis(m) {
    try { if (m.unfreezeWorldMatrix) { m.unfreezeWorldMatrix(); } } catch (e) {}
    try { m.computeWorldMatrix(true); } catch (e) {}
    try { if (m.refreshBoundingInfo) { m.refreshBoundingInfo(); } } catch (e) {}
  }

  function tailleGrille(m) {
    try {
      var v = m.material && m.material._vectors2 && m.material._vectors2.gridSize;
      return v ? { v: v, x: v.x, y: v.y } : null;
    } catch (e) { return null; }
  }

  function meshLignes() {
    try {
      var S = window.MeshScene;
      if (!S || !S.meshes) { return null; }
      for (var i = 0; i < S.meshes.length; i++) {
        var m = S.meshes[i];
        if (m && /Grid-Line-System/.test(m.name) && !/^vttk-pave-/.test(m.name)) { return m; }
      }
    } catch (e) {}
    return null;
  }

  /* LA PÉRIODE D'UNE SUITE DE VALEURS, trouvée par autocorrélation.
   *
   * On cherche le plus petit décalage qui remette la suite sur elle-même. Pas
   * de mathématiques d'hexagone ni d'isométrie à écrire : la géométrie dit
   * elle-même sa période, et un type de grille qu'on n'a jamais vu se traitera
   * comme les autres.
   *
   * Un peu de tolérance, parce que ces coordonnées sont des flottants : 20,2071
   * et 40,4145 sont le même motif à un dix-millième près. */
  function periode(vals) {
    /* ON DÉDOUBLONNE AVANT DE TRIER, et non l'inverse.
     *
     * Les neuf mille coordonnées d'une trame hexagonale n'ont que quarante-
     * quatre valeurs distinctes en x : trier les neuf mille pour n'en garder que
     * quarante-quatre, c'est soixante fois le travail nécessaire, et ce travail
     * se paie six fois au chargement d'une partie. Un tri est en n log n ; le
     * dédoublonnage par table est en n. */
    var vus = Object.create(null), v = [], j, k;
    for (j = 0; j < vals.length; j++) {
      k = Math.round(vals[j] * 100);
      if (vus[k] === undefined) { vus[k] = 1; v.push(vals[j]); }
    }
    v.sort(function (a, b) { return a - b; });
    /* DEUX TOLÉRANCES, ET C'EST VOULU. Celle du dédoublonnage est serrée — deux
     * sommets distants d'un centième sont le même point. Celle de la
     * CONCORDANCE est large : sur trente-sept périodes de 60,62, l'accumulation
     * des flottants dépasse largement le centième, et une tolérance unique
     * faisait échouer la recherche pour l'hexagone comme pour l'isométrie. La
     * période était bien là ; c'est nous qui la refusions. */
    var u = [], epsDoublon = 0.01, eps = 0.15;
    for (var i = 0; i < v.length; i++) {
      if (!u.length || v[i] - u[u.length - 1] > epsDoublon) { u.push(v[i]); }
    }
    if (u.length < 4) { return null; }
    var etendue = u[u.length - 1] - u[0];

    /* LES CANDIDATES NE S'ANCRENT PAS SUR LA PREMIÈRE VALEUR. C'était l'erreur :
     * la plus petite valeur est un sommet de BORDURE, rogné au bord de la page
     * et hors trame — toutes les périodes qu'on en tirait étaient décalées, et
     * la vraie n'était jamais essayée. On part donc de plusieurs origines, et
     * on garde la plus petite période qui tienne. */
    var cands = [];
    for (var o = 0; o < Math.min(4, u.length); o++) {
      for (var kk = o + 1; kk < Math.min(o + 40, u.length); kk++) {
        var c = u[kk] - u[o];
        if (c > eps) { cands.push(c); }
      }
    }
    cands.sort(function (a, b) { return a - b; });

    for (var k = 0; k < cands.length; k++) {
      var p = cands[k];
      if (k && p - cands[k - 1] < eps) { continue; }   // déjà essayée
      /* UNE CONCORDANCE TRÈS MAJORITAIRE, PAS TOTALE. Exiger que TOUTE valeur
       * décalée retombe sur une autre paraissait rigoureux ; c'était trop
       * strict, et la recherche échouait pour l'hexagone comme pour l'isométrie
       * alors que la période existait. La raison : la grille est ROGNÉE aux
       * bords de la page, et les rangées partielles de bordure ne se répètent
       * pas. Un seul de ces sommets suffisait à faire rejeter la bonne période.
       *
       * On demande donc quatre-vingt-dix pour cent. Et on borne la période à la
       * MOITIÉ de l'étendue plutôt que d'exiger un nombre d'appariements : une
       * période doit se répéter au moins deux fois pour en être une, et c'est
       * la seule formulation qui vaille aussi pour les grilles courtes — celle
       * de l'isométrie n'a que cent soixante-quinze sommets. */
      var vus = 0, apparies = 0, somme = 0;
      for (var j = 0; j < u.length; j++) {
        var cible = u[j] + p;
        if (cible > u[u.length - 1] - eps) { continue; }
        vus++;
        for (var q = j + 1; q < u.length; q++) {
          if (Math.abs(u[q] - cible) <= eps) {
            apparies++;
            somme += u[q] - u[j];   // cet écart vaut UNE période, et une seule
            break;
          }
          if (u[q] > cible + eps) { break; }
        }
      }
      if (vus >= 2 && apparies >= vus * 0.9 && p <= etendue / 2 + eps) {
        /* AFFINAGE PAR LA MOYENNE DES ÉCARTS APPARIÉS.
         *
         * La version d'avant prenait la distance entre le premier et le dernier
         * sommet appariés, divisée par le nombre de périodes qui les séparent.
         * C'était faux, et le chiffre l'a dit : 118,135 relevé pour « hexr » là
         * où le réseau vaut 121,2436. La raison — cette distance ne mesure des
         * périodes entières que si ses deux extrémités appartiennent à la MÊME
         * classe de résidu, et une trame hexagonale en a deux, séparées d'un
         * tiers de période. L'arrondi tombait alors sur le mauvais entier, et
         * rendait une valeur qui n'est période de rien.
         *
         * On moyenne donc les écarts appariés eux-mêmes : chacun vaut une
         * période et une seule, quelle que soit la classe d'où il part. L'erreur
         * est divisée par la racine de leur nombre, au lieu d'être remplacée par
         * une autre. */
        return somme / apparies;
      }
    }
    return null;
  }

  /* ---------- LIRE LA GÉOMÉTRIE, UNE FOIS ----------
   *
   * Segments normalisés — le plus petit sommet d'abord, sans quoi le même
   * segment parcouru à l'envers passerait pour un autre — et débarrassés des
   * DÉGÉNÉRÉS : la géométrie de Roll20 en porte cinquante-six sur l'hexagone,
   * qui ne dessinent rien mais occuperaient une place dans chaque tuile. */
  function segmentsDe(m) {
    var pos = null, idx = null;
    try { pos = m.getVerticesData("position"); idx = m.getIndices(); } catch (e) {}
    if (!pos || !pos.length) { return null; }
    if (!idx || !idx.length) {
      idx = [];
      for (var n = 0; n < pos.length / 3; n++) { idx.push(n); }
    }
    var seg = [], degeneres = 0, k, a, b, x0, y0, x1, y1, t;
    for (k = 0; k < Math.floor(idx.length / 2); k++) {
      a = idx[2 * k] * 3; b = idx[2 * k + 1] * 3;
      x0 = pos[a]; y0 = pos[a + 1]; x1 = pos[b]; y1 = pos[b + 1];
      if (x0 === x1 && y0 === y1) { degeneres++; continue; }
      if (x1 < x0 || (x1 === x0 && y1 < y0)) { t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }
      seg.push([x0, y0, x1, y1]);
    }
    return { seg: seg, z: pos[2], degeneres: degeneres };
  }

  function boiteDe(seg) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, i, s;
    for (i = 0; i < seg.length; i++) {
      s = seg[i];
      x0 = Math.min(x0, s[0], s[2]); x1 = Math.max(x1, s[0], s[2]);
      y0 = Math.min(y0, s[1], s[3]); y1 = Math.max(y1, s[1], s[3]);
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /* La médiane se prend sur un ÉCHANTILLON. Elle ne sert qu'à décider si les
   * segments sont des côtés de cellule ou de longues droites — un rapport de un
   * à quarante. Trier quatre mille sept cents longueurs pour trancher ça, c'est
   * payer cher une évidence ; deux cents suffisent, et le résultat est le même. */
  function medianeLongueur(seg) {
    var L = [], s;
    var saut = Math.max(1, Math.floor(seg.length / 200));
    for (var i = 0; i < seg.length; i += saut) {
      s = seg[i];
      L.push(Math.sqrt((s[2] - s[0]) * (s[2] - s[0]) + (s[3] - s[1]) * (s[3] - s[1])));
    }
    L.sort(function (a, b) { return a - b; });
    return L.length ? L[Math.floor(L.length / 2)] : 0;
  }

  /* Une table spatiale, pour demander « ce segment existe-t-il ? » sans
   * parcourir les cinq mille autres. */
  var TOL_SEG = 0.12;   // deux sommets plus proches que ça sont le même point
  var COTE = 8;

  function tableDe(seg) {
    var t = Object.create(null), i, c;
    for (i = 0; i < seg.length; i++) {
      c = Math.floor(seg[i][0] / COTE) + "," + Math.floor(seg[i][1] / COTE);
      if (!t[c]) { t[c] = []; }
      t[c].push(i);
    }
    return t;
  }

  function ilExiste(seg, tab, X0, Y0, X1, Y1) {
    var cx = Math.floor(X0 / COTE), cy = Math.floor(Y0 / COTE), u, v, lot, n, s;
    for (u = -1; u <= 1; u++) {
      for (v = -1; v <= 1; v++) {
        lot = tab[(cx + u) + "," + (cy + v)];
        if (!lot) { continue; }
        for (n = 0; n < lot.length; n++) {
          s = seg[lot[n]];
          if (Math.abs(s[0] - X0) < TOL_SEG && Math.abs(s[1] - Y0) < TOL_SEG &&
              Math.abs(s[2] - X1) < TOL_SEG && Math.abs(s[3] - Y1) < TOL_SEG) { return true; }
        }
      }
    }
    return false;
  }

  /* ---------- UNE TRANSLATION EST-ELLE UNE SYMÉTRIE DU RÉSEAU ? ----------
   *
   * C'était le trou, et il a coûté cher. Une trame hexagonale à sommet pointu
   * est engendrée par (70 ; 0) et (35 ; 60,62) : une translation VERTICALE de n
   * rangées n'en est une symétrie que si n est PAIR — une rangée sur deux étant
   * décalée d'une demi-largeur, un nombre impair de rangées laisse ce demi-pas
   * en travers. On tirait n de la seule hauteur de la page, sans rien vérifier.
   * Sur trente et une hauteurs, neuf tombaient juste : les autres affichaient,
   * dès le premier pixel au-delà du bord, une trame décalée d'une DEMI-LARGEUR
   * d'hexagone. En haut et en bas pour « hex », à gauche et à droite pour
   * « hexr » — et c'est exactement ce qui se voyait.
   *
   * On ne raisonne donc plus sur la parité, ni sur aucune formule d'hexagone :
   * on translate, et on regarde si ça retombe. Un type de grille qu'on n'a
   * jamais vu passera le même examen sans une ligne de plus. */
  function symetrie(seg, tab, bb, bande, dx, dy) {
    /* ON NE JUGE PAS UNE SYMÉTRIE SUR CE QUE LA PAGE A COUPÉ.
     *
     * Roll20 tronque sa géométrie au rectangle de la page : le long du bord, les
     * cellules sont incomplètes et hors trame. Une translation parfaitement
     * valide y échoue donc forcément, et sur une petite grille ces bords pèsent
     * assez pour la faire rejeter — le banc l'a montré tout de suite. On écarte
     * donc des deux côtés : le segment ne doit pas toucher le bord de la source,
     * et son image doit tomber franchement à l'intérieur, à plus d'une cellule
     * des bords. Ce qu'on teste alors, c'est bien la trame, et rien d'autre. */
    var testes = 0, ok = 0, i, s, A, B, C, D;
    var saut = Math.max(1, Math.floor(seg.length / 400));
    for (i = 0; i < seg.length; i += saut) {
      s = seg[i];
      if (s[0] <= bb.x0 + TOL_SEG || s[2] >= bb.x1 - TOL_SEG ||
          Math.min(s[1], s[3]) <= bb.y0 + TOL_SEG ||
          Math.max(s[1], s[3]) >= bb.y1 - TOL_SEG) { continue; }
      A = s[0] + dx; B = s[1] + dy; C = s[2] + dx; D = s[3] + dy;
      if (A < bb.x0 + bande || C > bb.x1 - bande ||
          Math.min(B, D) < bb.y0 + bande || Math.max(B, D) > bb.y1 - bande) { continue; }
      testes++;
      if (ilExiste(seg, tab, A, B, C, D)) { ok++; }
    }
    return testes >= 8 && ok >= testes * 0.97;
  }

  /* LE DOMAINE FONDAMENTAL D'UN AXE : le pavé qu'on va répéter.
   *
   * Son pas est un multiple ENTIER de la période — sinon les copies ne
   * retombent pas sur la trame — ET une symétrie vérifiée du réseau, sans quoi
   * elles y retombent décalées d'un demi-motif. On essaie le plus grand pas qui
   * tienne dans la source, puis le suivant, jusqu'à ce que l'un passe l'examen :
   * le plus grand qui passe, c'est le moins de tuiles, donc le moins de travail.
   *
   * Et ON NE PREND JAMAIS LES BORDS DE LA SOURCE. Roll20 coupe sa géométrie au
   * rectangle de la page, en plein milieu des cellules : le long de ce bord, il
   * ne reste que des demi-arêtes. Les recopier posait une colonne de moignons
   * pâles à chaque jointure — mesurée à vingt pixels en dedans du bord, soit une
   * demi-arête, répétée tous les 1540 px. Le pavé se prend donc au milieu, deux
   * périodes de marge de chaque côté. */
  var MARGE = 2;   // périodes écartées de chaque bord de la source

  /* `vals` sert à trouver la période et ne contient que l'intérieur ; `mini` et
   * `maxi` viennent de la source ENTIÈRE, car c'est la page qu'ils bornent. Les
   * confondre ferait couper notre trame au bord de l'intérieur, et Roll20
   * dessinerait deux rangées que nous redessinerions par-dessus. */
  function decalage(vals, mini, maxi, teste) {
    var v = vals.slice().sort(function (a, b) { return a - b; });
    var etendue = maxi - mini;
    var p = periode(v);
    if (!p || !(etendue > 0)) { return null; }

    var combien = etendue / p;
    var n = Math.floor(combien - 2 * MARGE);
    // Source trop courte pour se payer des marges : on prend ce qu'on peut.
    if (n < 1) { n = Math.max(1, Math.floor(combien)); }

    var verifie = false;
    while (n >= 1) {
      if (teste(n * p)) { verifie = true; break; }
      n--;
    }
    if (!verifie) { return null; }

    var pas = n * p;
    return { pas: pas, periode: Math.round(p * 10000) / 10000, periodesParTuile: n,
             mini: mini, maxi: maxi, etendue: etendue,
             origine: mini + (etendue - pas) / 2 };
  }

  function oteLesSegments() {
    paves.forEach(function (c) { try { c.dispose(); } catch (e) {} });
    paves = [];
  }

  /* MASQUER N'EST PAS DÉTRUIRE, et la différence coûte une compilation.
   *
   * Quand la grille de Roll20 s'absente un instant — il refait sa scène, il
   * change de page, il la masque le temps d'un rendu —, on détruisait tout, et
   * la pose suivante recompilait le shader. Répété toutes les secondes et demie,
   * c'est exactement le ralentissement qu'on a mis trois versions à chasser.
   * Un quad invisible ne coûte rien : on le range au lieu de le brûler. */
  /* ON RANGE LE QUAD, ON NE JETTE PAS L'ANALYSE.
   *
   * `derniere` retenait tout ce qu'on avait appris de la trame ; le mettre à
   * zéro ici obligeait à TOUT refaire au retour — relire quatre mille sept cents
   * segments, redétecter les périodes, réajuster la phase. Or Roll20 fait
   * s'absenter son maillage plusieurs fois pendant qu'il monte sa scène : c'est
   * une bonne part des sept poses relevées dans les quatre premières secondes.
   *
   * On ne garde que `paveSource = null`, qui dit au guet « il faudra repasser » ;
   * la signature, elle, décidera toute seule s'il y a vraiment quelque chose à
   * refaire. */
  function masquePeinture() {
    if (peint) { try { peint.isVisible = false; } catch (e) {} }
    paveSource = null;
  }

  function oteLesPaves() {
    oteLesSegments();
    paveSource = null;
    derniere = null;
    if (peint) { try { peint.dispose(true, true); } catch (e) {} }
    peint = null;
    // Ceinture : un rechargement de scène a pu laisser des orphelins.
    try {
      var S = window.MeshScene;
      (S && S.meshes ? S.meshes.slice() : []).forEach(function (m) {
        if (/^vttk-grille-/.test(m.name)) { try { m.dispose(true, true); } catch (e) {} }
      });
    } catch (e) {}
  }

  /* ---------- UN SEUL MAILLAGE, PAS CENT SOIXANTE-HUIT COPIES ----------
   *
   * La première version clonait le maillage une fois par tuile. Ça marchait, et
   * c'était mauvais sur les deux plans qui comptent.
   *
   * LE DESSIN. La géométrie porte une colonne de lignes à CHACUNE de ses deux
   * extrémités : deux tuiles adjacentes dessinent donc la même ligne au même
   * endroit. À une opacité de 0,5, deux traits superposés en font un à 0,75 —
   * une ligne plus marquée tous les 1540 pixels. Aucune translation ne peut
   * l'éviter : c'est la géométrie qui est inclusive de ses deux bords.
   *
   * LE COÛT. Cent soixante-huit maillages, c'est cent soixante-huit appels de
   * rendu par image, pour une grille.
   *
   * On construit donc UN maillage, dont les segments sont ceux de l'original
   * répétés. Un appel de rendu.
   *
   * ---------- ET ON DÉCOUPE, ON NE DÉDOUBLONNE PAS ----------
   *
   * La version d'avant répétait toute la source puis écartait les segments déjà
   * vus. Ça supprimait bien les lignes doublées, et ça en créait de PÂLES : la
   * mesure est sans appel — Roll20 trace 250 lignes solitaires, toutes au bord
   * de sa page ; nous en avions 3 436, dont 2 358 en plein milieu. Car Roll20
   * dessine ses hexagones un par un : chaque arête intérieure est tracée DEUX
   * fois, et c'est ce qui lui donne son épaisseur. En écarter une sur deux à la
   * jointure faisait un trait deux fois plus clair — une couture, tout aussi
   * visible qu'un trait deux fois plus sombre.
   *
   * On ne compare donc plus rien. On PARTITIONNE : chaque segment appartient à
   * la tuile où tombe son MILIEU, dans un pavé semi-ouvert [origine, origine +
   * pas). Comme deux segments superposés ont le même milieu, ils voyagent
   * ensemble — les arêtes doubles de Roll20 restent doubles, les simples restent
   * simples, et chaque ligne de la trame est tracée exactement autant de fois
   * qu'il le fait lui-même. Ni doublon ni pâleur, et plus aucune table.
   *
   * Le maillage est un LineList : les indices vont deux par deux, chaque paire
   * est un segment. */
  /* LE BUDGET, ET IL EST SÉRIEUX.
   *
   * Il était à 400 000, c'est-à-dire nulle part : rien ne l'atteignait, et il ne
   * protégeait donc de rien. En corrigeant l'unité de « case » — une case vaut
   * 70 px et non 46 — le halo est passé de 2764 à 4200 px, la surface a plus que
   * doublé, et l'hexagone est monté de 91 000 à 232 000 segments d'un coup.
   * Chez moi le rendu tenait les soixante images par seconde ; ailleurs non, et
   * c'est ailleurs que ça compte. On se cale donc sur ce qui a tourné : 120 000,
   * et le halo se réduit quand il le faut — en le DISANT. */
  /* LE BUDGET DU REPLI, ET IL EST SÉVÈRE EXPRÈS. Le pavage en segments n'est
   * plus la voie normale : il ne sert que si le shader refuse de compiler. Dans
   * ce cas on veut une grille QUI TOURNE, pas une grille complète — quarante
   * mille segments plutôt que deux cent trente mille, quitte à réduire le halo
   * et à le dire. */
  var MAX_SEGMENTS = 40000;
  var ECHARDE = 0.05;          // en deçà, ce n'est pas un trait, c'est du flottant

  /* On écrit dans un tableau typé, dimensionné d'avance. Un tableau JavaScript
   * ordinaire qui grandit d'un million et demi de nombres, c'est autant de
   * réallocations, une conversion de plus au moment de le donner à Babylon, et
   * le ramasse-miettes derrière. */
  function ecrivain(max, z) {
    return {
      t: new Float32Array(max), n: 0, z: z,
      seg: function (x0, y0, x1, y1) {
        var t = this.t, n = this.n;
        if (n + 6 > t.length) { return; }
        t[n] = x0; t[n + 1] = y0; t[n + 2] = this.z;
        t[n + 3] = x1; t[n + 4] = y1; t[n + 5] = this.z;
        this.n = n + 6;
      }
    };
  }

  /* CE QUI TOMBE SUR LA PAGE N'EST PAS ÉMIS — C'EST ROLL20 QUI LE DESSINE.
   * Mais on le COUPE à son bord, on ne le saute pas : il tronque sa géométrie
   * au rectangle de la page, et la moitié extérieure d'un côté qui l'enjambe ne
   * serait dessinée par personne.
   *
   * On coupe sur le bord EXACT, sans marge — une marge d'un demi-pixel laisse un
   * jeu du même ordre à chaque segment coupé, et le banc le voit. Ce qui absorbe
   * le flottant, c'est un seuil sur la LONGUEUR : une ligne tracée pile le long
   * de la bordure a ses sommets dessus au millième près et ressort en écharde
   * d'un millionième de pixel, qu'on jette. Sans ce garde-fou elle revenait
   * par-dessus la sienne — le banc en comptait quatre.
   *
   * Liang-Barsky donne l'intervalle [t0, t1] qui est DEDANS ; on émet le
   * complément. */
  function decoupe(out, page, X0, Y0, X1, Y1, cpt) {
    var ex = X1 - X0, ey = Y1 - Y0;
    var t0 = 0, t1 = 1, dedans = true, e, p, q, r;
    for (e = 0; e < 4 && dedans; e++) {
      p = e === 0 ? -ex : e === 1 ? ex : e === 2 ? -ey : ey;
      q = e === 0 ? X0 - page.x0 : e === 1 ? page.x1 - X0
        : e === 2 ? Y0 - page.y0 : page.y1 - Y0;
      if (p === 0) { if (q < 0) { dedans = false; } continue; }
      r = q / p;
      if (p < 0) { if (r > t1) { dedans = false; } else if (r > t0) { t0 = r; } }
      else { if (r < t0) { dedans = false; } else if (r < t1) { t1 = r; } }
    }
    if (!dedans || t0 >= t1) { out.seg(X0, Y0, X1, Y1); return; }
    var lg = Math.sqrt(ex * ex + ey * ey), seuil = lg > 0 ? ECHARDE / lg : 1;
    var avant = t0 > seuil, apres = t1 < 1 - seuil;
    if (!avant && !apres) { cpt.surPage++; return; }   // tout entier à lui
    cpt.coupes++;
    if (avant) { out.seg(X0, Y0, X0 + t0 * ex, Y0 + t0 * ey); }
    if (apres) { out.seg(X0 + t1 * ex, Y0 + t1 * ey, X1, Y1); }
  }

  /* ---------- UN SEUL MAILLAGE, PAS CENT SOIXANTE-HUIT COPIES ----------
   * Cent soixante-huit maillages, c'est cent soixante-huit appels de rendu par
   * image, pour une grille. On en construit UN, avec une géométrie propre au
   * clone — sans quoi on écrirait dans celle de Roll20. */
  function poseLeMaillage(m, out, infos) {
    oteLesPaves();
    paveSource = m;   // on retient CE maillage : c'est lui qu'on surveille
    var c = null;
    try {
      c = m.clone("vttk-grille-etendue");
      if (!c) { return { ok: false, raison: "clone-refuse" }; }
      if (c.makeGeometryUnique) { c.makeGeometryUnique(); }
      var sommets = out.n / 3, i;
      var ind = new Uint32Array(sommets);
      for (i = 0; i < sommets; i++) { ind[i] = i; }
      c.setVerticesData("position", out.t.subarray(0, out.n), false);
      c.setIndices(ind, sommets);
      c.position.x = m.position.x;
      c.position.y = m.position.y;
      c.computeWorldMatrix(true);
      if (c.refreshBoundingInfo) { c.refreshBoundingInfo(); }
      /* CE MAILLAGE NE BOUGERA PLUS. Il n'est ni déplaçable ni cliquable, et sa
       * matrice est acquise — autant le dire à Babylon, qui cessera de la
       * recalculer et de synchroniser sa boîte à chaque image. Roll20 gèle la
       * sienne ; la nôtre ne l'était pas, et elle est trente fois plus grosse. */
      c.isPickable = false;
      c.doNotSyncBoundingInfo = true;
      if (c.freezeWorldMatrix) { c.freezeWorldMatrix(); }
      paves.push(c);
    } catch (e) {
      try { if (c) { c.dispose(); } } catch (e2) {}
      paves = [];
      paveSource = null;
      return { ok: false, raison: "geometrie-non-remplacable" };
    }
    infos.ok = true;
    infos.segments = out.n / 6;
    return infos;
  }

  function cent(v) { return Math.round(v * 100) / 100; }

  /* ---------- LES GRILLES DE CELLULES : hexagones ----------
   *
   * On répète un pavé, et on le prend par le MILIEU des segments : deux segments
   * superposés ayant le même milieu, ils voyagent ensemble. Les arêtes que
   * Roll20 trace deux fois — il dessine ses hexagones un par un, et c'est ce qui
   * donne son épaisseur à sa trame — restent doubles ; les simples restent
   * simples. Ni doublon ni pâleur, et aucune table à tenir. */
  function paveCellules(g, bb, cases, m) {
    var seg = g.seg, tab = tableDe(seg), i, s;

    /* LA PÉRIODE SE CHERCHE SUR L'INTÉRIEUR, JAMAIS SUR LES BORDS.
     *
     * Roll20 coupe sa géométrie au rectangle de la page, et une arête coupée a
     * des coordonnées quelconques, hors trame. Elles sont nombreuses — deux
     * rangées entières le long de chaque bord — et, pire, elles se répètent au
     * pas des CELLULES et non à celui de la trame : sur une trame hexagonale,
     * une rangée sur deux seulement touche un bord donné. La détection y voyait
     * donc une période DOUBLE, et c'est ce qui rendait 118,135 pour « hexr » là
     * où le réseau vaut 121,2436, et 34,64 au lieu de 17,32 au banc.
     *
     * On écarte donc tout segment qui touche le bord de la source. S'il n'en
     * reste pas assez pour conclure, on reprend tout : une réponse approximative
     * vaut mieux que pas de grille du tout. */
    var xs = [], ys = [], xsTout = [], ysTout = [];
    for (i = 0; i < seg.length; i++) {
      s = seg[i];
      xsTout.push(s[0], s[2]); ysTout.push(s[1], s[3]);
      if (s[0] <= bb.x0 + TOL_SEG || s[2] >= bb.x1 - TOL_SEG ||
          Math.min(s[1], s[3]) <= bb.y0 + TOL_SEG ||
          Math.max(s[1], s[3]) >= bb.y1 - TOL_SEG) { continue; }
      xs.push(s[0], s[2]); ys.push(s[1], s[3]);
    }
    if (xs.length < 16) { xs = xsTout; ys = ysTout; }

    var bande = medianeLongueur(seg) * 1.5;
    var dx = decalage(xs, bb.x0, bb.x1,
      function (pas) { return symetrie(seg, tab, bb, bande, pas, 0); });
    var dy = decalage(ys, bb.y0, bb.y1,
      function (pas) { return symetrie(seg, tab, bb, bande, 0, pas); });
    if (!dx || !dy) { return { ok: false, raison: "aucun-pas-symetrique" }; }

    var bx0 = dx.origine, bx1 = dx.origine + dx.pas;
    var by0 = dy.origine, by1 = dy.origine + dy.pas;
    var pave = [], mx, my;
    for (i = 0; i < seg.length; i++) {
      s = seg[i];
      mx = (s[0] + s[2]) / 2; my = (s[1] + s[3]) / 2;
      // Semi-ouvert : le segment posé pile sur la frontière haute appartient à
      // la tuile d'après, jamais aux deux.
      if (mx < bx0 || mx >= bx1 || my < by0 || my >= by1) { continue; }
      pave.push(s);
    }
    if (!pave.length) { return { ok: false, raison: "pave-vide" }; }

    /* L'UNITÉ DE « CASE » EST LA MÊME SUR LES DEUX AXES, et la même que celle du
     * quadrillage carré : la case de Roll20 fait 70 px, et sur une trame
     * hexagonale la plus petite des deux périodes en vaut exactement la moitié —
     * 35 pour « hex » comme pour « hexr », l'axe changeant mais pas la valeur.
     * Sans ça, « 60 cases » achetait 4200 px en carré et 2764 en hexagonal, et
     * le halo de « hex » sortait plus étroit que haut alors que les écrans sont
     * en paysage. */
    var unite = 2 * Math.min(dx.periode, dy.periode);
    var vise = cases * unite;
    function combien(d) {
      return Math.max(1, Math.ceil((vise + d.etendue / 2 - d.pas / 2) / d.pas));
    }
    var tx = combien(dx), ty = combien(dy), voulu = [tx, ty];
    // On borne par le TRAVAIL, pas par un nombre de tuiles choisi au hasard, et
    // on rabote le plus grand des deux côtés pour garder un halo carré.
    while ((tx > 1 || ty > 1) && pave.length * (2 * tx + 1) * (2 * ty + 1) > MAX_SEGMENTS) {
      if (tx >= ty && tx > 1) { tx--; } else if (ty > 1) { ty--; } else { break; }
    }
    var rabote = tx < voulu[0] || ty < voulu[1];

    var page = { x0: dx.mini, x1: dx.maxi, y0: dy.mini, y1: dy.maxi };
    var cpt = { surPage: 0, coupes: 0 };
    // Deux morceaux au plus par segment découpé : c'est la borne haute exacte.
    var out = ecrivain(pave.length * (2 * tx + 1) * (2 * ty + 1) * 12, g.z);
    var a, b, ox, oy, j;
    for (a = -tx; a <= tx; a++) {
      for (b = -ty; b <= ty; b++) {
        ox = a * dx.pas; oy = b * dy.pas;
        for (j = 0; j < pave.length; j++) {
          s = pave[j];
          decoupe(out, page, s[0] + ox, s[1] + oy, s[2] + ox, s[3] + oy, cpt);
        }
      }
    }

    var atteint = Math.round(Math.min(tx * dx.pas + dx.pas / 2 - dx.etendue / 2,
                                      ty * dy.pas + dy.pas / 2 - dy.etendue / 2));
    return poseLeMaillage(m, out, {
      mode: "cellules", cases: cases, tuiles: [2 * tx + 1, 2 * ty + 1],
      source: pave.length, surPage: cpt.surPage, coupes: cpt.coupes,
      degeneres: g.degeneres, halo: atteint, haloVoulu: Math.round(vise), rabote: rabote,
      pas: [cent(dx.pas), cent(dy.pas)],
      motifs: [dx.periodesParTuile, dy.periodesParTuile],
      periodes: [cent(dx.periode), cent(dy.periode)]
    });
  }

  /* ---------- LES GRILLES DE DROITES : isométrique et dimétrique ----------
   *
   * Elles ne sont pas faites de cellules mais de longues diagonales qui
   * traversent la page de part en part. Les paver comme des cellules n'a aucun
   * sens, et c'est ce qui les a cassées : le domaine fondamental garde les
   * segments dont le MILIEU y tombe, or le milieu d'une droite rognée par la
   * page ne dit rien de sa place dans le réseau. Sur quatre-vingt-huit droites,
   * dix-sept disparaissaient purement et simplement, et les autres se
   * recouvraient.
   *
   * On les traite donc pour ce qu'elles sont : des FAMILLES de parallèles. Pour
   * chaque direction on relève le DÉCALAGE PERPENDICULAIRE de chaque droite —
   * la seule grandeur qui la situe, et qui ne dépend ni de sa longueur ni de
   * l'endroit où la page l'a coupée. Ces décalages, eux, sont bel et bien
   * alignés sur une dimension : leur période a un sens. On redessine alors la
   * famille sur toute l'étendue voulue. Rien de rogné à recopier, aucun
   * recouvrement possible, et cent fois moins de segments. */
  function droiteDansRect(ux, uy, off, r) {
    var px = -uy * off, py = ux * off;
    var t0 = -Infinity, t1 = Infinity, e, p, q, tt;
    for (e = 0; e < 4; e++) {
      p = e === 0 ? -ux : e === 1 ? ux : e === 2 ? -uy : uy;
      q = e === 0 ? px - r.x0 : e === 1 ? r.x1 - px : e === 2 ? py - r.y0 : r.y1 - py;
      if (p === 0) { if (q < 0) { return null; } continue; }
      tt = q / p;
      if (p < 0) { if (tt > t0) { t0 = tt; } } else if (tt < t1) { t1 = tt; }
    }
    if (!(t1 > t0)) { return null; }
    return [px + t0 * ux, py + t0 * uy, px + t1 * ux, py + t1 * uy];
  }

  /* Les familles de parallèles, lues une bonne fois : la peinture et le pavage
   * de repli s'en servent tous les deux, et deux lectures finiraient par ne plus
   * dire la même chose. */
  function famillesDe(seg) {
    var i, s, k;
    var parDir = Object.create(null), cles = [];
    for (i = 0; i < seg.length; i++) {
      s = seg[i];
      var ex = s[2] - s[0], ey = s[3] - s[1];
      var L = Math.sqrt(ex * ex + ey * ey);
      if (L < 1) { continue; }
      var ux = ex / L, uy = ey / L;
      if (ux < 0 || (ux === 0 && uy < 0)) { ux = -ux; uy = -uy; }
      var cle = Math.round(ux * 2000) + "," + Math.round(uy * 2000);
      if (!parDir[cle]) { parDir[cle] = { ux: ux, uy: uy, off: [] }; cles.push(cle); }
      parDir[cle].off.push(-uy * s[0] + ux * s[1]);
    }

    var familles = [];
    for (k = 0; k < cles.length; k++) {
      var f = parDir[cles[k]];
      var o = f.off.slice().sort(function (a2, b2) { return a2 - b2; });
      var dist = [], mult = [];
      for (i = 0; i < o.length; i++) {
        if (dist.length && o[i] - dist[dist.length - 1] < 0.05) { mult[mult.length - 1]++; continue; }
        dist.push(o[i]); mult.push(1);
      }
      // Une ou deux droites parallèles isolées, ce n'est pas une famille : c'est
      // le cadre de la page, que Roll20 dessine dans le même maillage.
      if (dist.length < 3) { continue; }
      var p = periode(dist);
      if (!(p > 0)) { continue; }

      // Multiplicité : la plus fréquente, pour ignorer les bords.
      var compte = {}, meilleure = 1, cbMax = 0, n2;
      for (i = 0; i < mult.length; i++) { compte[mult[i]] = (compte[mult[i]] || 0) + 1; }
      for (n2 in compte) { if (compte[n2] > cbMax) { cbMax = compte[n2]; meilleure = +n2; } }

      /* LE MOTIF : les décalages d'UNE période. Une famille régulière n'en a
       * qu'un ; une famille en paires en a deux, et c'est prévu.
       *
       * On prend le reste par rapport au multiple LE PLUS PROCHE, et non le
       * modulo. Le modulo ne recolle pas ce qui frôle la période par en dessous,
       * et il suffit d'un millième de dérive sur la période pour qu'au
       * quarantième pas le reste tombe à 62,52 au lieu de 0 : la famille
       * paraissait alors avoir trois motifs au lieu d'un, on traçait ses droites
       * trois fois trop serrées, et la trame sortait DEUX fois trop dense —
       * mesuré à 200 % sur « dimetric ». Le rapprochement se fait ensuite à un
       * vingtième de période, très au-dessus de toute dérive et très en dessous
       * du plus petit écart réel. */
      var base = dist[0], motif = [], r2, q2, trouve;
      var tolMotif = p / 20;
      for (i = 0; i < dist.length; i++) {
        r2 = dist[i] - base;
        r2 -= p * Math.round(r2 / p);
        trouve = false;
        for (q2 = 0; q2 < motif.length && !trouve; q2++) {
          if (Math.abs(motif[q2] - r2) < tolMotif) { trouve = true; }
        }
        if (!trouve) { motif.push(r2); }
      }
      familles.push({ ux: f.ux, uy: f.uy, base: base, p: p,
                      motif: motif, mult: meilleure, nb: dist.length });
    }
    familles.sort(function (a2, b2) { return b2.nb - a2.nb; });
    return familles;
  }

  /* L'unité de « case » pour une grille de droites : le côté du carré de même
   * aire que la maille formée par les deux familles les plus fournies. Même
   * grandeur que pour les hexagones, donc même sens pour le réglage. */
  function uniteDroites(familles) {
    var f1 = familles[0], f2 = null, sinus = 0, i;
    for (i = 1; i < familles.length; i++) {
      var sn = Math.abs(f1.ux * familles[i].uy - f1.uy * familles[i].ux);
      if (sn > 0.2) { f2 = familles[i]; sinus = sn; break; }
    }
    var e1 = f1.p / f1.motif.length;
    return f2 ? Math.sqrt(e1 * (f2.p / f2.motif.length) / sinus) : e1;
  }

  function paveDroites(g, bb, cases, m) {
    var seg = g.seg, i;
    var familles = famillesDe(seg);
    if (!familles.length) { return { ok: false, raison: "aucune-famille" }; }

    var unite = uniteDroites(familles);

    function compteDroites(vise) {
      var cible = { x0: bb.x0 - vise, x1: bb.x1 + vise, y0: bb.y0 - vise, y1: bb.y1 + vise };
      var n = 0, j, F, coins, omin, omax, oo, c;
      for (j = 0; j < familles.length; j++) {
        F = familles[j];
        coins = [[cible.x0, cible.y0], [cible.x1, cible.y0],
                 [cible.x0, cible.y1], [cible.x1, cible.y1]];
        omin = Infinity; omax = -Infinity;
        for (c = 0; c < 4; c++) {
          oo = -F.uy * coins[c][0] + F.ux * coins[c][1];
          omin = Math.min(omin, oo); omax = Math.max(omax, oo);
        }
        n += Math.ceil((omax - omin) / F.p) * F.motif.length * F.mult;
      }
      return { n: n, cible: cible };
    }

    var voulu = cases * unite, vise = voulu, etat = compteDroites(vise);
    // Chaque droite peut sortir en deux morceaux : c'est la borne haute.
    while (vise > unite && etat.n * 2 > MAX_SEGMENTS) {
      vise *= 0.8;
      etat = compteDroites(vise);
    }
    var cible = etat.cible;

    var page = { x0: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1 };
    var cpt = { surPage: 0, coupes: 0 };
    var out = ecrivain(etat.n * 12 + 60, g.z);
    var droites = 0, j2, F2, mi, kk, off, d, r3;
    for (j2 = 0; j2 < familles.length; j2++) {
      F2 = familles[j2];
      var coins2 = [[cible.x0, cible.y0], [cible.x1, cible.y0],
                    [cible.x0, cible.y1], [cible.x1, cible.y1]];
      var omin2 = Infinity, omax2 = -Infinity, c2, oo2;
      for (c2 = 0; c2 < 4; c2++) {
        oo2 = -F2.uy * coins2[c2][0] + F2.ux * coins2[c2][1];
        omin2 = Math.min(omin2, oo2); omax2 = Math.max(omax2, oo2);
      }
      for (mi = 0; mi < F2.motif.length; mi++) {
        var o0 = F2.base + F2.motif[mi];
        var kmin = Math.ceil((omin2 - o0) / F2.p), kmax = Math.floor((omax2 - o0) / F2.p);
        for (kk = kmin; kk <= kmax; kk++) {
          off = o0 + kk * F2.p;
          d = droiteDansRect(F2.ux, F2.uy, off, cible);
          if (!d) { continue; }
          droites++;
          for (r3 = 0; r3 < F2.mult; r3++) {
            decoupe(out, page, d[0], d[1], d[2], d[3], cpt);
          }
        }
      }
    }

    return poseLeMaillage(m, out, {
      mode: "droites", cases: cases, familles: familles.length, droites: droites,
      source: seg.length, surPage: cpt.surPage, coupes: cpt.coupes,
      degeneres: g.degeneres, halo: Math.round(vise),
      haloVoulu: Math.round(voulu), rabote: vise < voulu - 1,
      ecarts: familles.map(function (F) { return cent(F.p / F.motif.length); }),
      periodes: familles.map(function (F) { return cent(F.p); }),
      motifs: familles.map(function (F) { return F.motif.length; }),
      lues: familles.map(function (F) { return F.nb; }),
      multiplicites: familles.map(function (F) { return F.mult; })
    });
  }

  /* ============================================================
   * LA GRILLE PEINTE — six sommets au lieu de quatre-vingt-neuf mille segments
   * ============================================================
   *
   * On répétait la géométrie de Roll20 : 89 000 segments pour un halo moyen,
   * 232 000 pour un large. Ça ramait, et c'était perdu d'avance — le coût suit
   * la SURFACE du halo, donc le carré de ce que l'utilisateur demande.
   *
   * Or Roll20 lui-même ne fait pas ça. Sa grille CARRÉE est un quad de six
   * sommets avec un shader qui la calcule au pixel : elle ne coûte rien, et
   * c'est le seul type dont personne ne s'est jamais plaint. On fait pareil pour
   * les quatre autres.
   *
   * Un quad, un shader, un appel de rendu. Le coût ne dépend plus du halo mais
   * de la surface à l'écran, et il est le même à dix cases qu'à quatre cents.
   * Le trait garde une épaisseur constante à l'écran quel que soit le zoom,
   * comme un LinesMesh, parce que fwidth() donne la taille d'un pixel en unités
   * monde sans qu'on ait à suivre le zoom.
   *
   * On ne peint RIEN sur la page : Roll20 y dessine déjà, et le shader écarte
   * ces fragments. */
  var VS_GRILLE =
    "precision highp float;\n" +
    "attribute vec3 position;\n" +
    "uniform mat4 world;\n" +
    "uniform mat4 worldViewProjection;\n" +
    "uniform vec2 decalage;\n" +
    "varying vec2 vMonde;\n" +
    /* ON TRAVAILLE DANS LE REPÈRE DU MAILLAGE DE ROLL20, PAS DANS LE MONDE.
     *
     * C'est le défaut qui décalait les quatre types peints d'une demi-cellule.
     * Un maillage Babylon porte des sommets en coordonnées LOCALES et une
     * position qui les emmène dans le monde ; celui de la grille hexagonale est
     * à (35 ; -40,41). Tant qu'on clonait sa géométrie la question ne se posait
     * pas — le clone héritait de sa position, les deux repères restaient
     * confondus. Un shader, lui, reçoit la position MONDE du fragment, et toute
     * notre trame est mesurée en local : 35 px d'écart, soit exactement une
     * demi-largeur d'hexagone. Le carré, qu'on ne peint pas, était le seul à
     * rester juste — et c'est ce qui a mis sur la voie.
     *
     * On retranche donc sa position, une fois, ici. */
    "void main(void) {\n" +
    "  vMonde = (world * vec4(position, 1.0)).xy - decalage;\n" +
    "  gl_Position = worldViewProjection * vec4(position, 1.0);\n" +
    "}\n";

  var FS_GRILLE =
    "precision highp float;\n" +
    "varying vec2 vMonde;\n" +
    "uniform vec4 page;\n" +        // x0, y0, x1, y1 — ce que Roll20 dessine
    "uniform vec3 couleur;\n" +
    "uniform float opacite;\n" +
    "uniform float epaisseur;\n" +  // en pixels d'écran
    "uniform float mode;\n" +       // 0 = hexagones, 1 = droites
    "uniform vec2 origine;\n" +
    "uniform vec2 taille;\n" +      // hexagones : (largeur plat-à-plat, écart de rangée)
    "uniform float aplati;\n" +     // 1 si les hexagones ont le sommet plat
    "uniform float nbFamilles;\n" +
    "uniform vec4 familles[4];\n" + // droites : (nx, ny, écart, phase)
    "\n" +
    /* La distance au bord d'hexagone le plus proche. Le centre se trouve en
     * comparant DEUX candidats : le réseau hexagonal est l'union de deux
     * réseaux rectangulaires décalés, et le plus proche des deux est le bon. */
    "float distHexagone(vec2 p) {\n" +
    "  vec2 q = p - origine;\n" +
    "  if (aplati > 0.5) { q = vec2(q.y, -q.x); }\n" +
    "  float w = taille.x, h = taille.y;\n" +
    "  vec2 a = vec2(w, 2.0 * h);\n" +
    "  vec2 c1 = floor(q / a + 0.5) * a;\n" +
    "  vec2 c2 = floor((q - a * 0.5) / a + 0.5) * a + a * 0.5;\n" +
    "  vec2 d1 = q - c1, d2 = q - c2;\n" +
    "  vec2 r = dot(d1, d1) < dot(d2, d2) ? d1 : d2;\n" +
    /* Trois normales d'arête suffisent : un hexagone régulier est l'intersection
     * de trois bandes, et sa frontière est à l'apothème w/2 de chacune. */
    "  float m = max(abs(r.x), max(abs(r.x * 0.5 + r.y * 0.8660254),\n" +
    "                              abs(r.x * -0.5 + r.y * 0.8660254)));\n" +
    "  return abs(m - w * 0.5);\n" +
    "}\n" +
    "\n" +
    "float distDroites(vec2 p) {\n" +
    "  float meilleur = 1.0e9;\n" +
    "  for (int i = 0; i < 4; i++) {\n" +
    "    if (float(i) >= nbFamilles) { break; }\n" +
    "    vec4 F = familles[i];\n" +
    "    float o = dot(p, F.xy) - F.w;\n" +
    "    float f = o - F.z * floor(o / F.z);\n" +
    "    meilleur = min(meilleur, min(f, F.z - f));\n" +
    "  }\n" +
    "  return meilleur;\n" +
    "}\n" +
    "\n" +
    "void main(void) {\n" +
    "  if (vMonde.x > page.x && vMonde.x < page.z &&\n" +
    "      vMonde.y > page.y && vMonde.y < page.w) { discard; }\n" +
    "  float d = mode < 0.5 ? distHexagone(vMonde) : distDroites(vMonde);\n" +
    /* La taille d'un pixel en unités monde, prise sur la POSITION et non sur la
     * distance : la distance saute d'une cellule à l'autre, et son gradient y
     * exploserait en un trait large. */
    "  float px = max(fwidth(vMonde.x), fwidth(vMonde.y));\n" +
    "  float a = 1.0 - smoothstep(-0.5 * px, 0.5 * px, d - epaisseur * 0.5 * px);\n" +
    "  if (a <= 0.004) { discard; }\n" +
    "  gl_FragColor = vec4(couleur, opacite * a);\n" +
    "}\n";

  /* Les classes de Babylon sans le global BABYLON, que la page n'expose pas :
   * on les prend sur des objets vivants. Tout maillage hérite de Mesh, donc de
   * sa fabrique de plans ; et le matériau d'une grille — « GridMaterial » pour
   * le carré, « colorShader » pour les LinesMesh — est un ShaderMaterial. */
  function classesDe(S, g) {
    var Maillage = null, i, m;
    for (i = 0; i < S.meshes.length && !Maillage; i++) {
      m = S.meshes[i];
      if (m && m.constructor && m.constructor.CreatePlane) { Maillage = m.constructor; }
    }
    var Shader = g && g.material && g.material.constructor;
    return (Maillage && Shader) ? { Maillage: Maillage, Shader: Shader } : null;
  }

  /* Poser la peinture. `reseau` dit ce qu'il faut dessiner, `page` ce qu'il ne
   * faut pas.
   *
   * ON NE RECRÉE JAMAIS LE MATÉRIAU. C'est la correction qui manquait, et elle
   * pesait lourd : compiler un programme GLSL prend une centaine de
   * millisecondes et BLOQUE le fil. Au chargement d'une partie, le module
   * réessaie toutes les 400 ms tant que la scène n'est pas prête, et le guet
   * repose dès que Roll20 remplace son maillage — mesuré : SEPT poses dans les
   * quatre premières secondes, et une image à 834 ms. Sept compilations à la
   * suite, pour un shader qui n'a jamais changé d'une ligne.
   *
   * Le quad et son matériau vivent donc aussi longtemps que le module : reposer,
   * c'est écrire des uniformes et une échelle. Le shader se compile UNE fois par
   * page, et jamais plus. */
  function posePeinture(m, reseau, page, portee, aspect) {
    var S = window.MeshScene;
    var cl = classesDe(S, m);
    if (!cl) { return { ok: false, raison: "classes-babylon-introuvables" }; }
    if (paves.length) { oteLesSegments(); }   // on ne garde jamais les deux voies

    var vivant = peint && !(peint.isDisposed && peint.isDisposed()) && peint.material;
    var mat = vivant ? peint.material : null;
    var plan = vivant ? peint : null;
    try {
      if (!vivant) {
        if (peint) { try { peint.dispose(true, true); } catch (e) {} peint = null; }
        mat = new cl.Shader("vttk-grille-peinte", S,
          { vertexSource: VS_GRILLE, fragmentSource: FS_GRILLE },
          { attributes: ["position"],
            uniforms: ["world", "worldViewProjection", "decalage", "page", "couleur",
                       "opacite", "epaisseur", "mode", "origine", "taille", "aplati",
                       "nbFamilles", "familles"] });
      }
      mat.setArray2("decalage", [m.position.x, m.position.y]);
      mat.setArray4("page", [page.x0, page.y0, page.x1, page.y1]);
      mat.setArray3("couleur", aspect.couleur);
      mat.setFloat("opacite", aspect.opacite);
      mat.setFloat("epaisseur", aspect.epaisseur);
      mat.setFloat("mode", reseau.mode === "droites" ? 1 : 0);
      mat.setArray2("origine", reseau.origine || [0, 0]);
      mat.setArray2("taille", reseau.taille || [70, 60.62]);
      mat.setFloat("aplati", reseau.aplati ? 1 : 0);
      mat.setFloat("nbFamilles", reseau.familles ? reseau.familles.length : 0);
      if (reseau.familles && reseau.familles.length) {
        var plat = [], k;
        for (k = 0; k < 4; k++) {
          var F = reseau.familles[k] || [0, 0, 1, 0];
          plat.push(F[0], F[1], F[2], F[3]);
        }
        mat.setArray4("familles", plat);
      }
      mat.backFaceCulling = false;
      mat.alpha = 0.999;   // force le passage en transparence

      if (!plan) {
        plan = cl.Maillage.CreatePlane("vttk-grille-peinte", 1, S);
        plan.material = mat;
      } else if (plan.unfreezeWorldMatrix) {
        plan.unfreezeWorldMatrix();   // on va rechanger son échelle
      }
      plan.scaling.x = portee.largeur;
      plan.scaling.y = portee.hauteur;
      /* Le centre du halo est calculé dans SON repère : on le remet dans le
       * monde en ajoutant sa position, sans quoi le quad couvre le bon
       * rectangle au mauvais endroit. */
      plan.position.x = m.position.x + portee.cx;
      plan.position.y = m.position.y + portee.cy;
      plan.position.z = m.position.z;
      plan.renderingGroupId = m.renderingGroupId;
      plan.alphaIndex = m.alphaIndex;
      plan.isPickable = false;
      plan.isVisible = true;   // il a pu être rangé pendant une absence de grille
      plan.computeWorldMatrix(true);
      if (plan.refreshBoundingInfo) { plan.refreshBoundingInfo(); }
      plan.alwaysSelectAsActiveMesh = true;
      if (plan.freezeWorldMatrix) { plan.freezeWorldMatrix(); }
      /* ON NE FORCE PLUS LA COMPILATION ICI.
       *
       * `isReady()` compile le programme GLSL sur-le-champ, et ça bloque : 50 ms
       * mesurées à la première pose, contre 3 aux suivantes. C'était le dernier
       * gros poste du module, et il tombait au chargement de la partie —
       * exactement là où une machine modeste n'a rien à donner.
       *
       * Babylon compile de lui-même au premier rendu, et sait le faire en
       * parallèle quand le pilote graphique l'accepte. On le laisse faire, et
       * c'est le GUET qui vérifiera, un tour plus tard, que l'effet n'a pas
       * échoué — voir verifieGrille. Un shader refusé fait alors basculer sur le
       * pavage en segments, avec un tour de retard au lieu d'un blocage. */
      attenteEffet = 0;
      peint = plan;
    } catch (e) {
      try { if (plan) { plan.dispose(true, true); } else if (mat) { mat.dispose(); } } catch (e2) {}
      peint = null;
      return { ok: false, raison: "shader-refuse", detail: String(e && e.message || e) };
    }
    return { ok: true };
  }

  /* ---------- LA TRAME HEXAGONALE, AJUSTÉE ET VÉRIFIÉE ----------
   *
   * Le shader a besoin de trois choses : la largeur plat-à-plat, l'écart de
   * rangée, et la PHASE — où tombe un centre d'hexagone. Les deux premières se
   * lisent dans les périodes ; la troisième, non, et aucune formule ne la donne
   * sans supposer d'où Roll20 compte.
   *
   * On l'AJUSTE donc, puis on la VÉRIFIE : tous les sommets de sa géométrie sont
   * sur un bord d'hexagone, donc la distance du modèle doit y être nulle. On
   * balaie les phases possibles, on garde la meilleure, et on rend le résidu
   * avec. Un résidu qui dépasse le demi-pixel, et on n'y croit pas — on retombe
   * sur l'ancien pavage plutôt que d'afficher une trame fausse. */
  function distHex(px, py, w, h, ox, oy, plat) {
    var qx = px - ox, qy = py - oy, t;
    if (plat) { t = qx; qx = qy; qy = -t; }
    var ax = w, ay = 2 * h;
    var c1x = Math.floor(qx / ax + 0.5) * ax, c1y = Math.floor(qy / ay + 0.5) * ay;
    var c2x = Math.floor((qx - ax / 2) / ax + 0.5) * ax + ax / 2;
    var c2y = Math.floor((qy - ay / 2) / ay + 0.5) * ay + ay / 2;
    var d1x = qx - c1x, d1y = qy - c1y, d2x = qx - c2x, d2y = qy - c2y;
    var rx, ry;
    if (d1x * d1x + d1y * d1y < d2x * d2x + d2y * d2y) { rx = d1x; ry = d1y; }
    else { rx = d2x; ry = d2y; }
    var m = Math.max(Math.abs(rx),
                     Math.max(Math.abs(rx * 0.5 + ry * 0.8660254),
                              Math.abs(rx * -0.5 + ry * 0.8660254)));
    return Math.abs(m - w / 2);
  }

  function reseauHexagones(g, bb, px, py) {
    // Sommet pointu ou plat : le rapport des deux périodes le dit, et il vaut
    // racine de trois dans les deux cas — c'est lequel divise l'autre qui change.
    var w, h, plat;
    if (Math.abs(py / px - 1.7320508) < 0.02) { plat = false; w = 2 * px; h = py; }
    else if (Math.abs(px / py - 1.7320508) < 0.02) { plat = true; w = 2 * py; h = px; }
    else { return null; }   // ce n'est pas un pavage hexagonal régulier

    // Un échantillon de points qui sont TOUS sur un bord : sommets et milieux.
    var pts = [], i, s;
    var saut = Math.max(1, Math.floor(g.seg.length / 150));
    for (i = 0; i < g.seg.length; i += saut) {
      s = g.seg[i];
      if (s[0] <= bb.x0 + 1 || s[2] >= bb.x1 - 1 ||
          Math.min(s[1], s[3]) <= bb.y0 + 1 || Math.max(s[1], s[3]) >= bb.y1 - 1) { continue; }
      pts.push(s[0], s[1], (s[0] + s[2]) / 2, (s[1] + s[3]) / 2);
    }
    if (pts.length < 40) { return null; }

    function erreur(ox, oy) {
      var e = 0, k;
      for (k = 0; k < pts.length; k += 2) { e += distHex(pts[k], pts[k + 1], w, h, ox, oy, plat); }
      return e / (pts.length / 2);
    }

    /* LA PHASE NE SE CHERCHE PAS, ELLE SE DÉDUIT — et c'est six essais au lieu
     * de quatre cent quarante-huit.
     *
     * On la trouvait par balayage : seize par seize sur une maille, puis trois
     * resserrements. Ça marchait, et c'était cinq millisecondes sur les onze
     * que coûtait une pose — le poste le plus lourd de tout le module, chronomètre
     * en main.
     *
     * Or la phase n'a rien de continu. Tout sommet de la trame est un sommet
     * d'hexagone, donc son centre est à l'UNE DES SIX positions du sommet
     * correspondant. On prend un sommet intérieur, on essaie les six, on garde
     * le meilleur. Le résidu se juge ensuite comme avant : si aucun des six ne
     * tombe juste, le modèle est faux et on le dit. */
    var R = w / Math.sqrt(3);
    var offsets = [[0, R], [-w / 2, R / 2], [-w / 2, -R / 2],
                   [0, -R], [w / 2, -R / 2], [w / 2, R / 2]];
    // Le repère du calcul est celui de distHex, qui tourne d'un quart de tour
    // pour les sommets plats. On y amène le sommet de référence, et on ramènera
    // l'origine trouvée dans le repère d'origine.
    var vx = pts[0], vy = pts[1], t3;
    if (plat) { t3 = vx; vx = vy; vy = -t3; }
    var ox = 0, oy = 0, best = Infinity, k2, cx, cy, e;
    for (k2 = 0; k2 < 6; k2++) {
      cx = vx - offsets[k2][0];
      cy = vy - offsets[k2][1];
      // Retour dans le repère d'entrée : distHex refera la rotation lui-même.
      var rx = plat ? -cy : cx, ry = plat ? cx : cy;
      e = erreur(rx, ry);
      if (e < best) { best = e; ox = rx; oy = ry; }
    }
    return { mode: "hexagones", taille: [w, h], origine: [ox, oy], aplati: plat,
             residu: best, w: w, h: h };
  }

  /* L'aspect : on imite le sien, on ne l'invente pas.
   *
   * Et il faut CORRIGER L'OPACITÉ. Roll20 dessine ses hexagones un par un :
   * chaque arête intérieure est tracée deux fois, et à opacité a le résultat
   * vaut 1-(1-a)². Une trame peinte ne la trace qu'une fois ; sans correction
   * elle sortirait plus pâle que la sienne, exactement le défaut qu'on avait
   * mis une session à comprendre. */
  function aspectDe(m, double) {
    var c = [1, 1, 1], a = 0.5;
    try {
      if (m.color) { c = [m.color.r, m.color.g, m.color.b]; }
      if (typeof m.alpha === "number" && m.alpha > 0 && m.alpha <= 1) { a = m.alpha; }
      var mat = m.material;
      if (mat) {
        if (mat._colors3 && mat._colors3.color) {
          var k = mat._colors3.color;
          c = [k.r, k.g, k.b];
        }
        if (mat._floats && typeof mat._floats.opacity === "number") { a = mat._floats.opacity; }
      }
    } catch (e) {}
    return { couleur: c, opacite: double ? 1 - (1 - a) * (1 - a) : a,
             opaciteLue: a, epaisseur: 1 };
  }

  /* CELLULES OU DROITES ? La longueur médiane des segments le dit sans
   * ambiguïté : un côté d'hexagone fait quarante pixels sur une page qui en fait
   * mille cinq cents, une diagonale isométrique la traverse en entier. La
   * médiane, et non la moyenne : les quelques segments du cadre ne doivent pas
   * peser sur le choix. */
  /* LA SIGNATURE D'UNE GÉOMÉTRIE, en trois nombres et deux sommets. Assez pour
   * savoir qu'elle n'a pas bougé, assez peu pour ne rien coûter. */
  function signatureDe(m) {
    try {
      var p = m.getVerticesData("position"), i = m.getIndices();
      if (!p || !p.length) { return null; }
      /* LA POSITION EN FAIT PARTIE. Une géométrie identique déplacée est une
       * trame déplacée : sans elle dans la signature, on garderait un shader
       * calé sur l'ancien repère. */
      return (i ? i.length : 0) + "/" + p.length + "/" +
             Math.round(m.position.x * 100) + "," + Math.round(m.position.y * 100) + "/" +
             Math.round(p[0] * 100) + "," + Math.round(p[1] * 100) + "," +
             Math.round(p[p.length - 3] * 100) + "," + Math.round(p[p.length - 2] * 100);
    } catch (e) { return null; }
  }

  /* ON NE REFAIT RIEN QUAND RIEN N'A CHANGÉ.
   *
   * Le guet repasse toutes les secondes et demie, et le module réessaie toutes
   * les 400 ms au chargement. Sans ce garde-fou, chacun de ces passages relisait
   * quatre mille segments et rejouait l'ajustement de phase — pour aboutir
   * exactement au même résultat. On compare donc d'abord : même maillage, même
   * géométrie, même nombre de cases, et notre quad toujours vivant ? Alors il
   * n'y a rien à faire, et on le dit en un microseconde. */
  /* UNE HORLOGE FINE, ET UN DÉTAIL DE POSE.
   *
   * On a « optimisé » un tri de neuf mille valeurs sans que le temps de pose
   * bouge d'une milliseconde : c'était deviner, pas mesurer. Le pont chronomètre
   * donc ses propres étapes et les rend avec le résultat. Date.now() a une
   * résolution d'une milliseconde, ce qui est exactement l'ordre de grandeur
   * qu'on cherche à départager — performance.now() est cent fois plus fin. */
  var maintenant = (typeof performance !== "undefined" && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  var etapes = null;
  function etape(nom, depuis) {
    if (etapes) { etapes[nom] = Math.round((maintenant() - depuis) * 100) / 100; }
  }

  function paveGrille(m, cases) {
    var sig = signatureDe(m);
    var vivant = peint && !(peint.isDisposed && peint.isDisposed());
    /* ON SE FIE À LA GÉOMÉTRIE, PAS À L'IDENTITÉ DU MAILLAGE.
     *
     * Pendant qu'il monte sa scène, Roll20 remplace son maillage de grille
     * plusieurs fois — par la MÊME géométrie. Comparer les objets faisait tout
     * refaire à chaque remplacement ; comparer leur signature ne fait rien du
     * tout, ce qui est exactement juste : la trame n'a pas bougé d'un pixel.
     * On se contente de retenir le nouveau maillage, pour que le guet surveille
     * celui qui vit. */
    if (vivant && derniere && derniere.cases === cases &&
        derniere.sig === sig && sig !== null) {
      paveSource = m;
      /* LE QUAD A PU ÊTRE RANGÉ pendant une absence de grille : le chemin rapide
       * ne passe pas par posePeinture, c'est donc ici qu'il faut le ressortir.
       * L'oublier laisserait une grille invisible pour de bon — une panne totale
       * et silencieuse, qui ne se verrait que sur une machine assez lente pour
       * que l'absence dure. */
      if (!peint.isVisible) { peint.isVisible = true; }
      /* ET LE TEMPS RENDU EST CELUI DU COUP DE CACHE, PAS DE LA POSE D'ORIGINE.
       * On renvoyait l'objet mémorisé tel quel, `ms` compris : le journal
       * affichait « en 9 ms » pour un coup de cache qui n'avait rien coûté, et
       * plus personne ne pouvait distinguer les deux. Un instrument qui ment est
       * pire que pas d'instrument. */
      var vite = {}, q;
      for (q in derniere.infos) { vite[q] = derniere.infos[q]; }
      vite.ms = 0;
      vite.cache = true;
      return vite;
    }
    var chrono = maintenant();
    etapes = {};
    var r = paveSelonLaForme(m, cases);
    if (r && r.ok) {
      r.ms = Math.round((maintenant() - chrono) * 100) / 100;
      r.etapes = etapes;
      if (r.mode === "peinture") { derniere = { cases: cases, sig: sig, infos: r }; }
      else { derniere = null; }
    }
    return r;
  }

  function paveSelonLaForme(m, cases) {
    var t = maintenant();
    var g = segmentsDe(m);
    etape("lecture", t);
    if (!g || !g.seg.length) { return { ok: false, raison: "geometrie-illisible" }; }
    t = maintenant();
    var bb = boiteDe(g.seg);
    var petit = Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0);
    if (!(petit > 0)) { return { ok: false, raison: "geometrie-plate" }; }
    var droites = medianeLongueur(g.seg) >= petit * 0.25;
    etape("boite+mediane", t);

    /* ON PEINT D'ABORD. Le pavage en segments reste derrière, en repli : il a
     * servi longtemps, il est vérifié, et mieux vaut une grille lourde qu'aucune
     * grille si le shader refuse de compiler sur une machine ou l'autre. */
    var essai = essaiePeinture(g, bb, cases, m, droites);
    if (essai) { return essai; }
    return droites ? paveDroites(g, bb, cases, m) : paveCellules(g, bb, cases, m);
  }

  function essaiePeinture(g, bb, cases, m, droites) {
    if (shaderRefuse) { return null; }   // cette page ne veut pas de notre shader
    var reseau = null, unite = 0, detail = {};
    try {
      if (droites) {
        var familles = famillesDe(g.seg);
        if (!familles.length) { return null; }
        // Un emplacement de shader par famille ET par motif : au-delà de quatre,
        // on ne sait pas peindre, et on le dit plutôt que de peindre à moitié.
        var plates = [], i, j;
        for (i = 0; i < familles.length; i++) {
          for (j = 0; j < familles[i].motif.length; j++) {
            plates.push([-familles[i].uy, familles[i].ux, familles[i].p,
                         familles[i].base + familles[i].motif[j]]);
          }
        }
        if (!plates.length || plates.length > 4) { return null; }
        unite = uniteDroites(familles);
        reseau = { mode: "droites", familles: plates };
        detail = { familles: familles.length, droitesPeintes: plates.length,
                   ecarts: familles.map(function (F) { return cent(F.p / F.motif.length); }) };
      } else {
        /* UN SEGMENT SUR TROIS SUFFIT. La période est une propriété globale de
         * la trame, et chaque coordonnée distincte se répète des centaines de
         * fois : parcourir les seize mille valeurs pour en retenir quarante-
         * quatre, c'est trois fois le travail nécessaire. On garde un plancher,
         * pour qu'une petite grille reste lue en entier. */
        var xs = [], ys = [], s;
        var pas3 = g.seg.length > 4500 ? 3 : 1;
        for (i = 0; i < g.seg.length; i += pas3) {
          s = g.seg[i];
          if (s[0] <= bb.x0 + TOL_SEG || s[2] >= bb.x1 - TOL_SEG ||
              Math.min(s[1], s[3]) <= bb.y0 + TOL_SEG ||
              Math.max(s[1], s[3]) >= bb.y1 - TOL_SEG) { continue; }
          xs.push(s[0], s[2]); ys.push(s[1], s[3]);
        }
        if (xs.length < 16) { return null; }
        var t2 = maintenant();
        // periode() dédoublonne et trie elle-même : lui donner du trié n'apporte
        // rien et coûte deux tris de neuf mille valeurs.
        var px = periode(xs);
        var py = periode(ys);
        etape("periodes", t2);
        if (!px || !py) { return null; }
        t2 = maintenant();
        reseau = reseauHexagones(g, bb, px, py);
        etape("ajustement", t2);
        if (!reseau) { return null; }
        // LE RÉSIDU EST LE JUGE. Tous les points échantillonnés sont sur un bord
        // d'hexagone : si le modèle ne les y met pas, il est faux, et une trame
        // fausse est pire que lourde.
        if (!(reseau.residu < 0.5)) { return null; }
        unite = reseau.w;
        detail = { taille: [cent(reseau.w), cent(reseau.h)], aplati: !!reseau.aplati,
                   origine: [cent(reseau.origine[0]), cent(reseau.origine[1])],
                   residu: Math.round(reseau.residu * 1000) / 1000 };
      }
    } catch (e) { return null; }

    /* LA PORTÉE DU QUAD. C'est ici que tout se joue pour le coût : un quad de
     * six sommets couvre autant de surface qu'on veut sans un sommet de plus.
     * Quatre cents cases coûtent exactement ce que dix coûtent, et il n'y a plus
     * de budget de travail à raboter ni d'utilisateur à prévenir. */
    var halo = cases * unite;
    var page = { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 };
    var portee = { largeur: (bb.x1 - bb.x0) + 2 * halo,
                   hauteur: (bb.y1 - bb.y0) + 2 * halo,
                   cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2 };
    var aspect = aspectDe(m, !droites);

    var tp = maintenant();
    var r = posePeinture(m, reseau, page, portee, aspect);
    etape("pose", tp);
    if (!r.ok) { return null; }
    paveSource = m;   // le guet surveille la même chose, peinte ou pavée

    var infos = { ok: true, mode: "peinture", forme: reseau.mode, cases: cases,
                  halo: Math.round(halo), unite: cent(unite), sommets: 6,
                  couleur: aspect.couleur.map(function (v) { return Math.round(v * 100) / 100; }),
                  opacite: Math.round(aspect.opacite * 1000) / 1000,
                  opaciteLue: Math.round(aspect.opaciteLue * 1000) / 1000,
                  source: g.seg.length };
    for (var q in detail) { infos[q] = detail[q]; }
    return infos;
  }

  /* COMBIEN DE FOIS ON A POSÉ, ET C'EST EXPOSÉ EXPRÈS.
   *
   * Le guet appelle la pose directement, sans passer par le module : aucune
   * ligne de journal, donc rien à compter de l'extérieur. Un guet qui reposait
   * la grille deux fois par seconde a pu tourner sans que le moindre chiffre le
   * dise. Ce compteur-là est lisible depuis la page, et le banc comme le pilote
   * s'en servent. */
  var poses = 0;

  /* Poser l'extension. `cases` est le nombre de cases ajoutées DE CHAQUE CÔTÉ :
   * la carte reste au même endroit, la trame déborde tout autour. */
  function poseGrille(cases) {
    poses++;
    try { window.__vttinkerPoses = poses; } catch (e) {}
    return poseGrilleVraiment(cases);
  }

  function poseGrilleVraiment(cases) {
    var m = meshGrille();
    if (!m) {
      var L = meshLignes();
      if (L) { return paveGrille(L, Math.max(0, Math.round(cases))); }
      return { ok: false, raison: "grille-absente" };
    }
    var t = tailleGrille(m);
    if (!t) { return { ok: false, raison: "uniforme-gridSize-absent" }; }

    // On vient peut-être d'une grille en lignes : ne rien laisser derrière —
    // ni les segments, ni la peinture, qui n'a rien à faire sur un carré.
    if (paves.length) { oteLesSegments(); }
    if (peint && peint.isVisible) { masquePeinture(); }

    // L'état d'origine ne se prend qu'UNE fois : le reprendre après notre
    // propre écriture reviendrait à mémoriser nos valeurs comme les siennes.
    if (!grille) {
      grille = { mesh: m, ex: { sx: m.scaling.x, sy: m.scaling.y, gx: t.x, gy: t.y } };
    }
    var ex = grille.ex;
    var n = Math.max(0, Math.round(cases));
    var caseX = Math.abs(ex.sx) / ex.gx;   // 70 px, mais on le CALCULE
    var caseY = Math.abs(ex.sy) / ex.gy;
    var nx = ex.gx + 2 * n, ny = ex.gy + 2 * n;

    try {
      // Le signe est conservé : son échelle en y est NÉGATIVE (l'axe descend),
      // et la lui retourner mettrait la grille à l'envers.
      m.scaling.x = (ex.sx < 0 ? -1 : 1) * nx * caseX;
      m.scaling.y = (ex.sy < 0 ? -1 : 1) * ny * caseY;
      t.v.x = nx;
      t.v.y = ny;
      rafraichis(m);
    } catch (e) { return { ok: false, raison: "ecriture-refusee" }; }

    return { ok: true, cases: n, casePx: Math.round(caseX * 100) / 100,
             avant: [ex.gx, ex.gy], apres: [nx, ny], mode: "quad" };
  }

  function rendGrille() {
    oteLesPaves();
    if (!grille) { return { ok: true }; }
    var m = grille.mesh, ex = grille.ex;
    try {
      m.scaling.x = ex.sx;
      m.scaling.y = ex.sy;
      var t = tailleGrille(m);
      if (t) { t.v.x = ex.gx; t.v.y = ex.gy; }
      rafraichis(m);
    } catch (e) {}
    grille = null;
    return { ok: true };
  }

  /* LE GUET. Roll20 refait sa grille quand la page change, quand ses réglages
   * changent, ou à une reconnexion — et il la refait à SA taille. Sans ce
   * rappel, l'extension aurait l'air de s'être éteinte toute seule. On ne
   * réécrit que si la valeur n'est plus la nôtre : rien à faire le reste du
   * temps, et aucun travail par image. */
  var guetGrille = null;

  /* CE QUE LE GUET DOIT VOIR, ET QU'IL NE VOYAIT PAS.
   *
   * Il ne surveillait que la MORT de nos copies. Or au changement de type de
   * grille, Roll20 remplace SON maillage — et nos clones, eux, survivent : rien
   * ne se déclenchait, et l'ancienne trame restait par-dessus la nouvelle.
   * C'est le défaut qui a été signalé, et il ne se voyait qu'en changeant de
   * type, jamais en rechargeant.
   *
   * Il faut donc surveiller la SOURCE, pas seulement les copies. Et les quatre
   * passages d'une famille à l'autre demandent chacun leur ménage :
   *   carré → lignes  : jeter l'état du quad, paver ;
   *   lignes → carré  : jeter notre maillage, agrandir le quad ;
   *   lignes → lignes : la source a changé, tout refaire ;
   *   plus de grille  : ne rien laisser derrière. */
  /* LE SHADER A-T-IL FINI PAR COMPILER ?
   *
   * On ne bloque plus pour le savoir : c'est ici qu'on regarde, un tour de guet
   * plus tard. Une erreur de compilation, ou trois tours sans que l'effet soit
   * prêt, et on renonce à peindre pour cette page — le pavage en segments
   * reprend la main. Mieux vaut une grille lourde qu'une grille absente. */
  function surveilleEffet() {
    if (!peint || !peint.material || shaderRefuse) { return; }
    var mat = peint.material, err = null, pret = false;
    try {
      var eff = mat.getEffect && mat.getEffect();
      err = eff && eff.getCompilationError && eff.getCompilationError();
      pret = !!mat.isReady(peint);
    } catch (e) {}
    if (!err && pret) { attenteEffet = 0; return; }
    attenteEffet++;
    if (err || attenteEffet > 3) {
      /* On ne journalise pas d'ici : le pont n'a pas de journal à lui, et le
       * module dit déjà en clair, dans le panneau, qu'une page n'a pas pu être
       * peinte. La raison, elle, part avec le prochain résultat. */
      shaderRefuse = true;
      refusShader = String(err || "jamais prêt").slice(0, 200);
      oteLesPaves();
    }
  }

  function verifieGrille(cases) {
    surveilleEffet();
    var q = meshGrille();
    if (q) {
      // On vient des lignes : ni segments ni peinture n'ont plus rien à faire
      // là. Ranger la peinture suffit, et garde son shader compilé au chaud.
      if (paves.length) { oteLesSegments(); }
      if (peint && peint.isVisible) { masquePeinture(); }
      if (grille && grille.mesh !== q) { grille = null; }  // il a refait son quad
      var t = tailleGrille(q);
      if (!t) { return; }
      var attendu = grille ? grille.ex.gx + 2 * cases : null;
      if (attendu === null || t.x !== attendu) { poseGrille(cases); }
      return;
    }
    var L = meshLignes();
    if (L) {
      if (grille) { grille = null; }                       // on vient du carré
      /* LE GUET DOIT CONNAÎTRE LES DEUX VOIES, et c'est le défaut qui a coûté le
       * plus cher de tous.
       *
       * La condition était « !paves.length » : rien dans le tableau des clones,
       * donc rien de posé, donc on repose. Vrai tant que la seule voie était le
       * pavage en segments. Devenu FAUX le jour où la grille s'est mise à être
       * peinte : le quad ne vit pas dans `paves`, il vit dans `peint`, et le
       * guet a recommencé à poser TOUTES LES SECONDES ET DEMIE — relecture des
       * quatre mille segments, réajustement de la phase par balayage, et une
       * recompilation de shader à chaque tour. L'affichage ramait, et rien ne le
       * disait : le guet appelle la pose directement, sans passer par le module,
       * donc sans écrire une ligne de journal. Le compteur de reconstructions
       * était aveugle par construction.
       *
       * On demande donc à l'état, pas à l'une de ses moitiés. */
      var mort = false, i, c;
      for (i = 0; i < paves.length; i++) {
        c = paves[i];
        if (!c || (c.isDisposed && c.isDisposed())) { mort = true; break; }
      }
      if (peint && peint.isDisposed && peint.isDisposed()) { mort = true; }
      var rien = !paves.length && !peint;
      // Le guet passe par la même minuterie que tout le monde : il n'a aucune
      // raison d'être plus pressé que le module.
      if (rien || mort || paveSource !== L) { planifiePose(cases); }
      return;
    }
    /* Plus aucune grille : la page n'en a pas, ou elle est masquée. On range
     * notre peinture au lieu de la détruire — si elle revient, on la ressort
     * sans recompiler quoi que ce soit. */
    if (paves.length) { oteLesSegments(); }
    if (peint && peint.isVisible) { masquePeinture(); }
  }

  /* ---------- LA POSE S'ÉTRANGLE ----------
   *
   * Trois choses réclament une pose, et elles se bousculent au chargement : le
   * module réessaie toutes les 400 ms tant que la scène Babylon n'est pas là, le
   * guet repasse toutes les 1,5 s, et Roll20 remplace son maillage plusieurs
   * fois pendant qu'il monte sa scène. Mesuré : NEUF poses dans les cinq
   * premières secondes, chacune relisant quatre mille segments.
   *
   * Aucune n'est illégitime prise seule, et aucune n'a besoin d'être immédiate.
   * On les laisse donc se rejoindre : une demande arme une minuterie de 250 ms,
   * les suivantes la retrouvent déjà armée, et une seule pose sort du lot. Le
   * résultat part en diffusion, pas en réponse — le demandeur n'est plus le seul
   * concerné, et le module écoute de toute façon le type du message. */
  var attentePose = null, casesVoulues = 0;

  function annulePose() {
    if (attentePose) { clearTimeout(attentePose); attentePose = null; }
  }

  function planifiePose(cases) {
    casesVoulues = cases;
    if (attentePose) { return; }
    attentePose = setTimeout(function () {
      attentePose = null;
      var rg;
      try { rg = poseGrille(casesVoulues); }
      catch (e) { rg = { ok: false, raison: "pose-en-echec" }; }
      if (rg.ok) { surveilleGrille(Math.max(0, Math.round(casesVoulues))); }
      rg.type = "grille-resultat";
      repond(null, rg);
    }, 250);
  }

  function surveilleGrille(cases) {
    if (guetGrille) { clearInterval(guetGrille); }
    guetGrille = setInterval(function () { try { verifieGrille(cases); } catch (e) {} }, 1500);
  }

  function stoppeGuetGrille() {
    if (guetGrille) { clearInterval(guetGrille); guetGrille = null; }
  }

  /* ============================================================
   *                  LES MARQUEURS PERSONNALISÉS
   * ============================================================
   *
   * Roll20 n'accepte que ses propres pictogrammes d'état. On dessine les nôtres
   * à côté des siens, DANS SA SCÈNE, sans rien écrire dans la campagne au-delà
   * de l'étiquette elle-même — qu'il ignore poliment, c'est vérifié.
   *
   * TOUTE LA GÉOMÉTRIE A ÉTÉ MESURÉE SUR UNE VRAIE PARTIE, pas déduite :
   *
   *   Pour chaque token, Roll20 tient un nœud de transformation nommé
   *   « <id>-markers », posé EXACTEMENT sur le coin haut-droit du token
   *   (x = left + width/2, y = -(top - height/2)) et à LA PROFONDEUR DU TOKEN.
   *   Il existe pour tous les tokens, même ceux qui ne portent aucun marqueur.
   *
   *   Sous ce nœud, chaque pictogramme est un quad de 19 unités de côté, centré
   *   en y = -12,5, et en x = -12,5 pour le dernier, -34,5 pour l'avant-dernier :
   *   un pas de 22, la rangée alignée à droite. Ni la taille ni le pas ne
   *   dépendent de la taille du token (mesuré sur 70 et sur 140) ni du zoom.
   *
   * ET LE POINT QUI DÉCIDE DE TOUT : ce nœud SURVIT. Roll20 détruit et recrée
   * ses propres quads à chaque changement — de marqueurs comme de position —
   * mais le nœud garde son identité, et les enfants qu'on lui ajoute restent
   * accrochés. Mesuré : un quad à nous a traversé deux reconstructions de la
   * rangée et un déplacement de 70, qu'il a suivi au centième.
   *
   * D'où un module qui ne coûte RIEN à l'image : aucun écouteur de position,
   * aucun recalcul par trame, aucun guet. On pose des quads une fois, et c'est
   * la transformation de Roll20 qui les promène. On ne se réveille que sur un
   * changement d'étiquettes. */

  var MARQUEUR_COTE   = 19;    // le côté du quad, en unités de plateau
  var MARQUEUR_PAS    = 22;    // d'un centre au suivant, à taille pleine
  var MARQUEUR_BORD   = 12.5;  // du coin du token au centre du dernier
  /* Il n'y a PAS de marge fixe : la rangée entière est la rangée à taille pleine
   * multipliée par l'échelle, marge comprise. Une constante de 1,5 traînait ici,
   * traitée comme fixe — d'où un décalage dès que Roll20 rapetissait. */
  var MARQUEUR_AVANCE = 100;   // de combien on passe devant le token (créneau : 500)

  /* Le shader : une image, sa transparence, rien d'autre. Pas d'éclairage, pas
   * de couleur, pas de brouillard — Babylon en poserait par défaut avec un
   * StandardMaterial, et chacun de ces réglages coûte des instructions par
   * pixel sur des machines qui n'en ont pas de trop.
   *
   * Toutes nos images partagent CE source, donc un seul programme GLSL compilé
   * quel que soit le nombre de marqueurs : Babylon met ses effets en cache sur le
   * source, pas sur le matériau. */
  var VS_MARQUEUR =
    "precision highp float;\n" +
    "attribute vec3 position;\n" +
    "attribute vec2 uv;\n" +
    "uniform mat4 worldViewProjection;\n" +
    "varying vec2 vUV;\n" +
    /* AUCUN RETOURNEMENT ICI. L'orientation se règle sur la TEXTURE, par son
     * `invertY`, et pas dans le nuanceur.
     *
     * Ça n'a pas été trouvé du premier coup, et l'erreur mérite d'être écrite :
     * le premier jet retournait l'UV en x, sur la foi d'une comparaison faite
     * avec le pictogramme « lightning-helix ». Or un éclair en Z a une symétrie
     * de DEMI-TOUR — un Z tourné de 180° est un Z. Ce témoin-là ne pouvait donc
     * pas distinguer un miroir horizontal d'un miroir vertical : les deux
     * rendaient la même image. Le vrai défaut était vertical, la « correction »
     * horizontale, et leur composition donnait un demi-tour — soit un marqueur à
     * l'envers, ce qu'un utilisateur a vu tout de suite.
     *
     * Un témoin doit n'avoir AUCUNE symétrie. On emploie « snail » ou
     * « spanner » : ni miroir, ni demi-tour. */
    "void main(void) {\n" +
    "  vUV = uv;\n" +
    "  gl_Position = worldViewProjection * vec4(position, 1.0);\n" +
    "}\n";

  var FS_MARQUEUR =
    "precision highp float;\n" +
    "varying vec2 vUV;\n" +
    "uniform sampler2D image;\n" +
    "void main(void) {\n" +
    "  vec4 c = texture2D(image, vUV);\n" +
    /* Le rejet franc des pixels transparents évite de les mélanger pour rien :
     * une émote est transparente sur la plus grande partie de son carré. */
    "  if (c.a <= 0.004) { discard; }\n" +
    "  gl_FragColor = c;\n" +
    "}\n";

  var marqueursActif = false;
  var marqueursMat = {};          // url -> ShaderMaterial, une seule par image
  var marqueursScene = null;      // la scène à laquelle les matériaux ci-dessus appartiennent
  var marqueursPoses = {};        // id de token -> { signature, quads }
  var marqueursLiee = null;       // la collection Backbone qu'on écoute
  var marqueursSurChange = null;
  var marqueursRetard = null;
  var marqueursConnus = { texte: null, jeu: null };   // le catalogue de Roll20, mémoïsé

  /* Les classes de Babylon, encore une fois prises sur des objets vivants :
   * la page n'expose pas le global. Le matériau de n'importe quel maillage de
   * Roll20 est un ShaderMaterial, et sa texture une Texture. */
  function classesMarqueur(S) {
    /* UN MATÉRIAU APPARTIENT À SA SCÈNE, et nos deux caches n'en savaient rien.
     *
     * Ils sont indexés sur l'adresse de l'image et sur le nombre — jamais sur la
     * scène. Si Roll20 en montait une seconde, on ressortirait des matériaux de
     * l'ancienne pour des quads de la nouvelle : rien ne se dessinerait, et rien
     * ne le dirait.
     *
     * CE N'EST PAS UNE MESURE, C'EST UNE GARDE. On ne sait pas s'il remplace sa
     * scène en changeant de page — l'éprouver demanderait de déplacer une vraie
     * partie sous les joueurs. La garde coûte une comparaison par passage et
     * rend le cas impossible ; s'en passer, c'est parier sans avoir compté. */
    if (marqueursScene !== S) {
      marqueursScene = S;
      marqueursMat = {};
      marqueursNombreMat = {};
    }
    var Maillage = null, Shader = null, Image = null, i, m;
    for (i = 0; i < S.meshes.length && !Maillage; i++) {
      m = S.meshes[i];
      if (m && m.constructor && m.constructor.CreatePlane) { Maillage = m.constructor; }
    }
    for (i = 0; i < (S.materials || []).length && !Shader; i++) {
      m = S.materials[i];
      if (m && m.getClassName && m.getClassName() === "ShaderMaterial") { Shader = m.constructor; }
    }
    for (i = 0; i < (S.textures || []).length && !Image; i++) {
      m = S.textures[i];
      if (m && m.constructor && m.updateURL) { Image = m.constructor; }
    }
    return (Maillage && Shader && Image) ? { Maillage: Maillage, Shader: Shader, Image: Image } : null;
  }

  /* Un matériau par image, gardé tant que le module vit. Recréer un matériau,
   * c'est recompiler — la leçon a déjà coûté cher sur la grille, où sept poses
   * en quatre secondes recompilaient sept fois le même shader. */
  function materiauMarqueur(S, cl, url) {
    if (marqueursMat[url]) { return marqueursMat[url]; }
    var mat = new cl.Shader("vttk-marqueur", S,
      { vertexSource: VS_MARQUEUR, fragmentSource: FS_MARQUEUR },
      { attributes: ["position", "uv"], uniforms: ["worldViewProjection"], samplers: ["image"] });
    /* invertY à VRAI, c'est-à-dire le réglage ordinaire de Babylon. Une image
     * a son origine en haut à gauche, une texture WebGL en bas à gauche :
     * sans ce retournement, elle sort à l'envers. Le premier jet passait
     * `false` et l'image sortait bien retournée verticalement — c'est ce
     * défaut-là qu'il fallait corriger, et non celui qu'on avait cru voir. */
    var tex = new cl.Image(url, S, false, true);
    tex.hasAlpha = true;
    mat.setTexture("image", tex);
    mat.backFaceCulling = false;
    mat.alpha = 0.999;      // le seul moyen de forcer le passage en transparence
    marqueursMat[url] = mat;
    return mat;
  }

  /* ---------- LE COMPTEUR, RECOPIÉ SUR LE SIEN ----------
   *
   * TOUT CE QUI SUIT EST MESURÉ, sur une vraie partie, à deux échelles. Roll20
   * fabrique un maillage « <token>-<étiquette>-<N>-renderer » portant une
   * DynamicTexture nommée « …-tex--0-0 », et voici ce qu'on en a lu :
   *
   *   · LA TEXTURE fait 28 pixels de haut, toujours, et 20 pixels de large pour
   *     un chiffre, 36 pour deux, 52 pour trois — soit 20 + 16 × (chiffres − 1).
   *   · LE MAILLAGE fait EXACTEMENT LA MOITIÉ de sa texture en unités de
   *     plateau : 10 × 14, 18 × 14, 26 × 14. Deux pixels par unité.
   *   · IL SUIT L'ÉCHELLE DU MARQUEUR : à l'échelle 0,58, les boîtes relevées
   *     valent 5,8 × 8,12 / 10,44 × 8,12 / 15,08 × 8,12, soit exactement les
   *     précédentes multipliées par 0,58.
   *   · IL EST CENTRÉ SUR LA MÊME ABSCISSE que son marqueur, et son centre est
   *     7 × échelle SOUS le centre du marqueur (mesuré −4,06 pour 0,58).
   *   · LE DESSIN est un nombre ROUGE PUR (255,0,0) cerné de BLANC PUR, haut de
   *     26 des 28 pixels du canevas.
   *
   * On ne cherche pas à égaler sa fonte au pixel — on ne la connaît pas, et elle
   * changera avant nous. On reprend sa géométrie, ses couleurs et son encombrement,
   * qui sont ce qui se voit quand les deux sont côte à côte sur le même token. */
  var NOMBRE_HAUT   = 28;   // hauteur du canevas, en pixels
  var NOMBRE_LARGE  = 20;   // largeur du canevas pour UN chiffre
  var NOMBRE_PAR    = 16;   // ce que chaque chiffre supplémentaire ajoute
  var NOMBRE_DENSITE = 2;   // pixels de canevas par unité de plateau
  var NOMBRE_SOUS   = 7;    // de combien son centre descend sous celui du marqueur
  var NOMBRE_ROUGE  = "rgb(255,0,0)";
  var NOMBRE_BLANC  = "rgb(255,255,255)";

  var marqueursNombreMat = {};   // « 12 » -> ShaderMaterial, une seule par nombre

  /* La classe DynamicTexture, prise sur un objet vivant comme les autres : la
   * page n'expose pas le global de Babylon. Roll20 en a toujours au moins deux
   * dans sa scène — son atlas de pictogrammes en est une. */
  function classeCanevas(S) {
    var i, t;
    for (i = 0; i < (S.textures || []).length; i++) {
      t = S.textures[i];
      if (t && t.getClassName && t.getClassName() === "DynamicTexture" && t.getContext) {
        return t.constructor;
      }
    }
    return null;
  }

  function largeurNombre(n) {
    return NOMBRE_LARGE + NOMBRE_PAR * (String(n).length - 1);
  }

  /* UN MATÉRIAU PAR NOMBRE, ET NON PAR MARQUEUR. Le canevas ne dépend que des
   * chiffres : deux tokens portant « @3 » peignent le même 3. Roll20, lui, en
   * fabrique un par token et par étiquette — on n'a aucune raison de l'imiter
   * jusque dans sa dépense. */
  function materiauNombre(S, cl, n) {
    if (marqueursNombreMat[n]) { return marqueursNombreMat[n]; }
    var Canevas = classeCanevas(S);
    if (!Canevas) { return null; }
    var l = largeurNombre(n);
    /* invertY à VRAI, comme pour les images : notre nuanceur ne retourne rien,
     * et une texture qui monte à l'endroit doit le dire elle-même. */
    var tex = new Canevas("vttk-nombre-" + n, { width: l, height: NOMBRE_HAUT }, S, false,
      undefined, undefined, true);
    var ctx = tex.getContext();
    ctx.clearRect(0, 0, l, NOMBRE_HAUT);
    /* LE TRAIT AVANT LE REMPLISSAGE, et le trait par-dessous : dessiner le blanc
     * en second le poserait PAR-DESSUS le rouge et mangerait la moitié du
     * chiffre. `lineJoin` arrondi évite les pointes que les angles d'un 4 ou
     * d'un 7 produisent sur un contour épais. */
    ctx.font = "bold 25px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = 4;
    ctx.strokeStyle = NOMBRE_BLANC;
    ctx.strokeText(n, l / 2, NOMBRE_HAUT / 2);
    ctx.fillStyle = NOMBRE_ROUGE;
    ctx.fillText(n, l / 2, NOMBRE_HAUT / 2);
    tex.update(true);
    tex.hasAlpha = true;

    var mat = new cl.Shader("vttk-nombre", S,
      { vertexSource: VS_MARQUEUR, fragmentSource: FS_MARQUEUR },
      { attributes: ["position", "uv"], uniforms: ["worldViewProjection"], samplers: ["image"] });
    mat.setTexture("image", tex);
    mat.backFaceCulling = false;
    mat.alpha = 0.999;
    marqueursNombreMat[n] = mat;
    return mat;
  }

  /* Les étiquettes que Roll20 sait dessiner. On en a besoin pour COMPTER les
   * siennes : nos quads se rangent à la suite, et un décompte faux les ferait
   * chevaucher. Le catalogue ne bouge presque jamais, on le mémoïse sur son
   * propre texte. */
  /* LA BONNE SOURCE EST `tokenMarkerData`, PAS `token_markers`.
   *
   * Le premier jet lisait `Campaign.attributes.token_markers` : 47 entrées, et
   * il en manquait. Le magasin Pinia « campaign » en porte 63 sous
   * `tokenMarkerData` — les mêmes, PLUS celles que la fiche de personnage
   * ajoute (« sheet-blinded », « sheet-charmed », « sheet-deafened »…, servies
   * depuis beacon-sheets/tokenmarkers/). C'est de là que sa propre fenêtre tire
   * sa liste, et c'est un utilisateur qui a dû le signaler : la comparaison à
   * l'écran l'a montré, aucun compte ne l'aurait fait.
   *
   * L'ancienne source reste le repli : elle a le mérite d'exister avant Pinia. */
  function marqueursDeRoll20() {
    var C = window.Campaign;
    var brut = null, cle = "";
    try {
      var st = magasin("campaign");
      if (st && st.tokenMarkerData && st.tokenMarkerData.length) {
        brut = st.tokenMarkerData;
        cle = "pinia:" + brut.length;
      }
    } catch (e) {}
    if (!brut) {
      var texte = (C && C.attributes && C.attributes.token_markers) || "";
      cle = "attr:" + texte.length;
      try { brut = JSON.parse(texte); } catch (e) { brut = []; }
    }
    if (cle === marqueursConnus.texte) { return marqueursConnus.jeu; }
    var jeu = {}, liste = [];
    (brut || []).forEach(function (m) {
      if (!m || !m.tag) { return; }
      jeu[m.tag] = true;
      if (m.url) { liste.push({ tag: m.tag, nom: m.name || m.tag, url: m.url }); }
    });
    /* CE JEU DIT « QUI OCCUPE UNE CASE DE LA RANGÉE », et rien d'autre : c'est
     * lui qui décide du décalage de nos marqueurs, donc une erreur ici les fait
     * CHEVAUCHER les siens. Mesuré, sur une vraie partie :
     *
     *   · LES PASTILLES DE COULEUR occupent une case — « red » en -34,5 et
     *     « blue » en -12,5 — alors qu'elles ne sont dans AUCUN catalogue. Ne
     *     pas les compter posait notre marqueur PAR-DESSUS la dernière.
     *   · « dead » n'en occupe AUCUNE : il barre le token sur toute sa surface.
     *     Le compter laissait une case vide entre les siens et les nôtres.
     *
     * Les deux erreurs se compensaient quand un token portait une pastille ET
     * un « dead » — d'où un défaut qui n'apparaissait qu'« à certains moments ». */
    for (var p = 0; p < PASTILLES.length; p++) { jeu[PASTILLES[p].tag] = true; }
    marqueursConnus.texte = cle;
    marqueursConnus.jeu = jeu;
    marqueursConnus.liste = liste;
    return jeu;
  }

  /* LES MARQUEURS DE ROLL20, avec leurs images — pour les proposer dans notre
   * palette. Poser l'un des siens par notre chemin est plus rapide que par le
   * sien, et surtout il reste UN MARQUEUR DE ROLL20 : c'est lui qui le dessine,
   * donc tout le monde le voit, extension ou pas. */
  function catalogueDeRoll20() {
    marqueursDeRoll20();
    return marqueursConnus.liste || [];
  }

  /* ---------- LES PASTILLES DE COULEUR, QUI NE SONT DANS AUCUN CATALOGUE ----------
   *
   * Ce sont les marqueurs les plus employés en jeu, et ils manquaient : ils ne
   * figurent PAS dans `token_markers` — cette liste ne contient que ses 47
   * pictogrammes nommés. Les pastilles vivent comme MAILLAGES, sous les noms
   * « red-marker-template », « blue-marker-template »…
   *
   * Elles n'ont donc pas d'image : ce sont des disques vectoriels, qu'il faut
   * dessiner. Leurs teintes sont LUES sur ses propres modèles — les valeurs
   * ci-dessous ne servent que de repli, et elles viennent du même relevé. */
  /* LA CROIX ROUGE se range avec les pastilles, comme dans sa propre fenêtre :
   * c'est le marqueur « dead », qui barre le token. Il n'a ni image ni entrée de
   * catalogue — on le dessine, comme les pastilles. */
  var CROIX = { tag: "dead", nom: "Mort (croix rouge)", croix: true };

  var PASTILLES = [
    { tag: "red",    teinte: "rgb(201,16,16)" },
    { tag: "blue",   teinte: "rgb(16,118,201)" },
    { tag: "green",  teinte: "rgb(47,201,16)" },
    { tag: "brown",  teinte: "rgb(201,115,16)" },
    { tag: "purple", teinte: "rgb(149,16,201)" },
    { tag: "pink",   teinte: "rgb(235,117,225)" },
    { tag: "yellow", teinte: "rgb(229,235,117)" }
  ];

  function pastillesDeRoll20() {
    var S = window.MeshScene, out = [], i;
    for (i = 0; i < PASTILLES.length; i++) {
      var p = { tag: PASTILLES[i].tag, nom: PASTILLES[i].tag, teinte: PASTILLES[i].teinte };
      try {
        var m = S && S.getMeshByName && S.getMeshByName(p.tag + "-marker-template");
        var c = m && m.material && m.material.diffuseColor;
        if (c && c.r !== undefined) {
          p.teinte = "rgb(" + Math.round(c.r * 255) + "," +
                     Math.round(c.g * 255) + "," + Math.round(c.b * 255) + ")";
        }
      } catch (e) {}
      out.push(p);
    }
    out.push(CROIX);
    return out;
  }

  /* Ce que porte un token, séparé en deux : ce que Roll20 dessine, et ce qui
   * nous revient. Une étiquette peut s'écrire « skull@3 » — le nombre est une
   * décoration de Roll20, il ne change pas l'identité. */
  /* L'ÉTIQUETTE PORTE SON ADRESSE, DONC ON N'A BESOIN D'AUCUN CATALOGUE.
   *
   * Forme : « vttk_<nom>_<adresse sans https://> ». Le découpage est non ambigu
   * parce que le nom s'interdit le souligné : le premier ferme le préfixe, le
   * second ferme le nom, le reste est l'adresse.
   *
   * C'est ce qui a permis de SUPPRIMER tout le catalogue partagé — un document
   * de campagne à créer, à fusionner, à faire converger, et que seul un MJ
   * pouvait écrire. N'importe quel joueur ayant l'extension voit désormais le
   * marqueur, immédiatement, sans rien avoir reçu de personne.
   *
   * ON NE CROIT RIEN DE CE QU'ON LIT. Cette chaîne vient des données de la
   * campagne, donc d'autres joueurs, et le pont vit dans la page de Roll20 : on
   * revalide entièrement, comme à la première lecture. */
  function litEtiquette(tag) {
    if (tag.indexOf("vttk_") !== 0) { return null; }
    var reste = tag.slice(5);
    var coupe = reste.indexOf("_");
    if (coupe <= 0) { return null; }
    var nom = reste.slice(0, coupe);
    if (!/^[a-z0-9-]{1,24}$/.test(nom)) { return null; }
    var url = urlSure("https://" + reste.slice(coupe + 1));
    if (!url) { return null; }
    return { url: url, nom: nom };
  }

  /* LE NOMBRE APRÈS « @ » EST UN COMPTEUR, ET IL EST À NOUS AUSSI.
   *
   * Roll20 écrit « snail@3 » et dessine un 3 rouge sous le pictogramme. Il ne le
   * fait QUE pour ses propres étiquettes : les nôtres lui sont inconnues, donc
   * un « vttk_poison_…@3 » ne dessinerait rien du tout chez lui. C'est à nous de
   * le peindre, et c'est mesuré case par case plus bas.
   *
   * TROIS CHIFFRES AU PLUS, parce que c'est ce qu'il accepte : « padlock@999 »
   * se dessine, et sa boîte grandit de seize pixels par chiffre. Au-delà, on
   * ignore le suffixe plutôt que d'inventer une géométrie qu'on n'a pas mesurée.
   *
   * L'ADRESSE NE PEUT PAS EN CONTENIR : la validation interdit l'arobase dans
   * une URL, précisément parce que Roll20 coupe ce champ dessus. Le découpage
   * est donc sans risque, et il l'était déjà avant qu'on lise le nombre. */
  function litNombre(txt) {
    return /^[0-9]{1,3}$/.test(txt) ? String(parseInt(txt, 10)) : "";
  }

  function partageEtiquettes(brut) {
    var sien = 0, notre = [], i, e, lu, at, base, nombre;
    var liste = (brut || "").split(",");
    var jeu = marqueursDeRoll20();
    for (i = 0; i < liste.length; i++) {
      e = liste[i].trim();
      if (!e) { continue; }
      at = e.indexOf("@");
      base = at >= 0 ? e.slice(0, at) : e;
      nombre = at >= 0 ? litNombre(e.slice(at + 1).trim()) : "";
      if (!base) { continue; }
      lu = litEtiquette(base);
      if (lu) { notre.push({ tag: base, url: lu.url, nom: lu.nom, nombre: nombre }); continue; }
      if (jeu[base]) { sien++; }
    }
    return { sien: sien, notre: notre };
  }

  /* SON ÉCHELLE, LUE SUR SES PROPRES QUADS — jamais calculée quand on peut la
   * lire. C'est la seule façon d'avoir EXACTEMENT sa taille : sa loi est
   * quantifiée par pas de 0,02 d'une manière qu'on ne reproduit qu'à 1 % près,
   * et 1 % d'écart sur des marqueurs côte à côte se voit.
   *
   * On ignore nos propres quads et son ancre : le premier des siens suffit,
   * ils ont tous la même. */
  /* CE QU'IL A VRAIMENT DESSINÉ : combien, et à quelle échelle.
   *
   * On lit les DEUX sur ses propres quads, jamais on ne les calcule quand on
   * peut les lire.
   *
   *   · L'ÉCHELLE, parce que sa loi est quantifiée par pas de 0,02 d'une manière
   *     qu'on ne reproduit qu'à 1 % près, et 1 % d'écart entre deux marqueurs
   *     côte à côte se voit.
   *   · LE NOMBRE, parce qu'il décide où commence notre première case ET
   *     combien en tiennent sur une ligne. Compter les ÉTIQUETTES au lieu des
   *     quads suppose qu'il dessine tout ce qu'on croit qu'il dessine — ce qui
   *     est faux dès qu'une image manque.
   *
   * On ignore nos propres quads et son ancre ; les siens ont tous la même
   * échelle. */
  function etatDeRoll20(noeud) {
    if (!noeud || !noeud.getChildren) { return null; }
    var e = noeud.getChildren(), n = 0, ech = null;
    for (var i = 0; i < e.length; i++) {
      var m = e[i];
      if (!m || !m.scaling) { continue; }
      /* « vttk- » ET PAS « vttk-marqueur- ». Nos compteurs pendent au MÊME nœud
       * que nos marqueurs — Roll20, lui, accroche les siens ailleurs — et ils
       * s'appellent « vttk-nombre-… ». Un filtre qui ne visait que
       * « vttk-marqueur » les aurait comptés pour des marqueurs de Roll20 : sa
       * rangée aurait paru plus longue qu'elle n'est, tous nos marqueurs se
       * seraient décalés d'une case par compteur, et comme le compte lu n'aurait
       * jamais rejoint le compte annoncé, le rendez-vous de 600 ms se serait
       * rappelé sans fin. Trois défauts pour un préfixe. */
      if (/^vttk-/.test(m.name) || /group_marker/.test(m.name)) { continue; }
      if (m.isEnabled && !m.isEnabled()) { continue; }
      n++;
      /* SA GÉOMÉTRIE FAIT DÉJÀ 19 UNITÉS : son `scaling.x` EST le facteur, pas
       * une taille. Mesuré — boîte englobante 19 pour scaling 1, 17,1 pour 0,9.
       * Les nôtres partent d'un plan d'UNE unité, d'où le 19 qu'on remet. */
      if (ech === null && m.scaling.x > 0) { ech = m.scaling.x; }
    }
    return n ? { n: n, echelle: ech || 1 } : null;
  }

  function oteMarqueursDe(id) {
    var p = marqueursPoses[id];
    if (!p) { return; }
    for (var i = 0; i < p.quads.length; i++) {
      try { p.quads[i].dispose(false, false); } catch (e) {}
    }
    delete marqueursPoses[id];
  }

  function oteTousLesMarqueurs() {
    for (var id in marqueursPoses) {
      if (Object.prototype.hasOwnProperty.call(marqueursPoses, id)) { oteMarqueursDe(id); }
    }
    marqueursPoses = {};
  }

  /* Poser la rangée d'un token. Renvoie true si quelque chose a changé.
   *
   * ON NE REFAIT RIEN POUR RIEN : la signature réunit ce qui décide du dessin —
   * nos étiquettes et le nombre de celles de Roll20. Un token qu'on traîne
   * n'émet aucun changement de marqueurs, donc ne passe même pas ici ; et s'il
   * y passe, la signature l'arrête. */
  function poseMarqueursSur(S, cl, t) {
    var id = t.id;
    var a = t.attributes || {};
    var part = partageEtiquettes(a.statusmarkers);
    var noeudLu = S.getTransformNodeByName(id + "-markers");
    /* L'ÉCHELLE ENTRE DANS LA SIGNATURE, et c'est une correction.
     *
     * Nous plaçons souvent AVANT que Roll20 ait dessiné les siens : il n'y a
     * alors rien à lire, on prend la formule de repli, et elle ne tombe pas
     * exactement sur la sienne — 0,707 contre 0,70 pour neuf marqueurs, soit
     * 13,4 contre 13,3 de côté. Un dixième d'unité, mais côte à côte ça se voit,
     * et rien ne repassait jamais corriger.
     *
     * En mettant l'échelle dans la signature, le passage suivant — celui que le
     * rendez-vous ci-dessous provoque — voit qu'elle a changé et repose. */
    var luR20 = etatDeRoll20(noeudLu);
    var echLue = luR20 ? luR20.echelle : null;
    /* SON NOMBRE ET SON ÉCHELLE ENTRENT DANS LA SIGNATURE, et c'est ce qui fait
     * converger. Nous plaçons souvent AVANT qu'il ait dessiné : il n'y a alors
     * rien à lire, on prend la formule de repli, et elle ne tombe pas exactement
     * sur la sienne. Le passage suivant — celui que le rendez-vous plus bas
     * provoque — voit que l'état a changé, et repose. */
    /* LE NOMBRE ENTRE DANS LA SIGNATURE. Sans lui, passer un marqueur de « @3 » à
     * « @12 » ne changerait rien de ce qu'on compare, et le 3 resterait affiché
     * sur un token dont le champ dit 12. */
    /* LA LARGEUR DU TOKEN Y ENTRE AUSSI. C'est elle qui décide de la capacité
     * d'une ligne : redimensionner un token change la mise en page sans changer
     * une seule étiquette, et la signature ne voyait pas la différence. */
    var signature = (luR20 ? luR20.n : part.sien) + "|" +
      (echLue === null ? "?" : echLue) + "|" + (a.width || 0) + "|" +
      part.notre.map(function (x) { return x.nombre ? x.tag + "@" + x.nombre : x.tag; }).join(",");
    var pose = marqueursPoses[id];
    /* DÉJÀ À JOUR — ce n'est PAS une attente, et les confondre coûtait cher :
     * voir le rendez-vous plus bas. */
    if (pose && pose.signature === signature) { return false; }

    oteMarqueursDe(id);
    if (!part.notre.length) { return true; }

    var noeud = S.getTransformNodeByName(id + "-markers");
    /* Le nœud se monte avec le token : sur un token qui vient d'apparaître il
     * peut manquer. On ne pose rien et on ne mémorise rien — le prochain
     * passage réessaiera.
     *
     * ON REND `null`, ET NON `false`. C'est le SEUL cas où il faut repasser, et
     * il ne se distinguait pas du « déjà à jour » ci-dessus : le balayage
     * comptait donc une attente pour CHAQUE token portant un de nos marqueurs,
     * même parfaitement dessiné et parfaitement stable. Il réarmait alors son
     * rendez-vous de 700 ms, qui rappelait le balayage, qui recomptait la même
     * attente — un parcours complet de la page toutes les sept dixièmes de
     * seconde, à vie, dès qu'un seul marqueur était posé quelque part. */
    if (!noeud) { return null; }

    /* ---------- LA MÊME TAILLE QUE LES SIENS, ET ON PASSE À LA LIGNE ----------
     *
     * Roll20 rapetisse ses marqueurs dès que la rangée dépasserait la largeur du
     * token. Les nôtres ne le faisaient pas et sortaient du cadre.
     *
     * DEUX RÈGLES, ET DANS CET ORDRE :
     *   1. nos marqueurs ont TOUJOURS la taille des siens — on lit son échelle
     *      sur ses propres quads, on ne la choisit pas ;
     *   2. quand la ligne est pleine, on passe à la LIGNE DU DESSOUS, à la même
     *      taille. On ne rétrécit pas pour faire tenir : rapetisser encore
     *      rendrait illisible ce qui est déjà petit.
     *
     * Sa loi, relevée échelle par échelle de 1 à 14 marqueurs sur un token de
     * 140 puis de 70, sert de REPLI quand il n'a rien dessiné (donc rien à
     * lire) :
     *
     *     échelle = (largeur du token − 1,5) / (22 × nombre)
     *
     * À moins de 1 % près : pour 5 marqueurs sur un token de 70, il prend 0,62
     * et la formule donne 0,6227 ; pour 14, il prend 0,22 et elle donne 0,2224.
     *
     * ET IL NE COMPTE QUE CE QU'IL DESSINE : mesuré, ajouter cinq marqueurs à
     * nous ne change PAS son échelle. C'est pourquoi la capacité d'une ligne se
     * calcule avec SON pas à lui, et pourquoi le débordement nous revient. */
    var largeur = a.width || 70;
    var k = part.notre.length, quads = [], j, q, url;
    /* COMBIEN DE CASES IL OCCUPE : ce qu'il a DESSINÉ fait foi, pas notre
     * décompte d'étiquettes. Les deux diffèrent dès qu'une de ses images manque,
     * et c'est notre première case qui se décale. */
    var nSien = luR20 ? luR20.n : part.sien;
    var ech = echLue;
    if (ech === null) {
      /* Rien de lui à lire : soit il n'a aucun marqueur, soit ils ne sont pas
       * encore dessinés. On applique alors sa loi à son propre compte — la
       * rangée doit tenir dans la largeur, et sa largeur vaut 22 × échelle ×
       * nombre (voir plus bas). C'est une APPROXIMATION : ses échelles réelles
       * sont quantifiées par pas de 0,02 d'une façon qu'on ne reproduit pas
       * exactement. Elle ne sert qu'un instant, le temps qu'il dessine. */
      ech = part.sien ? Math.min(1, largeur / (MARQUEUR_PAS * part.sien)) : 1;
    }
    var cote = MARQUEUR_COTE * ech;
    var pas = MARQUEUR_PAS * ech;
    /* TOUT SUIT L'ÉCHELLE, Y COMPRIS LA MARGE DU BORD.
     *
     * C'était l'erreur : la marge de 1,5 entre le bord du token et la première
     * case était traitée comme FIXE, si bien que le premier centre tombait à
     * -1,5 - 11×échelle. Juste à taille pleine (-12,5), faux dès qu'il
     * rapetisse — pour une échelle de 0,7 il pose son premier marqueur en
     * -8,75, soit -12,5 × 0,7, et nous en -9,2. Un décalage d'un demi-pixel qui
     * se voyait aussitôt qu'on les mettait côte à côte.
     *
     * La loi est bien plus simple qu'elle n'en avait l'air : SA RANGÉE EST LA
     * RANGÉE À TAILLE PLEINE, MULTIPLIÉE PAR L'ÉCHELLE. Position comme taille.
     *
     *     centre de la case i  =  (-12,5 - 22 i) × échelle
     *
     * Vérifié : pour 9 marqueurs sur un token de 140, il prend 0,7 ; le dernier
     * tombe en -8,75 et le premier en -131,95, soit exactement -12,5×0,7 et
     * (-12,5 - 22×8)×0,7. */
    var premier = -MARQUEUR_BORD * ech;
    /* LA LIGNE EST UNE INVENTION DE NOTRE CÔTÉ, ET SA CAPACITÉ EST LA SIENNE.
     *
     * ROLL20 N'A PAS DE LIGNES. Il ne connaît qu'une rangée, et il rapetisse
     * jusqu'à tout y faire tenir — quel que soit le nombre. Le passage à la
     * ligne n'existe que chez nous, parce que nous refusons de rapetisser
     * davantage : ce qui est déjà petit deviendrait illisible.
     *
     * D'où la règle, et elle est de l'auteur : NOTRE LIGNE PORTE AUTANT DE CASES
     * QUE LA SIENNE EN PORTE À CET INSTANT. On ne calcule donc pas une capacité,
     * on la CONSTATE.
     *
     * Le premier jet la calculait — floor(largeur / pas) — et se trompait dès
     * qu'il rapetissait : avec onze marqueurs sur un token de 140 il prend 0,58,
     * soit 140,4 pour 140. La formule en comptait DIX par ligne, lui en mettait
     * ONZE ; notre douzième case partait en colonne 1 de la seconde ligne, avec
     * un trou à sa droite. Invisible tant qu'on ne dépassait pas dix marqueurs.
     *
     * MAIS SON COMPTE NE MESURE RIEN TANT QU'IL N'A PAS RAPETISSÉ, et c'était le
     * défaut. « Autant de cases que la sienne en porte » dit combien il en A, pas
     * combien il en TIENT : avec UN seul marqueur à taille pleine sur un token de
     * 140, la capacité tombait à un, et cinq marqueurs à nous descendaient en
     * colonne, quatre d'entre eux hors du token. Le cas est le plus courant en
     * jeu, et une pose multiple l'atteint au premier essai.
     *
     * On prend donc le PLUS GRAND des deux : ce qu'il a dessiné, et ce qui tient
     * à l'échelle courante. Quand il a rapetissé, son compte l'emporte — c'est le
     * cas que la règle de l'auteur visait, où onze des siens tiennent dans 140
     * alors que le calcul n'en compte que dix. Quand il est à taille pleine, il
     * ne mesure rien et c'est le calcul qui vaut. Les deux branches d'avant n'en
     * font plus qu'une : « aucun marqueur » n'est que le cas où son compte est
     * nul, et le maximum le traite tout seul. */
    var parLigne = Math.max(1, nSien, Math.floor(largeur / pas));

    for (j = 0; j < k; j++) {
      url = part.notre[j].url;
      q = cl.Maillage.CreatePlane("vttk-marqueur-" + part.notre[j].tag, 1, S);
      q.material = materiauMarqueur(S, cl, url);
      q.parent = noeud;
      q.scaling.x = cote;
      q.scaling.y = cote;
      /* LA CASE, ET RIEN QUE LA CASE. Les cases sont numérotées depuis la droite,
       * en continu : celles de Roll20 d'abord, les nôtres à la suite. Le rang se
       * déduit du numéro, et la colonne aussi — c'est tout ce qu'il y a à faire
       * pour que la ligne suivante se remplisse toute seule.
       *
       * L'ORDRE EST CELUI DU CHAMP, PAS CELUI DE LA PALETTE — le commentaire
       * disait le contraire, et c'était faux. `statusmarkers` est une liste
       * ordonnée que Roll20 diffuse telle quelle ; la palette ne décide que de
       * l'ordre dans lequel une pose MULTIPLE y entre. La rangée se remplissant
       * de droite à gauche, la dernière étiquette du champ se colle aux siennes :
       * d'où le (k - 1 - j). */
      var caseNo = nSien + (k - 1 - j);
      var rang = Math.floor(caseNo / parLigne);
      var colonne = caseNo % parLigne;
      q.position.x = premier - pas * colonne;
      q.position.y = premier - pas * rang;
      /* DEVANT LE TOKEN, ET PAS À SA HAUTEUR.
       *
       * Roll20 pose les siens à z = 0 sous ce nœud, donc à la profondeur EXACTE
       * du token, et s'en tire par un `zOffset` sur son matériau. À la même
       * profondeur mais sans cette ruse, les nôtres passaient DERRIÈRE l'image
       * du token — et comme la rangée est à l'intérieur du token, ils y
       * disparaissaient. Vu à l'usage, pas au banc.
       *
       * On les avance donc franchement. La caméra est en z = 0 et regarde vers
       * les z croissants : plus petit veut dire plus près. Cent unités, c'est
       * assez pour passer devant à coup sûr — la profondeur est linéaire sur
       * seize millions d'unités, une seule ne pèserait qu'un cran du tampon —
       * et bien assez peu pour rester dans le créneau du token, que Roll20
       * espace de cinq cents. Un token posé PAR-DESSUS continue donc de couvrir
       * nos marqueurs, exactement comme il couvre les siens. */
      q.position.z = -MARQUEUR_AVANCE;
      /* Les mêmes réglages que Roll20 donne aux siens, relevés un par un :
       * groupe 0, dessiné en dernier parmi les transparents, hors de portée du
       * clic, et toujours tenu pour actif — un quad de dix-neuf unités ne vaut
       * pas qu'on le teste contre le tronc de vue à chaque trame.
       *
       * PAS DE freezeWorldMatrix ICI, et c'est délibéré : c'est justement en
       * recalculant sa matrice depuis son parent que le quad suit le token. */
      q.renderingGroupId = 0;
      q.alphaIndex = Number.MAX_VALUE;
      q.isPickable = false;
      q.alwaysSelectAsActiveMesh = true;
      quads.push(q);

      /* LE COMPTEUR, S'IL Y EN A UN. Il se pose dans la même boucle parce qu'il
       * se place PAR RAPPORT À SON MARQUEUR, et pas par rapport à la rangée : il
       * n'occupe aucune case, il ne décale rien, il ne compte pour rien.
       *
       * Un échec ici ne doit pas emporter le marqueur : si la classe manque —
       * une scène où Roll20 n'aurait aucune texture dynamique —, on dessine le
       * marqueur sans son nombre, ce qui vaut mieux que rien du tout. */
      if (part.notre[j].nombre) {
        var mn = materiauNombre(S, cl, part.notre[j].nombre);
        if (mn) {
          var qn = cl.Maillage.CreatePlane(
            "vttk-nombre-" + part.notre[j].tag + "@" + part.notre[j].nombre, 1, S);
          qn.material = mn;
          qn.parent = noeud;
          qn.scaling.x = (largeurNombre(part.notre[j].nombre) / NOMBRE_DENSITE) * ech;
          qn.scaling.y = (NOMBRE_HAUT / NOMBRE_DENSITE) * ech;
          qn.position.x = q.position.x;
          qn.position.y = q.position.y - NOMBRE_SOUS * ech;
          /* DEVANT SON PROPRE MARQUEUR, et pas seulement devant le token : les
           * deux quads se chevauchent sur leur tiers bas, et à profondeur égale
           * l'ordre de rendu déciderait — c'est-à-dire le hasard. Une unité
           * suffit, le tampon de profondeur est linéaire ici. */
          qn.position.z = -MARQUEUR_AVANCE - 1;
          qn.renderingGroupId = 0;
          qn.alphaIndex = Number.MAX_VALUE;
          qn.isPickable = false;
          qn.alwaysSelectAsActiveMesh = true;
          quads.push(qn);
        }
      }
    }
    marqueursPoses[id] = { signature: signature, quads: quads };
    /* ON REPASSERA TANT QU'IL N'A PAS FINI.
     *
     * Deux cas, et le second manquait : soit il n'a rien dessiné alors qu'il a
     * des marqueurs (on a pris la formule de repli), soit il en a dessiné un
     * nombre DIFFÉRENT de ce que les étiquettes annoncent — il est en train de
     * les poser. Dans les deux cas la géométrie qu'on vient d'écrire est
     * provisoire, et la signature verra la différence au passage suivant.
     *
     * Le rendez-vous est unique et court. Rien ne se déclenche s'il a fini. */
    if ((luR20 === null ? part.sien > 0 : luR20.n !== part.sien) && !marqueursRetard) {
      marqueursRetard = setTimeout(function () {
        marqueursRetard = null;
        try { redessineMarqueurs(); } catch (e) {}
      }, 600);
    }
    return true;
  }

  function graphiquesCourants() {
    var C = window.Campaign;
    var p = C && C.activePage && C.activePage();
    return (p && p.thegraphics) || null;
  }

  /* Repasser sur toute la page. C'est le chemin lent, et il ne sert qu'à
   * l'installation, au changement de catalogue et au changement de page. Le
   * travail courant passe par l'écouteur, un token à la fois. */
  function redessineMarqueurs() {
    var S = window.MeshScene;
    if (!marqueursActif || !S) { return { ok: false, raison: "scene-absente" }; }
    var col = graphiquesCourants();
    if (!col) { return { ok: false, raison: "page-absente" }; }
    var cl = classesMarqueur(S);
    if (!cl) { return { ok: false, raison: "classes-babylon-introuvables" }; }

    var vus = {}, poses = 0, attente = 0;
    var t0 = (window.performance && performance.now) ? performance.now() : 0;
    col.models.forEach(function (t) {
      vus[t.id] = true;
      var part = partageEtiquettes((t.attributes || {}).statusmarkers);
      if (!part.notre.length && !marqueursPoses[t.id]) { return; }
      /* `null` ET LUI SEUL veut dire « il manque le nœud, repasse ». `false` veut
       * dire « déjà à jour », et le confondre avec une attente faisait battre ce
       * balayage indéfiniment. */
      if (poseMarqueursSur(S, cl, t) === null) { attente++; }
      if (marqueursPoses[t.id]) { poses += marqueursPoses[t.id].quads.length; }
    });
    /* Un token effacé, ou parti sur une autre page : ses quads n'ont plus de
     * nœud pour les porter, et Babylon les garderait indéfiniment. */
    for (var id in marqueursPoses) {
      if (Object.prototype.hasOwnProperty.call(marqueursPoses, id) && !vus[id]) { oteMarqueursDe(id); }
    }
    /* Des tokens attendaient leur nœud : on repasse une fois, plus tard. Un
     * seul rendez-vous en vol, jamais une boucle. */
    if (attente && !marqueursRetard) {
      marqueursRetard = setTimeout(function () {
        marqueursRetard = null;
        try { redessineMarqueurs(); } catch (e) {}
      }, 700);
    }
    var ms = t0 ? Math.round((performance.now() - t0) * 10) / 10 : null;
    return { ok: true, quads: poses, tokens: col.models.length, attente: attente,
             images: Object.keys(marqueursMat).length, ms: ms };
  }

  /* L'ÉCOUTE, ET RIEN D'AUTRE. Backbone prévient sur le seul attribut qui nous
   * concerne : personne n'a besoin d'un guet, ni d'un intervalle, ni d'un
   * observateur du DOM. Un déplacement de token ne passe pas par ici — le nœud
   * de Roll20 s'en charge tout seul. */
  function lieMarqueurs() {
    delieMarqueurs();
    var col = graphiquesCourants();
    if (!col || !col.on) { return; }
    var S = window.MeshScene;
    marqueursSurChange = function (t) {
      if (!marqueursActif || !S) { return; }
      var cl = classesMarqueur(S);
      if (!cl) { return; }
      /* UN « catch » MUET EST UN PIÈGE. Celui-ci a déjà coûté une session : les
       * quads ne paraissaient pas, l'erreur était avalée, et rien nulle part ne
       * disait pourquoi. Elle est désormais retenue, lisible depuis n'importe
       * quel outil qui regarde la page. Ça ne coûte qu'une affectation, et
       * seulement quand ça casse. */
      try { poseMarqueursSur(S, cl, t); }
      catch (e) { window.__vttinkerMarqueursErreur = String(e && e.stack || e).slice(0, 400); }
    };
    col.on("change:statusmarkers", marqueursSurChange);
    /* LA LARGEUR AUSSI, et c'est elle qui décide de la capacité d'une ligne :
     * redimensionner un token peut faire passer nos marqueurs de deux lignes à
     * une, ou l'inverse, sans qu'une seule étiquette bouge. Tant que le balayage
     * se rappelait indéfiniment tout seul, le cas se réparait par accident ;
     * maintenant qu'il ne bat plus, il faut l'écouter pour de bon. C'est UN
     * abonnement de collection, pas un par token. */
    col.on("change:width", marqueursSurChange);
    col.on("add", marqueursSurChange);
    col.on("remove", function (t) { oteMarqueursDe(t.id); });
    marqueursLiee = col;
  }

  function delieMarqueurs() {
    if (marqueursLiee && marqueursLiee.off) {
      try { marqueursLiee.off("change:statusmarkers", marqueursSurChange); } catch (e) {}
      try { marqueursLiee.off("change:width", marqueursSurChange); } catch (e) {}
      try { marqueursLiee.off("add", marqueursSurChange); } catch (e) {}
      try { marqueursLiee.off("remove"); } catch (e) {}
    }
    marqueursLiee = null;
    marqueursSurChange = null;
  }

  /* ============================================================
   *              LA BARRE : POSER ET RETIRER UN MARQUEUR
   * ============================================================
   *
   * ELLE NE S'APPUIE SUR RIEN DE ROLL20, ET C'EST DÉLIBÉRÉ.
   *
   * Le chemin évident aurait été de lire sa sélection — « choisissez un token,
   * puis cliquez un marqueur ». On a cherché : `d20.engine.tabletopSelected` existe
   * et porte bien une liste, mais elle est restée vide sous un clic de pilote
   * COMME sous des événements de pointeur dispatchés dans la page. Sa sélection
   * ne s'atteint pas du dehors, et un module qui en dépendrait se casserait le
   * jour où elle change de nom.
   *
   * On fait donc le pointage nous-mêmes, avec ce qu'on a déjà : la caméra, et
   * le rectangle de chaque token (left, top, width, height), qui sont des
   * données de la page et non des détails d'implémentation.
   *
   * L'ENCHAÎNEMENT : on arme un marqueur dans la barre, on clique un token, le
   * marqueur s'y pose — ou s'en retire s'il y était. Le marqueur reste armé, pour en
   * marquer plusieurs de suite. Échap, un clic hors token, ou le même bouton
   * désarment.
   *
   * ET RIEN N'ÉCOUTE TANT QUE RIEN N'EST ARMÉ : l'écouteur du plateau est posé
   * à l'armement et retiré au désarmement. Une extension qui garde un écouteur
   * de clic en capture sur toute la page, sur une machine modeste, se paie à
   * chaque clic — celui-ci ne coûte que pendant les deux secondes où il sert. */

  var barre = null;      // la palette elle-même
  var outil = null;      // notre bouton, CLONÉ dans sa colonne d'outils
  var outilTitre = null; // l'intitulé de notre section, cloné des siens
  var paletteOuverte = false;
  var etaitFlottante = false;   // la palette a-t-elle été montée SANS colonne où se greffer

  /* ---------- ON EN CHOISIT PLUSIEURS, ET ON LES POSE D'UN COUP ----------
   *
   * `choix` est une liste ORDONNÉE de { tag, nombre } — l'ordre est celui des
   * clics, parce que c'est le seul que l'utilisateur a lui-même produit, et
   * c'est dans cet ordre qu'ils entreront dans la rangée du token.
   *
   * `nombre` est le compteur de Roll20, une chaîne de un à trois chiffres ou
   * vide. Il se saisit au CLAVIER, en survolant la tuile — voir plus bas. */
  var choix = [];

  /* ---------- DEUX MANIÈRES DE POSER, ET ON CHOISIT LAQUELLE ----------
   *
   * « marqueur » — on arme un marqueur dans la palette, puis on clique les
   *   tokens. C'est la manière d'origine, et la bonne quand on met le MÊME
   *   marqueur sur plusieurs tokens dispersés.
   *
   * « tokens » — on sélectionne d'abord les tokens, avec la sélection de Roll20
   *   et ses poignées habituelles, puis on clique un marqueur : il s'applique à
   *   toute la sélection d'un coup. C'est la bonne quand on met PLUSIEURS
   *   marqueurs sur les mêmes tokens.
   *
   * Les deux emploient exactement la même règle de pose — `champApres` — donc
   * aucun des cas déjà éprouvés ne change de réponse selon le mode. */
  var MODE_MARQUEUR = "marqueur", MODE_TOKENS = "tokens";
  var modePose = MODE_MARQUEUR;

  /* LA SÉLECTION DE ROLL20, LUE AU MOMENT DU CLIC ET PAS AVANT.
   *
   * `d20.engine.tabletopSelected` EST UNE FONCTION, et c'est ce qui avait été
   * mal lu : un relevé ancien la prenait pour un tableau, la trouvait vide, et
   * concluait que sa sélection était inatteignable — d'où le pointage qu'on fait
   * nous-mêmes dans l'autre mode. Elle délègue à
   * `VTTEngine.instance.tabletop.getSelection()`, et chaque entrée porte `id` et
   * `model`, mesuré sur une vraie partie.
   *
   * ON LA LIT À LA DEMANDE : rien à surveiller, rien à mémoriser, donc rien qui
   * puisse vieillir. Le seul instant qui compte est celui du clic. */
  function selectionRoll20() {
    var d, brut, out = [], i, o, m, col;
    try { d = (window.currentPlayer && window.currentPlayer.d20) || window.d20; } catch (e) { return []; }
    if (!d || !d.engine || typeof d.engine.tabletopSelected !== "function") { return []; }
    try { brut = d.engine.tabletopSelected(); } catch (e) { return []; }
    if (!brut || !brut.length) { return []; }
    col = graphiquesCourants();
    for (i = 0; i < brut.length; i++) {
      o = brut[i];
      if (!o) { continue; }
      /* Le modèle d'abord, l'identifiant en repli : le premier est ce que Roll20
       * nous tend, le second ce qu'on sait retrouver. */
      m = (o.model && o.model.attributes) ? o.model : (col && o.id ? col.get(o.id) : null);
      if (m && m.attributes && out.indexOf(m) < 0) { out.push(m); }
    }
    return out;
  }

  var edition = false;         // le rouage : ajouter, supprimer, trier
  var survol = null;           // l'étiquette de la tuile sous le pointeur
  var survolQuand = 0;         // quand son dernier chiffre a été frappé
  var traine = null;           // l'étiquette qu'on est en train de déplacer

  function rangDansChoix(tag) {
    for (var i = 0; i < choix.length; i++) { if (choix[i].tag === tag) { return i; } }
    return -1;
  }

  function nombreDe(tag) {
    var i = rangDansChoix(tag);
    return i < 0 ? "" : choix[i].nombre;
  }

  /* Le lien écran ↔ plateau, mesuré à chaque clic plutôt que mémorisé : la
   * caméra bouge sans prévenir, et deux projections coûtent moins cher qu'un
   * cache faux. La caméra est orthographique et alignée sur les axes, donc la
   * correspondance est affine et deux points suffisent à l'établir. */
  function repereEcran() {
    var S = window.MeshScene;
    if (!S) { return null; }
    var e = S.getEngine();
    var c = null, i;
    for (i = 0; i < (S.cameras || []).length; i++) {
      if (/main-camera/.test(S.cameras[i].name)) { c = S.cameras[i]; }
    }
    c = c || S.activeCamera;
    var cv = e && e.getRenderingCanvas();
    if (!c || !cv) { return null; }
    var V = c.position.constructor, M = c.getWorldMatrix().constructor;
    var vp = c.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight());
    var tm = S.getTransformMatrix(), id = M.Identity();
    var r = cv.getBoundingClientRect();
    var kx = r.width / e.getRenderWidth(), ky = r.height / e.getRenderHeight();
    function proj(x, y) {
      var p = V.Project(new V(x, y, 9999000), id, tm, vp);
      return [p.x * kx + r.left, p.y * ky + r.top];
    }
    var o = proj(0, 0), u = proj(1000, 1000);
    var ax = (u[0] - o[0]) / 1000, ay = (u[1] - o[1]) / 1000;
    if (!ax || !ay) { return null; }
    return {
      rect: r,
      versPlateau: function (sx, sy) { return [(sx - o[0]) / ax, (sy - o[1]) / ay]; }
    };
  }

  /* Le token sous le point, en partant du dessus. L'ordre est celui de la
   * profondeur mesurée : le premier de la collection est le plus LOIN
   * (z 9999000) et le dernier le plus près (9997500), donc on remonte. */
  function tokenSous(sx, sy) {
    var rep = repereEcran();
    var col = graphiquesCourants();
    if (!rep || !col) { return null; }
    var p = rep.versPlateau(sx, sy);
    var x = p[0], y = -p[1];   // le plateau compte ses y vers le bas
    for (var i = col.models.length - 1; i >= 0; i--) {
      var t = col.models[i], a = t.attributes || {};
      if (a.layer !== "objects" && a.layer !== "gmlayer") { continue; }
      var dw = (a.width || 0) / 2, dh = (a.height || 0) / 2;
      if (!dw || !dh) { continue; }
      if (x >= a.left - dw && x <= a.left + dw && y >= a.top - dh && y <= a.top + dh) { return t; }
    }
    return null;
  }

  /* ============================================================
   *      CE QUE DEVIENT LE CHAMP QUAND ON POSE UNE SÉLECTION
   * ============================================================
   *
   * C'est une fonction PURE, et c'est délibéré : elle prend le champ tel qu'il
   * est et rend le champ tel qu'il devra être. Tous les cas tordus s'éprouvent
   * alors au banc, sans Backbone, sans Babylon et sans partie.
   *
   * LA RÈGLE, telle que l'auteur l'a posée : on AJOUTE, sans doublon, dès qu'au
   * moins un des marqueurs choisis manque ; on RETIRE tous les marqueurs choisis
   * s'ils sont tous déjà là. Un seul marqueur choisi n'est qu'un cas particulier
   * de cette règle, et c'est la bascule d'avant.
   *
   * DEUX IDENTITÉS, ET C'EST CE QUI FAIT TENIR LE COMPTEUR :
   *
   *   · « EST-IL DÉJÀ LÀ ? » se juge sur ce qu'on POSE. Un marqueur choisi sans
   *     nombre est là dès que sa base y est, compteur ou pas — cliquer une tuile
   *     déjà posée la retire, qu'elle porte « @3 » ou rien. Un marqueur choisi
   *     AVEC un nombre n'est là que si le champ porte exactement ce nombre :
   *     frapper 3 sur un marqueur qui est à 3 le retire, frapper 3 sur un
   *     marqueur qui est à 5 le passe à 3. C'est ce qu'on attend d'un compteur,
   *     et ça se déduit de la règle au lieu d'y ajouter une exception.
   *   · « EST-CE UN DOUBLON ? » se juge sur la BASE. Deux entrées de même base
   *     n'ont aucun sens — Roll20 en dessinerait deux, et son propre menu
   *     travaille par différence sur la base.
   *
   * ON NE TOUCHE À RIEN D'AUTRE. Les étiquettes que le champ portait déjà et
   * qu'on n'a pas choisies restent en place, dans leur ordre, y compris celles
   * que personne ne dessine. Un module qui « nettoie » ce qu'il ne comprend pas
   * efface le travail d'un autre. */
  function textePose(c) { return c.nombre ? c.tag + "@" + c.nombre : c.tag; }

  /* Le champ, découpé en entrées propres. Deux fonctions le font, autant qu'elles
   * le fassent pareil. */
  function entreesDe(brut) {
    var liste = String(brut || "").split(","), out = [], i, e;
    for (i = 0; i < liste.length; i++) { e = liste[i].trim(); if (e) { out.push(e); } }
    return out;
  }

  /* « CE CHOIX EST-IL DÉJÀ LÀ ? » — l'identité se juge sur ce qu'on POSE : un
   * choix nu est là dès que sa base y est, compteur ou pas ; un choix numéroté
   * ne l'est que si le champ porte exactement ce nombre. */
  function choixPresent(avant, c) {
    for (var k = 0; k < avant.length; k++) {
      if (c.nombre) { if (avant[k] === textePose(c)) { return true; } }
      else if (avant[k].split("@")[0] === c.tag) { return true; }
    }
    return false;
  }

  function tousLesChoixSont(brut, sel) {
    var avant = entreesDe(brut), i;
    if (!sel || !sel.length) { return false; }
    for (i = 0; i < sel.length; i++) { if (!choixPresent(avant, sel[i])) { return false; } }
    return true;
  }

  /* LA DÉCISION EST DONNÉE, ELLE N'EST PLUS PRISE ICI — et c'est tout le
   * changement. Elle se prend sur l'ENSEMBLE des tokens visés, une fois pour
   * tous : « si tous les tokens ont le marqueur, on le retire à tous ; sinon on
   * l'ajoute à ceux qui ne l'ont pas ». Un token à la fois, cette fonction ne
   * pouvait pas la prendre — elle ne voit qu'un champ. */
  function champApres(brut, sel, retirer) {
    /* UNE SÉLECTION VIDE N'EST PAS UNE POSE, et surtout pas un rangement. Le
     * quantificateur piège : « tous les marqueurs choisis sont là » est VRAI sur
     * un ensemble vide, et la lecture littérale tombait donc dans la branche de
     * retrait. Elle ne retirait rien — mais elle rendait le champ NORMALISÉ, ce
     * qui aurait réécrit dans la campagne un champ que personne n'a demandé de
     * réécrire. On rend l'entrée telle quelle, et rien ne part. */
    if (!sel || !sel.length) { return String(brut || ""); }
    var avant = entreesDe(brut), i;
    var tous = !!retirer;

    var vise = {};
    for (i = 0; i < sel.length; i++) { vise[sel[i].tag] = sel[i]; }

    var out = [];
    for (i = 0; i < avant.length; i++) {
      var base = avant[i].split("@")[0];
      var c = vise[base];
      /* On garde tout ce qui n'est pas visé. Puis, parmi ce qui l'est : on
       * retire quand la règle dit de retirer ; on RÉÉCRIT SUR PLACE quand on lui
       * donne un nombre ; et on garde tel quel quand le choix est nu et la base
       * déjà là, pour ne pas effacer en silence un compteur qu'on ne nous a pas
       * demandé de toucher.
       *
       * SUR PLACE, ET C'EST TOUT L'INTÉRÊT. Le premier jet laissait tomber
       * l'entrée ici et la republiait en fin de boucle : renuméroter un marqueur
       * le faisait donc SAUTER à l'autre bout de la rangée du token. Passer un
       * poison de 3 à 4 déplaçait le pictogramme sous les yeux du joueur, et
       * décalait au passage tous ceux qui le suivaient. La position dans le
       * champ est une donnée à part entière : un compteur qui change ne doit
       * rien déplacer. */
      if (!c) { out.push(avant[i]); continue; }
      if (tous) { continue; }
      out.push(c.nombre ? textePose(c) : avant[i]);
    }
    if (!tous) {
      for (i = 0; i < sel.length; i++) {
        /* LE DOUBLON SE JUGE SUR LA BASE, PAS SUR LE TEXTE POSÉ — et c'était le
         * défaut. En comparant les textes, « skull@7 » ne satisfaisait pas
         * « skull » : sur un token qui portait déjà « skull@7 », choisir skull ET
         * un marqueur absent écrivait « skull@7,skull,snail ». Roll20 dessinait
         * skull DEUX FOIS, sa rangée comptait une case de trop, et comme notre
         * première case se déduit de la sienne, tous nos marqueurs se
         * décalaient. Le défaut n'existait QUE dans le chemin à plusieurs : la
         * bascule d'un seul marqueur n'y passait jamais.
         *
         * Une base déjà présente à ce stade ne peut être qu'un choix NU dont
         * l'entrée a été gardée exprès — une entrée visée par un choix numéroté
         * a été retirée plus haut pour être réécrite. On n'ajoute donc rien, et
         * le compteur qu'on ne nous a pas demandé de toucher reste en place. */
        var c = sel[i], deja = false;
        for (var k = 0; k < out.length; k++) {
          if (out[k].split("@")[0] === c.tag) { deja = true; break; }
        }
        if (!deja) { out.push(textePose(c)); }
      }
    }
    return out.join(",");
  }

  /* ============================================================
   *        MJ OU JOUEUR : QUI A LE DROIT D'ÉCRIRE QUOI
   * ============================================================
   *
   * ROLL20 NE LAISSE ÉCRIRE UN TOKEN QU'À QUI LE CONTRÔLE. Un joueur qui pose
   * un marqueur sur un token d'autrui verrait le marqueur apparaître — Backbone
   * met le modèle à jour localement — puis DISPARAÎTRE quand le serveur reprend
   * la valeur. Rien n'expliquerait pourquoi, et la pose serait invisible pour
   * tout le monde y compris lui.
   *
   * MESURÉ SUR DEUX VRAIES PARTIES, la même en MJ et en joueur :
   *
   *                        MJ        joueur
   *     window.is_gm       true      false
   *     tokens contrôlés   0         3
   *
   * ET C'EST TOUT LE PIÈGE : le `controlledby` d'un token de MJ est VIDE. Une
   * vérification qui ne regarderait que ce champ interdirait au MJ de marquer
   * ses propres tokens — c'est-à-dire tous. Le drapeau passe donc AVANT.
   *
   * QUAND ON NE SAIT PAS, ON AUTORISE. Si Roll20 renommait `is_gm`, refuser par
   * défaut retirerait la fonction entière à tous les MJ ; autoriser laisse au
   * pire un joueur devant un marqueur qui s'efface — désagréable, mais partiel
   * et réversible. On ne choisit pas la panne la plus grave par prudence. */
  function suisJeMJ() {
    try { if (typeof window.is_gm === "boolean") { return window.is_gm; } } catch (e) {}
    return null;   // inconnu — voir ci-dessus
  }

  function monId() {
    try { return (window.currentPlayer && window.currentPlayer.id) || null; } catch (e) { return null; }
  }

  function puisJeEcrire(t) {
    var mj = suisJeMJ();
    if (mj !== false) { return true; }        // MJ, ou drapeau inconnu
    var c = String((t.attributes || {}).controlledby || "");
    if (!c) { return false; }                 // personne : c'est un token de MJ
    var qui = c.split(",");
    if (qui.indexOf("all") >= 0) { return true; }
    var moi = monId();
    return !!(moi && qui.indexOf(moi) >= 0);
  }

  /* ============================================================
   *   LA POSE, SUR UN TOKEN OU SUR CENT — ET UNE SEULE DÉCISION
   * ============================================================
   *
   * LA RÈGLE, TELLE QUE L'AUTEUR L'A POSÉE, ET LA MÊME DANS LES DEUX MODES :
   *
   *   · si TOUS les tokens visés ont le marqueur, on le retire à TOUS ;
   *   · sinon on l'ajoute à tous ceux qui ne l'ont pas.
   *
   * LA DÉCISION EST DONC COLLECTIVE, et c'est ce qui a changé. Chaque token
   * était jugé sur son propre champ : de deux tokens sélectionnés dont un seul
   * portait le marqueur, le premier le perdait pendant que le second le
   * gagnait — les deux se croisaient sans jamais se rejoindre, et cliquer deux
   * fois ne faisait qu'échanger leurs états. On regarde donc l'ensemble d'abord,
   * on décide une fois, et on applique.
   *
   * ELLE SE PREND SUR LES TOKENS QU'ON PEUT ÉCRIRE, et sur eux seuls : un token
   * d'autrui qu'on ne pourra pas toucher n'a pas à faire pencher la décision
   * pour les autres.
   *
   * UN SEUL TOKEN N'EST QUE LE CAS DÉGÉNÉRÉ : « tous » vaut « lui », et on
   * retrouve exactement la bascule du premier mode. C'est pourquoi les deux
   * modes passent ici, et pourquoi aucun cas déjà éprouvé ne change de réponse. */
  function appliqueA(tokens, sel) {
    var bilan = { poses: 0, inchanges: 0, refuses: 0, retire: false }, i;
    if (!sel || !sel.length) { return bilan; }

    var permis = [];
    for (i = 0; i < tokens.length; i++) {
      if (puisJeEcrire(tokens[i])) { permis.push(tokens[i]); }
      else { bilan.refuses++; }
    }
    if (!permis.length) { return bilan; }

    var retirer = true;
    for (i = 0; i < permis.length; i++) {
      var champ = (permis[i].attributes && permis[i].attributes.statusmarkers) || "";
      if (!tousLesChoixSont(champ, sel)) { retirer = false; break; }
    }
    bilan.retire = retirer;

    for (i = 0; i < permis.length; i++) {
      var t = permis[i];
      var brut = (t.attributes && t.attributes.statusmarkers) || "";
      var neuf = champApres(brut, sel, retirer);
      if (neuf === String(brut || "")) { bilan.inchanges++; continue; }
      try { t.save({ statusmarkers: neuf }); bilan.poses++; }
      catch (e) { bilan.refuses++; }
    }
    return bilan;
  }

  /* Poser sur UN token, par le chemin de Roll20 lui-même : save() sur le modèle.
   * C'est ce qui fait que les autres joueurs voient la pose — l'étiquette est
   * une donnée de la campagne comme les siennes, et elle se diffuse comme
   * elles. */
  function poseChoixSur(t, sel) {
    return appliqueA([t], sel).poses > 0;
  }

  /* « ev.target est-il dans la barre ? » à la main : on remonte les parents.
   * Node.contains ferait la même chose, mais le banc monte un DOM réduit, et un
   * code qui n'emploie que appendChild/parentNode s'y éprouve tel quel. */
  function dansLaBarre(n) {
    while (n) { if (n === barre) { return true; } n = n.parentNode; }
    return false;
  }

  function surClicPlateau(ev) {
    if (!choix.length) { return; }
    if (barre && dansLaBarre(ev.target)) { return; }
    var t = tokenSous(ev.clientX, ev.clientY);
    if (!t) { videChoix(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    /* ON REFUSE AVANT D'ÉCRIRE, ET ON LE DIT. Écrire quand même donnerait un
     * marqueur qui paraît puis s'efface tout seul quelques secondes plus tard —
     * le pire des comptes rendus, celui qui ment d'abord. */
    if (!puisJeEcrire(t)) {
      var nom = (t.attributes && t.attributes.name) || "ce token";
      dit("« " + nom + " » " + ditLe("pal.pasAVous", "ne vous appartient pas — Roll20 refuserait la pose."), true);
      versContenu({ type: "marqueurs-refus", token: String(nom).slice(0, 40) });
      return;
    }
    try { poseChoixSur(t, choix); } catch (e) {}
  }

  /* ÉCHAP EST ÉCOUTÉ PAR DEUX CHOSES — le tiroir et l'armement —, mais UNE SEULE
   * FOIS. Un vrai DOM ignore un second addEventListener avec le même couple
   * (type, fonction, capture), si bien qu'un double enregistrement ne se voit
   * pas à l'usage ; s'appuyer là-dessus reste une négligence, et le banc l'a
   * relevée. On tient donc l'état nous-mêmes. */
  var toucheLiee = false;

  function lieTouche() {
    if (toucheLiee) { return; }
    window.addEventListener("keydown", surToucheMarqueur, true);
    toucheLiee = true;
  }

  function delieTouche() {
    if (!toucheLiee) { return; }
    window.removeEventListener("keydown", surToucheMarqueur, true);
    toucheLiee = false;
  }

  /* ---------- LE CHIFFRE AU SURVOL ----------
   *
   * On survole une tuile, on frappe un chiffre : le marqueur est choisi ET
   * numéroté. C'est le geste de Roll20 sur ses propres marqueurs, et il n'y a
   * aucune raison qu'il s'arrête aux siens.
   *
   * LES CHIFFRES S'ENCHAÎNENT tant qu'on reste sur la même tuile : « 1 » puis
   * « 2 » donnent douze, et non deux. Sans quoi les compteurs à deux chiffres
   * seraient inaccessibles alors que Roll20 en accepte trois. Une seconde de
   * silence, ou un changement de tuile, et le nombre repart à zéro.
   *
   * ZÉRO SEUL EFFACE LE NOMBRE : c'est le seul moyen de revenir à un marqueur nu
   * sans lâcher la souris, et « @0 » n'aurait de toute façon aucun sens.
   *
   * ON ARRÊTE LA TOUCHE. Roll20 a ses propres raccourcis au clavier, et un
   * chiffre qui lui parviendrait ferait tout autre chose en même temps. */
  var NOMBRE_ENCHAINE = 1000;   // ms pendant lesquelles un chiffre s'ajoute au précédent
  var NOMBRE_CHIFFRES = 3;      // ce que Roll20 accepte, mesuré jusqu'à « @999 »

  /* L'HORLOGE EST DÉCLARÉE PLUS HAUT, ET IL N'Y EN A QU'UNE.
   *
   * Une seconde vivait ici, déclarée en « function » au même niveau que la
   * première. Elle était donc MORTE : une déclaration de fonction est hissée et
   * affectée en premier, puis le « var maintenant = … » du chronomètre s'exécute
   * au chargement et l'écrase. Tous les appels, y compris celui d'à côté,
   * obtenaient l'autre.
   *
   * Elles n'étaient pas identiques — « typeof performance » contre
   * « window.performance », « Date.now() » contre « +new Date() » —, donc le
   * doublon n'était pas seulement inutile : il donnait à lire un repli qui ne
   * s'appliquait pas. On garde celle qui tourne, la plus prudente des deux. */

  /* Un champ de saisie garde ses chiffres pour lui : le formulaire d'ajout vit
   * dans la même palette, et y taper une adresse ne doit pas numéroter une
   * tuile qui se trouverait sous le pointeur. */
  function dansUnChamp(n) {
    while (n) {
      var t = n.tagName ? String(n.tagName).toUpperCase() : "";
      if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") { return true; }
      n = n.parentNode;
    }
    return false;
  }

  /* « dead » N'A PAS DROIT À UN COMPTEUR, ET C'EST MESURÉ, pas supposé. On a posé
   * « red@4,dead@2,skull@9,blue@7 » sur un vrai token : Roll20 a fabriqué un
   * maillage porteur de nombre pour red, blue et skull, et AUCUN pour dead. Il
   * ne dessine rien pour lui parce que ce n'est pas un pictogramme de rangée
   * mais une croix qui barre le token entier.
   *
   * Écrire « dead@2 » serait donc une donnée que personne ne dessine — invisible
   * chez tout le monde, et un piège pour le prochain qui lira le champ. La
   * frappe choisit quand même le marqueur, ce qui est la moitié utile du geste ;
   * elle ne lui accroche simplement aucun nombre.
   *
   * LES PASTILLES DE COULEUR, ELLES, Y ONT DROIT : c'était la vraie question, et
   * la mesure a répondu l'inverse de ce qu'on soupçonnait. */
  var SANS_COMPTEUR = { dead: true };

  function frappeChiffre(c) {
    if (!survol) { return false; }
    if (SANS_COMPTEUR[survol]) {
      if (rangDansChoix(survol) < 0) { basculeChoix(survol); }
      return true;
    }
    var i = rangDansChoix(survol);
    var t = maintenant();
    var suite = i >= 0 && (t - survolQuand) < NOMBRE_ENCHAINE;
    var n = suite ? choix[i].nombre : "";

    if (c === "0" && !n) { n = ""; }                       // zéro seul : pas de nombre
    else if (n.length < NOMBRE_CHIFFRES) { n = n + c; }
    /* Au-delà de trois chiffres on RECOMMENCE plutôt que d'ignorer : frapper un
     * quatrième chiffre veut dire qu'on s'est trompé de nombre, pas qu'on veut
     * garder les trois premiers. */
    else { n = c === "0" ? "" : c; }

    if (i < 0) { choix.push({ tag: survol, nombre: n }); armeSiBesoin(); }
    else { choix[i].nombre = n; }
    survolQuand = t;
    peintBarre();
    return true;
  }

  /* Échap défait un cran à la fois : d'abord la sélection, puis le tiroir. C'est
   * ce qu'on attend d'une touche d'échappement, et ça évite de refermer la
   * palette quand on voulait seulement changer de marqueur. */
  function surToucheMarqueur(ev) {
    /* UNE TOUCHE MAINTENUE N'EST PAS UNE SUITE DE FRAPPES. Le clavier répète
     * une trentaine de fois par seconde : garder « 3 » enfoncé une demi-seconde
     * fabriquait « 3 », « 33 », « 333 », puis repartait de « 3 » — un compteur
     * tiré au sort. Et Échap maintenue franchissait ses DEUX crans d'un coup,
     * vidant la sélection et refermant la palette avant qu'on ait relâché.
     *
     * On ignore donc les répétitions, ici et pour toutes les branches : aucune
     * de nos touches n'a de sens répétée. */
    if (ev.repeat) { return; }
    if (ev.key === "Escape" || ev.keyCode === 27) {
      /* LE PANNEAU DU DESSUS PREND LA TOUCHE. Les réglages posent leur propre
       * écouteur d'Échap ; sans cette sortie, un seul appui refermait les deux
       * panneaux à la fois, alors qu'Échap défait UN cran. */
      if (reglagesOuvert) { return; }
      /* ÉCHAP VIDE LA SÉLECTION, ET NE FERME PLUS LA PALETTE.
       *
       * Elle ne se ferme que de deux façons, voulues et énumérées : son bouton
       * dans la boîte à outils, et sa croix. Échap serait une troisième, et
       * surtout une qu'on déclenche sans y penser — la même touche sert à
       * annuler tout et n'importe quoi dans Roll20.
       *
       * ET ON LA CONSOMME quand on a effectivement défait quelque chose : sans
       * ça, Roll20 la reçoit aussi et fait de son côté ce qu'il en fait. */
      var fait = false;
      if (choix.length) { videChoix(); fait = true; }
      if (fait) {
        if (ev.preventDefault) { ev.preventDefault(); }
        if (ev.stopPropagation) { ev.stopPropagation(); }
      }
      return;
    }
    if (!paletteOuverte || !survol) { return; }
    if (ev.ctrlKey || ev.altKey || ev.metaKey) { return; }
    if (dansUnChamp(ev.target)) { return; }
    var c = ev.key !== undefined ? String(ev.key)
          : String.fromCharCode(ev.keyCode || 0);
    if (!/^[0-9]$/.test(c)) { return; }
    if (frappeChiffre(c)) {
      if (ev.preventDefault) { ev.preventDefault(); }
      if (ev.stopPropagation) { ev.stopPropagation(); }
    }
  }

  /* L'ÉCOUTEUR DU PLATEAU NE VIT QUE PENDANT LA SÉLECTION. Une extension qui
   * garde un écouteur de clic en capture sur toute la page, sur une machine
   * modeste, se paie à chaque clic. */
  function armeSiBesoin() {
    /* PAS D'ÉCOUTEUR DE PLATEAU DANS LE SECOND MODE : on n'y attend aucun clic
     * sur la carte, et un écouteur de clic en capture sur toute la page se paie
     * à chaque clic. Le chiffre au survol, lui, y garde tout son sens — il fixe
     * le compteur que la pose emportera —, d'où le fait qu'on continue de tenir
     * `choix` et d'écouter le clavier. */
    if (choix.length === 1 && modePose === MODE_MARQUEUR) {
      window.addEventListener("pointerdown", surClicPlateau, true);
    }
    lieTouche();
  }

  function basculeChoix(tag) {
    var i = rangDansChoix(tag);
    if (i >= 0) {
      choix.splice(i, 1);
      if (!choix.length) { window.removeEventListener("pointerdown", surClicPlateau, true); }
      if (!choix.length && !paletteOuverte) { delieTouche(); }
    } else {
      choix.push({ tag: tag, nombre: "" });
      armeSiBesoin();
    }
    peintBarre();
  }

  function videChoix() {
    if (!choix.length) { return; }
    choix = [];
    window.removeEventListener("pointerdown", surClicPlateau, true);
    /* La touche reste écoutée tant que le tiroir est ouvert : c'est elle qui le
     * refermera. */
    if (!paletteOuverte) { delieTouche(); }
    peintBarre();
  }

  /* La barre est refaite en entier à chaque changement de palette — quelques
   * boutons, une fois de temps en temps. La sélection, elle, ne touche qu'une
   * classe et un texte : on ne reconstruit pas le DOM pour un surlignage. */
  function peintBarre() {
    if (!barre) { return; }
    var boutons = barre.querySelectorAll(".vttk-barre-marqueur");
    for (var i = 0; i < boutons.length; i++) {
      var b = boutons[i];
      var r = rangDansChoix(b.getAttribute("data-tag"));
      b.classList.toggle("arme", r >= 0);
      b.setAttribute("aria-pressed", r >= 0 ? "true" : "false");
      /* LES DEUX PASTILLES, CHACUNE DANS SON COIN ET CHACUNE SA CHOSE.
       *
       * LE NOMBRE, à gauche : ce que le marqueur portera une fois posé.
       * LE RANG, à droite : l'ordre des clics, qui est celui dans lequel les
       * marqueurs entreront dans la rangée du token — le cacher ferait d'une
       * pose une surprise. Il ne paraît qu'à partir de deux choisis : sur un
       * seul, un « 1 » n'apprendrait rien et encombrerait la tuile. */
      var boite = b.parentNode && b.parentNode.querySelector ? b.parentNode : null;
      var pNombre = boite ? boite.querySelector(".vttk-marqueur-nombre") : null;
      var pRang = boite ? boite.querySelector(".vttk-marqueur-rang") : null;
      var n = r >= 0 ? choix[r].nombre : "";
      if (pNombre) {
        pNombre.textContent = n || "";
        pNombre.hidden = !n;
      }
      if (pRang) {
        pRang.textContent = (r >= 0 && choix.length > 1) ? String(r + 1) : "";
        pRang.hidden = !pRang.textContent;
      }
    }
    barre.classList.toggle("arme", choix.length > 0);
  }

  /* UNE FABRIQUE, PAS UNE FERMETURE DANS LA BOUCLE. Le fichier est en ES5 :
   * `var` porte sur toute la fonction, et une fermeture écrite à même la boucle
   * aurait vu la DERNIÈRE étiquette pour tous les boutons. La fabrique fige la
   * sienne dans son propre appel.
   *
   * Le clic est arrêté ici : la barre flotte au-dessus du plateau, et sans ça
   * Roll20 recevrait le même clic et désélectionnerait ce qu'on visait. */
  function faisClicBouton(etiquette) {
    return function (ev) {
      if (ev && ev.preventDefault) { ev.preventDefault(); }
      if (ev && ev.stopPropagation) { ev.stopPropagation(); }
      if (modePose === MODE_TOKENS) { appliqueSurSelection(etiquette); return; }
      basculeChoix(etiquette);
    };
  }

  /* ---------- LE SECOND MODE : LES TOKENS D'ABORD ----------
   *
   * On applique à TOUTE la sélection de Roll20, avec la même règle qu'un clic
   * sur le plateau — donc la même arithmétique d'ajout et de retrait, token par
   * token. Deux tokens dont l'un porte déjà le marqueur et l'autre non ne se
   * répondent pas : chacun est jugé sur son propre champ.
   *
   * ET ON REND COMPTE. Sans sélection, un clic ne ferait rien du tout et rien ne
   * dirait pourquoi — c'est le défaut le plus facile à commettre ici, parce que
   * la palette a l'air de fonctionner. */
  function appliqueSurSelection(etiquette) {
    var tokens = selectionRoll20();
    if (!tokens.length) {
      dit(ditLe("pal.choisisJetons", "Sélectionnez d'abord un ou plusieurs jetons sur la carte."), true);
      return;
    }
    var n = nombreDe(etiquette);
    var bilan = appliqueA(tokens, [{ tag: etiquette, nombre: n }]);
    var poses = bilan.poses, refuses = bilan.refuses, inchanges = bilan.inchanges;
    /* LE NOMBRE FRAPPÉ SERT UNE FOIS, comme le geste qu'il accompagne : le
     * garder ferait porter le même compteur au marqueur suivant sans qu'on l'ait
     * demandé. La pastille s'efface donc avec la pose. */
    var r = rangDansChoix(etiquette);
    if (r >= 0) { choix.splice(r, 1); }
    peintBarre();

    /* ON DIT LEQUEL DES DEUX GESTES A EU LIEU. « 2 tokens marqués » et
     * « 2 tokens démarqués » ne se devinent pas l'un de l'autre, et c'est
     * justement la décision collective qui vient d'être prise pour vous. */
    var verbe = bilan.retire ? "démarqué" : "marqué";
    var mot = poses ? (poses + " token" + (poses > 1 ? "s" : "") + " " + verbe + (poses > 1 ? "s" : ""))
            : inchanges ? "Rien à changer sur cette sélection"
            : "";
    if (refuses) {
      mot += (mot ? " — " : "") + refuses + " refusé" + (refuses > 1 ? "s" : "") +
             " : pas à vous";
    }
    dit(mot, !poses);
  }

  /* ---------- NOTRE BOUTON DANS SA COLONNE D'OUTILS ----------
   *
   * ON N'AJOUTE PAS UN CADRE, ON ENTRE DANS LE SIEN. C'est déjà ce que fait la
   * commande de zoom, et pour la même raison : une pièce rapportée se voit, un
   * bouton cloné non.
   *
   * Sa colonne, relevée sur une vraie partie :
   *
   *   #master-toolbar > .upper-buttons
   *     .toolbar-button-outer            (un par outil)
   *       button.toolbar-button-inner    42 × 34
   *         .icon-slot                   « icon-selected » quand l'outil est actif
   *           span.grimoire__roll20-icon dont le TEXTE est le nom du glyphe
   *
   * Sa colonne est découpée en SECTIONS, chacune ouverte par un intitulé :
   *
   *   div.spacer-outer[role=separator]
   *     div.spacer-inner            le filet
   *     div.spacer-header           le mot — « Outils », « Effets »
   *
   * On en clone un pour ouvrir la nôtre, « VTTK », sous les siennes. Là encore
   * on ne dessine rien : le filet, la casse, l'espacement et le thème viennent
   * de lui.
   *
   * On clone un de ses boutons — donc ses classes, ses attributs de portée Vue
   * et son thème — et on remplace seulement le NOM DU GLYPHE. Lesquels existent
   * ne se devine pas : un nom inconnu s'affiche en toutes lettres. On a donc
   * mesuré, en clonant un vrai span d'icône et en comparant sa largeur à celle
   * d'un glyphe connu. Ce que sa police contient, dans le registre qui nous
   * intéresse : star, starFilled, heart, heartFilled, wandSparkle, user,
   * userCircle, plus, settings, message, checkCircle, infoCircle, helpCircle.
   * Et ce qu'elle NE contient PAS : emoji, emote, sticker, badge, tag, status,
   * condition, marker, token — tous rendus en toutes lettres.
   *
   * ON A ESSAYÉ DE FUSIONNER PLUS PROFONDÉMENT, et c'est mesuré : injecter nos
   * marqueurs dans `Campaign.attributes.token_markers` ne les fait PAS dessiner par
   * Roll20, même en injectant avant que la scène soit montée et avec son
   * catalogue déjà peuplé. Ses pictogrammes sont échantillonnés dans un atlas de
   * 4096 × 4096 qui arrive déjà cuit. Son propre choix de marqueurs n'est pas
   * davantage dans le DOM — 5656 nœuds balayés, aucun ne référence une de ses
   * images. Le rendu reste donc à nous ; l'INTERFACE, elle, peut être la sienne.
   */

  var section = null;        // notre intitulé « VTTK »
  var colonne = null;        // sa colonne d'outils, une fois trouvée

  /* ---------- QUEL MOTEUR DESSINE LA CARTE ? ----------
   *
   * Roll20 a DEUX moteurs, et le même client neuf sert les deux. Sur une
   * campagne d'héritage on trouve quand même « #babylonCanvas », Pinia, et
   * « currentPlayer.d20 » : aucun de ces trois-là ne distingue quoi que ce soit.
   * Relevé sur les deux, côte à côte :
   *
   *                       Jumpgate    héritage
   *     #babylonCanvas       oui        OUI
   *     currentPlayer.d20    oui        OUI
   *     Pinia                oui        OUI
   *     window.MeshScene     oui        non      ← le seul qui tranche
   *     d20.engine.canvas    non        oui
   *
   * « MeshScene » n'existe QUE là où Babylon dessine. C'est donc lui, et rien
   * d'autre, qui dit le moteur — et l'on rend « inconnu » plutôt que de parier
   * quand aucun des deux ne répond : un troisième arrivera. */
  function moteurDeRoll20() {
    try { if (window.MeshScene) { return "jumpgate"; } } catch (e) {}
    try {
      var d = (window.currentPlayer && window.currentPlayer.d20) || window.d20;
      if (d && d.engine && d.engine.canvas) { return "heritage"; }
    } catch (e) {}
    return "inconnu";
  }

  function laColonne() {
    if (colonne && colonne.isConnected !== false) { return colonne; }
    colonne = document.querySelector(".upper-buttons");
    return colonne;
  }

  /* L'intitulé « VTTK », cloné d'une de ses sections. Il faut en prendre une qui
   * PORTE un mot : sa colonne contient aussi des séparateurs nus, et cloner
   * celui-là donnerait un filet sans titre. */
  function faisSection() {
    if (section && section.parentNode) { return true; }
    var col = laColonne();
    if (!col) { return false; }
    var modele = null;
    var seps = col.querySelectorAll(".spacer-outer");
    for (var s = 0; s < seps.length && !modele; s++) {
      if (seps[s].querySelector(".spacer-header")) { modele = seps[s]; }
    }
    /* ---------- QUAND IL N'A AUCUNE SECTION TITRÉE ----------
     *
     * On clonait une de ses sections À INTITULÉ, et faute d'en trouver une on
     * rendait « false » — donc pas de section, donc AUCUN bouton VTTK. C'est
     * exactement ce qui se passe sur une campagne d'héritage : sa colonne porte
     * bien des « .spacer-outer », mais tous nus, sans le moindre
     * « .spacer-header ». Relevé : deux séparateurs, zéro intitulé.
     *
     * Renoncer était le pire choix : l'extension disparaissait entière — panneau
     * compris — alors que seul son ÉTIQUETTE manquait. On clone donc un
     * séparateur ordinaire et on lui greffe notre propre intitulé, bâti sur le
     * même squelette que les siens.
     *
     * Et s'il n'a même pas de séparateur, on en fabrique un de toutes pièces :
     * un titre sans modèle est moins beau qu'un titre cloné, et infiniment
     * mieux qu'une extension invisible. */
    var nu = false;
    if (!modele) {
      modele = seps[0] || null;
      nu = true;
    }
    var n;
    if (modele) {
      n = modele.cloneNode(true);
      n.removeAttribute("id");
    } else {
      n = document.createElement("div");
      n.className = "spacer-outer";
      var dedans = document.createElement("div");
      dedans.className = "spacer-inner";
      n.appendChild(dedans);
      nu = true;
    }
    n.classList.add("vttk-outil-titre");
    var mot = n.querySelector(".spacer-header");
    if (!mot && nu) {
      /* On lui donne la classe qu'il emploie ailleurs : le jour où sa feuille
       * la définit à nouveau, notre intitulé s'habille tout seul. */
      mot = document.createElement("div");
      mot.className = "spacer-header vttk-outil-titre-mot";
      n.appendChild(mot);
    }
    if (mot) { mot.textContent = "VTTK"; }
    poseDansLaColonne(col, n, RANG_TITRE);
    section = n;
    return true;
  }

  /* SOUS LES SIENNES, mais AVANT son bouton de débordement : celui-ci ferme la
   * colonne et reste masqué tant qu'elle tient en hauteur. Se poser après lui
   * marcherait aujourd'hui et se verrait le jour où il apparaît.
   *
   * ET DANS UN ORDRE FIXE. Chaque pièce à nous porte un RANG, et s'insère avant
   * la première des nôtres qui a un rang supérieur. Sans ça, l'ordre était celui
   * de la CRÉATION : le bouton des réglages se pose depuis un guet au chargement
   * du pont, celui des marqueurs quand le module s'installe, et lequel arrive
   * d'abord dépend du moment où sa colonne est peinte. On voyait donc l'étoile
   * au-dessus du rouage une fois sur deux. */
  function poseDansLaColonne(col, n, rang) {
    n.setAttribute("data-vttk-rang", String(rang));
    var miens = col.querySelectorAll("[data-vttk-rang]");
    var avant = null;
    for (var i = 0; i < miens.length && !avant; i++) {
      if (+miens[i].getAttribute("data-vttk-rang") > rang) { avant = miens[i]; }
    }
    if (!avant) {
      var dernier = col.lastElementChild;
      if (dernier && dernier.getBoundingClientRect &&
          dernier.getBoundingClientRect().height <= 4) { avant = dernier; }
    }
    if (avant) { col.insertBefore(n, avant); } else { col.appendChild(n); }
  }

  /* Les rangs de la section VTTK. L'intitulé ouvre, le rouage vient ensuite, et
   * les modules après lui : on cherche ses réglages avant de chercher un
   * module, et un bouton de réglages qu'il faut aller pêcher sous les autres
   * n'est pas à sa place. */
  var RANG_TITRE = 0, RANG_REGLAGES = 1, RANG_MARQUEURS = 2;

  /* Un bouton d'outil, cloné des siens. `glyphe` est un nom de sa police —
   * mesuré, pas deviné. */
  /* UN SOURIRE, PARCE QUE SA POLICE N'EN A PAS.
   *
   * Le bouton des marqueurs portait « starFilled » faute de mieux — une étoile pour
   * des émotes, c'est approchant sans être juste. Mais sa police d'icônes n'a
   * NI « smiley », NI « smile », NI « faceSmile », NI « emoji », NI « emote »,
   * NI « sticker » : tous rendus en toutes lettres, mesuré. Il n'y a donc rien à
   * lui emprunter, et on dessine.
   *
   * En trait, à `currentColor`, dans la même boîte que ses glyphes : le bouton
   * reste le sien, seul le dessin est de nous, et il suit son thème sans qu'on
   * ait à le savoir. */
  var SVG_NS = "http://www.w3.org/2000/svg";

  function faisSourire(doc) {
    function e(nom, attrs) {
      var n = doc.createElementNS(SVG_NS, nom);
      for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) { n.setAttribute(k, attrs[k]); } }
      return n;
    }
    /* PLEIN, ET NON EN TRAIT. Ses icônes — le rouage, l'étoile, la baguette —
     * sont des aplats ; un sourire au trait pesait visiblement moins qu'elles,
     * et ça se voyait dans la colonne. Le disque est plein et les yeux comme la
     * bouche sont EVIDÉS par la règle de remplissage « evenodd » : un
     * sous-chemin à l'intérieur d'un autre y creuse un trou, quel que soit son
     * sens de parcours. Rien n'est peint dans la couleur du fond — qui change
     * avec le thème et qu'on ne connaît donc pas. */
    var svg = e("svg", { viewBox: "0 0 24 24", width: "18", height: "18",
      fill: "currentColor", "fill-rule": "evenodd",
      "aria-hidden": "true", focusable: "false" });
    svg.appendChild(e("path", {
      d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" +
         "M9.1 9.1a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Z" +
         "M14.9 9.1a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Z" +
         "M7.6 13.2a4.9 4.9 0 0 0 8.8 0 3.6 3.6 0 0 1-8.8 0Z"
    }));
    return svg;
  }

  function faisBoutonOutil(glyphe, libelle, marque, rang, surClic) {
    var col = laColonne();
    if (!col) { return null; }
    var modeles = col.querySelectorAll(".toolbar-button-outer");
    if (!modeles.length) { return null; }
    /* ON CLONE UN BOUTON QUI SE VOIT, et c'est une correction : le premier jet
     * prenait le DERNIER, qui est justement celui du débordement — masqué. Le
     * clone héritait de sa taille nulle, et notre bouton n'existait à l'écran
     * que dans les relevés. On cherche donc, en partant de la fin, le premier
     * qui ait une hauteur — et on saute les nôtres, sans quoi on finirait par
     * cloner un clone. */
    var modele = null;
    for (var m = modeles.length - 1; m >= 0 && !modele; m--) {
      if (modeles[m].classList.contains("vttk-outil")) { continue; }
      var r = modeles[m].getBoundingClientRect();
      if (r.height > 4 && r.width > 4) { modele = modeles[m]; }
    }
    if (!modele) { return null; }
    var n = modele.cloneNode(true);
    /* Un modèle visible peut porter un chevron de sous-menu ou l'état
     * « sélectionné » de l'outil actif : ni l'un ni l'autre ne nous concerne. */
    var caret = n.querySelector(".submenu-caret");
    if (caret && caret.parentNode) { caret.parentNode.removeChild(caret); }
    var choisi = n.querySelector(".icon-selected");
    if (choisi) { choisi.classList.remove("icon-selected"); }
    n.removeAttribute("id");
    n.classList.add("vttk-outil");
    /* CHAQUE BOUTON PORTE SA PROPRE MARQUE. Ils sont deux dans la section, et
     * s'en remettre à « le premier .vttk-outil » donne l'un ou l'autre selon
     * l'ordre de création — c'est le genre d'ambiguïté qui se paie plus tard. */
    n.classList.add(marque);
    /* SEUL LE NOM DU GLYPHE CHANGE. Le span garde ses classes et ses attributs
     * de portée Vue — c'est d'eux que vient la police d'icônes, et un span
     * fabriqué à la main sortirait le nom en toutes lettres. Mesuré. */
    var ico = n.querySelector(".grimoire__roll20-icon");
    if (!ico) { return null; }
    if (glyphe === "@sourire") {
      /* Le span reste — c'est de lui que viennent la taille et la couleur —,
       * mais il porte notre dessin au lieu d'un nom de glyphe. */
      ico.textContent = "";
      ico.appendChild(faisSourire(document));
    } else {
      ico.textContent = glyphe;
    }
    /* ---------- QUI REÇOIT LE CLIC ----------
     *
     * On cherchait un « button » dans le nœud cloné, et on ne posait l'écouteur
     * QUE si on en trouvait un. Or SA BARRE N'EN CONTIENT PAS : relevé sur une
     * vraie partie, ses trois premiers outils rendent
     * `querySelectorAll("button").length === 0`, et leur premier enfant est un
     * DIV. Nos deux boutons — réglages et marqueurs — étaient donc INERTES :
     * posés, dessinés, intitulés, et sans le moindre écouteur.
     *
     * LE DÉFAUT NE SE VOYAIT DANS AUCUN CONTRÔLE. Le faux monde du banc monte
     * une colonne qui, elle, porte un « button » — plus riche que la vraie —,
     * et toutes les sondes pilotent les modules par message plutôt que par le
     * doigt. Il a fallu cliquer pour s'en apercevoir.
     *
     * ON PREND DONC LE BOUTON S'IL EXISTE, ET LE NŒUD SINON. Le nœud est de
     * toute façon ce que l'utilisateur vise : c'est lui qui a la taille, le
     * fond et le survol d'un outil de la colonne.
     *
     * ET IL DEVIENT ATTEIGNABLE AU CLAVIER, ce qu'un div n'est jamais. Sans
     * « role » ni « tabindex », un outil dessiné dans une barre n'existe pas
     * pour qui ne se sert pas d'une souris. */
    var b = n.querySelector("button") || n;
    b.setAttribute("aria-label", libelle);
    b.setAttribute("aria-expanded", "false");
    b.title = libelle;
    if (b === n) {
      b.setAttribute("role", "button");
      b.setAttribute("tabindex", "0");
    }
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      surClic();
    });
    /* Entrée et Espace, comme un vrai bouton. Espace fait défiler la page si on
     * ne le retient pas, et un défilement sous un plateau de jeu se voit. */
    b.addEventListener("keydown", function (ev) {
      var k = ev.key;
      if (k !== "Enter" && k !== " " && k !== "Spacebar") { return; }
      ev.preventDefault();
      ev.stopPropagation();
      surClic();
    });
    poseDansLaColonne(col, n, rang);
    return n;
  }

  /* ---------- LES COULEURS SE LISENT, ELLES NE SE CHOISISSENT PAS ----------
   *
   * Nos boîtes avaient un décor écrit en dur — fond #171717, bord #816e54 —
   * qui allait en thème sombre et détonnait en clair. Or on ne peut pas non plus
   * DEVINER le thème : son bascule `colorTheme` fait bien passer son magasin de
   * « light » à « dark », mais AUCUNE de ses variables CSS ne change et sa barre
   * reste blanche. Mesuré. Ces variables-là appartiennent à la fiche de
   * personnage, pas à l'interface du plateau.
   *
   * La seule vérité est donc ce que son interface REND. On lit la couleur de sa
   * barre d'outils et celle de son texte, et on les repose sur nos boîtes. C'est
   * exactement ce que fait déjà la commande de zoom pour son glisseur, et pour
   * la même raison : on veut une pièce qu'on ne distingue pas des siennes, y
   * compris dans un thème qu'on ne connaît pas. */
  /* LE THÈME CHOISI DANS LA FENÊTRE DE L'EXTENSION, s'il y en a un.
   *
   * « auto » veut dire : on lit Roll20, comme avant. « jour » et « nuit » sont
   * des CHOIX, et un choix ne se fait pas discuter par une détection.
   *
   * Sans ça, la palette de marqueurs restait claire pendant que le panneau de
   * réglages passait en sombre — deux panneaux censés être identiques, l'un
   * blanc et l'autre noir, côte à côte. */
  var themeChoisi = "auto";

  /* Les deux palettes, et ce sont les ANCRES DE ROLL20 : son fond sombre vaut
   * rgb(23, 23, 23) et son texte rgb(230, 230, 230), relevés sur son thème.
   * Le clair est celui de sa barre. */
  var PALETTES = {
    jour: { fond: "rgb(255, 255, 255)", texte: "rgb(51, 51, 51)", filet: "rgba(0, 0, 0, .2)", clair: true },
    nuit: { fond: "rgb(23, 23, 23)", texte: "rgb(230, 230, 230)", filet: "rgba(255, 255, 255, .18)", clair: false }
  };

  function couleursDeRoll20() {
    if (PALETTES[themeChoisi]) {
      var forcee = PALETTES[themeChoisi];
      return { fond: forcee.fond, texte: forcee.texte, filet: forcee.filet, clair: forcee.clair };
    }
    var out = { fond: "#ffffff", texte: "#333333", filet: "rgba(0,0,0,.2)", clair: true };
    var barreOutils = document.querySelector("#master-toolbar") || laColonne();
    if (barreOutils) {
      var s = getComputedStyle(barreOutils);
      var f = s.backgroundColor, t = s.color;
      if (f && f !== "rgba(0, 0, 0, 0)" && f !== "transparent") { out.fond = f; }
      if (t) { out.texte = t; }
    }
    var filet = document.querySelector(".spacer-inner");
    if (filet) {
      var bf = getComputedStyle(filet).backgroundColor;
      if (bf && bf !== "rgba(0, 0, 0, 0)") { out.filet = bf; }
    }
    /* CLAIR OU SOMBRE SE DÉDUIT DE LA LUMINANCE DU FOND, pas d'un réglage. On
     * n'a pas trouvé d'indicateur fiable chez lui ; la couleur rendue, elle, ne
     * ment pas. Coefficients de la luminance perçue, arrondis. */
    var m = String(out.fond).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) {
      var l = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      out.clair = l > 0.5;
    }
    return out;
  }

  /* On repose les couleurs SUR NOS BOÎTES, jamais sur :root — des noms aussi
   * banals entreraient dans la cascade de Roll20 et repeindraient ses propres
   * composants. C'est la règle de ui/overlay.css, et elle vaut ici aussi. */
  function habille(n) {
    if (!n || !n.style) { return null; }
    var c = couleursDeRoll20();
    n.style.setProperty("--vttk-fond", c.fond);
    n.style.setProperty("--vttk-texte", c.texte);
    n.style.setProperty("--vttk-filet", c.filet);
    return c;
  }

  /* ---------- LES RÉGLAGES, DANS SA BARRE ----------
   *
   * Le panneau de l'extension s'ouvrait en cliquant l'icône du navigateur. Il
   * s'ouvre maintenant d'ici, dans la section VTTK, à côté du reste.
   *
   * ON NE LE REDESSINE PAS : c'est la MÊME page — popup/popup.html — chargée
   * dans un cadre. Une seule interface, donc jamais deux idées divergentes de ce
   * qu'elle propose, et rien à tenir en double. Elle est déclarée accessible
   * depuis la page dans le manifeste, pour le seul éditeur de Roll20.
   *
   * Le thème lui est passé par le fragment de l'adresse : c'est le seul moyen de
   * parler à un cadre d'une autre origine sans écouter de messages, et il est
   * lisible à la construction, avant même que la page se dessine. */
  var reglages = null, reglagesOuvert = false, outilReglages = null;

  /* ---------- COLLÉ À LA BOÎTE À OUTILS, MÊME HAUTEUR ----------
   *
   * La même géométrie que le plateau de narration de l'extension JJK, et pour
   * les mêmes raisons — c'est là qu'elle a été mise au point :
   *
   *   x = barre.right   collé, zéro pixel entre les deux, et pas un seul
   *                     DESSOUS non plus : glisser sous la barre ferait passer
   *                     ses outils derrière notre panneau.
   *   y = barre.top     le même haut, pour que les deux forment un bloc.
   *   h = barre.height  LA MÊME HAUTEUR, exactement. Sans ça le panneau
   *                     descendait bien plus bas qu'elle et, posés côte à côte,
   *                     les deux ne formaient plus rien du tout.
   *
   * Le premier jet alignait le panneau sur le BOUTON, qui est en bas de la
   * colonne : le panneau partait donc du bas de la page. C'est exactement ce que
   * cette géométrie-là évite.
   *
   * Faute de barre, on retombe sur une place raisonnable plutôt que de ne rien
   * afficher. */
  function rectBarre() {
    var b = document.querySelector("#master-toolbar") || laColonne();
    if (!b || !b.getBoundingClientRect) { return null; }
    var r = null;
    try { r = b.getBoundingClientRect(); } catch (e) { return null; }
    if (!r || r.width < 8 || r.height < 8) { return null; }
    return r;
  }

  /* `fixe` dit si la boîte PREND toute la hauteur de la barre ou si elle s'y
   * BORNE seulement. Le panneau des réglages la prend — c'est un cadre, il n'a
   * pas de hauteur propre. La palette s'y borne : avec deux marqueurs elle serait
   * ridiculement vide sur mille pixels, avec cinquante elle a de quoi défiler. */
  /* LES DEUX ÉCARTS SONT LES SIENS, PAS LES NÔTRES.
   *
   * Nos panneaux étaient COLLÉS au bord droit de sa colonne, puis — une fois cela
   * corrigé — collés au plafond. Les siens ne le sont ni l'un ni l'autre :
   * `.block-submenu`, le panneau que Roll20 fait sortir de cette même colonne,
   * est posé à `left: 60px` ET `top: 24px`, pour une colonne large de 44 dont le
   * haut est à 0. Mesuré sur une vraie partie, sur le même témoin.
   *
   * Seize pixels de jour à gauche, vingt-quatre en haut. On ne choisit donc pas
   * ces valeurs, on les recopie : une fenêtre qui touche ce que les siennes
   * n'atteignent pas se voit tout de suite, et les deux fois ça a été signalé.
   *
   * LE JOUR DU BAS EST LE MÊME QUE CELUI DU HAUT. Roll20 ne donne pas la réponse
   * — ses panneaux sont taillés sur leur contenu et ne descendent pas jusqu'en
   * bas —, mais une fenêtre écartée en haut et collée en bas serait bancale, et
   * c'est le seul cas où la nôtre s'en approche : quand la liste est assez longue
   * pour buter contre sa hauteur maximale. */
  var ECART_BARRE = 16;
  var ECART_HAUT  = 24;

  function poseContreLaBarre(n, fixe) {
    if (!n || !n.style) { return; }
    var r = rectBarre();
    if (!r) {
      n.style.left = "50px";
      n.style.top = "60px";
      n.style.height = "";
      n.style.maxHeight = "";
      return;
    }
    n.style.left = Math.round(r.right + ECART_BARRE) + "px";
    n.style.top = Math.max(0, Math.round(r.top + ECART_HAUT)) + "px";
    /* La hauteur perd les DEUX jours : celui qu'on vient d'ajouter en haut, et
     * son pendant en bas. Sans quoi le panneau descendrait de vingt-quatre
     * pixels sous le bord inférieur de la colonne. */
    var dispo = Math.max(0, Math.round(r.height - 2 * ECART_HAUT));
    /* LA HAUTEUR N'EST PLUS IMPOSÉE, ELLE EST PLAFONNÉE.
     *
     * On la fixait à toute la colonne : le panneau faisait 1018 pixels pour 570
     * de contenu, avec quatre cent cinquante pixels de blanc sous la dernière
     * ligne. Ceux de Roll20 épousent leur contenu.
     *
     * Le contenu est dans une iframe, dont la hauteur intérieure n'est pas
     * lisible du dehors : c'est LUI qui la dit, par un message (voir
     * « hauteur » plus bas). En attendant qu'il parle — quelques dizaines de
     * millisecondes —, le plafond tient lieu de hauteur, et il reste ensuite
     * pour empêcher un contenu long de sortir de l'écran. */
    n.style.maxHeight = dispo + "px";
    if (!fixe) { n.style.height = ""; }
  }

  /* La hauteur que le panneau s'est mesurée, gardée pour les réouvertures : sans
   * elle, il repartirait à sa taille plafond à chaque fois et rétrécirait sous
   * les yeux. */
  var hauteurPanneau = 0;

  /* CHANGER DE LANGUE NE DÉMONTE RIEN. On repose les intitulés là où ils sont,
   * plutôt que de refaire les nœuds : une palette reconstruite perdrait sa
   * sélection en cours, son mode et son défilement — pour un mot. */
  function rhabille() {
    try {
      if (outilReglages) {
        var br = outilReglages.querySelector("button") || outilReglages;
        br.setAttribute("title", ditLe("zoom.reglages", "Réglages de VTTinker"));
      }
      if (outil) {
        var bm = outil.querySelector("button") || outil;
        bm.setAttribute("title", ditLe("mod.marqueurs", "Marqueurs personnalisés"));
      }
      if (reglages) {
        var cad = reglages.querySelector("iframe");
        if (cad) { cad.setAttribute("title", ditLe("zoom.reglages", "Réglages de VTTinker")); }
      }
      /* LA PALETTE SE REFAIT, elle ne se repeint pas. Ses intitulés sont
       * répartis dans une trentaine de nœuds fabriqués — titre, rouage, deux
       * modes et leurs aides, deux champs, une croix par marqueur : les
       * reposer un à un serait une liste à tenir à jour, et c'est exactement le
       * genre de liste où l'on oublie une entrée. faisBarre la reconstruit
       * entière, et elle sait déjà le faire — c'est ce qu'elle fait à chaque
       * changement de mode. */
      if (barre) { faisBarre(); }
    } catch (e) {}
  }

  function poseHauteurPanneau(h) {
    hauteurPanneau = h;
    if (!reglages || !h) { return; }
    var r = rectBarre();
    var dispo = r ? Math.max(0, Math.round(r.height - 2 * ECART_HAUT)) : h;
    reglages.style.height = Math.min(h, dispo) + "px";
  }

  function adresseDuPanneau(clair) {
    /* La base de l'extension se prend sur NOTRE propre adresse : le pont a été
     * injecté depuis moz-extension://<identifiant>/page/pont.js, et cet
     * identifiant change à chaque installation. Personne d'autre ne le connaît
     * ici — la page n'a pas accès à browser.runtime. */
    var base = String(monAdresse || "").replace(/page\/pont\.js.*$/, "");
    if (!base) { return null; }
    /* LE PANNEAU A SA PROPRE PAGE, et c'est la séparation demandée. Les deux
     * surfaces étaient le MÊME fichier — popup/popup.html, chargé une fois dans
     * la fenêtre du navigateur et une fois ici, dans un cadre : deux endroits
     * pour un seul geste. La fenêtre dit désormais si l'extension existe et
     * dans quelle langue elle parle ; ce cadre dit ce qu'elle fait. */
    return base + "panneau/panneau.html#" + (clair ? "clair" : "sombre");
  }

  function faisReglages() {
    if (reglages && reglages.parentNode) { return true; }
    var c = couleursDeRoll20();
    var url = adresseDuPanneau(c.clair);
    if (!url) { return false; }
    reglages = document.createElement("div");
    reglages.className = "vttk-reglages";
    habille(reglages);
    var cadre = document.createElement("iframe");
    cadre.className = "vttk-reglages-cadre";
    cadre.setAttribute("title", ditLe("zoom.reglages", "Réglages de VTTinker"));
    cadre.src = url;
    reglages.appendChild(cadre);
    document.body.appendChild(reglages);
    return true;
  }

  function ouvreReglages() {
    if (!faisReglages()) { return; }
    /* Le thème a pu changer depuis la dernière ouverture : on relit, et on ne
     * recharge le cadre que si le mode a VRAIMENT tourné. */
    var c = habille(reglages);
    var voulue = adresseDuPanneau(c.clair);
    var cadre = reglages.querySelector("iframe");
    if (cadre && voulue && cadre.src !== voulue) { cadre.src = voulue; }
    reglagesOuvert = true;
    reglages.classList.add("ouvert");
    poseContreLaBarre(reglages, true);
    if (outilReglages) {
      var b = outilReglages.querySelector("button");
      if (b) { b.setAttribute("aria-expanded", "true"); }
      var f = outilReglages.querySelector(".icon-slot");
      if (f) { f.classList.add("icon-selected"); }
    }
    window.addEventListener("pointerdown", surClicHorsReglages, true);
    window.addEventListener("keydown", surToucheReglages, true);
  }

  function fermeReglages() {
    reglagesOuvert = false;
    if (reglages) { reglages.classList.remove("ouvert"); }
    if (outilReglages) {
      var b = outilReglages.querySelector("button");
      if (b) { b.setAttribute("aria-expanded", "false"); }
      var f = outilReglages.querySelector(".icon-slot");
      if (f) { f.classList.remove("icon-selected"); }
    }
    window.removeEventListener("pointerdown", surClicHorsReglages, true);
    window.removeEventListener("keydown", surToucheReglages, true);
  }

  function surClicHorsReglages(ev) {
    if (reglages && estDedans(ev.target, reglages)) { return; }
    if (outilReglages && estDedans(ev.target, outilReglages)) { return; }
    fermeReglages();
  }

  function surToucheReglages(ev) {
    if (ev.key === "Escape" || ev.keyCode === 27) { fermeReglages(); }
  }

  /* Le bouton des réglages ne dépend d'AUCUN module : il est là dès que la
   * colonne existe, palette vide ou non. C'est par lui qu'on remplit la
   * palette, il serait absurde qu'il attende qu'elle le soit. */
  function faisOutilReglages() {
    if (outilReglages && outilReglages.parentNode) { return true; }
    if (!faisSection()) { return false; }
    outilReglages = faisBoutonOutil("settings", ditLe("zoom.reglages", "Réglages de VTTinker"), "vttk-outil-reglages",
      RANG_REGLAGES, function () {
        if (reglagesOuvert) { fermeReglages(); } else { ouvreReglages(); }
      });
    return !!outilReglages;
  }

  function faisOutil() {
    if (outil && outil.parentNode && outil.parentNode.isConnected !== false) { return true; }
    if (!faisSection()) { return false; }
    /* Un sourire, dessiné : sa police n'a ni « smiley », ni « emoji », ni
     * « sticker » — tous rendus en toutes lettres, mesuré. */
    outil = faisBoutonOutil("@sourire", ditLe("mod.marqueurs", "Marqueurs personnalisés"), "vttk-outil-marqueurs",
      RANG_MARQUEURS, function () {
        if (paletteOuverte) { fermePalette(); } else { ouvrePalette(); }
      });
    outilTitre = section;
    return !!outil;
  }

  function ouvrePalette() {
    if (!barre) { return; }
    /* Le thème a pu tourner depuis la dernière ouverture : deux lectures de
     * style, une fois par ouverture, ne se mesurent pas. */
    habille(barre);
    paletteOuverte = true;
    barre.classList.add("ouvert");
    /* La palette s'aligne sur NOTRE bouton, pas sur un coin de l'écran : sa
     * colonne peut défiler, et un panneau qui reste en bas quand son bouton est
     * en haut n'a plus l'air d'en venir. */
    /* COLLÉE À LA BARRE, comme le panneau des réglages, et pour la même raison :
     * elle porte désormais les quarante-sept marqueurs de Roll20 en plus des
     * vôtres, et alignée sur son bouton — qui est en bas de la colonne — elle
     * s'ouvrait dans le bas de la page. Elle se BORNE à la hauteur de la barre
     * au lieu de la prendre : avec deux marqueurs elle serait vide sur mille
     * pixels, avec cinquante elle a de quoi défiler. */
    poseContreLaBarre(barre, false);
    if (outil) {
      var b = outil.querySelector("button");
      if (b) { b.setAttribute("aria-expanded", "true"); }
      var f = outil.querySelector(".icon-slot");
      if (f) { f.classList.add("icon-selected"); }
    }
    /* ELLE NE SE REFERME PLUS TOUTE SEULE, et c'est demandé.
     *
     * Un clic ailleurs la fermait — ce qui est l'usage d'un menu, mais elle n'en
     * est pas un : on y revient sans cesse pendant qu'on travaille sur la carte,
     * et chaque aller-retour coûtait un clic de rouverture. Elle se ferme
     * maintenant de deux façons, et de deux seulement : le bouton de la boîte à
     * outils, et sa propre croix.
     *
     * Il n'y a donc plus d'écouteur de clic ici. C'en est un de moins en capture
     * sur toute la page pendant tout le temps où la palette est ouverte — un
     * gain, pas un renoncement. */
    lieTouche();
  }

  function fermePalette() {
    paletteOuverte = false;
    if (barre) { barre.classList.remove("ouvert"); }
    if (outil) {
      var b = outil.querySelector("button");
      if (b) { b.setAttribute("aria-expanded", "false"); }
      var f = outil.querySelector(".icon-slot");
      if (f) { f.classList.remove("icon-selected"); }
    }
    videChoix();
    survol = null;
    delieTouche();
  }

  function estDedans(n, hote) {
    while (n) { if (n === hote) { return true; } n = n.parentNode; }
    return false;
  }

  /* ============================================================
   *          LA PALETTE : POSER, AJOUTER, RETIRER
   * ============================================================
   *
   * ELLE PORTE DEUX FAMILLES, et la distinction compte :
   *
   *   · LES MARQUEURS DE ROLL20 — ses 47 pictogrammes, lus dans
   *     `Campaign.attributes.token_markers`. Les poser d'ici est plus rapide que
   *     par son propre menu, et surtout ils restent LES SIENS : c'est lui qui
   *     les dessine, donc TOUT LE MONDE les voit, extension ou pas.
   *   · LES VÔTRES — les images que vous avez collées. Roll20 ignore leur
   *     étiquette ; seuls ceux qui ont l'extension les voient.
   *
   * ET C'EST ICI QU'ON LES GÈRE. L'ajout et la suppression étaient dans le
   * panneau des réglages ; ils sont ici, avec le reste, parce que c'est ici
   * qu'on s'en sert. Le panneau, lui, n'en garde que l'interrupteur.
   *
   * LA VALIDATION ET L'ÉCRITURE NE SONT PAS ICI. Le pont vit dans la page : il
   * n'a ni `browser.storage`, ni le modèle de commun/marqueurs.js. Il envoie donc le
   * texte collé TEL QUEL au script de contenu, qui l'analyse avec le modèle
   * partagé, écrit le stockage, et renvoie son compte rendu. Une seule
   * définition de ce qu'est un marqueur valide, d'un bout à l'autre. */

  var champNom = null, champUrl = null, bilanCollage = null;
  var saisieEnCours = null;   // ce qui était tapé quand la palette s'est refaite

  /* ---------- LE SURVOL, PAR DÉLÉGATION ----------
   *
   * UN SEUL ÉCOUTEUR POUR SOIXANTE TUILES. Poser un « mouseenter » sur chacune
   * coûterait soixante enregistrements à chaque reconstruction de la palette,
   * et il y en a une à chaque ajout. « mouseover » remonte, lui : on le prend
   * une fois sur la barre et on cherche la tuile en remontant les parents.
   *
   * C'est aussi ce qui rend le survol testable : le banc n'a qu'un événement à
   * envoyer, sur un nœud qui existe toujours. */
  function surSurvol(ev) {
    var n = ev.target, tag = null;
    while (n && n !== barre) {
      var c = n.className ? String(n.className) : "";
      if (n.getAttribute && c.indexOf("vttk-barre-marqueur") >= 0) {
        tag = n.getAttribute("data-tag");
        break;
      }
      /* LA TUILE COMPTE AUSSI, ET PAS SEULEMENT SON BOUTON. En édition, la croix
       * de suppression s'ouvre au survol DANS le coin haut-droit de la tuile :
       * le pointeur passait dessus, la remontée ne trouvait plus de bouton, le
       * survol tombait à zéro — et le chiffre qu'on frappait juste après ne
       * numérotait rien. Un ornement posé sur une tuile ne doit pas la faire
       * disparaître ; on prend son étiquette sur le bouton qu'elle contient. */
      if (n.querySelector && c.indexOf("vttk-marqueur-tuile") >= 0) {
        var b = n.querySelector(".vttk-barre-marqueur");
        tag = b ? b.getAttribute("data-tag") : null;
        break;
      }
      n = n.parentNode;
    }
    if (tag === survol) { return; }
    survol = tag;
    /* Changer de tuile coupe l'enchaînement des chiffres : « 1 » sur l'une puis
     * « 2 » sur l'autre font deux marqueurs, l'un à 1 et l'autre à 2. */
    survolQuand = 0;
  }

  function faisBarre() {
    var greffe = faisOutil();
    if (!barre) {
      barre = document.createElement("div");
      barre.setAttribute("role", "dialog");
      barre.setAttribute("aria-label", ditLe("pal.titre", "Marqueurs"));
      barre.addEventListener("mouseover", surSurvol);
      barre.addEventListener("mouseleave", function () { survol = null; survolQuand = 0; });
      document.body.appendChild(barre);
    }
    habille(barre);
    /* GREFFÉE, la palette est un panneau qui sort du bouton et ne paraît que sur
     * demande. Faute de colonne où se greffer — une version de Roll20 qui
     * l'aurait changée —, elle tient debout toute seule, comme le fait déjà la
     * commande de zoom dans le même cas. Le repli doit exister, sinon le module
     * disparaît en silence le jour où ils renomment une classe. */
    barre.className = greffe ? "vttk-barre vttk-barre-tiroir" : "vttk-barre vttk-barre-flottante ouvert";
    /* LA GREFFE PEUT ARRIVER EN RETARD, et le repli laissait alors un tiroir
     * ouvert que personne n'avait ouvert.
     *
     * Le repli flottant se déclare ouvert, ce qui est juste : il n'a pas de
     * bouton pour l'ouvrir. Mais sa colonne d'outils se peint APRÈS la page,
     * parfois après notre premier passage — mesuré ailleurs dans ce fichier, où
     * l'ordre des deux boutons dépendait du même hasard. Au passage suivant la
     * palette devient un tiroir, et le drapeau resté vrai le rouvrait : panneau
     * affiché sans qu'`ouvrePalette` ait tourné, donc sans position calculée,
     * sans clic-dehors écouté et sans que le bouton se sache enfoncé. */
    if (!greffe) { paletteOuverte = true; etaitFlottante = true; }
    else if (etaitFlottante) { etaitFlottante = false; paletteOuverte = false; }
    /* LA PALETTE OUVERTE RESTE OUVERTE. Cette ligne réécrit `className` en entier
     * et perdait la classe « ouvert » — donc `display: none` — alors que
     * `paletteOuverte` restait vrai : la palette disparaissait sans que rien ne
     * la rouvre, et le bouton continuait d'annoncer qu'elle était ouverte.
     *
     * Le défaut se déclenchait à CHAQUE reconstruction, c'est-à-dire à chaque
     * ajout de marqueur — l'écriture du stockage repasse par le module, qui
     * renvoie le catalogue — et au passage en édition. Ajouter un marqueur
     * faisait donc s'évanouir la palette au moment précis où l'on regardait si
     * le marqueur était arrivé. */
    if (paletteOuverte) { barre.classList.add("ouvert"); }
    while (barre.firstChild) { barre.removeChild(barre.firstChild); }

    /* CE QU'ON ÉTAIT EN TRAIN DE SAISIR SURVIT À LA RECONSTRUCTION.
     *
     * La palette se refait à chaque changement de catalogue — donc à chaque
     * ajout, y compris depuis un AUTRE onglet Roll20, où l'écriture du stockage
     * se diffuse. On collait une adresse un peu longue, la palette se refaisait
     * pour une raison sans rapport, et le champ redevenait vide sans un mot. */
    if (champNom && champUrl) {
      saisieEnCours = { nom: String(champNom.value || ""), url: String(champUrl.value || "") };
    }
    barre.classList.toggle("edition", edition);
    barre.appendChild(faisTitre());

    barre.appendChild(faisChoixDeMode());

    var mot = document.createElement("p");
    mot.className = "vttk-barre-mot";
    mot.hidden = true;
    barre.appendChild(mot);

    var miens = marqueursMiens ? Object.keys(marqueursMiens) : [];
    barre.appendChild(faisEntete("Vos marqueurs",
      miens.length ? null
      : edition ? "Un nom, une adresse d'image, et « + »."
      : "Vide. Ouvrez le rouage pour en ajouter."));
    var grille = document.createElement("div");
    /* « mienne » N'EST PAS DÉCORATIF : c'est ce qui distingue la grille qu'on
     * peut trier de celle de Roll20, et le CSS n'a aucun autre moyen de les
     * séparer. Une première version employait `:first-of-type`, qui vise le
     * TYPE d'élément et non la classe : la barre de titre étant elle aussi un
     * div, la règle ne s'appliquait jamais — et le liseré du mode édition, qui
     * est le seul signal visible qu'on peut trier, ne paraissait pas. */
    grille.className = "vttk-marqueur-grille mienne";
    for (var i = 0; i < miens.length; i++) {
      grille.appendChild(faisTuile(miens[i], marqueursMiens[miens[i]], true));
    }
    /* LE DÉPÔT SE FAIT SUR LA GRILLE, pas seulement sur les tuiles : lâcher
     * entre deux tuiles, ou dans le vide à la fin de la dernière ligne, est un
     * geste courant et il ne doit pas se perdre. */
    if (edition && miens.length > 1) { armeDepot(grille, miens); }
    barre.appendChild(grille);

    /* L'AJOUT NE PARAÎT QU'EN ÉDITION. Il était toujours là, sous les tuiles, et
     * c'était son défaut : on ouvre cette palette cent fois pour poser un
     * marqueur et une fois pour en ajouter un. */
    if (edition) { barre.appendChild(faisFormulaire()); }
    /* Quitter l'édition jette la saisie en cours : la garder ferait ressurgir,
     * au retour, une adresse qu'on avait justement décidé d'abandonner. */
    else { bilanCollage = null; champNom = null; champUrl = null; saisieEnCours = null; }

    /* Les siens, en dessous : on les consulte souvent, on ne les gère jamais. */
    var siens = catalogueDeRoll20();
    var past = pastillesDeRoll20();
    if (siens.length || past.length) {
      barre.appendChild(faisEntete("Marqueurs de Roll20",
        "Posés par lui : tout le monde les voit."));
      var g2 = document.createElement("div");
      g2.className = "vttk-marqueur-grille";
      /* LES PASTILLES D'ABORD : ce sont les plus employées en jeu, et elles
       * manquaient — elles ne figurent dans aucun catalogue. */
      for (var p = 0; p < past.length; p++) {
        g2.appendChild(faisTuile(past[p].tag, past[p], false));
      }
      for (var k = 0; k < siens.length; k++) {
        g2.appendChild(faisTuile(siens[k].tag, siens[k], false));
      }
      barre.appendChild(g2);
    }
    peintBarre();
    /* Le mot survit à la reconstruction : la palette se refait pour des raisons
     * qui n'ont rien à voir avec ce qu'on était en train de dire. */
    peintMot();
  }

  /* ---------- LE TITRE, ET LE ROUAGE QUI OUVRE L'ÉDITION ----------
   *
   * DEUX ÉTATS, ET UN SEUL BOUTON POUR PASSER DE L'UN À L'AUTRE. Hors édition la
   * palette ne fait qu'une chose — choisir des marqueurs et les poser — et rien
   * n'y est cliquable par erreur : ni croix de suppression, ni champ de saisie,
   * ni tuile qui s'échappe sous la souris. En édition, les trois paraissent
   * ensemble, parce que ce sont trois façons de faire le même travail. */
  function faisTitre() {
    var t = document.createElement("div");
    t.className = "vttk-barre-titre";
    var m = document.createElement("span");
    m.className = "vttk-barre-nom";
    m.textContent = ditLe("pal.titre", "Marqueurs");
    t.appendChild(m);

    var r = document.createElement("button");
    r.type = "button";
    r.className = "vttk-barre-rouage" + (edition ? " actif" : "");
    r.title = edition ? ditLe("pal.editerFin", "Terminer l'édition")
                      : ditLe("pal.editer", "Ajouter, supprimer, trier");
    r.setAttribute("aria-label", r.title);
    r.setAttribute("aria-pressed", edition ? "true" : "false");
    r.appendChild(faisRouage(document));
    r.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      edition = !edition;
      /* On ne quitte pas l'édition avec une sélection en cours : les deux modes
       * arment des gestes différents sur la même tuile, et laisser un marqueur
       * choisi d'un mode à l'autre est le meilleur moyen d'en poser un sans le
       * vouloir. */
      videChoix();
      dernierBilan = null;
      faisBarre();
      /* DANS LES DEUX SENS. Entrer en édition ajoute une ligne de formulaire,
       * en sortir la retire : la hauteur du panneau change à chaque fois, et
       * c'est elle que cette fonction borne. Ne la rappeler qu'à l'aller
       * laissait le panneau réduit avec une borne calculée pour l'autre état. */
      if (paletteOuverte) { poseContreLaBarre(barre, false); }
    });
    t.appendChild(r);

    /* LA CROIX, ET C'EST L'UNE DES DEUX SEULES FAÇONS DE REFERMER.
     *
     * Depuis qu'un clic ailleurs ne referme plus, la palette a besoin d'une
     * sortie qui se voie. Elle est à droite du rouage, là où toute fenêtre porte
     * la sienne — on ne réinvente pas la place d'un bouton que les gens ont déjà
     * dans l'œil. */
    var x = document.createElement("button");
    x.type = "button";
    x.className = "vttk-barre-ferme";
    x.title = ditLe("pal.fermer", "Fermer la palette");
    x.setAttribute("aria-label", x.title);
    x.textContent = "×";
    x.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      fermePalette();
    });
    t.appendChild(x);
    return t;
  }

  /* ---------- LE CHOIX DU MODE, DANS LA PALETTE MÊME ----------
   *
   * DEUX BOUTONS PLUTÔT QU'UN INTERRUPTEUR. Un interrupteur dirait « autre
   * mode » sans dire lequel ; deux moitiés dont une est enfoncée disent l'état
   * ET le choix du même coup. Ils portent des mots, pas des pictogrammes : rien
   * ne dessine « on clique le marqueur puis les tokens » de façon lisible à
   * vingt pixels.
   *
   * ILS SONT HORS DU MODE ÉDITION, et c'est délibéré : ce n'est pas un réglage
   * de la palette mais une façon de s'en servir, qu'on change en cours de partie
   * selon ce qu'on a à faire. */
  function faisChoixDeMode() {
    var b = document.createElement("div");
    b.className = "vttk-barre-modes";
    b.setAttribute("role", "group");
    b.setAttribute("aria-label", ditLe("pal.maniere", "Manière de poser les marqueurs"));

    [{ id: MODE_MARQUEUR,
       mot: ditLe("pal.mode1", "Marqueur → jetons"),
       aide: ditLe("pal.mode1Aide", "On choisit un marqueur, puis on clique les jetons.") },
     { id: MODE_TOKENS,
       mot: ditLe("pal.mode2", "Jetons → marqueur"),
       aide: ditLe("pal.mode2Aide", "On sélectionne des jetons, puis un clic sur un marqueur les marque tous.") }
    ].forEach(function (m) {
      var o = document.createElement("button");
      o.type = "button";
      o.className = "vttk-barre-mode" + (modePose === m.id ? " actif" : "");
      o.textContent = m.mot;
      o.title = m.aide;
      o.setAttribute("aria-pressed", modePose === m.id ? "true" : "false");
      o.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (modePose === m.id) { return; }
        modePose = m.id;
        /* CHANGER DE MODE VIDE LA SÉLECTION. Les deux modes arment des gestes
         * différents sur les mêmes tuiles : laisser un marqueur choisi d'un mode
         * à l'autre est le meilleur moyen d'en poser un sans le vouloir. */
        videChoix();
        dit("", false);
        versContenu({ type: "marqueurs-mode", mode: m.id });
        faisBarre();
        if (paletteOuverte) { poseContreLaBarre(barre, false); }
      });
      b.appendChild(o);
    });
    return b;
  }

  /* ---------- LA PALETTE DOIT POUVOIR DIRE QUELQUE CHOSE ----------
   *
   * Elle n'avait de voix qu'en mode édition, dans le compte rendu du formulaire.
   * Or c'est en mode ORDINAIRE qu'arrive le refus le plus important — « ce token
   * ne vous appartient pas » —, et un refus muet est un défaut apparent : on
   * clique, rien ne se passe, et rien n'explique pourquoi.
   *
   * Le mot vit sous la barre de titre, il s'efface au bout de cinq secondes, et
   * il survit à une reconstruction de la palette — laquelle peut arriver entre
   * le moment où on le pose et celui où on le lit. */
  var motDit = null, motMinuterie = null;

  function dit(texte, mauvais) {
    motDit = texte ? { texte: texte, mauvais: !!mauvais } : null;
    peintMot();
    if (motMinuterie) { clearTimeout(motMinuterie); motMinuterie = null; }
    if (texte) {
      motMinuterie = setTimeout(function () {
        motMinuterie = null;
        motDit = null;
        peintMot();
      }, 5000);
    }
  }

  function peintMot() {
    if (!barre) { return; }
    var n = barre.querySelector(".vttk-barre-mot");
    if (!n) { return; }
    n.textContent = motDit ? motDit.texte : "";
    n.hidden = !motDit;
    n.classList.toggle("mauvais", !!(motDit && motDit.mauvais));
  }

  /* Un rouage, dessiné : sa police d'icônes en a un — « settings », employé pour
   * le bouton des réglages —, mais il n'est atteignable que par un clone de SES
   * boutons d'outils. Ici on est dans notre propre panneau, où rien n'a été
   * cloné : on dessine, comme pour le sourire.
   *
   * DEUX JETS RATÉS AVANT CELUI-CI, et ils disent quoi ne pas faire :
   *
   *   1. une couronne pleine décrite par un long tracé de courbes écrit à la
   *      main. Rendue à quatorze pixels, elle donnait une TACHE dont on ne
   *      distinguait plus les dents ;
   *   2. un cercle et huit rayons tracés au trait. Lisible, mais ce n'était plus
   *      un rouage : les rayons partant HORS du cercle, ça se lisait « soleil »
   *      ou « astérisque » — et c'est ce qui a été signalé.
   *
   * Un rouage se reconnaît à une SILHOUETTE dentée pleine, percée en son milieu.
   * On la CALCULE : huit dents carrées, chacune un créneau entre le rayon
   * extérieur et le rayon de fond, et un moyeu évidé par la règle pair-impair.
   * Une liste de coordonnées écrite à la main se relit mal et se corrige encore
   * plus mal — c'est exactement ce qui a produit la tache du premier jet. */
  function faisRouage(doc) {
    var s = doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "vttk-rouage");

    var N = 8, CX = 12, CY = 12;
    var DEHORS = 11, FOND = 7.7, MOYEU = 3.5;
    var pas = Math.PI * 2 / N;
    var demi = pas * 0.28;      // demi-largeur angulaire d'une dent
    var d = "", i, k;

    function point(angle, rayon) {
      return (CX + rayon * Math.cos(angle)).toFixed(2) + " " +
             (CY + rayon * Math.sin(angle)).toFixed(2);
    }

    for (i = 0; i < N; i++) {
      var a = i * pas;
      /* Le créneau d'une dent : on monte, on longe, on redescend, on longe le
       * fond jusqu'à la dent suivante. */
      var sommets = [
        [a - demi, DEHORS], [a + demi, DEHORS],
        [a + demi, FOND], [a + pas - demi, FOND]
      ];
      for (k = 0; k < sommets.length; k++) {
        d += (d ? "L" : "M") + point(sommets[k][0], sommets[k][1]) + " ";
      }
    }
    d += "Z ";
    /* LE MOYEU, en second tracé : avec la règle pair-impair, il creuse au lieu de
     * s'ajouter. Deux demi-arcs, parce qu'un arc SVG ne peut pas faire un tour
     * entier — son point d'arrivée serait son point de départ, et le tracé serait
     * ignoré. */
    d += "M" + (CX - MOYEU) + " " + CY +
         " A" + MOYEU + " " + MOYEU + " 0 1 0 " + (CX + MOYEU) + " " + CY +
         " A" + MOYEU + " " + MOYEU + " 0 1 0 " + (CX - MOYEU) + " " + CY + " Z";

    var p = doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "currentColor");
    p.setAttribute("fill-rule", "evenodd");
    s.appendChild(p);
    return s;
  }

  function faisEntete(mot, note) {
    var h = document.createElement("div");
    h.className = "vttk-marqueur-entete";
    var t = document.createElement("span");
    t.className = "vttk-marqueur-entete-mot";
    t.textContent = mot;
    h.appendChild(t);
    if (note) {
      var n = document.createElement("span");
      n.className = "vttk-marqueur-entete-note";
      n.textContent = note;
      h.appendChild(n);
    }
    return h;
  }

  /* PAS D'innerHTML. Le nom et l'adresse viennent d'un collage de
   * l'utilisateur, et cette chaîne serait construite DANS la page de Roll20 :
   * échapper trois caractères marcherait, mais construire les nœuds ne laisse
   * aucune question ouverte, et coûte le même prix. */
  function faisTuile(tag, j, supprimable) {
    var d = document.createElement("div");
    d.className = "vttk-marqueur-tuile";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "vttk-barre-marqueur";
    b.setAttribute("data-tag", tag);
    b.setAttribute("aria-pressed", "false");
    b.title = j.nom || tag;
    if (j.croix) {
      /* LA CROIX ROUGE, dessinée : « dead » n'a ni image ni entrée de catalogue,
       * il se rend par un maillage à part. */
      var x = document.createElementNS(SVG_NS, "svg");
      x.setAttribute("viewBox", "0 0 24 24");
      x.setAttribute("class", "vttk-marqueur-croix");
      x.setAttribute("aria-hidden", "true");
      var tr = document.createElementNS(SVG_NS, "path");
      tr.setAttribute("d", "M4 4 L20 20 M20 4 L4 20");
      tr.setAttribute("stroke", "rgb(201,16,16)");
      tr.setAttribute("stroke-width", "3.4");
      tr.setAttribute("stroke-linecap", "round");
      tr.setAttribute("fill", "none");
      x.appendChild(tr);
      b.appendChild(x);
    } else if (j.teinte) {
      /* UNE PASTILLE N'A PAS D'IMAGE : c'est un disque vectoriel chez lui, et
       * c'en est un chez nous. La teinte est LUE sur son propre modèle. */
      var d2 = document.createElement("span");
      d2.className = "vttk-marqueur-pastille";
      d2.style.background = j.teinte;
      b.appendChild(d2);
    } else {
      var img = document.createElement("img");
      img.src = j.url;
      img.alt = "";
      img.loading = "lazy";   // cinquante images ne se chargent pas d'un coup
      b.appendChild(img);
    }
    b.addEventListener("click", faisClicBouton(tag));
    d.appendChild(b);

    /* DEUX PASTILLES, ET DEUX COINS — elles disaient deux choses au même endroit.
     *
     * Une seule pastille portait le nombre frappé au clavier QUAND il y en avait
     * un, et sinon le rang du clic. Les deux ne pouvaient donc pas paraître
     * ensemble, et rien ne distinguait « ce marqueur portera un 3 » de « ce
     * marqueur est le troisième choisi » : même place, même forme.
     *
     *   · EN BAS À GAUCHE, le NOMBRE appliqué au marqueur — rouge, comme le
     *     compteur que Roll20 dessine sur les siens ;
     *   · EN BAS À DROITE, le RANG dans la sélection — rose, comme tout ce qui
     *     appartient à l'extension.
     *
     * Les deux sont posées pour TOUTES les tuiles et cachées par défaut :
     * `peintBarre` ne fait ensuite que du texte, sans jamais toucher à la
     * structure. */
    var nombre = document.createElement("span");
    nombre.className = "vttk-marqueur-nombre";
    nombre.hidden = true;
    d.appendChild(nombre);

    var rang = document.createElement("span");
    rang.className = "vttk-marqueur-rang";
    rang.hidden = true;
    d.appendChild(rang);

    /* LA CROIX ET LE DÉPLACEMENT NE VIVENT QU'EN ÉDITION. Une croix de
     * suppression à côté de chaque marqueur, en permanence, sur des tuiles de
     * vingt-six pixels, est un accident qui attend son heure. */
    if (supprimable && edition) {
      var x = document.createElement("button");
      x.type = "button";
      x.className = "vttk-marqueur-sup";
      x.title = ditLe("pal.retire", "Retirer") + " « " + (j.nom || tag) + " »";
      x.setAttribute("aria-label", x.title);
      x.textContent = "×";
      x.addEventListener("click", faisClicSuppression(tag));
      d.appendChild(x);

      d.draggable = true;
      d.setAttribute("draggable", "true");
      d.setAttribute("data-tag", tag);
      d.addEventListener("dragstart", faisDebutTraine(tag));
      d.addEventListener("dragend", function () {
        traine = null;
        if (barre) { barre.classList.remove("traine"); }
      });
    }
    return d;
  }

  /* ---------- TRIER À LA SOURIS ----------
   *
   * UN TYPE DE DONNÉE À NOUS, ET RIEN D'AUTRE DANS LE TRANSFERT. Roll20 accepte
   * des dépôts sur son plateau — on y jette une image et il en fait un token.
   * Un glissement portant du « text/plain » qui lui échapperait pourrait donc
   * lui parler ; avec un type qu'il ne connaît pas, un dépôt hors de notre
   * grille ne fait rien du tout, chez lui comme chez nous.
   *
   * `traine` sert de repli pour les navigateurs qui refusent de lire les données
   * pendant le survol — la plupart le font, par sécurité. */
  var TYPE_TRAINE = "application/x-vttk-marqueur";

  function faisDebutTraine(tag) {
    return function (ev) {
      traine = tag;
      if (barre) { barre.classList.add("traine"); }
      try {
        ev.dataTransfer.setData(TYPE_TRAINE, tag);
        ev.dataTransfer.effectAllowed = "move";
      } catch (e) {}
      if (ev.stopPropagation) { ev.stopPropagation(); }
    };
  }

  /* L'ORDRE APRÈS UN DÉPÔT — fonction PURE, donc éprouvable sans le moindre
   * événement. On déplace la source à la place de la cible : venant d'avant elle
   * se pose APRÈS, venant d'après elle se pose AVANT. C'est ce que fait tout
   * tri à la souris, et c'est ce qui donne l'impression que la tuile prend
   * exactement la place qu'on vise. */
  function ordreApres(tags, source, cible) {
    var de = tags.indexOf(source), a = tags.indexOf(cible);
    if (de < 0 || a < 0 || de === a) { return tags.slice(); }
    var out = tags.slice();
    out.splice(de, 1);
    var i = out.indexOf(cible);
    out.splice(de < a ? i + 1 : i, 0, source);
    return out;
  }

  function armeDepot(grille, tags) {
    grille.addEventListener("dragover", function (ev) {
      if (!traine) { return; }
      /* SANS CE preventDefault, LE DÉPÔT N'ARRIVE JAMAIS : le navigateur refuse
       * par défaut de laisser tomber quoi que ce soit sur un élément. */
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "move"; } catch (e) {}
    });
    grille.addEventListener("drop", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var source = traine;
      try {
        var d = ev.dataTransfer && ev.dataTransfer.getData(TYPE_TRAINE);
        if (d) { source = d; }
      } catch (e) {}
      traine = null;
      if (barre) { barre.classList.remove("traine"); }
      if (!source) { return; }
      /* LA CIBLE EST LA TUILE SOUS LE POINTEUR. Lâché entre deux tuiles, ou dans
       * le vide après la dernière, on prend la DERNIÈRE : c'est le geste « mets
       * ça à la fin », et il n'a rien d'ambigu. */
      var n = ev.target, cible = null;
      while (n && n !== grille) {
        if (n.getAttribute && n.getAttribute("data-tag")) { cible = n.getAttribute("data-tag"); break; }
        n = n.parentNode;
      }
      if (!cible) { cible = tags[tags.length - 1]; }
      var neuf = ordreApres(tags, source, cible);
      if (neuf.join(",") === tags.join(",")) { return; }
      versContenu({ type: "marqueurs-ordre", ordre: neuf });
    });
  }

  function faisClicSuppression(tag) {
    return function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var i = rangDansChoix(tag);
      if (i >= 0) { basculeChoix(tag); }
      versContenu({ type: "marqueurs-retire", tag: tag });
    };
  }

  /* ---------- [NOM] [ADRESSE] [+] ----------
   *
   * TROIS CHAMPS SUR UNE LIGNE, et la touche Entrée vaut le bouton. Ce qu'il y
   * avait avant — une zone de texte de deux lignes où l'on collait « Nom | url »
   * — demandait de connaître une syntaxe pour faire la chose la plus simple du
   * module. Le nom reste facultatif : sans lui, on le tire de l'adresse, comme
   * avant. */
  function faisFormulaire() {
    var bloc = document.createElement("div");
    bloc.className = "vttk-marqueur-ajout";

    var ligne = document.createElement("div");
    ligne.className = "vttk-marqueur-ligne";

    champNom = document.createElement("input");
    champNom.type = "text";
    champNom.className = "vttk-marqueur-champ nom";
    champNom.placeholder = ditLe("mq.nom", "Nom");
    champNom.setAttribute("aria-label", ditLe("pal.nom", "Nom du marqueur"));

    champUrl = document.createElement("input");
    champUrl.type = "text";
    champUrl.className = "vttk-marqueur-champ url";
    champUrl.placeholder = "https://…/image.png";
    champUrl.setAttribute("aria-label", ditLe("pal.url", "Adresse de l'image"));

    /* ON REPOSE CE QUI ÉTAIT TAPÉ, et on ne le repose qu'UNE fois : ces champs
     * sont neufs, ceux d'avant sont partis avec l'ancien panneau. */
    if (saisieEnCours) {
      champNom.value = saisieEnCours.nom;
      champUrl.value = saisieEnCours.url;
      saisieEnCours = null;
    }

    var plus = document.createElement("button");
    plus.type = "button";
    plus.className = "vttk-marqueur-bouton";
    plus.textContent = "+";
    plus.title = ditLe("pal.ajoute", "Ajouter ce marqueur");
    plus.setAttribute("aria-label", plus.title);

    function envoie(ev) {
      if (ev && ev.preventDefault) { ev.preventDefault(); }
      if (ev && ev.stopPropagation) { ev.stopPropagation(); }
      var u = String(champUrl.value || "").trim();
      if (!u) { montreBilan({ retenus: 0, rejets: ["il faut une adresse d'image"] }); return; }
      versContenu({ type: "marqueurs-ajoute",
        nom: String(champNom.value || "").trim(), url: u });
    }

    function surEntree(ev) {
      if (ev.key === "Enter" || ev.keyCode === 13) { envoie(ev); }
      /* Les frappes du formulaire ne remontent pas : sans quoi taper une adresse
       * numéroterait la tuile survolée, et un « s » atteindrait les raccourcis
       * de Roll20. */
      if (ev.stopPropagation) { ev.stopPropagation(); }
    }
    champNom.addEventListener("keydown", surEntree);
    champUrl.addEventListener("keydown", surEntree);
    plus.addEventListener("click", envoie);

    ligne.appendChild(champNom);
    ligne.appendChild(champUrl);
    ligne.appendChild(plus);
    bloc.appendChild(ligne);

    bilanCollage = document.createElement("p");
    bilanCollage.className = "vttk-marqueur-bilan";
    bilanCollage.hidden = true;
    bloc.appendChild(bilanCollage);
    peintBilan();   // le panneau vient d'être refait : on y repose le dernier mot
    /* AJOUTER UN MARQUEUR RECONSTRUIT LA PALETTE — l'écriture du stockage
     * repasse par le module, qui renvoie le catalogue. Les champs qu'on vient de
     * vider n'existent alors plus, et le foyer serait perdu au moment précis où
     * l'on s'apprête à en saisir un autre. Rien ne dit lequel du bilan ou de la
     * reconstruction arrive en premier : on rend le foyer des DEUX côtés. */
    if (dernierBilan && dernierBilan.bon) { try { champNom.focus(); } catch (e) {} }
    return bloc;
  }

  /* Le pont n'écrit rien lui-même : il DEMANDE, et le script de contenu écrit.
   * C'est le même chemin que tout le reste du module, à l'envers. */
  function versContenu(msg) {
    msg.ns = NS;
    msg.depuis = "page";
    try { window.postMessage(msg, location.origin); } catch (e) {}
  }

  /* On dit combien sont entrés, combien ont été écartés, et POURQUOI pour les
   * trois premiers — au-delà la liste devient illisible et ne sert plus. Le
   * champ ne se vide que si quelque chose est passé : sinon on efface sous les
   * yeux de l'utilisateur ce qu'il vient de coller. */
  var dernierBilan = null;

  function montreBilan(d) {
    var pris = d.retenus || 0, rejets = d.rejets || [];
    var t = pris ? pris + " ajouté" + (pris > 1 ? "s" : "") : "Rien d'ajouté";
    if (rejets.length) {
      t += " — " + rejets.length + " écarté" + (rejets.length > 1 ? "s" : "") + " : " +
        rejets.slice(0, 3).join(" ; ");
      if (rejets.length > 3) { t += " …"; }
    }
    /* ON LE GARDE, parce que le panneau se refait juste après : ajouter un marqueur
     * écrit le stockage, ce qui fait repasser le module, ce qui reconstruit la
     * palette — et le message aurait disparu avec l'ancien champ. Rien ne dit
     * lequel des deux arrive en premier ; on ne parie donc sur aucun ordre. */
    dernierBilan = { texte: t, bon: !!pris };
    /* LES CHAMPS NE SE VIDENT QUE SI QUELQUE CHOSE EST PASSÉ, sinon on efface
     * sous les yeux de l'utilisateur l'adresse qu'il vient de saisir — et c'est
     * précisément quand elle est refusée qu'il a besoin de la relire.
     *
     * ON REND LE FOYER AU NOM : ajouter trois marqueurs de suite est le cas
     * courant, et la palette se reconstruit entre chacun. Sans cette ligne, il
     * faudrait recliquer dans le champ à chaque fois. */
    if (pris && champNom && champUrl) {
      champNom.value = "";
      champUrl.value = "";
      try { champNom.focus(); } catch (e) {}
    }
    peintBilan();
  }

  function peintBilan() {
    if (!bilanCollage) { return; }
    if (!dernierBilan) { bilanCollage.hidden = true; return; }
    bilanCollage.textContent = dernierBilan.texte;
    bilanCollage.hidden = false;
    bilanCollage.classList.toggle("mauvais", !dernierBilan.bon);
  }

  function oteBarre() {
    fermePalette();
    if (barre && barre.parentNode) { barre.parentNode.removeChild(barre); }
    barre = null;
    /* Un glissement en cours meurt avec la palette : sans ça, `traine` resterait
     * à une étiquette d'un panneau qui n'existe plus, et le premier dépôt après
     * un rallumage réordonnerait sur une donnée périmée.
     *
     * `edition`, LUI, SURVIT, et c'est voulu : c'est un état de travail. Qui
     * éteint puis rallume le module au milieu d'un rangement de palette veut
     * reprendre son rangement, pas le recommencer. */
    traine = null;
    champNom = null;
    champUrl = null;
    bilanCollage = null;
    saisieEnCours = null;
    if (outil && outil.parentNode) { outil.parentNode.removeChild(outil); }
    outil = null;
    /* LA SECTION NE PART PAS AVEC LE MODULE. Elle est partagée avec le bouton
     * des réglages, qui, lui, ne s'éteint jamais : la retirer ici laisserait un
     * bouton orphelin sous l'intitulé « Effets » de Roll20. */
    outilTitre = null;
  }

  /* ============================================================
   *   PLUS DE CATALOGUE PARTAGÉ : L'ÉTIQUETTE PORTE SON ADRESSE
   * ============================================================
   *
   * IL Y AVAIT ICI TOUT UN SOUS-SYSTÈME, et il a été supprimé. L'étiquette ne
   * disait que le nom (« vt-poison »), donc il fallait un catalogue commun pour
   * savoir quelle image dessiner : un DOCUMENT de campagne à créer, à lire, à
   * fusionner sans écraser celui des autres, à faire converger par un tri
   * d'étiquettes pour que deux machines ne se répondent pas indéfiniment — et
   * que seul un MJ peut écrire.
   *
   * L'étiquette porte maintenant l'adresse : « vttk_<nom>_<adresse> ». Tout cela
   * devient inutile. N'importe quel joueur ayant l'extension voit le marqueur,
   * immédiatement, sans rien avoir reçu de personne et sans le moindre droit
   * d'écriture. Et plus rien n'est écrit dans la campagne au-delà de
   * l'étiquette elle-même — ce qui était le but depuis le début.
   *
   * MESURÉ AVANT D'Y ALLER : une étiquette de 70 caractères est écrite, relue et
   * renvoyée intacte par Roll20, aussitôt comme quatre secondes plus tard ;
   * trois marqueurs d'un coup (180 caractères) de même. Les « ? », « = », « / » et
   * « . » d'une adresse passent sans dommage. Restent interdits la virgule et
   * l'arobase, que Roll20 emploie comme séparateurs — la validation les refuse. */

  var marqueursMiens = null;      // ce que l'utilisateur a mis dans SA palette

  /* ON NE FAIT PAS CONFIANCE À CE QU'ON LIT DANS LA CAMPAGNE. Cette chaîne est
   * écrite par d'autres joueurs, et le pont vit dans la page de Roll20 : c'est
   * exactement le genre d'entrée dont on ne présume rien. La validation de
   * commun/marqueurs.js n'est pas disponible ici — elle vit dans le monde isolé —
   * donc on la refait, à l'identique. */
  /* LES DEUX MONDES DOIVENT DIRE LA MÊME CHOSE D'UNE MÊME ADRESSE.
   *
   * Le jumeau de commun/marqueurs.js commence par un trim() ; celui-ci ne le
   * faisait pas. Une adresse relue d'une campagne avec une espace finale était
   * donc VALIDE dans le monde isolé et REFUSÉE ici — le marqueur entrait au
   * catalogue et ne se dessinait jamais, sans un mot.
   *
   * On s'aligne sur le plus permissif des deux, parce que c'est lui qui a déjà
   * écrit dans les campagnes : refuser ici ce que l'autre a accepté là-bas
   * casserait des palettes existantes. */
  function urlSure(u) {
    u = String(u === undefined || u === null ? "" : u).trim();
    if (typeof u !== "string" || u.length > 240) { return null; }
    if (u.indexOf(",") >= 0 || u.indexOf("@") >= 0) { return null; }
    /* UN HÔTE POINTÉ ET UN CHEMIN. Sans ça, « https://javascript:alert(1) »
     * passait : ce n'est pas une adresse d'image mais ça coche « commence par
     * https:// et ne contient ni espace ni chevron ». La même règle qu'en
     * commun/marqueurs.js, mot pour mot. */
    return /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?\/[^\s"'<>]*$/i.test(u) ? u : null;
  }

  /* ============================================================
   *        LES JOUEURS DE LA TABLE, POUR LE CHAT
   * ============================================================
   *
   * LE PONT NE TOUCHE PAS AU CHAT — c'est du DOM ordinaire, et le script de
   * contenu y a accès directement. Il n'apporte que ce que le script de contenu
   * NE PEUT PAS voir : la collection Backbone des joueurs, qui vit dans la page.
   *
   * MESURÉ SUR UNE VRAIE PARTIE : `Campaign.players.models` porte cinq entrées,
   * chacune avec `displayname`, `online` et `color`. C'est la bonne source — elle
   * contient bien les noms que l'auteur cite.
   *
   * ON ÉCOUTE LA COLLECTION plutôt que de la relire à intervalles : un joueur qui
   * arrive, qui part ou qui se renomme doit paraître dans la liste sans qu'on
   * recharge, et Backbone prévient déjà. */
  var chatActif = false, chatLiee = null, chatSurChange = null;

  function joueursDeLaTable() {
    var C = window.Campaign, out = [];
    var col = C && C.players;
    if (!col || !col.models) { return out; }
    col.models.forEach(function (m) {
      var a = m.attributes || {};
      var nom = String(a.displayname || "").trim();
      if (!nom) { return; }
      out.push({ id: m.id, nom: nom, enLigne: !!a.online, couleur: a.color || null });
    });
    return out;
  }

  function emetJoueurs() {
    if (!chatActif) { return; }
    try {
      window.postMessage({ ns: NS, depuis: "page", type: "chat-joueurs",
                           joueurs: joueursDeLaTable(),
                           moi: (window.currentPlayer && window.currentPlayer.id) || null }, location.origin);
    } catch (e) {}
  }

  /* LA COLLECTION N'EST PAS LÀ TOUT DE SUITE, et c'est ce qui a raté au premier
   * jet : le module démarre avec la page, `Campaign.players` est alors vide ou
   * absente, on envoyait donc une liste vide — et comme on n'avait pas de
   * collection à écouter, plus rien ne la corrigeait jamais. Le sélecteur ne
   * proposait que « tout le monde » et « MJ », pour toujours.
   *
   * On réessaie donc jusqu'à la trouver peuplée, à intervalle court et pour un
   * temps borné. Dès qu'elle est là on s'y abonne, et le guet s'arrête : c'est
   * Backbone qui prévient ensuite. */
  var chatGuet = null, chatTours = 0;

  function tenteDeLier() {
    var col = window.Campaign && window.Campaign.players;
    if (!col || !col.on) { return false; }
    chatSurChange = function () { emetJoueurs(); };
    col.on("add", chatSurChange);
    col.on("remove", chatSurChange);
    col.on("change:displayname", chatSurChange);
    col.on("change:online", chatSurChange);
    chatLiee = col;
    return true;
  }

  function installeChat() {
    chatActif = true;
    delieChat();
    if (chatGuet) { clearInterval(chatGuet); chatGuet = null; }
    chatTours = 0;

    var lie = tenteDeLier();
    emetJoueurs();

    /* On s'arrête dès qu'on a une collection ET au moins un joueur : une table
     * vide n'existe pas — on y est soi-même. */
    if (!lie || !joueursDeLaTable().length) {
      chatGuet = setInterval(function () {
        chatTours++;
        if (!chatActif || chatTours > 40) {
          clearInterval(chatGuet); chatGuet = null; return;
        }
        if (!chatLiee) { tenteDeLier(); }
        if (chatLiee && joueursDeLaTable().length) {
          clearInterval(chatGuet); chatGuet = null;
          emetJoueurs();
        }
      }, 500);
    }
    return { ok: true, joueurs: joueursDeLaTable().length, ecoute: !!chatLiee };
  }

  function delieChat() {
    if (chatLiee && chatLiee.off) {
      try { chatLiee.off("add", chatSurChange); } catch (e) {}
      try { chatLiee.off("remove", chatSurChange); } catch (e) {}
      try { chatLiee.off("change:displayname", chatSurChange); } catch (e) {}
      try { chatLiee.off("change:online", chatSurChange); } catch (e) {}
    }
    chatLiee = null;
    chatSurChange = null;
  }

  function retireChat() {
    chatActif = false;
    delieChat();
    if (chatGuet) { clearInterval(chatGuet); chatGuet = null; }
    return { ok: true };
  }

  /* ============================================================
   *          NOTRE CALQUE, SUR L'ANCIEN MOTEUR
   * ============================================================
   *
   * Les deux modules qui suivent — les marqueurs et la grille — n'ont pas de
   * Babylon où poser un maillage. Il leur faut une surface, et le relevé a
   * montré qu'aucune de celles de Roll20 ne convient :
   *
   *   · SA TOILE VISIBLE EST LA SEULE DU DOCUMENT, et c'est « #babylonCanvas »
   *     — même sur une campagne d'héritage. Elle est en WebGL : rien à peindre
   *     dessus en 2D.
   *   · SON CANEVAS FABRIC N'EST PAS AU DOCUMENT. « lowerCanvasEl » et
   *     « upperCanvasEl » sont des tampons hors écran, téléversés ensuite comme
   *     textures. On a perdu deux essais à peindre dedans : la peinture
   *     réussissait, sans erreur, ET RIEN N'APPARAISSAIT.
   *   · « onAfterFOWRenderCallbacks » n'est jamais appelé sans brouillard.
   *
   * D'OÙ CE CALQUE : une toile à nous, posée par-dessus la sienne, à la même
   * taille et à la même place, qui ne reçoit aucun clic. On ne touche à rien de
   * son rendu — ni sa boucle, ni ses tampons, ni sa couche WebGL.
   *
   * ---------- LA CONVERSION, ÉPROUVÉE DEUX FOIS ----------
   *
   *     écran = (page − currentCanvasOffset) × canvasZoom
   *
   * Elle a été vérifiée EN PEIGNANT, jamais en calculant : un cadre rouge sur
   * chaque jeton, et l'on regarde s'il tombe dessus. La première fois à zoom 1
   * et décalage nul — c'est-à-dire dans le seul cas où l'identité tombe juste
   * par accident, donc où la mesure ne prouve rien. La seconde à 200 % et vue
   * déplacée, décalage [151, 551] : le cadre tombait exactement sur le jeton.
   * C'est cette seconde-là qui compte.
   *
   * ---------- LE RYTHME ----------
   *
   * Compté sur une vraie partie : « renderLoop » bat à la fréquence de l'écran
   * — 180 par seconde, exactement les trames du navigateur —, et tout le reste
   * (redrawScreenNextTick, drawHighlights, compositeCanvases) ne bat que sur
   * événement. On ne l'enveloppe pas pour autant : notre propre trame fait le
   * même travail, ne touche à rien de chez lui, et se retire d'un seul appel.
   *
   * Et ça ne coûte rien : effacer la toile entière puis y poser vingt cases a
   * été chronométré à 0,005 ms. Un peintre inscrit, une trame ; aucun peintre,
   * aucune trame et le calque disparaît du document.
   */
  var CALQUE = (function () {
    var el = null, ctx = null, raf = null;
    /* ORDONNÉS PAR RANG, ET PAS PAR ORDRE D'ALLUMAGE. La grille doit passer
     * SOUS les marqueurs — comme chez lui, où elle passe sous les jetons —, et
     * l'ordre d'allumage des modules n'a rien à voir avec un ordre de dessin. */
    var peintres = [];   // [{ nom, fn, rang }], du plus bas rang au plus haut

    function toileDeRoll20() {
      try { return document.getElementById("babylonCanvas"); } catch (e) { return null; }
    }

    /* On recale à chaque trame : la fenêtre se redimensionne, la barre latérale
     * s'ouvre et se ferme, et sa toile suit. Les tests d'égalité évitent
     * d'écrire un style identique soixante fois par seconde — une écriture de
     * style invalide la mise en page, une comparaison ne coûte rien. */
    function ajuste() {
      var vis = toileDeRoll20();
      if (!vis) { return false; }
      if (!el) {
        el = document.createElement("canvas");
        el.id = "vttk-calque";
        el.style.cssText = "position:fixed;pointer-events:none;z-index:9;";
        ctx = null;
      }
      if (el.parentNode !== vis.parentNode) {
        try { vis.parentNode.appendChild(el); } catch (e) { return false; }
      }
      /* CHANGER width OU height EFFACE LA TOILE ET REMET SON CONTEXTE À NEUF :
       * on ne le fait que si la taille a bougé, sinon on repartirait d'un
       * contexte vierge à chaque trame. */
      if (el.width !== vis.width) { el.width = vis.width; }
      if (el.height !== vis.height) { el.height = vis.height; }
      var q = vis.getBoundingClientRect();
      var g = q.left + "px", h = q.top + "px", l = q.width + "px", t = q.height + "px";
      if (el.style.left !== g) { el.style.left = g; }
      if (el.style.top !== h) { el.style.top = h; }
      if (el.style.width !== l) { el.style.width = l; }
      if (el.style.height !== t) { el.style.height = t; }
      if (!ctx) { try { ctx = el.getContext("2d"); } catch (e) { return false; } }
      return !!ctx;
    }

    /* Ce que tout peintre a besoin de savoir, lu une seule fois par trame. */
    function vue() {
      var d = null;
      try { d = (window.currentPlayer && window.currentPlayer.d20) || window.d20; } catch (e) {}
      var e2 = d && d.engine;
      if (!e2 || !(e2.canvasZoom > 0)) { return null; }
      var off = e2.currentCanvasOffset || [0, 0];
      return { zoom: e2.canvasZoom, ox: off[0] || 0, oy: off[1] || 0,
               l: el.width, h: el.height, d20: d };
    }

    /* CE QUE LA TRAME COÛTE, EXPOSÉ. Deux lectures d'horloge, et une moyenne
     * glissante : de quoi répondre par un chiffre à « est-ce que ça rame ». */
    var compteur = window.__vttinkerCalque = { trames: 0, ms: 0, max: 0 };

    function trame() {
      raf = null;
      var reste = peintres.length > 0;
      var t0 = (window.performance && performance.now) ? performance.now() : 0;
      try {
        if (reste && ajuste()) {
          var v = vue();
          if (v) {
            ctx.clearRect(0, 0, el.width, el.height);
            for (var n = 0; n < peintres.length; n++) {
              /* UN PEINTRE QUI CASSE NE DOIT PAS EMPORTER LES AUTRES, ni la
               * trame suivante. On retient l'erreur plutôt que de l'avaler :
               * un « catch » muet dans ce fichier a déjà coûté une session.
               *
               * ET ON REMET LA TRANSFORMATION APRÈS CHACUN. Le peintre de la
               * grille pose une échelle pour que le drawGrid de Roll20 dessine
               * en coordonnées de page ; s'il sautait au milieu, le suivant
               * peindrait à trois fois la bonne taille. */
              try { peintres[n].fn(ctx, v); }
              catch (e) { window.__vttinkerCalqueErreur = peintres[n].nom + " : " + String(e && e.stack || e).slice(0, 300); }
              try { ctx.setTransform(1, 0, 0, 1, 0, 0); } catch (e) {}
            }
          }
        }
      } catch (e) {}
      if (t0) {
        var dt = performance.now() - t0;
        compteur.trames++;
        compteur.ms += dt;
        if (dt > compteur.max) { compteur.max = dt; }
      }
      if (reste) { raf = requestAnimationFrame(trame); }
      else { demonte(); }
    }

    function demonte() {
      if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} raf = null; }
      if (el && el.parentNode) { try { el.parentNode.removeChild(el); } catch (e) {} }
      el = null; ctx = null;
    }

    /* QUI PEINT, ET DANS QUEL ORDRE — exposé pour qu'un outil extérieur puisse
     * le lire. Un peintre laissé allumé par mégarde ne se voit dans aucune
     * mesure de pixels : il faut pouvoir demander la liste. */
    function annonce() {
      try {
        window.__vttinkerPeintres = peintres.map(function (x) { return x.nom + ':' + x.rang; });
      } catch (e) {}
    }

    function inscris(nom, fn, rang) {
      raye(nom, true);
      peintres.push({ nom: nom, fn: fn, rang: rang || 0 });
      peintres.sort(function (a, b) { return a.rang - b.rang; });
      annonce();
      if (!raf) { raf = requestAnimationFrame(trame); }
    }

    /* « garde » sert à la réinscription : on retire l'ancien sans démonter le
     * calque, qu'on va rendre au suivant dans la même instruction. */
    function raye(nom, garde) {
      for (var i = peintres.length - 1; i >= 0; i--) {
        if (peintres[i].nom === nom) { peintres.splice(i, 1); }
      }
      annonce();
      if (!peintres.length && !garde) { demonte(); }
    }

    return { inscris: inscris, raye: raye,
             toile: function () { return el; },
             compte: function () { return peintres.length; } };
  })();

  /* ============================================================
   *        LES MARQUEURS DESSINÉS, SUR L'ANCIEN MOTEUR
   * ============================================================
   *
   * ---------- SA LOI EST LA MÊME, ET ELLE A ÉTÉ MESURÉE ICI AUSSI ----------
   *
   * Sous Jumpgate, on LIT l'échelle de Roll20 sur ses propres quads Babylon
   * plutôt que de la calculer. Ici il n'y a rien à lire : poser huit marqueurs
   * sur un jeton ne crée AUCUN objet de canevas — mesuré, 38 objets avant, 38
   * après —, il les peint directement dans son tampon.
   *
   * On a donc relevé sa rangée AU PIXEL, en lisant « lowerCanvasEl » (la seule
   * de ses surfaces 2D qui porte les pastilles) et en cherchant chaque teinte.
   * Sur un jeton de 39,17 de côté, à 250 % :
   *
   *     n      pas mesuré     22 × min(1, largeur / 22n)
   *     2        19,4                 19,6
   *     3        13,0                 13,05
   *     5         7,9                  7,83
   *     7         5,6                  5,59
   *
   * C'EST EXACTEMENT LA LOI DE REPLI DU MODULE DE JUMPGATE, au demi pour cent.
   * Le côté suit (19 × échelle), et le premier centre est à 12,5 × échelle du
   * coin haut-droit : pour sept marqueurs, le dernier tombe à 3,1 du bord droit
   * quand la formule dit 3,2. Les trois constantes valent donc pour les deux
   * moteurs, et ce module n'en invente aucune.
   *
   * ---------- CE QU'IL N'A PAS À FAIRE ----------
   *
   * Rien de ce qui, sous Jumpgate, sert à tenir des maillages à jour : ni pose
   * par jeton, ni signature, ni abonnement Backbone, ni rendez-vous différé
   * pour les nœuds qui manquent. Un peintre repart de l'état courant à chaque
   * trame ; il n'y a donc rien à synchroniser, et rien qui puisse se désaccorder.
   */
  var MH = (function () {
    var images = {};    // adresse -> Image, chargée une fois
    var poses = 0, tokens = 0;

    /* L'image, ou rien. On ne dessine jamais une image incomplète : Canvas 2D
     * lèverait, et le peintre entier sauterait pour un marqueur. */
    function image(url) {
      var im = images[url];
      if (im) { return (im.complete && im.naturalWidth) ? im : null; }
      im = new Image();
      im.decoding = "async";
      try { im.src = url; } catch (e) { return null; }
      images[url] = im;
      return null;
    }

    /* LE COMPTEUR, REPRIS DE SA GÉOMÉTRIE ET NON DE SON DESSIN. Sa texture fait
     * 28 pixels de haut pour 2 pixels par unité de plateau : le nombre occupe
     * donc 14 unités de haut, sa fonte 12,5, son cerne 2, et son centre descend
     * de 7 sous celui du marqueur. Tout cela × échelle × zoom donne des pixels
     * d'écran. On ne cherche pas à égaler sa fonte — on ne la connaît pas —
     * mais son encombrement et ses couleurs, qui sont ce qui se voit quand les
     * deux sont côte à côte. */
    function peinsNombre(ctx, n, sx, sy, ech, zoom) {
      var u = ech * zoom;                       // une unité de plateau, en pixels
      var taille = (25 / NOMBRE_DENSITE) * u;   // 25 px de fonte sur une densité de 2
      if (taille < 4) { return; }               // illisible : on ne barbouille pas
      ctx.save();
      ctx.font = "bold " + taille.toFixed(1) + "px Arial, Helvetica, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = (4 / NOMBRE_DENSITE) * u;
      ctx.strokeStyle = NOMBRE_BLANC;
      var y = sy + NOMBRE_SOUS * u;
      ctx.strokeText(n, sx, y);
      ctx.fillStyle = NOMBRE_ROUGE;
      ctx.fillText(n, sx, y);
      ctx.restore();
    }

    /* OÙ EST LE JETON, MAINTENANT. Le modèle ne bouge qu'au lâcher ; son objet
     * de canevas, lui, suit la souris pendant qu'on traîne. On préfère donc
     * l'objet quand on le trouve — c'est ce qui fait que nos marqueurs
     * accompagnent le jeton au lieu de l'attendre.
     *
     * Le relevé le confirme sur un jeton immobile : modèle (357, 880, 39) et
     * objet (357, 880, 39), au pixel. */
    function ouEst(objets, t) {
      var o = objets[t.id];
      if (o && o.left !== undefined && o.width) {
        return { x: o.left, y: o.top,
                 l: o.width * (o.scaleX || 1), h: o.height * (o.scaleY || 1) };
      }
      var a = t.attributes || {};
      return { x: a.left, y: a.top, l: a.width || 70, h: a.height || 70 };
    }

    function objetsParModele(d) {
      var m = {};
      try {
        var liste = d.engine.canvas.getObjects() || [];
        for (var i = 0; i < liste.length; i++) {
          var o = liste[i];
          if (o && o.model && o.model.id) { m[o.model.id] = o; }
        }
      } catch (e) {}
      return m;
    }

    /* LE DÉCOUPAGE, RETENU PAR CHAÎNE.
     *
     * « statusmarkers » ne change qu'au moment où quelqu'un pose un marqueur ;
     * entre deux, on recalculait cent quatre-vingts fois par seconde un
     * résultat rigoureusement identique — un découpage, et une recherche de
     * catalogue par étiquette.
     *
     * La mémoire se vide à l'installation comme à l'extinction : le partage
     * dépend du catalogue ET du jeu de marqueurs de Roll20, donc une palette
     * modifiée doit refaire le calcul. */
    var partages = {};

    function partageRetenu(brut) {
      var cle = brut || "";
      var v = partages[cle];
      if (v) { return v; }
      v = partageEtiquettes(cle);
      /* On ne retient pas indéfiniment : une partie où l'on change de marqueur
       * sans cesse ferait grossir cette table pour rien. Deux cents chaînes,
       * c'est déjà bien plus que ce qu'une page distincte peut porter. */
      var nb = 0;
      for (var k2 in partages) { if (Object.prototype.hasOwnProperty.call(partages, k2)) { nb++; } }
      if (nb > 200) { partages = {}; }
      partages[cle] = v;
      return v;
    }

    function peins(ctx, v) {
      var col = graphiquesCourants();
      if (!col || !col.models) { return; }
      /* PARESSEUX, ET C'EST TOUT LE POINT : parcourir les objets du canevas
       * coûte, et sur la plupart des pages personne ne porte de marqueur à
       * nous. On ne le fait qu'au premier jeton qui en a besoin. */
      var objets = null;
      var n = 0, vus = 0;
      col.models.forEach(function (t) {
        vus++;
        var brut = (t.attributes || {}).statusmarkers;
        if (!brut) { return; }
        var part = partageRetenu(brut);
        var k = part.notre.length;
        if (!k) { return; }
        if (!objets) { objets = objetsParModele(v.d20); }
        var g = ouEst(objets, t);
        if (!(g.l > 0) || typeof g.x !== "number") { return; }

        /* Sa loi, à son propre compte : c'est SA rangée qui décide de l'échelle,
         * et il ne compte que ce qu'il dessine — ajouter des marqueurs à nous ne
         * la change pas. */
        var ech = part.sien ? Math.min(1, g.l / (MARQUEUR_PAS * part.sien)) : 1;
        var cote = MARQUEUR_COTE * ech, pas = MARQUEUR_PAS * ech, premier = MARQUEUR_BORD * ech;
        /* La ligne est une invention de notre côté : Roll20 n'en connaît qu'une
         * et rapetisse jusqu'à tout y faire tenir. Nous refusons de rapetisser
         * davantage — ce qui est déjà petit deviendrait illisible —, donc on
         * passe à la ligne du dessous. Sa capacité est le plus grand de ce qu'il
         * a dessiné et de ce qui tient à l'échelle courante. */
        var parLigne = Math.max(1, part.sien, Math.floor(g.l / pas));
        var droite = g.x + g.l / 2, haut = g.y - g.h / 2;
        var cEcran = cote * v.zoom;
        for (var j = 0; j < k; j++) {
          /* Les cases sont numérotées depuis la droite, en continu : les siennes
           * d'abord, les nôtres à la suite. La rangée se remplissant de droite à
           * gauche, la dernière étiquette du champ se colle aux siennes — d'où
           * le (k − 1 − j). */
          var caseNo = part.sien + (k - 1 - j);
          var rang = Math.floor(caseNo / parLigne), colonne = caseNo % parLigne;
          var sx = ((droite - premier - pas * colonne) - v.ox) * v.zoom;
          var sy = ((haut + premier + pas * rang) - v.oy) * v.zoom;
          /* HORS DE LA TOILE, ON NE DESSINE PAS. Sur une grande page, la plupart
           * des jetons sont ailleurs, et « drawImage » hors cadre coûte quand
           * même son appel. */
          if (sx + cEcran < 0 || sy + cEcran < 0 || sx - cEcran > v.l || sy - cEcran > v.h) { continue; }
          var im = image(part.notre[j].url);
          if (im) {
            ctx.drawImage(im, sx - cEcran / 2, sy - cEcran / 2, cEcran, cEcran);
            n++;
          }
          if (part.notre[j].nombre) { peinsNombre(ctx, part.notre[j].nombre, sx, sy, ech, v.zoom); }
        }
      });
      poses = n; tokens = vus;
    }

    function installe() {
      partages = {};   // le catalogue a pu changer
      CALQUE.inscris("marqueurs", peins, 1);
      return { ok: true, moteur: "heritage", calque: true };
    }

    function retire() {
      CALQUE.raye("marqueurs");
      partages = {};
      images = {};
      poses = 0; tokens = 0;
      return { ok: true, moteur: "heritage" };
    }

    return { installe: installe, retire: retire,
             etat: function () { return { poses: poses, tokens: tokens, images: Object.keys(images).length }; } };
  })();

  /* ============================================================
   *        LA GRILLE HORS CARTE, SUR L'ANCIEN MOTEUR
   * ============================================================
   *
   * ---------- ON NE REDESSINE PAS SA GRILLE : ON LUI FAIT DESSINER LA NÔTRE ----------
   *
   * Le module de Jumpgate compte deux mille lignes, et pour cause : il lui faut
   * reconnaître cinq types de grille sur les maillages de Babylon, en déduire la
   * trame, et la prolonger sans que la jonction se voie. Ici, rien de tout ça —
   * et c'est sa propre source qui l'a dit :
   *
   *     drawGrid(T) { ... R == "hex"  ? d(T, -k, -x, P, B, "cols")
   *                     : R == "hexr" ? d(T, -k, -x, P, B, "rows")
   *                     : R === "dimetric" || R === "isometric" ? r(T, -k, -x)
   *                     :               e(T, -k, -x, P, B) }
   *
   * « T » EST UN CONTEXTE 2D, PASSÉ DE L'EXTÉRIEUR, et la fonction aiguille
   * elle-même sur le type de grille. On lui donne le nôtre : les cinq types, sa
   * géométrie, sa couleur, son opacité, son épaisseur de trait. Il n'y a rien à
   * faire coïncider, puisque c'est le même code qui dessine les deux.
   *
   * ---------- TROIS CHOSES MESURÉES, ET AUCUNE NE SE DEVINE ----------
   *
   *   1. ELLE NE SE BORNE PAS À LA CARTE. On a d'abord cru que oui : sa grille
   *      s'arrête net au rectangle de la page, la photo à 30 % le montre. Mais
   *      appelée sur notre calque elle a peint 6 322 pixels AU-DELÀ. Le bornage
   *      est fait ailleurs par Roll20 — pas par cette fonction. Contre-épreuve :
   *      en lui mentant sur la taille de la page (dix cases de plus de chaque
   *      côté), les chiffres n'ont pas bougé d'une unité. Elle ne la lit pas.
   *
   *   2. ELLE DESSINE EN COORDONNÉES DE PAGE. Au premier essai, notre grille
   *      était trois fois trop grande : à 30 %, ses cases faisaient 70 pixels
   *      d'écran quand celles de Roll20 en faisaient 21. Sa raison est dans le
   *      setZoom : « contextContainer.scale(s, s) » — son contexte porte le zoom
   *      en transformation accumulée, le nôtre était à l'identité. On la lui
   *      donne, et les deux grilles se superposent.
   *
   *   3. LE DÉCOUPAGE SE POSE AVANT LA TRANSFORMATION. « clip » retient la
   *      région en espace du périphérique : on trace donc le contour en pixels
   *      d'écran, transformation à l'identité, PUIS on pose l'échelle. Résultat
   *      mesuré : zéro pixel peint à l'intérieur de sa carte, 8 270 au-delà.
   *
   * ---------- CE QU'ON LUI LAISSE ----------
   *
   * Sa carte est à lui. On découpe en « tout sauf le rectangle de la page », de
   * sorte qu'aucun de nos pixels ne tombe là où il dessine déjà — pas de double
   * trait, pas de moiré, et rien à défaire si le module s'éteint.
   */
  var GH = (function () {
    var cases = 0;

    function pageCourante(d) {
      try { return (d.Campaign || window.Campaign).activePage() || null; } catch (e) { return null; }
    }

    /* LE PAS DE SA GRILLE, ET C'EST LUI QUI LE DIT. « snapTo » est ce que sa
     * propre drawGrid exige d'être positif avant de dessiner quoi que ce soit :
     * s'en servir, c'est être d'accord avec elle par construction. Le calcul à
     * partir de « snapping_increment » n'est qu'un repli. */
    function pasDeLaGrille(d, pg) {
      var s = d.engine ? d.engine.snapTo : 0;
      if (s > 0) { return s; }
      var i = pg.get("snapping_increment");
      return (i > 0) ? i * 70 : 0;
    }

    function peins(ctx, v) {
      if (!(cases > 0)) { return; }
      var d = v.d20, o = d && d.canvas_overlay;
      if (!o || typeof o.drawGrid !== "function") { return; }
      var pg = pageCourante(d);
      if (!pg) { return; }
      /* SANS GRILLE CHEZ LUI, RIEN À PROLONGER. Ce sont les deux conditions de
       * sa propre drawGrid : on les pose ici pour ne pas préparer un découpage
       * et une transformation dont elle ne fera rien. */
      if (!pg.get("showgrid") || !(pasDeLaGrille(d, pg) > 0)) { return; }

      var pas = pasDeLaGrille(d, pg);
      var m = pas * cases;
      var L = (pg.get("width") || 0) * 70, H = (pg.get("height") || 0) * 70;
      if (!(L > 0) || !(H > 0) || !(m > 0)) { return; }

      var z = v.zoom;
      ctx.save();
      /* Le contour, en pixels d'écran : le dehors permis, puis sa carte retirée
       * — deux rectangles et une règle pair-impair. */
      ctx.beginPath();
      ctx.rect((-m - v.ox) * z, (-m - v.oy) * z, (L + 2 * m) * z, (H + 2 * m) * z);
      ctx.rect((0 - v.ox) * z, (0 - v.oy) * z, L * z, H * z);
      ctx.clip("evenodd");
      ctx.setTransform(z, 0, 0, z, 0, 0);
      /* SON DESSIN, PAS LE NÔTRE. Une erreur ici ne doit pas laisser le contexte
       * transformé pour le peintre suivant : c'est ce que garantit le restore
       * du bloc appelant, mais on ne s'en remet pas à lui. */
      try { o.drawGrid(ctx); } catch (e) {}
      ctx.restore();
    }

    function pose(n) {
      cases = Math.max(0, Math.round(n || 0));
      if (!cases) { return retire(); }
      /* RANG 0 : la grille passe SOUS les marqueurs, comme chez lui où elle
       * passe sous les jetons. */
      CALQUE.inscris("grille", peins, 0);
      return { ok: true, moteur: "heritage", cases: cases };
    }

    function retire() {
      cases = 0;
      CALQUE.raye("grille");
      return { ok: true, moteur: "heritage" };
    }

    return { pose: pose, retire: retire, cases: function () { return cases; } };
  })();

  function installeMarqueurs(catalogue) {
    var cat = {}, i;
    for (i = 0; i < (catalogue || []).length; i++) {
      var j = catalogue[i];
      if (j && j.tag && j.url && urlSure(j.url)) { cat[j.tag] = { url: j.url, nom: j.nom || j.tag }; }
    }
    marqueursMiens = cat;
    marqueursActif = true;
    /* L'ANCIEN MOTEUR PEINT, IL NE MONTE PAS DE MAILLAGES. Le catalogue vient
     * d'être posé, et il sert aux deux : c'est la seule chose que les deux
     * branches ont en commun. La barre aussi — elle est de DOM, pas de
     * Babylon. */
    if (surLancienMoteur()) {
      var rh = MH.installe();
      faisBarre();
      rh.etiquettes = Object.keys(cat).length;
      return rh;
    }
    /* La palette a pu changer : une étiquette retirée doit disparaître de la
     * carte, et la signature d'un token ne le dira pas toute seule puisqu'elle
     * ne connaît que le passé. On repart donc de zéro sur les POSES, mais on
     * garde les matériaux — ce sont eux qui coûtent. */
    oteTousLesMarqueurs();
    var r = redessineMarqueurs();
    if (r.ok) { lieMarqueurs(); }
    faisBarre();
    r.etiquettes = Object.keys(cat).length;
    return r;
  }

  function retireMarqueurs() {
    marqueursActif = false;
    /* On retire le peintre DANS LES DEUX CAS : rien n'assure qu'on éteint sur
     * le moteur où l'on a allumé — une partie peut être rechargée d'une
     * campagne à l'autre —, et rayer un peintre absent ne coûte rien. */
    MH.retire();
    delieMarqueurs();    oteBarre();
    oteTousLesMarqueurs();
    if (marqueursRetard) { clearTimeout(marqueursRetard); marqueursRetard = null; }
    /* Les matériaux et leurs textures, eux, partent pour de bon : le module est
     * éteint, rien ne dit qu'on le rallumera, et une image de 128 pixels garde
     * quand même sa place en mémoire vidéo. */
    /* DEUX CACHES, ET LE SECOND ÉTAIT OUBLIÉ. Les matériaux de compteur sont
     * apparus après cette boucle, et personne ne les libérait : chaque cycle
     * éteindre/rallumer laissait derrière lui une DynamicTexture par nombre
     * rencontré, indéfiniment.
     *
     * `dispose(false, true)` et non `(true, true)` : le premier argument
     * demanderait de forcer la libération de l'EFFET compilé, or nos deux
     * familles partagent le même source GLSL — le jeter obligerait à le
     * recompiler au rallumage, pour rien. Les textures, elles, partent bien :
     * c'est le second argument qui les emporte, et ce sont elles qui pèsent. */
    [marqueursMat, marqueursNombreMat].forEach(function (cache) {
      for (var cle in cache) {
        if (Object.prototype.hasOwnProperty.call(cache, cle)) {
          try { cache[cle].dispose(false, true); } catch (e) {}
        }
      }
    });
    marqueursMat = {};
    marqueursNombreMat = {};
    marqueursScene = null;
    marqueursMiens = null;
    return { ok: true };
  }

  /* ---------- TOUT RETIRER, Y COMPRIS CE QUI N'APPARTIENT À AUCUN MODULE ----------
   *
   * SIGNALÉ : le bouton VTTK restait dans la boîte à outils après avoir éteint
   * l'extension. Et c'était logique : ce bouton ne dépend d'aucun module — c'est
   * par lui qu'on les allume —, il se pose donc tout seul dès que le pont est
   * injecté. Éteindre les modules un par un ne pouvait pas l'emporter, puisque
   * aucun ne l'avait mis là.
   *
   * ON NE PEUT PAS NON PLUS RETIRER LE PONT LUI-MÊME : sa balise s'est effacée à
   * l'onload, et aucun script de contenu ne l'atteint. Le seul chemin est de lui
   * DIRE, et c'est ce que fait le démarrage quand l'interrupteur général tombe.
   *
   * L'intitulé de section part avec : « VTTK » seul, au-dessus de rien, serait
   * la trace la plus visible d'une extension qu'on croit éteinte. */
  function oteToutVTTK() {
    fermeReglages();
    if (reglages && reglages.parentNode) { reglages.parentNode.removeChild(reglages); }
    reglages = null;
    if (outilReglages && outilReglages.parentNode) {
      outilReglages.parentNode.removeChild(outilReglages);
    }
    outilReglages = null;
    if (section && section.parentNode) { section.parentNode.removeChild(section); }
    section = null;
  }

  /* ---------- LE BOUTON DES RÉGLAGES SE POSE TOUT SEUL ----------
   *
   * Il ne dépend d'aucun module : c'est par lui qu'on les allume. Sa colonne
   * d'outils se monte APRÈS la page, comme la scène Babylon — on réessaie donc,
   * et on s'arrête dès qu'on a réussi. Vingt essais d'une demi-seconde couvrent
   * largement un chargement lent, et le guet disparaît ensuite pour de bon. */
  var vttkEteint = false;

  /* ---------- ON ATTEND DE SAVOIR AVANT DE LE DIRE ----------
   *
   * Le premier jet mesurait une seule fois, à l'injection. Le pont est injecté
   * TÔT — c'est tout son intérêt — et ni Babylon ni l'ancien moteur ne sont
   * montés à ce moment-là : il annonçait « inconnu » et s'en tenait là, ce qui
   * est exactement le genre de réponse qui fait chercher au mauvais endroit.
   *
   * On réessaie donc, et on n'annonce qu'une fois qu'on sait. Trente essais
   * d'une demi-seconde couvrent largement le montage d'une partie ; passé ce
   * délai, « inconnu » devient une vraie information et se dit aussi. */
  (function diLeMoteur() {
    var tours = 0;
    var t = setInterval(function () {
      tours++;
      var m = moteurDeRoll20();
      if (m === "inconnu" && tours < 30) { return; }
      clearInterval(t);
      window.__vttinkerMoteur = m;
      try {
        window.postMessage({ ns: NS, depuis: "page", type: "moteur", moteur: m }, location.origin);
      } catch (e) {}
    }, 500);
    /* Et tout de suite, au cas où tout serait déjà là. */
    var m0 = moteurDeRoll20();
    if (m0 !== "inconnu") { clearInterval(t); window.__vttinkerMoteur = m0;
      try { window.postMessage({ ns: NS, depuis: "page", type: "moteur", moteur: m0 }, location.origin); } catch (e) {} }
  })();

  (function poseLesOutils() {
    var tours = 0;
    var t = setInterval(function () {
      tours++;
      /* LE GUET NE REPOSE PAS CE QU'ON VIENT DE RETIRER. Il tourne pendant dix
       * secondes après l'injection ; sans ce test, éteindre l'extension dans
       * cette fenêtre-là faisait réapparaître le bouton au demi-seconde
       * suivant, ce qui est exactement le défaut qu'on corrige. */
      if (vttkEteint) { clearInterval(t); return; }
      var fait = false;
      try { fait = faisOutilReglages(); } catch (e) {}
      if (fait || tours > 20) { clearInterval(t); }
    }, 500);
    try { faisOutilReglages(); } catch (e) {}
  })();

  /* ---------- LES MOTS, REÇUS DU MONDE ISOLÉ ----------
   *
   * Le pont vit dans le monde de la PAGE, où commun/langue.js n'est pas : il ne
   * peut pas traduire lui-même. Le script de contenu lui envoie donc les
   * quelques mots qu'il a à dire — pas le dictionnaire entier, qui ferait
   * voyager cinquante chaînes pour en employer dix.
   *
   * LE REPLI EST LE MOT FRANÇAIS D'ORIGINE, et non du vide : si le message
   * n'était jamais arrivé, un panneau sans intitulé serait pire qu'un panneau
   * dans la mauvaise langue. */
  var mots = {};

  /* ELLE NE S'APPELLE PAS « mot », ET C'EST UNE CORRECTION. Trois fonctions de
   * ce fichier ont déjà une variable locale de ce nom — des nœuds DOM. Une
   * fonction globale ainsi nommée y est masquée : l'appeler revenait à appeler
   * un <p>, l'exception partait dans le try/catch de l'écouteur, et la palette
   * ne se construisait plus du tout. Un nom emprunté ne se voit pas ; ses
   * effets, si. */
  function ditLe(cle, repli) {
    return (mots && mots[cle]) || repli;
  }

  /* ---------- D'OÙ LE MESSAGE VIENT ----------
   *
   * Le filtre ne regardait QUE le contenu du message : un espace de noms et un
   * champ « depuis », deux chaînes que n'importe qui peut écrire. Or
   * postMessage traverse les origines par construction, et « matches » du
   * manifeste n'y peut rien : l'écouteur est posé sur la fenêtre de Roll20, et
   * toute page qui en garde une poignée — un simple window.open — peut lui
   * parler.
   *
   * CE QUE ÇA OUVRAIT, et ce n'est pas théorique : poser des marqueurs dont
   * l'adresse est choisie par l'appelant, éteindre l'extension, piloter le
   * zoom — et surtout RECEVOIR UNE RÉPONSE, puisque « repond » poste vers
   * « ev.source ». Un « recon » forgé renvoyait l'état de la partie à la
   * fenêtre qui l'avait demandé.
   *
   * DEUX GARDES, ET ELLES NE FONT PAS DOUBLE EMPLOI :
   *   · l'ORIGINE écarte la page étrangère qui garde une poignée sur l'onglet ;
   *   · la FENÊTRE écarte un cadre de MÊME origine — Roll20 en héberge — qui
   *     posterait vers le haut. Aucune enveloppe de sécurité ne change
   *     l'origine, alors que l'identité d'un objet fenêtre entre deux mondes
   *     dépend des enveloppes : l'origine est donc la garde porteuse, et la
   *     fenêtre celle qui resserre.
   *
   * LE PANNEAU EST LE SEUL CAS OÙ L'ORIGINE EST CONNUE D'AVANCE : il vit sur
   * moz-extension://<identifiant>/, que l'adresse de ce fichier nous donne. */
  var monOrigine = String(monAdresse || "").replace(/^([a-z-]+:\/\/[^\/]*).*$/, "$1") || null;
  if (monOrigine === String(monAdresse || "")) { monOrigine = null; }   // rien d'exploitable

  /* ---------- écouteur ---------- */

  window.addEventListener("message", function (ev) {
    try {
      var d = ev.data;
      if (!d || d.ns !== NS) { return; }
      /* LE PANNEAU PARLE AUSSI, et il est le seul à ne pas venir du script de
       * contenu : il vit dans une iframe, sur une autre origine, et n'a qu'une
       * chose à dire — sa hauteur, que personne d'autre ne peut mesurer. On la
       * prend avant le filtre ordinaire, et on ne lui laisse rien dire de
       * plus. */
      if (d.depuis === "panneau") {
        /* SON ORIGINE EST LA NÔTRE, et nous la connaissons. C'est le seul
         * émetteur du protocole dont l'origine soit sûre d'avance. */
        if (!monOrigine || ev.origin !== monOrigine) { return; }
        if (d.type === "hauteur" && typeof d.hauteur === "number" && d.hauteur > 0) {
          poseHauteurPanneau(Math.round(d.hauteur));
        }
        return;
      }
      if (d.depuis !== "contenu") { return; }
      /* IL POSTE VERS window.top, ET « all_frames » VAUT FAUX : le script de
       * contenu ne tourne que dans le cadre du haut, donc window.top EST
       * window. Un message légitime a donc notre origine et notre fenêtre. */
      if (ev.origin !== location.origin) { return; }
      if (ev.source !== window) { return; }
      /* LA LANGUE ARRIVE AVANT TOUT LE RESTE, et peut changer en cours de
       * partie : on garde les mots, et on refait ce qui porte du texte. */
      /* L'INTERRUPTEUR GÉNÉRAL, DIT AU PONT. Voir oteToutVTTK : il retire ce
       * qu'aucun module n'a posé, et que rien d'autre ne peut donc emporter. */
      if (d.type === "vttk") {
        vttkEteint = (d.actif === false);
        if (vttkEteint) { oteToutVTTK(); }
        else { try { faisOutilReglages(); } catch (e) {} }
        return;
      }
      /* LE THÈME CHOISI. Il change ce que couleursDeRoll20 rend, donc il faut
       * rhabiller ce qui est déjà posé — palette et panneau — et refaire
       * l'adresse du cadre, qui porte le thème dans son fragment. */
      if (d.type === "theme") {
        themeChoisi = d.theme || "auto";
        /* ON NE TOUCHE PAS AU CADRE, ET C'EST UNE CORRECTION.
         *
         * Le premier jet réécrivait son adresse pour y remettre le fragment du
         * thème. Or changer « src » RECHARGE le cadre : le panneau repartait de
         * zéro et relisait le stockage AVANT que l'écriture qui venait de
         * déclencher ce message soit terminée. Mesuré : on demandait la nuit, le
         * panneau revenait en jour.
         *
         * Et c'était inutile. Le fragment ne sert QUE pour « automatique » —
         * dire au panneau quel thème Roll20 emploie —, et « automatique » ne
         * change précisément rien à ce que le pont lit. Le panneau, lui, lit le
         * réglage tout seul. */
        try { if (barre) { habille(barre); } } catch (e) {}
        try { if (reglages) { habille(reglages); } } catch (e) {}
        return;
      }
      if (d.type === "langue") {
        mots = d.mots || {};
        try { rhabille(); } catch (e) {}
        return;
      }
      /* Le journal du monde isolé, déposé ici pour qu'il devienne lisible. Il
       * n'est jamais renvoyé ni traité : le pont ne fait que le porter, parce
       * qu'il est le seul des deux à vivre là où un pilote extérieur peut
       * regarder. */
      /* LE PONT ACCUMULE, le socle n'envoie que le neuf. Il renvoyait le journal
       * entier à chaque ligne — un clonage de deux cents chaînes par appel, chez
       * tout le monde. « remplace » n'est vrai qu'au versement du retard, juste
       * après l'injection. */
      if (d.type === "journal") {
        var neuf = d.lignes || [];
        if (d.remplace || !window.__vttinkerJournal) { window.__vttinkerJournal = neuf.slice(); }
        else {
          var j = window.__vttinkerJournal;
          for (var n = 0; n < neuf.length; n++) { j.push(neuf[n]); }
          if (j.length > 400) { j.splice(0, j.length - 400); }
        }
        return;
      }
      if (d.type === "recon") { repond(ev, { type: "recon-resultat", recon: recon() }); return; }
      if (d.type === "zoom") {
        var r;
        if (d.actif === false) { r = retire(); }
        else { r = installe(d.min, d.max); }
        r.type = "zoom-resultat";
        repond(ev, r);
        return;
      }
      // Ce que la commande de l'extension demande. Elle ne calcule rien
      // elle-même : le pas et le bornage vivent ici, et nulle part ailleurs.
      /* « Montre-lui sa commande. » Le module en a besoin AVANT qu'on la
       * masque : c'est sur elle qu'il clone ses boutons. Elle peut avoir été
       * laissée masquée par une session précédente — le réglage est persisté
       * dans le compte Roll20 — et il n'aurait alors plus rien à cloner. */
      if (d.type === "grille") {
        /* L'ANCIEN MOTEUR PEINT SUR NOTRE CALQUE, et il répond TOUT DE SUITE.
         * Le délai de 250 ms de la branche Babylon sert à laisser sa scène se
         * monter avant qu'on cherche des maillages ; ici il n'y a rien à
         * attendre, et rien à trouver. */
        if (surLancienMoteur()) {
          var rh = (d.actif === false) ? GH.retire() : GH.pose(d.cases);
          rh.type = "grille-resultat";
          repond(ev, rh);
          return;
        }
        if (d.actif === false) {
          stoppeGuetGrille(); annulePose();
          var rf = rendGrille();
          rf.type = "grille-resultat";
          repond(ev, rf);
          return;
        }
        planifiePose(d.cases);
        return;
      }
      if (d.type === "chat") {
        var rc = (d.actif === false) ? retireChat() : installeChat();
        rc.type = "chat-resultat";
        repond(ev, rc);
        return;
      }
      if (d.type === "marqueurs") {
        /* LE MODE ARRIVE AVEC LE CATALOGUE, et pas par un message à part : c'est
         * une préférence enregistrée, donc le script de contenu la connaît au
         * moment où il nous parle. Un second message ne ferait qu'ouvrir une
         * fenêtre pendant laquelle la palette afficherait un mode et en
         * appliquerait un autre. */
        if (d.mode === MODE_TOKENS || d.mode === MODE_MARQUEUR) { modePose = d.mode; }
        var rj = (d.actif === false) ? retireMarqueurs() : installeMarqueurs(d.catalogue);
        rj.type = "marqueurs-resultat";
        repond(ev, rj);
        return;
      }
      /* LE COMPTE RENDU D'UN COLLAGE. C'est le script de contenu qui analyse et
       * qui écrit — il a le modèle et le stockage —, et il renvoie ici ce qu'il
       * a retenu et ce qu'il a écarté. Un formulaire qui avale une ligne sans un
       * mot est un formulaire qui ment. */
      if (d.type === "marqueurs-bilan") { montreBilan(d); return; }
      if (d.type === "zoom-devoile") { rendControle(); return; }
      if (d.type === "zoom-veut") { pose(d.valeur); emetEtat(true); return; }
      if (d.type === "zoom-pas") { pasZoom(!!d.monte, PAS_BOUTON); emetEtat(true); return; }
    } catch (e) {}
  }, false);
})();
