/* MODULE « Marqueurs personnalisés ».
 *
 * ON DIT « MARQUEUR », PAS « JETON ». Dans l'interface française de Roll20, un
 * « jeton » est un TOKEN — sa colonne de calques l'affiche ainsi. Employer le
 * même mot pour ce qu'on pose DESSUS entretenait une confusion que rien ne
 * justifiait. Les identifiants, eux, gardent leur nom : la clé de stockage
 * `reg:marqueursPerso`, l'identifiant de module `mod:marqueurs`, les classes
 * `.vttk-marqueur-*` et les types de message `marqueurs-*`. Renommer une clé de
 * stockage effacerait la palette de tous ceux qui en ont une.
 *
 * Roll20 ne propose que ses propres pictogrammes d'état, et leur nombre est
 * arrêté. Ce module en ajoute d'autres : une image, une étiquette, et le
 * pictogramme se range à la suite de ceux de Roll20 sur le token.
 *
 * CE QUI EST ÉCRIT CHEZ ROLL20 SE RÉSUME À L'ÉTIQUETTE. Elle part dans
 * « statusmarkers », à côté des siennes, et il l'ignore sans un mot — c'est
 * mesuré, une étiquette inconnue ne le dérange pas et sa propre interface
 * continue de fonctionner par différence. On ne touche donc NI à son catalogue
 * de marqueurs, ni à quoi que ce soit qui se partage dans la campagne : rien de
 * ce que fait ce module ne peut abîmer une partie où quelqu'un n'aurait pas
 * l'extension. Chez lui, l'étiquette ne dessine simplement rien.
 *
 * Comme les autres modules, celui-ci ne sait rien de Babylon : il valide une
 * palette et la porte au pont. Toute la géométrie — mesurée sur une vraie
 * partie — vit dans page/pont.js.
 */
