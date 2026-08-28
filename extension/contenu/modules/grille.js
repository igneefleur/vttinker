/* MODULE « Grille hors carte ».
 *
 * Roll20 arrête le DESSIN de sa grille au bord de la page. Or l'aimantation des
 * jetons, elle, continue au-delà : on pose un personnage hors carte, il se cale
 * sur la trame, et plus rien ne la montre. Ce module étend l'affichage — et
 * rien d'autre. L'aimantation est déjà la sienne, il n'y a pas à la refaire.
 *
 * Comme pour le zoom, le module ne sait rien de la grille : il valide un nombre
 * et le porte au pont, seul à voir la scène Babylon. Le mécanisme — quel
 * maillage, quel uniforme, pourquoi l'alignement tient — vit dans page/pont.js,
 * au-dessus de son application.
 */
(function () {
  "use strict";

  var VTT = window.VTT;

  /* ON N'ÉCRIT PAS DEUX FOIS LE MÊME AVIS.
   *
   * Le module réessaie toutes les 400 ms tant que la scène Babylon n'est pas là,
   * et chaque échec écrivait la MÊME phrase dans le stockage — jusqu'à quarante
   * fois sur une page sans grille, et chaque écriture se diffuse à tous les
   * onglets Roll20 ouverts. Un mémo de trois lignes supprime tout ça. */
  var dernierAvis = null;

  function avis(texte) {
    var t = texte || "";
    if (t === dernierAvis) { return; }
    dernierAvis = t;
    try { browser.storage.local.set({ "_avis:grille": t }); } catch (e) {}
  }

  VTT.module({
    id: "grille",
    portee: "editeur",

    demarre: function () {
      var mod = this;
      mod.pose = false;

      if (!mod.branche) {
        mod.branche = true;
        VTT.surPage("grille-resultat", function (d) {
          /* ON NE S'ARRÊTE QUE SUR UN SUCCÈS. La scène Babylon se monte APRÈS
           * la page : le premier envoi tombe presque toujours sur une grille
           * qui n'existe pas encore, et le pont répond « grille-absente ».
           * Prendre cette réponse pour un aboutissement arrêtait les essais au
           * premier, et la grille n'était jamais étendue — mesuré. */
          if (d.ok) { mod.pose = true; }
          if (!d.ok) {
            VTT.log("grille NON étendue :", d.raison);
            avis(d.raison === "grille-absente"
              ? "La grille de cette page n'a pas été trouvée. Elle est peut-être désactivée dans les réglages de la page Roll20."
              : "La grille n'a pas pu être étendue (" + d.raison + ").");
            return;
          }
          if (d.cases === undefined) { VTT.log("grille rendue à Roll20"); avis(""); return; }
          /* DEUX MÉCANIQUES, DEUX COMPTES RENDUS. Le carré agrandit un quad et
           * dit son nombre de cases ; les grilles en lignes sont pavées et
           * disent leur nombre de copies. Lire l'un dans l'autre faisait
           * échouer l'écouteur en silence — c'est le socle, depuis qu'il parle,
           * qui l'a signalé. */
          /* LE TEMPS DE POSE EST DIT, ET C'EST LE SEUL CHIFFRE QU'ON N'AVAIT
           * PAS. Sur la machine qui développe, tout tient en quelques
           * millisecondes ; sur une autre, la même pose peut en coûter cent, et
           * personne ne pouvait le savoir. Une console qui l'affiche vaut mieux
           * qu'un aller-retour de questions. `ms: 0` veut dire « rien à
           * refaire » : c'est le cas normal quand le guet repasse. */
          if (d.mode === "peinture") {
            VTT.log("grille PEINTE (" + d.forme + ") en " + (d.ms === undefined ? 0 : d.ms) +
                    " ms :", d.sommets,
                    "sommets, un appel de rendu — halo de " + d.halo + " px",
                    "(" + d.cases + " cases de " + d.unite + " px)",
                    d.forme === "hexagones"
                      ? ", hexagones de " + d.taille.join(" × ") + " px" +
                        (d.aplati ? " à sommet plat" : " à sommet pointu") +
                        ", résidu d'ajustement " + d.residu + " px"
                      : ", " + d.droitesPeintes + " familles peintes, écarts " +
                        d.ecarts.join(" / ") + " px",
                    "; étapes " + JSON.stringify(d.etapes || {}) + ", opacité " + d.opaciteLue + " → " + d.opacite +
                    " (il trace deux fois), lu sur " + d.source + " segments");
          } else if (d.mode === "cellules") {
            VTT.log("grille de cellules :", d.segments, "segments sur un seul maillage",
                    "— pavé de " + d.source + " segments répété " + d.tuiles.join("×") +
                    ", pas de " + d.pas.join(" × ") + " px",
                    "(soit " + d.motifs.join(" × ") + " motifs de " +
                    d.periodes.join(" × ") + " px, symétries vérifiées), halo de " +
                    d.halo + " px ; " + d.surPage + " segments laissés à Roll20 et " +
                    d.coupes + " coupés à son bord, " + d.degeneres + " dégénérés");
          } else if (d.mode === "droites") {
            VTT.log("grille de droites :", d.segments, "segments sur un seul maillage",
                    "— " + d.droites + " droites en " + d.familles + " familles",
                    "(lues " + d.lues.join(" / ") + ", périodes " + d.periodes.join(" / ") +
                    " en " + d.motifs.join(" / ") + " motifs, soit des écarts de " +
                    d.ecarts.join(" / ") + " px, tracées " +
                    d.multiplicites.join(" / ") + " fois), halo de " + d.halo + " px ; " +
                    d.surPage + " droites laissées à Roll20 et " +
                    d.coupes + " coupées à son bord");
          } else {
            VTT.log("grille étendue de", d.cases, "cases de", d.casePx + " px",
                    "— " + d.avant.join("×") + " → " + d.apres.join("×"));
          }
          /* NI UN RABOTAGE NI UN REPLI NE SE FONT EN SILENCE.
           *
           * La grille est normalement PEINTE : un quad, un shader, et le halo ne
           * coûte rien. Si le shader n'a pas pu être posé, on retombe sur le
           * pavage en segments — qui marche, mais qui pèse, et c'est exactement
           * ce que quelqu'un doit pouvoir lire au lieu de constater que « ça
           * rame » sans savoir pourquoi. */
          // Le carré est peint par Roll20 lui-même : rien à signaler non plus.
          if (d.mode === "peinture" || d.mode === "quad") { avis(""); return; }
          avis("Cette page n'a pas pu être peinte : la grille est tracée segment "
            + "par segment (" + (d.segments || 0) + " traits), ce qui pèse sur "
            + "l'affichage." + (d.rabote
              ? " Le halo a d'ailleurs été réduit à " + d.halo + " px au lieu de "
                + d.haloVoulu + "."
              : "")
            + " Baisser « cases autour » soulage d'autant.");
          return;
        });
      }

      /* La scène Babylon se monte APRÈS la page : le maillage de la grille peut
       * ne pas exister encore. On réessaie, comme pour le pont — c'est la même
       * situation, et le même remède. */
      VTT.injectePont();
      var tours = 0;
      /* ON REGARDE AVANT DE REDEMANDER. L'ordre inverse envoyait une demande de
       * plus après le succès : le résultat arrive de façon asynchrone, donc au
       * tour où il vient d'arriver on avait déjà réenvoyé. Une pose complète
       * pour rien, à chaque chargement de partie. */
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

    change: function () { this.envoie(); },

    arrete: function () {
      this.stoppeAttente();
      VTT.versPage({ type: "grille", actif: false });
      avis("");
    },

    envoie: function () {
      var n = parseInt(VTT.reglages["reg:grilleCases"], 10);
      if (!isFinite(n) || n < 0 || n > 400) {
        VTT.log("extension de grille ignorée, valeur invalide :", n);
        return;
      }
      // Zéro case, c'est exactement Roll20 : on lui rend sa grille au lieu de
      // la réécrire à l'identique.
      if (n === 0) { VTT.versPage({ type: "grille", actif: false }); return; }
      VTT.versPage({ type: "grille", actif: true, cases: n });
    }
  });
})();
