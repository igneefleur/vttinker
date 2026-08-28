/* MODULE « Bornes du zoom ».
 *
 * Roll20 borne le zoom de la table à 10 % et 250 %. Ce module remplace ces deux
 * valeurs par celles du panneau.
 *
 * Le module lui-même ne sait rien du zoom : il valide un couple de bornes et le
 * porte jusqu'au pont, seul à voir le monde de la page. Tout le mécanisme —
 * quelles actions de Roll20 sont remplacées, où la caméra Babylon est écrite,
 * pourquoi on PROLONGE le zoom aux extrémités au lieu de tout reprendre — vit
 * dans page/pont.js, au-dessus de son application.
 *
 * Rien ici ne s'exécute au chargement : ce fichier ne fait que se déclarer, et
 * c'est 999-demarrage.js qui décide s'il a le droit de tourner.
 */
(function () {
  "use strict";

  var VTT = window.VTT;

  /* L'AVIS REMONTE JUSQU'AU PANNEAU PAR LE STOCKAGE, et pas autrement. Le popup
   * ne peut pas interroger l'onglet courant sans la permission « tabs », qui
   * s'annonce à l'installation comme un accès à l'historique de navigation. Il
   * lit donc une clé que ce module écrit : c'est le chemin des réglages, pris à
   * l'envers. */
  // Même mémo que pour la grille : réécrire la même phrase se diffuse à tous
  // les onglets Roll20 ouverts, pour rien.
  var dernierAvis = null;

  function avis(texte) {
    var t = texte || "";
    if (t === dernierAvis) { return; }
    dernierAvis = t;
    try { browser.storage.local.set({ "_avis:zoom": t }); } catch (e) {}
  }

  /* ============================================================
   *                  LA COMMANDE DE ZOOM
   * ============================================================
   *
   * Masquer le contrôle de Roll20 est la SEULE façon que ses bornes cessent de
   * s'imposer — mais on lui prend au passage son glisseur et trois de ses cinq
   * boutons. On lui en rend donc un, qui couvre la plage étendue.
   *
   * ELLE NE CALCULE RIEN. Ni le pas, ni le bornage, ni la caméra : tout cela
   * vit dans le pont, qui est le seul à voir Roll20. Elle affiche une valeur
   * qu'on lui pousse et poste ce qu'on lui demande. Deux escaliers pour le même
   * zoom finiraient par diverger.
   *
   * ÉCHELLE LOGARITHMIQUE. Un glisseur linéaire sur 2–600 % passerait les quatre
   * cinquièmes de sa course au-dessus de 120 %, et les petits zooms seraient
   * intouchables. En logarithmique, un même déplacement double ou divise par
   * deux où qu'on soit — c'est ce qu'on attend d'un zoom.
   *
   * ELLE SE POSE DANS LA BOÎTE DE ROLL20 quand elle existe : la place, le
   * décalage à droite et le déplacement au repli de la barre viennent alors
   * gratuitement, et suivent leurs évolutions. Sinon elle flotte.
   */
  var boite = null, glisseur = null, champ = null, garde = null;
  var courant = { zoom: 100, min: 10, max: 250 };
  var saisieEnCours = false;
  var modele = null;   // ce qu'on a pris à Roll20 avant de masquer sa commande

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (txt != null) { n.textContent = txt; }
    return n;
  }

  /* ---------- PRENDRE MODÈLE SUR LA SIENNE, AVANT DE LA MASQUER ----------
   *
   * On ne redessine pas ses boutons, ON LES CLONE. Trois raisons, mesurées :
   *
   *   - SES « + » ET « − » NE SONT PAS DES CARACTÈRES. C'est la police
   *     Roll20Icons, et le glyphe est le mot « plus » ou « minus » écrit dans
   *     un span. Un « + » tapé au clavier sera toujours plus petit et d'un
   *     autre dessin, quelle que soit la taille qu'on lui donne.
   *   - SON CSS EST SCOPÉ. Ses règles s'écrivent « …[data-v-2f0bc668] », et le
   *     condensat change à chaque déploiement. cloneNode emporte ces attributs
   *     sans qu'on ait à en deviner un seul — et il emporte aussi la variable
   *     en ligne « --v7353a950 » qu'ils posent sur l'icône.
   *   - LE THÈME SUIT TOUT SEUL. Que Roll20 change de mode, ou qu'une extension
   *     de mode sombre repeigne la page, elle repeint nos clones exactement
   *     comme ses originaux : mêmes classes, mêmes attributs. C'est la seule
   *     façon d'être juste dans un thème qu'on ne connaît pas.
   *
   * cloneNode ne copie AUCUN écouteur : le clone arrive inerte, et c'est nous
   * qui lui posons le sien.
   *
   * Le glisseur, lui, ne se clone pas — c'est un composant Vue, un clone en
   * serait la coquille morte. On lui prend ses COULEURS, telles qu'elles sont
   * rendues à cet instant, et on les repose sur le nôtre.
   */
  function prendModele() {
    if (modele) { return true; }
    try {
      var z = document.getElementById("vm_zoom_buttons");
      if (!z) { return false; }
      var boutons = [].slice.call(z.querySelectorAll("button"));
      function parIcone(nom) {
        for (var i = 0; i < boutons.length; i++) {
          var s = boutons[i].querySelector(".grimoire__roll20-icon");
          if (s && (s.textContent || "").trim() === nom) { return boutons[i]; }
        }
        return null;
      }
      var plus = parIcone("plus"), moins = parIcone("minus");
      if (!plus || !moins) { return false; }   // sa commande n'est pas encore là

      // La valeur : le seul bouton qui ne porte pas d'icône et dont le texte
      // est un nombre. On la reconnaît à ce qu'elle EST, pas à son rang.
      var valeur = null;
      boutons.forEach(function (b) {
        if (b.querySelector(".grimoire__roll20-icon") || b.querySelector("svg")) { return; }
        if (/^\d+$/.test((b.textContent || "").trim())) { valeur = b; }
      });

      function couleur(sel, prop) {
        try {
          var n = z.querySelector(sel);
          return n ? getComputedStyle(n)[prop] : null;
        } catch (e) { return null; }
      }
      modele = {
        plus: plus.cloneNode(true),
        moins: moins.cloneNode(true),
        valeur: valeur ? valeur.cloneNode(true) : null,
        piste: couleur(".el-slider__runway", "backgroundColor"),
        rempli: couleur(".el-slider__bar", "backgroundColor"),
        curseurFond: couleur(".el-slider__button", "backgroundColor"),
        curseurBord: couleur(".el-slider__button", "borderColor")
      };
      VTT.log("modèle pris sur la commande de Roll20" + (valeur ? "" : " (sans sa case de valeur)"));
      return true;
    } catch (e) { return false; }
  }

  /* Un bouton : son clone quand on en a un, un caractère sinon. Le repli n'est
   * pas décoratif — sans lui, une commande masquée dès l'ouverture (ou un
   * Roll20 qui renomme ses icônes) ne donnerait plus aucun bouton du tout. */
  function bouton(quoi, titre, surClic) {
    var b;
    if (modele && modele[quoi]) {
      b = modele[quoi].cloneNode(true);
      b.className = String(b.className || "") + " vttk-zoom-natif";
    } else {
      b = el("button", "vttk-zoom-b", quoi === "plus" ? "+" : "−");
    }
    b.type = "button";
    b.title = titre;
    b.addEventListener("click", surClic);
    return b;
  }

  function versGlisseur(z) {
    var r = Math.log(courant.max / courant.min);
    if (!(r > 0)) { return 0; }
    return Math.round(1000 * Math.log(z / courant.min) / r);
  }
  function depuisGlisseur(p) {
    return Math.round(courant.min * Math.pow(courant.max / courant.min, p / 1000));
  }

  /* OÙ SE POSER. Dans « .parentContainer » — c'est LUI le panneau visible de
   * Roll20 : trente-deux pixels de large, une colonne, un fond translucide et
   * un bord. Se poser un cran plus haut, dans « .wrapper », mettait notre
   * colonne À CÔTÉ de la sienne : deux plaques accolées au lieu d'une. */
  function hote() {
    try {
      var b = document.getElementById("vm_zoom_buttons");
      if (!b) { return null; }
      return b.querySelector(".parentContainer") || b.querySelector(".wrapper") || b;
    } catch (e) { return null; }
  }

  /* ENTRE L'OEIL ET LA MIRE, et non à la fin.
   *
   * Sa colonne est faite de trois enfants : le bouton de l'oeil, le bloc du
   * zoom, le bouton de la mire. En ajoutant la nôtre à la fin, on la posait
   * SOUS la mire — et la mire remontait sous l'oeil, ce qui se voit tout de
   * suite quand on connaît sa commande. On s'insère donc avant le dernier
   * enfant, à la place exacte que le bloc du zoom occupait.
   *
   * Le repli, si sa colonne n'a qu'un enfant ou aucun : on ajoute à la fin,
   * faute de mieux — c'est toujours plus juste que de ne rien poser. */
  function place() {
    if (!boite) { return; }
    var h = hote();
    if (!h) {
      if (boite.parentNode !== document.body) { document.body.appendChild(boite); }
      boite.classList.add("vttk-zoom-flottant");
      return;
    }
    boite.classList.remove("vttk-zoom-flottant");
    var dernier = null;
    try { dernier = h.lastElementChild; } catch (e) {}
    if (dernier && dernier !== boite) {
      try { h.insertBefore(boite, dernier); return; } catch (e) {}
    }
    if (boite.parentNode !== h) { h.appendChild(boite); }
  }

  function montre(etat) {
    courant = etat;
    if (!boite) { return; }
    if (!saisieEnCours) { champ.value = etat.zoom; }
    glisseur.value = versGlisseur(etat.zoom);
  }

  function veut(z) {
    z = Math.max(courant.min, Math.min(courant.max, Math.round(z)));
    VTT.versPage({ type: "zoom-veut", valeur: z });
  }

  function monte() {
    if (boite) { place(); return; }
    boite = el("div", "vttk-zoom");

    /* L'ORDRE EST CELUI DE ROLL20 : la valeur en haut, puis +, le glisseur,
     * puis −. On ne réinvente pas la disposition d'une commande que les gens
     * ont déjà dans l'oeil — c'est la même raison qui fait cloner un bouton
     * natif plutôt que d'en dessiner un.
     *
     * Pas de poignée de repli : Roll20 n'en a pas, elle ajoutait un trait rouge
     * en travers de sa colonne, et on n'a rien à replier de plus que ce que son
     * propre bouton de zoom replie déjà. */
    var corps = el("div", "vttk-zoom-corps");

    // Les couleurs de SON glisseur, telles qu'elles étaient rendues au moment
    // où on les a prises : c'est ce qui rend le nôtre juste dans un thème qu'on
    // ne connaît pas.
    if (modele) {
      if (modele.piste) { boite.style.setProperty("--vttk-piste", modele.piste); }
      if (modele.rempli) { boite.style.setProperty("--vttk-rempli", modele.rempli); }
      if (modele.curseurFond) { boite.style.setProperty("--vttk-curseur-fond", modele.curseurFond); }
      if (modele.curseurBord) { boite.style.setProperty("--vttk-curseur-bord", modele.curseurBord); }
    }

    champ = document.createElement("input");
    /* TEXTE, PAS « number ». Un champ numérique traîne avec lui les flèches du
     * navigateur — une marque grise sous le chiffre, que Roll20 n'a pas et
     * qu'aucune règle ne supprime tout à fait d'un moteur à l'autre. Le clavier
     * numérique s'obtient par inputmode, la validation est de toute façon faite
     * par le pont, et on gagne un souci de chrome de navigateur en moins. */
    champ.type = "text";
    champ.inputMode = "numeric";
    champ.className = "vttk-zoom-v";
    champ.title = VTT.mot("zoom.titre");
    // Pendant la saisie, on cesse d'écraser ce qui est tapé : sinon le premier
    // « 3 » de « 380 » serait appliqué puis réécrit avant le « 8 ».
    champ.addEventListener("focus", function () { saisieEnCours = true; });
    champ.addEventListener("blur", function () { saisieEnCours = false; montre(courant); });
    champ.addEventListener("change", function () { veut(parseInt(champ.value, 10)); });
    champ.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { veut(parseInt(champ.value, 10)); champ.blur(); }
      // Roll20 écoute les touches sur le document : sans ça, taper « 1 » dans
      // la case déclencherait aussi son raccourci.
      ev.stopPropagation();
    });
    /* La case de valeur entre dans SON bouton quand on en a cloné un : lui
     * donne la boîte, les trente-quatre pixels et la police ; nous donnons la
     * saisie, qu'il n'a pas. */
    if (modele && modele.valeur) {
      var ecrin = modele.valeur.cloneNode(true);
      ecrin.className = String(ecrin.className || "") + " vttk-zoom-natif vttk-zoom-ecrin";
      ecrin.type = "button";
      ecrin.textContent = "";
      /* Le remplissage se retire EN LIGNE, et pas par une classe. Son bouton
       * porte « padding: 8px » d'une règle scopée — .el-button[data-v-…] —, et
       * une classe à nous ne la surclasse pas : il restait vingt-deux pixels
       * utiles, « 281 » s'affichait « 28 ». Un style en ligne prime sur toute
       * règle de feuille, sans avoir à crier !important. */
      ecrin.style.padding = "0";
      ecrin.style.minWidth = "0";
      ecrin.appendChild(champ);
      corps.appendChild(ecrin);
    } else {
      corps.appendChild(champ);
    }

    corps.appendChild(bouton("plus", VTT.mot("zoom.plus"),
      function () { VTT.versPage({ type: "zoom-pas", monte: true }); }));

    glisseur = document.createElement("input");
    glisseur.type = "range";
    glisseur.className = "vttk-zoom-s";
    glisseur.min = 0; glisseur.max = 1000; glisseur.step = 1;
    glisseur.title = VTT.mot("zoom.titre");
    glisseur.addEventListener("input", function () { veut(depuisGlisseur(parseInt(glisseur.value, 10))); });
    corps.appendChild(glisseur);

    corps.appendChild(bouton("moins", VTT.mot("zoom.moins"),
      function () { VTT.versPage({ type: "zoom-pas", monte: false }); }));

    boite.appendChild(corps);
    place();
    montre(courant);

    /* LE GUET. La boîte de zoom de Roll20 est une application Vue : elle se
     * reconstruit au repli de la barre, à une reconnexion, à un changement de
     * page, et emporte notre noeud avec elle. On le repose, sans rien démonter
     * de ce qui existe déjà. */
    if (!garde) {
      garde = setInterval(function () {
        try { if (boite && !boite.isConnected) { place(); } } catch (e) {}
      }, 2000);
    }
  }

  function demonte() {
    if (garde) { clearInterval(garde); garde = null; }
    try { if (boite && boite.parentNode) { boite.parentNode.removeChild(boite); } } catch (e) {}
    boite = glisseur = champ = null;
  }

  VTT.module({
    id: "zoom",
    portee: "editeur",

    demarre: function () {
      var mod = this;
      mod.pose = false;

      /* LES ÉCOUTEURS NE SE POSENT QU'UNE FOIS, et le module peut redémarrer.
       * Un rallumage repasse par ici ; sans ce verrou, chaque bascule de
       * l'interrupteur ajouterait un écouteur « message » de plus sur la même
       * fenêtre, et chaque réponse du pont serait traitée deux fois, puis
       * trois. Ce sont des fonctions anonymes : removeEventListener n'a rien à
       * leur passer, donc on ne les pose pas deux fois. */
      if (mod.branche) { return mod.envoie(); }
      mod.branche = true;

      // La valeur poussée par le pont : molette de Roll20 comprise, sinon la
      // commande afficherait un chiffre faux dès le premier cran.
      VTT.surPage("zoom-etat", function (d) {
        montre({ zoom: d.zoom, min: d.min, max: d.max });
      });

      VTT.surPage("zoom-resultat", function (d) {
        // Comme pour la grille : une réponse en échec n'est pas un
        // aboutissement, et cesser d'essayer dessus laisse la feature morte.
        if (d.ok) { mod.pose = true; }
        if (!d.ok) {
          VTT.log("bornes du zoom NON appliquées :", d.raison);
          avis("Le zoom de Roll20 n'a pas pu être atteint (" + d.raison + "). Recharge la partie.");
          return;
        }
        if (d.min === undefined) { VTT.log("bornes du zoom retirées, Roll20 a repris la main"); avis(""); return; }
        if (d.natif) {
          VTT.log("bornes identiques à celles de Roll20 : rien n'est modifié");
          demonte(); avis(""); return;
        }
        VTT.log("bornes du zoom appliquées :", d.min + "–" + d.max + " %",
                d.controleMasque ? "(contrôle de Roll20 masqué)" : "");
        /* UNE SEULE BARRE DE ZOOM À L'ÉCRAN, TOUJOURS. Le pont masque celle de
         * Roll20 de lui-même ; si ce masquage échouait — réglage renommé,
         * action disparue —, la sienne serait encore là et c'est la nôtre qui
         * s'efface. Deux glisseurs côte à côte, dont un qui ne sait aller que
         * jusqu'à 250, seraient pires que pas de glisseur du tout. */
        if (d.sliderGene) { demonte(); } else { monte(); }
        avis(d.sliderGene
          ? "Le contrôle de zoom de Roll20 n'a pas pu être masqué : tant qu'il est "
            + "affiché, il repousse la vue dans sa plage d'origine."
          : "");
      });

      VTT.injectePont();

      /* DEUX ATTENTES EN UNE, ET L'ORDRE COMPTE.
       *
       * Le pont vient d'être injecté et sa balise n'a peut-être pas fini de
       * s'exécuter : son écouteur n'existe pas encore, il faut réessayer.
       *
       * Surtout, L'INSTALLATION MASQUE LA COMMANDE DE ROLL20 : une fois
       * masquée, il n'y a plus rien à cloner. On attend donc que sa boîte
       * paraisse — elle arrive avec la partie — AVANT d'envoyer. Six secondes
       * de patience, pas plus : elle peut ne jamais venir, si le joueur l'a
       * déjà masquée dans ses réglages, et la feature doit marcher quand même
       * avec les boutons de repli. */
      var tours = 0, demande = false;
      function tente() {
        tours++;
        /* SI SA COMMANDE N'EST PAS LÀ, ON LA RÉCLAME. Le masquage est persisté
         * dans le compte Roll20 : une session précédente a pu la laisser
         * masquée, et il n'y aurait alors PLUS JAMAIS rien à cloner — les
         * boutons retomberaient sur des caractères, deux fois plus petits, à
         * chaque partie. Le défaut s'aggravait tout seul ; on le coupe ici. */
        if (!modele && !demande && tours >= 3) {
          demande = true;
          VTT.versPage({ type: "zoom-devoile" });
        }
        /* ON REGARDE AVANT DE REDEMANDER — la forme est celle du module grille,
         * qui l'explique. L'ordre inverse envoyait une demande de trop par
         * chargement dans le cas normal, et une toutes les 300 ms des tours 21 à
         * 40 quand la commande de Roll20 reste introuvable : vingt installe()
         * complets pour rien. */
        if (mod.pose && modele) { mod.stoppeAttente(); return; }
        if (prendModele() || tours > 20) { mod.envoie(); }
        if (tours > 40) { mod.stoppeAttente(); }
      }
      if (prendModele()) { mod.envoie(); }
      mod.attente = setInterval(tente, 300);
    },

    /* LA MINUTERIE SE RANGE AVEC LE MODULE. Elle vivait dans une variable
     * locale que l'arrêt ne pouvait pas atteindre : éteint, le module se
     * défaisait proprement, puis le tour suivant de la minuterie le
     * RÉINSTALLAIT — et la commande revenait toute seule. Le banc l'a pris en
     * défaut une fois sur deux, ce qui est exactement la façon dont ce genre de
     * chose se manifeste avant d'être trouvé. */
    stoppeAttente: function () {
      if (this.attente) { clearInterval(this.attente); this.attente = null; }
    },

    // Un réglage a changé : le popup a écrit, le stockage a prévenu. Rien à
    // recharger, on renvoie.
    change: function () { this.envoie(); },

    /* Le module éteint pendant que la partie tourne. Le pont rend à Roll20 ses
     * actions et ramène la vue dans SA plage : sans ça on laisserait la partie
     * à 600 % sans plus aucun moyen d'en sortir, puisque c'est précisément le
     * code qu'on vient de retirer qui savait y aller. */
    arrete: function () {
      this.stoppeAttente();   // AVANT tout le reste : sinon elle réinstalle
      VTT.versPage({ type: "zoom", actif: false });
      demonte();
      avis("");
    },

    envoie: function () {
      var r = VTT.reglages;
      var min = parseInt(r["reg:zoomMin"], 10);
      var max = parseInt(r["reg:zoomMax"], 10);
      // Le panneau valide déjà, mais il n'est pas le seul à pouvoir écrire dans
      // le stockage : un couple absurde ne descend pas jusqu'à la caméra.
      if (!isFinite(min) || !isFinite(max) || min < 1 || max > 2000 || min >= max) {
        VTT.log("bornes du zoom ignorées, couple invalide :", min, max);
        return;
      }
      VTT.versPage({ type: "zoom", actif: true, min: min, max: max });
    }
  });
})();