(function () {
  "use strict";

  var VTT = window.VTT;

  var dernierAvis = null;
  var dernierEcart = 0;

  function avis(texte) {
    var t = texte || "";
    if (t === dernierAvis) { return; }
    dernierAvis = t;
    try { browser.storage.local.set({ "_avis:marqueurs": t }); } catch (e) {}
  }

  VTT.module({
    id: "marqueurs",
    portee: "editeur",

    demarre: function () {
      var mod = this;
      mod.pose = false;

      if (!mod.branche) {
        mod.branche = true;
        VTT.surPage("marqueurs-resultat", function (d) {
          /* MÊME PRUDENCE QUE POUR LA GRILLE : la scène Babylon se monte APRÈS
           * la page, et les premiers envois tombent sur une scène absente. On
           * ne s'arrête que sur un succès, sans quoi on n'essaierait qu'une
           * fois — et jamais au bon moment. */
          if (d.ok) { mod.pose = true; }
          if (!d.ok) {
            VTT.log("marqueurs non posés :", d.raison);
            /* UNE SCÈNE QUI N'EST PAS ENCORE MONTÉE N'EST PAS UNE PANNE.
             *
             * C'est même l'état normal des deux premières secondes, et les
             * essais s'y succèdent : afficher « les marqueurs n'ont pas pu être
             * dessinés » pendant ce temps-là ferait mentir le panneau à chaque
             * ouverture de partie. On se tait, et on réessaie. */
            if (d.raison !== "scene-absente" && d.raison !== "page-absente") {
              avis(VTT.mot("pal.echec") + " (" + d.raison + ").");
            }
            return;
          }
          if (d.etiquettes === undefined) { VTT.log("marqueurs retirés"); avis(""); return; }
          /* DEUX CHAMPS MORTS TRAÎNAIENT ICI — « connues » et « publié dans la
           * partie » — restes du catalogue partagé, supprimé depuis que
           * l'étiquette porte son adresse. Le journal affichait « 0 à vous sur
           *  connues » avec un trou, ce qui a l'air d'une panne et n'en est pas. */
          VTT.log("marqueurs posés :", d.quads, "sur", d.tokens, "tokens",
                  "—", d.etiquettes, "dans votre palette,", d.images, "images",
                  d.attente ? "(" + d.attente + " token(s) en attente de leur nœud)" : "",
                  d.ms === null ? "" : "en " + d.ms + " ms");
          /* La palette vide n'est pas une panne : c'est l'état de départ de
           * tout le monde. On le dit une fois, sans alarme. */
          avis(d.etiquettes ? "" : VTT.mot("pal.vide"));
        });
      }

      /* ---------- LA PALETTE SE GÈRE DEPUIS LA CARTE, PAS D'ICI ----------
       *
       * L'ajout et la suppression étaient dans le panneau des réglages ; ils
       * sont maintenant dans la palette, sur la carte, parce que c'est là qu'on
       * s'en sert. Mais le pont vit dans la PAGE : il n'a ni `browser.storage`,
       * ni le modèle de commun/marqueurs.js. Il envoie donc le texte collé tel
       * quel, et c'est ici qu'on l'analyse et qu'on écrit.
       *
       * Une seule définition de ce qu'est un marqueur valide, d'un bout à l'autre —
       * la même que celle du panneau, la même que celle qui relit le stockage. */
      if (!mod.brancheGestion) {
        mod.brancheGestion = true;

        /* DEUX PORTES, UN SEUL JUGE. Le formulaire de la palette envoie un nom et
         * une adresse ; un collage de plusieurs lignes envoie du texte. Les deux
         * passent par le modèle commun, qui seul décide de ce qui est valide. */
        VTT.surPage("marqueurs-ajoute", function (d) {
          var liste = vttMarqueursPropres(VTT.reglages["reg:marqueursPerso"]);
          var retenus, rejets;
          if (d.texte !== undefined) {
            var res = vttMarqueursDepuisTexte(d.texte, liste);
            retenus = res.retenus;
            rejets = res.rejets.map(function (r) { return r.raison; });
          } else {
            var r = vttMarqueurDepuisChamps(d.nom, d.url, liste);
            retenus = r.marqueur ? [r.marqueur] : [];
            rejets = r.marqueur ? [] : [r.raison];
          }
          if (retenus.length) {
            try { browser.storage.local.set({ "reg:marqueursPerso": liste.concat(retenus) }); }
            catch (e) {}
          }
          VTT.versPage({ type: "marqueurs-bilan", retenus: retenus.length, rejets: rejets });
        });

        VTT.surPage("marqueurs-retire", function (d) {
          var liste = vttMarqueursPropres(VTT.reglages["reg:marqueursPerso"]);
          var reste = liste.filter(function (j) { return j.tag !== d.tag; });
          if (reste.length === liste.length) { return; }
          try { browser.storage.local.set({ "reg:marqueursPerso": reste }); } catch (e) {}
        });

        /* L'ORDRE SE RANGE ICI, PAS DANS LA PAGE. Le pont sait quelle tuile a
         * été traînée où ; il ne sait pas écrire, et il n'a pas à connaître le
         * reste de la palette — une autre fenêtre a pu la changer entre-temps.
         * Il envoie donc l'ordre voulu, et le modèle commun le concilie avec ce
         * qui est réellement enregistré. */
        /* UN REFUS N'EST PAS UNE PANNE, ET IL NE DOIT PAS EN AVOIR L'AIR.
         *
         * Roll20 ne laisse écrire un token qu'à qui le contrôle : mesuré, un MJ
         * a `is_gm` vrai et zéro token « contrôlé », un joueur l'inverse. Le
         * pont refuse donc la pose plutôt que d'écrire une valeur que le serveur
         * reprendrait — ce qui ferait clignoter un marqueur sans un mot.
         *
         * On le journalise ici, où l'on peut : le pont vit dans la page et n'a
         * pas le journal de l'extension. */
        /* LA MANIÈRE DE POSER EST UNE PRÉFÉRENCE, donc elle s'enregistre. On la
         * change en cours de partie selon ce qu'on a à faire, et la retrouver au
         * rechargement est le minimum — sans quoi on la reposerait à chaque
         * ouverture de partie. */
        VTT.surPage("marqueurs-mode", function (d) {
          var m = (d.mode === "tokens") ? "tokens" : "marqueur";
          if (VTT.reglages["reg:marqueursMode"] === m) { return; }
          try { browser.storage.local.set({ "reg:marqueursMode": m }); } catch (e) {}
        });

        VTT.surPage("marqueurs-refus", function (d) {
          VTT.log("pose refusée : « " + (d.token || "?") + " » n'est pas à vous");
        });

        VTT.surPage("marqueurs-ordre", function (d) {
          var liste = vttMarqueursPropres(VTT.reglages["reg:marqueursPerso"]);
          var neuf = vttMarqueursReordonnes(liste, d.ordre);
          var change = neuf.length !== liste.length, i;
          for (i = 0; !change && i < neuf.length; i++) {
            if (neuf[i].tag !== liste[i].tag) { change = true; }
          }
          if (!change) { return; }
          try { browser.storage.local.set({ "reg:marqueursPerso": neuf }); } catch (e) {}
        });
      }

      VTT.injectePont();
      var tours = 0;
      function tente() {
        tours++;
        if (mod.pose) { mod.stoppeAttente(); return; }
        mod.envoie();
        if (tours > 40) { mod.stoppeAttente(); }
      }
      mod.envoie();
      mod.attente = setInterval(tente, 400);
    },

    stoppeAttente: function () {
      if (this.attente) { clearInterval(this.attente); this.attente = null; }
    },

    /* Un marqueur ajouté ou retiré dans le panneau doit se voir sur la carte sans
     * qu'on recharge : le pont sait refaire la pose, il n'a besoin que de la
     * nouvelle palette. */
    change: function () { this.envoie(); },

    arrete: function () {
      this.stoppeAttente();
      VTT.versPage({ type: "marqueurs", actif: false });
      avis("");
    },

    envoie: function () {
      /* ON NE FAIT PAS CONFIANCE À CE QU'ON RELIT. Le stockage de l'extension
       * survit à tout — c'est sa raison d'être ici — mais il survit aussi à nos
       * propres versions : une palette écrite par une version antérieure, ou
       * modifiée à la main, ne doit pas pouvoir faire poser une adresse que la
       * validation d'aujourd'hui refuserait. On revalide au départ, chaque
       * fois, et ça ne coûte qu'un parcours de quelques entrées. */
      /* Le nom nu, pas « window.… » : dans un script de contenu, les
       * déclarations de haut niveau vivent dans le bac à sable, et `window`
       * est le mandataire de la page — qui, lui, ne connaît rien de commun/.
       * Le module échouait au démarrage, et c'est le journal qui l'a dit. */
      var brut = VTT.reglages["reg:marqueursPerso"];
      var propres = vttMarqueursPropres(brut);
      /* ON NE LE DIT QU'UNE FOIS. `envoie` est rappelé toutes les 400 ms tant
       * que la scène Babylon n'est pas montée — jusqu'à quarante fois — et
       * cette ligne partait à chaque tour. Le banc l'a montrée en la répétant
       * dix-huit fois d'affilée. C'est la même correction que pour l'avis de la
       * grille, et pour la même raison. */
      var ecartes = (brut || []).length - propres.length;
      if (ecartes && ecartes !== dernierEcart) {
        VTT.log("palette : " + ecartes + " entrée(s) écartée(s) à la relecture");
      }
      dernierEcart = ecartes;
      /* LE MODE PART AVEC LE CATALOGUE : c'est le seul message que le pont reçoit
       * à coup sûr, et l'envoyer à part laisserait un instant où la palette
       * afficherait un mode et en appliquerait un autre. */
      VTT.versPage({ type: "marqueurs", actif: true, catalogue: propres,
        mode: VTT.reglages["reg:marqueursMode"] === "tokens" ? "tokens" : "marqueur" });
    }
  });
})();
