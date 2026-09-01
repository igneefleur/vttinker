/* MODULE « Jetons hors carte ».
 *
 * Un joueur qui pose un jeton à côté de la page ne le voit plus. Le MJ, si.
 * L'écart n'est ni un défaut d'affichage ni une affaire de caméra : le nuanceur
 * de Roll20 jette tout fragment qui déborde de la page quand le drapeau « MJ »
 * n'est pas levé, et le commentaire de Roll20 présente la chose comme une
 * économie de calcul. Ce module retire ce rejet, pour le joueur, et rien d'autre.
 *
 * Comme les autres, il ne sait rien de la scène : il porte une intention au
 * pont, seul à voir Babylon. Le mécanisme — quel attribut d'instance, quelle
 * ligne du nuanceur, pourquoi ça ne révèle rien de plus — vit dans
 * page/pont.js, au-dessus de son application.
 *
 * IL RÉESSAIE, ET C'EST LA MÊME RAISON QUE POUR LA GRILLE : la scène Babylon se
 * monte APRÈS la page, et le premier envoi tombe sur une scène qui n'existe pas
 * encore. Prendre cette réponse-là pour un aboutissement laisserait le module
 * allumé et sans effet — c'est exactement ce qui était arrivé à la grille.
 */
(function () {
  "use strict";

  var VTT = window.VTT;

  VTT.module({
    id: "horsPage",
    portee: "editeur",

    demarre: function () {
      var mod = this;
      mod.pose = false;

      if (!mod.branche) {
        mod.branche = true;
        VTT.surPage("horspage-resultat", function (d) {
          if (!d.ok) {
            VTT.log("jetons hors carte NON posés :", d.raison);
            return;
          }
          mod.pose = true;
          /* L'ANCIEN MOTEUR N'A RIEN À CORRIGER. Fabric ne peint pas par
           * nuanceur et ne jette rien au bord de la page : le module s'y
           * déclare sans objet, et le dit, plutôt que de laisser croire qu'il
           * travaille. */
          if (d.sansObjet) {
            VTT.log("jetons hors carte : sans objet sur l'ancien moteur");
            return;
          }
          VTT.log("jetons hors carte :", d.poses, "tampon(s) posé(s) sur", d.tampons,
                  "— guet toutes les", d.pas, "ms");
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

    arrete: function () {
      this.stoppeAttente();
      this.pose = false;
      VTT.versPage({ type: "horspage", actif: false });
    },

    envoie: function () {
      VTT.versPage({ type: "horspage", actif: true });
    }
  });
})();
