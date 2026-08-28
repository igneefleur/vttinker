# Ce que ça fait

Quatre outils, quatre interrupteurs. Ils se règlent depuis la section **VTTK** de
la colonne d'outils, une fois la partie ouverte.

Aucun ne s'allume tout seul, et aucun ne laisse de trace derrière lui quand on
l'éteint — c'est une contrainte que le code se donne, et qu'un banc d'essai
vérifie à chaque modification.

<div class="vttk-modules" markdown>

<div class="vttk-module" markdown>
### Bornes du zoom

Roll20 s'arrête à 10 % et à 250 %. Vous choisissez vos propres bornes, et le
zoom les respecte — à la molette, aux boutons, au glisseur.

Dans sa plage à lui, Roll20 fait tout son travail sans qu'on y touche. On ne
prend la main **qu'au-delà**, et le premier cran hors bornes vaut exactement le
dernier cran en deçà : la jonction ne se sent pas.
</div>

<div class="vttk-module" markdown>
### Grille hors carte

La grille de Roll20 s'arrête au bord de la page. Celle-ci la prolonge d'autant
de cases que vous voulez, dans le même alignement.

Les cinq types de grille sont pris en charge — carrés, hexagones par colonnes ou
par rangées, isométrique, dimétrique — parce que c'est le dessin de Roll20
lui-même qui est employé, pas une imitation.
</div>

<div class="vttk-module" markdown>
### Marqueurs personnalisés

Roll20 propose quarante-sept marqueurs de jeton. Ajoutez les vôtres, avec
l'adresse de n'importe quelle image.

**Tout le monde les voit**, extension ou pas : le marqueur est écrit dans la
partie comme n'importe quel autre, et l'adresse de l'image voyage avec lui. Vos
camarades n'ont rien à installer.

Ils se posent sur autant de jetons qu'on veut d'un seul geste, portent un
compteur, et se rangent dans une palette qu'on trie à la souris.
</div>

<div class="vttk-module" markdown>
### Pied de chat

La ligne du bas du tchat était mal alignée — « A » et « Envoyer » ne tombaient
pas à la même hauteur. C'est corrigé, et un choix d'émoji s'y ajoute.

Les émojis sont ceux d'Unicode, rangés dans leurs huit vraies catégories
officielles. Rien de personnalisé : **tout le monde les lit**, même sans
l'extension.
</div>

</div>

## Les deux moteurs de Roll20

Roll20 sert **deux moteurs de rendu** derrière le même écran : le moderne, dit
« Jumpgate », et l'ancien, que vos campagnes plus anciennes emploient encore.

Les quatre outils fonctionnent sur les deux, et sur les quatre situations que ça
fait — meneur ou joueur, moteur moderne ou ancien. Ce n'est pas une supposition :
chacune a été éprouvée sur une vraie partie.

## Ce que ça coûte

| | |
| --- | --- |
| Une trame, tous outils allumés | **0,2 ms** |
| Ce que ça prend d'un cœur | **3,5 %** |
| Images par seconde | 181 → 176 |

Mesuré sur une vraie partie, pas estimé. Le calque de dessin ne tourne que
lorsqu'un outil a quelque chose à peindre ; sans cela, il n'existe même pas dans
la page.
